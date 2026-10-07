#!/usr/bin/env python3
"""dsh 插件族（路线 A：进程内 agent 驱动）单测（2026-10-02 批次）。

覆盖范围：
- 族判定与扫描虚拟条目（agents.py）
- 能力位与会话解析族归一（server.family_capabilities / _sess_family）
- 驱动客户端（dshdriver）：SSE 帧解析、TurnWaiter 语义、URL 拆分与未配置态
- 轮次事件 → 平台日志行翻译（runner.dsh_event_to_log_line）
- runner 轮次分派（_run_round → _run_round_dshplugin，单族无兜底分支）
- sessparse 的 dsh 会话文件定位（v3/v4 版本化文件名 + 裸 uuid 目录）
- board 侧的族接入（_web_family / _dsh_answers / _iw_interaction 帧→三态）

零外部依赖：不打任何真实 HTTP——dshdriver 的 _request 全部打桩，
board 的 dshdriver.status 打桩。例外：P7a 缺陷 C 的两例起本进程内的最小 SSE 桩
（真 socket、回环地址），因为「阻塞 read1 能否被 stop 唤醒」只能在真 socket 上验证。
"""
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import agents
import board
import chat
import db
import dshdriver
import runner
import sessparse
import server
import waitq


# ---------- 族判定与扫描 ----------

@pytest.mark.parametrize("path,expected", [
    ("dsh-plugin:/usr/bin/dsh", "dsh_plugin"),   # 前缀优先于 basename
    ("dsh-plugin:", "dsh_plugin"),               # 裸前缀（scan_agents 产出的形态）
    # 无冒号的 "dsh-plugin" 自 2026-10-03 起也归 dsh_plugin（它落到「未知/空默认族」
    # 分支），不再能区分前缀语义；能区分的反例只剩退场族（P7b 单族化）：
    ("/opt/bin/kimi", "retired"),                # 旧 CLI 族可执行名
    ("/opt/bin/dsh", "retired"),                 # dsh CLI（headless）已退场
    ("kimi-web:/usr/bin/kimi", "retired"),       # 旧虚拟前缀优先于 basename
])
def test_agent_family_dsh_plugin(path, expected):
    assert agents.agent_family(path) == expected


def test_scan_agents_only_plugin_entry(monkeypatch):
    """dsh 存在时**只回**「插件·进程内」一条（P7b B7 起裸 dsh CLI 行不再返回）。"""
    monkeypatch.setattr(agents.shutil, "which",
                        lambda b: "/usr/bin/dsh" if b == "dsh" else None)
    monkeypatch.setattr(agents, "_probe_version", lambda p: "0.131.4")
    monkeypatch.setattr(agents, "_search_extra", lambda n: None)
    items = agents.scan_agents()
    plugin = [i for i in items if i["path"].startswith(agents.DSH_PLUGIN_PREFIX)]
    assert len(plugin) == 1
    assert plugin[0]["path"] == agents.DSH_PLUGIN_PREFIX + "/usr/bin/dsh"
    assert "插件" in plugin[0]["name"]
    # 扫描面收敛：只此一条（kimi/opencode/claude/hermes 已退场；裸 dsh CLI 属 retired
    # 族、不再作为可选项出现在「智能体」下拉里）
    assert [i["name"] for i in items] == ["dsh（插件·进程内）"]
    assert items[0]["version"] == "0.131.4" and items[0]["found"] is True


# ---------- 会话级权限档（2026-10-04 修「权限控件恒置灰」） ----------

def test_session_permission_mode_source():
    """权限档取值（会话窗「权限」控件的数据源）：平台三档 mode 优先；无 mode 时按宿主
    preset 反查近似档位；两者皆无 → 空串（调用方不下发 ⇒ 前端保持置灰，不猜）。

    yolo/auto 在正向映射里落到同一宿主 preset（多对一），故**只有** mode 能区分它们；
    反查只在平台没记过档位的会话（外部直跑后接管）用，统一取 yolo。
    """
    assert server._session_permission_mode(None) == ""
    assert server._session_permission_mode({}) == ""
    assert server._session_permission_mode({"permission": None}) == ""
    assert server._session_permission_mode(
        {"permission": {"mode": "manual", "preset": "workspace-write"}}) == "manual"
    assert server._session_permission_mode(
        {"permission": {"mode": "auto", "preset": "danger-full-access"}}) == "auto"
    # mode 缺席（外部会话/老插件）：preset 反查
    assert server._session_permission_mode(
        {"permission": {"mode": "", "preset": "workspace-write"}}) == "manual"
    assert server._session_permission_mode(
        {"permission": {"mode": "", "preset": "danger-full-access"}}) == "yolo"
    assert server._session_permission_mode(
        {"permission": {"mode": "", "preset": "没见过的 preset"}}) == ""
    # 反查表与正向表同源：manual 往返一致（yolo/auto 多对一，不参与往返断言）
    assert server.DSH_PRESET_MODES[server.DSH_PERMISSION_PRESETS["manual"]] == "manual"
    assert (server.DSH_PERMISSION_PRESETS["yolo"]
            == server.DSH_PERMISSION_PRESETS["auto"] == "danger-full-access")


def test_set_permission_passes_mode(monkeypatch):
    """`dshdriver.set_permission` 把平台三档 mode 随写下传（不带 mode 时请求体不出现该字段，
    兼容老插件：驱动侧按「来源不明」清 mode、只留 preset 实况）。"""
    calls = []
    monkeypatch.setattr(dshdriver, "_request",
                        lambda m, p, payload=None, timeout=None:
                        calls.append((m, p, payload)) or {})
    dshdriver.set_permission("sid-1", "workspace-write", mode="manual")
    assert calls[-1] == ("POST", "/permission",
                         {"session_id": "sid-1", "preset": "workspace-write",
                          "mode": "manual"})
    dshdriver.set_permission("sid-1", "danger-full-access")
    assert calls[-1][2] == {"session_id": "sid-1", "preset": "danger-full-access"}


# ---------- 能力位 / 解析族归一 ----------

def test_family_capabilities_dsh_plugin():
    """dsh_plugin 能力位（2026-10-03 P3 两批全开后）：stream/chat/queue/steer/
    abort 加 compact（驱动 /compact）、fork（宿主 sessionController.fork）、
    profile（**模型**切换，驱动 /model）、permission（**权限档**切换，驱动
    /permission → permissionPresets 近似映射）、rewind（fork(atSeq) 等价实现）
    全 True；events=True（插件全局状态流）。"""
    caps = server.family_capabilities("dsh_plugin")
    assert caps == {"stream": True, "chat": True, "queue": True, "steer": True,
                    "abort": True, "compact": True, "fork": True, "rewind": True,
                    "profile": True, "permission": True, "events": True}


def test_family_capabilities_profile_bit():
    """profile/permission 能力位：dsh 两开；已退场族路径（旧 CLI 可执行名 / 旧虚拟
    前缀）一律全 False（前端据此隐藏输入区与控制控件，不再按族名硬编码）。"""
    dsh = server.family_capabilities("dsh_plugin")
    assert dsh["profile"] is True and dsh["permission"] is True
    for fam in ("/usr/bin/kimi", "kimi-web:/x", "/usr/bin/dsh"):
        assert agents.agent_family(fam) == agents.RETIRED_FAMILY, fam   # 确为退场族路径
        caps = server.family_capabilities(fam)
        assert caps["profile"] is False and caps["permission"] is False, fam
        assert caps["chat"] is False and caps["steer"] is False, fam


def test_family_capabilities_events_bit():
    """`events` 能力位（P4 会话窗口事件化）：只有**有推送通道**的族为真
    （单族世界仅 dsh_plugin；已退场族无事件源）。前端据此决定是否走 SSE 事件唤醒。"""
    assert server.family_capabilities("dsh_plugin")["events"] is True
    for fam in ("/usr/bin/kimi", "kimi-web:/x", "/usr/bin/dsh"):
        assert agents.agent_family(fam) == agents.RETIRED_FAMILY, fam   # 确为退场族路径
        assert server.family_capabilities(fam)["events"] is False, fam


def test_sess_family_and_chat_families():
    """dsh_plugin 的会话就是 dsh 宿主会话 → 按 dsh 解析族读取；且是唯一可续聊族。"""
    assert server._sess_family("dsh_plugin") == "dsh"
    assert chat.CHAT_FAMILIES == ("dsh_plugin",)


# ---------- 退场族防呆（B0 遗留项，B4 落地） ----------

def test_enter_doing_retired_family_errors():
    """退场族项目（旧 CLI / 旧 web 前缀路径）起会话入口：不入队、不落列、不建行，
    直接返回明确错误（前端/端点按既有硬错误分支透出 4xx JSON）。"""
    proj = {"id": 4242, "agent_path": "/usr/bin/kimi", "project_dir": "/tmp/p",
            "work_dir": "/tmp/w"}
    card = {"id": 4242, "project_id": 4242, "title": "t", "description": "",
            "column_key": "todo", "sort_order": 1, "session_id": "",
            "sessions": "[]", "block_kind": None, "block_text": "",
            "parent_card_id": None, "origin": "", "done_at": None,
            "trashed": 0, "trashed_at": None, "scheduled_at": None,
            "jira_key": "", "last_error": "", "last_error_at": None,
            "created_at": 0, "updated_at": 0}
    out, err = board._enter_doing(proj, card)
    assert out is None
    assert err == {"error": agents.RETIRED_MSG}
    # 未产生任何等待项（不入队）：退场族在入口就被拦下
    assert waitq.get_active(waitq.KIND_CARD, card["id"]) is None


def test_start_card_retired_family_errors():
    """退场族项目起会话：start_card 记 last_error 后抛 RETIRED_MSG（worker 拾取路径
    按既有 RuntimeError 分支回滚），不落任何驱动调用。"""
    uid = uuid.uuid4().hex[:8]
    pid = db.insert_project(0, f"retired-{uid}", f"/tmp/retired-{uid}",
                            "/usr/bin/kimi", f"/tmp/retired-{uid}/work")
    proj = db.get_project(pid)
    cid = db.insert_board_card(pid, "退场族卡")
    card = db.get_board_card(cid)
    with pytest.raises(RuntimeError, match="该智能体族已下线"):
        board.start_card(proj, card)
    assert db.get_board_card(cid)["last_error"] == agents.RETIRED_MSG


# ---------- dshdriver：SSE 帧解析 ----------

