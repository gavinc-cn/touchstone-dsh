#!/usr/bin/env python3
"""Touchstone session 解析层：定位并解析 dsh（deepseek harness）会话存储，
统一输出 entry 模型供 session 对话窗口渲染（前端无需感知存储差异）。

存储位置（只读访问）：
- dsh: ~/.dsh/sessions/<工作区bucket>/<会话目录>/session[.v<N>].jsonl.zstd
       （多帧 zstd 拼接的 JSONL 事件流，zstandard 解压；目录名两代并存
       `session-<uuid>` / 裸 `<uuid>`，文件名带格式版本，见 _dsh_session_file）

**P7b B5 单族化**：kimi / claude / opencode / hermes 四族的解析器已随族退场删除
（族入口收敛见 agents.py），遗留解析族名 `deepseek` 一并改名 `dsh`。`family`
参数保留为白名单校验（值恒为 `dsh`），退场族传入即被拒。

统一 entry 模型（seq 自 0 递增，kind 字段区分类型）：
  user        {text, images:[{media}], mid, eseq}  mid/eseq 为 dsh 回退（fork）锚点
  assistant   {text}
  think       {text}
  tool_call   {name, args, call_id}
  tool_result {call_id, name, text, is_error, truncated}
（dsh 事件流没有 usage 汇总事件与「本轮失败」独立通道，故不产出 usage / error 条目；
响应里的 totals 字段保留为 0，维持 API 形状稳定。）
"""

import base64
import glob
import json
import os
import re
import threading

import zstandard

import dshdriver

# dsh 会话存储根（~ 经 expanduser 映射 %USERPROFILE%，Windows 语义成立）。
DSH_SESSIONS = os.path.expanduser("~/.dsh/sessions")

# session id / media id 白名单（防路径穿越）
# dsh 会话 id 为 session-<uuid>（新）或裸 <uuid>（早期/桌面端；目录名即 id，
# 本机实测 64655aea-… 属此形态）
SID_DSH_RE = re.compile(r"^(?:session-)?[0-9a-fA-F-]{8,36}$")
# dsh 附件 id（宿主 attachment 服务的不透明存储 id；平台只用它向驱动要字节）
MEDIA_DSH_RE = re.compile(r"^sha256:[a-f0-9]{64}$")

ARGS_MAX = 2000    # tool_call args JSON 截断长度
OUT_MAX = 4000     # tool_result 输出截断长度

# 可解析的会话族白名单（P7b B5 单族化：只剩 dsh，退场族传入即被拒）。
FAMILIES = ("dsh",)

# 解析缓存：{(sid, agent): {"stamp": ..., "entries": [...], "totals": {...}}}
# stamp 为底层 zstd 文件的 (mtime_ns, size)，变化才重解析
_CACHE = {}


def _trunc(text, limit):
    """超长文本截断（返回截断后的文本）。"""
    return text[:limit] if len(text) > limit else text


def _obj(raw):
    """JSON 文本 → dict 或 None（非法 JSON / 非对象一律 None）。

    JSONL 行容错统一入口：会话存储里可能出现合法 JSON 但非对象的行
    （数字/字符串/数组），直接 .get() 会抛 AttributeError 炸掉整次解析。
    """
    try:
        d = json.loads(raw)
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


class _Entries:
    """entry 收集器：自动分配 seq 并累计 totals。"""

    def __init__(self):
        self.entries = []
        # token/耗时汇总（API 契约字段）：dsh 事件流无 usage 事件，恒为 0
        self.totals = {"input": 0, "output": 0, "cache_read": 0, "duration_ms": 0}
        # dsh 回退锚点（仅 _parse_dsh 填充）：[(mid, ese)，...] —— 真实用户提问的
        # 合成 mid 与**会话事件 seq**；dsh 没有原地 undo，回退＝按该 seq fork 新会话
        self.dsh_anchors = []

    def add(self, kind, time_ms=0, **kw):
        self.entries.append({"seq": len(self.entries), "kind": kind,
                             "time": int(time_ms or 0), **kw})


# ---------------------------------------------------------------- dsh 解析

