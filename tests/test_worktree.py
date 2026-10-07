# 独立 worktree 模块单测（2026-10-06 批次）：
# 真 git 仓库（tmp 目录）验证 —— 创建/复用幂等、非 git 仓库报错、路径回退、
# 脏工作树拒绝清理、相对指针归一后仍可用、目录被手删后自愈
# （设计：doc_ai/plan/202610/20261006_0115_看板卡片独立worktree执行（开始按钮下拉+免排队）.md）
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest

import worktree


def _git(*args, cwd):
    """测试内跑 git（与产品代码同款 `git -C`；作者身份经环境变量给，不写用户 git config）。"""
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    return subprocess.run(["git", "-C", cwd] + list(args), capture_output=True,
                          text=True, env=env)


@pytest.fixture()
def repo(tmp_path):
    """建一个含一次提交的临时 git 仓库，返回 (项目字典, 仓库路径)。"""
    root = tmp_path / "repo"
    root.mkdir()
    _git("init", "-q", ".", cwd=str(root))
    _git("commit", "-q", "--allow-empty", "-m", "init", cwd=str(root))
    proj = {"project_dir": str(root), "work_dir": str(tmp_path / "work")}
    return proj, str(root)


def test_create_and_reuse_idempotent(repo):
    """首次创建：落 `<work_dir>/worktrees/card_<id>`、检出 `ts/card-<id>`；
    二次调用幂等复用（同路径同分支，不报错）——打回续改/失败重按开始依赖这条。"""
    proj, root = repo
    path, branch, err = worktree.create(proj, 830)
    assert err == "" and branch == "ts/card-830"
    assert path == os.path.join(proj["work_dir"], "worktrees", "card_830")
    assert os.path.isdir(path)
    assert _git("rev-parse", "--abbrev-ref", "HEAD", cwd=path).stdout.strip() == branch

    path2, branch2, err2 = worktree.create(proj, 830)
    assert (path2, branch2, err2) == (path, branch, "")


def test_pointers_normalized_to_relative(repo):
    """跨平台指针归一：`.git` 与 admin `gitdir` 都写成相对路径，且 git 仍能解析
    （Linux 建的 worktree 在 Windows git 下不可用，plan §2.5）。"""
    proj, root = repo
    path, _branch, err = worktree.create(proj, 831)
    assert err == ""
    gitfile = open(os.path.join(path, ".git"), encoding="utf-8").read().strip()
    assert gitfile.startswith("gitdir: ") and not os.path.isabs(gitfile[8:])
    admin_gitdir = os.path.join(root, ".git", "worktrees", "card_831", "gitdir")
    body = open(admin_gitdir, encoding="utf-8").read().strip()
    assert body and not os.path.isabs(body)
    # 归一是「美化」不是「改坏」：改写后 git 仍认得这棵工作树
    assert _git("rev-parse", "--show-toplevel", cwd=path).returncode == 0


def test_preview_and_fallback_path(repo):
    """预览不落盘；work_dir 落在仓库内部时回退到仓库同级 `.touchstone-worktrees/`
    （worktree 不得建在仓库内部）。"""
    proj, root = repo
    pv = worktree.preview(proj, 832)
    assert pv["ok"] and pv["path"] == os.path.join(proj["work_dir"], "worktrees", "card_832")
    assert pv["exists"] is False and pv["branch"] == "ts/card-832"

    inner = {"project_dir": root, "work_dir": os.path.join(root, ".touchstone")}
    pv2 = worktree.preview(inner, 832)
    assert pv2["ok"]
    assert pv2["path"] == os.path.join(os.path.dirname(root),
                                       worktree.FALLBACK_DIRNAME, "repo_card_832")
    assert not worktree._inside(pv2["path"], root)      # 回退路径确在仓库外


def test_non_repo_reports_error(tmp_path):
    """非 git 仓库：预览 ok=False（给中文原因）、创建返回错误串（不抛异常）。"""
    proj = {"project_dir": str(tmp_path / "plain"), "work_dir": str(tmp_path / "work")}
    os.makedirs(proj["project_dir"])
    pv = worktree.preview(proj, 833)
    assert pv["ok"] is False and "不是 git 仓库" in pv["error"]
    path, branch, err = worktree.create(proj, 833)
    assert path == "" and branch == "" and "不是 git 仓库" in err


def test_remove_requires_clean_tree(repo):
    """清理只在工作树干净时允许；脏工作树拒绝（绝不 --force），清理后分支保留。"""
    proj, root = repo
    path, _b, err = worktree.create(proj, 834)
    assert err == ""
    card = {"id": 834, "worktree": path}
    open(os.path.join(path, "dirty.txt"), "w").write("x")
    assert worktree.status(proj, card)["dirty"] is True
    ok, err = worktree.remove(proj, card)
    assert ok is False and "未提交" in err
    os.remove(os.path.join(path, "dirty.txt"))
    ok, err = worktree.remove(proj, card)
    assert ok is True and err == ""
    assert not os.path.isdir(path)
    # 分支保留（提交可能还没回流，删分支要 reflog 才找得回 —— plan D8）
    assert "ts/card-834" in _git("branch", "--list", "ts/card-834", cwd=root).stdout


