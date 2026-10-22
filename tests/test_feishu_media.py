# 飞书单聊截图支持（图片/图文消息 → board_media → 投递绑定会话）：入站解析 / 下载 /
# 存储 / 文案 / 失败矩阵。契约真源：
#   doc_ai/plan/202610/20261022_0837_飞书单聊截图支持（图片与图文消息转投绑定会话）.md
# 全部用例显式打桩 requests / chat.submit / rest_reply，断言零真实网络调用（仓库铁律：
# 用例绿不等于没触网——autouse 兜底桩把任何未打桩的 requests 调用记下来并抛错）。
import json
import os
import re
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import chat  # noqa: E402
import db  # noqa: E402
import feishu  # noqa: E402
import feishu_conv  # noqa: E402

db.init_db()  # 幂等；conftest 已把 TOUCHSTONE_DB 指到临时库

_CFG = {"app_id": "cli_x", "app_secret": "s"}
_FID_RE = re.compile(r"^m\d+_[0-9a-f]{10}\.[A-Za-z0-9]{1,10}$")
_MD_RE = re.compile(r"!\[飞书截图(\d+)\.([A-Za-z0-9]+)\]\(([^)]*)\)")

_PNG = b"\x89PNG\r\n\x1a\n" + b"png-body"
_JPEG = b"\xff\xd8\xff\xe0" + b"jpeg-body"
_GIF = b"GIF89a" + b"gif-body"
_WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"webp-body"


# ---------- 公共夹具 / 打桩（零真实网络） ----------

@pytest.fixture(autouse=True)
def _reset_media_state(monkeypatch):
    """每例隔离：入站去重表 / token 缓存 / 未打桩的 requests 调用一律拦下。

    yield 的列表是「真正尝试出站」的证据：零下载类用例断言它为空。
    """
    calls = []
    feishu._MSG_SEEN.clear()
    feishu._MSG_SEEN_SET.clear()
    feishu._TOKEN_CACHE.pop("cli_x", None)

    def _blocked(*a, **k):
        calls.append((a, k))
        raise RuntimeError("用例不得触真实网络（这次 requests 调用没有打桩）")

    monkeypatch.setattr(feishu.requests, "request", _blocked)
    monkeypatch.setattr(feishu.requests, "post", _blocked)
    monkeypatch.setattr(feishu.requests, "get", _blocked)
    yield calls


class _Resp:
    """requests 响应替身（状态码/字节/Content-Type/JSON 体）。"""

    _UNSET = object()

    def __init__(self, status_code=200, content=b"", content_type="image/png",
                 json_body=_UNSET):
        self.status_code = status_code
        self.content = content
        self.headers = {"Content-Type": content_type} if content_type else {}
        self._json_body = json_body

    def json(self):
        if self._json_body is _Resp._UNSET:
            raise ValueError("响应体不是 JSON")
        return self._json_body


def _prime_token():
    """预置 tenant token 缓存（避免 token 请求走到出站桩）。"""
    feishu._TOKEN_CACHE.update({"cli_x": {"token": "T", "expire": time.time() + 999}})


def _stub_http(monkeypatch, responses):
    """按顺序返回响应替身；记录每次 requests.request 的 (method, url, kwargs)。"""
    seq = list(responses)
    calls = []

    def _fake_request(method, url, **kw):
        calls.append({"method": method, "url": url, "kw": kw})
        if not seq:
            raise AssertionError("下载次数超出用例预期")
        item = seq.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    monkeypatch.setattr(feishu.requests, "request", _fake_request)
    return calls


def _stub_reply(monkeypatch):
    replies = []

    def _reply(mid, text, cfg=None):
        replies.append((mid, text))

    monkeypatch.setattr(feishu, "rest_reply", _reply)
    return replies


def _stub_delivery(monkeypatch):
    """投递链路打桩：会话存在 + baseline + chat.submit 捕获（不碰驱动/队列）。"""
    submits = []
    monkeypatch.setattr(feishu_conv.sessparse, "session_exists", lambda fam, sid: True)
    monkeypatch.setattr(feishu_conv, "_baseline_of", lambda sid: 0)
    monkeypatch.setattr(
        chat, "submit",
        lambda *a, **k: (submits.append((a, k)) or
                         {"id": "msg-media", "state": "queued", "queued": True}))
    return submits


def _mk_project(uid, name, tmp_path, work_dir=None):
    base = os.path.join(str(tmp_path), name)
    return db.insert_project(uid, name, os.path.join(base, "proj"),
                             "dsh-plugin:/x",
                             work_dir or os.path.join(base, "work"))