# dsh 会话文件为多帧 zstd 拼接（每帧一批 JSONL 事件行），逐帧 `decompressobj` 解压
# （项目唯一第三方依赖，见 requirements.txt）。
#
# **解压器必须按线程隔离**（2026-10-09 定因的 SIGSEGV 实障）：zstandard 的
# `ZstdDecompressor` **实例并发调用 `decompressobj()` 不是线程安全的**——原先这里
# 是模块级共享实例，而站点是多线程的（HTTP 请求线程池 + board 30s 调度线程 +
# 会话窗读口），并发解压直接 **SIGSEGV 打崩整个后端**（面板 502，薄壳不自愈）。
# 实测对照（8 线程 × 25s 反复解压真实会话文件）：共享实例 **core dumped**；
# 每线程独立实例同负载 765 次解压**零崩溃**。崩溃现场见
# `doc_ai/bug_report/20261009_0600_插件后端两次SIGSEGV…`（faulthandler 栈落在
# `server.py:_api_get_board` 的 `session_title` 调用行，扩展模块清单只有
# `zstandard.backend_c`）。
_DEC_TLS = threading.local()


def _dec():
    """取**本线程**的 zstd 解压器（无则新建并缓存，随线程回收）。

    不要改回模块级共享实例——那正是 SIGSEGV 的根因（见上方注释）。
    """
    d = getattr(_DEC_TLS, "d", None)
    if d is None:
        d = _DEC_TLS.d = zstandard.ZstdDecompressor()
    return d


def _dsh_decompressed(path):
    """解压 dsh 会话文件（多帧 zstd），返回拼接的 JSONL 文本；完全不可读返回 ''。

    容错（P7b B5 顺带修，真机实测：3206 条的会话尾部多 21 字节垃圾 → 整段解析 0 条）：
    dsh 边写边追加帧，读侧可能撞上「末帧写了一半」；尾部半截帧/损坏字节**不应让整段
    历史消失**。实现为**逐帧解压**（`decompressobj` 每次只吃一帧，余量在 `unused_data`），
    遇 ZstdError 即停并保留已解出的前序帧；半截帧内的字节随坏帧一起丢（不patch拼接），
    最后一行若是半截 JSON 由 `_obj` 容错跳过。

    注：不能用 `stream_reader(read_across_frames=True).read(n)` 做同样的事——它按块
    预读，尾部坏字节会在首次 read 就抛错，连完整的前序帧一起丢（实测 1MB/4KB 块均 0 字节）。
    完全非 zstd / 0 帧 / 首帧即坏仍返回 ''。
    """
    try:
        with open(path, "rb") as f:
            buf = f.read()
    except OSError:
        return ""
    chunks = []
    rest = buf
    while rest:
        obj = _dec().decompressobj()
        try:
            chunks.append(obj.decompress(rest))
        except zstandard.ZstdError:
            break                      # 坏帧：保留此前解出的帧
        nxt = obj.unused_data
        if not nxt or len(nxt) >= len(rest):
            break                      # 无剩余 / 无进展（防死循环）
        rest = nxt
    return b"".join(chunks).decode("utf-8", errors="replace")


def _dsh_pick_file(sdir):
    """在一个会话目录里挑事件流文件：`session*.jsonl.zstd` 中版本号最大者，无则 None。"""
    hits = []
    for path in glob.glob(os.path.join(sdir, "session*.jsonl.zstd")):
        hits.append((_dsh_format_version(path), path))
    return max(hits)[1] if hits else None


def _dsh_session_file(sid):
    """按会话 id 跨工作区 bucket 定位 zstd 会话文件（返回路径或 None）。

    id 形态两代并存（本机实测 2026-10-02）：`session-<uuid>`（dsh web/headless 新建）
    与裸 `<uuid>`（**绝大多数是子代理会话**，少数是老主会话，如 64655aea-…；
    2026-10-07 实测 82 个裸 uuid 目录里 73 个 origin=subagent、9 个主会话）。
    文件名也带格式版本：`session.v4.jsonl.zstd`（62 个）/ `session.v3.jsonl.zstd`（1 个）
    / 无版本的 `session.jsonl.zstd`（9 个存量）——**只认无版本名会让 v3/v4 会话全部
    found=false**（真机踩中），故按 `session*.jsonl.zstd` 通配并优先取版本号最大者。
    """
    if not SID_DSH_RE.match(sid or ""):
        return None
    hits = []
    for path in glob.glob(os.path.join(DSH_SESSIONS, "*", sid, "session*.jsonl.zstd")):
        hits.append((_dsh_format_version(path), path))
    if not hits:
        return None
    return max(hits)[1]          # 版本号大者优先（同目录一般只有一个）


