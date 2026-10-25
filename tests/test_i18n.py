#!/usr/bin/env python3
"""后端 i18n 运行时（Python）单测 + 与 Node 侧共享的期望表。

口径（与 `task-9-brief.md`、Controller 裁决和 `backend/test/i18n.test.mjs` 逐条对齐）：
  ① zh 是源语言：不查表，直接把中文 key 插值返回；
  ② en 查 `dict[ns][key]`（str 或 {"one","other"} 复数对象），缺失/类型非法回落中文 key；
  ③ 插值只认 `{标识符}`，变量缺失/None/对象等保留占位符原样，绝不抛错；
  ④ 语言解析优先级 `X-TS-Lang` → `?lang=` → `user_pref` → `zh`（非法值跳过、继续下一档）；
  ⑤ `TS_I18N=0` ⇒ 恒 zh；词典读不到/读坏 ⇒ 降级为仅中文且只 warning 一次。

用例真源是 `backend/test/i18n-cases.json`：本文件与 `backend/test/i18n.test.mjs` 读同一份
文件、逐条断言同一输出，任何一端语义分叉都会在同一行失败。两端测试文件里不再各写
一份手抄期望表。
"""
import builtins
import json
import logging
import threading
import time
import urllib.parse
from email.message import Message
from pathlib import Path

import pytest

import i18n

# 共享用例表：fixture 词典 + 全部断言（与 Node 测试同源）
_CASES_PATH = Path(__file__).resolve().parent.parent / "backend" / "test" / "i18n-cases.json"
with _CASES_PATH.open(encoding="utf-8") as _handle:
    CASES = json.load(_handle)
FIXTURE = CASES["fixture"]
T_CASES = [c for c in CASES["cases"] if c["kind"] == "t"]
NORMALIZE_CASES = [c for c in CASES["cases"] if c["kind"] == "normalize"]
RESOLVE_CASES = [c for c in CASES["cases"] if c["kind"] == "resolve"]
DICT_CASES = [c for c in CASES["cases"] if c["kind"] == "dict"]


class _ThrowingValue:
    """模拟 JS 侧 toString/valueOf 抛错的对象：任何字符串化/取数都会抛错。"""

    def __str__(self):
        raise RuntimeError("throwing value")

    def __float__(self):
        raise RuntimeError("throwing value")


def _materialize(value):
    """把用例表里的特殊值标记还原成本平台的原生值。

    JSON 无法表达 NaN/Infinity/None 之外的 undefined 与抛错对象，故用 {"$native": ...}
    描述；Python 没有 Proxy，throwingProxy 用等价的 __str__ 抛错对象代替。
    """
    if isinstance(value, dict) and set(value) == {"$native"}:
        marker = value["$native"]
        if marker == "undefined":
            return None
        if marker == "NaN":
            return float("nan")
        if marker == "Infinity":
            return float("inf")
        if marker == "-Infinity":
            return float("-inf")
        if marker in ("throwingToString", "throwingProxy"):
            return _ThrowingValue()
        raise AssertionError(f"未知 $native 标记: {marker}")
    return value


def _build_vars(case):
    """构造用例的 vars；varsNative=throwingProxy 在 Python 侧映射为抛错变量值。"""
    if case.get("varsNative") == "throwingProxy":
        return {"v": _ThrowingValue()}
    return {key: _materialize(value) for key, value in case.get("vars", {}).items()}


def _call_t(case):
    """调 t()：lang 缺省时省略该实参，走函数默认值（zh）。"""
    args = [case["ns"], case["key"]]
    if "lang" in case:
        args.append(case["lang"])
    return i18n.t(*args, **_build_vars(case))


@pytest.fixture(autouse=True)
def _fresh_i18n(monkeypatch):
    """每个用例前清缓存/清 TS_I18N，避免用例间互相污染。"""
    i18n.reset_cache()
    monkeypatch.delenv("TS_I18N", raising=False)
    yield
    i18n.reset_cache()


def _load_fixture(tmp_path):
    """把共享 fixture 词典写到临时路径，并显式加载（load_dict 的测试钩子）。"""
    path = tmp_path / "en.json"
    path.write_text(json.dumps(FIXTURE, ensure_ascii=False), encoding="utf-8")
    i18n.load_dict(str(path))
    return path