def _bind(uid, open_id, project_id, sid="session-media"):
    db.set_feishu_binding(open_id, uid)
    db.set_feishu_default_project(open_id, project_id)
    db.set_feishu_cur_session(open_id, project_id, sid, "会话")
    return db.get_feishu_binding_by_open(open_id)


def _evt(mid="om_media_1", message_type="image", content=None, chat_type="p2p",
         sender="ou_media_1"):
    return {"message_id": mid, "message_type": message_type,
            "content": json.dumps({} if content is None else content),
            "chat_type": chat_type, "mentions": [], "sender_open_id": sender}


def _header(n, text=""):
    return feishu.MEDIA_HEADER_FMT % n + ("" if text else feishu.MEDIA_HEADER_NOTE)


def _md_items(composed):
    """composed 里的 markdown 图片条目 → [(序号, ext, 绝对路径)]。"""
    return [(int(n), ext, path) for n, ext, path in _MD_RE.findall(composed)]


def _media_dir(project_id):
    p = db.get_project(project_id)
    return os.path.join(p["work_dir"] or
                        os.path.join(p["project_dir"], ".touchstone"),
                        "board_media")


# ---------- Task 1：常量 / 开关（§3.1、§3.8） ----------

def test_media_constants_contract():
    """§3.1 常量逐字钉死（文案/上限是双后端契约，改字即破坏对拍）。"""
    assert feishu.MEDIA_ENV == "TS_FEISHU_MEDIA"
    assert feishu.MEDIA_MAX_BYTES == 10 * 1024 * 1024
    assert feishu.MEDIA_MAX_COUNT == 9
    assert feishu.MEDIA_TYPE_HINT == "暂不支持该消息类型，请发送文字指令"
    assert feishu.MEDIA_SCOPE_HINT == (
        "截图功能需要飞书应用额外开通「获取单聊、群组消息（im:message:readonly）」"
        "权限：在「接入」卡片点「补齐配置」→「发布」，或到开发者后台「权限管理」"
        "添加该权限并发布新版本后重试。")
    assert feishu.MEDIA_FAIL_PREFIX == "截图接收失败："
    assert feishu.MEDIA_TOO_LARGE == "图片过大（单张上限 10MB），请压缩后重发"
    assert feishu.MEDIA_NO_IMAGE == "消息里没有可下载的图片"
    assert feishu.MEDIA_SAVE_FAIL_PREFIX == "截图保存失败："
    assert feishu.MEDIA_HEADER_FMT == "[飞书截图] 用户从飞书发送了 %d 张截图"
    assert feishu.MEDIA_HEADER_NOTE == "（未附文字说明）"
    assert feishu.UNBOUND_DM_MSG == (
        "尚未绑定 Touchstone 账号：登录站点 → 侧栏「设置」→ 飞书设置，"
        "生成绑定码后在这里回复「绑定 <码>」完成绑定")


def test_media_enabled_env_switch(monkeypatch):
    """TS_FEISHU_MEDIA=0 关闭本功能（缺省开、其它值按开）。"""
    monkeypatch.delenv(feishu.MEDIA_ENV, raising=False)
    assert feishu.media_enabled() is True
    monkeypatch.setenv(feishu.MEDIA_ENV, "0")
    assert feishu.media_enabled() is False
    monkeypatch.setenv(feishu.MEDIA_ENV, "1")
    assert feishu.media_enabled() is True


# ---------- Task 2：REST 二进制底层 + 下载（§3.4） ----------

def test_rest_bytes_returns_bytes_and_content_type(monkeypatch):
    """200：返回 (字节, Content-Type)；请求头只有 Bearer（资源下载不带 Content-Type）。"""
    _prime_token()
    calls = _stub_http(monkeypatch, [_Resp(200, _PNG, "image/png")])
    data, ctype = feishu._rest_bytes(
        "GET", "/open-apis/im/v1/messages/om_1/resources/img_1",
        params={"type": "image"}, cfg=_CFG)
    assert data == _PNG and ctype == "image/png"
    assert len(calls) == 1
    call = calls[0]
    assert call["method"] == "GET"
    assert call["url"] == ("https://open.feishu.cn/open-apis/im/v1/messages/"
                           "om_1/resources/img_1")
    assert call["kw"]["params"] == {"type": "image"}
    assert call["kw"]["timeout"] == 30
    assert call["kw"]["headers"] == {"Authorization": "Bearer T"}   # 无 Content-Type


