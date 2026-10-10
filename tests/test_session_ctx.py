#!/usr/bin/env python3
"""会话窗底栏「上下文占用」圈的数据链（2026-10-10 修「一致都是 0」）。

**症状**：会话详情页底栏的占用圈恒显示 0（`ComposerBar` 的 `.sess-ring`）。
**根因**：前端按 `meta.ctx = {used, max}` 画进度弧，且 `+ctx.max > 0` 才算百分比；
而服务端只有看板卡片会话下发 ctx，且分母写死 `"max": None`（P6 时代「dsh 的
TokenUsage 没有窗口上限」）——`used/max` 永远算不出百分比；任务会话端点则连 ctx
都不下发，两侧一律画 0。

**修法**：分子/分母改从**会话存储**的两个 last-wins 槽位取（`sessparse.load`）：
`assistant/message.usage` 的 prompt 侧 token 数 + `request/context.contextWindow`。
本文件钉住**接线**（解析本身的口径单测在 tests/test_sessparse.py）：用真会话文件
（真 `sessparse.load`）过端点，断言 ctx 来自会话文件、**不是** EventHub 的旧口径
（旧口径是 `{"used": total, "max": None}`，正是本次要修掉的形态）。

端点用最小 handler 替身直接调方法（不起 HTTP，同 tests/test_session_owned.py 先例）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
import zstandard

import sessparse
import server

SID = "session-abcabcab-1234-5678-9012-abcdefabcdef"
# 真机样本口径（2026-10-10 卡 952 会话实测）：prompt 侧 372 + 277632 + 0 = 278004
USAGE = {"inputTokens": 372, "outputTokens": 1170, "cacheReadTokens": 277632,
         "cacheWriteTokens": 0, "totalTokens": 279174}
WINDOW = 1000000
WANT_CTX = {"used": 278004, "max": WINDOW}


@pytest.fixture(autouse=True)
def _session_file(tmp_path, monkeypatch):
    """把会话存储根指到 tmp_path，写一份「窗口 + usage」俱全的 dsh 会话文件。

    会话窗数据链的其余读口（运行态/队列态/看板）全部打桩——本文件只关心 ctx。
    """
    monkeypatch.setattr(sessparse, "DSH_SESSIONS", str(tmp_path / "sessions"))
    sessparse.cache_clear()
    events = [
        {"type": "request/context", "seq": 1, "time": 1,
         "data": {"provider": "deepseek-account", "model": "deepseek-flash",
                  "contextWindow": WINDOW}},
        {"type": "assistant/message", "seq": 2, "time": 2,
         "data": {"message": {"content": [{"type": "text", "text": "好"}]},
                  "usage": USAGE}},
    ]
    path = os.path.join(sessparse.DSH_SESSIONS, "bucket", SID, "session.v4.jsonl.zstd")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(zstandard.ZstdCompressor().compress(
            "".join(json.dumps(e) + "\n" for e in events).encode("utf-8")))
    yield path
    sessparse.cache_clear()


def _stub_common(monkeypatch):
    """会话窗下发的非 ctx 读口一律打桩（本文件不测它们）。

    特别地：`dshevents.get` 返回**带 usage 的旧数据源**——它必须不再影响 ctx
    （旧代码正是拿它的 total 当 used、max 恒 None）。
    """
    monkeypatch.setattr(server, "_board_session_running", lambda *a: True)
    monkeypatch.setattr(server.chat, "state", lambda sid: {"running": True})
    monkeypatch.setattr(server, "_project_busy", lambda pid: False)
    monkeypatch.setattr(server, "_unit_state", lambda pid, key: "idle")
    monkeypatch.setattr(server.board, "is_answer_pending", lambda cid: False)
    monkeypatch.setattr(server.board, "interaction_of_sid", lambda sid: None)
    monkeypatch.setattr(server, "_session_owned", lambda sid: True)
    monkeypatch.setattr(server, "_session_queue_state", lambda *a, **k: "idle")
    monkeypatch.setattr(server.dshevents, "get",
                        lambda sid: {"usage": {"total": 999999}, "model": None,
                                     "inbox": []})
    monkeypatch.setattr(server.dshevents, "session_effort", lambda sid: "")
    monkeypatch.setattr(server, "_session_permission_mode", lambda st: "")


class _BoardHandler:
    """看板会话端点的最小 handler 替身（只实现被调用的三个成员）。"""

    def __init__(self):
        self.resp = []

    def _owned_project(self, pid):
        return {"id": pid, "agent_path": "dsh-plugin:/usr/bin/dsh"}

    def _board_owns_sid(self, row, sid):
        return {"id": 7, "column_key": "doing", "block_kind": None}

    def _respond(self, code, body, ctype=None):
        self.resp.append((code, json.loads(body.decode("utf-8"))))


def test_board_session_payload_carries_session_ctx(monkeypatch):
    """看板卡片会话端点：ctx 来自会话文件（used=prompt 侧 token、max=contextWindow），
    不再被 EventHub 的 usage（total 口径 + max=None）覆盖。"""
    _stub_common(monkeypatch)
    h = _BoardHandler()
    server.Handler._api_board_session_messages(h, 126, {"sid": [SID]})
    code, body = h.resp[0]
    assert code == 200
    assert body["ctx"] == WANT_CTX
    assert body["family"] == "dsh_plugin"


def test_board_session_payload_omits_ctx_without_window(monkeypatch):
    """适配器未声明窗口的会话：不下发 ctx（前端回落「暂无上下文用量数据」灰环），
    而不是发一个 `max: None` 让前端算出恒 0 的百分比。"""
    _stub_common(monkeypatch)
    sessparse.cache_clear()
    path = os.path.join(sessparse.DSH_SESSIONS, "bucket", SID, "session.v4.jsonl.zstd")
    with open(path, "wb") as f:
        f.write(zstandard.ZstdCompressor().compress(json.dumps(
            {"type": "assistant/message", "seq": 1, "time": 1,
             "data": {"message": {"content": []}, "usage": USAGE}}).encode() + b"\n"))
    h = _BoardHandler()
    server.Handler._api_board_session_messages(h, 126, {"sid": [SID]})
    assert h.resp[0][0] == 200
    assert "ctx" not in h.resp[0][1]


def test_task_session_payload_carries_session_ctx(monkeypatch):
    """任务会话端点（`_session_payload` → `_api_session_messages`）：同样下发 ctx
    ——修前该路径连 ctx 都没有，任务会话窗的圈恒 0。"""
    _stub_common(monkeypatch)
    monkeypatch.setattr(server, "effective_model", lambda tid, m: "m")
    task = {"id": 9, "session_id": SID, "model": ""}
    project = {"id": 126, "project_dir": "/tmp/x"}
    body = server.Handler._session_payload(None, task, project, "dsh_plugin", "main", 0)
    assert body["found"] is True
    assert body["ctx"] == WANT_CTX
