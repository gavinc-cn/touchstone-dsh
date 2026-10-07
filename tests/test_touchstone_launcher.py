"""touchstone.py 启停器「按需 npm install / 按需 npm run build」逻辑单测。

覆盖 deps_fingerprint / npm_install_needed / write_install_stamp 三件套：
node_modules 或戳缺失、依赖清单（package.json + package-lock.json）变化、
TS_FORCE_INSTALL=1 强制时判「需要安装」；指纹算法与 touchstone.sh 的 shell
管道（cat 清单 | md5sum）逐位一致，保证两个启动器共用同一枚戳文件互通。

另覆盖 build_fingerprint / build_needed / write_build_stamp 三件套（2026-09-28
构建按需跳过）：dist 或戳缺失、src 源码变化、TS_FORCE_BUILD=1 强制、npm install
待执行时判「需要构建」；构建指纹（src 树 + 顶层构建配置，路径行+内容拼接 md5）
同样与 touchstone.sh 管道逐位一致（戳文件 webui/dist/.touchstone-build-stamp 互通）。
纯文件系统打桩（tmp_path），不触网、不跑 npm。
"""

import hashlib
import os
import shutil
import subprocess

import pytest

import touchstone


def _make_webui(tmp_path, pkg='{"name":"x"}', lock='{"lockfileVersion":3}'):
    """造一个带最小依赖清单的 webui 目录，返回其路径。"""
    webui = tmp_path / "webui"
    webui.mkdir()
    (webui / "package.json").write_text(pkg, encoding="utf-8")
    (webui / "package-lock.json").write_text(lock, encoding="utf-8")
    return webui


def test_fingerprint_changes_with_lockfile(tmp_path):
    """lockfile 内容变化 ⇒ 指纹变化（按需重装的判定来源）。"""
    webui = _make_webui(tmp_path)
    fp1 = touchstone.deps_fingerprint(str(webui))
    (webui / "package-lock.json").write_text('{"lockfileVersion":3,"x":1}',
                                             encoding="utf-8")
    assert touchstone.deps_fingerprint(str(webui)) != fp1


def test_fingerprint_is_concat_md5(tmp_path):
    """指纹 = package.json + package-lock.json 字节顺序拼接的 md5 hex。"""
    webui = _make_webui(tmp_path)
    expect = hashlib.md5(
        (webui / "package.json").read_bytes()
        + (webui / "package-lock.json").read_bytes()
    ).hexdigest()
    assert touchstone.deps_fingerprint(str(webui)) == expect


def test_fingerprint_missing_files_ok(tmp_path):
    """清单文件缺失不炸：全缺返回空串，部分缺失按存在的文件算。"""
    webui = tmp_path / "empty"
    webui.mkdir()
    assert touchstone.deps_fingerprint(str(webui)) == ""
    (webui / "package.json").write_text("{}", encoding="utf-8")
    assert touchstone.deps_fingerprint(str(webui)) == hashlib.md5(b"{}").hexdigest()


def test_fingerprint_matches_bash_pipeline(tmp_path):
    """与 touchstone.sh 的 `cat 清单 | md5sum` 管道同值——两启动器戳互通的前提。"""
    if shutil.which("md5sum") is None:
        pytest.skip("无 md5sum（非 Linux 环境）")
    webui = _make_webui(tmp_path)
    out = subprocess.run("cat package.json package-lock.json | md5sum",
                         shell=True, cwd=str(webui),
                         capture_output=True, text=True, check=True)
    assert touchstone.deps_fingerprint(str(webui)) == out.stdout.split()[0]


def test_install_needed_without_node_modules(tmp_path):
    """node_modules 缺失（首启/被删）⇒ 必须安装。"""
    webui = _make_webui(tmp_path)
    assert touchstone.npm_install_needed(str(webui)) is True


def test_install_needed_when_stamp_missing(tmp_path):
    """node_modules 在但无戳（老环境首次升级到该机制）⇒ 安装一次补戳。"""
    webui = _make_webui(tmp_path)
    os.makedirs(webui / "node_modules")
    assert touchstone.npm_install_needed(str(webui)) is True


def test_install_not_needed_fresh_after_stamp(tmp_path):
    """装完写戳、依赖未变 ⇒ 跳过安装（本需求的主路径）。"""
    webui = _make_webui(tmp_path)
    os.makedirs(webui / "node_modules")
    touchstone.write_install_stamp(str(webui))
    assert touchstone.npm_install_needed(str(webui)) is False


def test_install_needed_after_dep_change(tmp_path):
    """写过戳后 package.json 变更 ⇒ 指纹失配，重新安装。"""
    webui = _make_webui(tmp_path)
    os.makedirs(webui / "node_modules")
    touchstone.write_install_stamp(str(webui))
    (webui / "package.json").write_text('{"name":"x","dep":"^1"}',
                                        encoding="utf-8")
    assert touchstone.npm_install_needed(str(webui)) is True