def _dsh_format_version(path):
    """从会话文件名解析格式版本（无版本号记 0，保证「有版本 > 无版本」）。"""
    m = re.search(r"session\.v(\d+)\.jsonl\.zstd$", os.path.basename(path))
    return int(m.group(1)) if m else 0


# dsh 会话**头行**缓存：{path: (stamp, header)}。头行承载 origin/delegationDepth/cwd，
# 是判「子代理会话」的唯一可靠依据（目录名不是判据，见 is_subagent）。
_DSH_HEADER_CACHE = {}
_DSH_HEADER_FRAMES = 4      # 头行最多向前找几帧（真机 304 个会话全在第 1 帧第 1 行）


def _dsh_header(path):
    """读 dsh 会话**头行**（`{"type":"session","id":…,"origin":…,"delegationDepth":…}`），
    读不到/无头行返回 {}（老样本与异常一律降级为空）。

    只解前 `_DSH_HEADER_FRAMES` 帧即停（头行就是第 1 帧第 1 行，实测 278 字节）——
    与 `_dsh_decompressed` 的全量解压相比，判一个会话是不是子代理不该付整段解压的
    代价（枚举 300+ 会话时差一个量级）。按 (mtime_ns, size) 缓存：会话只追加，
    stamp 变即失效重读。
    """
    try:
        st = os.stat(path)
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    hit = _DSH_HEADER_CACHE.get(path)
    if hit and hit[0] == stamp:
        return hit[1]
    header = {}
    try:
        with open(path, "rb") as f:
            rest = f.read()
    except OSError:
        return {}
    for _ in range(_DSH_HEADER_FRAMES):
        if not rest:
            break
        obj = _dec().decompressobj()
        try:
            text = obj.decompress(rest).decode("utf-8", "replace")
        except zstandard.ZstdError:
            break                       # 坏帧：头行读不到就按「未知」（=主会话）
        rest = obj.unused_data          # 余量即下一帧（逐帧解压，同 _dsh_decompressed）
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            d = _obj(line)
            if d is not None and d.get("type") == "session":
                header = d
                break
        if header:
            break
    _DSH_HEADER_CACHE[path] = (stamp, header)
    return header


def _header_subagent(header):
    """头行 → 是否子代理会话：`origin=subagent` 为主判据，`delegationDepth>0` 兜底。

    2026-10-07 全机实测 304 个会话目录：73 个 `origin=subagent`（且 delegationDepth
    全为 1）、231 个主会话（origin 字段缺失、delegationDepth 全为 0），两集合严格互斥。
    两个判据都留，是防 dsh 后续只写其一。
    """
    if str(header.get("origin") or "") == "subagent":
        return True
    try:
        return int(header.get("delegationDepth") or 0) > 0
    except (TypeError, ValueError):
        return False


def is_subagent(family, sid):
    """该会话是否 dsh **子代理会话**（主会话派生的调研/审计子代理，非用户会话）。

    子代理会话与主会话同 bucket、同格式，只能靠头行区分（见 `_header_subagent`；
    **目录名不是判据**——裸 uuid 目录 82 个里 73 个是子代理，另 9 个是老主会话）。
    子代理是主会话的实现细节：不建看板卡、不进「绑定已有会话」下拉、不按「外部会话
    在跑」占项目运行位（看板 sync 投影 / server 绑定下拉 / board 占用三处共用本读口）。

    族不在白名单 / 存储不存在 / 头行缺失一律 False（未知按主会话处理——占用判定
    宁多等不可误放行，与 `dshevents` 的「断连=未知」同向）。
    """
    if family not in FAMILIES:
        return False
    try:
        path = _dsh_session_file(sid)
    except Exception:
        return False
    return _header_subagent(_dsh_header(path)) if path else False


def dsh_bucket(cwd):
    """工作区路径 → dsh 会话 bucket 目录。

    实测命名（~/.dsh/sessions 下）：路径斜杠换 '-'，首尾各补 '-'，
    如 /srv/myproj → --srv-myproj--。
    """
    return os.path.join(DSH_SESSIONS,
                        "-" + (cwd or "").rstrip("/").replace("/", "-") + "--")


