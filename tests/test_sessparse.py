# sessparse 单测（P7b B5 单族化后）：只覆盖 dsh 一族——多帧 zstd 事件流 → 统一
# entry 模型，以及会话定位（bucket / 文件名版本 / sid 白名单）/ 枚举 / 标题 /
# 存在性 / 运行中探测 / 媒体解析的正常与容错路径，末段断言单族收敛（退场族一律被拒）。
# 会话存储根由 autouse fixture 改指 tmp_path，绝不读真实用户目录。
import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
import zstandard

import sessparse

# 样本 id / 路径（dsh 会话 id 两代形态：`session-<uuid>` 与裸 `<uuid>`）
DSH_SID = "session-99999999-8888-7777-6666-555555555555"
DSH_SID2 = "session-11111111-1111-1111-1111-111111111111"
BARE_SID = "64655aea-1111-2222-3333-444444444444"        # 早期/桌面端目录名即 id
ABSENT_SID = "session-deadbeef-0000-0000-0000-000000000000"  # 形态合法但存储不存在
MEDIA_ID = "sha256:" + "a" * 64                          # dsh 宿主附件 id 形态
CWD = "/ws/proj"        # 样本会话的工作目录（虚拟路径，仅作 bucket 匹配键，不落盘）
OTHER_CWD = "/ws/other"

# P7b B5 退场族（含遗留名 deepseek）与未知/空族名，统一走「被拒」断言
RETIRED_FAMILIES = ("kimi", "claude", "opencode", "hermes", "deepseek", "nope", "")

# 随族退场删除的解析器/常量（B5 删除验收：模块里确实不存在这些名字）
REMOVED_NAMES = (
    "KIMI_SESSIONS", "CLAUDE_PROJECTS", "OPENCODE_DB", "OPENCODE_STORAGE", "HERMES_DB",
    "SID_KIMI_RE", "SID_CLAUDE_RE", "SID_OPENCODE_RE", "SID_HERMES_RE",
    "MEDIA_KIMI_RE", "KIMI_FILE_URL_RE", "MEDIA_KIMI_BLOB_RE", "KIMI_BLOB_URL_RE",
    "AGENT_NAME_RE", "_IMG_CTYPE",
    "kimi_title", "kimi_compaction_summary", "set_kimi_title", "kimi_undo_count",
    "hermes_title", "_iso_ms", "_json_dumps", "_sniff_ctype",
    "_list_kimi", "_list_claude", "_list_opencode", "_list_hermes",
    "_parse_kimi", "_parse_claude", "_parse_opencode", "_parse_hermes",
)


@pytest.fixture(autouse=True)
def _isolated_roots(tmp_path, monkeypatch):
    """会话存储根指向 tmp_path 独立子目录，并清空解析缓存/标题缓存。

    存储根无环境变量覆盖（模块常量），函数在调用时按模块全局名读取，故
    monkeypatch.setattr 生效；解析缓存键为 (sid, agent)（B5 单族化后不再带
    family），跨用例同 sid 会互相污染，逐用例清空。
    """
    monkeypatch.setattr(sessparse, "DSH_SESSIONS", str(tmp_path / "dsh" / "sessions"))
    monkeypatch.setattr(sessparse, "_DSH_TITLE_CACHE", {})
    monkeypatch.setattr(sessparse, "_ARCHIVE_CACHE", {"key": None, "ids": frozenset()})
    sessparse.cache_clear()
    yield


# ---------------------------------------------------------------- 样本构造

