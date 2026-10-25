#!/usr/bin/env python3
"""Task 3（KB-02）：RAG 测试连接 / Jira 残余 JSON 错误路径 + `sendNow` 死键边界。

覆盖（与 `backend/test/i18n-rag-jira.test.mjs` 逐条镜像）：
  ① RAG：`test_connection(cfg, "en")` 的三条固定错误（字段不全 + `_cfg_int` 两键）、
     `_post_embeddings` 的两条固定 ValueError（第三条超时仅 Node）；动态异常
     （OSError/属性错误原文）不翻；
  ② Jira：`jira_myself` / `jira_import` 两条固定错误；`HTTP {status}: …` 动态不翻；
  ③ 端点级（真隔离实例）：`POST /api/admin/rag/test` 与 `POST .../board/jira/*` 带
     `X-TS-Lang: en` 时 200/400 body 英文；无头（zh）响应**逐字节**等于改前 golden；
  ④ `sendNow` 死键：`i18n/en.json` 不再含 `…：{family}` 键，双端 throw 仍中文
     （Ruling R-A5：删键，不接线）。

zh golden 均按「实现前实测旧串」硬编码（见本任务报告证据节）；英文侧由 key+vars
共享 `i18n/en.json` 的 api 词条。
"""
import json
import pathlib

import pytest

import board
import chat
import rag
from serverfixture import Api, IsolatedServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
EN_JSON = ROOT / "i18n" / "en.json"


# --------------------------------------------------------------------------
# 夹具
# --------------------------------------------------------------------------

class _Resp:
    """`urllib.request.urlopen` 的最小替身（`_post_embeddings` 只用 `read` + 上下文）。"""

    def __init__(self, payload):
        self._raw = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture(scope="module")
def srv(tmp_path_factory):
    """隔离实例：HOME / RAG 配置均指沙箱，绝不读真实 `~/.touchstone/rag.json`。"""
    base = tmp_path_factory.mktemp("i18n_rag_jira")
    instance = IsolatedServer(extra_env={
        "HOME": str(base),
        "TS_RAG_CONFIG": str(base / "rag.json"),
    })
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _en_client(srv):
    """带 `X-TS-Lang: en` 并已登录 admin 的客户端。"""
    api = Api(srv.base, headers={"X-TS-Lang": "en"})
    code, d = api.json("/api/auth/login", "POST",
                       {"username": "admin", "password": srv.admin_pw})
    assert code == 200, f"登录失败: {code} {d}"
    return api


# --------------------------------------------------------------------------
# ① RAG：固定错误 en / zh golden
# --------------------------------------------------------------------------

def test_rag_fixed_errors_zh_golden_and_en():
    """字段不全 + `_cfg_int` 两键：zh 逐字为旧串；en 走共享词条。"""
    cfg = {"api_base": "http://x/v1", "api_key": "k", "model": "m"}
    # zh golden（实现前实测旧串）
    assert rag.test_connection({}) == {
        "ok": False, "error": "api_base / model / api_key 尚未填写完整"}
    assert rag.test_connection({**cfg, "timeout_s": "x"}) == {
        "ok": False, "error": "timeout_s 须为正整数"}
    assert rag.test_connection({**cfg, "timeout_s": 0}) == {
        "ok": False, "error": "timeout_s 须在 1~300 之间"}
    # en
    assert rag.test_connection({}, "en") == {
        "ok": False, "error": "api_base / model / api_key are incomplete"}
    assert rag.test_connection({**cfg, "timeout_s": "x"}, "en") == {
        "ok": False, "error": "timeout_s must be a positive integer"}
    assert rag.test_connection({**cfg, "timeout_s": 0}, "en") == {
        "ok": False, "error": "timeout_s must be between 1 and 300"}


def test_rag_cfg_int_passthrough_lang():
    """`_cfg_int` 透传 lang：两份 key 仍是同一个 `i18n_key` 载体（save 路径不回归）。"""
    with pytest.raises(ValueError) as ei:
        rag._cfg_int("x", 30, 300, "timeout_s")
    assert str(ei.value) == "timeout_s 须为正整数"
    assert ei.value.i18n_key == "{name} 须为正整数"
    assert ei.value.i18n_vars == {"name": "timeout_s"}

    with pytest.raises(ValueError) as ei:
        rag._cfg_int("x", 30, 300, "timeout_s", "en")
    assert str(ei.value) == "timeout_s must be a positive integer"
    assert ei.value.i18n_key == "{name} 须为正整数"

    with pytest.raises(ValueError) as ei:
        rag._cfg_int(0, 30, 300, "timeout_s", lang="en")
    assert str(ei.value) == "timeout_s must be between 1 and 300"
    assert ei.value.i18n_key == "{name} 须在 1~{upper} 之间"
    assert ei.value.i18n_vars == {"name": "timeout_s", "upper": 300}

    # zh 缺省仍是旧串
    with pytest.raises(ValueError) as ei:
        rag._cfg_int(999, 30, 300, "timeout_s")
    assert str(ei.value) == "timeout_s 须在 1~300 之间"


