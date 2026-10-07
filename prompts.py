#!/usr/bin/env python3
"""Touchstone 每轮 prompt 模板。

首轮携带完整约束（案例库根目录/bug_report 目录/阅读范围/选项/红线）；
常规测试轮还注入内置流程文档与文件模板（builtin_prompts/free_style/），
不依赖 agent 侧配置任何 skill；续轮同一会话只发短 prompt，约束靠会话上下文保持。
任务类型（task.task_type）决定首轮提示词：
- normal     常规测试轮（自由风格探索测试：生成/执行用例，流程由内置资产注入；
             end_stage 收窄每轮范围：gen_case 只建用例 / execute 只执行不报告）
- regression 存量用例回归：按必填指令重跑用例，不生成新用例
- stress     压测任务首轮：生成压测场景 JSON（只写文件不发请求），平台随后发压
- fix        处理一枚 bug 报告（起点=报告分析，终点可选 报告分析/问题修复/重新部署/复测）
- retest_bug 复测 bug 报告关联用例；范围三选一（仅复测/重新部署→复测/仅重新部署）
- reject     报告被用户拒绝：按拒绝理由修正关联用例，教训沉淀 PITFALLS.md
- pipeline   后段任务：对前段探索/回归产出的 bug 报告清单逐枚执行 报告分析→终点
"""

import json
import os

import export_cases
import lib
import rag

# 内置提示词资产目录：builtin_prompts/free_style/（流程文档 + 文件模板）
_ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "builtin_prompts", "free_style")
# 资产读取缓存（进程内只读一次磁盘）
_ASSET_CACHE = {}

# 生命周期阶段（与 server.STAGES / runner.STAGES / 前端 STAGES 保持一致；
# prompts 不 import server 防循环依赖）
STAGE_ORDER = ("gen_case", "execute", "report", "analyze", "fix", "deploy", "retest")
STAGE_LABELS = {"gen_case": "测试用例生成", "execute": "测试", "report": "生成报告",
                "analyze": "报告分析", "fix": "问题修复", "deploy": "重新部署",
                "retest": "复测"}


def _load_asset(*names):
    """读取 builtin_prompts/free_style/ 下的内置提示词资产（带缓存）。

    names 为相对 _ASSET_DIR 的路径分段；文件缺失或为空时抛 RuntimeError——
    宁可任务失败留日志，也不给 agent 注入残缺流程。
    """
    key = "/".join(names)
    if key not in _ASSET_CACHE:
        text = lib.read_text(os.path.join(_ASSET_DIR, *names))
        if not text:
            raise RuntimeError(f"内置提示词资产缺失或为空: {os.path.join(_ASSET_DIR, *names)}")
        _ASSET_CACHE[key] = text
    return _ASSET_CACHE[key]


def _free_style_doc():
    """拼接自由风格测试流程文档与全部文件模板（首轮 prompt 注入用）。

    模板依次附在流程文档之后，用分隔线隔开；flow.md 末尾的「附带文件模板」
    一节与该拼接顺序一一对应。
    """
    parts = [_load_asset("flow.md")]
    for name in ("case_template.md", "status_template.md", "index_template.md",
                 "bug_report_template.md"):
        parts.append("\n\n---\n\n" + _load_asset("templates", name))
    return "".join(parts)


def first_round_prompt(project, task, log=None):
    """构建首轮 prompt。project/task: sqlite Row；log 可选任务日志回调
    （日期范围复测的 RAG 检索统计行，见 retest_range_prompt）。"""
    task_type = task["task_type"] or "normal"
    if task_type == "fix":
        prompt = fix_prompt(project, task)
    elif task_type == "retest_bug":
        prompt = retest_prompt(project, task)
    elif task_type == "stress":
        prompt = stress_prompt(project, task)
    elif task_type == "regression":
        prompt = regression_prompt(project, task)
    elif task_type == "pipeline":
        prompt = pipeline_prompt(project, task)
    elif task_type == "reject":
        prompt = reject_prompt(project, task)
    else:
        prompt = normal_prompt(project, task)
    # 阶段任务：要求 agent 按阶段推进更新 live.json 的 phase/phase_label（仅监控展示，
    # 平台不做硬依赖）；探索/压测的 phase 约定由现有流程文档/压测 prompt 承担
    if task_type in ("fix", "retest_bug", "pipeline", "regression"):
        prompt += ("\n---\n阶段进度上报（仅监控展示）：每完成/进入一个阶段，更新 "
                   f"{project['work_dir']}/.live/live.json 的 phase=done 或当前阶段 key、"
                   "phase_label=当前阶段中文名。\n")
    extra = (task["extra"] or "").strip()
    if extra:
        prompt += ("\n\n---\n用户附加要求（平台转达，务必遵守；如与上面约束冲突以本段为准）:\n"
                   + extra + "\n")
    return prompt