def _write(path, text):
    """写文本文件（自动建父目录）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _jsonl(records):
    """记录列表 → JSONL 文本（每行一个紧凑 JSON）。"""
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)


def _write_jsonl(path, records):
    _write(path, _jsonl(records))


def _append(path, text):
    """追加文本（模拟写入损坏/半截落盘的文件）。"""
    with open(path, "a", encoding="utf-8") as f:
        f.write(text)


def _frame_bytes(frame):
    """帧内容 → 字节：list/tuple 走 _jsonl，str 原样（用于构造坏 JSON 行）。"""
    text = frame if isinstance(frame, str) else _jsonl(frame)
    return text.encode("utf-8")


def _kinds(data):
    """load() 结果的 entry kind 序列（按 seq 序）。"""
    return [e["kind"] for e in data["entries"]]


def _dsh_frames(cwd=CWD):
    """dsh 事件流样本分两帧：帧 1 = 标题 + 真实用户输入（文本 + 图片）+ 系统注入
    （source.kind=plugin，应被过滤）；帧 2 = assistant 消息 + tool/call + tool/result。
    跨帧解析即验证多帧解压；每条事件带单调 seq（user 锚点 mid=`e<seq>` 的来源）。"""
    frame1 = [
        {"type": "session/title", "seq": 1, "time": 1, "data": {"title": "修复登录"}},
        {"type": "user/message", "seq": 2, "time": 100,
         "data": {"source": {"kind": "user"},
                  "content": [{"type": "text", "text": "请修复"},
                              {"type": "image",
                               "attachment": {"attachmentId": MEDIA_ID}}]}},
        {"type": "user/message", "seq": 3, "time": 101,
         "data": {"source": {"kind": "plugin"},
                  "content": [{"type": "text", "text": "系统注入"}]}},
    ]
    frame2 = [
        {"type": "assistant/message", "seq": 4, "time": 200,
         "data": {"message": {"content": [{"type": "reasoning", "text": "思考"},
                                          {"type": "text", "text": "好的"}]}}},
        {"type": "tool/call", "seq": 5, "time": 300,
         "data": {"callId": "c1", "name": "bash", "arguments": '{"cmd": "ls"}'}},
        {"type": "tool/result", "seq": 6, "time": 400,
         "data": {"message": {"source": {"callId": "c1"}, "content": [
             {"type": "tool-result", "toolCallId": "c1",
              "content": [{"type": "text", "text": "输出"}]}]}}},
    ]
    return [frame1, frame2]


def _mk_dsh(frames=None, sid=DSH_SID, cwd=CWD, mtime=None, fname="session.jsonl.zstd"):
    """建 dsh 多帧 zstd 会话文件样本（每帧一次 compress，字节直接拼接），返回文件路径。

    fname 可指定带格式版本的文件名（session.v3/v4.jsonl.zstd）以验证版本优先。
    """
    path = os.path.join(sessparse.dsh_bucket(cwd), sid, fname)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    comp = zstandard.ZstdCompressor()
    blob = b"".join(comp.compress(_frame_bytes(frame))
                    for frame in (_dsh_frames(cwd) if frames is None else frames))
    with open(path, "wb") as f:
        f.write(blob)
    if mtime is not None:
        # 文件 mtime 供 list_sessions/_live_dsh（按事件流文件），目录 mtime 供区分
        # 目录语义的用例；两处一起固定才能稳定断言顺序
        os.utime(path, (mtime, mtime))
        os.utime(os.path.dirname(path), (mtime, mtime))
    return path


def _append_dsh_frame(path, frame):
    """向 dsh 会话文件追加**一个 zstd 帧**（真实存储的增量写入形态：多帧拼接）。"""
    with open(path, "ab") as f:
        f.write(zstandard.ZstdCompressor().compress(_frame_bytes(frame)))


# ------------------------------------------------ dsh 解析：entry 模型 / 增量 / 容错

def test_dsh_load_multiframe_zstd_entry_model():
    """dsh load：多帧 zstd 跨帧解压——帧 1/帧 2 的事件落同一 entry 流；user 只认
    source.kind=user（plugin 注入被过滤）；图片记宿主附件 id；tool_result 回填工具名；
    user 条目带回退锚点 mid/eseq；无 usage 事件时 totals 全 0。"""
    path = _mk_dsh()
    with open(path, "rb") as f:
        assert len(f.read()) > 0
    data = sessparse.load("dsh", DSH_SID, "main", 0)
    assert data["found"] is True and data["agent"] == "main"
    # 单线会话、无子 agent（只固定 id，附带的 type/parent 展示字段不写死）
    assert [a["id"] for a in data["agents"]] == ["main"]
    assert _kinds(data) == ["user", "think", "assistant", "tool_call", "tool_result"]
    assert [e["seq"] for e in data["entries"]] == list(range(5))   # seq 自 0 递增
    assert data["total"] == 5 == len(data["entries"])
    user = data["entries"][0]
    assert user["text"] == "请修复" and user["time"] == 100        # 帧 1
    assert user["images"] == [{"media": MEDIA_ID}]
    assert user["mid"] == "e2" and user["eseq"] == 2               # 回退锚点
    assert data["entries"][1]["text"] == "思考"                     # 帧 2（只解首帧会丢）
    call = data["entries"][3]
    assert call["name"] == "bash" and call["call_id"] == "c1"
    assert json.loads(call["args"]) == {"cmd": "ls"}
    result = data["entries"][4]
    assert result["name"] == "bash" and result["text"] == "输出"    # 工具名回填
    assert result["is_error"] is False and result["truncated"] is False
    assert data["totals"] == {"input": 0, "output": 0, "cache_read": 0, "duration_ms": 0}


def test_dsh_load_after_incremental_and_reparse():
    """dsh load：after 增量窗口（越界空、负数当 0，total 恒为全量条数）；文件追加新帧
    后按 stamp 重新解析，total 跟随增长且新帧内容可见。"""
    path = _mk_dsh()
    data = sessparse.load("dsh", DSH_SID, "main", 4)
    assert [e["seq"] for e in data["entries"]] == [4]      # after=4 只回增量
    assert data["total"] == 5                              # total 仍是全量条数
    assert sessparse.load("dsh", DSH_SID, "main", 99)["entries"] == []   # 越界 → 空
    assert len(sessparse.load("dsh", DSH_SID, "main", -5)["entries"]) == 5  # 负数当 0
    _append_dsh_frame(path, [{"type": "assistant/message", "seq": 7, "time": 500,
                              "data": {"message": {"content": [
                                  {"type": "text", "text": "后续"}]}}}])
    again = sessparse.load("dsh", DSH_SID, "main", 0)
    assert again["total"] == 6                             # 文件变化 → 重新解析
    assert _kinds(again)[-1] == "assistant"
    assert again["entries"][-1]["text"] == "后续"


def test_dsh_load_cache_hit_and_stamp_invalidation(monkeypatch):
    """dsh load：解析结果按 (sid, agent) 缓存——文件未变时二次 load 命中缓存（不再
    解压解析）；追加帧或仅 mtime 变化（stamp=(mtime_ns, size)）后重解析。"""
    path = _mk_dsh()
    calls = []
    real = sessparse._parse_dsh

    def counting(p):
        calls.append(p)
        return real(p)

    monkeypatch.setattr(sessparse, "_parse_dsh", counting)
    assert sessparse.load("dsh", DSH_SID, "main", 0)["total"] == 5
    assert sessparse.load("dsh", DSH_SID, "main", 2)["total"] == 5
    assert len(calls) == 1                                 # 缓存命中，未重复解析
    # 缓存键为 (sid, agent)：B5 单族化后不再带 family
    assert set(sessparse._CACHE) == {(DSH_SID, "main")}
    # 换 agent → 另一个缓存键（单族会话只有 main，agent 参数仍原样参与键）
    assert sessparse.load("dsh", DSH_SID, "sub", 0)["total"] == 5
    assert set(sessparse._CACHE) == {(DSH_SID, "main"), (DSH_SID, "sub")}
    assert len(calls) == 2
    _append_dsh_frame(path, [{"type": "assistant/message", "seq": 7, "time": 500,
                              "data": {"message": {"content": [
                                  {"type": "text", "text": "新帧"}]}}}])
    assert sessparse.load("dsh", DSH_SID, "main", 0)["total"] == 6
    assert len(calls) == 3                                 # 追加帧 → stamp 失效
    os.utime(path, (12345.0, 12345.0))                     # 内容/大小不变、仅 mtime 变
    assert sessparse.load("dsh", DSH_SID, "main", 0)["total"] == 6
    assert len(calls) == 4


def test_dsh_load_tolerates_bad_and_non_object_lines():
    """dsh load：坏 JSON 行与合法 JSON 非对象行（数组/数字/字符串/null）跳过不崩——
    旧实现对这类行直接 .get() 会抛 AttributeError 炸掉整次解析；同一容错覆盖标题
    提取路径（session_title 逐行扫描同一事件流）。"""
    title, user, injected = _dsh_frames()[0]
    frame = ("{坏 JSON 行\n"
             + _jsonl([title, [1, 2, 3], 123, "字符串行", None, user, injected]))
    _mk_dsh(frames=[frame])
    data = sessparse.load("dsh", DSH_SID, "main", 0)
    assert data["found"] is True and data["total"] == 1
    assert _kinds(data) == ["user"]
    assert data["entries"][0]["text"] == "请修复"
    assert sessparse.session_title("dsh", DSH_SID) == "修复登录"


def test_dsh_load_agent_echo_and_fixed_agents():
    """dsh load：单线会话 agents 恒为 main 一项，agent 参数原样回显（B5 单族语义：
    不再按族回落到 main）；仅 agent 为空才补 "main"。"""
    _mk_dsh()
    ghost = sessparse.load("dsh", DSH_SID, "ghost", 0)
    assert ghost["agent"] == "ghost"
    assert [a["id"] for a in ghost["agents"]] == ["main"]
    assert ghost["found"] is True
    assert sessparse.load("dsh", DSH_SID, "", 0)["agent"] == "main"


def test_dsh_load_truncates_long_args_and_output():
    """dsh load：tool_call args 截到 ARGS_MAX、tool_result 输出截到 OUT_MAX 并置
    truncated（会话窗不因超长参数/输出卡死）。"""
    long_args = '{"cmd": "' + "x" * (sessparse.ARGS_MAX + 100) + '"}'
    long_out = "y" * (sessparse.OUT_MAX + 100)
    _mk_dsh(frames=[[
        {"type": "tool/call", "seq": 1, "time": 10,
         "data": {"callId": "c9", "name": "bash", "arguments": long_args}},
        {"type": "tool/result", "seq": 2, "time": 11,
         "data": {"message": {"source": {"callId": "c9"}, "content": [
             {"type": "tool-result", "toolCallId": "c9",
              "content": [{"type": "text", "text": long_out}]}]}}},
    ]])
    data = sessparse.load("dsh", DSH_SID, "main", 0)
    assert _kinds(data) == ["tool_call", "tool_result"]
    call, result = data["entries"]
    assert len(call["args"]) == sessparse.ARGS_MAX
    assert len(result["text"]) == sessparse.OUT_MAX
    assert result["truncated"] is True and result["name"] == "bash"


def test_dsh_tool_result_v4_real_shape():
    """dsh tool/result 取 v4 **实况**形态的文本，并回填 is_error。

    真机样本（2026-10-04 B7 走查发现）：v4 事件里 `message.content` **直接**是
    `[{"type":"text","text":…}]`，工具名在 `message.source.callId` 关联的 tool/call，
    错误位在 `message.isError`；旧实现只认再嵌一层的 `{type:"tool-result",content:[…]}`
    形态 ⇒ 真机上所有 tool_result 的 text 恒为空、会话窗全是「结果 · bash（0 字符）」。
    本例用真机逐字形态钉住；嵌套形态仍由既有 `_mk_dsh` 样本覆盖（兼容迁移前事件）。
    """
    _mk_dsh(frames=[[
        {"type": "tool/call", "seq": 20, "time": 1791076837894,
         "data": {"turn": 1, "step": 1, "callId": "call_00_eiYwxQDqoVHLJ9iJGzIR2595",
                  "name": "bash",
                  "arguments": '{"command": "pwd && ls -la", "description": "List"}'}},
        {"type": "tool/result", "seq": 21, "time": 1791076837918,
         "data": {"turn": 1, "step": 1, "message": {
             "role": "tool",
             "source": {"kind": "tool", "callId": "call_00_eiYwxQDqoVHLJ9iJGzIR2595"},
             "toolCallId": "call_00_eiYwxQDqoVHLJ9iJGzIR2595",
             "content": [{"type": "text", "text": "/tmp/tf_acc/proj\ntotal 8\n"}],
             "isError": False, "id": "7a58ec1a"}}, "sourceEventSeqs": [20],
         "surfaceOp": "append"},
        {"type": "tool/result", "seq": 22, "time": 1791076837920,
         "data": {"turn": 1, "step": 1, "message": {
             "role": "tool",
             "source": {"kind": "tool", "callId": "call_00_eiYwxQDqoVHLJ9iJGzIR2595"},
             "content": [{"type": "text", "text": "boom"}],
             "isError": True, "id": "err-1"}}},
    ]])
    data = sessparse.load("dsh", DSH_SID, "main", 0)
    assert _kinds(data) == ["tool_call", "tool_result", "tool_result"]
    call, ok, bad = data["entries"]
    assert call["name"] == "bash" and '"pwd && ls -la"' in call["args"]
    assert ok["text"] == "/tmp/tf_acc/proj\ntotal 8\n"
    assert ok["name"] == "bash" and ok["call_id"].startswith("call_00_")
    assert ok["is_error"] is False and ok["truncated"] is False
    assert bad["text"] == "boom" and bad["is_error"] is True


def test_dsh_load_missing_and_unreadable_storage():
    """dsh load：不存在的 sid / 路径穿越 sid → missing；空会话（0 帧）、明文 JSONL
    （未压缩）→ 解压失败按空事件流处理（found 但 0 条，不崩）；**尾部损坏/半截帧
    只丢坏帧**（P7b B5 顺带修：原先整段解压失败 → 整会话 0 条，实测 3206 条历史
    因尾部 21 字节垃圾全部不可见）。"""
    assert sessparse.load("dsh", ABSENT_SID, "main", 0) == {
        "found": False, "reason": "missing"}
    assert sessparse.load("dsh", "../../x", "main", 0) == {
        "found": False, "reason": "missing"}
    assert sessparse.load("dsh", "../../etc/passwd", "main", 0) == {
        "found": False, "reason": "missing"}     # sid 白名单挡路径穿越
    path = _mk_dsh(frames=[])
    data = sessparse.load("dsh", DSH_SID, "main", 0)
    assert data["found"] is True and data["entries"] == [] and data["total"] == 0
    assert data["totals"] == {"input": 0, "output": 0, "cache_read": 0, "duration_ms": 0}
    _write_jsonl(path, [{"type": "user/message", "seq": 1, "data": {
        "source": {"kind": "user"}, "content": [{"type": "text", "text": "明文"}]}}])
    assert sessparse.load("dsh", DSH_SID, "main", 0)["entries"] == []   # 非 zstd 字节
    _mk_dsh()
    whole = sessparse.load("dsh", DSH_SID, "main", 0)["total"]
    assert whole > 0
    _append(path, "半截未写完的行\n")             # 帧后垃圾（末帧坏）→ 前序帧保留
    broken = sessparse.load("dsh", DSH_SID, "main", 0)
    assert broken["found"] is True and broken["total"] == whole
    # 末帧只写了一半（压缩帧被截断）：同样只丢坏帧，前序帧照常可读
    frame1, frame2 = _dsh_frames()
    _mk_dsh(frames=[frame1])
    first_only = sessparse.load("dsh", DSH_SID, "main", 0)["total"]
    assert first_only > 0
    half = zstandard.ZstdCompressor().compress(_frame_bytes(frame2))
    with open(path, "ab") as f:
        f.write(half[:len(half) // 2])
    truncated = sessparse.load("dsh", DSH_SID, "main", 0)
    assert truncated["found"] is True and truncated["total"] == first_only


def test_dsh_user_anchors_and_fork_boundary():
    """dsh 回退锚点：dsh_user_anchors 列真实用户提问（mid 用 `e<事件seq>` 合成，注入
    与 slash 类噪音不计，纯图片提问文本记 [图片]）；dsh_fork_boundary 把「回退到该
    提问之前」换算成 inclusive 的宿主 atSeq（该提问 seq 的前一个）；mid 空 / 提问不在
    会话 / 会话不可读 → None。"""
    _mk_dsh(frames=[[
        {"type": "user/message", "seq": 1, "time": 100,
         "data": {"source": {"kind": "user"},
                  "content": [{"type": "text", "text": "问题 A"}]}},
        {"type": "user/message", "seq": 2, "time": 101,
         "data": {"source": {"kind": "plugin"},
                  "content": [{"type": "text", "text": "注入噪音"}]}},
        {"type": "user/message", "seq": 3, "time": 102,
         "data": {"source": {"kind": "user"},
                  "content": [{"type": "text", "text": "问题 B"}]}},
        {"type": "user/message", "seq": 5, "time": 103,
         "data": {"source": {"kind": "user"},
                  "content": [{"type": "image",
                               "attachment": {"attachmentId": MEDIA_ID}}]}},
    ]])
    assert sessparse.dsh_user_anchors(DSH_SID) == [
        {"mid": "e1", "eseq": 1, "text": "问题 A"},
        {"mid": "e3", "eseq": 3, "text": "问题 B"},
        {"mid": "e5", "eseq": 5, "text": "[图片]"},
    ]
    assert sessparse.dsh_fork_boundary(DSH_SID, "e1") == 0     # max(0, 1-1)
    assert sessparse.dsh_fork_boundary(DSH_SID, "e3") == 2
    assert sessparse.dsh_fork_boundary(DSH_SID, "e5") == 4
    assert sessparse.dsh_fork_boundary(DSH_SID, "e_ghost") is None
    assert sessparse.dsh_fork_boundary(DSH_SID, "") is None
    assert sessparse.dsh_fork_boundary(ABSENT_SID, "e1") is None
    assert sessparse.dsh_user_anchors(ABSENT_SID) == []
    data = sessparse.load("dsh", DSH_SID, "main", 0)
    assert _kinds(data) == ["user", "user", "user"]            # 注入不进 entry
    assert data["entries"][-1]["images"] == [{"media": MEDIA_ID}]


# ------------------------------------------------ 会话定位：bucket / 文件版本 / sid 白名单

def test_dsh_bucket_naming():
    """dsh_bucket：路径斜杠换 '-'、首尾各补 '-'（/srv/myproj → --srv-myproj--）；
    尾斜杠归一；空 cwd 只剩首部 '-' 与尾部 '--'（即 '---'）。"""
    root = sessparse.DSH_SESSIONS
    assert sessparse.dsh_bucket("/srv/myproj") == os.path.join(root, "--srv-myproj--")
    assert sessparse.dsh_bucket("/srv/myproj/") == os.path.join(root, "--srv-myproj--")
    assert sessparse.dsh_bucket("") == os.path.join(root, "---")


def test_dsh_pick_file_prefers_highest_version():
    """_dsh_pick_file：会话目录内 `session*.jsonl.zstd` 取版本号最大者（v4 > v3 >
    无版本）——只认无版本名会让 v3/v4 会话全部 found=false（真机踩中）；后缀不符的
    文件不参与挑选；无匹配返回 None。"""
    sdir = os.path.dirname(_mk_dsh(fname="session.jsonl.zstd"))
    assert os.path.basename(sessparse._dsh_pick_file(sdir)) == "session.jsonl.zstd"
    _write(os.path.join(sdir, "session.v4.jsonl"), "明文，后缀不符")   # 不该被选中
    assert os.path.basename(sessparse._dsh_pick_file(sdir)) == "session.jsonl.zstd"
    _mk_dsh(fname="session.v3.jsonl.zstd")
    assert os.path.basename(sessparse._dsh_pick_file(sdir)) == "session.v3.jsonl.zstd"
    _mk_dsh(fname="session.v4.jsonl.zstd")
    assert os.path.basename(sessparse._dsh_pick_file(sdir)) == "session.v4.jsonl.zstd"
    assert sessparse._dsh_session_file(DSH_SID).endswith("session.v4.jsonl.zstd")
    assert sessparse.load("dsh", DSH_SID, "main", 0)["total"] == 5   # 定向到 v4 且能解
    assert sessparse._dsh_pick_file(os.path.join(sessparse.DSH_SESSIONS,
                                                 "no-such-dir")) is None


def test_dsh_session_file_lookup_and_traversal():
    """_dsh_session_file：按 sid 跨工作区 bucket 定位；两代目录名（session-<uuid> /
    裸 <uuid>）都能定向并解析；非 id 形态与路径穿越一律 None（sid 白名单）。"""
    path = _mk_dsh()
    assert sessparse._dsh_session_file(DSH_SID) == path
    bare = _mk_dsh(sid=BARE_SID, frames=[[
        {"type": "assistant/message", "seq": 1, "time": 10,
         "data": {"message": {"content": [{"type": "text", "text": "裸 id 会话"}]}}}]])
    assert sessparse._dsh_session_file(BARE_SID) == bare
    assert sessparse.load("dsh", BARE_SID, "main", 0)["entries"][0]["text"] == "裸 id 会话"
    other = _mk_dsh(sid=DSH_SID2, cwd=OTHER_CWD)          # 另一 bucket 下也能定位
    assert sessparse._dsh_session_file(DSH_SID2) == other
    for bad in ("../../x", "../../etc/passwd", "", "not a sid",
                "session-" + "z" * 30, "0" * 37):
        assert sessparse._dsh_session_file(bad) is None


def test_dsh_latest_session_newest_and_empty():
    """dsh_latest_session：按**事件流文件** mtime 取最新会话（目录 mtime 不随写入
    变化，故真机语义看文件——本用例刻意让目录 mtime 与文件相反以固定该语义）；
    缺事件流文件的会话目录跳过；未建工作区 / 空 cwd → ''。"""
    old = _mk_dsh(sid=DSH_SID2)
    new = _mk_dsh(sid=DSH_SID)
    os.utime(os.path.dirname(old), (9000, 9000))   # 旧会话的目录更「新」
    os.utime(old, (1000, 1000))                    # 但事件流文件更旧
    os.utime(os.path.dirname(new), (1, 1))
    os.utime(new, (2000, 2000))
    assert sessparse.dsh_latest_session(CWD) == DSH_SID
    # 只有目录、没有事件流文件的会话目录：枚举时跳过
    os.makedirs(os.path.join(sessparse.dsh_bucket(CWD),
                             "session-22222222-2222-2222-2222-222222222222"),
                exist_ok=True)
    assert sessparse.dsh_latest_session(CWD) == DSH_SID
    assert sessparse.dsh_latest_session(OTHER_CWD) == ""      # bucket 不存在
    assert sessparse.dsh_latest_session("") == ""             # 空 cwd（bucket 名 --）


def test_sid_and_media_re_whitelist():
    """SID_DSH_RE / MEDIA_DSH_RE：两代会话 id 形态放行、路径穿越与非 id 形态拒绝；
    附件 id 只认 `sha256:<64 位小写 hex>`。"""
    assert sessparse.SID_DSH_RE.match(DSH_SID)
    assert sessparse.SID_DSH_RE.match(BARE_SID)
    for bad in ("../../x", "../../etc/passwd", "", "not a sid", "session-" + "z" * 30,
                "0" * 37):
        assert sessparse.SID_DSH_RE.match(bad) is None
    assert sessparse.MEDIA_DSH_RE.match(MEDIA_ID)
    for bad in ("sha256:" + "A" * 64,       # 大写 hex 不放行
                "sha256:" + "a" * 63, MEDIA_ID + "0", "a" * 64, ""):
        assert sessparse.MEDIA_DSH_RE.match(bad) is None


# -------------------------------------- 会话枚举 / 标题 / 存在性 / 运行中探测

def test_list_sessions_dsh_sorted_limit_and_edges(monkeypatch):
    """list_sessions：bucket 目录下枚举（目录名即 sid）、mtime 降序、title 取
    session/title 事件、归档标记读宿主归档集（本用例无归档集 ⇒ 恒 False）；
    缺事件流文件的目录跳过；上限按 LIST_SESSIONS_LIMIT 截断；空 cwd / 未建工作区
    一律 []。"""
    _mk_dsh(sid=DSH_SID2, mtime=1000)
    _mk_dsh(sid=DSH_SID, mtime=2000)
    os.makedirs(os.path.join(sessparse.dsh_bucket(CWD),
                             "session-22222222-2222-2222-2222-222222222222"),
                exist_ok=True)                      # 只有目录：跳过
    items = sessparse.list_sessions("dsh", CWD)
    assert [i["sid"] for i in items] == [DSH_SID, DSH_SID2]      # mtime 降序
    assert items[0]["title"] == "修复登录" and items[0]["archived"] is False
    assert items[0]["mtime"] == pytest.approx(2000)
    assert items[1]["mtime"] == pytest.approx(1000)
    assert [i["sid"] for i in sessparse.list_sessions("dsh", CWD + "/")] == \
        [DSH_SID, DSH_SID2]                         # 尾斜杠归一
    monkeypatch.setattr(sessparse, "LIST_SESSIONS_LIMIT", 1)     # 上限截断
    assert len(sessparse.list_sessions("dsh", CWD)) == 1
    assert sessparse.list_sessions("dsh", "") == []
    assert sessparse.list_sessions("dsh", "/ws/none") == []


def _write_archive_state(ids):
    """写宿主归档集文件（`<dsh home>/storages/workspace.json`），返回路径。"""
    home = os.path.dirname(sessparse.DSH_SESSIONS)
    path = os.path.join(home, "storages", "workspace.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"unit": {"name": "workspace", "version": 2},
                   "global": {"initialized": True, "workspaceIds": [],
                              "archivedSessionIds": list(ids)}}, f)
    return path


def test_list_sessions_archived_from_workspace_state(monkeypatch):
    """归档标记来源 = 宿主 workspace.json 的 global.archivedSessionIds：
    命中 True、未命中 False；文件重写（归档集变化）后缓存失效重读。"""
    _mk_dsh(sid=DSH_SID, mtime=2000)
    _mk_dsh(sid=DSH_SID2, mtime=1000)
    _write_archive_state([DSH_SID])
    by_sid = {i["sid"]: i for i in sessparse.list_sessions("dsh", CWD)}
    assert by_sid[DSH_SID]["archived"] is True
    assert by_sid[DSH_SID2]["archived"] is False
    _write_archive_state([DSH_SID, DSH_SID2])       # 归档集变化 → mtime/size 失效
    by_sid = {i["sid"]: i for i in sessparse.list_sessions("dsh", CWD)}
    assert by_sid[DSH_SID]["archived"] is True
    assert by_sid[DSH_SID2]["archived"] is True
    _write_archive_state([])                        # 清空归档
    assert all(not i["archived"] for i in sessparse.list_sessions("dsh", CWD))


def test_dsh_archived_ids_tolerates_broken_state(monkeypatch):
    """归档集读取容错：缺文件 / 坏 JSON / 缺该键 / 顶层直挂形态，一律降级不抛。"""
    assert sessparse._dsh_archived_ids() == frozenset()          # 缺文件
    home = os.path.dirname(sessparse.DSH_SESSIONS)
    path = os.path.join(home, "storages", "workspace.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("{ 这不是 JSON")
    monkeypatch.setattr(sessparse, "_ARCHIVE_CACHE", {"key": None, "ids": frozenset()})
    assert sessparse._dsh_archived_ids() == frozenset()
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"global": {"initialized": True}}, f)          # 无该键
    monkeypatch.setattr(sessparse, "_ARCHIVE_CACHE", {"key": None, "ids": frozenset()})
    assert sessparse._dsh_archived_ids() == frozenset()
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"archivedSessionIds": [DSH_SID]}, f)          # 顶层直挂（防御兼容）
    monkeypatch.setattr(sessparse, "_ARCHIVE_CACHE", {"key": None, "ids": frozenset()})
    assert sessparse._dsh_archived_ids() == frozenset({DSH_SID})


def test_session_title_dsh_and_cache_refresh():
    """session_title / dsh_title：标题取 session/title 事件；无该事件的会话、不存在的
    会话、非法 sid 返回 ''；标题按文件 stamp 缓存，文件变化（换标题）后重新读取。"""
    _mk_dsh()
    assert sessparse.session_title("dsh", DSH_SID) == "修复登录"
    assert sessparse.dsh_title(DSH_SID) == "修复登录"
    _mk_dsh(sid=DSH_SID2, frames=[[                       # 无 session/title 事件
        {"type": "assistant/message", "seq": 1, "time": 1,
         "data": {"message": {"content": [{"type": "text", "text": "无标题"}]}}}]])
    assert sessparse.session_title("dsh", DSH_SID2) == ""
    assert sessparse.session_title("dsh", ABSENT_SID) == ""
    assert sessparse.session_title("dsh", "../../x") == ""
    _mk_dsh(frames=[[{"type": "session/title", "seq": 1, "time": 1,
                      "data": {"title": "新标题"}}]])
    assert sessparse.session_title("dsh", DSH_SID) == "新标题"   # 缓存失效重读


def test_session_exists_dsh():
    """session_exists：纯路径存在性（不做内容解析）——未建 False、建成 True；不存在
    sid / 非法 sid（路径穿越、非 id 形态）恒 False。"""
    assert sessparse.session_exists("dsh", DSH_SID) is False
    _mk_dsh()
    assert sessparse.session_exists("dsh", DSH_SID) is True
    assert sessparse.session_exists("dsh", ABSENT_SID) is False
    assert sessparse.session_exists("dsh", "../../x") is False
    assert sessparse.session_exists("dsh", "../../etc/passwd") is False
    assert sessparse.session_exists("dsh", "") is False


def test_live_session_id_dsh():
    """live_session_id：dsh 按「工作区 bucket + 事件流 mtime 晚于 since」探测运行中
    会话；尾斜杠归一；since 晚于活动 / 别的 cwd / cwd 空 / since<=0 → ''。"""
    path = _mk_dsh()
    base = os.path.getmtime(path)
    assert sessparse.live_session_id("dsh", CWD, base - 1) == DSH_SID
    assert sessparse.live_session_id("dsh", CWD + "/", base - 1) == DSH_SID
    assert sessparse.live_session_id("dsh", CWD, base + 1) == ""     # since 晚于活动
    assert sessparse.live_session_id("dsh", OTHER_CWD, base - 1) == ""
    assert sessparse.live_session_id("dsh", "", base - 1) == ""
    assert sessparse.live_session_id("dsh", CWD, 0) == ""


# ---------------------------------------------------------------- 媒体解析

def test_resolve_media_dsh(monkeypatch):
    """resolve_media：dsh 媒体 id 走 `sha256:<64hex>` 白名单 + 驱动 `media()` 取字节，
    解码成 (bytes, content_type)；形态不符不进驱动；驱动空数据/空类型/OSError 一律
    None（驱动未配置时不触网）。"""
    calls = []

    def fake_media(mid):
        calls.append(mid)
        return {"content_type": "image/png",
                "data": base64.b64encode(b"PNG1").decode()}

    monkeypatch.setattr(sessparse.dshdriver, "media", fake_media)
    assert sessparse.resolve_media("dsh", DSH_SID, "main", MEDIA_ID) == \
        (b"PNG1", "image/png")
    assert sessparse.resolve_media("dsh", DSH_SID, "main", "bad-id") is None
    assert sessparse.resolve_media("dsh", DSH_SID, "main", "sha256:" + "A" * 64) is None
    assert sessparse.resolve_media("dsh", DSH_SID, "main", "") is None
    assert calls == [MEDIA_ID]                      # 非法 id 不触达驱动
    monkeypatch.setattr(sessparse.dshdriver, "media",
                        lambda mid: {"content_type": "image/png", "data": ""})
    assert sessparse.resolve_media("dsh", DSH_SID, "main", MEDIA_ID) is None
    monkeypatch.setattr(sessparse.dshdriver, "media",
                        lambda mid: {"content_type": "", "data": "eA=="})
    assert sessparse.resolve_media("dsh", DSH_SID, "main", MEDIA_ID) is None

    def boom(mid):
        raise OSError("驱动不可用")

    monkeypatch.setattr(sessparse.dshdriver, "media", boom)
    assert sessparse.resolve_media("dsh", DSH_SID, "main", MEDIA_ID) is None


# ------------------------------------------------ 单族收敛（P7b B5 核心验收点）

def test_families_single_family_dsh():
    """单族收敛：FAMILIES 只剩 dsh；遗留解析族名 deepseek 已改名删除。"""
    assert sessparse.FAMILIES == ("dsh",)
    assert "deepseek" not in sessparse.FAMILIES


@pytest.mark.parametrize("family", RETIRED_FAMILIES)
def test_retired_families_rejected(family):
    """退场四族（kimi/claude/opencode/hermes）、遗留族名 deepseek 与未知/空族名一律
    被拒：load → unsupported、标题 ''、列表 []、存在性 False、运行探测 ''、媒体 None
    ——即使磁盘上存在会话存储也不放行。"""
    _mk_dsh()
    assert sessparse.load(family, DSH_SID, "main", 0) == {
        "found": False, "reason": "unsupported"}
    assert sessparse.session_title(family, DSH_SID) == ""
    assert sessparse.list_sessions(family, CWD) == []
    assert sessparse.session_exists(family, DSH_SID) is False
    assert sessparse.live_session_id(family, CWD, 1) == ""
    assert sessparse.resolve_media(family, DSH_SID, "main", MEDIA_ID) is None


def test_retired_family_attrs_removed():
    """退场族的解析器/常量确实不在模块里（B5 删除验收）：逐名断言 not hasattr。"""
    for name in REMOVED_NAMES:
        assert not hasattr(sessparse, name), f"{name} 应随族退场删除"