def dsh_latest_session(cwd):
    """取工作区 bucket 下最新的会话 id。

    dsh headless 形态不输出 session id（每轮独立会话），轮后按此启发式关联本任务
    的会话（仅供 session 窗口查看历史，非续会话）。
    ⚠️ dsh_plugin 族**不用**本函数：插件在轮次开始即精确回执 sid（见
    runner._run_round_dshplugin），mtime 启发式只服务无 sid 回执的 headless 形态。
    目录名两代并存（session-<uuid> / 裸 <uuid>），故按 `*` 通配 + 事件流文件判存在。
    """
    best, best_mt = "", 0.0
    for d in glob.glob(os.path.join(dsh_bucket(cwd), "*")):
        zfile = _dsh_pick_file(d)
        if not zfile:
            continue
        try:
            mt = os.path.getmtime(zfile)
        except OSError:
            continue
        if mt > best_mt:
            best, best_mt = os.path.basename(d), mt
    return best


# path -> (stamp, title, first_prompt, titles)：当前标题、首问与全部标题事件同源
# 同缓存——三者都要全量解压会话文件，一次扫描一起取（30s 同步节拍里同一文件只解压
# 一次）
_DSH_TITLE_CACHE = {}


def _line_at(text, idx):
    """取 text 中 idx 所在的那一行（不含换行符）。

    find 定位 + 切一行，避免为找一处事件把上千行文本 split 成全量列表再 Python
    逐行循环（会话动辄上千行，标题与首问都在文件开头附近）。
    """
    start = text.rfind("\n", 0, idx) + 1
    end = text.find("\n", idx)
    return text[start:] if end < 0 else text[start:end]


def _dsh_scan_titles(text):
    """全部 `session/title` 事件的标题，按文件顺序（无事件返回 []）。

    **末枚即 DSH 当前标题**（dsh 对同一会话会写多枚：先 fallback 截断句、再由 LLM
    标题覆盖、用户显式改名再追加；GUI 侧栏显示 last-wins 的那一枚）。平台侧一律
    取同一口径（会话窗 / 任务标题 / 看板 sync 卡标题）；`list_sessions` 另把整串
    下发给看板，用于判定「卡面标题是否仍是平台自动写入的形态」。

    逐次 find + **整行 JSON 校验**（同 `_dsh_scan_prompt`）：非事件行里出现同名
    字符串（坏行 / 别处文本）一律跳过；空标题事件跳过（dsh 不会写空标题，真出现
    时按「不表态」处理，避免把当前标题抹成空串）。
    """
    out = []
    pos = 0
    while True:
        idx = text.find('"session/title"', pos)
        if idx < 0:
            return out
        pos = idx + 1
        d = _obj(_line_at(text, idx))
        if d is None or d.get("type") != "session/title":
            continue
        title = str((d.get("data") or {}).get("title") or "")
        if title:
            out.append(title)


def _dsh_scan_prompt(text):
    """主会话第一条真实用户提问的原文（可多行；无返回 ''）。

    判定与会话窗口的 user entry 同口径：`user/message` 且 `source.kind == "user"`
    （系统注入的 plugin / agent-instructions 消息被过滤）；文本块按换行拼接、
    **原样保留内部换行**——调用方（看板同步卡）直接作为卡描述（首问全文）。
    只有图片没有文本的提问返回 `[图片]`（沿用会话窗的图片占位口径）。

    「第一条」按**文件顺序**取（会话窗的展示顺序；真机 20 个会话核对：文件序首条
    与 seq 最小那条一致）。
    """
    pos = 0
    while True:
        idx = text.find('"user/message"', pos)
        if idx < 0:
            return ""
        pos = idx + 1
        d = _obj(_line_at(text, idx))
        if d is None or d.get("type") != "user/message":
            continue            # 别的行里出现同名字符串（工具输出等）：跳过
        data = d.get("data") or {}
        if (data.get("source") or {}).get("kind", "") != "user":
            continue            # 系统注入消息：不是用户提问
        blocks = [b for b in (data.get("content") or []) if isinstance(b, dict)]
        texts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
        body = "\n".join(t for t in texts if t).strip()
        if body:
            return body
        if any(b.get("type") == "image" for b in blocks):
            return "[图片]"
        continue                # 既无文本也无图片：不是有效提问


