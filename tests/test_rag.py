# RAG 底座单测：配置/嵌入文本/BM25/RRF/索引差量/降级链（临时案例库，不触网络/真实数据）
import argparse, json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest
import rag
try:
    import prompts
except Exception:  # prompts 依赖另算（lib/export_cases），import 失败允许本文件其余用例继续
    prompts = None


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _mk_lib(tmp, cases):
    """生成临时案例库。cases: [(子路径, case.md 正文), ...]，子路径形如 mod/FS0001_名称。"""
    root = os.path.join(tmp, "free_style")
    for rel, body in cases:
        _write(os.path.join(root, rel, "case.md"), body)
        _write(os.path.join(root, rel, "status.md"), "- **状态**: 未执行\n")
    return root


CASES = [
    ("mod_login/FS0001_密码错误提示",
     "# FS0001\n\n- **用例 ID**: FS0001\n- **接口**: POST /api/login\n"
     "- **测试目标**: 验证密码错误时登录失败并提示\n"),
    ("mod_login/FS0002_登录成功",
     "# FS0002\n\n- **用例 ID**: FS0002\n- **接口**: POST /api/login\n"
     "- **测试目标**: 验证正确密码登录成功跳转首页\n"),
    ("mod_data/FS0003_导出CSV",
     "# FS0003\n\n- **用例 ID**: FS0003\n- **接口**: GET /api/export\n"
     "- **测试目标**: 验证导出 CSV 列头与行数一致\n"),
]


@pytest.fixture
def lib_root(tmp_path):
    return _mk_lib(str(tmp_path), CASES)


def test_config_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("TS_RAG_CONFIG", str(tmp_path / "nope.json"))
    assert rag.load_config() is None


def test_config_load_and_defaults(tmp_path, monkeypatch):
    cfg_path = tmp_path / "rag.json"
    cfg_path.write_text(json.dumps(
        {"api_base": "http://x/v1", "api_key": "k", "model": "m"}), encoding="utf-8")
    monkeypatch.setenv("TS_RAG_CONFIG", str(cfg_path))
    cfg = rag.load_config()
    assert cfg["timeout_s"] == 30 and cfg["batch_size"] == 16
    assert cfg["api_key"] == "k" and cfg["model"] == "m"


def test_config_incomplete_returns_none(tmp_path, monkeypatch):
    cfg_path = tmp_path / "rag.json"
    cfg_path.write_text(json.dumps({"api_base": "http://x/v1"}), encoding="utf-8")
    monkeypatch.setenv("TS_RAG_CONFIG", str(cfg_path))
    assert rag.load_config() is None  # 缺 model = 未启用


def test_embedding_text_contains_dir_and_body(lib_root):
    import export_cases
    rec = export_cases.scan_cases(lib_root)[0]
    text = rag.embedding_text(lib_root, rec)
    assert rec["dir"] in text and "FS0001" in text and "登录失败" in text


def test_embedding_text_truncated(lib_root):
    import export_cases
    rec = export_cases.scan_cases(lib_root)[0]
    assert len(rag.embedding_text(lib_root, rec)) <= rag.EMBED_TEXT_MAX


def test_text_hash_varies_by_text_and_model():
    h1 = rag.text_hash("abc", "m1")
    assert h1 == rag.text_hash("abc", "m1")      # 稳定
    assert h1 != rag.text_hash("abd", "m1")       # 文本变
    assert h1 != rag.text_hash("abc", "m2")       # 模型变


