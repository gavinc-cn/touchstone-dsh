# 任务提示词构建单测（prompts.py）：七类任务首轮 / 续轮 / compact 的结构契约。
# 只断言「对外文本契约」（必含/必不含的关键条款与路径），不做全文快照——措辞微调
# 不应碎测试。零外部依赖：git 摘录与 RAG 检索全部打桩（不触网、不读真实仓库）。
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import lib
import prompts
import rag

# 七类任务首轮的「判型标志串」（各类型独有的标题行片段）
_TITLE_NORMAL = "执行一轮自由风格探索测试"
_TITLE_REGRESSION = "执行一轮存量用例回归"
_TITLE_STRESS = "压测任务（第 1 步/共 2 步"
_TITLE_FIX = "处理以下 bug 报告（任务范围："
_TITLE_RETEST = "复测以下 bug 报告关联的全部用例"
_TITLE_REJECT = "以下 bug 报告已被用户拒绝"
_TITLE_PIPELINE = "后段任务：处理前一段探索/回归任务产出的全部 bug 报告"

_BUG_NAME = "20260901_1200_FS0001_登录异常"


# ---------- 输入替身（生产中 project/task 是 sqlite3.Row，二者同为下标映射） ----------

def _project(tmp_path, **kw):
    """构造项目视图 dict：键集与 db.project_view 一致（projects 行字段 + 派生路径）。"""
    work = kw.pop("work_dir", None) or os.path.join(str(tmp_path), "wd")
    base = {
        "id": 7, "name": "示例项目",
        "project_dir": os.path.join(str(tmp_path), "repo"),
        "work_dir": work,
        "agent_path": "/usr/bin/kimi", "model": "",
        "env_label": "", "guide_text": "",
        "skill_understand": "", "skill_deploy": "", "skill_commit": "",
        "skill_test": "", "skill_cases": "",
        "cases_root": os.path.join(work, "free_style"),
        "bug_dir": os.path.join(work, "bug_report"),
    }
    base.update(kw)
    return base


def _task(**kw):
    """构造任务视图 dict：键集与 db tasks 行一致（仅 prompts 用到的字段有语义）。"""
    base = {
        "id": 101, "project_id": 7, "task_type": "normal",
        "start_stage": "", "end_stage": "", "payload": "", "extra": "",
        "auto_fix": 0, "retest": "不复测",
        "auto_commit": 0, "auto_deploy": 0, "auto_retest": 0,
        "date_from": "", "date_to": "", "fresh_prompt": 0,
        "model": "", "permission": "",
    }
    base.update(kw)
    return base


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _mk_case(cases_root, cid, name, code_ref="src/login.py"):
    """在案例库建一条用例目录（find_case_dirs / scan_cases 都按 FS%04d_ 目录名识别）。"""
    d = os.path.join(cases_root, "mod_login", f"{cid}_{name}")
    _write(os.path.join(d, "case.md"),
           f"# {cid}\n\n- **用例 ID**: {cid}\n- **依据代码**: {code_ref}\n"
           f"- **测试目标**: 验证 {name}\n")
    _write(os.path.join(d, "status.md"), "- **状态**: 未执行\n")


def _mk_bug(project, name=_BUG_NAME, case_ids=("FS0001", "FS0002")):
    """在项目 bug 目录建一枚报告（正文含关联用例 id，供 lib.bug_cases 提取）。"""
    _write(os.path.join(project["bug_dir"], name, "bug_report.md"),
           "# 登录接口异常\n\n- **状态**: 待分析\n\n## 复现\n\n关联用例："
           + "、".join(case_ids) + "\n")
    return name


def _bug_env(tmp_path):
    """建好「案例库 + bug 报告」环境，返回 (project, bug 目录名)。"""
    proj = _project(tmp_path)
    _mk_case(proj["cases_root"], "FS0001", "登录超时")
    _mk_case(proj["cases_root"], "FS0002", "导出超时")
    return proj, _mk_bug(proj)