def test_parse_stream_line():
    assert dshdriver.parse_stream_line(': keepalive') is None
    assert dshdriver.parse_stream_line('') is None
    assert dshdriver.parse_stream_line('data: not-json') is None
    assert dshdriver.parse_stream_line('data: {"type":"turn/end"}') == {"type": "turn/end"}


def test_split_url_and_configured(monkeypatch):
    monkeypatch.delenv(dshdriver.URL_ENV, raising=False)
    assert dshdriver.configured() is False
    with pytest.raises(dshdriver.DshDriverError):
        dshdriver._split_url()
    monkeypatch.setenv(dshdriver.URL_ENV, "http://127.0.0.1:3080/touchstone-agent")
    assert dshdriver.configured() is True
    assert dshdriver._split_url() == ("127.0.0.1", 3080, "/touchstone-agent")


def test_error_str_and_args():
    """错误串是纯消息（不出现元组），但 args 保持 (code, message) 供既有判据读。"""
    err = dshdriver.DshDriverError(40405, "提问不存在或已应答")
    assert str(err) == "提问不存在或已应答"
    assert err.args[0] == 40405
    assert err.code == 40405


def test_turn_exit_code():
    assert dshdriver.turn_exit_code("completed") == 0
    assert dshdriver.turn_exit_code("aborted") == 130
    assert dshdriver.turn_exit_code("error") == 1
    assert dshdriver.turn_exit_code(None) == 1


# ---------- dshdriver：TurnWaiter ----------

def test_turn_waiter_turn_end():
    w = dshdriver.TurnWaiter()
    w.feed({"type": "turn/start", "seq": 1, "data": {"turn": 1}})
    assert w.started is True
    assert w.wait_turn(0.05) == "timeout"
    w.feed({"type": "turn/end", "seq": 2,
            "data": {"turn": 1, "reason": {"kind": "completed"}}})
    assert w.wait_turn(0.05) == "turn_end"
    assert w.exit_code == 0
    assert w.turn_reason == "completed"


def test_turn_waiter_null_reason_normalized_to_aborted():
    """P7a 缺陷 H：会话流 turn/end 的 `reason=null`（dsh cancel 落盘形态）必须判
    「用户中断」（130）而不是失败（1）——插件归一 + 平台侧兜底两道都要有，
    装机副本可能是旧版（`file:` 拷贝）时靠这里兜住。"""
    w = dshdriver.TurnWaiter()
    w.feed({"type": "turn/end", "seq": 1, "data": {"turn": 1, "reason": None}})
    assert w.wait_turn(0.05) == "turn_end"
    assert w.turn_reason == "aborted" and w.exit_code == 130
    # 显式 reason 不被兜底覆盖
    w2 = dshdriver.TurnWaiter()
    w2.feed({"type": "turn/end", "seq": 1,
             "data": {"turn": 1, "reason": {"kind": "error"}}})
    assert w2.turn_reason == "error" and w2.exit_code == 1
    # reason 键缺失（更旧的形态）同样按中断处理
    w3 = dshdriver.TurnWaiter()
    w3.feed({"type": "turn/end", "seq": 1, "data": {"turn": 1}})
    assert w3.turn_reason == "aborted" and w3.exit_code == 130


def test_turn_waiter_interaction_consume_on_read():
    """挂起交互帧：一次 wait_turn 返回 interaction 后即清零（同一轮多次提问不空转）。"""
    w = dshdriver.TurnWaiter()
    mark = {"kind": "question", "call_id": "c1", "questions": []}
    w.feed({"type": "driver/interaction", "seq": None,
            "data": {"state": "asked", "interaction": mark}})
    assert w.wait_turn(0.05) == "interaction"
    assert w.interaction is None
    assert w.started is True                    # 提问意味着 turn 已在跑
    assert w.wait_turn(0.05) == "timeout"


def test_turn_waiter_fail():
    w = dshdriver.TurnWaiter()
    w.fail("链路僵死")
    assert w.wait_turn(0.05) == "error"
    assert w.error == "链路僵死"


def test_turn_waiter_blocks_until_fed():
    """等待是条件变量阻塞而非轮询：另一个线程喂帧即唤醒。"""
    w = dshdriver.TurnWaiter()

    def feeder():
        time.sleep(0.1)
        w.feed({"type": "turn/end", "seq": 3, "data": {"reason": {"kind": "aborted"}}})

    threading.Thread(target=feeder, daemon=True).start()
    started = time.time()
    assert w.wait_turn(5) == "turn_end"
    assert time.time() - started < 3
    assert w.exit_code == 130


# ---------- dshdriver：HTTP 客户端（打桩 _request） ----------

def test_client_endpoints(monkeypatch):
    """各端点的 method/path/payload 拼装（不真发请求）。"""
    calls = []

    def fake_request(method, path, payload=None, timeout=None):
        calls.append((method, path, payload))
        if path == "/health":
            return {"ok": True}
        if path.startswith("/status"):
            return {"status": "running", "last_seq": 7}
        if path == "/session":
            return {"session_id": payload.get("session_id") or "session-new"}
        if path == "/answer":
            return {"accepted": True}
        return {}

    monkeypatch.setenv(dshdriver.URL_ENV, "http://127.0.0.1:3080/touchstone-agent")
    monkeypatch.setattr(dshdriver, "_request", fake_request)

    assert dshdriver.health() == {"ok": True}
    assert dshdriver.create_session("/tmp/x", task="t1", model="m") == "session-new"
    assert dshdriver.resume_session("session-a", task="t1") == "session-a"
    assert dshdriver.ensure_session("session-a", "/tmp/x") == "session-a"
    assert dshdriver.ensure_session("", "/tmp/x") == "session-new"
    assert dshdriver.status("session-a")["last_seq"] == 7
    assert dshdriver.answer_question("session-a", "call1", [{"id": "q_0"}]) is True
    paths = [c[1] for c in calls]
    assert "/health" in paths
    assert any(p.startswith("/status?session_id=") for p in paths)
    # 建会话不带 session_id（新建 → 插件侧生成 sid）；恢复带（resume）。
    # 显式 create/resume 各 1 次 + ensure_session 两条分支各 1 次 = 2 / 2
    create = [c for c in calls if c[1] == "/session" and "session_id" not in c[2]]
    resume = [c for c in calls if c[1] == "/session" and c[2].get("session_id")]
    assert len(create) == 2 and len(resume) == 2
    answer = [c for c in calls if c[1] == "/answer"][0]
    assert answer[0] == "POST" and answer[2]["call_id"] == "call1"


def test_client_p3_endpoints(monkeypatch):
    """P3 对齐端点的拼装（compact / fork / rename / set_model；不真发请求）。"""
    calls = []

    def fake_request(method, path, payload=None, timeout=None):
        calls.append((method, path, payload))
        if path == "/fork":
            return {"new_session_id": "session-fork-1"}
        if path == "/rename":
            return {"title": payload["title"]}
        if path == "/model":
            return {"selected": {"provider": payload.get("provider"),
                                 "model": payload["model"]}}
        if path == "/compact":
            return {"started": True}
        return {}

    monkeypatch.setattr(dshdriver, "_request", fake_request)
    assert dshdriver.compact("session-a") == {"started": True}
    assert dshdriver.fork("session-a")["new_session_id"] == "session-fork-1"
    assert dshdriver.fork("session-a", at_seq=7)["new_session_id"] == "session-fork-1"
    assert dshdriver.rename("session-a", "标题")["title"] == "标题"
    sel = dshdriver.set_model("session-a", "p/m", reasoning_effort="high")
    # `provider/model` 的拆分在**插件侧**做（见 JS 契约自检的两项 /model 检查），
    # Python 客户端原样透传；这里只钉住透传与返回值。
    assert sel["selected"]["model"] == "p/m"
    assert calls[0] == ("POST", "/compact", {"session_id": "session-a"})
    assert calls[1] == ("POST", "/fork", {"session_id": "session-a"})
    assert calls[2] == ("POST", "/fork", {"session_id": "session-a", "at_seq": 7})
    assert calls[3] == ("POST", "/rename",
                        {"session_id": "session-a", "title": "标题"})
    assert calls[4] == ("POST", "/model",
                        {"session_id": "session-a", "model": "p/m",
                         "reasoning_effort": "high"})


# ---------- 事件 → 轮次日志行 ----------

def test_dsh_event_to_log_line_assistant():
    line = runner.dsh_event_to_log_line({
        "type": "assistant/message",
        "data": {"message": {"content": [{"type": "text", "text": "你好"}]}}})
    assert json.loads(line) == {"role": "assistant", "content": "你好", "tool_calls": []}


def test_dsh_event_to_log_line_interrupted_prefix():
    line = runner.dsh_event_to_log_line({
        "type": "assistant/message", "data": {"interrupted": True,
        "message": {"content": [{"type": "text", "text": "半句"}]}}})
    assert "中断" in json.loads(line)["content"]


def test_dsh_event_to_log_line_tool_call_and_result():
    call = json.loads(runner.dsh_event_to_log_line({
        "type": "tool/call",
        "data": {"name": "bash", "arguments": '{"command":"ls"}'}}))
    assert call["role"] == "assistant" and call["tool_calls"][0]["function"]["name"] == "bash"
    res = json.loads(runner.dsh_event_to_log_line({
        "type": "tool/result",
        "data": {"message": {"toolCallId": "c1",
                             "content": [{"type": "text", "text": "ok"}]}}}))
    assert res == {"role": "tool", "tool_call_id": "c1", "content": "ok"}


def test_dsh_event_to_log_line_tool_error_appended():
    res = json.loads(runner.dsh_event_to_log_line({
        "type": "tool/result",
        "data": {"message": {"toolCallId": "c1", "content": []},
                 "error": {"name": "BashError", "code": "E1", "reason": "崩了"}}}))
    assert "BashError" in res["content"] and "崩了" in res["content"]


def test_dsh_event_to_log_line_skips_noise():
    """平台自身已记录的事件（prompt/状态/结束）不重复落行。"""
    for ftype in ("turn/end", "user/message", "agent/status", "step/start",
                  "assistant/message"):
        assert runner.dsh_event_to_log_line({"type": ftype, "data": {}}) is None
    line = runner.dsh_event_to_log_line({"type": "driver/interaction", "data": {}})
    assert line.startswith("### ")


def test_dsh_event_log_line_is_single_line():
    """多行文本必须 JSON 转义成单行（read_dialogue 按行解析的前提）。"""
    line = runner.dsh_event_to_log_line({
        "type": "tool/result",
        "data": {"message": {"toolCallId": "c", "content": [
            {"type": "text", "text": "第一行\n第二行"}]}}})
    assert line.count("\n") == 1 and line.endswith("\n")