def test_rest_bytes_path_normalized(monkeypatch):
    """路径规范化与 `_rest` 同款：带/不带 /open-apis 前缀都恰好拼出一层。"""
    _prime_token()
    calls = _stub_http(monkeypatch, [_Resp(200, b"x", "image/png")] * 2)
    feishu._rest_bytes("GET", "/open-apis/im/v1/messages/m/resources/k", cfg=_CFG)
    feishu._rest_bytes("GET", "im/v1/messages/m/resources/k", cfg=_CFG)
    assert [c["url"] for c in calls] == [
        "https://open.feishu.cn/open-apis/im/v1/messages/m/resources/k",
        "https://open.feishu.cn/open-apis/im/v1/messages/m/resources/k"]


def test_rest_bytes_non_2xx_json_error_has_code(monkeypatch):
    """非 2xx + JSON 错误体：FeishuRestError 带业务码（缺权限判定靠它）。"""
    _prime_token()
    _stub_http(monkeypatch, [_Resp(400, b"", "",
                                   {"code": 99991672, "msg": "no scope"})])
    with pytest.raises(feishu.FeishuRestError) as ei:
        feishu._rest_bytes("GET", "/open-apis/im/v1/messages/m/resources/k", cfg=_CFG)
    err = ei.value
    assert err.code == 99991672
    assert "code=99991672" in str(err) and "no scope" in str(err)


def test_rest_bytes_non_2xx_non_json_reports_status(monkeypatch):
    """非 2xx + 非 JSON：只给 HTTP status（契约原文 f"REST {path} status=…"）。"""
    _prime_token()
    _stub_http(monkeypatch, [_Resp(502, b"bad gateway", "")])
    with pytest.raises(feishu.FeishuRestError) as ei:
        feishu._rest_bytes("GET", "/open-apis/im/v1/messages/m/resources/k", cfg=_CFG)
    assert "REST /open-apis/im/v1/messages/m/resources/k status=502" == str(ei.value)
    assert ei.value.code is None


def test_rest_bytes_network_error_wrapped(monkeypatch):
    """网络异常包成 FeishuRestError（上层统一按 MEDIA_FAIL_PREFIX 回文案）。"""
    _prime_token()
    calls = _stub_http(monkeypatch, [OSError("connection reset")])
    with pytest.raises(feishu.FeishuRestError) as ei:
        feishu._rest_bytes("GET", "/open-apis/im/v1/messages/m/resources/k", cfg=_CFG)
    assert "失败" in str(ei.value) and "connection reset" in str(ei.value)
    assert len(calls) == 1          # 不重试


def test_rest_bytes_without_cfg_makes_no_request(monkeypatch):
    """无凭据：零请求 + 中文错误（绝不拿空凭据打真实飞书）。"""
    calls = _stub_http(monkeypatch, [])
    with pytest.raises(feishu.FeishuRestError) as ei:
        feishu._rest_bytes("GET", "/open-apis/im/v1/messages/m/resources/k", cfg=None)
    assert "未配置" in str(ei.value) and calls == []


@pytest.mark.parametrize("content_type,data,want_ctype", [
    ("image/png", _PNG, "image/png"),
    ("image/jpeg", _JPEG, "image/jpeg"),
    ("image/jpg", _JPEG, "image/jpg"),
    ("image/png; charset=utf-8", _PNG, "image/png"),      # 去参数 + 小写
    ("IMAGE/GIF", _GIF, "image/gif"),
    ("application/octet-stream", _PNG, "image/png"),      # 未知 Content-Type → 魔数嗅探
    ("", _JPEG, "image/jpeg"),
    ("", _GIF, "image/gif"),
    ("", _WEBP, "image/webp"),
    ("*/*", b"\x00\x01\x02not-an-image", "application/octet-stream"),  # 嗅探不出 → bin
])
def test_download_image_mime_normalization(monkeypatch, content_type, data, want_ctype):
    """Content-Type 归一 + 魔数嗅探 + 最终二进制兜底（§3.4）。"""
    _prime_token()
    _stub_http(monkeypatch, [_Resp(200, data, content_type)])
    out = feishu._download_image("om_1", "img_v3_x", _CFG)
    assert out["mime"] == want_ctype
    assert out["data"] == data


def test_download_image_url_quotes_and_shape(monkeypatch):
    """下载路径：/im/v1/messages/<mid>/resources/<key>?type=image，参数经 urlquote。"""
    _prime_token()
    calls = _stub_http(monkeypatch, [_Resp(200, _PNG, "image/png")])
    out = feishu._download_image("om_1", "img/v3 x", _CFG)
    assert out == {"data": _PNG, "mime": "image/png"}
    assert calls[0]["url"].endswith(
        "/open-apis/im/v1/messages/om_1/resources/img%2Fv3%20x")
    assert calls[0]["kw"]["params"] == {"type": "image"}