def _dsh_meta(path):
    """一次解压取出 (当前标题, 主会话首问原文, 全部标题事件)，按文件 stamp 缓存。

    - 当前标题 = `titles` 的**末枚**（`session/title` 事件 last-wins）= dsh GUI 侧栏
      显示的标题（口径说明见 `_dsh_scan_titles`）；
    - 首问 = 见 `_dsh_scan_prompt`，是看板 sync 卡描述（首问全文）的数据源；
    - 全部标题事件（tuple）= 该会话历史上出现过的每个标题，看板 sync 卡据此判定
      「卡面标题是否仍是平台自动写入的形态」（建卡时只有兜底标题、LLM 标题后到的
      窗口里，旧的兜底标题只存在于事件历史中）。
    """
    try:
        st = os.stat(path)
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return "", "", ()
    hit = _DSH_TITLE_CACHE.get(path)
    if hit and hit[0] == stamp:
        return hit[1], hit[2], hit[3]
    text = _dsh_decompressed(path)
    titles = tuple(_dsh_scan_titles(text))
    title = titles[-1] if titles else ""
    prompt = _dsh_scan_prompt(text)
    _DSH_TITLE_CACHE[path] = (stamp, title, prompt, titles)
    return title, prompt, titles


def dsh_title(sid):
    """读取 dsh 会话当前标题（最后一枚 session/title 事件），无/不可读返回 ''。"""
    path = _dsh_session_file(sid)
    return _dsh_meta(path)[0] if path else ""


def dsh_first_prompt(sid):
    """读取主会话第一条真实用户提问的原文（可多行），无/不可读返回 ''。

    看板 sync 卡的描述数据源（见 board.sync_sessions）：会话还没收到提问时
    返回 ''，调用方按会话标题 / sid 短码兜底，首问落盘后由同步节拍补齐。
    """
    path = _dsh_session_file(sid)
    return _dsh_meta(path)[1] if path else ""


def _parse_dsh(path):
    """解析 dsh 会话（解压后的 JSONL 事件流）。

    关注事件（本机实测）：user/message（仅 source.kind=user 的真实输入，
    过滤 plugin/agent-instructions 等系统注入）、assistant/message（content 块
    reasoning/text）、tool/call（name/arguments/callId）、tool/result（content[]
    的 tool-result 块 text 拼接）。无 usage 事件，totals 记 0。
    """
    col = _Entries()
    tool_names = {}  # callId -> 工具名（回填 tool_result）
    for line in _dsh_decompressed(path).split("\n"):
        line = line.strip()
        if not line:
            continue
        d = _obj(line)
        if d is None:
            continue
        t = d.get("type")
        tm = int(d.get("time") or 0)
        data = d.get("data") or {}
        if t == "user/message":
            if (data.get("source") or {}).get("kind", "") != "user":
                continue
            texts, images = [], []
            for b in (data.get("content") or []):
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text":
                    texts.append(b.get("text", ""))
                elif b.get("type") == "image":
                    # 图片附件：只记 attachmentId（字节由宿主 attachment 服务持有，
                    # 平台经驱动 `/media` 端点取）；前端按 {"media": id} 渲染缩略图
                    aid = str(((b.get("attachment") or {}).get("attachmentId")) or "")
                    if aid:
                        images.append({"media": aid})
            text = "\n".join(x for x in texts if x).strip()
            if text or images:
                # ese=会话事件 seq（dsh 每条事件自带单调 seq），mid 用 `e<ese>` 合成：
                # 会话窗的「回退」按钮需要 mid 才显示，回退时再用 mid 换算 fork 边界
                ese = int(d.get("seq") or 0)
                mid = f"e{ese}"
                col.dsh_anchors.append((mid, ese, text or "[图片]"))
                col.add("user", tm, text=text, images=images, mid=mid, eseq=ese)
        elif t == "assistant/message":
            for b in ((data.get("message") or {}).get("content") or []):
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "reasoning":
                    col.add("think", tm, text=b.get("text", ""))
                elif b.get("type") == "text":
                    col.add("assistant", tm, text=b.get("text", ""))
        elif t == "tool/call":
            cid = data.get("callId", "")
            tool_names[cid] = data.get("name", "")
            col.add("tool_call", tm, name=data.get("name", ""),
                    args=_trunc(data.get("arguments", "") or "", ARGS_MAX),
                    call_id=cid)
        elif t == "tool/result":
            msg = data.get("message") or {}
            cid = (msg.get("source") or {}).get("callId", "") or msg.get("toolCallId", "")
            texts = []
            for b in (msg.get("content") or []):
                if not isinstance(b, dict):
                    continue
                # v4 实况：message.content 直接是 [{type:"text",text:…}]（真机样本核对）；
                # 另兼容早期/迁移形态：再嵌一层 {type:"tool-result",content:[{text}]}
                if b.get("type") == "text":
                    texts.append(b.get("text", ""))
                elif b.get("type") == "tool-result":
                    cid = cid or b.get("toolCallId", "")
                    for c in (b.get("content") or []):
                        if isinstance(c, dict) and c.get("type") == "text":
                            texts.append(c.get("text", ""))
            out = "\n".join(x for x in texts if x)
            col.add("tool_result", tm, call_id=cid, name=tool_names.get(cid, ""),
                    text=_trunc(out, OUT_MAX), is_error=bool(msg.get("isError")),
                    truncated=len(out) > OUT_MAX)
    return col