def _sqlite_row(d):
    """把 dict 转成真 sqlite3.Row（核对提示词构建接受 Row 输入，非仅 dict）。"""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    cols = list(d)
    conn.execute("CREATE TABLE t (%s)" % ", ".join('"%s"' % c for c in cols))
    conn.execute("INSERT INTO t VALUES (%s)" % ",".join("?" * len(cols)),
                 [d[c] for c in cols])
    row = conn.execute("SELECT * FROM t").fetchone()
    conn.close()
    return row


# ---------- 模块级隔离：git / RAG 全部打桩 ----------

@pytest.fixture(autouse=True)
def _no_git_no_net(monkeypatch):
    """默认造「非 git 仓库」+「RAG 未配置」：单测不依赖本机仓库状态、绝不触网。

    RAG 检索器一旦被调用直接判失败（pytest.fail 的异常继承 BaseException，
    不会被 _semantic_order 的宽 except 吞掉），据此守住「不触网」红线。
    """
    monkeypatch.setattr(lib, "git_log_changes",
                        lambda d, f="", t="", limit=100: {"ok": False,
                                                          "error": "stub: 非 git 仓库"})
    monkeypatch.setattr(rag, "load_config", lambda: None)
    monkeypatch.setattr(rag, "retrieve_detail",
                        lambda *a, **k: pytest.fail("单测不得触发 RAG 检索（触网）"))


def _stub_git_ok(monkeypatch, commits=("abc123 2026-01-02 张三 修复登录",),
                 files=("src/login.py", "src/api/order.py")):
    """打桩 git 摘录为成功态（日期范围段注入用）。"""
    monkeypatch.setattr(lib, "git_log_changes",
                        lambda d, f="", t="", limit=100: {"ok": True,
                                                          "commits": list(commits),
                                                          "files": list(files)})


# ---------- 1. 分派与输入形态 ----------

def test_first_round_dispatch_by_task_type(tmp_path):
    """首轮按 task_type 分派：空/未知类型回落常规探索，各类型标题互不相同。"""
    proj = _project(tmp_path)
    for tt in ("", None, "mystery"):
        assert _TITLE_NORMAL in prompts.first_round_prompt(proj, _task(task_type=tt)), tt
    assert _TITLE_REGRESSION in prompts.first_round_prompt(
        proj, _task(task_type="regression"))
    assert _TITLE_STRESS in prompts.first_round_prompt(proj, _task(task_type="stress"))
    # 类型标题不串台
    for tt in ("normal", "regression", "stress"):
        p = prompts.first_round_prompt(proj, _task(task_type=tt))
        assert (p.count(_TITLE_NORMAL) + p.count(_TITLE_REGRESSION)
                + p.count(_TITLE_STRESS)) == 1


def test_prompt_accepts_sqlite_row_inputs(tmp_path):
    """输入是 sqlite3.Row（生产 runner 传 db 行）时同样可构建，不是只吃 dict。"""
    proj = _sqlite_row(_project(tmp_path))
    task = _sqlite_row(_task(task_type="normal", auto_fix=1))
    p = prompts.first_round_prompt(proj, task)
    assert _TITLE_NORMAL in p and proj["cases_root"] in p


# ---------- 2. normal（常规探索） ----------

def test_normal_prompt_core_constraints(tmp_path):
    """常规探索首轮：案例库/报告目录/阅读范围/误报教训/选项/停止条件/红线/摘要行齐备。"""
    proj = _project(tmp_path)
    p = prompts.normal_prompt(proj, _task(auto_fix=1, retest="不复测"))
    assert f"- 案例库根目录：{proj['cases_root']}" in p
    assert f"- bug_report 输出到：{proj['bug_dir']}" in p
    assert f"- 阅读范围：当前项目 {proj['project_dir']}" in p
    assert f"{proj['cases_root']}/PITFALLS.md" in p
    assert "- 选项：自动修复=开；复测=不复测" in p
    assert f"{proj['work_dir']}/.live/live.json" in p and "phase=done" in p
    assert "- 项目红线：不编译、不部署、不 git 提交" in p
    assert "ROUND_DONE 轮次N 新增X通过Y失败Z新bug" in p
    # 选项随任务取值（自动修复 0 → 关）
    assert "- 选项：自动修复=关" in prompts.normal_prompt(proj, _task(auto_fix=0))