def _project_context(project):
    """项目配置的上下文段落：环境标签/项目附加提示词/能力 skill。

    提交规范与部署说明已并入项目附加提示词（guide_text），不再单独注入；
    项目绑定能力 skill（skill_understand/skill_test/skill_cases）时在此追加注入行。
    所有任务类型（测试/修复/复测）的首轮 prompt 都附带，供 agent 理解项目。
    """
    parts = []
    img = (project["env_label"] or "").strip()
    if img:
        parts.append(f"- 环境标签：{img}（测试/修复/部署针对该环境）")
    guide = (project["guide_text"] or "").strip()
    if guide:
        parts.append(f"- 项目附加提示（如何理解项目/写 commit/部署等）：\n  {guide}")
    skill = (project["skill_understand"] or "").strip()
    if skill:
        parts.append(f"- 理解项目：优先使用 skill「{skill}」分析项目结构与约定")
    skill = (project["skill_test"] or "").strip()
    if skill:
        parts.append(f"- 测试项目：优先使用 skill「{skill}」了解本项目的测试方式"
                     "（启动/运行/环境/压测等要求）")
    skill = (project["skill_cases"] or "").strip()
    if skill:
        parts.append(f"- 用例规范：生成用例时遵循 skill「{skill}」的用例命名/结构/登记规范")
    if not parts:
        return ""
    return "\n".join(parts)


def _date_range_ctx(project, task):
    """提交日期范围上下文段：范围说明 + 范围内 git 提交/变更文件摘录。

    task 带 date_from/date_to（YYYY-MM-DD，空=不限）时返回多行文本，
    无日期范围返回空串；git 摘录失败时给范围说明并注明原因。
    """
    df = (task["date_from"] or "").strip()
    dt = (task["date_to"] or "").strip()
    if not (df or dt):
        return ""
    log = lib.git_log_changes(project["project_dir"], df, dt)
    lines = [f"- 提交日期范围：{df or '最早'} .. {dt or '现在'}（本任务优先覆盖该范围内提交）"]
    commits = log.get("commits") or [] if log.get("ok") else []
    files = log.get("files") or [] if log.get("ok") else []
    if commits:
        lines.append(f"- 范围内提交（{len(commits)} 条）：")
        lines.append("  " + "\n  ".join(commits[:60]))
    if files:
        more = f" …共 {len(files)} 个" if len(files) > 50 else ""
        lines.append(f"- 变更文件（{len(files)} 个，去重）：")
        lines.append("  " + "\n  ".join(files[:50]) + more)
    elif log.get("ok"):
        lines.append("- 该日期范围内没有提交（非 git 仓库或时间段无提交），按项目当前代码自行判断")
    else:
        lines.append(f"- git 摘录失败（{log.get('error') or '未知原因'}），按项目当前代码自行判断")
    return "\n".join(lines) + "\n"


def _date_range_priority(project, task):
    """探索任务优先范围段：在普通探索约束里插入「先分析范围内提交、优先相关用例」。"""
    ctx = _date_range_ctx(project, task)
    if not ctx:
        return ""
    return ("- 优先范围：先按下方提交清单分析改动涉及的模块与文件，"
            "本轮优先设计并执行与这些改动相关的用例；\n" + ctx)


def normal_prompt(project, task):
    """常规测试轮：执行一轮自由风格探索测试（流程文档与模板由平台注入）。

    end_stage 收窄每轮范围：gen_case 只生成用例不执行；execute 执行回状态不写
    bug 报告；report 及以后为现状完整行为（后续阶段由平台创建的后段任务承接）。
    """
    auto_fix = "开" if task["auto_fix"] else "关"
    end = task["end_stage"] or "report"
    if end == "gen_case":
        scope = ("- 任务终点=测试用例生成：每轮只按模板生成新用例并登记各级 INDEX/status，"
                 "严禁执行用例、严禁发起任何请求；\n")
    elif end == "execute":
        scope = ("- 任务终点=测试：每轮生成新用例并执行，回写 status.md 与 execution 记录；"
                 "发现失败只记录用例状态，严禁写 bug 报告；\n")
    else:
        scope = ""
    ctx = _project_context(project)
    ctx_block = f"- 项目上下文：\n{ctx}\n" if ctx else ""
    date_part = _date_range_priority(project, task)
    head = (
        "执行一轮自由风格探索测试，严格按下方《流程文档》与《文件模板》执行，约束如下：\n"
        f"- 案例库根目录：{project['cases_root']}（INDEX.md/ROUNDS.md 不存在则按附带模板初始化）\n"
        f"- bug_report 输出到：{project['bug_dir']}\n"
        f"- 阅读范围：当前项目 {project['project_dir']}\n"
        f"- 误报教训：生成用例前必读 {project['cases_root']}/PITFALLS.md"
        "（历史被用户否决的报告及原因），避开其中记录的误报模式；文件不存在则跳过\n"
        f"- 选项：自动修复={auto_fix}；复测={task['retest']}\n"
        f"{scope}"
        f"{date_part}"
        f"{ctx_block}"
        f"- 停止条件：只执行这一轮；结束后写 {project['work_dir']}/.live/live.json 的 "
        "phase=done 并输出本轮摘要\n"
        "- 项目红线：不编译、不部署、不 git 提交\n"
        "- 最后用一行输出本轮摘要：'ROUND_DONE 轮次N 新增X通过Y失败Z新bug'\n"
    )
    return head + "\n---\n\n" + _free_style_doc() + "\n"