# ------------------------------------------------ 回退边界 / 运行中会话探测

def dsh_fork_boundary(sid, mid):
    """把「回退到某条提问之前」换算成宿主 `session.fork` 的 `atSeq`（P5）。

    dsh **没有原地 undo**：等价实现是把该提问**之前**的历史复制成新会话
    （新会话不含该提问及其后内容）。`atSeq` 是 inclusive 的，故取该提问事件 seq 的
    **前一个**（`max(0, ese - 1)`）——fork 出来的新会话正好停在提问之前。

    返回值：`(boundary_seq, new_hint)`；提问不在会话里/会话不可读/mid 为空 → None。
    """
    if not mid:
        return None
    path = _dsh_session_file(sid)
    if path is None:
        return None
    try:
        col = _parse_dsh(path)
    except (OSError, ValueError):
        return None
    for anchor_mid, ese, _text in col.dsh_anchors:
        if anchor_mid == mid:
            return max(0, int(ese) - 1)
    return None


def dsh_user_anchors(sid):
    """该 dsh 会话的真实用户提问锚点 `[{mid, eseq, text}]`（测试与诊断用）。"""
    path = _dsh_session_file(sid)
    if path is None:
        return []
    try:
        col = _parse_dsh(path)
    except (OSError, ValueError):
        return []
    return [{"mid": m, "eseq": e, "text": t} for m, e, t in col.dsh_anchors]


def _live_dsh(cwd, since):
    """dsh 运行中探测：工作区 bucket 下 mtime 晚于 since 的最新会话目录。

    沿用 dsh_latest_session 的启发式（dsh headless 每轮独立会话、无精确关联）；
    mtime 取事件流文件（目录 mtime 不随写入变化，且文件名带格式版本）。
    dsh_plugin 族不走本路径（插件内存态可精确回答，见 server._dsh_live_sid）。
    """
    best, best_mt = "", 0.0
    for d in glob.glob(os.path.join(dsh_bucket(cwd), "*")):
        zfile = _dsh_pick_file(d)
        if not zfile:
            continue
        try:
            mt = os.path.getmtime(zfile)
        except OSError:
            continue
        if mt > since and mt > best_mt:
            best, best_mt = os.path.basename(d), mt
    return best


def live_session_id(family, cwd, since):
    """运行中会话探测：任务的 session_id 尚未入库（resume_hint 要到轮次结束才
    写进日志）时，按「工作区匹配 + 活动时间晚于 since」猜出正在写的会话 id，
    供 session 窗口在任务运行期间实时展示对话。

    结果只用于展示，绝不写回任务行——真实 sid 以轮后 resume_hint 为准，探测错了
    不影响续轮；真实 sid 入库后本函数即不再被调用。dsh_plugin 族正常不走本路径
    （插件内存态可精确回答，见 server._dsh_live_sid），本函数是其兜底。
    无匹配 / 存储不存在 / 参数无效 / 族不在白名单返回 ''。
    """
    cwd = (cwd or "").rstrip("/")
    if not cwd or since <= 0 or family not in FAMILIES:
        return ""
    try:
        return _live_dsh(cwd, since)
    except (OSError, ValueError):
        return ""


# ---------------------------------------------------------------- 统一入口

