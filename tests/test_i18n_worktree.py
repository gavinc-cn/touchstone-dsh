#!/usr/bin/env python3
"""Task 4（KB-03）：`worktree.py` 用户可见固定中文 + preview reason 的双语验收。

覆盖三件事（与 `backend/test/i18n-worktree.test.mjs` 逐条镜像）：
  ① **zh 零 churn**：缺省 `lang`（或显式 zh）时 `repo_root` / `preview` / `create` /
     `status` / `remove` / `merge_status` 的返回串与改动前逐字节相同（golden 为改前实测）；
  ② **en 全量**：每条固定模板（含 preview 的两条 reason）按 `lang="en"` 渲染英文；
     动态内容（git stderr、路径、异常原文）**原样保留**，只翻外层骨架；
  ③ **端点级**：真隔离实例上 `X-TS-Lang: en` 的 GET preview / DELETE cleanup（400）/
     POST merge（400）正文英文；无头（zh）正文逐字节仍是旧中文。
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest

import board
import worktree
from serverfixture import Api, IsolatedServer


def _git(*args, cwd):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    return subprocess.run(["git", "-C", cwd] + list(args), capture_output=True,
                          text=True, env=env)


@pytest.fixture()
def repo(tmp_path):
    """含一次提交的临时 git 仓库（真 git，验 head_branch/merge_status 的语言传播）。"""
    root = tmp_path / "repo"
    root.mkdir()
    _git("init", "-q", "-b", "main", ".", cwd=str(root))
    _git("commit", "-q", "--allow-empty", "-m", "init", cwd=str(root))
    proj = {"project_dir": str(root), "work_dir": str(tmp_path / "work")}
    return proj, str(root)


@pytest.fixture()
def plain(tmp_path):
    """存在但**不是** git 仓库的项目目录。"""
    d = tmp_path / "plain"
    d.mkdir()
    proj = {"project_dir": str(d), "work_dir": str(tmp_path / "work")}
    return proj, str(d)


# --------------------------------------------------------------------------
# ① zh golden（改前实测）+ ② en：固定模板逐条
# --------------------------------------------------------------------------

def test_repo_root_zh_golden_and_en(plain):
    proj, d = plain
    missing = os.path.join(d, "nope")
    # zh golden：改前实测（`repo_root` 的固定文案；缺失路径的动态部分原样）
    assert worktree.repo_root("") == (None, "项目目录为空")
    assert worktree.repo_root(missing) == (None, "项目目录不存在: " + missing)
    assert worktree.repo_root(d)[0] is None
    assert worktree.repo_root(d)[1].startswith("fatal: not a git repository")
    # 显式 lang="zh" 与缺省逐字节相同
    assert worktree.repo_root("", "zh") == worktree.repo_root("")
    # en：骨架英文，路径动态部分原样
    assert worktree.repo_root("", "en") == (None, "Project directory is empty")
    assert worktree.repo_root(missing, "en") == (
        None, "Project directory does not exist: " + missing)
    en_err = worktree.repo_root(d, "en")[1]
    assert en_err.startswith("fatal: not a git repository")


def test_preview_and_create_non_repo_zh_golden_and_en(plain):
    proj, d = plain
    detail = worktree.repo_root(d)[1]
    assert worktree.preview(proj, 3) == {
        "ok": False, "error": "项目目录不是 git 仓库（%s）" % detail,
        "path": "", "branch": "ts/card-3", "exists": False, "root": ""}
    assert worktree.create(proj, 3) == (
        "", "", "无法创建 worktree：项目目录不是 git 仓库（%s）" % detail)
    # en
    assert worktree.preview(proj, 3, "en")["error"] == \
        "Project directory is not a git repository (%s)" % detail
    assert worktree.create(proj, 3, "en")[2] == \
        "Cannot create worktree: project directory is not a git repository (%s)" % detail


def test_status_remove_merge_fixed_errors_zh_and_en(tmp_path):
    proj = {"project_dir": str(tmp_path / "plain"), "work_dir": str(tmp_path / "work")}
    os.makedirs(proj["project_dir"])
    missing = str(tmp_path / "missing")
    no_wt = {"id": 3, "worktree": ""}
    gone = {"id": 3, "worktree": missing}

    # zh golden（改前实测）
    assert worktree.status(proj, no_wt)["error"] == "该卡片没有独立 worktree"
    assert worktree.status(proj, gone)["error"] == "worktree 目录不存在"
    assert worktree.remove(proj, no_wt) == (False, "该卡片没有独立 worktree")
    assert worktree.remove(proj, gone) == (False, "worktree 目录不存在")
    assert worktree.merge_status(proj, no_wt)["error"] == "该卡片没有独立 worktree"
    assert worktree.merge_status(proj, gone)["error"] == "worktree 目录不存在"
    # en
    assert worktree.status(proj, no_wt, "en")["error"] == \
        "This card has no standalone worktree"
    assert worktree.status(proj, gone, "en")["error"] == \
        "The worktree directory does not exist"
    assert worktree.remove(proj, no_wt, "en") == \
        (False, "This card has no standalone worktree")
    assert worktree.remove(proj, gone, "en") == \
        (False, "The worktree directory does not exist")
    assert worktree.merge_status(proj, no_wt, "en")["error"] == \
        "This card has no standalone worktree"
    assert worktree.merge_status(proj, gone, "en")["error"] == \
        "The worktree directory does not exist"


def test_git_unavailable_detail_is_translated_skeleton_only(monkeypatch, tmp_path):
    """`git 不可用: {detail}`：骨架按语言渲染，`OSError` 原文保持原样。"""
    def boom(*_a, **_k):
        raise OSError("no git binary")

    monkeypatch.setattr(worktree.subprocess, "run", boom)
    assert worktree._git([], str(tmp_path)) == (-1, "", "git 不可用: no git binary")
    assert worktree._git([], str(tmp_path), lang="en") == \
        (-1, "", "git is unavailable: no git binary")
    # 语言沿内部递归透传：repo_root → _git
    assert worktree.repo_root(str(tmp_path), "en")[1] == "git is unavailable: no git binary"


def test_detached_head_translated(repo):
    proj, root = repo
    _git("checkout", "-q", "--detach", cwd=root)
    assert worktree.head_branch(root) == (
        "", "主仓库处于游离 HEAD 状态，无法判定主分支")
    assert worktree.head_branch(root, "en") == (
        "", "The main repository is on a detached HEAD; the main branch cannot be determined")
    # merge_status 把 head_branch 的错误原样透出（语言已由上一跳决定）
    wt = os.path.join(proj["work_dir"], "worktrees", "card_5")
    os.makedirs(wt, exist_ok=True)
    st = worktree.merge_status(proj, {"id": 5, "worktree": wt}, "en")
    assert st["ok"] is False and "detached HEAD" in st["error"]


def test_worktree_preview_reasons_zh_and_en(plain):
    proj, _d = plain
    card_wt = {"id": 5, "worktree": "/tmp/wt-x", "session_id": ""}
    card_sess = {"id": 6, "worktree": "", "session_id": "sid"}
    # zh golden（改前实测；缺省 lang 与显式 zh 相同）
    assert board.worktree_preview(proj, card_wt)["reason"] == "该卡片已在独立 worktree 中运行"
    assert board.worktree_preview(proj, card_sess)["reason"] == \
        "该卡片已有主会话，不能切换到独立 worktree（请新建卡片）"
    assert board.worktree_preview(proj, card_wt, "zh")["reason"] == \
        "该卡片已在独立 worktree 中运行"
    # en
    assert board.worktree_preview(proj, card_wt, "en")["reason"] == \
        "This card is already running in a standalone worktree"
    assert board.worktree_preview(proj, card_sess, "en")["reason"] == \
        "This card already has a main session and cannot switch to a standalone worktree" \
        " (create a new card)"


def test_cleanup_and_handoff_pass_lang_down(monkeypatch, tmp_path):
    """调用链把请求语言透传给 worktree 层（cleanup → remove / handoff → merge_status）。"""
    proj = {"project_dir": str(tmp_path), "work_dir": str(tmp_path)}
    seen = []

    def fake_remove(project, card, lang="zh"):
        seen.append(("remove", lang))
        return False, "boom"

    def fake_merge(project, card, lang="zh"):
        seen.append(("merge_status", lang))
        return {"ok": False, "error": "boom"}

    monkeypatch.setattr(worktree, "remove", fake_remove)
    monkeypatch.setattr(worktree, "merge_status", fake_merge)
    assert board.cleanup_card_worktree(proj, {"id": 1, "worktree": "/x"}, "en") == (False, "boom")
    carrier = board.handoff_worktree_merge(
        proj, {"id": 1, "worktree": "/x", "session_id": "sid"}, "en")[1]
    assert carrier["error"] == {"message": "无法判定待合并提交：{detail}",
                                "vars": {"detail": "boom"}}
    assert seen == [("remove", "en"), ("merge_status", "en")]


# --------------------------------------------------------------------------
# ③ 端点级（真隔离实例）：GET preview / DELETE cleanup / POST merge
# --------------------------------------------------------------------------

@pytest.fixture(scope="module")
def srv():
    instance = IsolatedServer()
    try:
        instance.start()
        yield instance
    finally:
        instance.stop()


def _new_client(srv, headers=None):
    api = Api(srv.base, headers=headers)
    code, d = api.json("/api/auth/login", "POST",
                       {"username": "admin", "password": srv.admin_pw})
    assert code == 200, f"登录失败: {code} {d}"
    return api


def _new_card(api, pid):
    code, text = api(f"/api/projects/{pid}/board/cards", "POST", {"title": "wt-i18n"})
    assert code == 200, text
    return json.loads(text)["id"]


def test_endpoint_preview_cleanup_merge_bilingual(srv):
    pid = srv.create_project(srv.admin, "i18n-worktree")
    cid = _new_card(srv.admin, pid)
    preview = f"/api/projects/{pid}/board/cards/{cid}/worktree"
    cleanup = preview
    merge = preview + "/merge"

    # ①② zh 无头：preview 的 reason 是改前的「固定骨架 + git stderr 原文」
    detail = worktree.repo_root(srv.proj_dir)[1]
    code, text = srv.admin(preview)
    assert code == 200
    assert json.loads(text)["reason"] == "项目目录不是 git 仓库（%s）" % detail
    code, text = srv.admin(cleanup, "DELETE")
    assert (code, text) == (400, '{"error": "该卡片没有独立 worktree"}')
    code, text = srv.admin(merge, "POST", {})
    assert (code, text) == (400, '{"error": "该卡片尚无主会话，无法交给 agent 合并"}')

    # en：同三条路径
    en = _new_client(srv, {"X-TS-Lang": "en"})
    code, text = en(preview)
    assert code == 200
    assert json.loads(text)["reason"] == \
        "Project directory is not a git repository (%s)" % detail
    code, text = en(cleanup, "DELETE")
    assert (code, text) == (400, '{"error": "This card has no standalone worktree"}')
    code, text = en(merge, "POST", {})
    assert (code, text) == \
        (400, '{"error": "This card has no main session yet, so the merge cannot be '
              'handed to an agent"}')