@pytest.mark.parametrize("end,scope_mark,absent_mark", [
    ("gen_case", "严禁执行用例、严禁发起任何请求", "严禁写 bug 报告"),
    ("execute", "严禁写 bug 报告", "严禁执行用例、严禁发起任何请求"),
    ("", None, "- 任务终点="),          # 默认（report）不加收窄段
    ("report", None, "- 任务终点="),
])
def test_normal_prompt_end_stage_narrows_scope(tmp_path, end, scope_mark, absent_mark):
    """终点收窄每轮范围：gen_case 只建用例、execute 只执行不写报告、report 不加段。"""
    p = prompts.normal_prompt(_project(tmp_path), _task(end_stage=end))
    if scope_mark:
        assert scope_mark in p
    if absent_mark:
        assert absent_mark not in p


def test_normal_prompt_injects_builtin_flow_doc_and_templates(tmp_path):
    """流程文档与四份文件模板随首轮注入，且约束块在前、文档在后。"""
    # 片段取自 builtin_prompts/free_style/ 各资产的首行标题（独立字面量，非快照全文）
    p = prompts.normal_prompt(_project(tmp_path), _task())
    for frag in ("# 自由风格探索性测试（Free Style Test）流程",
                 "## 功能分级与测试顺序",
                 "# FS0000_用例名称",          # templates/case_template.md
                 "# FS0000 状态",              # templates/status_template.md
                 "# <目录名> 索引",            # templates/index_template.md
                 "# <一句话标题>"):            # templates/bug_report_template.md
        assert frag in p, frag
    assert p.count("\n\n---\n\n") >= 4                       # 模板以分隔线依次附在文档后
    assert p.index("ROUND_DONE") < p.index("## 功能分级与测试顺序")
    # 探索首轮不注入压测资产
    assert "# 压力测试场景生成流程（平台内置）" not in p


def test_normal_prompt_date_range_priority_and_degradation(tmp_path, monkeypatch):
    """带提交日期范围注入「优先范围 + 提交/变更文件摘录」；无范围不出现；摘录失败降级。"""
    proj = _project(tmp_path)
    # 无日期范围：整段不出现
    p = prompts.normal_prompt(proj, _task())
    assert "- 优先范围" not in p and "提交日期范围" not in p
    # 有日期范围：摘录成功
    _stub_git_ok(monkeypatch)
    p = prompts.normal_prompt(proj, _task(date_from="2026-01-01", date_to="2026-01-31"))
    assert "- 优先范围：" in p
    assert "- 提交日期范围：2026-01-01 .. 2026-01-31" in p
    assert "- 范围内提交（1 条）：" in p and "abc123 2026-01-02 张三 修复登录" in p
    assert "- 变更文件（2 个，去重）：" in p and "src/api/order.py" in p
    assert p.index("优先范围") < p.index("- 停止条件")     # 插在停止条件之前
    # 只填一端：另一端按「最早/现在」渲染
    p = prompts.normal_prompt(proj, _task(date_to="2026-01-31"))
    assert "- 提交日期范围：最早 .. 2026-01-31" in p
    # 摘录成功但范围内无提交 / 摘录失败：都要给出可读原因并让 agent 自行判断
    monkeypatch.setattr(lib, "git_log_changes",
                        lambda d, f="", t="", limit=100: {"ok": True, "commits": [],
                                                         "files": []})
    p = prompts.normal_prompt(proj, _task(date_from="2026-01-01"))
    assert "该日期范围内没有提交" in p
    monkeypatch.setattr(lib, "git_log_changes",
                        lambda d, f="", t="", limit=100: {"ok": False, "error": "git 不可用"})
    p = prompts.normal_prompt(proj, _task(date_from="2026-01-01"))
    assert "- git 摘录失败（git 不可用）" in p


# ---------- 3. 项目上下文与能力 skill 注入 ----------