def load(family, sid, agent, after=0):
    """加载并解析 dsh 会话，返回 messages 响应主体。

    返回 {"found": True, "agents", "agent", "entries", "total", "totals"}
    或 {"found": False, "reason": "missing" | "unsupported"}。
    entries 为 seq >= after 的增量；total 为全量条数（变小时客户端应重置重拉）。
    dsh 为单线会话（固定 main，无子 agent）。
    """
    if family not in FAMILIES:
        return {"found": False, "reason": "unsupported"}
    agent = agent or "main"
    try:
        zpath = _dsh_session_file(sid)
        if zpath is None:
            return {"found": False, "reason": "missing"}
        # dsh 为单线会话（无子 agent）：agents 形状与旧单线族逐字段一致
        agents = [{"id": "main", "type": "main", "parent": ""}]
        st = os.stat(zpath)
        stamp = (st.st_mtime_ns, st.st_size)
        key = (sid, agent)
        cache = _CACHE.get(key)
        if cache is None or cache["stamp"] != stamp:
            col = _parse_dsh(zpath)
            cache = {"stamp": stamp, "entries": col.entries, "totals": col.totals}
            _CACHE[key] = cache
    except (OSError, ValueError):
        return {"found": False, "reason": "missing"}
    entries = cache["entries"]
    after = max(0, int(after or 0))
    return {"found": True, "agents": agents, "agent": agent,
            "entries": entries[after:], "total": len(entries), "totals": cache["totals"]}


def resolve_media(family, sid, agent, media_id):
    """解析会话图片为 (bytes, content_type)；不存在或校验失败返回 None。

    dsh: media_id = sha256:<64hex>（宿主 attachment id）→ 驱动 `/media` 取字节
    （插件用 `attachments.imageHostPath` 定位宿主机文件并嗅探类型）。
    族不在白名单 / id 形态不符 / 驱动无数据 / 附件不存在（驱动 404，见
    dshdriver.media）一律返回 None，路由层据此落 404。
    """
    if family not in FAMILIES:
        return None
    try:
        if not MEDIA_DSH_RE.match(media_id or ""):
            return None
        resp = dshdriver.media(media_id)
        data = base64.b64decode(resp.get("data") or "")
        ctype = str(resp.get("content_type") or "")
        return (data, ctype) if data and ctype else None
    except (OSError, ValueError, dshdriver.DshDriverError):
        return None


def cache_clear():
    """清空解析缓存（测试用）。"""
    _CACHE.clear()


# -------------------------------------- 会话标题 / 按工作区枚举 / 存在性检查
# 供看板「绑定已有会话」下拉与「session 自动同步」共用；均为增强能力，
# 异常一律静默返回空（'' / [] / False），不打断主流程。

LIST_SESSIONS_LIMIT = 50  # 按工作区枚举会话的条数上限（绑定下拉/自动同步共用）

# dsh 归档集读侧缓存：{key: (path, mtime_ns, size), ids: frozenset}。
# 按 (path, mtime_ns, size) 失效——宿主每次归档/取消归档都整表重写 workspace.json。
_ARCHIVE_CACHE = {"key": None, "ids": frozenset()}


def _dsh_archived_ids():
    """读 dsh 宿主归档集（`<dsh home>/storages/workspace.json` → `global.archivedSessionIds`）。

    为什么读文件而不是问驱动：sessparse 是纯只读解析层，归档标记只服务展示/建卡
    归类（绑定下拉的 [已归档] 标记、sync 卡落「已完成」），不该引入 HTTP 依赖与
    调用频次；实时搬列判定走 `dshevents`（驱动推帧，权威在宿主内存）另有一条路。

    文件缺失 / 坏 JSON / 无该键 / 无 global 段 → 空集（= 全部未归档，即历史行为）；
    解析结果按 (mtime_ns, size) 缓存，归档集没变就不重复解析大文件。
    """
    path = os.path.join(os.path.dirname(DSH_SESSIONS), "storages", "workspace.json")
    try:
        st = os.stat(path)
        key = (path, st.st_mtime_ns, st.st_size)
    except OSError:
        return frozenset()
    if _ARCHIVE_CACHE["key"] == key:
        return _ARCHIVE_CACHE["ids"]
    ids = frozenset()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        raw = None
        if isinstance(data, dict):
            glob = data.get("global")
            if isinstance(glob, dict):
                raw = glob.get("archivedSessionIds")
            if raw is None:              # 兼容顶层直挂的写法（防御）
                raw = data.get("archivedSessionIds")
        if isinstance(raw, list):
            ids = frozenset(str(s) for s in raw if s)
    except (OSError, ValueError):
        ids = frozenset()                # 读不到/坏文件：按未归档降级（绝不上抛）
    _ARCHIVE_CACHE["key"] = key
    _ARCHIVE_CACHE["ids"] = ids
    return ids