# ---------- runner：轮次分派 ----------

def test_run_round_dispatches_dsh_plugin(monkeypatch):
    """_run_round 对 dsh_plugin 走 _run_round_dshplugin（不起子进程）。"""
    inst = runner.Runner.__new__(runner.Runner)
    called = []
    monkeypatch.setattr(runner.Runner, "_run_round_dshplugin",
                        lambda self, p, t, r: (called.append((p, t, r)) or (0, "sid")))
    monkeypatch.setattr(runner.platcompat, "spawn_session",
                        lambda *a, **k: pytest.fail("dsh_plugin 不得起子进程"))
    out = inst._run_round({"project_dir": "/tmp", "work_dir": "/tmp"},
                          {"id": 1}, 1, "dsh_plugin")
    assert out == (0, "sid") and called


# ---------- sessparse：dsh 会话文件定位 ----------

def test_sid_dsh_re_accepts_both_forms():
    assert sessparse.SID_DSH_RE.match("session-0886b806-9330-41a8-be02-492d1769ca54")
    assert sessparse.SID_DSH_RE.match("64655aea-41fe-4daa-8948-4c3e9448297c")
    assert not sessparse.SID_DSH_RE.match("../../etc/passwd")
    assert not sessparse.SID_DSH_RE.match("")


def test_dsh_pick_file_prefers_versioned(tmp_path):
    """同目录多个版本文件时取版本号最大者（v4 > v3 > 无版本）。"""
    (tmp_path / "session.jsonl.zstd").write_text("plain")
    (tmp_path / "session.v3.jsonl.zstd").write_text("v3")
    (tmp_path / "session.v4.jsonl.zstd").write_text("v4")
    assert sessparse._dsh_pick_file(str(tmp_path)).endswith("session.v4.jsonl.zstd")
    (tmp_path / "session.v4.jsonl.zstd").unlink()
    assert sessparse._dsh_pick_file(str(tmp_path)).endswith("session.v3.jsonl.zstd")
    (tmp_path / "session.v3.jsonl.zstd").unlink()
    assert sessparse._dsh_pick_file(str(tmp_path)).endswith("session.jsonl.zstd")


def test_dsh_session_file_locates_versioned(tmp_path, monkeypatch):
    """v4 版本化文件名能被 _dsh_session_file 命中（真机踩坑：只认无版本名）。"""
    sid = "session-11111111-2222-3333-4444-555555555555"
    sdir = tmp_path / "bucket" / sid
    sdir.mkdir(parents=True)
    (sdir / "session.v4.jsonl.zstd").write_bytes(b"x")
    monkeypatch.setattr(sessparse, "DSH_SESSIONS", str(tmp_path))
    assert sessparse._dsh_session_file(sid) == str(sdir / "session.v4.jsonl.zstd")


def test_dsh_session_file_rejects_bad_sid(tmp_path, monkeypatch):
    monkeypatch.setattr(sessparse, "DSH_SESSIONS", str(tmp_path))
    assert sessparse._dsh_session_file("../../etc") is None


# ---------- board：族接入 ----------

def _proj(agent_path):
    return {"id": 1, "agent_path": agent_path, "project_dir": "/tmp/p",
            "work_dir": "/tmp/p/.ts"}


def test_web_family_includes_dsh_plugin():
    """dsh-plugin 前缀（唯一在跑族）按 web 处置；空串/未知路径落到默认族
    （也是 dsh_plugin）；退场族路径（旧 CLI 名 / 旧虚拟前缀）归 retired → None。"""
    assert board._web_family(_proj("dsh-plugin:")) == "dsh_plugin"
    assert board._web_family(_proj("")) == "dsh_plugin"            # 空串=默认族
    assert board._web_family(_proj("/opt/bin/unknown")) == "dsh_plugin"   # 未知路径=默认族
    assert board._web_family(_proj("/usr/bin/kimi")) is None       # 退场族：旧 CLI 名
    assert board._web_family(_proj("kimi-web:/usr/bin/kimi")) is None    # 退场族：旧虚拟前缀
    assert board._web_family(_proj("/usr/bin/dsh")) is None        # 退场族：dsh CLI


def test_session_state_reads_hub(monkeypatch):
    """P4：dsh 会话三态读 EventHub 注册表（**零请求**）——原为逐会话 /status。

    未知（未连接 / 不在注册表）⇒ STATE_UNKNOWN：绝不推断空闲。
    """
    monkeypatch.setattr(board.dshevents, "get", lambda sid: {"status": "running"})
    assert board._session_state_family("dsh_plugin", "/tmp", "session-x") == board.STATE_RUNNING
    monkeypatch.setattr(board.dshevents, "get", lambda sid: {"status": "idle"})
    assert board._session_state_family("dsh_plugin", "/tmp", "session-x") == board.STATE_IDLE
    monkeypatch.setattr(board.dshevents, "get", lambda sid: None)
    assert board._session_state_family("dsh_plugin", "/tmp", "session-x") == board.STATE_UNKNOWN

    # 读口不碰驱动：驱动层被炸掉也照样工作（这就是「事件化」的可证伪断言）
    def boom(*a, **kw):
        raise AssertionError("P4 后 board 不应再调 dshdriver 读状态")
    monkeypatch.setattr(board.dshdriver, "status", boom)
    monkeypatch.setattr(board.dshdriver, "live", boom)
    monkeypatch.setattr(board.dshevents, "get", lambda sid: {"status": "running"})
    assert board._session_state_family("dsh_plugin", "/tmp", "session-x") == board.STATE_RUNNING


def test_dsh_answers_conversion():
    """平台作答载荷 → dsh 原生（selected/custom）形态。"""
    out = board._dsh_answers([
        {"wire": "q_0", "kind": "single", "option_id": "A", "option_ids": [], "text": ""},
        {"wire": "q_1", "kind": "multi", "option_id": "", "option_ids": ["B", "C"], "text": ""},
        {"wire": "q_2", "kind": "other", "option_id": "", "option_ids": [], "text": "自由输入"},
    ])
    assert out == [{"id": "q_0", "selected": ["A"]},
                   {"id": "q_1", "selected": ["B", "C"]},
                   {"id": "q_2", "selected": [], "custom": "自由输入"}]


def test_iw_interaction_dsh_question(monkeypatch):
    """挂起提问（插件内存态）→ 三态字典：pending/kind/qid(=callId)/逐题视图。"""
    mark = {"kind": "question", "call_id": "call-9",
            "questions": [{"id": "q1", "header": "选一个", "question": "用哪个？",
                           "multi": False, "options": ["A", "B"]}]}
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "running", "interaction": mark})
    r = board._iw_interaction("dsh_plugin", _proj("dsh-plugin:"), "session-x")
    assert r["pending"] is True and r["busy"] is True
    assert r["kind"] == "question" and r["qid"] == "call-9"
    assert r["answerable"] is True
    assert r["questions"][0]["id"] == "q1"
    assert r["questions"][0]["options"] == [{"id": "A", "label": "A", "description": ""},
                                            {"id": "B", "label": "B", "description": ""}]
    assert r["questions"][0]["allow_other"] is True


def test_iw_interaction_dsh_options_with_description(monkeypatch):
    """插件对象形态选项（{label, description}）+ 题面 detail：#791 修复后
    会话窗要渲染「选项主行 + 描述次行」，detail 落 body。"""
    mark = {"kind": "question", "call_id": "tsq-1-abc",
            "questions": [{"id": "route", "header": "选择路线", "question": "按哪条路线？",
                           "detail": "补充说明", "multi": True,
                           "options": [{"label": "A. 推荐", "description": "首选"},
                                       {"label": "B. 次选", "description": ""},
                                       "C. 纯字符串兼容项"]}]}
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "running", "interaction": mark})
    r = board._iw_interaction("dsh_plugin", _proj("dsh-plugin:"), "session-x")
    assert r["pending"] is True and r["answerable"] is True
    assert r["qid"] == "tsq-1-abc"
    assert r["questions"][0]["body"] == "补充说明"
    assert r["questions"][0]["multi_select"] is True
    assert r["questions"][0]["options"] == [
        {"id": "A. 推荐", "label": "A. 推荐", "description": "首选"},
        {"id": "B. 次选", "label": "B. 次选", "description": ""},
        {"id": "C. 纯字符串兼容项", "label": "C. 纯字符串兼容项", "description": ""},
    ]
    # 首题平面字段与逐题视图同源（老载荷兼容）
    assert r["options"] == r["questions"][0]["options"]
    assert r["body"] == "补充说明"


def test_iw_interaction_dsh_empty_call_id_not_answerable(monkeypatch):
    """无提问标识（外部会话 legacy 提问）⇒ answerable=False：会话窗只展示题干，
    不给选择框/提交（平台没有可送达的作答通道）。"""
    mark = {"kind": "question", "call_id": "",
            "questions": [{"id": "q1", "question": "外部问题", "options": ["A"]}]}
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "running", "interaction": mark})
    r = board._iw_interaction("dsh_plugin", _proj("dsh-plugin:"), "session-x")
    assert r["pending"] is True and r["answerable"] is False


def test_iw_interaction_dsh_approval_not_answerable(monkeypatch):
    mark = {"kind": "approval", "id": "ap-1", "tool": "bash", "reason": ""}
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "running", "interaction": mark})
    r = board._iw_interaction("dsh_plugin", _proj("dsh-plugin:"), "session-x")
    assert r["kind"] == "approval" and r["answerable"] is False
    assert r["approval_id"] == "ap-1"


def test_iw_interaction_dsh_idle(monkeypatch):
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"status": "idle", "interaction": None})
    r = board._iw_interaction("dsh_plugin", _proj("dsh-plugin:"), "session-x")
    assert r == {"pending": False, "busy": False, "qid": None, "question": None,
                 "options": None, "answerable": True, "text": ""}


def test_iw_interaction_dsh_hub_unknown(monkeypatch):
    """未连接/未知会话 ⇒ None（该轮跳过，不误移不报错）——P4 的「未知」口径。"""
    monkeypatch.setattr(board.dshevents, "get", lambda sid: None)
    assert board._iw_interaction("dsh_plugin", _proj("dsh-plugin:"), "session-x") is None