def test_project_context_injects_label_guide_and_skills(tmp_path):
    """项目上下文段：环境标签/项目附加提示/三个分析类 skill；全空则整段不出现。"""
    proj = _project(tmp_path, env_label="测试环境 A", guide_text="提交需带 BUG-123",
                    skill_understand="理解项目-skill", skill_test="测试-skill",
                    skill_cases="用例-skill")
    p = prompts.normal_prompt(proj, _task())
    assert "\n- 项目上下文：\n" in p
    assert "- 环境标签：测试环境 A（测试/修复/部署针对该环境）" in p
    assert "- 项目附加提示（如何理解项目/写 commit/部署等）：\n  提交需带 BUG-123" in p
    assert "理解项目：优先使用 skill「理解项目-skill」" in p
    assert "测试项目：优先使用 skill「测试-skill」" in p
    assert "用例规范：生成用例时遵循 skill「用例-skill」" in p
    # 未配置：段落为空，提示词里不出现空的「项目上下文」标题
    bare = _project(tmp_path)
    assert prompts._project_context(bare) == ""
    assert "- 项目上下文：" not in prompts.normal_prompt(bare, _task())


# ---------- 4. regression（存量回归） ----------

def test_regression_prompt_instruction_and_end_stage(tmp_path):
    """回归轮：重跑指令取自 extra（唯一依据），终点决定失败用例是否写报告。"""
    proj = _project(tmp_path)
    instr = "只重跑登录与导出模块的用例"
    p = prompts.regression_prompt(proj, _task(task_type="regression", extra=instr))
    assert _TITLE_REGRESSION in p
    assert "严禁生成任何新用例" in p
    assert f"- 案例库根目录：{proj['cases_root']}（只读取，不登记新用例）" in p
    assert f"- 重跑范围指令（用户提供，选取要重跑用例的唯一依据）：\n---\n{instr}\n---\n" in p
    assert "不生成新用例、不修改用例的断言与步骤" in p
    assert "REGRESSION_DONE 重跑X通过Y失败Z" in p
    # 终点=execute：失败只回状态，严禁写报告；默认（report）→ 允许为该失败建报告
    assert "严禁写 bug 报告" in prompts.regression_prompt(
        proj, _task(task_type="regression", end_stage="execute"))
    p = prompts.regression_prompt(proj, _task(task_type="regression", end_stage="report"))
    assert "按流程文档为该失败创建 bug 报告" in p and "严禁写 bug 报告" not in p
    # 指令缺失时的兜底占位，不能出现空白的「唯一依据」段
    assert "（未填写）" in prompts.regression_prompt(proj, _task(task_type="regression"))


# ---------- 5. stress（压测首轮） ----------

def test_stress_prompt_case_package(tmp_path):
    """压测首轮：方案包三件套产出契约 + 用户压测说明注入 + 严禁发请求 + 注入内置资产。"""
    proj = _project(tmp_path, env_label="预发")
    brief = "目标 http://127.0.0.1:8080，关注 /api/order 下单，2 组档位"
    p = prompts.stress_prompt(proj, _task(task_type="stress", id=88,
                                          payload=json.dumps({"brief": brief})))
    assert _TITLE_STRESS in p and "本轮只生成压测方案包，绝不发任何请求" in p
    cdir = f"{proj['cases_root']}/load/task_88"
    assert f"- 方案包目录：{cdir}（本轮只允许在该目录内写文件）" in p
    assert f"1. {cdir}/plan.md（必产）" in p
    assert f"2. 执行载体二选一：简单 HTTP 压测写 {cdir}/scenario.json" in p
    assert f"run.py（按《流程文档》的脚本契约" in p
    assert f"3. {cdir}/charts.json（建议产）" in p
    assert brief in p and "- 压测说明（用户提供，目标服务地址与关注接口以它为准）" in p
    assert "- 环境标签：预发（测试/修复/部署针对该环境）" in p
    assert "本轮严禁向任何地址发请求、不做压测" in p and "不在方案包目录之外写文件" in p
    assert f"{proj['cases_root']}/load/INDEX.md" in p
    assert "STRESS_DONE 方案要点（目标/驱动/面板数）" in p
    # 压测内置资产（流程文档 + 方案/图表/场景/索引四份模板）
    assert "# 压力测试方案生成流程（平台内置）" in p
    assert "# 压测方案文档模板" in p and "# 图表声明模板" in p
    assert "# 压测场景 JSON 模板" in p and "# 压测场景索引" in p
    assert "MetricsWriter" in p and "TS_METRICS_FILE" in p
    assert "# 自由风格探索性测试（Free Style Test）流程" not in p
    # 未填压测说明：兜底占位而非空段
    p2 = prompts.stress_prompt(proj, _task(task_type="stress"))
    assert "（未填写，按案例库与项目信息自行确定）" in p2