def _stress_doc():
    """拼接压测流程文档与方案包模板（stress 首轮 prompt 注入用）。

    模板以 --- 分隔线跟在流程文档后；顺序与 load_test.md 正文的引用一致
    （方案文档 → 图表声明 → 场景 → INDEX）。
    """
    parts = [_load_asset("load_test.md")]
    for name in ("load_plan_template.md", "load_charts_template.md",
                 "load_scenario_template.md", "load_index_template.md"):
        parts.append("\n\n---\n\n" + _load_asset("templates", name))
    return "".join(parts)


def stress_prompt(project, task):
    """压测任务首轮：生成压测方案包（方案文档 + 执行载体 + 图表声明）。

    方案包固定落在 <案例库根>/load/task_<任务id>/（平台按任务 id 直接定位，不经
    INDEX 解析）；用户压测说明（payload.brief）是目标地址与关注接口的权威来源。
    本轮只写文件不发请求，发压由平台第 2 步以统一脚本驱动执行。
    """
    brief = _task_payload(task).get("brief", "") or "（未填写，按案例库与项目信息自行确定）"
    cdir = f"{project['cases_root']}/load/task_{task['id']}"
    return (
        "压测任务（第 1 步/共 2 步，本轮只生成压测方案包，绝不发任何请求）：\n"
        f"- 方案包目录：{cdir}（本轮只允许在该目录内写文件）\n"
        f"- 压测说明（用户提供，目标服务地址与关注接口以它为准）：\n---\n{brief}\n---\n"
        f"- 案例库根目录：{project['cases_root']}（用例记录了接口事实；说明未覆盖的"
        f"接口细节阅读 {project['project_dir']} 代码确认，不要臆造）\n"
        f"{_project_context(project)}"
        "产出（格式见下方《压测流程文档》与各模板）：\n"
        f"1. {cdir}/plan.md（必产）：压测方案文档，按《方案文档模板》写全"
        "（目标/接口/加压模型/指标定义/通过标准）；\n"
        f"2. 执行载体二选一：简单 HTTP 压测写 {cdir}/scenario.json（按《场景模板》，"
        "字段与取值范围不符合会导致平台校验失败）；需要多协议/有状态链路/业务自定义"
        f"度量时写 {cdir}/run.py（按《流程文档》的脚本契约，用 loadgen.MetricsWriter 上报指标）；\n"
        f"3. {cdir}/charts.json（建议产）：按《图表声明模板》声明本次要看的图"
        "（吞吐/延迟/错误率之外的业务量也一视同仁，如委托数、各状态分布）；\n"
        f"4. 同步更新 {project['cases_root']}/load/INDEX.md（不存在则按附带模板新建），"
        "登记本方案一行；\n"
        "要求：\n"
        "- plan.md 必须是 **Markdown**：`#/##/###` 分节、`|` 管道表格、`-` 与 `1.` 列表、"
        "反引号包代码与路径——平台「压测方案」页直接渲染它（标题/表格/列表/引用块都有排版），"
        "空格对齐的伪表格与纯文本大段不会成表；开头一段「- 键：值」抬头会渲染成方案抬头栏；\n"
        "- 指标命名与图表声明必须一致：charts.json 引用的每个 metric 都要真的上报；\n"
        "- 红线：本轮严禁向任何地址发请求、不做压测、不启动/停止服务、不编译、"
        "不部署、不 git 提交；不在方案包目录之外写文件；发压由平台在第 2 步自动执行；\n"
        f"- 写完文件后更新 {project['work_dir']}/.live/live.json 的 "
        "phase=done，并输出一行摘要：'STRESS_DONE 方案要点（目标/驱动/面板数）'。"
    ) + "\n---\n\n" + _stress_doc() + "\n"