def test_web_busy_map_uses_hub_snapshot(monkeypatch):
    """P4：批量 busy 读 EventHub 进程内快照——**零请求**（原为每轮一次 /live）。"""
    def boom(*a, **kw):
        raise AssertionError("P4 后 busy 计算不应再打驱动")
    monkeypatch.setattr(board.dshdriver, "live", boom)
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {
        "s1": {"status": "running"}, "s2": {"status": "idle"}})
    monkeypatch.setattr(board.db, "list_board_cards",
                        lambda pid: [{"session_id": "s1"}, {"session_id": "s2"},
                                     {"session_id": ""}])
    m = board.web_busy_map(_proj("dsh-plugin:"))
    assert m == {"s1": True, "s2": False}


def test_web_busy_map_hub_disconnected(monkeypatch):
    """未连接 ⇒ 快照空 ⇒ 全 False（无信号不点亮，不误判）。"""
    monkeypatch.setattr(board.dshevents, "snapshot", lambda: {})
    monkeypatch.setattr(board.db, "list_board_cards",
                        lambda pid: [{"session_id": "s1"}])
    assert board.web_busy_map(_proj("dsh-plugin:")) == {"s1": False}


def test_web_turn_baseline_and_ran(monkeypatch):
    """turn 归属基线 = (轮次原因, 事件 seq)，读 EventHub（P4：零请求）；seq 增长即「跑过」。"""
    def boom(*a, **kw):
        raise AssertionError("P4 后 turn 归属不应再打驱动")
    monkeypatch.setattr(board.dshdriver, "status", boom)
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"last_turn_reason": "completed", "last_seq": 10})
    base = board._web_turn_baseline("dsh_plugin", "/tmp", "session-x")
    assert base == ("completed", 10)
    rec = {"family": "dsh_plugin", "sid": "session-x", "turn_baseline": base}
    assert board._web_turn_ran(rec) is False
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"last_turn_reason": "completed", "last_seq": 12})
    assert board._web_turn_ran(rec) is True
    # 未知基线（未连接）：容错为「跑过」，不误判负
    monkeypatch.setattr(board.dshevents, "get", lambda sid: None)
    assert board._web_turn_baseline("dsh_plugin", "/tmp", "session-x") is None
    assert board._web_turn_ran({"family": "dsh_plugin", "sid": "s",
                                "turn_baseline": None}) is True


def test_web_turn_error_dsh(monkeypatch):
    rec = {"family": "dsh_plugin", "sid": "s"}
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"last_turn_reason": "completed"})
    assert board._web_turn_error(rec) == ""
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"last_turn_reason": "aborted"})
    assert board._web_turn_error(rec) == ""      # 用户主动中断不算错误
    monkeypatch.setattr(board.dshevents, "get",
                        lambda sid: {"last_turn_reason": "error"})
    assert "error" in board._web_turn_error(rec)
    monkeypatch.setattr(board.dshevents, "get", lambda sid: None)
    assert board._web_turn_error(rec) == ""      # 未知：收尾不因此失败


def test_answer_deliver_dsh_gone(monkeypatch):
    """accepted=false → 抛 40405（对齐 kimi「问题已不存在」放弃语义）。"""
    monkeypatch.setattr(board.dshdriver, "answer_question",
                        lambda sid, qid, answers: False)
    meta = {"sid": "session-x", "qid": "call-1", "answers": []}
    with pytest.raises(board.dshdriver.DshDriverError) as ei:
        board._answer_deliver(_proj("dsh-plugin:"), meta)
    assert board._answer_question_gone(ei.value) is True


def test_answer_deliver_dsh_ok(monkeypatch):
    seen = {}

    def fake_answer(sid, qid, answers):
        seen.update({"sid": sid, "qid": qid, "answers": answers})
        return True

    monkeypatch.setattr(board.dshdriver, "answer_question", fake_answer)
    meta = {"sid": "session-x", "qid": "call-1",
            "answers": [{"wire": "q_0", "kind": "single", "option_id": "A"}]}
    board._answer_deliver(_proj("dsh-plugin:"), meta)
    assert seen["qid"] == "call-1"
    assert seen["answers"] == [{"id": "q_0", "selected": ["A"]}]


# ---------- chat：dsh 投递 ----------

def test_chat_dsh_send_records_baseline_and_delivers(monkeypatch):
    sent = []
    monkeypatch.setattr(chat.dshdriver, "status",
                        lambda sid: {"last_seq": 5, "status": "idle"})
    monkeypatch.setattr(chat.dshdriver, "prompt",
                        lambda sid, text: sent.append(("prompt", sid, text)))
    monkeypatch.setattr(chat.dshdriver, "steer",
                        lambda sid, text: sent.append(("steer", sid, text)))
    assert chat.dsh_send("session-x", "普通消息") == 5
    assert chat._DSH_BASELINE["session-x"] == 5
    assert sent[-1] == ("prompt", "session-x", "普通消息")
    chat.dsh_send("session-x", "插话", inject=True)
    assert sent[-1] == ("steer", "session-x", "插话")
    chat._DSH_BASELINE.clear()


def test_chat_dsh_send_requires_sid():
    with pytest.raises(chat.dshdriver.DshDriverError):
        chat.dsh_send("", "x")


def test_chat_wait_web_busy_routes_to_dsh(monkeypatch):
    monkeypatch.setattr(chat, "dsh_wait_turn", lambda sid, since=None: chat.STATE_YIELDED)
    assert chat.wait_web_busy("/tmp", "session-x", "dsh_plugin") == chat.STATE_YIELDED


def test_chat_inject_supported_families():
    """「立即注入」白名单只剩 dsh_plugin（走 steer）——单族化后不再按族枚举。"""
    src = open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "chat.py"), encoding="utf-8").read()
    assert 'meta.get("family") != "dsh_plugin"' in src


# ---------- 插件侧契约自检（桩 ctx，不经 dsh） ----------

def test_driver_contract_harness():
    """跑 `dsh-plugin/scripts/dev-check-driver.mjs`：桩 ctx 覆盖驱动全部端点语义。

    本文件是插件半边（`lib/agent-driver.js`）唯一的自动化回归——真机验证要走一个
    真 dsh 实例（`tests/e2e_dsh_driver.py`），成本高；桩 harness 秒级把契约钉死：
    鉴权闸、sid 格式、preset 装配、followup/steer/cancel 语义、SSE 帧与裁剪、
    提问→interaction、作答 accepted 真假、dispose 回收。

    node 不可用时跳过（与 vitest 档「缺前端环境自动跳过」同口径：本档不因缺
    Node 而红，但开发机上必然跑到）。
    """
    import shutil
    import subprocess
    node = shutil.which("node")
    if node is None:
        pytest.skip("node 不可用（跳过插件侧契约自检）")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.run([node, "scripts/dev-check-driver.mjs"],
                          cwd=os.path.join(root, "dsh-plugin"),
                          capture_output=True, text=True, timeout=120)
    out = (proc.stdout or "") + (proc.stderr or "")
    assert proc.returncode == 0, f"驱动契约自检失败：\n{out}"
    assert "OVERALL: PASS" in out
    assert "✗" not in out, out


def test_shell_full_chain_harness():
    """跑 `dsh-plugin/scripts/dev-check.mjs`：桩 ctx + **真 server.py** 的全链路自检。

    覆盖 banner 端口解析 → `/touchstone/api/auth/me` 免登 admin → `/touchstone/app`
    返回插件版产物（base=/touchstone/assets/）。2026-10-04 修复：该脚本自 P1 加
    agent 驱动后一直抛 `ctx.inject is not a function`（桩 ctx 没跟上），且直连默认库
    会撞同库单实例锁 —— 本次补 `inject` 桩、改按路径取反代 handler，并把子进程指到
    临时隔离库（`TOUCHSTONE_DB` + `TS_ADMIN_PASSWORD`），跑完自清。
    缺 `webui/dist-plugin/index.html`（未 `npm run build:plugin`）或 node 时跳过。
    """
    import shutil
    import subprocess
    node = shutil.which("node")
    if node is None:
        pytest.skip("node 不可用（跳过插件侧薄壳全链路自检）")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.isfile(os.path.join(root, "webui", "dist-plugin", "index.html")):
        pytest.skip("缺 webui/dist-plugin（先 cd webui && npm run build:plugin）")
    proc = subprocess.run(
        [node, "scripts/dev-check.mjs", root, sys.executable],
        cwd=os.path.join(root, "dsh-plugin"), capture_output=True, text=True, timeout=180)
    out = (proc.stdout or "") + (proc.stderr or "")
    assert proc.returncode == 0, f"薄壳全链路自检失败：\n{out}"
    assert "PASS: 薄壳全链路 OK" in out, out


def test_shell_lifecycle_harness():
    """跑 `dsh-plugin/scripts/dev-check-shell.mjs`：桩 ctx 覆盖薄壳生命周期自愈。

    背景（2026-10-04 真机修复）：dsh 热重载停用插件时**不保证**调用本插件的
    disposer——实测旧实现（同步 apply）停用后面板回 `applied`，但 `/touchstone`、
    `/touchstone-agent` 两条路由与 server.py 子进程全都活着；重新启用时
    `webServer.register` 抛 `duplicate prefix route "/touchstone-agent"`，条目激活
    失败（面板「启用失败：1 entry did not activate touchstone」）。
    本档用假 server.py（node 脚本）把两条兜底钉死：① 启用即回收（旧壳路由 +
    子进程必须先退，否则同库单实例锁会让新进程 exit 3）；② 掉线自检（fiber 不在
    loader 里 → 2s 内自主停壳）；另覆盖正常 dispose 与幂等。
    """
    import shutil
    import subprocess
    node = shutil.which("node")
    if node is None:
        pytest.skip("node 不可用（跳过插件侧薄壳生命周期自检）")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.run([node, "scripts/dev-check-shell.mjs"],
                          cwd=os.path.join(root, "dsh-plugin"),
                          capture_output=True, text=True, timeout=120)
    out = (proc.stdout or "") + (proc.stderr or "")
    assert proc.returncode == 0, f"薄壳生命周期自检失败：\n{out}"
    assert "OVERALL: PASS" in out
    assert "✗" not in out, out


