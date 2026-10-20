#!/usr/bin/env python3
"""Touchstone 案例库语义检索（RAG）底座。

API 嵌入（OpenAI 兼容 /v1/embeddings，urllib 标准库直调）+ 纯标准库 BM25 兜底 +
RRF 混合排序。派生索引落 <案例库根>/.live/（rag_index.jsonl / similar.jsonl），
原子写、可随时重建；未配置（~/.touchstone/rag.json 不存在）时一切功能 no-op，
系统行为与无 RAG 完全一致；任何检索故障静默降级，永不阻塞任务。

子命令：
- rebuild  删除索引后全量重建（嵌入 + 近邻）
- search   混合检索试查，打印 top-k
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.request

import export_cases
import lib

# 派生文件名（<案例库根>/.live/ 下，平台维护，agent 只读）
RAG_INDEX_NAME = "rag_index.jsonl"
SIMILAR_NAME = "similar.jsonl"
# 嵌入源文本截断长度（字符）；近邻条数；检索默认 top-k
EMBED_TEXT_MAX = 2000
TOPK_SIMILAR = 5
DEFAULT_K = 8
# RRF 常数（标准 60）；融合前单路候选数；BM25 参数（标准值）
RRF_K = 60
CAND_TOP = 20
BM25_K1 = 1.5
BM25_B = 0.75
# BM25 内存缓存 TTL（秒），key=案例库根+扫描签名
CACHE_TTL = 1.0
# 嵌入请求失败重试次数（加首次共 2 次尝试）
HTTP_RETRY = 1
# 未显式配置时的缺省请求超时（秒）与嵌入批量大小（load_config 兜底 / 管理页保存校验同源）
DEF_TIMEOUT_S = 30
DEF_BATCH_SIZE = 16


def config_path():
    """rag.json 路径：环境变量 TS_RAG_CONFIG 覆盖，默认 ~/.touchstone/rag.json。"""
    return os.environ.get("TS_RAG_CONFIG") or os.path.expanduser("~/.touchstone/rag.json")


def load_config():
    """读 RAG 配置；文件不存在/解析失败/关键字段缺失返回 None（=RAG 未启用）。

    api_key 仅存于返回 dict（内存），调用方不得写入日志或任何落盘内容。
    """
    raw = lib.read_text(config_path())
    if not raw:
        return None
    try:
        cfg = json.loads(raw)
    except ValueError:
        return None
    if not (isinstance(cfg, dict) and cfg.get("api_base")
            and cfg.get("api_key") and cfg.get("model")):
        return None
    cfg.setdefault("timeout_s", DEF_TIMEOUT_S)
    cfg.setdefault("batch_size", DEF_BATCH_SIZE)
    return cfg


def raw_config():
    """读 rag.json 原始 dict（不校验关键字段），文件缺失/解析失败/非 dict 返回 None。

    供管理页回显：load_config 校验失败（半填配置）时页面上仍要能
    展示已填的字段值，让用户补全而不是从零重填。
    """
    raw = lib.read_text(config_path())
    if not raw:
        return None
    try:
        cfg = json.loads(raw)
    except ValueError:
        return None
    return cfg if isinstance(cfg, dict) else None


def _cfg_int(value, default, upper, name):
    """配置整数字段规整：None/空串→默认值；非法或越界抛 ValueError（上限防误填拖垮请求）。"""
    if value is None or value == "":
        return default
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ValueError("%s 须为正整数" % name)
    if n < 1 or n > upper:
        raise ValueError("%s 须在 1~%d 之间" % (name, upper))
    return n


def save_config(cfg):
    """校验并原子写入 rag.json（0600 权限——文件含 api_key 明文）。

    关键字段缺失/非法抛 ValueError，由管理页端点转 400 返回给前端提示；
    api_base 须 http(s) 开头（拼接 /embeddings 的约定见 _post_embeddings）。
    """
    api_base = str(cfg.get("api_base") or "").strip().rstrip("/")
    api_key = str(cfg.get("api_key") or "").strip()
    model = str(cfg.get("model") or "").strip()
    if not api_base.lower().startswith(("http://", "https://")):
        raise ValueError(
            "api_base 须为 http(s):// 开头的 OpenAI 兼容服务地址（含 /v1，不含 /embeddings）")
    if not api_key:
        raise ValueError("api_key 不能为空")
    if not model:
        raise ValueError("model 不能为空（须为嵌入模型，非对话模型）")
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"api_base": api_base, "api_key": api_key, "model": model,
                   "timeout_s": _cfg_int(cfg.get("timeout_s"), DEF_TIMEOUT_S, 300, "timeout_s"),
                   "batch_size": _cfg_int(cfg.get("batch_size"), DEF_BATCH_SIZE, 256, "batch_size")},
                  f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    # 收紧权限到属主可读写（api_key 明文）；Windows 无 POSIX 权限位，此调用
    # 在该平台不报错也无实际效果，机密性依赖 %USERPROFILE% 的默认 ACL
    os.chmod(path, 0o600)


def disable():
    """停用 RAG：删除 rag.json（存在才删）。返回是否实际删除了文件。"""
    try:
        os.remove(config_path())
        return True
    except FileNotFoundError:
        return False


def test_connection(cfg):
    """配置连通性探测：按给定配置发一次单文本嵌入请求（管理页「测试连接」用）。

    返回 {"ok": True, "dim": 向量维度} 或 {"ok": False, "error": 原因}，绝不抛出；
    timeout_s/batch_size 走同一 _cfg_int 规整，表单误填在探测时一并报出。
    error 文本不含 api_key（urllib 异常只含 URL，Bearer 头不进异常消息）。
    """
    try:
        probe = {
            "api_base": str(cfg.get("api_base") or "").strip(),
            "model": str(cfg.get("model") or "").strip(),
            "api_key": str(cfg.get("api_key") or "").strip(),
        }
        if not (probe["api_base"] and probe["model"] and probe["api_key"]):
            raise ValueError("api_base / model / api_key 尚未填写完整")
        probe["timeout_s"] = _cfg_int(cfg.get("timeout_s"), DEF_TIMEOUT_S, 300, "timeout_s")
        probe["batch_size"] = _cfg_int(cfg.get("batch_size"), DEF_BATCH_SIZE, 256, "batch_size")
        vecs = _post_embeddings(probe, ["ping"])
        return {"ok": True, "dim": len(vecs[0]) if vecs and vecs[0] else 0}
    except Exception as exc:  # 网络/鉴权/响应形态异常统一转为可展示文本
        return {"ok": False, "error": str(exc) or exc.__class__.__name__}


def embedding_text(root, rec):
    """嵌入源文本 = 用例相对目录路径 + case.md 原文（截断）。

    不含 status——相似度只反映「测的是什么」，不随通过/失败漂移。
    rec 为 export_cases.scan_cases 记录（含 dir/name 等字段）。
    """
    body = lib.read_text(os.path.join(root, rec["dir"], "case.md"))
    return (rec["dir"].replace("\\", "/") + "\n" + body)[:EMBED_TEXT_MAX]


def text_hash(text, model):
    """嵌入内容指纹：文本+模型 双因子 sha256，索引差量判定与模型变更重建的依据。"""
    return hashlib.sha256((model + "\n" + text).encode("utf-8")).hexdigest()


def _post_embeddings(cfg, texts):
    """调 OpenAI 兼容 /v1/embeddings 批量嵌入。

    返回与 texts 等长同序的向量列表（按响应 index 字段还原顺序）；
    响应缺 data/条数不符（HTTP 200+error 体）/网络/解析失败一律抛异常
    （重试 1 次），由调用方决定降级——绝不静默返回可能错位的向量。
    """
    url = cfg["api_base"].rstrip("/") + "/embeddings"
    body = json.dumps({"model": cfg["model"], "input": texts}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg["api_key"],
    })
    for attempt in range(HTTP_RETRY + 1):
        try:
            with urllib.request.urlopen(req, timeout=cfg["timeout_s"]) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            items = data.get("data") if isinstance(data, dict) else None
            if not isinstance(items, list):
                raise ValueError("embeddings 响应缺 data")
            items = sorted(items, key=lambda d: d.get("index", 0))
            if len(items) != len(texts):
                raise ValueError("embeddings 返回条数不符")
            return [item["embedding"] for item in items]
        except Exception as exc:  # HTTP/超时/解析失败统一计数重试
            if attempt >= HTTP_RETRY:
                raise


# ---- 分词与 BM25（纯标准库兜底检索，永远可用）----

WORD_RE = re.compile(r"[A-Za-z0-9_]+")
CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def tokenize(text):
    """查询/文档统一分词：ASCII/数字下划线段小写词；CJK 连续段字符 bigram（单字保底）。

    「登录失败」→ [登录, 录失, 失败]；词面兜底检索与 BM25 语料共用此口径。
    """
    tokens = [w.lower() for w in WORD_RE.findall(text or "")]
    for seg in CJK_RE.findall(text or ""):
        if len(seg) == 1:
            tokens.append(seg)
        else:
            tokens.extend(seg[i] + seg[i + 1] for i in range(len(seg) - 1))
    return tokens


def _scan_signature(root):
    """扫描签名=(用例数, 全库最大 mtime)：BM25 缓存与差量刷新的失效判定。

    mtime 覆盖用例目录与 case.md（目录改名只变目录 mtime，也会被捕捉）。
    """
    count, latest = 0, 0.0
    for rec in export_cases.scan_cases(root):
        count += 1
        for p in (os.path.join(root, rec["dir"]),
                  os.path.join(root, rec["dir"], "case.md")):
            try:
                latest = max(latest, os.path.getmtime(p))
            except OSError:
                pass
    return (count, latest)


def _bm25_build(texts):
    """由语料文本列表构建 BM25 内存倒排（词 → {文档序号: 词频}）。"""
    inv, doc_len = {}, []
    for i, text in enumerate(texts):
        toks = tokenize(text)
        doc_len.append(len(toks))
        for t in toks:
            inv.setdefault(t, {}).setdefault(i, 0)
            inv[t][i] += 1
    return {"inv": inv, "doc_len": doc_len, "n": len(texts),
            "avgdl": (sum(doc_len) / len(doc_len)) if doc_len else 0.0}


def _bm25_search(idx, query, top):
    """BM25 打分（k1/b 标准值 + 概率 IDF），返回 [(文档序号, 得分)] 降序前 top。"""
    scores = {}
    n, avgdl = idx["n"], idx["avgdl"] or 1.0
    for t in set(tokenize(query)):
        postings = idx["inv"].get(t)
        if not postings:
            continue
        idf = math.log(1.0 + (n - len(postings) + 0.5) / (len(postings) + 0.5))
        for i, tf in postings.items():
            dl = idx["doc_len"][i] or 1
            gain = tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl))
            scores[i] = scores.get(i, 0.0) + idf * gain
    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:top]


# BM25 内存缓存（进程级单例；签名+TTL 双重失效，同 server.StateCache 风格）
_BM25_CACHE = {"root": None, "sig": None, "at": 0.0, "idx": None}


def _bm25_cached(root, texts):
    """带缓存的 BM25 索引：案例库未变且 1s 内直接复用，重建 <100ms（百级库）。"""
    sig = _scan_signature(root)
    now = time.time()
    if (_BM25_CACHE.get("root") == root and _BM25_CACHE.get("sig") == sig
            and now - _BM25_CACHE.get("at", 0.0) < CACHE_TTL):
        return _BM25_CACHE["idx"]
    idx = _bm25_build(texts)
    _BM25_CACHE.update({"root": root, "sig": sig, "at": now, "idx": idx})
    return idx


# ---- 派生文件读写与差量刷新 ----


def _index_path(root):
    return os.path.join(root, ".live", RAG_INDEX_NAME)


def _similar_path(root):
    return os.path.join(root, ".live", SIMILAR_NAME)


def _atomic_write_jsonl(path, rows):
    """原子写 jsonl（tmp + os.replace），读方永远看到完整旧文件或完整新文件。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def _load_index(root):
    """读 rag_index.jsonl → {id: 行}；文件缺失/行损坏按缺失处理（重建自愈）。"""
    out = {}
    for line in lib.read_text(_index_path(root)).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("id"):
            out[rec["id"]] = rec
    return out