def test_recreate_after_manual_delete(repo):
    """用户手删工作树目录后：下次创建自愈——重新 add 并检出既有分支（保留既往提交）。"""
    proj, _root = repo
    path, branch, err = worktree.create(proj, 835)
    assert err == ""
    shutil.rmtree(path)
    path2, branch2, err2 = worktree.create(proj, 835)
    assert err2 == "" and path2 == path and branch2 == branch


def test_path_occupied_reports_error(repo):
    """目标路径被非工作树内容占用：明确报错，不擅自删用户目录。"""
    proj, _root = repo
    path = worktree.worktree_path(proj, 836, worktree.repo_root(proj["project_dir"])[0])
    os.makedirs(path)
    open(os.path.join(path, "keep.txt"), "w").write("user data")
    _p, _b, err = worktree.create(proj, 836)
    assert "已存在" in err and os.path.exists(os.path.join(path, "keep.txt"))


# ---------- 合并就绪度（「通过」前的待合并判定，2026-10-07 批次） ----------


def test_merge_status_counts_ahead_behind_dirty(repo):
    """merge_status：target=主仓库当前分支；ahead=分支还没回流的提交数；
    dirty/dirty_count 取工作树未提交改动（含未跟踪）——这三项就是「通过」时
    要不要弹合并交接框的全部依据。"""
    proj, root = repo
    target = _git("rev-parse", "--abbrev-ref", "HEAD", cwd=root).stdout.strip()
    path, branch, err = worktree.create(proj, 840)
    assert err == ""
    card = {"id": 840, "worktree": path}
    st = worktree.merge_status(proj, card)
    assert st["ok"] is True and st["target"] == target and st["branch"] == branch
    assert st["ahead"] == 0 and st["behind"] == 0 and st["dirty"] is False
    # 工作树里提交一次：ahead=1（改动还没回流主分支）
    open(os.path.join(path, "f.txt"), "w").write("card work\n")
    _git("add", "-A", cwd=path)
    _git("commit", "-q", "-m", "card change", cwd=path)
    st = worktree.merge_status(proj, card)
    assert st["ok"] is True and st["ahead"] == 1 and st["behind"] == 0
    # 未提交改动（含未跟踪文件）计入 dirty_count，但不改变 ahead
    open(os.path.join(path, "wip.txt"), "w").write("wip\n")
    st = worktree.merge_status(proj, card)
    assert st["dirty"] is True and st["dirty_count"] == 1 and st["ahead"] == 1
    assert st["path"] == path


def test_merge_status_zero_after_branch_merged_back(repo):
    """分支回流主分支后 ahead=0 —— 用户第二次点「通过」时平台据此直接完成。"""
    proj, root = repo
    path, branch, err = worktree.create(proj, 841)
    assert err == ""
    open(os.path.join(path, "f.txt"), "w").write("card work\n")
    _git("add", "-A", cwd=path)
    _git("commit", "-q", "-m", "card change", cwd=path)
    assert worktree.merge_status(proj, {"id": 841, "worktree": path})["ahead"] == 1
    # 快进回流（主分支没前进过，必成）——测试里只做 ff，平台侧同样不执行合并
    r = _git("merge", "--ff-only", branch, cwd=root)
    assert r.returncode == 0, r.stderr
    st = worktree.merge_status(proj, {"id": 841, "worktree": path})
    assert st["ahead"] == 0 and st["behind"] == 0


def test_merge_status_without_worktree_marker(repo):
    """非 worktree 卡（标记为空）：ok=False + 中文原因，调用方按「不拦用户」处置。"""
    proj, _root = repo
    st = worktree.merge_status(proj, {"id": 842, "worktree": ""})
    assert st["ok"] is False and "没有独立 worktree" in st["error"]
    assert st["ahead"] == 0


def test_merge_status_deleted_worktree_dir(repo):
    """工作树目录被用户手删：不抛异常，ok=False 带原因（「通过」不被卡住）。"""
    proj, _root = repo
    path, _branch, err = worktree.create(proj, 843)
    assert err == ""
    shutil.rmtree(path)
    st = worktree.merge_status(proj, {"id": 843, "worktree": path})
    assert st["ok"] is False and "不存在" in st["error"]


def test_merge_status_detached_head(repo):
    """主仓库处于游离 HEAD：判定失败并给中文原因（不猜 master/main）。"""
    proj, root = repo
    path, _branch, err = worktree.create(proj, 844)
    assert err == ""
    r = _git("checkout", "--detach", cwd=root)
    assert r.returncode == 0, r.stderr
    st = worktree.merge_status(proj, {"id": 844, "worktree": path})
    assert st["ok"] is False and "游离 HEAD" in st["error"]