def test_post_embeddings_request_and_order(tmp_path, monkeypatch):
    cfg = {"api_base": "http://x/v1", "api_key": "k", "model": "m",
           "timeout_s": 5, "batch_size": 16}
    seen = {}

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            seen["code"] = 200
            return json.dumps({"data": [
                {"index": 1, "embedding": [0.3]},
                {"index": 0, "embedding": [0.1]},
            ]}).encode("utf-8")

    def fake_urlopen(req, timeout=0):
        seen["url"] = req.full_url
        seen["auth"] = req.headers.get("Authorization")
        seen["body"] = json.loads(req.data.decode("utf-8"))
        return FakeResp()

    monkeypatch.setattr(rag.urllib.request, "urlopen", fake_urlopen)
    vecs = rag._post_embeddings(cfg, ["甲", "乙"])
    assert seen["url"] == "http://x/v1/embeddings"
    assert seen["auth"] == "Bearer k"
    assert seen["body"]["model"] == "m" and seen["body"]["input"] == ["甲", "乙"]
    assert vecs == [[0.1], [0.3]]  # 按 index 还原为输入顺序


def test_post_embeddings_missing_data_raises(monkeypatch):
    """200 体缺 data（HTTP 200+error 体是部分网关的常规错误形态）→ 抛异常，不静默返回空。"""
    cfg = {"api_base": "http://x/v1", "api_key": "k", "model": "m",
           "timeout_s": 5, "batch_size": 16}

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"error": {"message": "bad gateway"}}).encode("utf-8")

    monkeypatch.setattr(rag.urllib.request, "urlopen", lambda req, timeout=0: FakeResp())
    with pytest.raises(ValueError):
        rag._post_embeddings(cfg, ["甲"])


def test_post_embeddings_count_mismatch_raises(monkeypatch):
    """响应条数与输入不等长 → 抛异常，防止错位向量。"""
    cfg = {"api_base": "http://x/v1", "api_key": "k", "model": "m",
           "timeout_s": 5, "batch_size": 16}

    class FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"data": [{"index": 0, "embedding": [0.1]}]}).encode("utf-8")

    monkeypatch.setattr(rag.urllib.request, "urlopen", lambda req, timeout=0: FakeResp())
    with pytest.raises(ValueError):
        rag._post_embeddings(cfg, ["甲", "乙"])


def test_tokenize_cjk_bigram_and_ascii():
    assert rag.tokenize("登录失败 login") == ["login", "登录", "录失", "失败"]
    assert rag.tokenize("POST /api/login 密码") == ["post", "api", "login", "密码"]
    assert rag.tokenize("") == []


def test_bm25_search_ranks_relevant_first():
    texts = ["登录 密码 错误 提示", "导出 csv 列表 列头", "登录 成功 跳转 首页"]
    idx = rag._bm25_build(texts)
    hits = rag._bm25_search(idx, "登录失败提示", 3)
    assert hits[0][0] == 0            # 含「登录/提示」的文档排第一
    assert hits[1][0] == 2            # 仅共享「登录」的第二


def test_scan_signature_changes_on_mtime(lib_root):
    sig1 = rag._scan_signature(lib_root)
    import time
    path = os.path.join(lib_root, "mod_login/FS0001_密码错误提示", "case.md")
    os.utime(path, (time.time() + 2, time.time() + 2))
    assert rag._scan_signature(lib_root) != sig1


def _fake_embed(dims=257):
    """确定性假嵌入：token → 固定维度累加。维度 257 大于用例语料的去重词元数，
    即无折叠碰撞，近邻序由共享词元数决定（断言可确定）；真实语义近邻由 Task 8 实测。"""
    vocab = {}

    def embed(cfg, texts):
        out = []
        for t in texts:
            v = [0.0] * dims
            for tok in rag.tokenize(t):
                i = vocab.setdefault(tok, len(vocab) % dims)
                v[i] += 1.0
            out.append(v)
        return out

    return embed


def _cfg_env(tmp_path, monkeypatch, api_base="http://fake/v1"):
    cfg_path = tmp_path / "rag.json"
    cfg_path.write_text(json.dumps(
        {"api_base": api_base, "api_key": "k", "model": "m"}), encoding="utf-8")
    monkeypatch.setenv("TS_RAG_CONFIG", str(cfg_path))