def test_zh_passthrough(tmp_path):
    """zh 透传并插值：不查表，直接返回中文 key。"""
    _load_fixture(tmp_path)
    assert i18n.t("web", "保存", "zh") == "保存"
    assert i18n.t("web", "共 {n} 张卡片", "zh", n=3) == "共 3 张卡片"


def test_en_lookup_and_interpolation(tmp_path):
    """en 查表并插值。"""
    _load_fixture(tmp_path)
    assert i18n.t("web", "保存", "en") == "Save"
    assert i18n.t("web", "你好 {name}", "en", name="Ada") == "Hello Ada"
    assert i18n.t("api", "删除失败: {name}", "en", name="x") == "Delete failed: x"


def test_en_plural_one_other(tmp_path):
    """en 复数：n == 1 取 one，其余取 other。"""
    _load_fixture(tmp_path)
    assert i18n.t("web", "共 {n} 张卡片", "en", n=1) == "1 card"
    assert i18n.t("web", "共 {n} 张卡片", "en", n=2) == "2 cards"


def test_missing_key_ns_and_invalid_entry_fall_back_to_chinese(tmp_path):
    """缺失 key / 缺失 ns / 非法词条一律回落中文 key。"""
    _load_fixture(tmp_path)
    assert i18n.t("web", "未收录", "en") == "未收录"
    assert i18n.t("nope", "保存", "en") == "保存"
    assert i18n.t("web", "非法词条", "en") == "非法词条"
    assert i18n.t("prompt", "任意", "en") == "任意"


def test_shared_cases_t(tmp_path):
    """共享用例表：t() 同输入同输出（与 Node 测试同源）。"""
    _load_fixture(tmp_path)
    for case in T_CASES:
        assert _call_t(case) == case["expected"], case


def test_shared_cases_normalize():
    """共享用例表：normalize_lang 大小写/地区变体与非法值。"""
    for case in NORMALIZE_CASES:
        assert i18n.normalize_lang(case["input"]) == case["expected"], case


def test_shared_cases_resolve():
    """共享用例表：resolve_lang 优先级链（含重复头数组）。"""
    for case in RESOLVE_CASES:
        got = i18n.resolve_lang(case["headers"], case["query"], case["userPref"])
        assert got == case["expected"], case


def test_shared_cases_invalid_dict(tmp_path, caplog):
    """共享用例表：非法词典根节点/NaN/Infinity 一律整份降级为中文。"""
    with caplog.at_level(logging.WARNING, logger="i18n"):
        for index, case in enumerate(DICT_CASES):
            i18n.reset_cache()
            path = tmp_path / f"dict-{index}.json"
            path.write_text(case["raw"], encoding="utf-8")
            i18n.load_dict(str(path))
            assert i18n.t(case["ns"], case["key"], case["lang"]) == case["expected"], case


def test_interpolate_non_mapping_vars_keeps_placeholders():
    """vars 不是映射时保留占位符原样：Python 公开 API 走 **vars 不可达，单测内部兜底。"""
    assert i18n._interpolate("你好 {name}", "not-a-mapping") == "你好 {name}"
    assert i18n._interpolate("你好 {name}", None) == "你好 {name}"


def test_resolve_lang_email_message_and_parse_qs():
    """headers 可为 email.message.Message；query 可为 parse_qs 的 {key: [values]} 形状。"""
    msg = Message()
    msg["X-TS-Lang"] = "EN"
    assert i18n.resolve_lang(msg) == "en"
    assert i18n.resolve_lang({}, urllib.parse.parse_qs("lang=en")) == "en"
    assert i18n.resolve_lang({}, urllib.parse.parse_qs("lang=zh-CN")) == "zh"
    assert i18n.resolve_lang() == "zh"