def test_install_needed_force_env(tmp_path, monkeypatch):
    """TS_FORCE_INSTALL=1 强制安装；其他值不触发。"""
    webui = _make_webui(tmp_path)
    os.makedirs(webui / "node_modules")
    touchstone.write_install_stamp(str(webui))
    monkeypatch.setenv("TS_FORCE_INSTALL", "1")
    assert touchstone.npm_install_needed(str(webui)) is True
    monkeypatch.setenv("TS_FORCE_INSTALL", "0")
    assert touchstone.npm_install_needed(str(webui)) is False


# ---------- 构建按需跳过（build_fingerprint / build_needed / write_build_stamp） ----------


def _make_webui_src(tmp_path):
    """造一个带 src 树 + 顶层构建配置的 webui 目录，返回其路径。

    结构: index.html / vite.config.js / package.json / components.json /
    src/main.jsx / src/components/a.jsx（嵌套目录 + 多文件，验排序与递归）。"""
    webui = _make_webui(tmp_path)
    (webui / "index.html").write_text("<html></html>", encoding="utf-8")
    (webui / "vite.config.js").write_text("export default {}", encoding="utf-8")
    (webui / "components.json").write_text("{}", encoding="utf-8")
    (webui / "src" / "components").mkdir(parents=True)
    (webui / "src" / "main.jsx").write_text("console.log(1)", encoding="utf-8")
    (webui / "src" / "components" / "a.jsx").write_text("export const a=1",
                                                        encoding="utf-8")
    return webui


def test_build_fingerprint_changes_with_src(tmp_path):
    """src 内任一文件内容变化 ⇒ 构建指纹变化（按需重建的判定来源）。"""
    webui = _make_webui_src(tmp_path)
    fp1 = touchstone.build_fingerprint(str(webui))
    (webui / "src" / "components" / "a.jsx").write_text("export const a=2",
                                                        encoding="utf-8")
    assert touchstone.build_fingerprint(str(webui)) != fp1


def test_build_fingerprint_is_md5_of_paths_and_contents(tmp_path):
    """指纹 = 排序后（webui 相对路径 + 换行 + 文件字节）顺序拼接的 md5 hex。

    该格式就是 sh/py 戳互通的硬约定，本用例钉死，两侧实现漂移即红。"""
    webui = _make_webui_src(tmp_path)
    expect = hashlib.md5(
        b"components.json\n" + (webui / "components.json").read_bytes()
        + b"index.html\n" + (webui / "index.html").read_bytes()
        + b"package.json\n" + (webui / "package.json").read_bytes()
        + b"src/components/a.jsx\n" + (webui / "src" / "components" / "a.jsx").read_bytes()
        + b"src/main.jsx\n" + (webui / "src" / "main.jsx").read_bytes()
        + b"vite.config.js\n" + (webui / "vite.config.js").read_bytes()
    ).hexdigest()
    assert touchstone.build_fingerprint(str(webui)) == expect


def test_build_fingerprint_empty_tree_ok(tmp_path):
    """src 与顶层配置全缺不炸：返回空串（调用方按「需构建」处理）。"""
    webui = tmp_path / "empty"
    webui.mkdir()
    assert touchstone.build_fingerprint(str(webui)) == ""


def test_build_fingerprint_matches_bash_pipeline(tmp_path):
    """与 touchstone.sh 的 find/sort/while/md5sum 管道同值——两启动器戳互通的前提。"""
    if shutil.which("md5sum") is None:
        pytest.skip("无 md5sum（非 Linux 环境）")
    webui = _make_webui_src(tmp_path)
    pipeline = (
        "{ find src -type f;"
        " for f in components.json index.html package.json vite.config.js; do"
        ' [ -f "$f" ] && printf \'%s\\n\' "$f"; done; }'
        " | LC_ALL=C sort"
        ' | while IFS= read -r f; do printf \'%s\\n\' "$f"; cat "$f"; done'
        " | md5sum"
    )
    out = subprocess.run(pipeline, shell=True, cwd=str(webui),
                         capture_output=True, text=True, check=True)
    assert touchstone.build_fingerprint(str(webui)) == out.stdout.split()[0]


def test_build_needed_without_dist(tmp_path):
    """dist/index.html 缺失（首启/dist 被删）⇒ 必须构建。"""
    webui = _make_webui_src(tmp_path)
    assert touchstone.build_needed(str(webui)) is True


def test_build_not_needed_fresh_after_stamp(tmp_path):
    """构建过写戳、源码与依赖均未变 ⇒ 跳过构建（本需求的主路径）。"""
    webui = _make_webui_src(tmp_path)
    (webui / "dist").mkdir()
    (webui / "dist" / "index.html").write_text("<html></html>", encoding="utf-8")
    os.makedirs(webui / "node_modules")
    touchstone.write_install_stamp(str(webui))
    touchstone.write_build_stamp(str(webui))
    assert touchstone.build_needed(str(webui)) is False