def test_client_shortcut_harness():
    """跑 `dsh-plugin/scripts/dev-check-shortcuts.mjs`：客户端快捷键两条通道（2026-10-04）。

    背景：面板开关快捷键横跨三个面——dsh 官方快捷键注册表（「设置 → 快捷键」目录 /
    可改键 / 冲突校验）、宿主页 document、面板的同源 iframe document（iframe 内
    按键不冒泡到宿主页）。前两者要么依赖 dsh 内部白名单（Web 档不接受纯 Alt+T，
    故 Web 默认取 primary+alt+T、desktop 三档才是纯 Alt+T），要么只能在真浏览器里
    验；桩 DOM harness 把注册面与两侧监听逐条钉死，真浏览器那一档见
    `tests/e2e_plugin_shortcut.py`（隔离 dsh 实例 + Playwright）。
    """
    import shutil
    import subprocess
    node = shutil.which("node")
    if node is None:
        pytest.skip("node 不可用（跳过客户端快捷键自检）")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.run([node, "scripts/dev-check-shortcuts.mjs"],
                          cwd=os.path.join(root, "dsh-plugin"),
                          capture_output=True, text=True, timeout=120)
    out = (proc.stdout or "") + (proc.stderr or "")
    assert proc.returncode == 0, f"客户端快捷键自检失败：\n{out}"
    assert "OVERALL: PASS" in out
    assert "✗" not in out, out


def test_client_host_bridge_harness():
    """跑 `dsh-plugin/scripts/dev-check-bridge.mjs`：面板 ↔ 内嵌 SPA 消息桥（2026-10-04）。

    背景：看板卡片新增的「在 dsh 界面打开卡片主会话」按钮，走的是 SPA（同源 iframe）
    → 宿主页 postMessage → dsh 客户端服务 `uiWorkspace.openSession` 这条链。三个面
    （宿主页 message 事件、iframe contentWindow 来源判定、uiWorkspace 服务）真机复现
    要起 dsh + 真开面板 + 真点按钮；桩 DOM harness 把探针应答、打开请求、拒绝面
    （异源/非本 iframe/sid 形状/服务抛错）与监听解绑逐条钉死。SPA 半同协议由
    `webui/src/__tests__/dshHost.test.js`（vitest）覆盖。
    """
    import shutil
    import subprocess
    node = shutil.which("node")
    if node is None:
        pytest.skip("node 不可用（跳过面板消息桥自检）")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.run([node, "scripts/dev-check-bridge.mjs"],
                          cwd=os.path.join(root, "dsh-plugin"),
                          capture_output=True, text=True, timeout=120)
    out = (proc.stdout or "") + (proc.stderr or "")
    assert proc.returncode == 0, f"面板消息桥自检失败：\n{out}"
    assert "OVERALL: PASS" in out
    assert "✗" not in out, out


# ---------- board：P3 对齐（compact / fork / 压缩新建，2026-10-03）----------

def _card(sid="session-a", title="卡片", model=""):
    return {"id": 5, "session_id": sid, "sessions": "[]", "title": title,
            "model": model}


def test_board_compact_session_dsh(monkeypatch):
    """dsh 卡 compact 走驱动 `/compact`（触发即返回）；驱动异常转 RuntimeError。"""
    seen = []
    monkeypatch.setattr(board.dshdriver, "compact",
                        lambda sid: seen.append(sid) or {"started": True})
    board.compact_session(_proj("dsh-plugin:/usr/bin/dsh"), _card(), "session-a")
    assert seen == ["session-a"]

    def boom(sid):
        raise board.dshdriver.DshDriverError(-2, "不可达")
    monkeypatch.setattr(board.dshdriver, "compact", boom)
    with pytest.raises(RuntimeError) as ei:
        board.compact_session(_proj("dsh-plugin:/usr/bin/dsh"), _card(), "session-a")
    assert "compact 失败" in str(ei.value)


def test_board_fork_session_dsh(monkeypatch):
    """dsh fork：驱动 fork → ensure_session 把新会话接进池 → 改名加「（fork）」后缀。"""
    calls = []
    monkeypatch.setattr(board.dshdriver, "fork",
                        lambda sid: calls.append(("fork", sid))
                        or {"new_session_id": "session-new"})
    monkeypatch.setattr(board.dshdriver, "ensure_session",
                        lambda sid, cwd="", task="", **kw:
                        calls.append(("ensure", sid, cwd)) or sid)
    monkeypatch.setattr(board.dshdriver, "rename",
                        lambda sid, title: calls.append(("rename", sid, title))
                        or {"title": title})
    new_sid = board.fork_session(_proj("dsh-plugin:/usr/bin/dsh"),
                                 _card(title="卡 A"), "session-a")
    assert new_sid == "session-new"
    assert calls[0] == ("fork", "session-a")
    assert calls[1][0] == "ensure" and calls[1][1] == "session-new"
    assert calls[2] == ("rename", "session-new", "卡 A（fork）")


def test_board_fork_compact_session_dsh(monkeypatch):
    """dsh「压缩并新建」的等价近似：fork → 接池 → **压缩新会话** → 改名（压缩续）。

    与 kimi 的差别：kimi 是「读原会话压缩摘要 → 只把摘要注入全新会话」；dsh
    没有摘要读取口，故改为「复制副本 + 压缩副本」——上下文同样变轻，但副本日志
    仍留完整历史（见 spec）。
    """
    calls = []
    monkeypatch.setattr(board.dshdriver, "fork",
                        lambda sid: {"new_session_id": "session-new"})
    monkeypatch.setattr(board.dshdriver, "ensure_session", lambda sid, **kw: sid)
    monkeypatch.setattr(board.dshdriver, "compact",
                        lambda sid: calls.append(("compact", sid)) or {"started": True})
    monkeypatch.setattr(board.dshdriver, "rename",
                        lambda sid, title: calls.append(("rename", sid, title))
                        or {"title": title})
    out = board.fork_compact_session(_proj("dsh-plugin:/usr/bin/dsh"),
                                     _card(title="卡 B"), "session-a")
    assert out == ("session-new", True)
    assert calls == [("compact", "session-new"),
                     ("rename", "session-new", "卡 B（压缩续）")]


def test_server_session_profile_dsh_model_only(monkeypatch):
    """会话级配置端点对 dsh 的模型/思考等级路径：`model` 与 `reasoning_effort`
    都走驱动 /model（2026-10-04 起只改等级时 model 可留空）；三者皆空 400；
    驱动异常 502。（权限档路径见 test_server_session_profile_dsh_permission_and_model）"""
    import server

    calls = []

    class _H:
        def _respond(self, code, body=b"", ctype=""):
            calls.append((code, json.loads(body or b"{}")))
        def _owned_project(self, pid):
            return {"id": pid, "agent_path": "dsh-plugin:/usr/bin/dsh"}
        def _board_owns_sid(self, row, sid):
            return {"id": 1}

    seen = []
    monkeypatch.setattr(server.dshdriver, "set_model",
                        lambda sid, model, **kw: seen.append((sid, model, kw)) or {"ok": True})
    server.Handler._api_board_session_profile(_H(), 1, "session-a", {"model": "m1"})
    assert calls[-1][0] == 200 and seen == [("session-a", "m1", {"reasoning_effort": ""})]
    # 只改思考等级：model 留空也必须放行（插件从会话当前模型回读），非法的 400
    server.Handler._api_board_session_profile(_H(), 1, "session-a", {"reasoning_effort": "max"})
    assert calls[-1][0] == 200 and seen[-1] == ("session-a", "", {"reasoning_effort": "max"})
    server.Handler._api_board_session_profile(_H(), 1, "session-a", {"reasoning_effort": "ultra"})
    assert calls[-1][0] == 400 and "思考等级非法" in calls[-1][1]["error"]
    server.Handler._api_board_session_profile(_H(), 1, "session-a", {})
    assert calls[-1][0] == 400 and \
        calls[-1][1]["error"] == "model/permission_mode/reasoning_effort required"

    def boom(sid, model, **kw):
        raise server.dshdriver.DshDriverError(-2, "不可达")
    monkeypatch.setattr(server.dshdriver, "set_model", boom)
    server.Handler._api_board_session_profile(_H(), 1, "session-a", {"model": "m2"})
    assert calls[-1][0] == 502 and "不可达" in calls[-1][1]["error"]


# ---------- P3 第二批：权限 preset + 审批代答（2026-10-03）----------

def test_client_models_endpoint(monkeypatch):
    """`dshdriver.models()` 拼装（GET /models）。"""
    calls = []

    def fake_request(method, path, payload=None, timeout=None):
        calls.append((method, path))
        return {"groups": [], "default": {"provider": "p", "model": "m"}}
    monkeypatch.setattr(dshdriver, "_request", fake_request)
    assert dshdriver.models()["default"]["model"] == "m"
    assert calls == [("GET", "/models")]


def test_split_model():
    """平台模型值 `provider/id` 拆成 (provider, id)——宿主 `/session` 不拆前缀。"""
    assert dshdriver.split_model("deepseek-official/deepseek-flash") == \
        ("deepseek-official", "deepseek-flash")
    assert dshdriver.split_model("  p/m  ") == ("p", "m")
    # 无前缀（存量值/裸模型名）→ provider 空，由宿主沿用当前 provider
    assert dshdriver.split_model("deepseek-flash") == ("", "deepseek-flash")
    assert dshdriver.split_model("") == ("", "")
    # 只有一侧为空时不拆（防把模型名里的斜杠误当 provider 分隔）
    assert dshdriver.split_model("/m") == ("", "/m")
    assert dshdriver.split_model("p/") == ("", "p/")


def test_agent_models_dsh_plugin(monkeypatch):
    """平台模型下拉的 dsh 分支：值=`provider/模型 id`、显示=`provider/显示名` + 默认值 + 60s 缓存。

    2026-10-03 二次修订：宿主 `selectModel` 按 **id** 严格校验（`modelAvailable`），
    故下拉值必须是 id；显示名（含 provider 前缀，区分 official/account 两个 provider）
    只用于展示，description 不参与（原先会顶掉模型名）。
    """
    import server
    calls = []

    def fake_models():
        calls.append(1)
        return {"default": {"provider": "p", "model": "m"},
                "groups": [{"id": "p", "name": "P",
                            "models": [{"id": "m", "name": "M 显示名", "description": "模型 m"},
                                       {"id": "m2", "name": "M2 显示名"}]},
                           {"id": "q", "name": "Q",
                            "models": [{"id": "w", "name": "W 显示名"}]}]}
    monkeypatch.setattr(server.dshdriver, "models", fake_models)
    monkeypatch.setattr(server, "_MODELS_CACHE", {})          # 清缓存（模块级）
    out = server.agent_models("dsh-plugin:/usr/bin/dsh")
    assert [m["name"] for m in out["models"]] == ["p/m", "p/m2", "q/w"]
    assert [m["display_name"] for m in out["models"]] == \
        ["p/M 显示名", "p/M2 显示名", "q/W 显示名"]
    assert out["default"] == "p/m"
    server.agent_models("dsh-plugin:/usr/bin/dsh")
    assert len(calls) == 1                                    # 60s 缓存命中

    def boom():
        raise server.dshdriver.DshDriverError(-2, "不可达")
    monkeypatch.setattr(server.dshdriver, "models", boom)
    monkeypatch.setattr(server, "_MODELS_CACHE", {})
    assert server.agent_models("dsh-plugin:/usr/bin/dsh") == {"models": [], "default": ""}


