#!/usr/bin/env python3
"""dsh 插件客户端的两条静态守卫（快层，2026-10-09 批次）。

守卫一 —— **引用的宿主 token 必须真实存在**。背景是真机 bug：侧栏入口写
`color: var(--dsw-alias-text-l1, #e8e8e8)`，而 dsh 里**没有** `--dsw-alias-text-l1`
这族 token（真实族是 `--dsw-alias-label-primary/secondary/tertiary/...`）。`var()` 取不到
就静默吃 fallback —— 于是浅色档在 `#f9fafb` 的侧栏底上画 `#e8e8e8` 的字（Playwright
真机实测对比度 **1.172**，同排其它侧栏行 18.082），深色档碰巧能看所以一直没人发现。
这类拼错不报错、不变红，只在某一档变糊，必须静态钉住：把 `dsh-plugin/src/client.js`
里出现的每个 `var(--dsw-…|--dsh-…)` 与 dsh 安装里**定义过**的 token 名对账。

守卫二 —— **提交进仓的 client.bundle.js 必须与 src/client.js 同源**。bundle 是产物但入
了库（安装包只带 lib/，装机副本又是一层拷贝），改了 src 忘了 `node scripts/build.mjs`
就会「源码是对的、用户装到的还是旧的」——本批的 bug 正是这么一路带到真机的。

dsh 安装定位（三条都落空即 SKIP —— 别的机器/CI 没装 dsh 不该红）:
  1. 环境变量 `TS_DSH_PACKAGE_ROOTS`（os.pathsep 分隔；每个根下直接是各 `@deepseek-ai` 包）
  2. `~/.dsh/profiles/*/node_modules/@deepseek-ai`
  3. `shutil.which('dsh')` 所在 node 安装的 `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`
"""
import functools
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_DIR = os.path.join(REPO_ROOT, "dsh-plugin")
CLIENT_SRC = os.path.join(PLUGIN_DIR, "src", "client.js")
CLIENT_BUNDLE = os.path.join(PLUGIN_DIR, "lib", "client.bundle.js")

# 只认 dsh 自己的两族宿主 token（--dsw-* 设计平台 / --dsh-* 宿主间接层）
TOKEN_DEF_RE = re.compile(rb"--(?:dsw|dsh)-[a-z0-9-]+\s*:")
TOKEN_REF_RE = re.compile(r"var\(\s*(--(?:dsw|dsh)-[a-z0-9-]+)")
_SCAN_EXT = {".js", ".css", ".mjs", ".cjs", ".html"}


# 「dsh 安装」的四个候选尾巴: 从 dsh 可执行文件所在目录逐级上溯试这些相对路径
# （2026-10-09 实测: dsh 的真实布局是 `<node>/lib/node_modules/@deepseek-ai/dsh/
#  node_modules/@deepseek-ai/*` —— realpath 会落到 `<...>/dsh/lib/bin.js`，
#  故必须上溯到 `<...>/dsh` 再拼 `node_modules/@deepseek-ai`，不能只看两级）。
_INSTALL_TAILS = (
    "node_modules/@deepseek-ai",
    "lib/node_modules/@deepseek-ai",
    "node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai",
    "lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai",
)


def _uniq(paths):
    """去重（按 realpath），保持发现顺序。"""
    seen, out = set(), []
    for p in paths:
        real = os.path.realpath(p)
        if real not in seen:
            seen.add(real)
            out.append(p)
    return out


@functools.lru_cache(maxsize=1)
def _dsh_package_roots():
    """dsh 各 `@deepseek-ai/*` 包所在目录（探测不到返回空表 ⇒ 上游用例 SKIP）。

    优先取**真正装着 dsh 的那棵**（含 `@deepseek-ai/dsh` 子目录的根），profile 里的
    散装包目录只在没有 dsh 安装时兜底 —— token 是否存在的权威是**运行中的那个 dsh**。
    """
    explicit = [c for c in (os.environ.get("TS_DSH_PACKAGE_ROOTS") or "").split(os.pathsep)
                if c and os.path.isdir(c)]
    if explicit:
        return _uniq(explicit)

    candidates = []
    exe = shutil.which("dsh")
    if exe:
        here = os.path.dirname(os.path.realpath(exe))
        for _ in range(6):  # 逐级上溯（realpath 可能落在 dsh/lib/bin.js 这类深路径）
            for tail in _INSTALL_TAILS:
                candidates.append(os.path.join(here, tail))
            parent = os.path.dirname(here)
            if parent == here:
                break
            here = parent

    profiles = os.path.expanduser("~/.dsh/profiles")
    if os.path.isdir(profiles):
        bases = [profiles] + [os.path.join(profiles, n) for n in sorted(os.listdir(profiles))]
        candidates += [os.path.join(b, "node_modules", "@deepseek-ai") for b in bases]

    installs = [c for c in candidates if os.path.isdir(os.path.join(c, "dsh"))]
    if installs:
        return _uniq(installs)
    loose = [c for c in candidates if os.path.isdir(c)]
    return _uniq(loose)