# ---------- 6. fix（bug 修复，按终点拼阶段块） ----------

@pytest.mark.parametrize("end,stages", [
    ("analyze", ["阶段一 报告分析"]),
    ("", ["阶段一 报告分析", "阶段二 问题修复"]),                 # 存量任务回落终点=问题修复
    ("fix", ["阶段一 报告分析", "阶段二 问题修复"]),
    ("deploy", ["阶段一 报告分析", "阶段二 问题修复", "阶段三 重新部署"]),
    ("retest", ["阶段一 报告分析", "阶段二 问题修复", "阶段三 重新部署", "阶段四 复测"]),
])
def test_fix_prompt_stage_blocks_by_end_stage(tmp_path, end, stages):
    """修复轮：起点固定报告分析，阶段块按终点拼接，未达阶段不得出现。"""
    proj, bug = _bug_env(tmp_path)
    p = prompts.fix_prompt(proj, _task(task_type="fix", end_stage=end,
                                       payload=json.dumps({"bug_dir": bug}), auto_commit=1))
    all_stages = ["阶段一 报告分析", "阶段二 问题修复", "阶段三 重新部署", "阶段四 复测"]
    for s in all_stages:
        assert (s in p) == (s in stages), (end, s)
    assert _TITLE_FIX in p and _TITLE_NORMAL not in p
    assert f"- bug 报告目录：{proj['bug_dir']}/{bug}/" in p
    assert "- bug_report.md 全文：\n---\n# 登录接口异常" in p      # 报告全文随首轮下发
    assert f"任务范围：报告分析 → {prompts.STAGE_LABELS[end or 'fix']}" in p
    assert f"- 选项：自动提交=开；自动部署={'开' if end in ('deploy', 'retest') else '关'}；" in p
    assert ("自动复测=开（复测在本任务内执行，平台不再另建复测任务）" in p) == (end == "retest")
    assert ("FIX_DONE 已分析" in p) == (end == "analyze")
    if end == "analyze":                     # 终点=分析：不碰代码/不提交
        assert "不修改项目代码、不部署、不 git 提交、不改报告其他小节" in p
    else:
        assert "自动提交=关：严禁执行任何形式的 git commit" in p
        assert "'FIX_DONE 方案要点（已提交:是/否 已部署:" in p
        assert "已复测:" in p
    if end not in ("analyze", "deploy", "retest"):
        # 不到部署的阶段（fix/存量回落）在红线里显式禁止部署与重启服务
        assert "；严禁执行任何部署/重启服务操作" in p
        assert "已部署:否" in p
    if end == "retest":
        assert "已部署:是/否 已复测:是/否" in p


def test_fix_prompt_commit_and_deploy_skill_rewrites_clause(tmp_path):
    """能力 skill 绑定：skill_commit/skill_deploy 非空时改写对应条款，空则回落文字步骤。"""
    proj, bug = _bug_env(tmp_path)
    payload = json.dumps({"bug_dir": bug})
    proj_skill = dict(proj, skill_commit="提交-skill", skill_deploy="部署-skill")
    p = prompts.fix_prompt(proj_skill, _task(task_type="fix", end_stage="retest",
                                             payload=payload))
    assert "修复完成后使用 skill「提交-skill」完成 git commit" in p
    assert "自动部署=开：使用 skill「部署-skill」自动部署到环境标签对应的测试环境并重启服务" in p
    assert "直接 git commit" not in p
    p = prompts.fix_prompt(proj, _task(task_type="fix", end_stage="retest", payload=payload))
    assert "修复完成后直接 git commit" in p
    assert "自动部署=开：按项目附加提示词中的部署说明" in p
    assert "若 git 状态/权限不允许提交，在摘要中说明原因" in p
    # 终点不到部署：部署 skill 不参与（无部署块）
    p = prompts.fix_prompt(proj_skill, _task(task_type="fix", end_stage="fix",
                                             payload=payload))
    assert "阶段三 重新部署" not in p and "使用 skill「部署-skill」" not in p