def test_download_image_too_large(monkeypatch):
    """字节数 > MEDIA_MAX_BYTES ⇒ 抛过大错误（上层回 MEDIA_TOO_LARGE 文案）。"""
    _prime_token()
    monkeypatch.setattr(feishu, "MEDIA_MAX_BYTES", 4)
    _stub_http(monkeypatch, [_Resp(200, b"12345", "image/png")])
    with pytest.raises(feishu.MediaTooLarge):
        feishu._download_image("om_1", "img_v3_x", _CFG)


# ---------- Task 3：内容解析 `_media_items`（§3.3） ----------

def test_media_items_image():
    text, keys = feishu._media_items(
        {"message_type": "image", "content": json.dumps({"image_key": "img_v3_a"})})
    assert (text, keys) == ("", ["img_v3_a"])
    assert feishu._media_items(
        {"message_type": "image", "content": json.dumps({})}) == ("", [])
    assert feishu._media_items(
        {"message_type": "image", "content": "not-json"}) == ("", [])


def test_media_items_post_text_and_images_ordered():
    """post：title 作首行、段落文字 \n 连接、图片按出现顺序、a 取显示文字。"""
    content = json.dumps({
        "title": "  报错截图  ",
        "content": [
            [{"tag": "text", "text": "登录报错："}],
            [{"tag": "img", "image_key": "img_v3_1"},
             {"tag": "img", "image_key": "img_v3_2"}],
            [{"tag": "a", "text": "详情链接", "href": "https://example.com/x"}],
            [{"tag": "at", "user_id": "ou_x"}, {"tag": "emotion", "emoji_type": "SMILE"}],
            [{"tag": "text", "text": "第二段"}],
        ]})
    text, keys = feishu._media_items({"message_type": "post", "content": content})
    assert text == "报错截图\n登录报错：\n详情链接\n第二段"   # 空段落不产生空行
    assert keys == ["img_v3_1", "img_v3_2"]


def test_media_items_post_locale_wrapped():
    """locale 包裹形态（zh_cn/en_us/ja_jp）按序取第一个 dict。"""
    post = {"title": "标题", "content": [[{"tag": "text", "text": "正文"}],
                                         [{"tag": "img", "image_key": "img_zh"}]]}
    content = json.dumps({"en_us": {"title": "EN", "content": []},
                          "zh_cn": post, "ja_jp": {"title": "JP", "content": []}})
    assert feishu._media_items({"message_type": "post", "content": content}) == \
        ("标题\n正文", ["img_zh"])


def test_media_items_post_pure_text_no_images():
    content = json.dumps({"title": "", "content": [[{"tag": "text", "text": "纯文字"}]]})
    assert feishu._media_items({"message_type": "post", "content": content}) == \
        ("纯文字", [])


def test_media_items_other_type_or_bad_json():
    assert feishu._media_items({"message_type": "file", "content": "{}"}) == ("", [])
    assert feishu._media_items({"message_type": "post", "content": "[]"}) == ("", [])
    assert feishu._media_items({"message_type": "post"}) == ("", [])


# ---------- Task 4：入站分支矩阵（§3.2 / §五 用例 1-11） ----------

def test_image_message_delivers_to_bound_session(monkeypatch, tmp_path, capsys):
    """用例 1：p2p + 绑定 + image（1 张）→ 下载 1 次、落 1 个 png、投递带 header+路径。"""
    uid, oid = 9_101, "ou_media_1"
    pid = _mk_project(uid, "p_media_1", tmp_path)
    binding = _bind(uid, oid, pid)
    assert binding is not None
    submits = _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    _prime_token()
    calls = _stub_http(monkeypatch, [_Resp(200, _PNG, "image/png")])

    feishu.handle_message_event(
        _evt(sender=oid, content={"image_key": "img_v3_aa"}), _CFG)

    assert len(calls) == 1 and len(submits) == 1
    assert calls[0]["url"].endswith(
        "/open-apis/im/v1/messages/om_media_1/resources/img_v3_aa")
    (args, kwargs) = submits[0]
    composed = args[2]
    assert args[0] == pid and args[1] == "session-media"
    lines = composed.split("\n")
    assert lines[0] == _header(1) + "："
    items = _md_items(composed)
    assert len(items) == 1 and items[0][0] == 1 and items[0][1] == "png"
    path = items[0][2]
    assert os.path.dirname(path) == _media_dir(pid)
    assert _FID_RE.match(os.path.basename(path))
    with open(path, "rb") as f:
        assert f.read() == _PNG                       # 文件字节 = 下载字节
    assert len(os.listdir(_media_dir(pid))) == 1
    assert replies and replies[0][1].startswith("已投递到「会话」")
    assert kwargs["extra_meta"]["feishu"]["project_id"] == pid
    # 真机核对日志（契约 §3.2）：入站一行 + 投递成功一行（stderr）
    err = capsys.readouterr().err
    assert "feishu inbound: 媒体消息 type=image images=1" in err
    assert "[feishu] 截图 1 张已存 board_media 并投递 sid=session-media（project=" in err