@functools.lru_cache(maxsize=1)
def _defined_dsh_tokens():
    """dsh 安装里定义过的全部 `--dsw-*` / `--dsh-*` token 名（约 45MB 源码，实测 0.15s）。"""
    found = set()
    for root in _dsh_package_roots():
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d != ".git"]
            for name in filenames:
                if os.path.splitext(name)[1] not in _SCAN_EXT:
                    continue
                try:
                    with open(os.path.join(dirpath, name), "rb") as fh:
                        data = fh.read()
                except OSError:
                    continue
                # 先做字节级子串快筛，命中才 regex（45MB 全量也只要 0.15s）
                if b"--dsw-" not in data and b"--dsh-" not in data:
                    continue
                found.update(m.group(0)[:-1].decode() for m in TOKEN_DEF_RE.finditer(data))
    return found


def _strip_js_comments(text):
    """去掉 JS 注释后再找 token 引用：注释里为记录 bug 而写下的旧 token 名不算「引用」。

    只处理块注释 `/* */` 与**整行** `//` 注释（本仓插件客户端的注释都是整行式）；
    行尾注释里的 token 名仍会被算作引用，属可接受的保守偏差。
    """
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return "\n".join("" if ln.lstrip().startswith("//") else ln for ln in text.split("\n"))


def _client_refs():
    """插件客户端源码里引用的宿主 token 名集合（已剔除注释）。"""
    with open(CLIENT_SRC, encoding="utf-8") as fh:
        return set(TOKEN_REF_RE.findall(_strip_js_comments(fh.read())))


def test_plugin_client_dsw_tokens_are_defined_by_dsh():
    """插件客户端引用的每个宿主 token 都必须在 dsh 安装里定义过。

    引用未定义 token 的后果是**静默**的：`var()` 落到 fallback，只有某一档主题会变糊
    （2026-10-09 真机 bug 就是这么来的），故此处直接 FAIL 并点名 token。
    """
    roots = _dsh_package_roots()
    if not roots:
        pytest.skip("未找到 dsh 安装（TS_DSH_PACKAGE_ROOTS / ~/.dsh/profiles / which dsh）")
    defined = _defined_dsh_tokens()
    if not defined:
        pytest.skip(f"dsh 安装里没扫到任何 --dsw-/--dsh- token 定义: {roots}")

    refs = _client_refs()
    assert refs, "dsh-plugin/src/client.js 里没有解析到任何宿主 token 引用（口径失效?）"
    missing = sorted(refs - defined)
    assert not missing, (
        "dsh-plugin/src/client.js 引用了 dsh 里不存在的宿主 token（var() 会静默吃 fallback，"
        f"明暗某一档必然变糊）: {missing}\n"
        f"（已扫 {len(defined)} 个 dsh 定义 token，扫描根: {roots}）"
    )


def test_plugin_client_bundle_matches_source():
    """入仓的 lib/client.bundle.js 必须与 src/client.js 的当前内容一致（产物不许滞后）。"""
    node = shutil.which("node")
    if not node:
        pytest.skip("无 node，跳过 bundle 同步校验")
    if not os.path.isfile(CLIENT_BUNDLE):
        pytest.fail(f"缺 lib/client.bundle.js（先跑 node scripts/build.mjs）: {CLIENT_BUNDLE}")

    # build.mjs 的路径推导: root=scripts 的上级(=dsh-plugin), 读 ../package.json 与 src/client.js,
    # 写 lib/client.bundle.js —— 故在临时目录里搭同构骨架即可得到「本应有」的产物字节。
    with tempfile.TemporaryDirectory() as tmp:
        plug = os.path.join(tmp, "dsh-plugin")
        os.makedirs(os.path.join(plug, "scripts"))
        os.makedirs(os.path.join(plug, "src"))
        os.makedirs(os.path.join(plug, "lib"))
        shutil.copy2(os.path.join(PLUGIN_DIR, "scripts", "build.mjs"),
                     os.path.join(plug, "scripts", "build.mjs"))
        shutil.copy2(CLIENT_SRC, os.path.join(plug, "src", "client.js"))
        shutil.copy2(os.path.join(REPO_ROOT, "package.json"), os.path.join(tmp, "package.json"))
        proc = subprocess.run([node, os.path.join(plug, "scripts", "build.mjs")],
                              capture_output=True, text=True, timeout=120)
        assert proc.returncode == 0, f"build.mjs 失败: {proc.stderr or proc.stdout}"
        with open(os.path.join(plug, "lib", "client.bundle.js"), "rb") as fh:
            fresh = fh.read()
    with open(CLIENT_BUNDLE, "rb") as fh:
        committed = fh.read()
    assert committed == fresh, (
        "dsh-plugin/lib/client.bundle.js 与 src/client.js 不同步"
        "（改了源码要跑 node dsh-plugin/scripts/build.mjs 重新生成并提交）"
    )