def fix_prompt(project, task):
    """修复任务首轮：起点固定「报告分析」，按终点拼接 报告分析→(修复→部署→复测)。

    存量任务（无 end_stage）回落终点=问题修复，行为与拆块前一致；能力 skill
    绑定（skill_commit/skill_deploy 非空时改写对应条款）原样保留。
    """
    bug = _linked_bug(project, task)
    if bug is None:
        return normal_prompt(project, task)
    bug_dir_name, content = bug
    end = task["end_stage"] or "fix"
    auto_commit = "开" if task["auto_commit"] else "关"
    do_deploy = end in ("deploy", "retest")
    do_retest = end == "retest"
    # 复测选项行：终点=复测时注明复测在本任务内执行（平台不再另建复测任务）；
    # 终点<复测（仅分析/修复/部署）时只显示「自动复测=关」
    retest_opt = ("自动复测=开（复测在本任务内执行，平台不再另建复测任务）\n" if do_retest
                  else "自动复测=关\n")
    ctx = _project_context(project)
    ctx_block = f"\n- 项目上下文：\n{ctx}" if ctx else ""
    # 能力 skill 绑定：部署/提交仅在字段非空时改写对应要求文案；红线与开关语义不动
    skill_commit = (project["skill_commit"] or "").strip()
    skill_deploy = (project["skill_deploy"] or "").strip()
    if skill_commit:
        commit_req = ("修复完成后使用 skill「" + skill_commit + "」完成 git commit"
                      "（仅 add 本次改动的文件）；严禁 git push；"
                      "若 git 状态/权限不允许提交，在摘要中说明原因")
    else:
        commit_req = ("修复完成后直接 git commit（仅 add 本次改动的文件，"
                      "commit message 需符合项目附加提示词中的 git commit 规范）；"
                      "严禁 git push；若 git 状态/权限不允许提交，在摘要中说明原因")
    head = (
        f"处理以下 bug 报告（任务范围：报告分析 → {STAGE_LABELS[end]}），逐阶段执行：\n"
        f"- bug 报告目录：{project['bug_dir']}/{bug_dir_name}/\n"
        f"- bug_report.md 全文：\n---\n{content}\n---\n"
        f"- 相关项目代码根：{project['project_dir']}"
        f"{ctx_block}\n"
        f"- 选项：自动提交={auto_commit}；自动部署={'开' if do_deploy else '关'}；{retest_opt}"
        "\n阶段一 报告分析：\n"
        "1. 对照报告全文与项目代码核实问题是否成立、确认根因与触发条件；\n"
        "2. 把结论写回该报告 bug_report.md 的「## 报告分析」小节"
        "（是否成立/根因/涉及文件:行号/建议修复方向）。\n"
    )
    if end == "analyze":
        return head + (
            "终点即报告分析：不修改项目代码、不部署、不 git 提交、不改报告其他小节；\n"
            "最后用一行输出摘要：'FIX_DONE 已分析（结论要点）'。"
        )
    parts = [
        "\n阶段二 问题修复（修复=直接修改项目代码）：\n"
        "1. 按报告推荐方案修复：直接修改项目代码（文件:行号 已在报告中给出）；\n"
        "2. 自动提交=开：" + commit_req + "；\n"
        "   自动提交=关：严禁执行任何形式的 git commit（含经远程/消息通道委托提交），"
        "不应为验证修复而提交代码；\n",
    ]
    if do_deploy:
        if skill_deploy:
            deploy_req = ("使用 skill「" + skill_deploy + "」自动部署到环境标签对应的"
                          "测试环境并重启服务，完成后给出验证结果；"
                          "部署失败要说明原因与已完成的步骤")
        else:
            deploy_req = ("按项目附加提示词中的部署说明（指定的部署 skill 或文字步骤）"
                          "自动部署到环境标签对应的测试环境并重启服务，完成后给出验证结果；"
                          "部署失败要说明原因与已完成的步骤")
        parts.append(
            "\n阶段三 重新部署：\n"
            "自动部署=开：" + deploy_req + "；\n"
            "   自动部署=关：严禁执行任何部署/重启服务操作（含经 SSH/消息通道执行），"
            "如需部署仅给出命令让用户自行执行；\n")
    if do_retest:
        parts.append(
            "\n阶段四 复测（本任务内执行）：\n"
            "1. 重跑该报告关联的全部用例（按 case 文件执行），通过：status.md 状态改「通过」；"
            "失败：改「失败」并写失败原因，失败证据追加到该报告 bug_report.md 的"
            "「复测证据」小节；\n"
            "2. 不改动案例库用例的断言与步骤；平台将按用例状态自动更新 bug 报告状态；\n")
    redline = ("红线：自动提交=关时严禁 git commit；不要 git push、不要编译 C++"
               "（如需编译仅说明命令）、不要改动案例库与 bug 报告文件本身"
               "（「报告分析」「复测证据」小节除外）")
    if not do_deploy:
        redline += "；严禁执行任何部署/重启服务操作"
    parts.append(redline + "；\n最后用一行输出摘要：'FIX_DONE 方案要点（已提交:是/否 已部署:"
                 + ("是/否" if do_deploy else "否") + " 已复测:" + ("是/否" if do_retest else "否")
                 + " 结果）'。")
    return head + "".join(parts)