def test_success_path_calls_route_text_with_images_kwarg(monkeypatch, tmp_path):
    """媒体成功路径的调用形状：route_text(binding, text, cfg, images=[…])（第 4 参关键字）。"""
    uid, oid = 9_115, "ou_media_15"
    pid = _mk_project(uid, "p_media_15", tmp_path)
    _bind(uid, oid, pid)
    replies = _stub_reply(monkeypatch)
    _prime_token()
    _stub_http(monkeypatch, [_Resp(200, _PNG, "image/png")])
    seen = []
    monkeypatch.setattr(
        feishu_conv, "route_text",
        lambda binding, text, cfg=None, images=None:
        seen.append((binding["open_id"], text, cfg, images)) or "已投递到「会话」")
    feishu.handle_message_event(
        _evt(sender=oid, content={"image_key": "img_v3_x"}), _CFG)
    assert len(seen) == 1
    got_open_id, got_text, got_cfg, got_images = seen[0]
    assert got_open_id == oid and got_text == "" and got_cfg is _CFG
    assert got_images == [{"data": _PNG, "mime": "image/png"}]
    assert replies == [("om_media_1", "已投递到「会话」")]   # 回执 = route_text 返回值


def test_post_message_with_text_and_two_images(monkeypatch, tmp_path):
    """用例 2：post（文字 + 2 图）→ 文案 = 原文字 + 空行 + header + 2 条 markdown。"""
    uid, oid = 9_102, "ou_media_2"
    pid = _mk_project(uid, "p_media_2", tmp_path)
    _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    _stub_reply(monkeypatch)
    _prime_token()
    calls = _stub_http(monkeypatch, [_Resp(200, _PNG, "image/png"),
                                     _Resp(200, _JPEG, "image/jpeg")])
    content = {"title": "", "content": [
        [{"tag": "text", "text": "看这个报错"}],
        [{"tag": "img", "image_key": "img_v3_a"}],
        [{"tag": "img", "image_key": "img_v3_b"}],
    ]}
    feishu.handle_message_event(
        _evt(message_type="post", content=content, sender=oid), _CFG)

    assert len(calls) == 2
    assert "img_v3_a" in calls[0]["url"] and "img_v3_b" in calls[1]["url"]
    composed = submits[0][0][2]
    items = _md_items(composed)
    assert [(i[0], i[1]) for i in items] == [(1, "png"), (2, "jpg")]   # 顺序保持
    assert composed.startswith("看这个报错\n\n" + _header(2, "看这个报错") + "：\n")
    assert composed == ("看这个报错\n\n" + _header(2, "看这个报错") + "：\n" +
                        "![飞书截图1.png](%s)\n![飞书截图2.jpg](%s)"
                        % (items[0][2], items[1][2]))
    with open(items[1][2], "rb") as f:
        assert f.read() == _JPEG


def test_post_pure_text_routes_as_plain_text(monkeypatch, tmp_path):
    """用例 3：post 纯文字无图 → 走 route_text 纯文本路径（不下载、不落盘）。"""
    uid, oid = 9_103, "ou_media_3"
    pid = _mk_project(uid, "p_media_3", tmp_path)
    _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    calls = _stub_http(monkeypatch, [])
    content = {"title": "", "content": [[{"tag": "text", "text": "纯文字内容"}]]}
    feishu.handle_message_event(
        _evt(message_type="post", content=content, sender=oid), _CFG)

    assert calls == []                                  # 零下载
    assert submits and submits[0][0][2] == "纯文字内容"  # 与文字消息同路径
    assert not os.path.exists(_media_dir(pid))          # 不落盘
    assert replies[0][1].startswith("已投递到「会话」")