def test_agent_models_dsh_plugin_missing_id(monkeypatch):
    """宿主条目缺 id/name 时的兜底：id 缺失用显示名当值，两者都缺则跳过。
    2026-10-04：每项再带思考等级键（目录没给 reasoning 时为空列表/空串）。"""
    import server
    monkeypatch.setattr(server.dshdriver, "models", lambda: {
        "default": {},
        "groups": [{"id": "p", "models": [{"name": "仅有名"}, {"description": "都没有"}]}]})
    monkeypatch.setattr(server, "_MODELS_CACHE", {})
    out = server.agent_models("dsh-plugin:/usr/bin/dsh")
    assert out["models"] == [{"name": "p/仅有名", "display_name": "p/仅有名",
                              "efforts": [], "default_effort": ""}]


def test_start_web_dsh_splits_provider(monkeypatch):
    """卡片起 dsh 会话：模型值 `provider/id` 拆成 provider + 裸 id 下传。

    宿主 `/session` 不拆 `provider/model`（只有 `/model` 会拆），不拆则 provider
    前缀会被当成模型名的一部分 ⇒ 起会话即失败（2026-10-03 修复回归）。
    """
    import board
    seen = {}

    def fake_create(cwd, task="", model="", provider=""):
        seen.update(cwd=cwd, task=task, model=model, provider=provider)
        return "session-x"
    monkeypatch.setattr(board.dshdriver, "create_session", fake_create)
    monkeypatch.setattr(board.dshdriver, "resume_session", lambda sid, **kw: sid)
    monkeypatch.setattr(board, "build_start_prompt", lambda *a, **k: "prompt")
    monkeypatch.setattr(board.lib, "ensure_runtime_dirs", lambda d: None)
    monkeypatch.setattr(board.lib, "runtime_dir", lambda *a: "/tmp/tf-test")
    monkeypatch.setattr(board.runner, "append_log", lambda *a, **k: None)
    monkeypatch.setattr(board, "_web_turn_baseline", lambda *a: None)
    monkeypatch.setattr(board, "_save_card_sid", lambda cid, sid: True)
    monkeypatch.setattr(board.chat, "dsh_send", lambda sid, prompt: None)
    proj = {"project_dir": "/tmp/p", "work_dir": "/tmp/p/.ts", "env": {},
            "model": "deepseek-official/deepseek-flash"}
    card = {"id": 1, "session_id": "", "model": "", "title": "t", "description": "d",
            "column_key": "doing"}
    board._start_web(proj, card, "dsh_plugin")
    assert (seen["provider"], seen["model"]) == ("deepseek-official", "deepseek-flash")
    # 无前缀的存量值：provider 空传（宿主沿用当前 provider），模型名原样
    seen.clear()
    proj2 = dict(proj, model="deepseek-flash")
    board._start_web(proj2, dict(card, id=2), "dsh_plugin")
    assert (seen["provider"], seen["model"]) == ("", "deepseek-flash")


# ---------- P5：会话回退（dsh 无原地 undo → fork 边界）----------

def _mk_dsh_session(tmp_path, monkeypatch, events):
    """写一个最小 dsh 会话（JSONL；文件名走 `session*.jsonl.zstd` 通配）。

    会话根用 `sessparse.DSH_SESSIONS` 覆盖（同既有 dsh 文件定位用例的写法）；
    内容必须真 zstd 压缩（`_dsh_decompressed` 解压失败会静默返回 ''）。
    """
    import zstandard as _zstd
    import json as _json
    sid = "session-aaaa1111-2222-3333-4444-555555555555"   # sid 需过 SID_DSH_RE（十六进制 UUID 形态）
    sdir = tmp_path / "bucket" / sid
    sdir.mkdir(parents=True)
    body = "\n".join(_json.dumps(e, ensure_ascii=False) for e in events)
    (sdir / "session.v4.jsonl.zstd").write_bytes(_zstd.ZstdCompressor().compress(
        body.encode("utf-8")))
    monkeypatch.setattr(sessparse, "DSH_SESSIONS", str(tmp_path))
    return sid


def _ev(seq, typ, **data):
    return {"type": typ, "seq": seq, "time": 1000 + seq, "data": data}


def test_dsh_fork_boundary_maps_mid_to_prev_seq(tmp_path, monkeypatch):
    """回退边界 = 该提问事件 seq 的前一个（fork atSeq 是 inclusive）。"""
    sid = _mk_dsh_session(tmp_path, monkeypatch, [
        _ev(1, "session/init", cwd="/tmp/p"),
        _ev(2, "user/message", source={"kind": "user"},
            content=[{"type": "text", "text": "第一个问题"}]),
        _ev(3, "assistant/message", message={"content": [{"type": "text", "text": "答一"}]}),
        _ev(4, "user/message", source={"kind": "user"},
            content=[{"type": "text", "text": "第二个问题"}]),
        _ev(5, "assistant/message", message={"content": [{"type": "text", "text": "答二"}]}),
        # 系统注入不算锚点（与解析口径一致）
        _ev(6, "user/message", source={"kind": "plugin"},
            content=[{"type": "text", "text": "注入"}])
    ])
    anchors = sessparse.dsh_user_anchors(sid)
    assert [a["mid"] for a in anchors] == ["e2", "e4"]
    assert [a["text"] for a in anchors] == ["第一个问题", "第二个问题"]
    assert sessparse.dsh_fork_boundary(sid, "e4") == 3      # 第二个问题之前
    assert sessparse.dsh_fork_boundary(sid, "e2") == 1      # 第一个问题之前
    assert sessparse.dsh_fork_boundary(sid, "e9") is None   # 不存在的锚点
    assert sessparse.dsh_fork_boundary(sid, "") is None
    assert sessparse.dsh_fork_boundary("nope", "e2") is None


def test_server_rewind_dsh_forks_and_returns_sid(monkeypatch):
    """`_rewind_session` 的 dsh 分支：fork(atSeq=边界) → 接池 → 回新 sid；不改绑定。"""
    import server

    calls = []

    class _H:
        def _respond(self, code, body=b"", ctype=""):
            calls.append((code, json.loads(body or b"{}")))

    monkeypatch.setattr(server.sessparse, "dsh_fork_boundary",
                        lambda sid, mid: 3 if mid == "e4" else None)
    seen = []
    monkeypatch.setattr(server.dshdriver, "fork",
                        lambda sid, at_seq=None: seen.append(("fork", sid, at_seq))
                        or {"new_session_id": "session-new"})
    monkeypatch.setattr(server.dshdriver, "ensure_session",
                        lambda sid, cwd="", task="", **kw: seen.append(("ensure", sid, cwd)) or sid)
    proj = {"id": 1, "agent_path": "dsh-plugin:/usr/bin/dsh", "project_dir": "/tmp/p"}
    server.Handler._rewind_session_dsh(_H(), proj, "session-a", {"mid": "e4"})
    assert calls[-1][0] == 200
    assert calls[-1][1]["new_session_id"] == "session-new" and calls[-1][1]["boundary"] == 3
    assert seen[0] == ("fork", "session-a", 3)
    assert seen[1] == ("ensure", "session-new", "/tmp/p")

    assert calls[-1][1]["rebound"] is False          # 看板路径：不改绑定，由 UI 切会话

    # 锚点已失效 → 409（不调驱动）
    server.Handler._rewind_session_dsh(_H(), proj, "session-a", {"mid": "e9"})
    assert calls[-1][0] == 409 and len(seen) == 2

    # 驱动失败 → 502
    def boom(sid, at_seq=None):
        raise server.dshdriver.DshDriverError(-2, "不可达")
    monkeypatch.setattr(server.dshdriver, "fork", boom)
    server.Handler._rewind_session_dsh(_H(), proj, "session-a", {"mid": "e4"})
    assert calls[-1][0] == 502 and "回退失败" in calls[-1][1]["error"]


def test_parse_dsh_image_blocks_and_resolve_media(tmp_path, monkeypatch):
    """#20 媒体预览：dsh 的 image 块 → entry `images=[{media: attachmentId}]`；
    `resolve_media("dsh", ...)` 经驱动取字节（非法 id 直接 None，不打驱动）。"""
    import base64 as _b64
    sid = _mk_dsh_session(tmp_path, monkeypatch, [
        _ev(1, "user/message", source={"kind": "user"},
            content=[{"type": "text", "text": "看这张图"},
                     {"type": "image",
                      "attachment": {"attachmentId": "sha256:" + "a" * 64,
                                     "mediaType": "image/png", "bytes": 8,
                                     "width": 1, "height": 1}}]),
    ])
    col = sessparse._parse_dsh(sessparse._dsh_session_file(sid))
    user = [e for e in col.entries if e["kind"] == "user"][0]
    assert user["images"] == [{"media": "sha256:" + "a" * 64}]
    assert user["text"] == "看这张图"

    calls = []
    monkeypatch.setattr(sessparse.dshdriver, "media",
                        lambda mid: calls.append(mid)
                        or {"content_type": "image/png",
                            "data": _b64.b64encode(b"\x89PNGdata").decode()})
    out = sessparse.resolve_media("dsh", sid, "main", "sha256:" + "a" * 64)
    assert out == (b"\x89PNGdata", "image/png") and len(calls) == 1
    # 非法 id / 相对路径 → None（不打驱动）
    assert sessparse.resolve_media("dsh", sid, "main", "../../etc/passwd") is None
    assert sessparse.resolve_media("dsh", sid, "main", "") is None
    assert len(calls) == 1