def retest_prompt(project, task):
    """复测任务首轮：范围三选一——仅复测 / 重新部署→复测 / 仅重新部署。

    payload 带 only_cases 时只复核该子集（脚本复测失败升级）。存量任务（start/end
    两列均空）回落「仅复测」，行为与拆块前一致；部署是否包含由起点列决定
    （start=deploy 才含部署），范围含部署时注入部署条款
    （skill_deploy 非空时改用对应 skill）。
    """
    bug = _linked_bug(project, task)
    if bug is None:
        # 未绑定 bug 报告：带日期范围的复测走 retest_range_prompt（无报告复测），
        # 否则回落常规探索（存量行为）
        if (task["date_from"] or task["date_to"]):
            return retest_range_prompt(project, task, log)
        return normal_prompt(project, task)
    bug_dir_name, content = bug
    end = task["end_stage"] or "retest"
    # 部署是否包含由起点决定：仅复测=(retest,retest) 不含部署；重新部署→复测=(deploy,retest)
    # 含部署；存量行（两列均空）回落起点=retest，即现状「不部署直接复测」
    start = task["start_stage"] or "retest"
    deploy_first = start == "deploy"
    case_ids = lib.bug_cases(os.path.join(project["bug_dir"], bug_dir_name))[1]
    only_cases = [c for c in (_task_payload(task).get("only_cases") or [])
                  if c in set(case_ids)]
    if only_cases:
        case_ids = only_cases
    case_dirs = lib.find_case_dirs(project["cases_root"], case_ids)
    if not case_dirs:
        return normal_prompt(project, task)
    case_lines = "\n".join(f"- {cid}：{d}" for cid, d in case_dirs)
    ctx = _project_context(project)
    ctx_block = f"- 项目上下文：\n{ctx}\n" if ctx else ""
    only_block = ""
    if only_cases:
        only_block = (
            "\n背景：平台已用各用例固化的 verify.py 脚本做过一轮复测，上述用例被脚本判定失败。\n"
            "请逐个人工复核：确认为真回归 → 按要求 2 记失败并补证据；"
            "判定脚本过期（接口/数据变化导致断言失效）→ 修正该用例 verify.py 后重跑，\n"
            "并在 execution 记录中注明「脚本已修正」。\n"
        )

    def _deploy_block():
        skill_deploy = (project["skill_deploy"] or "").strip()
        if skill_deploy:
            body = f"使用 skill「{skill_deploy}」部署到环境标签对应的测试环境并重启服务"
        else:
            body = ("按项目附加提示词中的部署说明（指定的部署 skill 或文字步骤）部署到"
                    "环境标签对应的测试环境并重启服务")
        return ("阶段一 重新部署：\n" + body + "，完成后给出验证结果；"
                "部署失败要说明原因与已完成的步骤，并按当前已部署状态继续后续阶段；\n")

    if end == "deploy":
        return (
            "对以下 bug 报告执行「仅重新部署」（唯一任务：只部署验证，不复测用例）：\n"
            f"- bug 报告目录：{project['bug_dir']}/{bug_dir_name}/\n"
            f"- bug_report.md 全文：\n---\n{content}\n---\n"
            f"{ctx_block}"
            + _deploy_block() +
            "红线：不重跑用例、不生成新用例、不修改项目代码与案例库、不 git 提交；\n"
            "最后用一行输出摘要：'RETEST_DONE 已部署（验证结果）'。"
        )
    deploy_part = _deploy_block() if deploy_first else ""
    redline = ("红线：不生成新用例、不补充新 bug 报告、不编译、不 git 提交"
               + ("" if deploy_first else "、不部署") +
               "；平台会在任务结束时按用例状态自动更新 bug 报告状态")
    return (
        "复测以下 bug 报告关联的全部用例（唯一任务，不要生成新用例）：\n"
        f"- bug 报告目录：{project['bug_dir']}/{bug_dir_name}/\n"
        f"- 关联用例（已在平台侧标记「需要复测」）：\n{case_lines}\n"
        f"{ctx_block}{only_block}"
        + deploy_part +
        "要求：\n"
        "1. 逐个用例按 case 文件（case.md/脚本）执行复测，记录每次请求与返回；\n"
        "2. 通过：status.md 状态改「通过」；失败：改「失败」并写失败原因，"
        "执行记录文件（execution_*.md）标注复测；\n"
        "3. 失败的请求/返回证据追加到该 bug 报告 bug_report.md 的「复测证据」小节；\n"
        f"4. {redline}；\n"
        "5. 最后用一行输出摘要：'RETEST_SUMMARY 通过X失败Y'。"
    )