def _load_jsonl(path):
    """读通用 jsonl 文件为行 dict 列表（CLI 展示与测试用）。"""
    out = []
    for line in lib.read_text(path).splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def _norm(vec):
    """向量 L2 归一化（零向量安全），归一化后点积即余弦。"""
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _similar_rows(index):
    """全库两两余弦取 top-5 近邻（向量均归一化，点积即余弦）。

    行格式 {"id","name","similar":[{"id","name","score"}]}；name 供 agent 直接 grep。
    """
    ids = sorted(index)
    rows = []
    for rid in ids:
        vec = index[rid].get("vec") or []
        scored = [(_dot(vec, index[other].get("vec") or []), other)
                  for other in ids if other != rid]
        scored.sort(reverse=True)
        rows.append({
            "id": rid, "name": index[rid].get("name", ""),
            "similar": [{"id": other, "name": index[other].get("name", ""),
                         "score": round(s, 4)} for s, other in scored[:TOPK_SIMILAR]],
        })
    return rows


def refresh(root, log=None):
    """索引增量维护：差量嵌入 + 近邻重算。RAG 未配置时 no-op（不产生任何文件）。

    返回 {"enabled","embedded","total"}。嵌入批间失败保留已成功批次，
    剩余 stale 下轮重试；存在 stale（索引不完整）时不动 similar.jsonl，避免降级成残缺清单。
    """
    cfg = load_config()
    records = export_cases.scan_cases(root)
    if not cfg:
        return {"enabled": False, "embedded": 0, "total": len(records)}
    index = _load_index(root)
    rec_map = {rec["id"]: rec for rec in records}
    # 模型变更 → 全量重建（旧向量全部失配）
    if index and any(r.get("model") != cfg["model"] for r in index.values()):
        index = {}
    texts, hashes = {}, {}
    for rec in records:
        t = embedding_text(root, rec)
        texts[rec["id"]] = t
        hashes[rec["id"]] = text_hash(t, cfg["model"])
    stale = [rid for rid, h in hashes.items()
             if rid not in index or index[rid].get("hash") != h]
    embedded = 0
    batch = max(1, int(cfg.get("batch_size") or 16))
    for start in range(0, len(stale), batch):
        part = stale[start:start + batch]
        try:
            vecs = _post_embeddings(cfg, [texts[rid] for rid in part])
        except Exception as exc:
            if log:
                log(f"RAG 嵌入失败（保留旧索引，待嵌 {len(stale) - embedded} 条）：{exc}")
            break
        for rid, vec in zip(part, vecs):
            index[rid] = {"id": rid, "name": rec_map[rid]["name"], "hash": hashes[rid],
                          "model": cfg["model"], "dim": len(vec), "vec": _norm(vec)}
            embedded += 1
    # 逐出已删除用例
    removed = [rid for rid in list(index) if rid not in hashes]
    for rid in removed:
        index.pop(rid, None)
    if embedded or removed:
        _atomic_write_jsonl(_index_path(root),
                            sorted(index.values(), key=lambda r: r["id"]))
    # 索引完整（无 stale）才重算 similar，防止嵌入失败期间输出残缺近邻；
    # 且本轮无任何变更（无新嵌、无删除）且 similar.jsonl 已存在时直接跳过——
    # retrieve 每轮调用前都会 refresh，此分支保证零无用开销（无变更不写盘，
    # 跳过 O(n²) 近邻重算）；not exists 分支保底：similar.jsonl 被手删而索引
    # 完整时仍能重建。
    stale_left = [rid for rid, h in hashes.items()
                  if rid not in index or index[rid].get("hash") != h]
    if not stale_left and (embedded or removed
                           or not os.path.exists(_similar_path(root))):
        _atomic_write_jsonl(_similar_path(root), _similar_rows(index))
    elif log:
        log(f"RAG 索引不完整（待嵌 {len(stale_left)} 条），本轮不更新 similar.jsonl")
    return {"enabled": True, "embedded": embedded, "total": len(records)}