def test_refresh_no_config_noop(lib_root, monkeypatch):
    monkeypatch.setenv("TS_RAG_CONFIG",
                       os.path.join(os.path.dirname(lib_root), "nope.json"))
    stat = rag.refresh(lib_root)
    assert stat["enabled"] is False
    assert not os.path.exists(os.path.join(lib_root, ".live"))  # 未启用不产生任何文件


def test_refresh_writes_index_and_similar(lib_root, tmp_path, monkeypatch):
    _cfg_env(tmp_path, monkeypatch)
    monkeypatch.setattr(rag, "_post_embeddings", _fake_embed())
    stat = rag.refresh(lib_root)
    assert stat["enabled"] and stat["embedded"] == 3 and stat["total"] == 3
    index = rag._load_index(lib_root)
    assert set(index) == {"FS0001", "FS0002", "FS0003"}
    assert all(r["model"] == "m" and len(r["vec"]) == 257 for r in index.values())
    similar = [json.loads(line) for line in open(
        rag._similar_path(lib_root), encoding="utf-8") if line.strip()]
    by_id = {row["id"]: row for row in similar}
    assert set(by_id) == {"FS0001", "FS0002", "FS0003"}
    top1 = by_id["FS0001"]["similar"][0]
    assert top1["id"] == "FS0002"           # 同模块同接口用例最近邻
    assert 0 < top1["score"] <= 1.0


def test_refresh_incremental(lib_root, tmp_path, monkeypatch):
    _cfg_env(tmp_path, monkeypatch)
    monkeypatch.setattr(rag, "_post_embeddings", _fake_embed())
    rag.refresh(lib_root)
    stat = rag.refresh(lib_root)             # 无变更零嵌入
    assert stat["embedded"] == 0
    _write(os.path.join(lib_root, "mod_data/FS0003_导出CSV/case.md"),
           "# FS0003\n\n- **用例 ID**: FS0003\n- **测试目标**: 改动后的目标描述\n")
    stat = rag.refresh(lib_root)             # 单条内容变更 → 只嵌 1 条
    assert stat["embedded"] == 1
    import shutil
    shutil.rmtree(os.path.join(lib_root, "mod_data/FS0003_导出CSV"))
    rag.refresh(lib_root)                    # 目录删除 → 索引逐出
    assert "FS0003" not in rag._load_index(lib_root)


def test_refresh_partial_failure_keeps_old(lib_root, tmp_path, monkeypatch):
    _cfg_env(tmp_path, monkeypatch)
    monkeypatch.setattr(rag, "_post_embeddings", _fake_embed())
    rag.refresh(lib_root)
    old_similar = open(rag._similar_path(lib_root), encoding="utf-8").read()
    _write(os.path.join(lib_root, "mod_login/FS0002_登录成功/case.md"),
           "# FS0002\n\n- **用例 ID**: FS0002\n- **测试目标**: 新目标\n")

    def boom(cfg, texts):
        raise OSError("network down")

    monkeypatch.setattr(rag, "_post_embeddings", boom)
    stat = rag.refresh(lib_root, log=lambda m: None)
    assert stat["embedded"] == 0
    # 嵌入失败：similar.jsonl 保持旧版不动（不降级成残缺清单）
    assert open(rag._similar_path(lib_root), encoding="utf-8").read() == old_similar