def test_retest_prompt_scope_three_way(tmp_path):
    """复测轮三档范围：仅复测（默认）/ 重新部署→复测 / 仅重新部署。"""
    proj, bug = _bug_env(tmp_path)
    payload = json.dumps({"bug_dir": bug})
    # ① 存量行（start/end 均空）→ 不部署直接复测
    p = prompts.retest_prompt(proj, _task(task_type="retest_bug", payload=payload))
    assert _TITLE_RETEST in p
    assert f"- 关联用例（已在平台侧标记「需要复测」）：\n- FS0001：{proj['cases_root']}" in p
    assert "- FS0002：" in p
    assert "阶段一 重新部署" not in p and "、不部署；" in p
    assert "RETEST_SUMMARY 通过X失败Y" in p
    # ② 起点=deploy → 先部署再复测（红线不再含「不部署」）
    p = prompts.retest_prompt(proj, _task(task_type="retest_bug", start_stage="deploy",
                                          end_stage="retest", payload=payload))
    assert "阶段一 重新部署：" in p and "、不部署；" not in p
    assert "按项目附加提示词中的部署说明（指定的部署 skill 或文字步骤）部署到" in p
    # ③ 终点=deploy → 只部署验证，不复测
    p = prompts.retest_prompt(proj, _task(task_type="retest_bug", start_stage="deploy",
                                          end_stage="deploy", payload=payload))
    assert "「仅重新部署」（唯一任务：只部署验证，不复测用例）" in p
    assert "不重跑用例、不生成新用例、不修改项目代码与案例库、不 git 提交" in p
    assert "RETEST_DONE 已部署（验证结果）" in p and "RETEST_SUMMARY" not in p
    # skill_deploy 非空 → 部署块改走 skill
    proj_skill = dict(proj, skill_deploy="部署-skill")
    p = prompts.retest_prompt(proj_skill, _task(task_type="retest_bug", start_stage="deploy",
                                                end_stage="retest", payload=payload))
    assert "阶段一 重新部署：\n使用 skill「部署-skill」部署到环境标签对应的测试环境并重启服务" in p


def test_retest_prompt_only_cases_subset(tmp_path):
    """payload.only_cases（脚本复测失败升级）：只列该子集并注入脚本修正背景，未知 id 忽略。"""
    proj, bug = _bug_env(tmp_path)
    task = _task(task_type="retest_bug",
                 payload=json.dumps({"bug_dir": bug, "only_cases": ["FS0001"]}))
    p = prompts.retest_prompt(proj, task)
    assert "- FS0001：" in p and "- FS0002：" not in p
    assert "平台已用各用例固化的 verify.py 脚本做过一轮复测" in p
    assert "脚本已修正" in p
    # only_cases 含库里不存在的 id → 视同未指定，回全量清单
    p = prompts.retest_prompt(proj, _task(task_type="retest_bug",
                                          payload=json.dumps({"bug_dir": bug,
                                                              "only_cases": ["FS9999"]})))
    assert "- FS0001：" in p and "- FS0002：" in p
    assert "verify.py 脚本做过一轮复测" not in p


def test_retest_bug_no_report_with_date_range_documents_known_defect(tmp_path):
    """已知缺陷固化（记录不修）：retest_bug 带日期范围且未绑定报告时，retest_prompt
    引用未定义的 log（prompts.py 中 `return retest_range_prompt(project, task, log)`）
    → NameError，日期范围复测的回落路径实际不可用。

    本用例只固化当前行为，不是对外契约；缺陷修复后应改为断言正常回落到
    retest_range_prompt 的提示词（含「受影响用例：」固定行要求）。
    """
    proj = _project(tmp_path)
    task = _task(task_type="retest_bug", date_from="2026-01-01", date_to="2026-01-31")
    with pytest.raises(NameError, match="log"):
        prompts.first_round_prompt(proj, task)
    # 回落目标本身可用：直接调用 retest_range_prompt 生成日期范围复测首轮
    p = prompts.retest_range_prompt(proj, task)
    assert "日期范围复测任务（唯一任务，不生成新用例、不写 bug 报告）" in p
    assert "- 提交日期范围：2026-01-01 .. 2026-01-31" in p
    assert "要求 2：判断完成后单独输出一行：'受影响用例：FS0001、FS0002'" in p
    assert "无受影响用例输出'受影响用例：无'" in p