def test_session_media_endpoints_pass_dsh_family(monkeypatch):
    """两个会话图片端点必须以**归一后的解析族 `dsh`** 调 sessparse.resolve_media。

    P7b B5 前的一致性缺陷：`_sess_family("dsh_plugin")` 返回遗留族名 "deepseek"，
    而 `resolve_media` 的 dsh 分支判 `family == "dsh"` → 恒不匹配，会话图片恒 404
    （原端点用例只断「坏 media id → 404」，掩盖了该不一致）。本用例锁死传参族。
    """
    import server

    real_resolve = sessparse.resolve_media          # 打桩前的真函数（末段复原用）
    calls = []

    class _H:
        """只实现两个端点触达的方法（不建真连接）。"""

        def _respond(self, code, body=b"", ctype=""):
            calls.append((code, body))

        def _owned_project(self, pid):
            return {"id": pid, "project_dir": "/tmp/p",
                    "agent_path": "dsh-plugin:/usr/bin/dsh"}

        def _board_owns_sid(self, row, sid):
            return {"id": 7}

        def _session_context(self, task_id):
            return {"id": task_id, "session_id": "session-task"}, {}, "dsh_plugin"

    seen = []

    def fake_resolve(family, sid, agent, media_id):
        seen.append((family, sid, agent, media_id))
        if family not in sessparse.FAMILIES:      # 与真实实现的族白名单同口径
            return None
        return (b"\x89PNG-bytes", "image/png")

    monkeypatch.setattr(server.sessparse, "resolve_media", fake_resolve)
    mid = "sha256:" + "a" * 64
    parsed = {"sid": ["session-a"], "agent": ["main"]}
    # 看板卡片会话（project + sid 寻址）
    server.Handler._api_board_session_media(_H(), 3, mid, parsed)
    # 任务会话（taskId + sid 寻址）
    server.Handler._api_session_media(_H(), 9, mid, parsed)
    assert [c[0] for c in calls] == [200, 200]
    assert [c[1] for c in calls] == [b"\x89PNG-bytes", b"\x89PNG-bytes"]
    assert seen == [("dsh", "session-a", "main", mid),
                    ("dsh", "session-task", "main", mid)]

    # 退场族项目（agent_path=kimi → agent_family=retired）：解析族原样传递
    # "retired" 不在白名单 → resolve_media 落空 → 404
    class _HRetired(_H):
        def _owned_project(self, pid):
            return {"id": pid, "project_dir": "/tmp/p", "agent_path": "kimi"}

    calls.clear()
    server.Handler._api_board_session_media(_HRetired(), 3, mid, parsed)
    assert calls and calls[-1][0] == 404
    assert seen[-1][0] == "retired"

    # 驱动 404（附件不存在）/驱动不可达：resolve_media 收敛为 None → 端点 404，
    # 不让 DshDriverError 穿出（P7b B5 顺带修；此前异常会穿透端点落 500/断连）
    def _boom(mid_):
        raise sessparse.dshdriver.DshDriverError(404, "attachment not found")

    monkeypatch.setattr(server.sessparse, "resolve_media", real_resolve)
    monkeypatch.setattr(sessparse.dshdriver, "media", _boom)
    assert real_resolve("dsh", "session-a", "main", mid) is None
    calls.clear()
    server.Handler._api_board_session_media(_H(), 3, mid, parsed)
    assert calls and calls[-1][0] == 404


def test_server_rewind_dsh_task_rebinds_session(monkeypatch):
    """任务侧回退：把任务会话重绑到新会话（任务只有一个会话位，否则后续轮次打旧会话）。"""
    import server

    calls = []
    rebound = []

    class _H:
        def _respond(self, code, body=b"", ctype=""):
            calls.append((code, json.loads(body or b"{}")))

    monkeypatch.setattr(server.sessparse, "dsh_fork_boundary", lambda sid, mid: 7)
    monkeypatch.setattr(server.dshdriver, "fork",
                        lambda sid, at_seq=None: {"new_session_id": "session-new"})
    monkeypatch.setattr(server.dshdriver, "ensure_session", lambda sid, **kw: sid)
    monkeypatch.setattr(server.db, "update_task",
                        lambda tid, **kw: rebound.append((tid, kw)) or None)
    proj = {"id": 1, "agent_path": "dsh-plugin:/usr/bin/dsh", "project_dir": "/tmp/p"}
    server.Handler._rewind_session_dsh(_H(), proj, "session-a", {"mid": "e4"},
                                       task={"id": 42, "session_id": "session-a"})
    assert calls[-1][0] == 200 and calls[-1][1]["rebound"] is True
    assert rebound == [(42, {"session_id": "session-new"})]


def test_client_p3b_endpoints(monkeypatch):
    """审批/权限端点的拼装（answer_approval / set_permission / presets）。"""
    calls = []

    def fake_request(method, path, payload=None, timeout=None):
        calls.append((method, path, payload))
        if path == "/approval":
            return {"ok": True, "outcome": payload["decision"]}
        if path == "/permission":
            return {"ok": True, "preset": payload["preset"], "hold_approvals": True}
        if path.startswith("/presets"):
            return {"current": "workspace-write", "options": []}
        return {}

    monkeypatch.setattr(dshdriver, "_request", fake_request)
    assert dshdriver.answer_approval("session-a", "ap-1", "allowed-once")["outcome"] == "allowed-once"
    assert dshdriver.set_permission("session-a", "workspace-write")["hold_approvals"] is True
    assert dshdriver.presets("session-a")["current"] == "workspace-write"
    assert calls[0] == ("POST", "/approval",
                        {"session_id": "session-a", "approval_id": "ap-1",
                         "decision": "allowed-once"})
    assert calls[1] == ("POST", "/permission",
                        {"session_id": "session-a", "preset": "workspace-write"})
    assert calls[2][0] == "GET" and calls[2][1].startswith("/presets?session_id=")


def test_iw_interaction_dsh_approval_answerable_from_mark(monkeypatch):
    """dsh 审批的 `answerable` 由插件标记决定：认领（平台接管）才可代答。"""
    monkeypatch.setattr(board.dshevents, "get", lambda sid: {
        "status": "running",
        "interaction": {"kind": "approval", "id": "ap-7", "tool": "bash",
                        "answerable": True}})
    r = board._iw_interaction("dsh_plugin", {"id": 1}, "session-a")
    assert r["kind"] == "approval" and r["answerable"] is True
    assert r["approval_id"] == "ap-7" and r["pending"] is True
    # 未认领（GUI 作答）：只展示，不可代答
    monkeypatch.setattr(board.dshevents, "get", lambda sid: {
        "status": "running",
        "interaction": {"kind": "approval", "id": "ap-8", "tool": "bash"}})
    r2 = board._iw_interaction("dsh_plugin", {"id": 1}, "session-a")
    assert r2["answerable"] is False and r2["approval_id"] == "ap-8"


def test_answer_deliver_dsh_approval(monkeypatch):
    """送达出口的 dsh 审批分支：outcome 直传 /approval；409 转 40405 放弃语义。"""
    seen = []
    monkeypatch.setattr(board.dshdriver, "answer_approval",
                        lambda sid, aid, outcome: seen.append((sid, aid, outcome)) or {"outcome": outcome})
    proj = _proj("dsh-plugin:/usr/bin/dsh")
    board._answer_deliver(proj, {"sid": "session-a", "approval_id": "ap-1",
                                 "outcome": "allowed-once"})
    assert seen == [("session-a", "ap-1", "allowed-once")]

    def gone(sid, aid, outcome):
        raise board.dshdriver.DshDriverError(409, "当前没有等待中的审批")
    monkeypatch.setattr(board.dshdriver, "answer_approval", gone)
    with pytest.raises(board.dshdriver.DshDriverError) as ei:
        board._answer_deliver(proj, {"sid": "session-a", "approval_id": "ap-2",
                                     "outcome": "rejected"})
    assert ei.value.code == board._QUESTION_GONE_CODE     # 已由 GUI 作答 → 放弃重试


def test_board_answer_approval_dsh_direct_and_scope(monkeypatch):
    """`board.answer_approval` 的 dsh 分支：任务侧直送 + 拒绝「本会话内批准」。"""
    rows = {"pending": True, "kind": "approval", "approval_id": "ap-1"}
    monkeypatch.setattr(board, "interaction_of_sid", lambda sid: dict(rows))
    seen = []
    monkeypatch.setattr(board.dshdriver, "answer_approval",
                        lambda sid, aid, outcome: seen.append((sid, aid, outcome)) or {})
    monkeypatch.setattr(board, "_iw_clear", lambda sid: None)
    proj = _proj("dsh-plugin:/usr/bin/dsh")
    # 任务侧（card 无 id）→ 直送，approved 映射 allowed-once
    err = board.answer_approval(proj, {"session_id": "session-a"}, "ap-1", "approved")
    assert err is None and seen == [("session-a", "ap-1", "allowed-once")]
    # 拒绝 rejected → rejected
    board.answer_approval(proj, {"session_id": "session-a"}, "ap-1", "rejected")
    assert seen[-1] == ("session-a", "ap-1", "rejected")
    # scope=session：dsh 无「本会话内批准」语义 → 明确报错且不投递
    err2 = board.answer_approval(proj, {"session_id": "session-a"}, "ap-1",
                                 "approved", scope="session")
    assert "不支持" in err2 and len(seen) == 2
    # 驱动异常上浮为错误串
    def boom(sid, aid, outcome):
        raise board.dshdriver.DshDriverError(-2, "不可达")
    monkeypatch.setattr(board.dshdriver, "answer_approval", boom)
    assert "审批失败" in board.answer_approval(proj, {"session_id": "session-a"},
                                             "ap-1", "approved")


def test_server_session_profile_dsh_permission_and_model(monkeypatch):
    """dsh 会话级配置：权限档映射到 preset（manual→workspace-write）+ 模型同请求可带；
    非法档 400、两者皆空 400、驱动异常 502。"""
    import server

    calls = []

    class _H:
        def _respond(self, code, body=b"", ctype=""):
            calls.append((code, json.loads(body or b"{}")))
        def _owned_project(self, pid):
            return {"id": pid, "agent_path": "dsh-plugin:/usr/bin/dsh"}
        def _board_owns_sid(self, row, sid):
            return {"id": 1}

    seen = []
    monkeypatch.setattr(server.dshdriver, "set_permission",
                        lambda sid, preset, mode=None:
                        seen.append(("preset", sid, preset, mode)) or {})
    monkeypatch.setattr(server.dshdriver, "set_model",
                        lambda sid, model, **kw: seen.append(("model", sid, model)) or {})
    server.Handler._api_board_session_profile(_H(), 1, "session-a",
                                              {"permission_mode": "manual"})
    # 三档 mode 随写一起下传（preset→三档多对一，只有平台知道点的是哪一档；
    # 驱动记下后经 driver/permission 帧回读，会话窗「权限」控件据此点亮）
    assert calls[-1][0] == 200
    assert seen == [("preset", "session-a", "workspace-write", "manual")]
    server.Handler._api_board_session_profile(_H(), 1, "session-a",
                                              {"permission_mode": "yolo", "model": "m1"})
    assert calls[-1][0] == 200
    assert seen[-2:] == [("preset", "session-a", "danger-full-access", "yolo"),
                         ("model", "session-a", "m1")]
    server.Handler._api_board_session_profile(_H(), 1, "session-a",
                                              {"permission_mode": "bogus"})
    assert calls[-1][0] == 400
    server.Handler._api_board_session_profile(_H(), 1, "session-a", {})
    assert calls[-1][0] == 400

    def boom(sid, preset, mode=None):
        raise server.dshdriver.DshDriverError(-2, "不可达")
    monkeypatch.setattr(server.dshdriver, "set_permission", boom)
    server.Handler._api_board_session_profile(_H(), 1, "session-a",
                                              {"permission_mode": "manual"})
    assert calls[-1][0] == 502 and "不可达" in calls[-1][1]["error"]