def test_build_needed_after_src_change(tmp_path):
    """写过构建戳后 src 变更 ⇒ 指纹失配，重新构建。"""
    webui = _make_webui_src(tmp_path)
    (webui / "dist").mkdir()
    (webui / "dist" / "index.html").write_text("<html></html>", encoding="utf-8")
    os.makedirs(webui / "node_modules")
    touchstone.write_install_stamp(str(webui))
    touchstone.write_build_stamp(str(webui))
    (webui / "src" / "main.jsx").write_text("console.log(2)", encoding="utf-8")
    assert touchstone.build_needed(str(webui)) is True


def test_build_needed_when_stamp_missing(tmp_path):
    """dist 在但无构建戳（老环境首次升级到该机制）⇒ 构建一次补戳。"""
    webui = _make_webui_src(tmp_path)
    (webui / "dist").mkdir()
    (webui / "dist" / "index.html").write_text("<html></html>", encoding="utf-8")
    os.makedirs(webui / "node_modules")
    touchstone.write_install_stamp(str(webui))
    assert touchstone.build_needed(str(webui)) is True


def test_build_needed_when_install_pending(tmp_path):
    """npm install 待执行（如 node_modules 被删）⇒ 连带重建，不放心旧 dist。"""
    webui = _make_webui_src(tmp_path)
    (webui / "dist").mkdir()
    (webui / "dist" / "index.html").write_text("<html></html>", encoding="utf-8")
    touchstone.write_build_stamp(str(webui))
    assert touchstone.build_needed(str(webui)) is True


def test_build_needed_force_env(tmp_path, monkeypatch):
    """TS_FORCE_BUILD=1 强制重建；其他值不触发。"""
    webui = _make_webui_src(tmp_path)
    (webui / "dist").mkdir()
    (webui / "dist" / "index.html").write_text("<html></html>", encoding="utf-8")
    os.makedirs(webui / "node_modules")
    touchstone.write_install_stamp(str(webui))
    touchstone.write_build_stamp(str(webui))
    monkeypatch.setenv("TS_FORCE_BUILD", "1")
    assert touchstone.build_needed(str(webui)) is True
    monkeypatch.setenv("TS_FORCE_BUILD", "0")
    assert touchstone.build_needed(str(webui)) is False


# ---------- 前端单测入口（vitest 直连包入口，不经 .bin 影子链接） ----------


def test_frontend_test_ready_needs_vitest_entry(tmp_path, monkeypatch):
    """就绪判定认「vitest 包入口文件」：光有 node_modules 目录 / test script 不算。

    背景（2026-10-06）：本仓库 webui/node_modules 是从 Windows 侧拷贝来的，npm 建的
    bin 符号链接被展平成同名文件拷贝（`.bin/vitest` 的内容就是 `vitest.mjs`），从
    `.bin/` 解析其相对导入 `./dist/cli.js` 必然 ERR_MODULE_NOT_FOUND ⇒ 就绪判定与
    调用都改走包入口（理由与修复记录见 doc_ai/spec/platform/启停脚本与按需构建.md）。
    """
    monkeypatch.setattr(touchstone, "ROOT", str(tmp_path))
    webui = _make_webui(tmp_path, pkg='{"scripts":{"test":"vitest run"}}')

    assert touchstone.frontend_test_ready() is False   # 有 package.json 但依赖未装
    os.makedirs(webui / "node_modules" / "vitest")
    assert touchstone.frontend_test_ready() is False   # 目录在、入口文件缺
    (webui / "node_modules" / "vitest" / "vitest.mjs").write_text("", encoding="utf-8")
    assert touchstone.frontend_test_ready() is True    # 入口在 ⇒ 就绪

    (webui / "package.json").write_text('{"scripts":{}}', encoding="utf-8")
    assert touchstone.frontend_test_ready() is False   # 无 test script 仍不跑


def test_both_launchers_run_vitest_entry_not_bin_shim():
    """sh / py 两侧都直连 vitest 包入口（两入口行为对齐的硬约定），不再走 npm test。

    直连包入口是对「bin 链接被展平成文件拷贝」这一环境事实的规避：任一侧写回
    `npm test`（其 `vitest run` 要经 `.bin` 链接解析）本用例即红。"""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "touchstone.sh"), encoding="utf-8") as f:
        sh = f.read()
    with open(os.path.join(root, "touchstone.py"), encoding="utf-8") as f:
        py = f.read()

    # 两侧各自的调用形态：sh 字面量命令行 / py 常量 + node 可执行
    assert "(cd webui && node node_modules/vitest/vitest.mjs run)" in sh
    assert 'subprocess.run([find_node(), VITEST_ENTRY, "run"]' in py
    # py 侧入口常量与 sh 侧字面量同值（Windows 上 os.sep 为反斜杠，归一后比较）
    assert touchstone.VITEST_ENTRY.replace(os.sep, "/") == "node_modules/vitest/vitest.mjs"
    assert "npm test" not in sh and "npm test" not in py