def test_unbound_user_image_gets_guidance_and_no_download(monkeypatch, tmp_path):
    """用例 4：未绑定用户发图 → UNBOUND_DM_MSG；零下载、零 submit。"""
    uid = 9_104
    _mk_project(uid, "p_media_4", tmp_path)
    submits = _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    calls = _stub_http(monkeypatch, [])                 # 有任何下载都记这里
    feishu.handle_message_event(
        _evt(sender="ou_media_unbound", content={"image_key": "img_v3_x"}), _CFG)
    assert replies == [("om_media_1", feishu.UNBOUND_DM_MSG)]
    assert calls == [] and submits == []


def test_conv_disabled_replies_old_hint(monkeypatch, tmp_path):
    """用例 5：TS_FEISHU_CONV=0 → 旧回执 MEDIA_TYPE_HINT；零下载。"""
    uid, oid = 9_105, "ou_media_5"
    pid = _mk_project(uid, "p_media_5", tmp_path)
    _bind(uid, oid, pid)
    _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    calls = _stub_http(monkeypatch, [])
    monkeypatch.setenv(feishu_conv.CONV_ENV, "0")
    feishu.handle_message_event(
        _evt(sender=oid, content={"image_key": "img_v3_x"}), _CFG)
    assert replies == [("om_media_1", feishu.MEDIA_TYPE_HINT)]
    assert calls == []


def test_media_disabled_replies_old_hint(monkeypatch, tmp_path):
    """用例 6：TS_FEISHU_MEDIA=0 → 旧回执 MEDIA_TYPE_HINT；零下载。"""
    uid, oid = 9_106, "ou_media_6"
    pid = _mk_project(uid, "p_media_6", tmp_path)
    _bind(uid, oid, pid)
    _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    calls = _stub_http(monkeypatch, [])
    monkeypatch.setenv(feishu.MEDIA_ENV, "0")
    feishu.handle_message_event(
        _evt(sender=oid, content={"image_key": "img_v3_x"}), _CFG)
    assert replies == [("om_media_1", feishu.MEDIA_TYPE_HINT)]
    assert calls == []


def test_group_media_message_is_silent(monkeypatch, tmp_path):
    """用例 7：群聊 @机器人 发图 → 静默（零回复、零下载；保持旧行为）。"""
    uid, oid = 9_107, "ou_media_7"
    pid = _mk_project(uid, "p_media_7", tmp_path)
    _bind(uid, oid, pid)
    _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    calls = _stub_http(monkeypatch, [])
    monkeypatch.setattr(feishu, "bot_open_id", lambda cfg=None: "ou_bot")
    evt = _evt(sender=oid, chat_type="group", content={"image_key": "img_v3_x"})
    evt["mentions"] = [{"key": "@_user_1", "open_id": "ou_bot"}]
    feishu.handle_message_event(evt, _CFG)
    assert replies == [] and calls == []


def test_missing_scope_replies_scope_hint(monkeypatch, tmp_path):
    """用例 8：下载抛缺权限码（99991672）→ MEDIA_SCOPE_HINT；零 submit、零落盘。"""
    uid, oid = 9_108, "ou_media_8"
    pid = _mk_project(uid, "p_media_8", tmp_path)
    _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    _prime_token()
    _stub_http(monkeypatch, [_Resp(403, b"", "",
                                   {"code": 99991672, "msg": "no scope"})])
    feishu.handle_message_event(
        _evt(sender=oid, content={"image_key": "img_v3_x"}), _CFG)
    assert replies == [("om_media_1", feishu.MEDIA_SCOPE_HINT)]
    assert submits == []
    assert not os.path.exists(_media_dir(pid))          # 全有或全无：一张都不存


def test_other_download_error_replies_fail_prefix(monkeypatch, tmp_path):
    """用例 9：其它 REST 错误 / 网络异常 → MEDIA_FAIL_PREFIX + 原因；零 submit。"""
    uid, oid = 9_109, "ou_media_9"
    pid = _mk_project(uid, "p_media_9", tmp_path)
    _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    _prime_token()
    # 第 1 张正常、第 2 张网络异常 ⇒ 全有或全无：一张都不投递
    _stub_http(monkeypatch, [_Resp(200, _PNG, "image/png"),
                             OSError("connection reset")])
    content = {"title": "", "content": [
        [{"tag": "img", "image_key": "img_v3_a"}],
        [{"tag": "img", "image_key": "img_v3_b"}]]}
    feishu.handle_message_event(
        _evt(message_type="post", content=content, sender=oid), _CFG)
    assert len(replies) == 1
    assert replies[0][1].startswith(feishu.MEDIA_FAIL_PREFIX)
    assert "connection reset" in replies[0][1]
    assert submits == []
    assert not os.path.exists(_media_dir(pid))