# ---------- 7. reject（修例） ----------

def test_reject_prompt_reason_cases_and_pitfalls(tmp_path):
    """修例轮：拒绝理由/关联用例/误报教训录注入，红线禁止再动报告与提交。"""
    proj, bug = _bug_env(tmp_path)
    reason = "误报：断言把正常 401 当异常"
    p = prompts.reject_prompt(proj, _task(task_type="reject",
                                          payload=json.dumps({"bug_dir": bug,
                                                              "reason": reason})))
    assert _TITLE_REJECT in p
    assert f"- 用户拒绝理由（修例的根本依据）：\n---\n{reason}\n---\n" in p
    assert "- 关联用例（case 目录）：\n- FS0001：" in p and "- FS0002：" in p
    assert f"{proj['cases_root']}/PITFALLS.md" in p and "# 误报教训录" in p
    assert "不修改 bug 报告文件本身（平台已标记「已拒绝」）" in p
    assert "REJECT_DONE 修正X删除Y 教训要点" in p
    # payload 无 reason → 占位；报告无关联用例目录 → 只沉淀教训的降级文案
    empty = _mk_bug(proj, name="20260902_0900_FS9999_孤立报告", case_ids=("FS9999",))
    p = prompts.reject_prompt(proj, _task(task_type="reject",
                                          payload=json.dumps({"bug_dir": empty})))
    assert "（未填写）" in p
    assert "（未解析到关联用例，跳过用例修正，只沉淀教训）" in p


# ---------- 8. pipeline（后段任务） ----------

@pytest.mark.parametrize("end,steps,deploy", [
    ("report", ["1. 逐枚阅读 bug 报告全文"], False),
    ("retest", ["1. 逐枚阅读 bug 报告全文", "2. 对确认成立的问题逐枚修复",
                "3. 全部修复完成后", "4. 逐枚重跑各报告关联用例"], True),
])
def test_pipeline_prompt_bug_listing_and_stages(tmp_path, end, steps, deploy):
    """后段任务：报告清单逐枚执行，阶段由终点裁剪（≥fix/部署/复测逐级追加）。"""
    proj = _project(tmp_path)
    dirs = ["20260901_1200_FS0001_登录异常", "20260902_0900_FS0002_导出超时"]
    p = prompts.pipeline_prompt(proj, _task(task_type="pipeline", end_stage=end,
                                            payload=json.dumps({"bug_dirs": dirs})))
    assert _TITLE_PIPELINE in p
    assert f"任务范围：报告分析 → {prompts.STAGE_LABELS[end]}" in p
    for d in dirs:
        assert f"- {proj['bug_dir']}/{d}/" in p
    for s in steps:
        assert s in p, s
    # 未达阶段不得出现
    for s in ("2. 对确认成立的问题逐枚修复", "3. 全部修复完成后",
              "4. 逐枚重跑各报告关联用例"):
        assert (s in p) == (s in steps), s
    assert ("、不部署/重启服务" in p) == (not deploy)
    assert ("部署:是/否" if deploy else "部署:否") in p
    assert "PIPELINE_DONE 分析X修复Y" in p
    # 清单为空 → 占位，不留空段
    p2 = prompts.pipeline_prompt(proj, _task(task_type="pipeline", end_stage="report"))
    assert "（无）" in p2


# ---------- 9. 跨类型：阶段进度行 / 附加要求 / 缺输入回落 ----------

@pytest.mark.parametrize("task_type,has_line", [
    ("normal", False), ("stress", False), ("reject", False),
    ("regression", True), ("fix", True), ("retest_bug", True), ("pipeline", True),
])
def test_stage_progress_reporting_line_by_type(tmp_path, task_type, has_line):
    """阶段进度上报行只加在 fix/retest_bug/pipeline/regression 四类（写 live.json）。"""
    proj, bug = _bug_env(tmp_path)
    payload = {"fix": {"bug_dir": bug}, "retest_bug": {"bug_dir": bug},
               "reject": {"bug_dir": bug, "reason": "r"},
               "pipeline": {"bug_dirs": [bug]}}.get(task_type, {})
    task = _task(task_type=task_type, payload=json.dumps(payload) if payload else "")
    p = prompts.first_round_prompt(proj, task)
    line = f"{proj['work_dir']}/.live/live.json 的 phase=done 或当前阶段 key"
    assert ("阶段进度上报" in p) == has_line
    assert (line in p) == has_line