# ---- 混合检索（RRF 融合 + 多级降级，永不抛出）----


def _rrf_merge(pools, k):
    """倒数排名融合：score = Σ 1/(RRF_K + rank)；via 记录命中来源（字典序拼接）。"""
    agg = {}
    for name, hits in pools.items():
        for rank, (i, _score) in enumerate(hits):
            score, via = agg.get(i, (0.0, set()))
            agg[i] = (score + 1.0 / (RRF_K + rank + 1), via | {name})
    out = [(i, s, "+".join(sorted(v))) for i, (s, v) in agg.items()]
    out.sort(key=lambda x: x[1], reverse=True)
    return out[:k]


def _fallback(root, query, k):
    """最终兜底：scan_cases 字段 substring 关键词过滤（连 RAG 底座都异常时仍可用）。"""
    records = export_cases.scan_cases(root)
    kw = (query or "").strip()
    if kw:
        hits = [r for r in records
                if any(kw in str(r.get(f, "")) for f in ("dir", "name", "interface", "module"))]
    else:
        hits = []
    return [{**r, "score": 0.0, "via": "kw"} for r in hits[:k]]


def retrieve_detail(root, query, k=DEFAULT_K):
    """混合检索入口（带元数据版）：BM25 恒可用；配置了 RAG 则向量路并入 RRF 融合。

    返回 (rows, meta)：rows = scan_cases 记录 + score + via；meta 回答
    「这次检索到底用没用 RAG」——{"configured": RAG 是否已配置,
    "vec_ok": 向量路是否真实参与本次检索, "vec_error": 向量路失败原因
    （成功/未配置为 None）}，供任务调用方记日志与 CLI 降级提示。
    任何异常降级到关键词兜底，永不抛出。
    """
    meta = {"configured": False, "vec_ok": False, "vec_error": None}
    try:
        try:
            refresh(root)  # 惰性差量：案例库被其他任务更新过则先补索引（未配置 no-op）
        except Exception:
            pass
        records = export_cases.scan_cases(root)
        if not records:
            return [], meta
        texts = [embedding_text(root, rec) for rec in records]
        pools = {"bm25": _bm25_search(_bm25_cached(root, texts), query, CAND_TOP)}
        cfg = load_config()
        if cfg:
            meta["configured"] = True
            try:
                qvec = _norm(_post_embeddings(cfg, [(query or "")[:EMBED_TEXT_MAX]])[0])
                index = _load_index(root)
                vec_hits = []
                for i, rec in enumerate(records):
                    item = index.get(rec["id"])
                    if item and item.get("vec"):
                        vec_hits.append((i, _dot(qvec, item["vec"])))
                vec_hits.sort(key=lambda x: x[1], reverse=True)
                pools["vec"] = vec_hits[:CAND_TOP]
                meta["vec_ok"] = True
            except Exception as exc:
                # 嵌入失败：向量路缺席，BM25 结果照常返回；原因截断后记入 meta
                meta["vec_error"] = (str(exc) or exc.__class__.__name__)[:200]
        merged = _rrf_merge(pools, k)
        return ([{**records[i], "score": round(s, 4), "via": via}
                 for i, s, via in merged], meta)
    except Exception:
        try:
            return _fallback(root, query, k), meta
        except Exception:
            return [], meta  # 连兜底都异常（如案例库根不可读）时返回空，保证永不抛出