def test_other_rest_error_code_replies_fail_prefix(monkeypatch, tmp_path):
    """用例 9b：非权限类 FeishuRestError（如 token 无效）→ 同 MEDIA_FAIL_PREFIX。"""
    uid, oid = 9_110, "ou_media_10"
    pid = _mk_project(uid, "p_media_10", tmp_path)
    _bind(uid, oid, pid)
    _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    _prime_token()
    _stub_http(monkeypatch, [_Resp(400, b"", "",
                                   {"code": 99991663, "msg": "token 无效"})])
    feishu.handle_message_event(
        _evt(sender=oid, content={"image_key": "img_v3_x"}), _CFG)
    assert replies[0][1].startswith(feishu.MEDIA_FAIL_PREFIX)
    assert "token 无效" in replies[0][1]


def test_too_large_replies_too_large_hint(monkeypatch, tmp_path):
    """用例 10：下载字节 > 上限 → 过大文案；零 submit。"""
    uid, oid = 9_111, "ou_media_11"
    pid = _mk_project(uid, "p_media_11", tmp_path)
    _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    _prime_token()
    monkeypatch.setattr(feishu, "MEDIA_MAX_BYTES", 8)
    _stub_http(monkeypatch, [_Resp(200, b"0123456789", "image/png")])
    feishu.handle_message_event(
        _evt(sender=oid, content={"image_key": "img_v3_x"}), _CFG)
    assert replies[0][1] == feishu.MEDIA_FAIL_PREFIX + feishu.MEDIA_TOO_LARGE
    assert submits == []


def test_post_over_nine_images_truncated(monkeypatch, tmp_path):
    """用例 11：post 含 12 张图 → 只下载/投递前 9 张（多余静默丢弃）。"""
    uid, oid = 9_112, "ou_media_12"
    pid = _mk_project(uid, "p_media_12", tmp_path)
    _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    _stub_reply(monkeypatch)
    _prime_token()
    calls = _stub_http(monkeypatch, [_Resp(200, _PNG, "image/png")] * 9)
    content = {"title": "", "content": [
        [{"tag": "img", "image_key": f"img_v3_{i:02d}"}] for i in range(12)]}
    feishu.handle_message_event(
        _evt(message_type="post", content=content, sender=oid), _CFG)
    assert len(calls) == 9                              # 只下前 9 张
    composed = submits[0][0][2]
    assert len(_md_items(composed)) == 9
    assert composed.split("\n")[0] == _header(9) + "："
    assert not any("img_v3_09" in c["url"] for c in calls)


def test_media_message_without_image_key_replies_no_image(monkeypatch, tmp_path):
    """image 消息 content 无 image_key：MEDIA_FAIL_PREFIX + MEDIA_NO_IMAGE。"""
    uid, oid = 9_113, "ou_media_13"
    pid = _mk_project(uid, "p_media_13", tmp_path)
    _bind(uid, oid, pid)
    _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    calls = _stub_http(monkeypatch, [])
    feishu.handle_message_event(_evt(sender=oid), _CFG)     # content={}
    assert replies == [("om_media_1", feishu.MEDIA_FAIL_PREFIX + feishu.MEDIA_NO_IMAGE)]
    assert calls == []


def test_other_message_type_keeps_old_hint(monkeypatch, tmp_path):
    """其它类型（file/audio/…）不在本批范围：仍回旧文案（§3.2 步骤 2）。"""
    uid, oid = 9_114, "ou_media_14"
    pid = _mk_project(uid, "p_media_14", tmp_path)
    _bind(uid, oid, pid)
    _stub_delivery(monkeypatch)
    replies = _stub_reply(monkeypatch)
    calls = _stub_http(monkeypatch, [])
    feishu.handle_message_event(
        _evt(message_type="file", content={"file_key": "f_1"}, sender=oid), _CFG)
    assert replies == [("om_media_1", feishu.MEDIA_TYPE_HINT)]
    assert calls == []


# ---------- Task 5：route_text 存图与文案（§3.5 / §3.6，用例 12-14） ----------