def test_first_round_appends_task_extra_last(tmp_path):
    """任务附加要求（extra）追加在末尾且声明优先；空白 extra 不注入。"""
    proj, bug = _bug_env(tmp_path)
    extra = "只测登录接口，不要动其他模块"
    p = prompts.first_round_prompt(proj, _task(task_type="fix", extra=extra,
                                               payload=json.dumps({"bug_dir": bug})))
    assert "用户附加要求（平台转达，务必遵守；如与上面约束冲突以本段为准）:" in p
    assert p.rstrip().endswith(extra)
    assert "阶段进度上报" in p and p.index("阶段进度上报") < p.index("用户附加要求")
    for blank in ("", "   \n  "):
        assert "用户附加要求" not in prompts.first_round_prompt(
            proj, _task(task_type="normal", extra=blank))


def test_prompts_fall_back_to_normal_when_linked_inputs_missing(tmp_path):
    """payload 缺关联报告（或报告文件读不到）时，fix/retest_bug/reject 一律回落常规探索。"""
    proj = _project(tmp_path)
    for tt in ("fix", "retest_bug", "reject"):
        p = prompts.first_round_prompt(proj, _task(task_type=tt))
        assert _TITLE_NORMAL in p, tt
        assert _TITLE_FIX not in p and _TITLE_REJECT not in p, tt
    # 声明了 bug_dir 但报告文件不存在（lib.read_text 返空）→ 同样回落
    p = prompts.first_round_prompt(proj, _task(task_type="fix",
                                               payload=json.dumps({"bug_dir": "不存在"})))
    assert _TITLE_NORMAL in p and _TITLE_FIX not in p


def test_invalid_payload_json_degrades_to_empty(tmp_path):
    """payload 非法 JSON 时按空 payload 处理（不抛错）：无报告回落、压测说明走兜底。"""
    proj = _project(tmp_path)
    assert _TITLE_NORMAL in prompts.first_round_prompt(
        proj, _task(task_type="fix", payload="{不是 JSON"))
    p = prompts.stress_prompt(proj, _task(task_type="stress", payload="{不是 JSON"))
    assert "（未填写，按案例库与项目信息自行确定）" in p
    assert "（无）" in prompts.pipeline_prompt(
        proj, _task(task_type="pipeline", payload="{不是 JSON"))


# ---------- 10. 续轮 / compact / 内置资产 ----------

def test_next_round_and_compact_prompts():
    """续轮短 prompt：探索/回归分版且带轮次号；compact 固定 /compact。"""
    p = prompts.next_round_prompt(3)
    assert "第 3 轮" in p and "自由风格探索测试" in p
    assert "ROUNDS.md" in p and "根 INDEX.md" in p and ".live/live.json" in p
    assert "ROUND_DONE" in p and "约束同首轮" in p
    r = prompts.next_round_prompt(3, _task(task_type="regression"))
    assert "第 3 轮" in r and "存量用例回归" in r and "重跑范围指令" in r
    assert "严禁生成任何新用例" in r and "REGRESSION_DONE" in r
    assert "自由风格探索测试" not in r
    assert "自由风格探索测试" in prompts.next_round_prompt(2, _task(task_type="normal"))
    assert prompts.compact_prompt() == "/compact"


def test_builtin_assets_present_and_required():
    """内置提示词资产齐备（缺一即 RuntimeError，宁可任务失败也不注入残缺流程）。"""
    for rel in ("flow.md", "load_test.md",
                "templates/case_template.md", "templates/status_template.md",
                "templates/index_template.md", "templates/bug_report_template.md",
                "templates/load_scenario_template.md", "templates/load_index_template.md"):
        text = prompts._load_asset(*rel.split("/"))
        assert text.strip(), rel
    with pytest.raises(RuntimeError, match="内置提示词资产缺失或为空"):
        prompts._load_asset("__不存在的资产__.md")