def session_title(family, sid):
    """统一会话标题读取（异常静默返回 ''，标题只是展示增强，不打断主流程）。

    dsh 标题取会话**当前**标题（末枚 `session/title` 事件，与 dsh GUI 侧栏一致）；
    族不在白名单返回 ''。
    """
    if family not in FAMILIES:
        return ""
    try:
        return dsh_title(sid)
    except Exception:
        return ""


def _list_dsh(cwd):
    """dsh：bucket 目录（dsh_bucket 返回值已含 DSH_SESSIONS 前缀）下 glob 会话目录，
    mtime 取事件流文件。`archived` 取宿主归档集（见 `_dsh_archived_ids`）。

    目录名两代并存：`session-<uuid>` 与裸 `<uuid>`；文件名带格式版本
    （session.v4.jsonl.zstd 等），故目录匹配与文件匹配都用通配（见 _dsh_session_file）。
    **子代理会话不进列表**（2026-10-07 实障修复）：它由主会话派生，被当成独立会话
    会各自建卡（实测 72 张、70 张永留「待审核」）并在跑时占项目运行位，判据取会话
    头行的 origin/delegationDepth（见 `is_subagent`）。裸 uuid 目录**不代表**是子代理：
    实测 82 个里 73 个是子代理、9 个是老主会话。
    归档只影响归档标记：会话目录仍在 bucket 里，列表照常枚举到它（平台据此把
    归档会话建成落在「已完成」的 sync 卡 / 在绑定下拉里标 [已归档]）。
    """
    archived = _dsh_archived_ids()
    out = []
    for sdir in glob.glob(os.path.join(dsh_bucket(cwd), "*")):
        zfile = _dsh_pick_file(sdir)
        if not zfile:
            continue
        try:
            mtime = os.path.getmtime(zfile)
        except OSError:
            continue
        sid = os.path.basename(sdir)
        if _header_subagent(_dsh_header(zfile)):
            continue            # 子代理会话：先判头行再解全量（省一次整段解压）
        # 一次解压同时取当前标题、首问与全部标题事件（同 stamp 缓存）：看板 sync 卡
        # 建卡/标题同步都要后两者，逐会话各调一次读口会重复解压同一个文件（见 _dsh_meta）
        title, first_prompt, titles = _dsh_meta(zfile)
        out.append({"sid": sid, "title": title, "titles": list(titles),
                    "first_prompt": first_prompt,
                    "mtime": mtime, "archived": sid in archived})
    return out


def list_sessions(family, cwd):
    """按工作区枚举 dsh 会话 [{sid, title, titles, first_prompt, mtime秒, archived}]，
    mtime 降序、上限 LIST_SESSIONS_LIMIT。

    `title` = **当前**会话标题（末枚 session/title 事件，与 dsh GUI 一致）、
    `titles` = 全部标题事件、`first_prompt` = 主会话第一条真实用户提问原文
    （看板 sync 卡取它做描述、取 title 做卡标题）。

    供看板「绑定已有会话」下拉与「自动同步」共用；`archived` 读宿主归档集
    （`<dsh home>/storages/workspace.json` 的 `global.archivedSessionIds`，读不到
    按未归档）。族不在白名单 / cwd 为空 / 异常一律静默返回 []（列表是增强能力）。
    """
    if family not in FAMILIES:
        return []
    cwd = (cwd or "").rstrip("/")
    if not cwd:
        return []
    try:
        items = _list_dsh(cwd)
    except Exception:
        return []
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items[:LIST_SESSIONS_LIMIT]


def session_exists(family, sid):
    """会话存储是否还在（sync 卡片「存储被删→done」判定用；不做内容解析，
    纯路径存在性）。族不在白名单返回 False。
    """
    if family not in FAMILIES:
        return False
    try:
        return bool(_dsh_session_file(sid))
    except Exception:
        return False