def _semantic_order(project, task, log=None):
    """日期范围复测首轮的语义候选 id 序（RAG 未配置/失败返回空，纯增量增强）。

    query 与 runner 粗筛兜底同源：变更文件 + 提交摘录（rag.change_query）。
    log 可选任务日志回调：检索完成记一行统计（候选数 + via 分布），
    向量路失败降级 BM25 时附原因——任务日志可查「这次到底用没用 RAG」。
    """
    try:
        if not rag.load_config():
            return []  # RAG 未配置：不触发检索（retrieve 会走 BM25 兜底返回非空），保证行为与无 RAG 完全一致
        changes = lib.git_log_changes(project["project_dir"],
                                      task["date_from"], task["date_to"])
        if not changes.get("ok"):
            return []
        rows, meta = rag.retrieve_detail(project["cases_root"],
                                         rag.change_query(changes), k=15)
        if log:
            n_vec = sum(1 for r in rows if "vec" in r.get("via", ""))
            line = (f"RAG 语义排序检索：候选 {len(rows)} 条"
                    f"（bm25+vec {n_vec} / 仅bm25 {len(rows) - n_vec}）")
            if meta.get("configured") and not meta.get("vec_ok"):
                line += f"；向量路失败已降级 BM25：{meta.get('vec_error')}"
            log(line)
        return [r["id"] for r in rows]
    except Exception:
        return []


def retest_range_prompt(project, task, log=None):
    """日期范围复测首轮：先按范围内提交判断受影响用例，再逐用例复测（无 bug 报告）。

    适用范围：retest_bug 且任务带提交日期范围（date_from/date_to）、未绑定 bug 报告。
    要求 agent 以固定行「受影响用例：FS0001、FS0002」输出判断结果，平台首轮后解析
    写入 payload.only_cases（续跑/后续轮限定复测该子集）；用例清单按案例库扫描注入
    （上限 150 条，含『依据代码』供影响面映射），超出部分省略。
    log 可选任务日志回调，透传语义检索（_semantic_order）统计行。
    """
    ctx = _project_context(project)
    ctx_block = f"- 项目上下文：\n{ctx}\n" if ctx else ""
    cases = export_cases.scan_cases(project["cases_root"])
    sem_ids = _semantic_order(project, task, log)
    if sem_ids:
        rank = {cid: i for i, cid in enumerate(sem_ids)}
        cases = sorted(cases, key=lambda c: (rank.get(c["id"], len(rank)), c["id"]))
    truncated = len(cases) > 150
    case_lines = "\n".join(
        f"- {c['id']} {c['name']}（依据代码：{(c['code_refs'] or '未填写')[:100]}）"
        for c in cases[:150]) or "- （案例库暂无用例）"
    only = _task_payload(task).get("only_cases") or []
    if only:
        only_note = (
            f"\n背景：首轮已选出受影响的用例（{len(only)} 条：{'、'.join(only)}），"
            "本轮只复测该清单内的用例，不要再重复全库判断；\n"
        )
    else:
        only_note = (
            "\n要求 1：先按范围内提交计算影响面（提交改动文件 → 模块 → 用例『依据代码』"
            "映射），只选取受影响的用例进入复测范围；\n"
            "要求 2：判断完成后单独输出一行：'受影响用例：FS0001、FS0002'"
            "（仅受影响用例 id、顿号分隔；无受影响用例输出'受影响用例：无'）；\n"
        )
    sem_note = f"，前 {min(len(sem_ids), 150)} 条为语义检索相关候选" if sem_ids else ""
    return (
        "日期范围复测任务（唯一任务，不生成新用例、不写 bug 报告），约束如下：\n"
        f"- 提交日期范围：{task['date_from'] or '最早'} .. {task['date_to'] or '现在'}\n"
        f"- 范围内提交与变更文件：\n{_date_range_ctx(project, task)}"
        f"- 案例库根目录：{project['cases_root']}\n"
        f"- 用例清单（共 {len(cases)} 条"
        f"{'，仅列前 150 条' if truncated else ''}{sem_note}，"
        f"按『依据代码』映射影响面）：\n{case_lines}\n"
        f"{ctx_block}{only_note}"
        "复测执行要求：\n"
        "1. 逐个受影响用例按 case 文件（case.md/脚本）执行复测，记录每次请求与返回；\n"
        "2. 通过：status.md 状态改「通过」；失败：改「失败」并写失败原因，"
        "执行记录文件（execution_*.md）标注复测；\n"
        "3. 红线：不生成新用例、不补充 bug 报告、不编译、不部署、不 git 提交；\n"
        "4. 最后用一行输出摘要：'RETEST_SUMMARY 通过X失败Y'。"
    )