def test_refresh_partial_success_keeps_similar(lib_root, tmp_path, monkeypatch):
    """批 1 成功、批 2 失败：已嵌入批次入库，similar.jsonl 保持旧版（stale 守卫钉死）。

    全部失败场景测不出守卫（重写内容与旧版相同）；只有 partial-success 会在
    索引不完整时把 similar.jsonl 重写成残缺清单，本用例钉死该降级契约。
    """
    cfg_path = tmp_path / "rag.json"
    cfg_path.write_text(json.dumps(
        {"api_base": "http://fake/v1", "api_key": "k", "model": "m",
         "batch_size": 2}), encoding="utf-8")
    monkeypatch.setenv("TS_RAG_CONFIG", str(cfg_path))
    fake = _fake_embed()
    monkeypatch.setattr(rag, "_post_embeddings", fake)
    rag.refresh(lib_root)
    old_similar = open(rag._similar_path(lib_root), encoding="utf-8").read()
    old_index = rag._load_index(lib_root)
    # 3 条 stale（batch_size=2 → 第 1 批 2 条、第 2 批 1 条）
    _write(os.path.join(lib_root, "mod_login/FS0001_密码错误提示/case.md"),
           "# FS0001\n\n- **用例 ID**: FS0001\n- **测试目标**: 改动一\n")
    _write(os.path.join(lib_root, "mod_login/FS0002_登录成功/case.md"),
           "# FS0002\n\n- **用例 ID**: FS0002\n- **测试目标**: 改动二\n")
    _write(os.path.join(lib_root, "mod_data/FS0003_导出CSV/case.md"),
           "# FS0003\n\n- **用例 ID**: FS0003\n- **测试目标**: 改动三\n")

    calls = {"n": 0}

    def flaky(cfg, texts):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise OSError("network down")
        return fake(cfg, texts)

    monkeypatch.setattr(rag, "_post_embeddings", flaky)
    stat = rag.refresh(lib_root, log=lambda m: None)
    assert stat["embedded"] == 2           # 批 1（2 条）成功入库，批 2 失败
    # 索引不完整：similar.jsonl 保持旧版，不被重写成残缺清单
    assert open(rag._similar_path(lib_root), encoding="utf-8").read() == old_similar
    index = rag._load_index(lib_root)
    updated = [rid for rid in index if index[rid]["hash"] != old_index[rid]["hash"]]
    kept = [rid for rid in index if index[rid]["hash"] == old_index[rid]["hash"]]
    assert len(updated) == 2               # 批 1 两条 hash 已更新（新文本指纹）
    assert len(kept) == 1                  # 批 2 用例保持旧 hash，下轮 stale 重试


def test_rrf_merge_fuses_pools():
    pools = {"vec": [(0, 9.0), (1, 8.0)], "bm25": [(1, 7.0), (2, 6.0)]}
    out = rag._rrf_merge(pools, 3)
    assert [i for i, _s, _v in out] == [1, 0, 2]   # 1 两路都命中应居首
    assert out[0][2] == "bm25+vec" and out[1][2] == "vec" and out[2][2] == "bm25"


def test_retrieve_bm25_only_without_config(lib_root, monkeypatch):
    monkeypatch.setenv("TS_RAG_CONFIG", os.path.join(lib_root, "nope.json"))
    rows = rag.retrieve(lib_root, "密码错误提示")
    assert rows and rows[0]["id"] == "FS0001"
    assert rows[0]["via"] == "bm25"


def test_retrieve_hybrid_via_and_order(lib_root, tmp_path, monkeypatch):
    _cfg_env(tmp_path, monkeypatch)
    fake = _fake_embed()
    monkeypatch.setattr(rag, "_post_embeddings", fake)
    rag.refresh(lib_root)
    rows = rag.retrieve(lib_root, "密码错误时登录失败并提示")
    assert rows[0]["id"] == "FS0001"
    assert "vec" in rows[0]["via"]                      # 向量路参与融合


def test_retrieve_never_raises(lib_root, tmp_path, monkeypatch):
    _cfg_env(tmp_path, monkeypatch, api_base="http://127.0.0.1:1/v1")  # 必然连不通
    rows = rag.retrieve(lib_root, "登录")                # 嵌入失败也应返回 BM25 结果
    assert isinstance(rows, list) and rows
    import export_cases
    monkeypatch.setattr(export_cases, "scan_cases",
                        lambda root: (_ for _ in ()).throw(RuntimeError("x")))
    rows = rag.retrieve(lib_root, "导出")                # 底座彻底异常 → kw 兜底不抛
    assert isinstance(rows, list)


