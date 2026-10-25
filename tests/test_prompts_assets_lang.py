"""T15：内置模板英译 + `_load_asset_lang` 语言选择（Python 端）。

覆盖（brief E）：
  - 英文模板齐备且 `_load_asset_lang('en')` 返回英文全文；缓存键与 zh 区分；
  - `zh`/其它语言与旧 `_load_asset` **逐字节相同**且零警告；
  - 英文缺失时回落中文并**每资产只 warn 一次**（不抛错），补上英文后立即生效；
  - 英文模板可被 T14 双语解析器回读为中文 canonical；`set_md_field` 按英文键+英文值写回；
  - en 任务的 normal/stress 首轮注入英文模板，zh 任务仍注入中文模板。

零外部依赖：git/RAG 全部打桩（同 `tests/test_prompts_build.py` 口径），不触网。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import lib
import prompts
import rag

_TEMPLATES = ("case_template.md", "status_template.md", "index_template.md",
              "bug_report_template.md", "load_charts_template.md", "load_index_template.md",
              "load_plan_template.md", "load_scenario_template.md")

_LANG_HEAD_EN = "【产出语言】Write all deliverables (cases, reports, logs) in English.\n\n---\n\n"

# 与 server.CASE_ROW_RE 同一形状（这里不 import server：prompts 单测不拉起服务模块）
_INDEX_ROW_RE = re.compile(r"^\|\s*(FS\d{4})\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|", re.M)


# ---------- 夹具（与 test_prompts_build 同构的最小版） ----------

def _project(tmp_path):
    work = os.path.join(str(tmp_path), "wd")
    return {
        "id": 7, "name": "示例项目",
        "project_dir": os.path.join(str(tmp_path), "repo"),
        "work_dir": work,
        "env_label": "", "guide_text": "",
        "skill_understand": "", "skill_deploy": "", "skill_commit": "",
        "skill_test": "", "skill_cases": "",
        "cases_root": os.path.join(work, "free_style"),
        "bug_dir": os.path.join(work, "bug_report"),
    }


def _task(**kw):
    base = {
        "id": 101, "project_id": 7, "task_type": "normal",
        "start_stage": "", "end_stage": "", "payload": "", "extra": "",
        "auto_fix": 0, "retest": "不复测",
        "auto_commit": 0, "auto_deploy": 0, "auto_retest": 0,
        "date_from": "", "date_to": "", "fresh_prompt": 0,
        "model": "", "permission": "", "lang": "zh",
    }
    base.update(kw)
    return base


@pytest.fixture(autouse=True)
def _no_git_no_net(monkeypatch):
    """单测不依赖本机 git 状态、绝不触网；资产缓存每例重置（避免跨例污染）。"""
    monkeypatch.setattr(lib, "git_recent_commits",
                        lambda d, limit=30: {"ok": False, "error": "stub: 非 git 仓库"})
    monkeypatch.setattr(lib, "git_log_changes",
                        lambda d, f="", t="", limit=100: {"ok": False,
                                                          "error": "stub: 非 git 仓库"})
    monkeypatch.setattr(rag, "load_config", lambda: None)
    monkeypatch.setattr(rag, "retrieve_detail",
                        lambda *a, **k: pytest.fail("单测不得触发 RAG 检索（触网）"))
    prompts._ASSET_CACHE.clear()
    prompts._EN_ASSET_WARNED.clear()
    yield
    prompts._ASSET_CACHE.clear()
    prompts._EN_ASSET_WARNED.clear()


def _copy_template(tmp_path, name):
    """把真实模板拷到临时文件（写回测试用；绝不动仓库内资产）。"""
    dst = os.path.join(str(tmp_path), name)
    with open(os.path.join(prompts._ASSET_DIR, "templates", name), encoding="utf-8") as f:
        text = f.read()
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    return dst


# ---------- 1. 英文模板齐备 + 语言选择 ----------

def test_all_en_templates_present_and_equal_to_disk():
    """8 个英文模板都在；`_load_asset_lang('en')` 返回的就是英文文件全文。"""
    for name in _TEMPLATES:
        en_name = name[:-3] + ".en.md"
        want = lib.read_text(os.path.join(prompts._ASSET_DIR, "templates", en_name))
        assert want.strip(), en_name
        assert prompts._load_asset_lang("en", "templates", name) == want, en_name


def test_zh_and_other_langs_are_byte_identical_and_silent(capsys):
    """zh / 其它语言（含 None/空/地区变体）走旧 `_load_asset`：逐字节相同、零警告。"""
    for lang in ("zh", "zh-CN", "zh_CN", "", None, "fr", "english"):
        for name in _TEMPLATES:
            assert prompts._load_asset_lang(lang, "templates", name) == \
                prompts._load_asset("templates", name), (lang, name)
    assert capsys.readouterr().err == ""


def test_en_cache_key_isolated_from_zh_semantics():
    """英文缓存键 `en:...` 与旧 zh 键并存，互不覆盖；命中缓存不再读盘。"""
    zh = prompts._load_asset("templates", "status_template.md")
    en = prompts._load_asset_lang("en", "templates", "status_template.md")
    assert prompts._ASSET_CACHE["templates/status_template.md"] == zh
    assert prompts._ASSET_CACHE["en:templates/status_template.md"] == en
    assert zh != en
    sentinel = object()
    prompts._ASSET_CACHE["en:templates/status_template.md"] = sentinel
    assert prompts._load_asset_lang("en", "templates", "status_template.md") is sentinel


def test_en_missing_falls_back_to_zh_and_warns_once(tmp_path, monkeypatch, capsys):
    """英文缺失 → 回落中文、每资产只警告一次、不抛错；补上英文后立即生效。"""
    asset_dir = os.path.join(str(tmp_path), "free_style")
    os.makedirs(os.path.join(asset_dir, "templates"))
    with open(os.path.join(asset_dir, "templates", "demo_template.md"), "w",
              encoding="utf-8") as f:
        f.write("# 中文示例模板\n")
    monkeypatch.setattr(prompts, "_ASSET_DIR", asset_dir)

    for _ in range(3):
        assert prompts._load_asset_lang("en", "templates", "demo_template.md") == \
            "# 中文示例模板\n"
    err = capsys.readouterr().err
    assert err.count("英文资产缺失") == 1, err
    assert "demo_template.en.md" in err
    # zh 走旧 loader：零警告
    assert prompts._load_asset_lang("zh", "templates", "demo_template.md") == \
        "# 中文示例模板\n"
    assert capsys.readouterr().err == ""
    # 缺失回落不缓存英文键 ⇒ 英文文件补上后立即生效（告警仍只出过一次）
    with open(os.path.join(asset_dir, "templates", "demo_template.en.md"), "w",
              encoding="utf-8") as f:
        f.write("# English demo template\n")
    assert prompts._load_asset_lang("en", "templates", "demo_template.md") == \
        "# English demo template\n"
    assert capsys.readouterr().err == ""


def test_free_style_and_stress_docs_language_selection():
    """4+4 份模板按 lang 选版本；流程文档（flow.md/load_test.md）保持中文单份。"""
    zh = prompts._free_style_doc()
    assert zh == prompts._free_style_doc("zh")
    for frag in ("# FS0000_用例名称", "# FS0000 状态", "# <目录名> 索引", "# <一句话标题>"):
        assert frag in zh, frag
    en = prompts._free_style_doc("en")
    for frag in ("# FS0000_Case name", "# FS0000 Status", "# <directory name> Index",
                 "## Related cases"):
        assert frag in en, frag
    for frag in ("# FS0000_用例名称", "# FS0000 状态", "# <目录名> 索引", "# <一句话标题>"):
        assert frag not in en, frag
    assert zh.startswith(prompts._load_asset("flow.md"))
    assert en.startswith(prompts._load_asset("flow.md"))

    stress_zh = prompts._stress_doc()
    assert stress_zh == prompts._stress_doc("zh")
    assert "# 压测方案文档模板（plan.md）" in stress_zh
    assert stress_zh.startswith(prompts._load_asset("load_test.md"))
    stress_en = prompts._stress_doc("en")
    for frag in ("# Load test plan document template (plan.md)",
                 "# Chart declaration template (charts.json)",
                 "# Load test scenario JSON template", "# Load test scenario index"):
        assert frag in stress_en, frag
    assert "# 压测方案文档模板（plan.md）" not in stress_en
    assert stress_en.startswith(prompts._load_asset("load_test.md"))


# ---------- 2. 英文模板经 T14 解析器回读 canonical + 写回 ----------

def test_en_status_template_parses_to_canonical_and_writes_back(tmp_path):
    """英文 status 模板 → 中文 canonical；`set_md_field` 写英文键+英文值，其余行不动。"""
    path = _copy_template(tmp_path, "status_template.en.md")
    fields = lib.parse_fields(lib.read_text(path))
    assert fields["状态"] == "Not run / Pass / Failed / Skipped / Needs retest"
    assert fields["最近执行时间"] == "%Y-%m-%d %H:%M"
    assert fields["执行轮次"].startswith("Round N")
    st = lib.parse_status_md(path)
    assert st["status"] == "未执行"

    assert lib.set_md_field(path, "状态", "失败") is True
    text = lib.read_text(path)
    assert "- **Status**: Failed" in text
    assert "**状态**" not in text
    assert text.count("**Status**:") == 1
    assert lib.parse_status_md(path)["status"] == "失败"

    assert lib.set_md_field(path, "结果摘要", "code=0 返回 3 条记录") is True
    text = lib.read_text(path)
    assert "- **Result summary**: code=0 返回 3 条记录" in text
    assert "- **结果摘要**" not in text


def test_en_bug_report_template_parses_to_canonical_and_writes_back(tmp_path):
    """英文 bug 模板字段归一到中文 canonical；状态写回英文值；关联表/FS 号保留。"""
    path = _copy_template(tmp_path, "bug_report_template.en.md")
    fields = lib.parse_fields(lib.read_text(path))
    assert set(fields) >= {"状态", "严重程度", "报告时间", "执行环境", "错误签名"}
    assert fields["严重程度"] == "High / Medium / Low"
    assert fields["报告时间"] == "%Y-%m-%d %H:%M"

    assert lib.set_md_field(path, "状态", "已分析，待修复") is True
    text = lib.read_text(path)
    assert "- **Status**: Analyzed, to fix" in text
    assert lib.parse_fields(text)["状态"] == "已分析，待修复"

    assert lib.set_md_field(path, "状态", "复测通过") is True
    assert "- **Status**: Retest passed" in lib.read_text(path)
    # 关联用例表保持英文表头，正文 FS 号仍可提取
    text = lib.read_text(path)
    assert "| Case ID | Case name | Status |" in text
    assert re.findall(r"FS\d{4}", text) == ["FS0001"]


def test_en_case_template_parses_to_canonical_keys(tmp_path):
    """英文 case 模板 13 个字段全部归一到中文 canonical 键；空值字段也保留键。"""
    path = _copy_template(tmp_path, "case_template.en.md")
    fields = lib.parse_fields(lib.read_text(path))
    assert fields["用例 ID"] == "FS0000"
    assert fields["接口"].startswith("interface under test")
    assert fields["所属模块/功能"].startswith("Level-1 category")
    assert fields["依据代码"].startswith("(required)")
    assert fields["脚本"].startswith("(optional)")
    # 既有 FIELD_RE 的 `\s*` 跨行 quirk（T14 §8.4 已登记）：空值字段吞下一行首行
    assert fields["测试方法"] == "1. Step 1"
    assert fields["输入参数"] == "```json"
    assert set(fields) == {
        "用例 ID", "接口", "分类", "所属模块/功能", "测试目标", "依据代码", "脚本",
        "测试方法", "输入参数", "预期输出", "输出获取方式", "验证逻辑", "备注",
    }


def test_en_index_template_case_row_keeps_fs_shape():
    """英文 INDEX 模板的用例行仍是 `FSxxxx` + 5 列（用例行解析只看 id/名称/测试点）。"""
    text = lib.read_text(os.path.join(prompts._ASSET_DIR, "templates",
                                      "index_template.en.md"))
    m = _INDEX_ROW_RE.search(text)
    assert m is not None, "英文 INDEX 模板缺 FS 用例行"
    assert m.group(1) == "FS0001"
    assert m.group(2).strip() == "Reject overlong request parameters"
    assert "Next available id: FS0001" in text


# ---------- 3. prompt 级：en 用英文模板、zh 用中文模板 ----------

def test_normal_prompt_uses_lang_specific_templates(tmp_path):
    proj = _project(tmp_path)
    en = prompts.normal_prompt(proj, _task(lang="en"))
    zh = prompts.normal_prompt(proj, _task(lang="zh"))
    assert "# FS0000_Case name" in en and "# FS0000_用例名称" not in en
    assert "# FS0000_用例名称" in zh and "# FS0000_Case name" not in zh
    # 约束块/流程文档保持中文（D5）：en 只换模板段落（flow.md 之前的头部逐字节相同）
    assert "执行一轮自由风格探索测试" in en
    flow = prompts._load_asset("flow.md")
    assert zh[:zh.index(flow)] == en[:en.index(flow)]
    # zh 的模板段落就是旧 `_free_style_doc()` 的输出（缺省 zh = 改前行为）
    assert zh.endswith(prompts._free_style_doc() + "\n")
    assert en.endswith(prompts._free_style_doc("en") + "\n")


def test_first_round_en_has_head_and_english_templates(tmp_path):
    proj = _project(tmp_path)
    tasks = (_task(task_type="normal", lang="en"),
             _task(task_type="mystery", lang="en"))
    for task in tasks:
        p = prompts.first_round_prompt(proj, task)
        assert p.startswith(_LANG_HEAD_EN)
        assert "# FS0000_Case name" in p
        assert p[len(_LANG_HEAD_EN):] == prompts.normal_prompt(proj, task)


def test_stress_prompt_uses_lang_specific_templates(tmp_path):
    proj = _project(tmp_path)
    en = prompts.stress_prompt(proj, _task(task_type="stress", lang="en"))
    zh = prompts.stress_prompt(proj, _task(task_type="stress", lang="zh"))
    assert "# Load test plan document template (plan.md)" in en
    assert "# 压测方案文档模板（plan.md）" not in en
    assert "# 压测方案文档模板（plan.md）" in zh
    assert "# Load test plan document template (plan.md)" not in zh
    assert "压测任务（第 1 步/共 2 步" in en     # 包装文案保持中文（D5）