def test_rag_embeddings_fixed_errors_en(monkeypatch):
    """`_post_embeddings` 两条固定 ValueError（第三条超时仅 Node）也按请求语言渲染；
    动态异常原样。"""
    cfg = {"api_base": "http://x/v1", "api_key": "k", "model": "m"}

    monkeypatch.setattr(rag.urllib.request, "urlopen",
                        lambda req, timeout=0: _Resp({"data": "oops"}))
    assert rag.test_connection(cfg) == {"ok": False, "error": "embeddings 响应缺 data"}
    assert rag.test_connection(cfg, "en") == {
        "ok": False, "error": "embeddings response is missing data"}

    monkeypatch.setattr(rag.urllib.request, "urlopen",
                        lambda req, timeout=0: _Resp({"data": []}))
    assert rag.test_connection(cfg) == {"ok": False, "error": "embeddings 返回条数不符"}
    assert rag.test_connection(cfg, "en") == {
        "ok": False, "error": "embeddings response item count mismatch"}

    # 动态异常（网络/鉴权原文）不翻：英文请求同样原样回显
    def boom(req, timeout=0):
        raise OSError("HTTP Error 401: Unauthorized")

    monkeypatch.setattr(rag.urllib.request, "urlopen", boom)
    assert rag.test_connection(cfg, "en") == {
        "ok": False, "error": "HTTP Error 401: Unauthorized"}
    # 非字符串/无 i18n_key 的异常走旧 `str(exc) or 类名` 口径
    monkeypatch.setattr(rag, "_post_embeddings",
                        lambda *a, **k: (_ for _ in ()).throw(ValueError("")))
    assert rag.test_connection(cfg, "en") == {"ok": False, "error": "ValueError"}


def test_http_rag_test_en_and_zh_bytes(srv):
    """端点级：`X-TS-Lang: en` ⇒ 200 body 英文；无头 ⇒ 与旧字节逐字节相同。"""
    en = _en_client(srv)
    body = {"api_base": "", "model": ""}
    code, text = en("/api/admin/rag/test", "POST", body)
    assert code == 200
    assert text == ('{"ok": false, "error": '
                    '"api_base / model / api_key are incomplete"}')
    code, text = srv.admin("/api/admin/rag/test", "POST", body)
    assert code == 200
    # zh golden（改前抓取）：json.dumps 带空格；键序 ok→error
    assert text == ('{"ok": false, "error": '
                    '"api_base / model / api_key 尚未填写完整"}')


# --------------------------------------------------------------------------
# ② Jira：固定错误 en / zh golden + 端点级
# --------------------------------------------------------------------------

def test_jira_fixed_errors_en_and_zh_golden(monkeypatch):
    """两条固定中文错误：zh 逐字旧串；en 走共享词条。"""
    assert board.jira_myself({}) == {
        "ok": False, "error": "请填全 Jira 地址 / 用户名 / token"}
    assert board.jira_myself({}, "en") == {
        "ok": False, "error": "Fill in the Jira URL, username, and token"}

    monkeypatch.setattr(board, "settings_of", lambda project_id: {"jira": {}})
    assert board.jira_import(1) == {"ok": False, "error": "请先在设置中配置 Jira"}
    assert board.jira_import(1, "en") == {
        "ok": False, "error": "Configure Jira in settings first"}


def test_http_jira_en_and_zh_bytes(srv):
    """端点级 400 body：en 英文；zh 与旧字节一致（紧凑/带空格均由源码形态决定）。"""
    en = _en_client(srv)
    pid = srv.create_project(srv.admin, "i18n_jira")
    body = {"url": "https://jira.example.com"}

    code, text = srv.admin(f"/api/projects/{pid}/board/jira/test", "POST", body)
    assert code == 400
    assert text == '{"ok": false, "error": "请填全 Jira 地址 / 用户名 / token"}'
    code, text = en(f"/api/projects/{pid}/board/jira/test", "POST", body)
    assert code == 400
    assert text == ('{"ok": false, "error": '
                    '"Fill in the Jira URL, username, and token"}')

    code, text = srv.admin(f"/api/projects/{pid}/board/jira/import", "POST", {})
    assert code == 400
    assert text == '{"ok": false, "error": "请先在设置中配置 Jira"}'
    code, text = en(f"/api/projects/{pid}/board/jira/import", "POST", {})
    assert code == 400
    assert text == '{"ok": false, "error": "Configure Jira in settings first"}'


# --------------------------------------------------------------------------
# ③ sendNow 死键（Ruling R-A5：删键；中文为冻结诊断）
# --------------------------------------------------------------------------

DEAD_KEY = "该智能体族已下线，请在项目设置里改绑 dsh 插件：{family}"
FROZEN_MSG = "该智能体族已下线，请在项目设置里改绑 dsh 插件"
FROZEN_NOTE = ("单族世界该分支不可达；中文为冻结诊断（无请求语言通道，"
               "chat_msgs 无 lang 列），不接词表")


def test_send_now_dead_key_removed_and_throw_frozen():
    api = json.loads(EN_JSON.read_text(encoding="utf-8"))["api"]
    assert DEAD_KEY not in api, "en.json 的 sendNow 死键应已删除（R-A5）"
    assert api[FROZEN_MSG] == ("This agent family has been retired; "
                               "rebind the dsh plugin in project settings")

    with pytest.raises(RuntimeError) as ei:
        chat._send_now(None, None, "", "sid", "msg", False)
    assert str(ei.value) == f"{FROZEN_MSG}：未知"

    src = (ROOT / "backend_py" / "chat.py").read_text(encoding="utf-8")
    assert FROZEN_NOTE in src, "Python 侧 throw 旁应留冻结诊断注释"