def test_ts_i18n_zero_forces_chinese(tmp_path, monkeypatch):
    """TS_I18N=0：t 与 resolve_lang 恒 zh，normalize_lang 不受影响。"""
    _load_fixture(tmp_path)
    monkeypatch.setenv("TS_I18N", "0")
    assert i18n.t("web", "保存", "en") == "保存"
    assert i18n.t("web", "共 {n} 张卡片", "en", n=1) == "共 1 张卡片"
    assert i18n.resolve_lang({"X-TS-Lang": "en"}, {"lang": "en"}) == "zh"
    assert i18n.normalize_lang("en") == "en"


def test_ts_i18n_non_zero_keeps_localization(tmp_path, monkeypatch):
    """TS_I18N 非 0（如 1）不关闭本地化。"""
    _load_fixture(tmp_path)
    monkeypatch.setenv("TS_I18N", "1")
    assert i18n.t("web", "保存", "en") == "Save"
    assert i18n.resolve_lang({"X-TS-Lang": "en"}) == "en"


def test_default_dict_from_repo_root():
    """默认词典：从仓库根 i18n/en.json 读取并缓存。"""
    data = i18n.load_dict()
    assert isinstance(data, dict)
    assert isinstance(data.get("web"), dict)
    # 已知词条抽查（en.json 的稳定条目，不是读实现反推）
    assert i18n.t("web", "保存", "en") == "Save"
    assert i18n.t("web", "共 {n} 张卡片", "en", n=1) == "1 card"


def test_missing_dict_degrades_to_chinese_warn_once(tmp_path, caplog):
    """词典文件缺失：降级中文、不抛错、warning 只一次。"""
    with caplog.at_level(logging.WARNING, logger="i18n"):
        i18n.load_dict(str(tmp_path / "missing.json"))
        assert i18n.t("web", "保存", "en") == "保存"
        assert i18n.t("web", "共 {n} 张卡片", "en", n=1) == "共 1 张卡片"
        assert i18n.t("web", "保存", "en") == "保存"
    warnings = [r for r in caplog.records if r.name == "i18n" and r.levelno == logging.WARNING]
    assert len(warnings) == 1, [r.getMessage() for r in warnings]


def test_broken_dict_degrades_to_chinese_warn_once(tmp_path, caplog):
    """词典 JSON 损坏：降级中文、不抛错、warning 只一次。"""
    path = tmp_path / "broken.json"
    path.write_text("{ not valid json", encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="i18n"):
        i18n.load_dict(str(path))
        assert i18n.t("web", "保存", "en") == "保存"
        assert i18n.t("web", "保存", "en") == "保存"
    warnings = [r for r in caplog.records if r.name == "i18n" and r.levelno == logging.WARNING]
    assert len(warnings) == 1, [r.getMessage() for r in warnings]


def test_load_dict_warn_once_thread_safe(tmp_path, monkeypatch, caplog):
    """并发首读只读盘/只告警一次：ThreadingHTTPServer 下不能双读双警告。

    用慢 open 把并发窗口撑开：修复前多个线程都能越过「_DICT is None」检查并各读一次；
    加锁后第一个线程持锁加载并写入缓存，其余线程在锁内复查后直接复用。
    """
    i18n.reset_cache()
    monkeypatch.setattr(i18n, "_DICT_PATH", str(tmp_path / "missing.json"))
    real_open = builtins.open
    calls = []

    def slow_open(*args, **kwargs):
        calls.append(args[0])
        time.sleep(0.05)
        return real_open(*args, **kwargs)

    monkeypatch.setattr(builtins, "open", slow_open)
    workers = 8
    barrier = threading.Barrier(workers)
    errors = []

    def worker():
        try:
            barrier.wait(timeout=5)
            i18n.t("web", "保存", "en")
        except BaseException as exc:  # noqa: BLE001 —— 线程内异常汇总后统一断言
            errors.append(exc)

    with caplog.at_level(logging.WARNING, logger="i18n"):
        threads = [threading.Thread(target=worker) for _ in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)

    assert not errors, errors
    assert all(not thread.is_alive() for thread in threads)
    assert len(calls) == 1, f"并发首读应只打开词典一次，实际 {len(calls)} 次"
    warnings = [r for r in caplog.records if r.name == "i18n" and r.levelno == logging.WARNING]
    assert len(warnings) == 1, [r.getMessage() for r in warnings]