def reject_prompt(project, task):
    """修例任务：报告被用户拒绝，按拒绝理由修正关联用例并沉淀教训。

    报告状态「已拒绝」与「拒绝记录」小节由平台在创建本任务前写入，
    agent 只负责案例库侧（修正用例 + PITFALLS.md），不再动报告本身。
    """
    bug = _linked_bug(project, task)
    if bug is None:
        return normal_prompt(project, task)
    bug_dir_name, content = bug
    reason = _reject_reason(task)
    case_dirs = lib.find_case_dirs(project["cases_root"], lib.bug_cases(
        os.path.join(project["bug_dir"], bug_dir_name))[1])
    case_lines = "\n".join(f"- {cid}：{d}" for cid, d in case_dirs) \
        or "（未解析到关联用例，跳过用例修正，只沉淀教训）"
    ctx = _project_context(project)
    ctx_block = f"- 项目上下文：\n{ctx}\n" if ctx else ""
    return (
        "以下 bug 报告已被用户拒绝（判定不成立/不接受）。唯一任务：根据拒绝理由"
        "修正关联用例，并把教训沉淀到误报教训录，供后续生成用例时避开同类误报：\n"
        f"- bug 报告目录：{project['bug_dir']}/{bug_dir_name}/\n"
        f"- bug_report.md 全文：\n---\n{content}\n---\n"
        f"- 用户拒绝理由（修例的根本依据）：\n---\n{reason}\n---\n"
        f"- 关联用例（case 目录）：\n{case_lines}\n"
        f"- 案例库根目录：{project['cases_root']}\n"
        f"{ctx_block}"
        "要求：\n"
        "1. 对照报告全文与拒绝理由，判断报告不被接受的原因"
        "（误报/理解偏差/断言错误/环境问题等）；\n"
        "2. 逐个检查关联用例：按理由修正错误的断言与预期；因误报而不成立的用例"
        "直接删除（目录连同各级 INDEX.md 中的记录一并移除）；修改处在 case 文件中"
        "注明「因报告被拒修正」；\n"
        f"3. 把教训追加到 {project['cases_root']}/PITFALLS.md（不存在则新建，"
        "首行标题「# 误报教训录」），每条一行，格式：\n"
        f"   '- YYYY-MM-DD {bug_dir_name}：一句话教训（拒绝理由摘要）'"
        "（日期填当天）；\n"
        "4. 红线：不生成新用例、不修改 bug 报告文件本身（平台已标记「已拒绝」）、"
        "不编译、不部署、不 git 提交；\n"
        "5. 最后用一行输出摘要：'REJECT_DONE 修正X删除Y 教训要点'。"
    )


def _task_payload(task):
    """解析任务 payload JSON；为空或非法时返回 {}。"""
    try:
        return json.loads(task["payload"] or "{}")
    except ValueError:
        return {}


def _reject_reason(task):
    """从 payload 解析拒绝理由（创建 reject 任务时由平台写入）。"""
    try:
        return json.loads(task["payload"] or "{}").get("reason", "") or "（未填写）"
    except ValueError:
        return "（未填写）"


def _linked_bug(project, task):
    """从 payload 解析关联 bug 报告，返回 (目录名, bug_report.md 全文)，无效返回 None。"""
    bug_dir = _task_payload(task).get("bug_dir", "")
    if not bug_dir:
        return None
    dir_path = os.path.join(project["bug_dir"], bug_dir)
    content = lib.read_text(os.path.join(dir_path, "bug_report.md"))
    return (bug_dir, content) if content else None


def regression_prompt(project, task):
    """回归轮：按用户指令重跑存量用例（不生成新用例）。

    指令存任务 extra（创建时必填），是选取重跑用例的唯一依据；终点=execute
    时失败只回状态，≥report 时失败用例按流程写 bug 报告（不新建用例）。
    """
    end = task["end_stage"] or "report"
    instruction = (task["extra"] or "").strip() or "（未填写）"
    ctx = _project_context(project)
    ctx_block = f"- 项目上下文：\n{ctx}\n" if ctx else ""
    if end == "execute":
        scope = "- 任务终点=测试：失败用例只回写状态与执行记录，严禁写 bug 报告；\n"
    else:
        scope = ("- 任务终点含「生成报告」：失败用例除回写状态外，按流程文档为该失败"
                 "创建 bug 报告（关联该用例；不新建用例）；\n")
    return (
        "执行一轮存量用例回归（唯一任务：重跑已有用例，严禁生成任何新用例），约束如下：\n"
        f"- 案例库根目录：{project['cases_root']}（只读取，不登记新用例）\n"
        f"- 重跑范围指令（用户提供，选取要重跑用例的唯一依据）：\n---\n{instruction}\n---\n"
        f"- 阅读范围：当前项目 {project['project_dir']}\n"
        f"{ctx_block}"
        f"{scope}"
        "- 执行要求：逐个选中用例按 case 文件执行，回写 status.md 状态与执行记录"
        "（execution_*.md）；\n"
        "- 项目红线：不生成新用例、不修改用例的断言与步骤（仅状态/执行记录）、"
        "不编译、不部署、不 git 提交；\n"
        f"- 停止条件：只执行这一轮；结束后更新 {project['work_dir']}/.live/live.json "
        "phase=done 并输出一行摘要：'REGRESSION_DONE 重跑X通过Y失败Z'\n"
    )