# ---------- P7a 缺陷 C：stop 置位后 SSE 线程秒级退出 ----------

class _SseStubHandler(BaseHTTPRequestHandler):
    """最小 SSE 桩：发两帧真帧后长时间静默（模拟真插件 15s keepalive 间隔）。

    chunked=True 走真插件形态（Node/HTTP1.1，Transfer-Encoding: chunked）；
    chunked=False 走 tests/fakedriver.py 假驱动的 HTTP/1.0「连接关闭收尾」形态
    （http.client 会把 socket 所有权交给响应并置空 conn.sock——这正是缺陷 C
    看门线程必须提前留 socket 引用的原因）。
    """

    protocol_version = "HTTP/1.1"
    chunked = True
    hold = 6.0                 # 首帧之后的静默时长（秒）：旧实现要等这么久才醒
    frame_count = 2
    first_frame = None         # 用例注入的 threading.Event：首帧写出后置位

    def log_message(self, *args):       # 静音
        pass

    def _write(self, data):
        if self.chunked:
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        else:
            self.wfile.write(data)
        self.wfile.flush()

    def do_GET(self):
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            if self.chunked:
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Connection", "close")
            self.end_headers()
            for i in range(1, self.frame_count + 1):
                self._write(b"data: " + json.dumps(
                    {"seq": i, "type": "noise", "n": i}).encode() + b"\n\n")
            if self.first_frame is not None:
                self.first_frame.set()
            time.sleep(self.hold)          # 静默：不主动关连接、也不再发帧
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            pass                           # 客户端主动断开：桩正常收尾


def _start_sse_stub(chunked, hold=6.0, frame_count=2):
    """起一个 SSE 桩，返回 (url, first_frame_event, httpd)。"""
    sent = threading.Event()
    handler = type("BoundSseStub", (_SseStubHandler,), {
        "chunked": chunked, "hold": hold, "frame_count": frame_count,
        "protocol_version": "HTTP/1.1" if chunked else "HTTP/1.0",
        "first_frame": sent})
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    # poll_interval 调小：shutdown() 不必等默认 0.5s 的 serve_forever 轮询节拍
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05},
                     daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}", sent, httpd


@pytest.mark.parametrize("chunked", [True, False])
def test_stream_stop_interrupts_blocking_read(monkeypatch, chunked):
    """[缺陷 C] stop 置位后 dshdriver.stream 秒级返回（不再白等到下一帧 keepalive）。

    实测时间线（真机）：驱动侧 /prompt → turn/end 0.21s，平台轮次日志却「开始
    09:07:54 / 结束 09:07:59」（+5s = runner 收尾的 join(timeout=5) 白等满）。
    本用例把 SSE 桩静默期设为 6s：修复前 stream 要等桩关连接（≈6s）才返回，
    修复后应在 1s 内返回，且断开前的帧一帧不丢。
    """
    url, sent, httpd = _start_sse_stub(chunked, hold=6.0)
    monkeypatch.setenv(dshdriver.URL_ENV, url)
    try:
        frames = []
        stop = threading.Event()
        box = {}
        t = threading.Thread(target=lambda: box.setdefault(
            "r", dshdriver.stream("session-sse", lambda f: frames.append(f),
                                  stop=stop.is_set)))
        t.start()
        assert sent.wait(5), "SSE 桩未写出首帧"
        time.sleep(0.3)                    # 让订阅线程读完已发帧、回到阻塞 read1
        t0 = time.time()
        stop.set()
        t.join(timeout=4)
        elapsed = time.time() - t0
        assert not t.is_alive(), "stop 置位后 SSE 线程仍滞留"
        assert elapsed < 1.0, f"stop → 退出耗时 {elapsed:.2f}s（缺陷 C 未修：应秒级退出）"
        assert [f["n"] for f in frames] == [1, 2]        # 断开前帧不丢
        assert box["r"] == (2, 2)                        # (帧数, 最后 seq) 正常收尾
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_stream_idle_timeout_still_raises(monkeypatch):
    """[缺陷 C 回归] 空闲超时语义不变：无字节超过 idle_timeout 仍抛 -2 让等待方收口。

    静默期 6s > idle_timeout=1s：必须在桩关连接（≈6s）之前就抛「事件流空闲超时」，
    证明主动断开的唤醒通道没有把空闲超时语义吃掉。
    """
    url, sent, httpd = _start_sse_stub(True, hold=6.0)
    monkeypatch.setenv(dshdriver.URL_ENV, url)
    try:
        t0 = time.time()
        with pytest.raises(dshdriver.DshDriverError) as ei:
            dshdriver.stream("session-sse", lambda f: None, idle_timeout=1.0)
        elapsed = time.time() - t0
        assert ei.value.code == -2
        assert "事件流空闲超时" in str(ei.value)
        assert elapsed < 5.0, f"空闲超时应在桩静默期内触发（实际 {elapsed:.2f}s）"
    finally:
        httpd.shutdown()
        httpd.server_close()


# ---------- P7a 缺陷 G：dsh_wait_turn 总时限兜底 ----------

def _stub_dsh_send(monkeypatch):
    """dsh 投递路径打桩：只喂「无关帧」（永不喂 turn/end），复现链路活着但不收口。"""
    monkeypatch.setattr(chat.dshdriver, "status",
                        lambda sid: {"last_seq": 7, "status": "running"})
    monkeypatch.setattr(chat.dshdriver, "prompt", lambda sid, text: {"ok": True})
    fed = threading.Event()

    def fake_feed(sid, since, waiter, stop_event, on_frame=None):
        while not stop_event.is_set():
            waiter.feed({"type": "assistant/message", "seq": 1, "data": {}})
            fed.set()
            time.sleep(0.05)

    monkeypatch.setattr(chat.dshdriver, "feed_into", fake_feed)
    return fed


def test_dsh_wait_turn_total_deadline_closes(monkeypatch, tmp_path):
    """[缺陷 G] turn/end 永不到达：dsh_wait_turn 在总时限内返回 None 并落日志行。

    复现实测症状：SSE 保活正常（无关帧一直有），但服务端就是不推 turn/end——
    旧实现只等 TurnWaiter，消息单元永久挂起（chat_msgs 卡 running、wait_items 的
    m: 行卡 starting 4 分钟以上，项目运行位只有重启能解）。现应在总时限（环境变量
    调小到约 1s）内按「本轮结束」返回，让调用方收口。
    """
    fed = _stub_dsh_send(monkeypatch)
    monkeypatch.setenv(chat.DSH_WAIT_TURN_TIMEOUT_ENV, "1.2")
    log_path = tmp_path / "chat_dsh_1.log"
    log_path.write_text("### DRIVER dsh_plugin sid=session-g followup\n", encoding="utf-8")
    t0 = time.time()
    assert chat.dsh_wait_turn("session-g", since=7, log_path=str(log_path)) is None
    elapsed = time.time() - t0
    assert fed.is_set(), "桩未喂出无关帧（未复现「链路活着但不收口」）"
    assert 1.0 <= elapsed < 3.0, f"总时限兜底未按时收口（实际 {elapsed:.2f}s）"
    text = log_path.read_text(encoding="utf-8")
    assert "### 会话等待 turn 结束超时（1.2s 无 turn/end）" in text


def test_dsh_wait_turn_deadline_uses_chat_log(monkeypatch, tmp_path):
    """[缺陷 G] 超时行缺省落到本会话对话日志（_CHATS[sid]）——board 评论投递
    走 chat.wait_web_busy → dsh_wait_turn 时不显式传 log_path 的分支。"""
    _stub_dsh_send(monkeypatch)
    monkeypatch.setenv(chat.DSH_WAIT_TURN_TIMEOUT_ENV, "1")
    log_path = tmp_path / "chat_dsh_2.log"
    log_path.write_text("", encoding="utf-8")
    with chat._lock:
        chat._CHATS["session-g2"] = {"dsh_plugin": True, "log_path": str(log_path)}
    try:
        t0 = time.time()
        assert chat.wait_web_busy(str(tmp_path), "session-g2", "dsh_plugin") is None
        assert time.time() - t0 < 3.0
    finally:
        with chat._lock:
            chat._CHATS.pop("session-g2", None)
    assert "### 会话等待 turn 结束超时（1s 无 turn/end）" in \
        log_path.read_text(encoding="utf-8")


def test_dsh_wait_turn_limit_env_override(monkeypatch):
    """总时限 = 常量默认（45 分钟，口径见 chat.py 注释）+ 环境变量覆盖（非法值回落）。"""
    monkeypatch.delenv(chat.DSH_WAIT_TURN_TIMEOUT_ENV, raising=False)
    assert chat._dsh_wait_turn_limit() == chat.DSH_WAIT_TURN_TIMEOUT == 2700.0
    monkeypatch.setenv(chat.DSH_WAIT_TURN_TIMEOUT_ENV, "12.5")
    assert chat._dsh_wait_turn_limit() == 12.5
    monkeypatch.setenv(chat.DSH_WAIT_TURN_TIMEOUT_ENV, "abc")
    assert chat._dsh_wait_turn_limit() == chat.DSH_WAIT_TURN_TIMEOUT
    monkeypatch.setenv(chat.DSH_WAIT_TURN_TIMEOUT_ENV, "-3")
    assert chat._dsh_wait_turn_limit() == chat.DSH_WAIT_TURN_TIMEOUT