def retrieve(root, query, k=DEFAULT_K):
    """混合检索入口（兼容壳）：只返回结果行；检索元数据见 retrieve_detail。"""
    return retrieve_detail(root, query, k)[0]


def change_query(log):
    """git_log_changes 结果 → 检索 query：变更文件路径 + 提交摘录（截 4000 字符）。"""
    parts = list(log.get("files") or []) + list(log.get("commits") or [])
    return "\n".join(parts)[:4000]


def cmd_rebuild(args):
    """强制全量重建：删索引文件使 refresh 全量 stale。"""
    try:
        os.remove(_index_path(args.root))
    except OSError:
        pass
    stat = refresh(args.root, log=lambda m: print(m, file=sys.stderr))
    print(json.dumps(stat, ensure_ascii=False))
    similar = _load_jsonl(_similar_path(args.root))
    print(f"similar.jsonl {len(similar)} 条")
    return 0


def cmd_search(args):
    """检索试查：打印 top-k（id [via] score 相对路径）；向量路降级时 stderr 提示。"""
    rows, meta = retrieve_detail(args.root, args.query, args.k)
    for r in rows:
        print(f"{r['id']} [{r['via']}] {r['score']} {r['dir']}")
    if meta["configured"] and not meta["vec_ok"]:
        print(f"向量路失败，本次为纯 BM25 结果：{meta['vec_error']}", file=sys.stderr)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_re = sub.add_parser("rebuild", help="全量重建嵌入索引与近邻文件")
    p_re.add_argument("root", help="案例库根目录")
    p_re.set_defaults(func=cmd_rebuild)
    p_se = sub.add_parser("search", help="混合检索试查")
    p_se.add_argument("root", help="案例库根目录")
    p_se.add_argument("query", help="查询文本")
    p_se.add_argument("--k", type=int, default=DEFAULT_K, help="返回条数（默认 8）")
    p_se.set_defaults(func=cmd_search)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