def test_change_query_from_log():
    q = rag.change_query({"ok": True,
                          "files": ["src/a.py", "src/b.py"],
                          "commits": ["abc1234 2026-09-06 me 修复登录校验"]})
    assert "src/a.py" in q and "修复登录校验" in q


def test_retrieve_kw_fallback_real_rows(lib_root, monkeypatch):
    """kw 兜底返回真实过滤行：BM25 缓存注入抛异常，_fallback 走真实 scan_cases。"""
    monkeypatch.setenv("TS_RAG_CONFIG", os.path.join(lib_root, "nope.json"))
    monkeypatch.setattr(rag, "_bm25_cached",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    rows = rag.retrieve(lib_root, "导出")
    assert rows and rows[0]["via"] == "kw"
    assert rows[0]["id"] == "FS0003"        # 导出用例被 kw 过滤真实命中


def test_retrieve_detail_meta_vec_ok(lib_root, tmp_path, monkeypatch):
    """retrieve_detail：向量路成功时 meta.vec_ok=True，结果 via 含 bm25+vec。"""
    _cfg_env(tmp_path, monkeypatch)
    monkeypatch.setattr(rag, "_post_embeddings", _fake_embed())
    rag.refresh(lib_root)
    rows, meta = rag.retrieve_detail(lib_root, "密码错误时登录失败并提示")
    assert meta == {"configured": True, "vec_ok": True, "vec_error": None}
    assert any("vec" in r["via"] for r in rows)


def test_retrieve_detail_meta_vec_fail(lib_root, tmp_path, monkeypatch):
    """retrieve_detail：查询嵌入失败降级——meta 记 vec_ok=False + 原因，行仍 BM25。"""
    _cfg_env(tmp_path, monkeypatch)
    monkeypatch.setattr(rag, "_post_embeddings", _fake_embed())
    rag.refresh(lib_root)                   # 索引先建好，失败只发生在查询嵌入

    def boom(cfg, texts):
        raise RuntimeError("连接超时")

    monkeypatch.setattr(rag, "_post_embeddings", boom)
    rows, meta = rag.retrieve_detail(lib_root, "密码错误提示")
    assert meta["configured"] is True and meta["vec_ok"] is False
    assert "连接超时" in meta["vec_error"]
    assert rows and all("vec" not in r["via"] for r in rows)


def test_retrieve_detail_meta_not_configured(lib_root, monkeypatch):
    """retrieve_detail：未配置时 meta.configured=False，BM25 行照常返回。"""
    monkeypatch.setenv("TS_RAG_CONFIG", os.path.join(lib_root, "nope.json"))
    rows, meta = rag.retrieve_detail(lib_root, "密码错误提示")
    assert meta == {"configured": False, "vec_ok": False, "vec_error": None}
    assert rows and all(r["via"] == "bm25" for r in rows)


def test_refresh_unchanged_skips_similar_rewrite(lib_root, tmp_path, monkeypatch):
    """无变更（embedded==0 且 removed==[]）时 refresh 零写：similar.jsonl 不重写。

    契约：retrieve 每轮都先 refresh，similar.jsonl 已存在且索引完整时直接跳过
    （零开销）——否则 O(n²) 近邻重算 + jsonl 原子重写会进任务每轮关键路径。
    """
    _cfg_env(tmp_path, monkeypatch)
    monkeypatch.setattr(rag, "_post_embeddings", _fake_embed())
    real_write = rag._atomic_write_jsonl
    calls = {"similar": 0, "index": 0}

    def counting_write(path, rows):
        calls["similar" if os.path.basename(path) == rag.SIMILAR_NAME else "index"] += 1
        return real_write(path, rows)

    monkeypatch.setattr(rag, "_atomic_write_jsonl", counting_write)
    rag.refresh(lib_root)                       # 首次：全量写 index + similar
    assert calls["similar"] == 1 and calls["index"] == 1
    calls["similar"] = calls["index"] = 0       # 清计数器
    stat = rag.refresh(lib_root)                # 无任何变更
    assert stat["embedded"] == 0
    assert calls["similar"] == 0 and calls["index"] == 0
    _write(os.path.join(lib_root, "mod_data/FS0003_导出CSV/case.md"),
           "# FS0003\n\n- **用例 ID**: FS0003\n- **测试目标**: 改动后的目标描述\n")
    stat = rag.refresh(lib_root)                # 1 条内容变更 → 重算近邻
    assert stat["embedded"] == 1 and calls["similar"] == 1


def test_semantic_order_no_config_returns_empty(tmp_path, lib_root, monkeypatch):
    """RAG 未配置：_semantic_order 直接返回空（不触发 BM25 兜底检索）。"""
    assert prompts is not None
    monkeypatch.setenv("TS_RAG_CONFIG", os.path.join(str(tmp_path), "nope.json"))
    project = {"project_dir": str(tmp_path), "cases_root": lib_root}
    task = {"date_from": "2026-01-01", "date_to": "2026-12-31"}
    assert prompts._semantic_order(project, task) == []


def test_semantic_order_ranked_first_in_prompt(tmp_path, lib_root, monkeypatch):
    """日期范围复测首轮：语义检索候选排在用例清单前部（头行注记 + id 行序），
    检索统计（候选数 + via 分布）经 log 回调记任务日志。"""
    assert prompts is not None
    import export_cases
    import lib
    # 库根是临时目录非 git 仓库：真实 git_log_changes 必 ok=False，monkeypatch 造成功
    monkeypatch.setattr(lib, "git_log_changes",
                        lambda d, f, t: {"ok": True, "files": ["a.py"], "commits": ["c1"]})
    monkeypatch.setattr(rag, "load_config",
                        lambda: {"api_base": "http://fake/v1", "api_key": "k", "model": "m"})
    records = {r["id"]: r for r in export_cases.scan_cases(lib_root)}
    monkeypatch.setattr(rag, "retrieve_detail",
                        lambda root, q, k=8: (
                            [{**records["FS0003"], "via": "bm25+vec"},
                             {**records["FS0001"], "via": "bm25"}],
                            {"configured": True, "vec_ok": True, "vec_error": None}))
    project = {"project_dir": str(tmp_path), "cases_root": lib_root,
               "env_label": "", "guide_text": "", "skill_understand": "",
               "skill_test": "", "skill_cases": ""}
    task = {"date_from": "2026-01-01", "date_to": "2026-12-31", "payload": ""}
    logged = []
    prompt = prompts.retest_range_prompt(project, task, log=logged.append)
    assert "语义检索相关候选" in prompt
    lines = prompt.splitlines()
    idx1 = next(i for i, ln in enumerate(lines) if ln.startswith("- FS0001 "))
    idx3 = next(i for i, ln in enumerate(lines) if ln.startswith("- FS0003 "))
    assert idx3 < idx1                        # 语义序：FS0003 在 FS0001 前
    assert any("RAG 语义排序检索" in m and "候选 2 条" in m
               and "bm25+vec 1 / 仅bm25 1" in m for m in logged)


def test_export_cases_semantic_rerank(tmp_path, monkeypatch, capsys):
    """retest-candidates --semantic：配置 RAG 时按检索注入序输出；未开时保持原序。"""
    import export_cases
    root = _mk_lib(str(tmp_path), [
        ("mod_a/FS0001_用例一", "# FS0001\n\n- **用例 ID**: FS0001\n- **依据代码**: src/x.py\n"),
        ("mod_b/FS0002_用例二", "# FS0002\n\n- **用例 ID**: FS0002\n- **依据代码**: src/x.py\n"),
        ("mod_c/FS0003_用例三", "# FS0003\n\n- **用例 ID**: FS0003\n- **依据代码**: src/x.py\n"),
    ])
    records = {r["id"]: r for r in export_cases.scan_cases(root)}
    monkeypatch.setattr(rag, "load_config",
                        lambda: {"api_base": "http://fake/v1", "api_key": "k", "model": "m"})
    monkeypatch.setattr(rag, "retrieve",
                        lambda r, q, k=8: [records["FS0003"], records["FS0001"],
                                           records["FS0002"]])
    args = argparse.Namespace(root=root, files=["src/x.py"], json=False, semantic=True)
    export_cases.cmd_retest_candidates(args)
    out = capsys.readouterr().out
    assert out.splitlines()[0].startswith("FS0003 ")     # 注入序排最前
    args2 = argparse.Namespace(root=root, files=["src/x.py"], json=False, semantic=False)
    export_cases.cmd_retest_candidates(args2)
    out2 = capsys.readouterr().out
    assert out2.splitlines()[0].startswith("FS0001 ")    # 未开语义：原 id 序


# ---- 管理页配置读写（save_config / raw_config / disable / test_connection）----

def test_save_config_roundtrip_and_defaults(tmp_path, monkeypatch):
    """save_config 去空白/缺省补默认后原子落盘（0600），load_config/raw_config 可读回同值。"""
    import stat
    cfg_path = tmp_path / "rag.json"
    monkeypatch.setenv("TS_RAG_CONFIG", str(cfg_path))
    rag.save_config({"api_base": " http://x/v1/ ", "api_key": " k1 ", "model": " m1 ",
                     "timeout_s": "", "batch_size": None})
    assert stat.S_IMODE(os.stat(cfg_path).st_mode) == 0o600   # 文件含 api_key 明文
    cfg = rag.load_config()
    assert cfg["api_base"] == "http://x/v1" and cfg["api_key"] == "k1"
    assert cfg["model"] == "m1" and cfg["timeout_s"] == 30 and cfg["batch_size"] == 16
    assert rag.raw_config()["api_key"] == "k1"   # raw 回显不校验关键字段（半填配置可展示）


def test_save_config_validation_errors(tmp_path, monkeypatch):
    """关键字段缺失/非法/整型越界抛 ValueError，且不落盘。"""
    monkeypatch.setenv("TS_RAG_CONFIG", str(tmp_path / "rag.json"))
    with pytest.raises(ValueError):
        rag.save_config({"api_base": "ftp://x", "api_key": "k", "model": "m"})
    with pytest.raises(ValueError):
        rag.save_config({"api_base": "http://x/v1", "api_key": "", "model": "m"})
    with pytest.raises(ValueError):
        rag.save_config({"api_base": "http://x/v1", "api_key": "k", "model": ""})
    with pytest.raises(ValueError):
        rag.save_config({"api_base": "http://x/v1", "api_key": "k", "model": "m",
                         "timeout_s": 0})
    assert rag.raw_config() is None


def test_disable_removes_config(tmp_path, monkeypatch):
    monkeypatch.setenv("TS_RAG_CONFIG", str(tmp_path / "rag.json"))
    (tmp_path / "rag.json").write_text("{}", encoding="utf-8")
    assert rag.disable() is True
    assert not (tmp_path / "rag.json").exists()
    assert rag.disable() is False            # 已删除再停用=无操作


def test_test_connection_ok_and_fail(monkeypatch):
    """探测成功回维度；字段不全/网络异常转 ok=false 文本，绝不抛出。"""
    monkeypatch.setattr(rag, "_post_embeddings", lambda cfg, texts: [[0.1, 0.2]])
    out = rag.test_connection({"api_base": "http://x/v1", "api_key": "k", "model": "m"})
    assert out == {"ok": True, "dim": 2}
    out = rag.test_connection({"api_base": "", "api_key": "k", "model": "m"})
    assert out["ok"] is False and "api_base" in out["error"]

    def boom(cfg, texts):
        raise OSError("HTTP Error 401")

    monkeypatch.setattr(rag, "_post_embeddings", boom)
    out = rag.test_connection({"api_base": "http://x/v1", "api_key": "k", "model": "m"})
    assert out["ok"] is False and "401" in out["error"]