def test_route_text_stores_images_and_composes(monkeypatch, tmp_path):
    """用例 12：直接 route_text(images=…) → fid 正则通过 + 文案逐字 + 回执不变。"""
    uid, oid = 9_201, "ou_media_rt1"
    pid = _mk_project(uid, "p_rt_1", tmp_path)
    binding = _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    calls = _stub_http(monkeypatch, [])                 # 不应有下载（图已由入站下好）
    reply = feishu_conv.route_text(
        binding, "看这个", None,
        images=[{"data": _PNG, "mime": "image/png"}])

    assert calls == []
    assert reply == "已投递到「会话」（排队中），跑完把答复发回这里"
    assert len(submits) == 1
    args, kwargs = submits[0]
    composed = args[2]
    assert composed.startswith("看这个\n\n" + _header(1, "看这个") + "：\n")
    items = _md_items(composed)
    assert len(items) == 1 and items[0][1] == "png"
    path = items[0][2]
    assert os.path.isabs(path)
    assert os.path.dirname(path) == _media_dir(pid)
    assert _FID_RE.match(os.path.basename(path))
    with open(path, "rb") as f:
        assert f.read() == _PNG
    assert kwargs["extra_meta"]["feishu"]["open_id"] == oid
    assert kwargs["extra_meta"]["feishu"]["baseline"] == 0


def test_route_text_no_project_does_not_store(monkeypatch, tmp_path):
    """用例 13：route_text(images=…) 且无默认项目 → 引导文案、不落盘、不 submit。"""
    uid, oid = 9_202, "ou_media_rt2"
    p1 = _mk_project(uid, "p_rt_2a", tmp_path)
    p2 = _mk_project(uid, "p_rt_2b", tmp_path)
    db.set_feishu_binding(oid, uid)                     # 不设默认项目 ⇒ 多项目歧义
    binding = db.get_feishu_binding_by_open(oid)
    submits = _stub_delivery(monkeypatch)
    reply = feishu_conv.route_text(
        binding, "", None, images=[{"data": _PNG, "mime": "image/png"}])
    assert reply.startswith(feishu_conv.NO_DEFAULT_GUIDE)
    assert submits == []
    for pid in (p1, p2):
        assert not os.path.exists(_media_dir(pid))      # 无项目不落盘（无孤儿文件）


def test_route_text_save_failure_returns_error_and_no_submit(monkeypatch, tmp_path):
    """用例 14：存盘 OSError → MEDIA_SAVE_FAIL_PREFIX…；不投递。"""
    uid, oid = 9_203, "ou_media_rt3"
    blocker = os.path.join(str(tmp_path), "not_a_dir")
    with open(blocker, "w") as f:
        f.write("x")                                    # work_dir 是文件 ⇒ makedirs 失败
    pid = _mk_project(uid, "p_rt_3", tmp_path, work_dir=blocker)
    binding = _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    reply = feishu_conv.route_text(
        binding, "看这个", None, images=[{"data": _PNG, "mime": "image/png"}])
    assert reply.startswith(feishu.MEDIA_SAVE_FAIL_PREFIX)
    assert submits == []


def test_route_text_without_images_is_unchanged(monkeypatch, tmp_path):
    """用例 15：images=None（全部存量调用点）→ 纯文本路径一个字节不变。"""
    uid, oid = 9_204, "ou_media_rt4"
    pid = _mk_project(uid, "p_rt_4", tmp_path)
    binding = _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    reply = feishu_conv.route_text(binding, "帮我看看登录")
    assert submits[0][0][2] == "帮我看看登录"
    assert len(submits[0][0]) == 3                      # (pid, sid, text) 位置参数不变
    assert reply == "已投递到「会话」（排队中），跑完把答复发回这里"
    assert not os.path.exists(_media_dir(pid))


def test_route_text_image_ext_follows_mime(monkeypatch, tmp_path):
    """ext 由 mime 映射（jpg/webp/gif/未知→bin）；展示名序号 1 起。"""
    uid, oid = 9_205, "ou_media_rt5"
    pid = _mk_project(uid, "p_rt_5", tmp_path)
    binding = _bind(uid, oid, pid)
    submits = _stub_delivery(monkeypatch)
    feishu_conv.route_text(binding, "", None, images=[
        {"data": _JPEG, "mime": "image/jpeg"},
        {"data": _WEBP, "mime": "image/webp"},
        {"data": _GIF, "mime": "image/gif"},
        {"data": b"\x00\x01", "mime": "application/octet-stream"},
    ])
    composed = submits[0][0][2]
    items = _md_items(composed)
    assert [(i[0], i[1]) for i in items] == [(1, "jpg"), (2, "webp"),
                                             (3, "gif"), (4, "bin")]
    assert composed.split("\n")[0] == _header(4) + "："     # 无文字 ⇒ 追加说明
    assert len(os.listdir(_media_dir(pid))) == 4
    for _, _, path in items:
        assert os.path.exists(path) and _FID_RE.match(os.path.basename(path))
