#!/usr/bin/env python3
"""Touchstone 案例库派生索引导出与复测粗筛。

子命令：
- export             扫描案例库，导出 <案例库根>/.live/cases.jsonl（派生索引，可随时重建）
- retest-candidates  给定变更文件列表（如 git diff 涉及文件），按用例「依据代码」
                     的文件交集粗筛候选复测用例，供 agent 逐条语义确认

案例库 md 文件是唯一权威，本脚本只读案例内容；索引导出到 .live/ 目录。
"""

import argparse
import json
import os
import re
import sys

import lib

# 「依据代码」中的代码文件引用（可带 :行号 或 :起-止 行号）；字符集不含中文，避免吞掉前文
CODE_REF_RE = re.compile(
    r"[A-Za-z0-9_./-]+\.(?:cpp|cc|cxx|hpp|h|java|py|jsx?|tsx?|sql|xml|proto|go|rs)"
    r"(?::\d+(?:-\d+)?)?"
)


def extract_code_files(raw):
    """从「依据代码」原文提取文件路径列表（去行号、去重，保留原文写法）。"""
    files = []
    for m in CODE_REF_RE.finditer(raw or ""):
        path = m.group(0).split(":")[0]
        if path not in files:
            files.append(path)
    return files


def scan_cases(root):
    """遍历案例库，返回用例记录列表（dict）。"""
    records = []
    for dirpath, dirnames, _filenames in os.walk(root):
        # 跳过 .live/.web 等机器目录
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        m = lib.CASE_DIR_RE.match(os.path.basename(dirpath))
        if not m:
            continue
        case_id, name = m.group(1), m.group(2)
        case_md = lib.parse_fields(lib.read_text(os.path.join(dirpath, "case.md")))
        status = lib.parse_status_md(os.path.join(dirpath, "status.md"))
        code_refs = case_md.get("依据代码", "")
        records.append({
            "id": case_id,
            "name": name,
            "dir": os.path.relpath(dirpath, root),
            "interface": case_md.get("接口", ""),
            "message_id": case_md.get("message_id", ""),
            "module": case_md.get("所属模块/功能", ""),
            "status": status["status"],
            "bug_report": status["bug_report"],
            "code_files": extract_code_files(code_refs),
            "code_refs": code_refs,
            "has_script": os.path.isfile(os.path.join(dirpath, lib.VERIFY_SCRIPT_NAME)),
        })
    records.sort(key=lambda r: r["id"])
    return records


def cmd_export(args):
    """导出 cases.jsonl：每行一个用例。"""
    root = args.root
    out = args.out or os.path.join(root, ".live", "cases.jsonl")
    records = scan_cases(root)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    os.replace(tmp, out)
    no_code = [r["id"] for r in records if not r["code_files"]]
    print(f"导出 {len(records)} 条用例 -> {out}")
    if no_code:
        print(f"警告：{len(no_code)} 条未提取到依据代码文件：{' '.join(no_code)}",
              file=sys.stderr)
    return 0


def _norm(path):
    """路径归一化：去 ./ 前缀、统一分隔符。"""
    return path.replace("\\", "/").lstrip("./")


def _match_level(case_file, changed):
    """匹配等级：path=路径后缀匹配（可靠）；name=仅同名（需人工确认）；无匹配返回 None。"""
    cf, ch = _norm(case_file), _norm(changed)
    if cf == ch or ch.endswith("/" + cf) or cf.endswith("/" + ch):
        return "path"
    if os.path.basename(cf) == os.path.basename(ch):
        return "name"
    return None


def cmd_retest_candidates(args):
    """按变更文件列表粗筛候选复测用例。"""
    records = scan_cases(args.root)
    hits = []
    for rec in records:
        matched = {}  # changed_file -> level
        for case_file in rec["code_files"]:
            for changed in args.files:
                level = _match_level(case_file, changed)
                if level and matched.get(changed) != "path":
                    matched[changed] = level
        if matched:
            hits.append((rec, matched))
    if getattr(args, "semantic", False):
        # RAG 语义重排（可选）：配置存在时按混合检索序输出；不可用保持原序（离线默认）
        try:
            import rag
            if rag.load_config():
                ranked = {r["id"]: i for i, r in
                          enumerate(rag.retrieve(args.root, "\n".join(args.files), k=30))}
                hits.sort(key=lambda pair: ranked.get(pair[0]["id"], 10 ** 9))
        except Exception:
            pass
    if args.json:
        print(json.dumps([
            {**rec, "matched": matched} for rec, matched in hits
        ], ensure_ascii=False, indent=2))
    else:
        for rec, matched in hits:
            files = ", ".join(f"{f}({lv})" for f, lv in sorted(matched.items()))
            print(f"{rec['id']} [{rec['status']}] {rec['dir']}  <- {files}")
        print(f"共 {len(hits)} 条候选（path=路径匹配，name=仅同名需确认）",
              file=sys.stderr)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_export = sub.add_parser("export", help="导出 .live/cases.jsonl 派生索引")
    p_export.add_argument("root", help="案例库根目录")
    p_export.add_argument("--out", help="输出路径（默认 <root>/.live/cases.jsonl）")
    p_export.set_defaults(func=cmd_export)

    p_retest = sub.add_parser("retest-candidates", help="按变更文件粗筛候选复测用例")
    p_retest.add_argument("root", help="案例库根目录")
    p_retest.add_argument("files", nargs="+", help="变更文件列表（如 git diff 涉及文件）")
    p_retest.add_argument("--json", action="store_true", help="以 JSON 输出")
    p_retest.add_argument("--semantic", action="store_true",
                          help="配置 RAG 时按语义检索重排候选输出")
    p_retest.set_defaults(func=cmd_retest_candidates)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