def pipeline_prompt(project, task):
    """后段任务首轮：对前段探索/回归产出的 bug 报告清单逐枚执行 报告分析→终点。

    清单由平台在任务启动时按「bug 目录时间戳 ≥ 前段任务 created_at」固化进
    payload.bug_dirs；终点≥fix/部署/复测时追加对应阶段。
    """
    end = task["end_stage"] or "report"
    try:
        bug_dirs = json.loads(task["payload"] or "{}").get("bug_dirs") or []
    except ValueError:
        bug_dirs = []
    listing = "\n".join(f"- {project['bug_dir']}/{d}/" for d in bug_dirs) or "（无）"
    ctx = _project_context(project)
    ctx_block = f"- 项目上下文：\n{ctx}\n" if ctx else ""
    steps = ["1. 逐枚阅读 bug 报告全文与项目代码，把核实结论写回该报告"
             "「## 报告分析」小节（不改代码）；\n"]
    do_fix = STAGE_ORDER.index(end) >= STAGE_ORDER.index("fix")
    do_deploy = STAGE_ORDER.index(end) >= STAGE_ORDER.index("deploy")
    do_retest = STAGE_ORDER.index(end) >= STAGE_ORDER.index("retest")
    if do_fix:
        steps.append("2. 对确认成立的问题逐枚修复（直接修改项目代码，按报告推荐方案）；\n")
    if do_deploy:
        skill_deploy = (project["skill_deploy"] or "").strip()
        deploy_body = (f"使用 skill「{skill_deploy}」" if skill_deploy
                       else "按项目附加提示词中的部署说明")
        steps.append(f"3. 全部修复完成后，{deploy_body}重新部署到环境标签"
                     "对应的测试环境并重启服务，给出验证结果；\n")
    if do_retest:
        steps.append("4. 逐枚重跑各报告关联用例（按 case 文件执行），回写 status.md，"
                     "失败证据追加到报告「复测证据」小节；平台将按用例状态更新各 bug 报告状态；\n")
    redline = ("红线：不生成新用例、不改用例断言与步骤、不 git 提交"
               + ("" if do_deploy else "、不部署/重启服务") + "；\n")
    return (
        "后段任务：处理前一段探索/回归任务产出的全部 bug 报告（清单如下），"
        f"任务范围：报告分析 → {STAGE_LABELS[end]}，逐枚按顺序执行：\n"
        f"{listing}\n"
        f"- 案例库根目录：{project['cases_root']}（复测用例只执行不修改）\n"
        f"{ctx_block}"
        + "".join(steps) + redline +
        "最后用一行输出摘要：'PIPELINE_DONE 分析X修复Y部署:"
        + ("是/否" if do_deploy else "否") + "复测通过Z失败W'。"
    )


def next_round_prompt(round_no, task=None):
    """续轮短 prompt（同会话）：探索/回归分版（回归续轮同样不生成新用例）。"""
    if task is not None and (task["task_type"] or "normal") == "regression":
        return (
            f"继续执行存量用例回归第 {round_no} 轮：仍严禁生成任何新用例，按首轮"
            "「重跑范围指令」继续选取未重跑的用例执行并回写状态，约束同首轮"
            "（重跑指令、终点范围、红线）；只执行这一轮，结束后更新工作目录下 "
            ".live/live.json phase=done 并输出 'REGRESSION_DONE 重跑X通过Y失败Z' 摘要行。"
        )
    return (
        f"继续执行自由风格探索测试第 {round_no} 轮：换一个 ROUNDS.md 未记录过的"
        "角度生成新 case，并按根 INDEX.md「功能分级」节从高优先级到低优先级推进"
        "（高优先级功能域未覆盖时不选边界/异常类细节角度），"
        "约束同首轮（案例库根目录、bug_report 目录、阅读范围、"
        "选项、红线）；只执行这一轮，结束后更新工作目录下 .live/live.json phase=done "
        "并输出 'ROUND_DONE ...' 摘要行。"
    )


def compact_prompt():
    """轮次开始前的上下文压缩提示（kimi 支持，其余 agent 日志注明跳过）。"""
    return "/compact"

