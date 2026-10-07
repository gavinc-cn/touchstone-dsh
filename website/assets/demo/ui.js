/* ==========================================================================
   Touchstone 在线 Demo —— 界面层（渲染 + 交互）
   设计语境与维护约定见 website/README.md

   渲染策略（为什么不是每次 tick 全量重绘）：
   - 结构级变化（切页/开关弹窗/选中项）→ render()：把 #app 整体重画一次；
   - 心跳级变化（排队徽标、会话条目、监控数字）→ sync()：只重画签名字符串变了的
     区域（[data-r] 容器），并在替换前记住焦点元素的 data-fk，替换后还原焦点，
     避免打字时丢光标。
   两条纪律：sync 期间不碰拖拽中的看板（拖拽自带本地预览态）；输入框的值一律先
   进 state 再渲染（draft 字段），不让 DOM 成为唯一数据源。
   ========================================================================== */
(function () {
  'use strict';

  var E = window.TS_ENGINE;
  var T = window.T;
  var app = document.getElementById('app');
  var layer = document.getElementById('layer');
  var coachEl = document.getElementById('coach');
  var toastEl = document.getElementById('toast');

  var dragging = { id: null, over: null };   // 拖拽中的卡片与悬停列

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function S() { return E.state; }
  function UI() { return E.state.ui; }
  function cls() { return Array.prototype.slice.call(arguments).filter(Boolean).join(' '); }
  function st(patch) { E.act.ui(patch); }
  function act(name, data) { return 'data-act="' + name + '"' + (data ? ' ' + data : ''); }

  /* 排队徽标（文案口径与 queueBadge.js 一致） */
  function queueChip(state) {
    var label = T('board.queueStates.' + state) || '';
    if (!label) return '';
    var tone = (state === 'running' || state === 'starting') ? 'run' : 'retest';
    return '<span class="bug-status ' + tone + '">' + esc(label) + '</span>';
  }
  function qsOfCard(c) { return E.q.queueStateOf(c); }

  /* ======================================================================
     一、登录页
     ====================================================================== */
  function viewLogin() {
    return '' +
      '<div class="dlogin">' +
        '<form class="dlogin-card" data-act="loginForm">' +
          '<div class="dlogin-logo">' + logoSvg(38) + '</div>' +
          '<div class="dlogin-title">' + esc(T('login.title')) + '</div>' +
          '<div class="dlogin-desc">' + esc(T('login.desc')) + '</div>' +
          '<label class="dfield"><span>' + esc(T('login.username')) + '</span>' +
            '<input name="u" value="demo" placeholder="' + esc(T('login.phUser')) + '" autocomplete="username"></label>' +
          '<label class="dfield"><span>' + esc(T('login.password')) + '</span>' +
            '<input name="p" type="password" value="demo" placeholder="' + esc(T('login.phPass')) + '" autocomplete="current-password"></label>' +
          '<button class="dbtn dbtn-primary dbtn-block" type="submit">' + esc(T('login.submit')) + '</button>' +
          '<p class="dlogin-note">' + esc(T('login.note')) + '</p>' +
          '<p class="dlogin-demo">' + esc(T('login.demoHint')) + '</p>' +
        '</form>' +
        '<div class="dlogin-side">' +
          '<h1 class="dlogin-h1">' + esc(T('legend.title')) + '</h1>' +
          '<ul class="dlegend-list">' + T('legend.coveredItems').map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
          '<h2 class="dlogin-h2">' + esc(T('legend.notCovered')) + '</h2>' +
          '<ul class="dlegend-list dim">' + T('legend.notCoveredItems').map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
          (window.TS_LANG === 'en' ? '<p class="dlogin-langnote">' + esc(T('legend.langNote')) + '</p>' : '') +
          '<p class="dlogin-langnote">' + esc(T('legend.resetNote')) + '</p>' +
        '</div>' +
      '</div>';
  }
  function logoSvg(size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" fill-rule="evenodd" d="M8.6 3H15.4A5.6 5.6 0 0 1 21 8.6V15.4A5.6 5.6 0 0 1 15.4 21H8.6A5.6 5.6 0 0 1 3 15.4V8.6A5.6 5.6 0 0 1 8.6 3Z' +
      ' M7.6 6.6H16.4V9.8H13.6V17.8H10.4V9.8H7.6Z"/></svg>';
  }

  /* ======================================================================
     二、应用外壳（侧栏 + 顶栏 + 标签页）
     ====================================================================== */
  function viewApp() {
    var s = S();
    var p = s.curProj;
    var body = p ? viewTab() : '<div class="dempty">' + esc(T('shell.pickProject')) + '</div>';
    return '' +
      '<div class="dshell">' +
        '<aside class="dside' + (UI().sideOpen ? ' open' : '') + '" data-r="side">' + sideHtml() + '</aside>' +
        '<div class="dmain">' +
          '<header class="dhead" data-r="head">' + headHtml() + '</header>' +
          '<nav class="dtabs" data-r="tabs">' + tabsHtml() + '</nav>' +
          '<div class="dbody" data-r="body">' + body + '</div>' +
        '</div>' +
      '</div>';
  }

  function sideHtml() {
    var s = S(), p = s.curProj;
    var counts = { doing: 0, blocked: 0, review: 0 };
    s.board.cards.forEach(function (c) { if (counts[c.column] !== undefined) counts[c.column]++; });
    return '' +
      '<div class="dside-brand">' + logoSvg(20) + '<b>Touchstone</b></div>' +
      '<div class="dside-sec">' +
        '<span>' + esc(T('shell.projectList')) + '</span>' +
        '<button type="button" class="dicon" ' + act('addProject') + ' title="' + esc(T('shell.addProject')) + '">＋</button>' +
      '</div>' +
      '<div class="dside-list">' +
        (s.projects.length ? s.projects.map(function (pr) {
          return '<button type="button" class="dproj' + (p && pr.id === p.id ? ' on' : '') + '" ' + act('pickProject', 'data-id="' + pr.id + '"') + '>' +
            '<span class="dproj-name">' + esc(pr.name) + '</span>' +
            '<span class="dproj-dir">' + esc(pr.project_dir) + '</span>' +
            '<span class="dproj-counts">' +
              '<i>' + esc(T('shell.counts.doing')) + ' <b>' + counts.doing + '</b></i>' +
              '<i>' + esc(T('shell.counts.blocked')) + ' <b>' + counts.blocked + '</b></i>' +
              '<i>' + esc(T('shell.counts.review')) + ' <b>' + counts.review + '</b></i>' +
            '</span></button>';
        }).join('') : '<div class="dside-empty">' + esc(T('shell.noProject')) + '</div>') +
      '</div>' +
      '<div class="dside-foot">' +
        '<span class="dside-user">' + esc(T('shell.user')) + '</span>' +
        '<button type="button" class="dside-link" ' + act('setScreen', 'data-k="settings"') + '>' + esc(T('shell.settings')) + '</button>' +
        '<button type="button" class="dside-link" ' + act('logout') + '>' + esc(T('shell.logout')) + '</button>' +
      '</div>';
  }

  function headHtml() {
    var s = S(), p = s.curProj;
    return '' +
      '<button type="button" class="dicon dbars" ' + act('toggleSide') + ' aria-label="menu">☰</button>' +
      '<h2 class="dhead-name">' + esc(p ? p.name : T('shell.noProject')) + '</h2>' +
      (p && p.archived ? '<span class="bug-status pending">' + esc(T('shell.archivedTag')) + '</span>' : '') +
      '<span class="dhead-gap"></span>' +
      (p ? '<button type="button" class="dbtn dbtn-ghost" ' + act('editProject') + '>' + esc(T('shell.editProject')) + '</button>' +
           '<button type="button" class="dbtn dbtn-ghost" ' + act('archiveProject') + '>' + esc(T('shell.archiveProject')) + '</button>' : '') +
      '<button type="button" class="dbtn dbtn-primary" ' + act('addProject') + '>' + esc(T('shell.addProject')) + '</button>';
  }

  function tabsHtml() {
    var s = S();
    var keys = ['board', 'tasks', 'stress', 'monitor', 'bugs'];
    return keys.map(function (k) {
      return '<button type="button" class="dtab' + (s.tab === k ? ' on' : '') + '" ' + act('tab', 'data-k="' + k + '"') + '>' + esc(T('shell.tabs.' + k)) + '</button>';
    }).join('');
  }

  function viewTab() {
    var s = S();
    if (s.tab === 'board') return viewBoard();
    if (s.tab === 'tasks') return viewTasks();
    if (s.tab === 'stress') return viewStress();
    if (s.tab === 'monitor') return viewMonitor();
    if (s.tab === 'bugs') return viewBugs();
    return '';
  }

  /* ======================================================================
     三、开发看板
     ====================================================================== */
  var COLS = ['todo', 'doing', 'blocked', 'review', 'done'];

  function viewBoard() {
    return '' +
      '<div class="dtool" data-r="board-tool">' + boardToolHtml() + '</div>' +
      '<div class="dboard" data-r="board-cols">' + boardColsHtml() + '</div>';
  }

  function boardToolHtml() {
    var s = S();
    return '' +
      '<span class="dtool-title">' + esc(T('board.title')) + '</span>' +
      '<span class="bug-status pending">' + esc(T('board.mode.' + s.board.mode)) + '</span>' +
      '<span class="dtool-gap"></span>' +
      '<input class="dinput dsearch" id="boardSearch" value="' + esc(s.board.search) + '" placeholder="' + esc(T('board.searchPh')) + '" ' + act('noop') + ' data-input="search">' +
      '<button type="button" class="dbtn dbtn-ghost" ' + act('boardSettings') + '>⚙ ' + esc(T('board.settings')) + '</button>' +
      '<button type="button" class="dbtn dbtn-ghost" ' + act('openTrash') + ' title="' + esc(T('board.trash')) + '">🗑 ' + esc(T('board.trash')) + '</button>';
  }

  function matchCard(c) {
    var q = (S().board.search || '').trim().toLowerCase();
    if (!q) return true;
    return (c.title + ' ' + c.description + ' ' + (c.jira || '')).toLowerCase().indexOf(q) >= 0;
  }

  function boardColsHtml() {
    var s = S();
    return COLS.map(function (col) {
      var flt = s.board.filters[col] || 'all';
      var cards = flt === 'test' ? [] : E.q.cardsOf(col).filter(matchCard);
      var tasks = (col === 'doing' || col === 'review' || col === 'done') && flt !== 'dev'
        ? E.q.taskEntriesOf(col) : [];
      /* doing 列：运行位区在前、等待区在后（组内保持队序 = 服务端下发序） */
      var runList = col === 'doing' ? cards.filter(function (c) { var q = qsOfCard(c); return q === 'running' || q === 'starting'; }) : [];
      var waitList = col === 'doing' ? cards.filter(function (c) { var q = qsOfCard(c); return q !== 'running' && q !== 'starting'; }) : [];
      var list = col === 'doing' ? runList.concat(waitList) : sortCards(cards, col);
      var waitStart = (col === 'doing' && runList.length && waitList.length) ? runList.length : -1;
      var body = '';
      tasks.forEach(function (tk) { body += taskEntryHtml(tk); });
      list.forEach(function (c, i) {
        if (waitStart === i) body += '<div class="board-runzone"><span>' + esc(T('board.runzone')) + '</span></div>';
        body += cardHtml(c);
      });
      if (!body) body = '<div class="dcol-empty">' + esc(flt === 'all' ? T('board.emptyCol') : T('board.allFiltered')) + '</div>';
      var quick = col === 'todo' ?
        '<div class="dquick">' +
          '<textarea class="dquick-ta" data-input="quick" rows="2" placeholder="' + esc(T('board.quickAddPh')) + '"></textarea>' +
          '<button type="button" class="dquick-add" ' + act('quickAdd') + ' title="' + esc(T('board.quickAddPh')) + '">＋</button>' +
        '</div>' : '';
      return '' +
        '<section class="board-col' + (dragging.over === col ? ' dragover' : '') + '" data-col="' + col + '">' +
          '<div class="board-col-head">' +
            '<span class="board-col-name">' + esc(T('board.cols.' + col)) + '</span>' +
            '<span class="board-col-count">' + list.length + '</span>' +
            '<select class="board-col-sel" data-sel="filter" data-col="' + col + '" title="' + esc(T('board.filters.all')) + '">' +
              ['all', 'dev', 'test'].map(function (v) {
                return '<option value="' + v + '"' + (flt === v ? ' selected' : '') + '>' + esc(T('board.filters.' + v)) + '</option>';
              }).join('') +
            '</select>' +
            (col !== 'doing' ? '<select class="board-col-sel" data-sel="sort" data-col="' + col + '" title="' + esc(T('board.sorts.manual')) + '">' +
              (col === 'done' ? ['entered_desc'] : []).concat(['manual', 'created_desc', 'updated_desc', 'title']).map(function (v) {
                var cur = s.board.sorts[col] || (col === 'done' ? 'entered_desc' : 'manual');
                return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + esc(T('board.sorts.' + v)) + '</option>';
              }).join('') + '</select>' : '') +
          '</div>' +
          '<div class="board-col-body" data-drop="' + col + '">' + body + '</div>' +
          quick +
        '</section>';
    }).join('');
  }

  function sortCards(cards, col) {
    var mode = S().board.sorts[col] || 'manual';
    var arr = cards.slice();
    if (mode === 'title') arr.sort(function (a, b) { return a.title.localeCompare(b.title); });
    else if (mode === 'created_desc') arr.sort(function (a, b) { return b.id - a.id; });
    else if (mode === 'updated_desc') arr.sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
    else arr.sort(function (a, b) { return a.order - b.order; });
    return arr;
  }

  /* 测试任务条目（只读，不能拖；映射口径与 board._TASK_BOARD_COLUMN 一致） */
  function taskEntryHtml(tk) {
    var stCls = tk.status === 'running' ? 'run' : (tk.status === 'queued' ? 'pending' : (tk.status === 'done' ? 'pass' : 'retest'));
    return '' +
      '<div class="board-task" ' + act('taskSession', 'data-id="' + tk.id + '"') + ' title="' + esc(T('tasks.ops.session')) + '">' +
        '<div class="board-card-title">' + esc(tk.name) + '</div>' +
        '<div class="board-card-badges">' +
          '<span class="board-card-id">' + esc(T('board.taskChip')) + tk.id + '</span>' +
          '<span class="bug-status ' + stCls + '">' + esc(T('tasks.stPrefix')) + esc(T('tasks.st.' + tk.status)) + '</span>' +
          '<span class="bug-status pending">' + esc(T('tasks.type.' + tk.task_type)) + '</span>' +
          (tk.current_round > 0 ? '<span class="bug-status pending">' + esc(T('monitor.round')) + tk.current_round + esc(T('monitor.roundEnd')) + '</span>' : '') +
        '</div>' +
        (tk.error ? '<div class="board-card-err">' + esc(tk.error) + '</div>' : '') +
      '</div>';
  }

  /* 卡面（DOM 顺序对齐 BoardTab：标题 → 描述 → 徽标行 → 错误行 → 操作行） */
  function cardHtml(c) {
    var q = qsOfCard(c);
    var badges = '';
    if (c.unread) badges += '<span class="board-card-new" title="' + esc(T('board.badgeNew')) + '">' + esc(T('board.badgeNew')) + '</span>';
    badges += '<span class="board-card-id" title="' + esc(T('board.detailTitle')) + '">#' + c.id + '</span>';
    badges += queueChip(q);
    if (c.worktree) badges += '<span class="bug-status pending" title="' + esc(c.worktree) + '">' + esc(T('board.badgeWorktree')) + '</span>';
    if (c.scheduled_at) badges += '<span class="bug-status pending">⏰ ' + esc(c.scheduled_at) + '</span>';
    if (c.parent) badges += '<span class="bug-status pending">' + esc(T('board.badgeDep')) + c.parent + '</span>';
    if (c.blockKind === 'interaction') badges += '<span class="bug-status interaction" title="' + esc(T('session.ask.waiting')) + '">' + esc(c.blockText || T('board.badgeWait')) + '</span>';
    if (c.blockKind === 'manual') badges += '<span class="bug-status retest">' + esc(T('board.badgeManual')) + '</span>';
    if (c.origin === 'sync') badges += '<span class="bug-status pending">' + esc(T('board.badgeSync')) + '</span>';
    if (c.jira) badges += '<span class="bug-status pending">' + esc(c.jira) + '</span>';

    var editing = UI().cardEdit === c.id;
    var titleHtml = editing
      ? '<textarea class="board-card-edit" data-input="titleEdit" rows="2">' + esc(UI().cardEditText) + '</textarea>'
      : '<div class="board-card-title" title="单击编辑标题" ' + act('cardEditTitle', 'data-id="' + c.id + '"') + '>' + (esc(c.title) || '<span class="dim">' + esc(T('board.newCard')) + '</span>') + '</div>';
    var descHtml = (!editing && c.description) ? '<div class="board-card-desc">' + esc(c.description) + '</div>' : '';

    return '' +
      '<article class="board-card col-' + c.column + (c.running ? ' is-run' : '') + (q === 'queued_serial' || q === 'answer_pending' ? ' is-wait' : '') + (dragging.id === c.id ? ' is-drag' : '') + '"' +
        ' draggable="true" data-card="' + c.id + '" data-sel="card">' +
        titleHtml + descHtml +
        '<div class="board-card-badges">' + badges + '</div>' +
        (c.last_error ? '<div class="board-card-err">' + esc(c.last_error) + '</div>' : '') +
        '<div class="board-card-ops">' + cardOpsHtml(c, q) + '</div>' +
      '</article>';
  }

  function cardOpsHtml(c, q) {
    var b = [];
    var icon = function (name, glyph, title, data) {
      return '<button type="button" class="dicon" title="' + esc(title) + '" ' + act(name, data) + '>' + glyph + '</button>';
    };
    if (c.column === 'todo') {
      b.push('<span class="board-split">' +
        '<button type="button" class="dbtn dbtn-sm dbtn-primary" ' + act('cardStart', 'data-id="' + c.id + '"') + '>▶ ' + esc(T('board.start')) + '</button>' +
        '<button type="button" class="dbtn dbtn-sm dbtn-primary dsplit" title="' + esc(T('board.moreStart')) + '" ' + act('startMenu', 'data-id="' + c.id + '"') + '>▾</button>' +
      '</span>');
    }
    if (c.column === 'doing' && !c.running && c.blockKind !== 'queue') {
      b.push('<button type="button" class="dbtn dbtn-sm" ' + act('cardReview', 'data-id="' + c.id + '"') + '>→ ' + esc(T('board.toReview')) + '</button>');
    }
    if (c.column === 'blocked') {
      b.push('<button type="button" class="dbtn dbtn-sm" ' + act('cardRetry', 'data-id="' + c.id + '"') + '>▶ ' + esc(T('board.retry')) + '</button>');
    }
    if (c.answerPending) {
      b.push('<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('cardDeliver', 'data-id="' + c.id + '"') + '>' + esc(T('board.deliver')) + '</button>');
    }
    if (c.blockKind === 'queue' && !c.answerPending) {
      b.push('<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('cardForce', 'data-id="' + c.id + '"') + '>' + esc(T('board.force')) + '</button>');
    }
    if (c.blockKind === 'queue') {
      b.push('<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('cardStop', 'data-id="' + c.id + '"') + '>' + esc(T('board.stop')) + '</button>');
    }
    if (c.column === 'review') {
      b.push('<button type="button" class="dbtn dbtn-sm dbtn-primary" ' + act('cardPass', 'data-id="' + c.id + '"') + '>✓ ' + esc(T('board.pass')) + '</button>');
      b.push('<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('cardRejectOpen', 'data-id="' + c.id + '"') + '>↩ ' + esc(T('board.reject')) + '</button>');
    }
    if (c.column === 'done') {
      b.push('<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('cardReopen', 'data-id="' + c.id + '"') + '>↩ ' + esc(T('board.reopen')) + '</button>');
    }
    b.push('<span class="board-ops-gap"></span>');
    b.push(icon('cardDetail', '⤢', T('board.openDetail'), 'data-id="' + c.id + '"'));
    b.push(icon('cardTrash', '🗑', T('board.delCard'), 'data-id="' + c.id + '"'));
    b.push('<button type="button" class="dicon' + (c.session_id ? '' : ' dis') + '" title="' + esc(c.session_id ? T('board.enterSession') : T('board.noSession')) + '" ' +
      (c.session_id ? act('cardSession', 'data-id="' + c.id + '"') : 'disabled') + '>💬</button>');
    return b.join('');
  }

  /* ======================================================================
     四、测试任务
     ====================================================================== */
  function viewTasks() {
    var s = S(), p = s.curProj;
    return '' +
      '<section class="dcard">' +
        '<h3 class="dcard-h">' + esc(T('tasks.projectInfo')) + '</h3>' +
        '<dl class="dkv">' +
          '<dt>' + esc(T('shell.projDir')) + '</dt><dd class="mono">' + esc(p.project_dir) + '</dd>' +
          '<dt>' + esc(T('proj.agent')) + '</dt><dd>' + esc(T('proj.agentVal')) + '</dd>' +
          '<dt>' + esc(T('shell.workDir')) + '</dt><dd class="mono">' + esc(p.work_dir) + '</dd>' +
          '<dt>' + esc(T('shell.envTag')) + '</dt><dd>' + esc(p.env_tag || T('common.dash')) + '</dd>' +
        '</dl>' +
        '<p class="dhint">' + esc(p.guide_text) + '</p>' +
      '</section>' +
      '<section class="dcard">' +
        '<div class="dcard-hrow">' +
          '<h3 class="dcard-h">' + esc(T('tasks.list')) + '</h3>' +
          '<span class="dtool-gap"></span>' +
          '<input class="dinput dsearch" data-input="taskSearch" placeholder="' + esc(T('tasks.searchPh')) + '">' +
          '<button type="button" class="dbtn dbtn-primary" ' + act('newTask') + '>＋ ' + esc(T('tasks.newTask')) + '</button>' +
        '</div>' +
        '<div data-r="task-list">' + taskListHtml() + '</div>' +
      '</section>';
  }

  function taskListHtml() {
    var s = S();
    var q = (UI().taskSearch || '').trim().toLowerCase();
    var list = s.tasks.filter(function (tk) { return !q || (tk.name + ' ' + (tk.session_id || '')).toLowerCase().indexOf(q) >= 0; });
    if (!s.tasks.length) return '<div class="dempty">' + esc(T('tasks.empty')) + '</div>';
    if (!list.length) return '<div class="dempty">' + esc(T('tasks.noMatch')) + '</div>';
    var rows = list.map(function (tk) {
      var open = UI().taskOpen === tk.id;
      return '' +
        '<tr class="' + (open ? 'open' : '') + '">' +
          '<td><button type="button" class="dlink" ' + act('taskToggle', 'data-id="' + tk.id + '"') + '>' + esc(tk.name) + '</button>' +
            (tk.task_type !== 'normal' ? ' <span class="bug-status pending">' + esc(T('tasks.type.' + tk.task_type)) + '</span>' : '') +
            (tk.error ? ' <span class="tl-err">' + esc(tk.error) + '</span>' : '') + '</td>' +
          '<td><span class="bug-status ' + stCls(tk.status) + '">' + esc(T('tasks.st.' + tk.status)) + '</span></td>' +
          '<td class="mono">' + (tk.current_round || 0) + '</td>' +
          '<td class="mono">' + (tk.new_bugs || 0) + '</td>' +
          '<td class="mono dim">' + esc(shortTime(tk.created_at)) + '</td>' +
          '<td class="mono dim">' + esc(tk.ended_at ? shortTime(tk.ended_at) : T('common.dash')) + '</td>' +
          '<td class="dops">' +
            '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('taskSession', 'data-id="' + tk.id + '"') + '>' + esc(T('tasks.ops.session')) + '</button>' +
            (tk.status === 'running' || tk.status === 'queued' ? '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('taskStop', 'data-id="' + tk.id + '"') + '>' + esc(T('tasks.ops.stop')) + '</button>' : '') +
            ((tk.status === 'done' || tk.status === 'stopped' || tk.status === 'failed' || tk.status === 'interrupted') && tk.task_type !== 'stress'
              ? '<button type="button" class="dbtn dbtn-sm dbtn-ghost" title="' + esc(T('tasks.contTitle')) + '" ' + act('taskContinue', 'data-id="' + tk.id + '"') + '>' + esc(T('tasks.ops.cont')) + '</button>' : '') +
            ((tk.status === 'stopped' || tk.status === 'failed' || tk.status === 'interrupted' || (tk.task_type === 'stress' && tk.status === 'done'))
              ? '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('taskRestart', 'data-id="' + tk.id + '"') + '>' + esc(T('tasks.ops.restart')) + '</button>' : '') +
            '<button type="button" class="dbtn dbtn-sm dbtn-ghost" title="' + esc(T('tasks.delTitle')) + '" ' + act('taskDelete', 'data-id="' + tk.id + '"') + '>' + esc(T('tasks.ops.del')) + '</button>' +
          '</td>' +
        '</tr>' +
        (open ? '<tr class="drow-detail"><td colspan="7">' + taskDetailHtml(tk) + '</td></tr>' : '');
    }).join('');
    return '' +
      '<table class="dtable">' +
        '<thead><tr>' +
          '<th>' + esc(T('tasks.cols.name')) + '</th><th>' + esc(T('tasks.cols.status')) + '</th>' +
          '<th>' + esc(T('tasks.cols.rounds')) + '</th><th>' + esc(T('tasks.cols.newBug')) + '</th>' +
          '<th>' + esc(T('tasks.cols.created')) + '</th><th>' + esc(T('tasks.cols.ended')) + '</th>' +
          '<th>' + esc(T('tasks.cols.ops')) + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function stCls(status) {
    return status === 'running' ? 'run' : status === 'queued' ? 'pending'
      : status === 'done' ? 'pass' : status === 'failed' ? 'fix' : 'retest';
  }

  function taskDetailHtml(tk) {
    var d = T('tasks');
    var stage = tk.start_stage ? (stageLabel(tk.start_stage) + ' → ' + stageLabel(tk.end_stage)) : (d.stageDefault);
    var rounds = (tk.rounds || 0) > 0
      ? '<table class="dtable mini"><thead><tr><th>' + esc(d.rounds.round) + '</th><th>' + esc(d.rounds.status) + '</th><th>' + esc(d.rounds.exit) + '</th><th>' + esc(d.rounds.start) + '</th><th>' + esc(d.rounds.end) + '</th><th>' + esc(d.rounds.logs) + '</th></tr></thead><tbody>' +
        Array.apply(null, Array(tk.rounds)).map(function (_, i) {
          return '<tr><td class="mono">' + (i + 1) + '</td><td>' + esc(T('tasks.st.done')) + '</td><td class="mono">0</td>' +
            '<td class="mono dim">' + esc(shortTime(tk.started_at)) + '</td><td class="mono dim">' + esc(shortTime(tk.ended_at)) + '</td>' +
            '<td><button type="button" class="dlink" ' + act('taskLog', 'data-id="' + tk.id + '"') + '>' + esc(d.rounds.logs) + '</button></td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="dempty">' + esc(d.rounds.empty) + '</div>';
    return '' +
      '<div class="ddetail">' +
        '<div class="ddetail-h">' + esc(d.detail) + ' · ' + esc(tk.name) +
          '<span class="dtool-gap"></span>' +
          '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('taskToggle', 'data-id="' + tk.id + '"') + '>' + esc(T('board.close')) + '</button></div>' +
        '<dl class="dkv">' +
          '<dt>' + esc(d.f.status) + '</dt><dd>' + esc(T('tasks.st.' + tk.status)) + '</dd>' +
          '<dt>' + esc(d.f.type) + '</dt><dd>' + esc(T('tasks.type.' + tk.task_type)) + '</dd>' +
          '<dt>' + esc(d.f.stages) + '</dt><dd>' + esc(stage) + '</dd>' +
          (tk.parent_task_id ? '<dt>' + esc(d.f.parent) + '</dt><dd class="mono">#' + tk.parent_task_id + '</dd>' : '') +
          '<dt>' + esc(d.f.stop) + '</dt><dd>' + esc(stopText(tk)) + '</dd>' +
          '<dt>' + esc(d.f.autofix) + '</dt><dd>' + esc(tk.auto_fix ? T('common.on') : T('common.off')) + '</dd>' +
          '<dt>' + esc(d.f.retest) + '</dt><dd>' + esc(tk.retest) + '</dd>' +
          '<dt>' + esc(d.f.model) + '</dt><dd>' + esc(tk.model) + '</dd>' +
          '<dt>' + esc(d.f.sid) + '</dt><dd class="mono">' + esc(tk.session_id ? tk.session_id.slice(0, 20) : d.sidPending) + '</dd>' +
          '<dt>' + esc(d.f.round) + '</dt><dd class="mono">' + (tk.current_round || 0) + '</dd>' +
          '<dt>' + esc(d.f.newCases) + '</dt><dd class="mono">+' + (tk.new_cases || 0) + '</dd>' +
          '<dt>' + esc(d.f.newBugs) + '</dt><dd class="mono">' + (tk.new_bugs || 0) + '</dd>' +
          (tk.other ? '<dt>' + esc(d.f.extra) + '</dt><dd>' + esc(tk.other) + '</dd>' : '') +
        '</dl>' +
        '<h4 class="dsub">' + esc(d.rounds.round) + '</h4>' + rounds +
      '</div>';
  }

  function stageLabel(k) {
    var labels = { gen_case: '测试用例生成', execute: '测试', report: '生成报告', analyze: '报告分析', fix: '问题修复', deploy: '重新部署', retest: '复测' };
    return labels[k] || T('tasks.stageDefault');
  }
  function stopText(tk) {
    var L = T('tasks.stopLabel');
    if (tk.stop_type === 'rounds') return L.rounds + tk.stop_value + T('monitor.roundEnd');
    if (tk.stop_type === 'bugs') return L.bugs + tk.stop_value;
    return tk.stop_value;
  }
  function shortTime(s) { return s ? String(s).slice(5, 16) : T('common.dash'); }

  /* ======================================================================
     五、监控面板
     ====================================================================== */
  function viewMonitor() {
    var s = S();
    var stats = E.q.caseStats();
    return '' +
      '<div class="dmon-head" data-r="mon-head">' + monHeadHtml() + '</div>' +
      '<div class="dmon">' +
        '<section class="dcard">' +
          '<div class="dcard-hrow"><h3 class="dcard-h">' + esc(T('monitor.cases')) + '</h3>' +
            '<span class="dtool-gap"></span>' +
            '<span class="bug-status pass">' + esc(T('monitor.chip.pass')) + ' ' + stats.pass + '</span>' +
            '<span class="bug-status fix">' + esc(T('monitor.chip.fail')) + ' ' + stats.fail + '</span>' +
            '<span class="bug-status retest">' + esc(T('monitor.chip.retest')) + ' ' + stats.retest + '</span>' +
            '<span class="bug-status pending">' + esc(T('monitor.chip.pending')) + ' ' + stats.pending + '</span>' +
            '<span class="dim mono">' + esc(T('monitor.chip.total')) + stats.total + '</span>' +
          '</div>' +
          '<div class="dcases" data-r="mon-cases">' + monitorCasesHtml() + '</div>' +
        '</section>' +
        '<section class="dcard dmon-mid">' +
          '<div class="dcard-hrow"><h3 class="dcard-h">' + esc(monitorChartTitle()) + '</h3>' +
            '<span class="dtool-gap"></span>' +
            '<button type="button" class="dicon" ' + act('chartPrev') + '>‹</button>' +
            '<button type="button" class="dicon" ' + act('chartNext') + '>›</button>' +
          '</div>' +
          '<div class="dchart" data-r="mon-chart">' + monitorChartHtml() + '</div>' +
          '<div class="dmon-detail" data-r="mon-detail">' + monitorDetailHtml() + '</div>' +
        '</section>' +
      '</div>' +
      '<section class="dcard">' +
        '<div class="dcard-hrow"><h3 class="dcard-h">' + esc(T('monitor.events')) + '</h3>' +
          '<span class="dtool-gap"></span>' +
          ['all', 'fail', 'case', 'phase', 'bug'].map(function (f) {
            return '<button type="button" class="dchip' + (UI().eventFilter === f ? ' on' : '') + '" ' + act('evFilter', 'data-k="' + f + '"') + '>' + esc(T('monitor.filters.' + f)) + '</button>';
          }).join('') +
          '<label class="dcheck"><input type="checkbox" checked> ' + esc(T('monitor.autoScroll')) + '</label>' +
        '</div>' +
        '<div class="devents" data-r="mon-events">' + eventsHtml() + '</div>' +
      '</section>';
  }

  function monHeadHtml() {
    var s = S(), live = s.live;
    var pill = !live ? '<span class="live-pill idle">' + esc(T('monitor.idle')) + '</span>'
      : '<span class="live-pill run">' + esc((live.phaseLabel ? live.phaseLabel + ' · ' : '') + T('monitor.running')) + '</span>';
    return '<h3 class="dmon-title">' + esc(T('monitor.title')) + esc(s.curProj ? s.curProj.name : '') + '</h3>' + pill +
      (live ? '<span class="mono dim">' + esc(T('monitor.round') + live.round + T('monitor.roundEnd')) + '</span>' +
        '<span class="dim">' + esc(T('monitor.stopCond')) + esc(stopText(E.q.task(live.taskId) || {})) + '</span>' +
        '<span class="dim">' + esc(T('monitor.autofix')) + esc(s.tasks[0] && s.tasks[0].auto_fix ? T('monitor.on') : T('monitor.off')) + '</span>' : '') +
      '<span class="dtool-gap"></span>' +
      '<span class="dim mono">' + esc(T('monitor.updated') + E.q.fmtTime(s.now)) + '</span>';
  }

  function monitorCasesHtml() {
    var byMod = {};
    S().cases.forEach(function (c) { (byMod[c.mod] = byMod[c.mod] || []).push(c); });
    var out = Object.keys(byMod).map(function (m) {
      var list = byMod[m];
      var pass = list.filter(function (c) { return c.status === 'pass'; }).length;
      return '<div class="dmod"><div class="dmod-h"><b>' + esc(m) + '</b>' +
        '<span class="dim mono">' + pass + '/' + list.length + '</span></div>' +
        list.map(function (c) {
          return '<button type="button" class="dcase ' + c.status + (UI().monitorCase === c.id ? ' on' : '') + '" ' + act('monCase', 'data-id="' + c.id + '"') + '>' +
            '<span class="mono dim">' + c.id + '</span><span class="dcase-name">' + esc(c.name) + '</span>' +
            '<span class="dcase-dot ' + c.status + '"></span></button>';
        }).join('') + '</div>';
    }).join('');
    return out || '<div class="dempty">' + esc(T('monitor.casesEmpty')) + '</div>';
  }

  function monitorChartTitle() {
    var keys = ['cases', 'modulePass', 'rounds', 'bugStat', 'funnel'];
    return T('monitor.charts.' + keys[UI().monitorChart % keys.length]);
  }
  function monitorChartHtml() {
    var i = UI().monitorChart % 5;
    if (i === 0) return donutSvg();
    if (i === 1) return barsSvg();
    if (i === 2) return trendSvg();
    if (i === 3) return bugBarsSvg();
    return funnelSvg();
  }
  function donutSvg() {
    var s = E.q.caseStats();
    var total = Math.max(1, s.total);
    var segs = [['pass', s.pass, 'var(--pass)'], ['fail', s.fail, 'var(--fail)'], ['retest', s.retest, 'var(--retest)'], ['pending', s.pending, 'var(--steel)']];
    var off = 0, r = 54, C = 2 * Math.PI * r;
    var circles = segs.map(function (seg) {
      var frac = seg[1] / total;
      var el = '<circle r="' + r + '" cx="70" cy="70" fill="none" stroke="' + seg[2] + '" stroke-width="18" ' +
        'stroke-dasharray="' + (frac * C).toFixed(1) + ' ' + C.toFixed(1) + '" stroke-dashoffset="' + (-off * C).toFixed(1) + '" transform="rotate(-90 70 70)"/>';
      off += frac;
      return el;
    }).join('');
    var pct = Math.round(s.pass / total * 100);
    return '<svg viewBox="0 0 140 140" class="dsvg">' + circles +
      '<text x="70" y="66" text-anchor="middle" class="dsvg-big">' + pct + '%</text>' +
      '<text x="70" y="86" text-anchor="middle" class="dsvg-sub">' + esc(T('monitor.chartSub.passRate')) + '</text></svg>' +
      '<ul class="dlegend"><li><i style="background:var(--pass)"></i>' + esc(T('monitor.chip.pass')) + ' ' + s.pass + '</li>' +
      '<li><i style="background:var(--fail)"></i>' + esc(T('monitor.chip.fail')) + ' ' + s.fail + '</li>' +
      '<li><i style="background:var(--retest)"></i>' + esc(T('monitor.chip.retest')) + ' ' + s.retest + '</li>' +
      '<li><i style="background:var(--steel)"></i>' + esc(T('monitor.chip.pending')) + ' ' + s.pending + '</li></ul>';
  }
  function barsSvg() {
    var byMod = {};
    S().cases.forEach(function (c) { (byMod[c.mod] = byMod[c.mod] || []).push(c); });
    var mods = Object.keys(byMod);
    var h = 22, gap = 10, rows = mods.map(function (m, i) {
      var list = byMod[m];
      var pass = list.filter(function (c) { return c.status === 'pass'; }).length;
      var pct = Math.round(pass / list.length * 100);
      var y = i * (h + gap) + 6;
      return '<text x="0" y="' + (y + 12) + '" class="dsvg-sub">' + esc(m) + '</text>' +
        '<rect x="70" y="' + y + '" width="200" height="' + h + '" rx="4" fill="rgba(42,58,94,.6)"/>' +
        '<rect x="70" y="' + y + '" width="' + (pct * 2) + '" height="' + h + '" rx="4" fill="var(--pass)" opacity=".85"/>' +
        '<text x="284" y="' + (y + 15) + '" class="dsvg-sub">' + pass + '/' + list.length + '</text>';
    }).join('');
    return '<svg viewBox="0 0 330 ' + (mods.length * (h + gap) + 12) + '" class="dsvg wide">' + rows + '</svg>' +
      '<div class="dchart-sub">' + esc(T('monitor.chartSub.modules')) + '</div>';
  }
  function trendSvg() {
    var s = S();
    var pts = [1, 2].slice(0, Math.max(1, Math.min(2, s.tasks.filter(function (x) { return x.rounds; }).length || 1)));
    var series = [3, 5, 4, 7, 6, 8, 9].slice(0, 7);
    var max = Math.max.apply(null, series);
    var path = series.map(function (v, i) {
      return (i * 40 + 12) + ',' + (100 - v / max * 80);
    }).join(' ');
    return '<svg viewBox="0 0 280 120" class="dsvg wide">' +
      '<polyline points="' + path + '" fill="none" stroke="var(--star)" stroke-width="2"/>' +
      series.map(function (v, i) {
        return '<circle cx="' + (i * 40 + 12) + '" cy="' + (100 - v / max * 80) + '" r="3" fill="var(--star)"/>' +
          '<text x="' + (i * 40 + 12) + '" y="116" text-anchor="middle" class="dsvg-sub">R' + (i + 1) + '</text>';
      }).join('') + '</svg>';
  }
  function bugBarsSvg() {
    var s = S();
    var order = ['待分析', '已分析，待修复', '已修复（未验证）', '复测通过', '已拒绝'];
    var counts = order.map(function (k) { return s.bugs.filter(function (b) { return b.status === k; }).length; });
    var max = Math.max.apply(null, counts.concat([1]));
    return '<svg viewBox="0 0 300 120" class="dsvg wide">' + order.map(function (k, i) {
      var hgt = counts[i] / max * 80;
      var colors = ['var(--retest)', 'var(--star)', 'var(--run)', 'var(--pass)', 'var(--steel)'];
      return '<rect x="' + (i * 56 + 16) + '" y="' + (96 - hgt) + '" width="30" height="' + Math.max(2, hgt) + '" rx="3" fill="' + colors[i] + '"/>' +
        '<text x="' + (i * 56 + 31) + '" y="112" text-anchor="middle" class="dsvg-sub">' + counts[i] + '</text>';
    }).join('') + '</svg><div class="dchart-sub">' + esc(T('monitor.chartSub.total')) + s.bugs.length + '</div>';
  }
  function funnelSvg() {
    var s = S();
    var st = (s.live && s.live.stats) || { proposal: 12, stored: 9, executed: 9, pass: 6 };
    var steps = [['提案', st.proposal || 0], ['入库', st.stored || 0], ['执行', st.executed || 0], ['通过', st.pass || 0]];
    var max = Math.max(1, st.proposal || 1);
    return '<svg viewBox="0 0 300 130" class="dsvg wide">' + steps.map(function (sp, i) {
      var w = Math.max(12, sp[1] / max * 240);
      var y = i * 30 + 8;
      return '<rect x="' + (270 - w) + '" y="' + y + '" width="' + w + '" height="22" rx="4" fill="var(--run)" opacity="' + (0.35 + i * 0.16) + '"/>' +
        '<text x="0" y="' + (y + 15) + '" class="dsvg-sub">' + sp[0] + '</text>' +
        '<text x="276" y="' + (y + 15) + '" class="dsvg-sub">' + sp[1] + '</text>';
    }).join('') + '</svg>';
  }

  function monitorDetailHtml() {
    var id = UI().monitorCase;
    var c = null;
    S().cases.forEach(function (x) { if (x.id === id) c = x; });
    if (!c) return '<div class="dempty">' + esc(T('monitor.detailEmpty')) + '</div>';
    var running = S().live && S().live.currentCase === c.id;
    return '<h4 class="dsub">' + esc(T('monitor.detail')) + (running ? esc(T('monitor.detailCur')) : '') + '</h4>' +
      '<dl class="dkv">' +
        '<dt>' + esc(T('monitor.fields.id')) + '</dt><dd class="mono">' + c.id + '</dd>' +
        '<dt>' + esc(T('monitor.fields.name')) + '</dt><dd>' + esc(c.name) + '</dd>' +
        '<dt>' + esc(T('monitor.fields.point')) + '</dt><dd>' + esc(c.name) + '</dd>' +
        '<dt>' + esc(T('monitor.fields.status')) + '</dt><dd>' + esc(T('monitor.chip.' + c.status)) + '</dd>' +
        (c.status === 'fail' ? '<dt>' + esc(T('monitor.fields.reason')) + '</dt><dd>' + esc(c.note || '断言不符') + '</dd>' : '') +
        '<dt>' + esc(T('monitor.fields.summary')) + '</dt><dd>' + esc(c.status === 'pass' ? '断言全部满足' : c.status === 'fail' ? '断言不符，已聚类进 bug 报告' : c.status === 'retest' ? '待复测' : '尚未执行') + '</dd>' +
        '<dt>' + esc(T('monitor.fields.last')) + '</dt><dd class="mono">' + esc(c.last) + '</dd>' +
        '<dt>' + esc(T('monitor.fields.bug')) + '</dt><dd class="mono">' + esc(c.bug || T('common.dash')) + '</dd>' +
      '</dl>';
  }

  function eventsHtml() {
    var f = UI().eventFilter;
    var map = { fail: ['失败'], case: ['用例', '通过', '失败'], phase: ['阶段'], bug: ['新Bug'] };
    var list = S().events.filter(function (e) {
      if (f === 'all') return true;
      return map[f].indexOf(e.kind) >= 0;
    }).slice(-60).reverse();
    if (!list.length) return '<div class="dempty">' + esc(S().events.length ? T('monitor.evEmptyFiltered') : T('monitor.evEmpty')) + '</div>';
    var kcls = { '失败': 'fix', '通过': 'pass', '新Bug': 'retest', '用例': 'run', '阶段': 'pending', '开始': 'run', '提案': 'pending', '拒绝': 'fix', '跳过': 'pending' };
    return list.map(function (e) {
      return '<div class="dev"><span class="mono dim">' + esc(String(e.at).slice(11)) + '</span>' +
        '<span class="bug-status ' + (kcls[e.kind] || 'pending') + '">' + esc(e.kind) + '</span>' +
        '<span class="dev-text">' + esc(e.text) + '</span></div>';
    }).join('');
  }

  /* ======================================================================
     六、Bug 报告
     ====================================================================== */
  function viewBugs() {
    var s = S();
    var cur = null;
    s.bugs.forEach(function (b) { if (b.dir === UI().bugOpen) cur = b; });
    return '' +
      '<div class="dbugs">' +
        '<section class="dcard dcol-list">' +
          '<div class="dcard-hrow"><h3 class="dcard-h">' + esc(T('bugs.title')) + '</h3>' +
            '<span class="dtool-gap"></span><span class="dim mono">' + esc(T('bugs.total')) + s.bugs.length + '</span></div>' +
          (s.bugs.length ? s.bugs.map(function (b) {
            var dim = b.status === '复测通过' || b.status === '已拒绝';
            return '<button type="button" class="dbug' + (dim ? ' dim' : '') + (UI().bugOpen === b.dir ? ' on' : '') + '" ' + act('bugOpen', 'data-dir="' + esc(b.dir) + '"') + '>' +
              '<span class="dbug-title">' + esc(b.title) + '</span>' +
              '<span class="dbug-meta">' +
                '<span class="bug-status ' + bugCls(b.status) + '">' + esc(b.status) + '</span>' +
                (b.last_task ? '<span class="bug-status pending">' + esc(T('bugs.lastTask')) + ' #' + b.last_task + '</span>' : '') +
                '<span class="dim mono">' + b.cases.length + esc(T('bugs.cases')) + '</span>' +
              '</span></button>';
          }).join('') : '<div class="dempty">' + esc(T('bugs.empty')) + '</div>') +
        '</section>' +
        '<section class="dcard dcol-main" data-r="bug-detail">' + bugDetailHtml(cur) + '</section>' +
      '</div>';
  }
  function bugCls(status) {
    if (status === '复测通过') return 'pass';
    if (status === '已拒绝') return 'reject';
    if (status === '已修复（未验证）' || status === '已修复') return 'run';
    if (status === '已分析，待修复') return 'fix';
    return 'retest';
  }
  function bugDetailHtml(b) {
    if (!b) return '<div class="dempty">' + esc(T('bugs.pick')) + '</div>';
    var tk = b.last_task ? E.q.task(b.last_task) : null;
    var tab = UI().bugTab || 'report';
    return '' +
      '<div class="dcard-hrow"><h3 class="dcard-h">' + esc(b.title) + '</h3>' +
        '<span class="bug-status ' + bugCls(b.status) + '">' + esc(b.status) + '</span>' +
        '<span class="dtool-gap"></span>' +
        '<button type="button" class="dchip' + (tab === 'report' ? ' on' : '') + '" ' + act('bugTab', 'data-k="report"') + '>' + esc(T('bugs.tabReport')) + '</button>' +
        '<button type="button" class="dchip' + (tab === 'chat' ? ' on' : '') + '" ' + act('bugTab', 'data-k="chat"') + '>' + esc(T('bugs.tabChat')) + '</button>' +
      '</div>' +
      '<div class="dbug-dir mono dim">bug_report/' + esc(b.dir) + (tk ? ' · ' + esc(T('bugs.lastTask')) + ' #' + tk.id : '') + '</div>' +
      (tab === 'report' ? '' +
        '<div class="drow-ops">' +
          (b.status !== '已拒绝' ? '<button type="button" class="dbtn dbtn-sm" ' + act('bugRetestOpen') + '>' + esc(T('bugs.retest')) + '</button>' : '') +
          (b.status !== '复测通过' ? '<button type="button" class="dbtn dbtn-sm" ' + act('bugFixOpen') + '>' + esc(T('bugs.fix')) + '</button>' : '') +
          (b.status !== '已拒绝' ? '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('bugRejectOpen') + '>' + esc(T('bugs.reject')) + '</button>' : '') +
        '</div>' +
        '<p class="dhint">' + esc(T('bugs.hint')) + '</p>' +
        '<h4 class="dsub">' + esc(T('bugs.related')) + b.cases.length + '）</h4>' +
        (b.cases.length ? '<table class="dtable mini"><thead><tr><th>ID</th><th>' + esc(T('monitor.fields.name')) + '</th><th>' + esc(T('monitor.fields.status')) + '</th></tr></thead><tbody>' +
          b.cases.map(function (id) {
            var c = null; S().cases.forEach(function (x) { if (x.id === id) c = x; });
            return '<tr><td class="mono">' + esc(id) + '</td><td>' + esc(c ? c.name : id) + '</td><td>' + esc(c ? T('monitor.chip.' + c.status) : T('common.dash')) + '</td></tr>';
          }).join('') + '</tbody></table>' : '<div class="dempty">' + esc(T('bugs.relatedEmpty')) + '</div>') +
        '<h4 class="dsub">' + esc(T('bugs.full')) + '</h4>' +
        '<pre class="dpre">' + esc(bugMd(b)) + '</pre>'
      : '' +
        (tk ? '<div class="drow-ops"><span class="bug-status ' + stCls(tk.status) + '">' + esc(T('tasks.st.' + tk.status)) + '</span>' +
          '<span class="dim mono">' + esc(T('tasks.rounds.round')) + ' ' + (tk.current_round || 0) + '</span></div>' +
          '<div class="dchat">' + bugChatHtml(tk) + '</div>'
          : '<div class="dempty">' + esc(T('bugs.noTaskChat')) + '</div>'));
  }
  function bugMd(b) {
    return '状态: ' + b.status + '\n' +
      '标题: ' + b.title + '\n' +
      '关联用例: ' + (b.cases.join(', ') || '（无）') + '\n\n' +
      '## 现象\n' + (b.note || '（见会话记录）') + '\n\n' +
      '## 复现\n1. 按用例目录执行 verify.py\n2. 观察返回\n\n' +
      '## 期望\n按接口契约返回参数错误。\n';
  }
  function bugChatHtml(tk) {
    var s = S().sessions['task:' + tk.id];
    if (!s) return '<div class="dempty">' + esc(T('bugs.noTask')) + '</div>';
    return s.entries.slice(-12).map(function (e) {
      return '<div class="dchat-ent ' + e.kind + '">' + esc(e.text || e.name || '') + '</div>';
    }).join('');
  }

  /* ======================================================================
     七、压测面板
     ====================================================================== */
  function viewStress() {
    var s = S();
    var list = s.tasks.filter(function (tk) { return tk.task_type === 'stress'; });
    var cur = null;
    list.forEach(function (tk) { if (tk.id === UI().stressOpen) cur = tk; });
    if (!cur) cur = list[0] || null;
    return '' +
      '<div class="dstress">' +
        '<section class="dcard dcol-list">' +
          '<div class="dcard-hrow"><h3 class="dcard-h">' + esc(T('stress.title')) + list.length + esc(T('stress.titleEnd')) + '</h3></div>' +
          (list.length ? list.map(function (tk) {
            var plan = tk.load && tk.load.charts;
            return '<button type="button" class="dbug' + (cur && cur.id === tk.id ? ' on' : '') + '" ' + act('stressOpen', 'data-id="' + tk.id + '"') + '>' +
              '<span class="dbug-title">' + esc(tk.name) + '</span>' +
              '<span class="dbug-meta">' +
                '<span class="bug-status ' + stCls(tk.status) + '">' + esc(T('tasks.st.' + tk.status)) + '</span>' +
                '<span class="bug-status pending">' + esc(T('monitor.round') + (tk.current_round || 0) + T('monitor.roundEnd')) + '</span>' +
                (plan ? '<span class="bug-status pass">' + esc(T('stress.hasPlan')) + '</span>' : '') +
              '</span></button>';
          }).join('') : '<div class="dempty">' + esc(T('stress.empty')) + '</div>') +
        '</section>' +
        '<section class="dcard dcol-main" data-r="stress-detail">' + stressDetailHtml(cur) + '</section>' +
      '</div>';
  }

  function stressDetailHtml(tk) {
    if (!tk) return '<div class="dempty">' + esc(T('stress.empty')) + '</div>';
    var tab = UI().stressTab || 'plan';
    var run = S().stress.run && S().stress.taskId === tk.id ? S().stress.run
      : (tk.load && tk.load.runs && tk.load.runs[0]) || null;
    var series = run ? run.series : [];
    return '' +
      '<div class="dcard-hrow"><h3 class="dcard-h">' + esc(tk.name) + '</h3>' +
        '<span class="bug-status ' + stCls(tk.status) + '">' + esc(T('tasks.st.' + tk.status)) + '</span>' +
        '<span class="dim mono">' + esc(T('monitor.round') + (tk.current_round || 0) + T('monitor.roundEnd')) + '</span>' +
        '<span class="dtool-gap"></span>' +
        '<button type="button" class="dchip' + (tab === 'plan' ? ' on' : '') + '" ' + act('stressTab', 'data-k="plan"') + '>' + esc(T('stress.plan')) + '</button>' +
        '<button type="button" class="dchip' + (tab === 'log' ? ' on' : '') + '" ' + act('stressTab', 'data-k="log"') + '>' + esc(T('stress.log')) + '</button>' +
      '</div>' +
      '<div class="drow-ops">' +
        '<button type="button" class="dbtn dbtn-sm" title="' + esc(T('stress.rerunTitle')) + '" ' + act('stressRerun', 'data-id="' + tk.id + '"') + '>' + esc(T('stress.rerun')) + '</button>' +
        '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('stressStop', 'data-id="' + tk.id + '"') + '>' + esc(T('stress.stop')) + '</button>' +
        '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('stressDiag', 'data-id="' + tk.id + '"') + '>' + esc(T('stress.diag')) + '</button>' +
        '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('stressRestart', 'data-id="' + tk.id + '"') + '>' + esc(T('stress.restart')) + '</button>' +
      '</div>' +
      (tab === 'plan' ? '' +
        '<h4 class="dsub">' + esc(T('stress.planTab')) + tk.id + '</h4>' +
        '<div class="drow-ops"><span class="bug-status pending">' + esc(T('stress.script')) + '</span>' +
          '<span class="bug-status pending">' + esc(T('stress.scenario')) + '</span></div>' +
        '<pre class="dpre">' + esc(planJson(tk)) + '</pre>' +
        '<h4 class="dsub">' + esc(T('stress.proposal')) + '</h4>' +
        '<p class="dhint">' + esc(tk.other || T('common.empty')) + '</p>'
      : '' +
        '<h4 class="dsub">' + esc(T('stress.logTitle')) + '</h4>' +
        '<p class="dhint">' + esc(T('stress.logHint')) + '</p>' +
        '<div class="dmetric-row">' + metricCards(run) + '</div>' +
        '<div class="dchart">' + stressChart(series, 'rps') + '</div>' +
        '<div class="dchart">' + stressChart(series, 'lat') + '</div>' +
        '<h4 class="dsub">' + esc(T('stress.report')) + '</h4>' +
        (run ? '<pre class="dpre">' + esc(stressReport(tk, run)) + '</pre>' : '<div class="dempty">' + esc(T('stress.reportHint')) + '</div>'));
  }

  function planJson(tk) {
    return JSON.stringify({
      name: 'order-checkout',
      target: 'http://127.0.0.1:8080',
      steps: [{ concurrency: 10, duration: '60s' }, { concurrency: 50, duration: '60s' }, { concurrency: 100, duration: '60s' }],
      requests: [{ name: 'create-order', method: 'POST', path: '/api/order' }, { name: 'query-order', method: 'GET', path: '/api/order/123' }],
      charts: ['rps', 'latency_p50_p95_p99', 'error_rate'],
    }, null, 2);
  }
  function metricCards(run) {
    var m = (run && run.metrics) || { total: 0, err: 0, p95: 0, rps: 0 };
    return '' +
      '<div class="dmetric"><span class="dim">' + esc(T('stress.mTotal')) + '</span><b class="mono">' + m.total + '</b></div>' +
      '<div class="dmetric"><span class="dim">' + esc(T('stress.mErr')) + '</span><b class="mono">' + m.err + '</b></div>' +
      '<div class="dmetric"><span class="dim">' + esc(T('stress.mP95')) + '</span><b class="mono">' + m.p95 + '</b></div>' +
      '<div class="dmetric"><span class="dim">' + esc(T('stress.mErrRate')) + '</span><b class="mono">' + (m.errRate || 0) + '</b></div>';
  }
  function stressChart(series, kind) {
    if (!series.length) return '<div class="dempty">' + esc(T('stress.noData')) + '</div>';
    var W = 320, H = 110;
    var max = 1;
    series.forEach(function (p) { max = Math.max(max, kind === 'rps' ? p.rps : p.p99); });
    var line = function (key, color) {
      return '<polyline fill="none" stroke="' + color + '" stroke-width="2" points="' +
        series.map(function (p, i) {
          var x = (i / Math.max(1, series.length - 1)) * (W - 20) + 10;
          var y = H - 14 - (p[key] / max) * (H - 30);
          return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ') + '"/>';
    };
    var body = kind === 'rps' ? line('rps', 'var(--star)')
      : line('p50', 'var(--pass)') + line('p95', 'var(--retest)') + line('p99', 'var(--fail)');
    return '<div class="dchart-h">' + esc(kind === 'rps' ? T('stress.chartRps') : T('stress.chartLat')) + '</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" class="dsvg wide">' + body + '</svg>';
  }
  function stressReport(tk, run) {
    var m = run && run.metrics ? run.metrics : {};
    return '# 压测报告 · task' + tk.id + '_' + (run ? run.key : '—') + '\n\n' +
      '- 目标: http://127.0.0.1:8080\n' +
      '- 并发档位: 10 / 50 / 100（各 60s）\n' +
      '- 总请求: ' + (m.total || 0) + '，错误数: ' + (m.err || 0) + '\n' +
      '- P95: ' + (m.p95 || 0) + ' ms，错误率: ' + (m.errRate || 0) + ' %\n\n' +
      '## 结论\n\n100 并发档位错误率抬头，P95 抬升明显；建议先查下单接口的连接池配置。\n';
  }

  /* ======================================================================
     八、设置页（配色/字号是真切换的，其余标注演示未覆盖）
     ====================================================================== */
  function viewSettings() {
    var s = S();
    var sec = UI().settingsSection || 'appearance';
    var sections = ['appearance', 'password', 'feishu', 'assets', 'rag'];
    return '' +
      '<div class="dsettings">' +
        '<aside class="dset-nav">' +
          '<div class="dset-title">' + esc(T('settings.title')) + '</div>' +
          sections.map(function (k) {
            return '<button type="button" class="dset-item' + (sec === k ? ' on' : '') + '" ' + act('setSection', 'data-k="' + k + '"') + '>' + esc(T('settings.sections.' + k)) + '</button>';
          }).join('') +
          '<div class="dset-foot"><button type="button" class="dbtn dbtn-ghost" ' + act('setScreen', 'data-k="app"') + '>← ' + esc(T('settings.back')) + '</button></div>' +
        '</aside>' +
        '<section class="dcard dset-main">' + settingsBody(sec) + '</section>' +
      '</div>';
  }

  function settingsBody(sec) {
    if (sec === 'appearance') {
      var skins = [['starlight', '#141E36', '#E8B86D'], ['classic', '#151b23', '#58a6ff']];
      var scales = [[0.9, 's'], [1, 'm'], [1.15, 'l'], [1.3, 'xl']];
      return '<h3 class="dcard-h">' + esc(T('settings.appearance')) + '</h3>' +
        '<p class="dhint">' + esc(T('settings.appearanceHint')) + '</p>' +
        '<h4 class="dsub">' + esc(T('settings.skin')) + '</h4>' +
        '<div class="dskins">' + skins.map(function (sk) {
          return '<button type="button" class="dskin' + (S().prefs.skin === sk[0] ? ' on' : '') + '" ' + act('skin', 'data-k="' + sk[0] + '"') + '>' +
            '<span class="dskin-sw" style="background:' + sk[1] + '"><i style="background:' + sk[2] + '"></i></span>' +
            '<span>' + esc(T('settings.skins.' + sk[0])) + '</span></button>';
        }).join('') + '</div>' +
        '<h4 class="dsub">' + esc(T('settings.font')) + '</h4>' +
        '<div class="dchips">' + scales.map(function (sc) {
          return '<button type="button" class="dchip' + (S().prefs.fs === sc[0] ? ' on' : '') + '" ' + act('fs', 'data-v="' + sc[0] + '"') + '>' + esc(T('settings.scales.' + sc[1])) + '</button>';
        }).join('') + '</div>';
    }
    if (sec === 'password') {
      return '<h3 class="dcard-h">' + esc(T('settings.password')) + '</h3>' +
        '<label class="dfield"><span>' + esc(T('settings.oldPw')) + '</span><input type="password" value="demo"></label>' +
        '<label class="dfield"><span>' + esc(T('settings.newPw')) + '</span><input type="password" value="demo123456"></label>' +
        '<button type="button" class="dbtn dbtn-primary" ' + act('demoUncovered') + '>' + esc(T('settings.save')) + '</button>' +
        '<p class="dhint">' + esc(T('settings.pwOk')) + '</p>';
    }
    if (sec === 'feishu') {
      return '<h3 class="dcard-h">' + esc(T('settings.feishu')) + '</h3>' +
        '<p class="dhint">' + esc(T('settings.feishuHint')) + '</p>' +
        '<p class="dhint warn">' + esc(T('settings.feishuMissing')) + '</p>';
    }
    if (sec === 'assets') {
      return '<h3 class="dcard-h">' + esc(T('settings.assets')) + '</h3>' +
        '<p class="dhint">' + esc(T('settings.assetsHint')) + '</p>' +
        '<div class="dasset"><b>dsh-autocommit</b><span class="dim">' + esc(T('settings.notCovered')) + '</span></div>';
    }
    return '<h3 class="dcard-h">' + esc(T('settings.rag')) + '</h3>' +
      '<p class="dhint">' + esc(T('settings.ragHint')) + '</p>' +
      '<p class="dhint warn">' + esc(T('settings.notCovered')) + '</p>';
  }

  /* ======================================================================
     九、弹窗层（同一时刻只有一个）
     ====================================================================== */
  function modalHtml() {
    var ui = UI(), s = S();
    if (ui.projOpen) return projModalHtml();
    if (ui.newTaskOpen) return newTaskModalHtml();
    if (ui.detailCard) return cardDetailHtml();
    if (ui.sessKey) return sessionModalHtml();
    if (ui.trashOpen) return trashModalHtml();
    if (s.board.settingsOpen) return boardSettingsHtml();
    if (ui.startMenuFor) return startMenuHtml();
    if (ui.rejectFor) return rejectModalHtml();
    if (ui.wtFor) return worktreeModalHtml();
    if (ui.depFor) return depModalHtml();
    if (ui.legendOpen) return legendModalHtml();
    if (ui.contFor) return continueModalHtml();
    if (ui.bugDlg) return bugDlgHtml();
    if (ui.taskLogFor) return taskLogModalHtml();
    return '';
  }

  function shellModal(title, body, footer, cls2) {
    return '<div class="dmodal-wrap"><div class="dmodal ' + (cls2 || '') + '" role="dialog" aria-modal="true">' +
      '<div class="dmodal-head"><span class="dmodal-title">' + title + '</span>' +
        '<button type="button" class="dicon" ' + act('closeModal') + ' aria-label="close">✕</button></div>' +
      '<div class="dmodal-body">' + body + '</div>' +
      (footer ? '<div class="dmodal-foot">' + footer + '</div>' : '') +
    '</div></div>';
  }

  function projModalHtml() {
    var d = UI().projDraft || {};
    var sd = T('seed');
    var isNew = !S().curProj || UI().projIsNew;
    var v = function (k, fallback) { return esc(d[k] !== undefined ? d[k] : (fallback || '')); };
    return shellModal(
      esc(isNew ? T('proj.addTitle') : T('proj.editTitle')),
      '<div class="dform">' +
        '<label class="dfield"><span>' + esc(T('proj.name')) + '</span><input data-f="name" value="' + v('name', sd.projectName) + '" placeholder="' + esc(T('proj.phName')) + '"></label>' +
        '<label class="dfield"><span>' + esc(T('proj.dir')) + '</span><input data-f="dir" value="' + v('dir', sd.projectDir) + '" placeholder="' + esc(T('proj.phDir')) + '"></label>' +
        '<label class="dfield"><span>' + esc(T('proj.agent')) + '</span><input value="' + esc(T('proj.agentVal')) + '" readonly></label>' +
        '<label class="dfield"><span>' + esc(T('proj.workdir')) + '</span><input data-f="workdir" value="' + v('workdir', sd.workDir) + '"></label>' +
        '<label class="dfield"><span>' + esc(T('proj.env')) + '</span><input data-f="env" value="' + v('env', sd.envTag) + '" placeholder="' + esc(T('proj.phEnv')) + '"></label>' +
        '<label class="dfield"><span>' + esc(T('proj.prompt')) + '</span><textarea data-f="prompt" rows="3">' + v('prompt', sd.projectPrompt) + '</textarea></label>' +
        '<p class="dhint">' + esc(T('proj.hintWorkdir')) + '</p>' +
      '</div>',
      '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('proj.cancel')) + '</button>' +
      '<button type="button" class="dbtn dbtn-primary" ' + act('saveProject') + '>' + esc(T('proj.save')) + '</button>'
    );
  }

  function newTaskModalHtml() {
    var d = UI().taskDraft || {};
    var type = d.type || 'normal';
    var stages = ['gen_case', 'execute', 'report', 'analyze', 'fix', 'deploy', 'retest'];
    var endsFor = {
      normal: stages, regression: stages.slice(1),
      retest_bug: [], stress: [],
    };
    var ends = endsFor[type] || [];
    var stopTypes = ['rounds', 'bugs', 'deadline', 'duration'];
    return shellModal(
      esc(T('nt.title')),
      '<div class="dform">' +
        '<label class="dfield"><span>' + esc(T('nt.name')) + '</span><input data-f="name" value="' + esc(d.name || '') + '" placeholder="' + esc(T('nt.phName')) + '"></label>' +
        '<div class="dfield"><span>' + esc(T('nt.type')) + '</span><div class="dchips">' +
          ['normal', 'regression', 'retest_bug', 'stress'].map(function (k) {
            return '<button type="button" class="dchip' + (type === k ? ' on' : '') + '" ' + act('ntType', 'data-k="' + k + '"') + '>' + esc(T('nt.types.' + k)) + '</button>';
          }).join('') + '</div></div>' +
        '<p class="dhint">' + esc(T('nt.typeNote')) + '</p>' +
        ((type === 'normal' || type === 'retest_bug')
          ? '<div class="dfield"><span>' + esc(T('nt.dateRange')) + '</span><div class="drow">' +
            '<input type="date" data-f="dateFrom" value="' + esc(d.dateFrom || '2026-10-01') + '">' +
            '<span class="dim">' + esc(T('nt.to')) + '</span>' +
            '<input type="date" data-f="dateTo" value="' + esc(d.dateTo || '2026-10-07') + '"></div>' +
            '<p class="dhint">' + esc(type === 'retest_bug' ? T('nt.dateHintRetest') : T('nt.dateHintNormal')) + '</p></div>' : '') +
        (type === 'stress'
          ? '<label class="dfield"><span>' + esc(T('nt.stressLabel')) + '</span><textarea data-f="other" rows="3" placeholder="' + esc(T('nt.phStress')) + '">' + esc(d.other || '') + '</textarea><p class="dhint">' + esc(T('nt.stressHint')) + '</p></label>'
          : '<div class="dfield"><span>' + esc(T('nt.endStage')) + '</span><div class="dchips">' +
            ends.map(function (k) {
              return '<button type="button" class="dchip' + ((d.endStage || 'report') === k ? ' on' : '') + '" ' + act('ntEnd', 'data-k="' + k + '"') + '>' + esc(stageLabel(k)) + '</button>';
            }).join('') + '</div><p class="dhint">' + esc(T('nt.stageHint')) + '</p></div>') +
        ((type === 'normal' || type === 'regression')
          ? '<div class="dfield"><span>' + esc(T('nt.retest')) + '</span><div class="dchips">' +
            ['无', '全部失败用例', '指定范围'].map(function (k) {
              return '<button type="button" class="dchip' + ((d.retest || '全部失败用例') === k ? ' on' : '') + '" ' + act('ntRetest', 'data-k="' + k + '"') + '>' + esc(k === '无' ? T('nt.retestOpts.none') : k === '全部失败用例' ? T('nt.retestOpts.all') : T('nt.retestOpts.scope')) + '</button>';
            }).join('') + '</div></div>' : '') +
        (type !== 'stress'
          ? '<div class="dfield"><span>' + esc(T('nt.stopCond')) + '</span><div class="dchips">' +
            stopTypes.map(function (k) {
              return '<button type="button" class="dchip' + ((d.stopType || 'rounds') === k ? ' on' : '') + '" ' + act('ntStop', 'data-k="' + k + '")') + '>' + esc(T('nt.stopTypes.' + k)) + '</button>';
            }).join('') + '</div>' +
            '<p class="dhint">' + esc(T('nt.stopHints.' + (d.stopType || 'rounds'))) + '</p>' +
            (d.stopType === 'deadline'
              ? '<input type="datetime-local" data-f="stopValue" value="2026-10-08T12:00">'
              : '<input type="number" min="1" data-f="stopValue" value="' + esc(d.stopValue || (d.stopType === 'bugs' ? '1' : '2')) + '">') +
            '</div>' : '') +
        '<label class="dfield"><span>' + esc(type === 'regression' ? T('nt.regressionLabel') : T('nt.other')) + '</span>' +
          '<textarea data-f="other" rows="3" placeholder="' + esc(type === 'regression' ? T('nt.phRegression') : T('nt.phOther')) + '">' + esc(d.other || '') + '</textarea></label>' +
      '</div>',
      '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('nt.cancel')) + '</button>' +
      '<button type="button" class="dbtn dbtn-primary" ' + act('ntSubmit') + '>' + esc(T('nt.submit')) + '</button>',
      'dmodal-wide'
    );
  }

  function cardDetailHtml() {
    var c = E.q.card(UI().detailCard);
    if (!c) return '';
    var others = S().board.cards.filter(function (x) { return x.id !== c.id; });
    var s = S().sessions['card:' + c.id];
    return shellModal(
      '#' + c.id + ' ' + esc(c.title || T('board.newCard')),
      '<div class="dform">' +
        '<h4 class="dsub">' + esc(T('board.secTitleDesc')) + '</h4>' +
        (UI().detailEdit
          ? '<p class="dhint">' + esc(T('board.editHint')) + '</p>' +
            '<textarea class="dta" data-input="detailEdit" rows="5">' + esc(UI().detailEditText) + '</textarea>' +
            '<div class="drow-ops"><button type="button" class="dbtn dbtn-primary dbtn-sm" ' + act('detailSave') + '>' + esc(T('common.save')) + '</button>' +
            '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('detailCancel') + '>' + esc(T('common.cancel')) + '</button></div>'
          : '<div class="dmd">' + (c.description ? esc(c.description) : esc(T('board.noDesc'))) + '</div>' +
            '<div class="drow-ops"><button type="button" class="dbtn dbtn-sm" ' + act('detailEditOn') + '>' + esc(T('board.edit')) + '</button></div>') +
        (c.column === 'todo'
          ? '<h4 class="dsub">' + esc(T('board.secSchedule')) + '</h4>' +
            '<input type="datetime-local" data-f="sched" value="' + esc(c.scheduled_at || '') + '" ' + act('noop') + ' data-input="sched">' +
            '<p class="dhint">' + esc(T('board.scheduleHint')) + '</p>' : '') +
        (c.worktree
          ? '<h4 class="dsub">' + esc(T('board.secWorktree')) + '</h4>' +
            '<button type="button" class="dbtn dbtn-sm dbtn-ghost" title="' + esc(T('board.cleanWtTitle')) + '" ' + act('cleanWt', 'data-id="' + c.id + '"') + '>' + esc(T('board.cleanWt')) + '</button>' +
            '<p class="dhint mono">' + esc(c.worktree) + '（' + esc(T('board.wtBranch')) + 'ts/card-' + c.id + '）</p>' : '') +
        '<h4 class="dsub">' + esc(T('board.secSessions')) + '</h4>' +
        (s ? '<div class="dsess-row"><span class="mono">' + esc(s.sid.slice(0, 18)) + '…</span>' +
             '<span class="bug-status pass">' + esc(T('board.mainTag')) + '</span>' +
             '<button type="button" class="dlink" ' + act('cardSession', 'data-id="' + c.id + '"') + '>' + esc(T('board.viewSession')) + '</button></div>'
           : '<div class="dempty">' + esc(T('board.noSession')) + '</div>') +
        '<h4 class="dsub">' + esc(T('board.secDep')) + '</h4>' +
        '<select data-f="parent" data-sel="dep">' +
          '<option value="0">' + esc(T('board.depNone')) + '</option>' +
          others.map(function (x) {
            return '<option value="' + x.id + '"' + (c.parent === x.id ? ' selected' : '') + '>#' + x.id + ' ' + esc(x.title || T('board.newCard')) + '（' + esc(T('board.cols.' + x.column)) + '）</option>';
          }).join('') +
        '</select>' +
        '<h4 class="dsub">' + esc(T('board.secComments')) + '</h4>' +
        (c.comments.length ? c.comments.map(function (cm) {
          return '<div class="dcomment"><span class="dim mono">' + esc(cm.at) + '</span>' +
            (cm.delivered ? '<span class="bug-status pass">' + esc(T('board.delivered')) + '</span>' : '') +
            '<div>' + esc(cm.text) + '</div></div>';
        }).join('') : '') +
        '<textarea class="dta" data-input="comment" rows="2" placeholder="' + esc(T('board.commentPh')) + '"></textarea>' +
        '<div class="drow-ops">' +
          '<button type="button" class="dbtn dbtn-sm" ' + act('commentSave', 'data-id="' + c.id + '"') + '>' + esc(T('board.commentSave')) + '</button>' +
          '<button type="button" class="dbtn dbtn-sm dbtn-primary" ' + act('commentDeliver', 'data-id="' + c.id + '"') + '>' + esc(T('board.commentDeliver')) + '</button>' +
        '</div>' +
      '</div>',
      '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('board.close')) + '</button>',
      'dmodal-wide'
    );
  }

  function trashModalHtml() {
    var list = S().board.trash;
    return shellModal(
      esc(T('board.trashTitle')) + '（' + list.length + '）',
      '<p class="dhint">' + esc(T('board.trashNote')) + '</p>' +
      (list.length ? list.map(function (c) {
        return '<div class="dtrash-row"><span class="dtrash-title">' + esc(c.title || T('board.newCard')) + '</span>' +
          '<span class="bug-status pending">' + esc(T('board.cols.' + c.column)) + '</span>' +
          '<span class="dim mono">' + esc(T('board.trashAt') + c.trashed_at) + '</span>' +
          '<span class="dtool-gap"></span>' +
          '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('restore', 'data-id="' + c.id + '"') + '>' + esc(T('board.restore')) + '</button>' +
          '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('purge', 'data-id="' + c.id + '"') + '>' + esc(T('board.purge')) + '</button>' +
        '</div>';
      }).join('') : '<div class="dempty">' + esc(T('board.trashEmpty')) + '</div>'),
      '<button type="button" class="dbtn dbtn-ghost" ' + act('emptyTrash') + '>🗑 ' + esc(T('board.trashClear')) + '</button>' +
      '<button type="button" class="dbtn" ' + act('closeModal') + '>' + esc(T('board.close')) + '</button>'
    );
  }

  function boardSettingsHtml() {
    var mode = S().board.mode;
    return shellModal(
      esc(T('board.setTitle')),
      '<h4 class="dsub">' + esc(T('board.setParallel')) + '</h4>' +
      '<label class="dradio"><input type="radio" name="bmode" ' + (mode === 'serial' ? 'checked' : '') + ' data-sel="mode" value="serial"> ' + esc(T('board.setSerial')) + '</label>' +
      '<label class="dradio"><input type="radio" name="bmode" ' + (mode === 'parallel' ? 'checked' : '') + ' data-sel="mode" value="parallel"> ' + esc(T('board.setParallel5')) + '</label>' +
      '<p class="dhint">' + esc(T('board.setHint')) + '</p>' +
      '<h4 class="dsub">' + esc(T('board.jira')) + '</h4>' +
      '<input class="dinput" placeholder="' + esc(T('board.jiraUrl')) + '">' +
      '<input class="dinput" placeholder="' + esc(T('board.jiraUser')) + '">' +
      '<input class="dinput" type="password" placeholder="' + esc(T('board.jiraToken')) + '">' +
      '<div class="drow-ops"><button type="button" class="dbtn dbtn-sm" ' + act('demoUncovered') + '>' + esc(T('board.jiraSave')) + '</button>' +
        '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('demoUncovered') + '>' + esc(T('board.jiraTest')) + '</button>' +
        '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('demoUncovered') + '>' + esc(T('board.jiraImport')) + '</button></div>' +
      '<p class="dhint warn">' + esc(T('board.jiraDemo')) + '</p>',
      '<button type="button" class="dbtn" ' + act('closeModal') + '>' + esc(T('board.close')) + '</button>'
    );
  }

  function startMenuHtml() {
    var id = UI().startMenuFor;
    return shellModal(
      esc(T('board.moreStart')),
      '<div class="dmenu">' +
        '<button type="button" class="dmenu-item" ' + act('cardStart', 'data-id="' + id + '"') + '>' + esc(T('board.startQueue')) + '</button>' +
        '<button type="button" class="dmenu-item" ' + act('wtOpen', 'data-id="' + id + '"') + '>' + esc(T('board.startWorktree')) + '</button>' +
      '</div>', '');
  }

  function worktreeModalHtml() {
    var c = E.q.card(UI().wtFor);
    var path = T('seed.workDir') + '/worktrees/card_' + c.id;
    return shellModal(
      esc(T('board.wtTitle')),
      '<p>' + esc(T('board.wtBody')) + '</p>' +
      '<p class="mono dim">' + esc(T('board.wtPath')) + esc(path) + '<br>' + esc(T('board.wtBranch')) + 'ts/card-' + c.id + '</p>' +
      '<p class="dhint warn">' + esc(T('board.wtNote')) + '</p>',
      '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('common.cancel')) + '</button>' +
      '<button type="button" class="dbtn dbtn-primary" ' + act('wtStart', 'data-id="' + c.id + '"') + '>' + esc(T('board.wtOk')) + '</button>'
    );
  }

  function rejectModalHtml() {
    var c = E.q.card(UI().rejectFor);
    return shellModal(
      esc(T('board.rejectTitle')) + '「' + esc(c.title || T('board.newCard')) + '」',
      '<textarea class="dta" data-input="rejectText" rows="3" placeholder="' + esc(T('board.rejectPh')) + '">' + esc(UI().rejectText || '') + '</textarea>',
      '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('common.cancel')) + '</button>' +
      '<button type="button" class="dbtn dbtn-primary" ' + act('rejectOk', 'data-id="' + c.id + '"') + '>' + esc(T('board.rejectOk')) + '</button>'
    );
  }

  function depModalHtml() {
    var c = E.q.card(UI().depFor);
    return shellModal(
      esc(T('board.depTitle')),
      '<p>' + esc(T('board.depBody')) + '</p>' +
      '<p class="mono dim">' + esc(T('board.badgeDep')) + c.parent + '</p>',
      '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('common.cancel')) + '</button>' +
      '<button type="button" class="dbtn dbtn-primary" ' + act('cardForce', 'data-id="' + c.id + '"') + '>' + esc(T('board.depForce')) + '</button>'
    );
  }

  function continueModalHtml() {
    var tk = E.q.task(UI().contFor);
    return shellModal(
      esc(T('tasks.ops.cont')),
      '<p class="dhint">' + esc(T('tasks.contTitle')) + '</p>' +
      '<label class="dfield"><span>' + esc(T('nt.stopCond')) + '</span><input type="number" min="1" data-f="contRounds" value="1"></label>',
      '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('common.cancel')) + '</button>' +
      '<button type="button" class="dbtn dbtn-primary" ' + act('contOk', 'data-id="' + tk.id + '"') + '>' + esc(T('tasks.ops.cont')) + '</button>'
    );
  }

  function bugDlgHtml() {
    var d = UI().bugDlg, b = E.q.bug(d.dir);
    if (d.kind === 'fix') {
      return shellModal(esc(T('bugs.fixTitle')) + '「' + esc(b.title) + '」',
        '<label class="dfield"><span>' + esc(T('bugs.fixNote')) + '</span><textarea class="dta" data-input="fixNote" rows="3"></textarea></label>' +
        '<div class="dfield"><span>' + esc(T('bugs.fixEnd')) + '</span><div class="dchips">' +
          ['analyze', 'fix', 'deploy', 'retest'].map(function (k) {
            return '<button type="button" class="dchip' + ((UI().fixEnd || 'fix') === k ? ' on' : '') + '" ' + act('fixEnd', 'data-k="' + k + '"') + '>' + esc(stageLabel(k)) + '</button>';
          }).join('') + '</div></div>' +
        '<label class="dcheck"><input type="checkbox" data-f="autocommit"> ' + esc(T('bugs.autocommit')) + '</label>',
        '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('common.cancel')) + '</button>' +
        '<button type="button" class="dbtn dbtn-primary" ' + act('bugFixOk') + '>' + esc(T('bugs.fixGo')) + '</button>');
    }
    if (d.kind === 'reject') {
      return shellModal(esc(T('bugs.rejectTitle')) + '「' + esc(b.title) + '」',
        '<textarea class="dta" data-input="rejectReason" rows="3" placeholder="' + esc(T('bugs.rejectPh')) + '"></textarea>',
        '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('common.cancel')) + '</button>' +
        '<button type="button" class="dbtn dbtn-primary" ' + act('bugRejectOk') + '>' + esc(T('bugs.rejectGo')) + '</button>');
    }
    return shellModal(esc(T('bugs.retestTitle')) + '「' + esc(b.title) + '」',
      '<div class="dfield"><span>' + esc(T('bugs.retestScope')) + '</span><div class="dchips">' +
        ['retest_only', 'deploy_retest', 'deploy_only'].map(function (k) {
          return '<button type="button" class="dchip' + ((UI().retestScope || 'retest_only') === k ? ' on' : '') + '" ' + act('retestScope', 'data-k="' + k + '"') + '>' + esc(T('bugs.scopes.' + k)) + '</button>';
        }).join('') + '</div></div>',
      '<button type="button" class="dbtn dbtn-ghost" ' + act('closeModal') + '>' + esc(T('common.cancel')) + '</button>' +
      '<button type="button" class="dbtn dbtn-primary" ' + act('bugRetestOk') + '>' + esc(T('bugs.retestGo')) + '</button>');
  }

  function taskLogModalHtml() {
    var tk = E.q.task(UI().taskLogFor);
    return shellModal(esc(T('tasks.rounds.logs')) + ' · ' + esc(tk.name),
      '<pre class="dpre">' + esc(
        '2026-10-07 14:00:01 [INFO] 第 1 轮开始\n' +
        '2026-10-07 14:00:03 [阶段] 测试用例生成\n' +
        '2026-10-07 14:00:12 [用例] FS0007 币种缺失返回参数错误\n' +
        '2026-10-07 14:00:14 [失败] 期望 400，实际 500\n' +
        '2026-10-07 14:00:20 [新Bug] 20261006_1512_FS_退款签名未校验\n' +
        '2026-10-07 14:00:24 [阶段] 生成报告\n' +
        '2026-10-07 14:00:26 [INFO] 本轮结束，退出码 0\n') + '</pre>',
      '<button type="button" class="dbtn" ' + act('closeModal') + '>' + esc(T('board.close')) + '</button>');
  }

  function legendModalHtml() {
    return shellModal(
      esc(T('legend.title')),
      '<h4 class="dsub">' + esc(T('legend.covered')) + '</h4>' +
      '<ul class="dlegend-list">' + T('legend.coveredItems').map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '<h4 class="dsub">' + esc(T('legend.notCovered')) + '</h4>' +
      '<ul class="dlegend-list dim">' + T('legend.notCoveredItems').map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (window.TS_LANG === 'en' ? '<p class="dhint">' + esc(T('legend.langNote')) + '</p>' : '') +
      '<p class="dhint">' + esc(T('legend.resetNote')) + '</p>',
      '<button type="button" class="dbtn" ' + act('closeModal') + '>' + esc(T('board.close')) + '</button>');
  }

  /* ======================================================================
     十、会话窗口
     ====================================================================== */
  function sessionModalHtml() {
    var key = UI().sessKey;
    var s = S().sessions[key];
    if (!s) return '';
    var isCard = key.indexOf('card:') === 0;
    var ref = Number(key.split(':')[1]);
    var card0 = isCard ? E.q.card(ref) : null;
    var task0 = isCard ? null : E.q.task(ref);
    var q = isCard ? E.q.queueStateOf(card0) : E.q.taskQueueState(task0);
    var pos = E.q.posOf(isCard ? 'c' : 't', ref) || E.q.posOf('a', ref);
    var colKey = card0 ? card0.column : (task0 ? E.q.taskCol(task0.status) : '');
    return '<div class="dmodal-wrap"><div class="dmodal dmodal-sess" role="dialog" aria-modal="true">' +
      '<div class="dmodal-head">' +
        '<span class="dmodal-title">' + esc(T('session.title')) + esc(s.title) + '</span>' +
        (colKey ? '<span class="sess-colstate" title="' + esc(T('session.colstateTitle')) + '">' + esc(T('board.cols.' + colKey)) + '</span>' : '') +
        '<span class="sess-qstate ' + sessQCls(q) + '" title="' + esc(q === 'idle' ? T('session.idleTitle') : T('session.idle')) + '">' +
          esc(q === 'idle' ? T('session.idle') : T('board.queueStates.' + q)) +
          (pos && (q === 'queued_serial' || q === 'answer_pending') ? esc(T('session.posSuffix') + pos + T('session.posSuffixEnd')) : '') +
        '</span>' +
        '<span class="dtool-gap"></span>' +
        (isCard && card0 && (card0.column === 'doing' || card0.column === 'review')
          ? '<button type="button" class="dbtn dbtn-sm dbtn-primary" title="' + esc(T('session.passTitle')) + '" ' + act('sessPass') + '>' + esc(T('session.pass')) + '</button>' : '') +
        '<button type="button" class="dicon" ' + act('closeModal') + '>✕</button>' +
      '</div>' +
      '<div class="dmodal-body dmodal-sess-body">' +
        '<div class="sess-sub" data-r="sess-sub">' + sessSubHtml(s, q) + '</div>' +
        '<div class="sess-entries" data-r="sess-entries">' + sessEntriesHtml(s) + '</div>' +
        '<div class="sess-slash" data-r="sess-slash" data-slash hidden></div>' +
        '<div class="sess-foot" data-r="sess-foot">' + sessFootHtml(s, q) + '</div>' +
      '</div>' +
    '</div></div>';
  }
  function sessQCls(q) {
    if (q === 'running' || q === 'starting') return 'run';
    if (q === 'idle') return '';
    return q === 'server_queued' || q === 'foreign_busy' ? 'server' : 'queued';
  }
  function sessSubHtml(s, q) {
    return '<button type="button" class="dchip' + (UI().askIndex ? ' on' : '') + '" title="' + esc(T('session.askIndex')) + '" ' + act('toggleAskIndex') + '>☰ ' + esc(T('session.askIndex')) + '</button>' +
      '<span class="sess-conn on" title="' + esc(T('session.connDemo')) + '"></span>' +
      '<span class="sess-chip mono" title="' + esc(s.sid) + '">' + esc(s.sid.replace('session_', '').slice(0, 8)) + '</span>' +
      '<span class="sess-chip mono">' + esc(s.model) + '</span>' +
      '<span class="dtool-gap"></span>' +
      (UI().askIndex ? '<div class="sess-askindex">' + askIndexHtml(s) + '</div>' : '') +
      '<span class="sess-totals dim">' + esc(T('session.total') + s.entries.length + T('session.totalEnd')) + '</span>';
  }
  function askIndexHtml(s) {
    var idx = s.entries.filter(function (e) { return e.kind === 'user'; });
    if (!idx.length) return '<span class="dim">' + esc(T('session.noAsk')) + '</span>';
    return idx.map(function (e, i) {
      return '<span class="sess-askitem mono">' + (i + 1) + ' · ' + esc(String(e.text).slice(0, 40)) + '</span>';
    }).join('');
  }

  function sessEntriesHtml(s) {
    var out = s.entries.map(function (e) {
      if (e.kind === 'think') return '<details class="sess-msg think"><summary>' + esc(T('session.think')) + '</summary><div class="think-text">' + esc(e.text) + '</div></details>';
      if (e.kind === 'tool_call') return '<details class="sess-msg tool"><summary>🔧 ' + esc(e.name || T('session.toolCall')) + '</summary><pre>' + esc(JSON.stringify(e.args || {}, null, 2)) + '</pre></details>';
      if (e.kind === 'tool_result') return '<details class="sess-msg tool result' + (e.err ? ' err' : '') + '"><summary>' + esc(e.err ? T('session.error') : T('session.result')) +
        (e.name ? ' · ' + esc(e.name) : '') + '（' + esc(String(e.result || '').length) + esc(T('session.chars')) + '）</summary><pre>' + esc(e.result) + '</pre></details>';
      if (e.kind === 'user') return '<div class="sess-msg user"><div class="bubble">' + esc(e.text) + '</div></div>';
      return '<div class="sess-msg assistant">' + esc(e.text) + '</div>';
    }).join('');
    if (s.interaction) out += interactionHtml(s);
    if (!out) out = '<div class="dempty">' + esc(T('session.empty')) + '</div>';
    return out;
  }

  function interactionHtml(s) {
    var it = s.interaction;
    if (it.kind === 'approval') return approvalHtml(it);
    var q = it.questions[it.page] || it.questions[0];
    var ans = it.answers[it.page];
    if (UI().askMin) {
      return '<div class="sess-interaction-bar" ' + act('askMin') + '>' + esc(T('session.ask.minimised')) +
        (it.questions.length > 1 ? esc(T('session.ask.answeredN')) + Object.keys(it.answers).length + '/' + it.questions.length : '') + '</div>';
    }
    var opts = (q.options || []).map(function (o, i) {
      var on = it.multi ? (ans || []).indexOf(o.label) >= 0 : ans === o.label;
      return '<button type="button" class="sess-iopt' + (on ? ' on' : '') + '" ' + act('askOpt', 'data-i="' + i + '"') + '>' +
        '<span class="sess-iopt-key">' + (i + 1) + '</span>' +
        '<span class="sess-iopt-body"><b>' + esc(o.label) + '</b><span>' + esc(o.description || '') + '</span></span></button>';
    }).join('');
    var other = q.other ? '<div class="sess-otherow"><input class="dinput" data-input="askOther" placeholder="' + esc(T('session.ask.other')) + '" value="' + esc(UI().askOtherDraft || '') + '"></div>' : '';
    var nav = it.questions.length > 1
      ? '<div class="sess-inav"><button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('askPrev') + '>' + esc(T('session.ask.prev')) + '</button>' +
        it.questions.map(function (_, i) {
          return '<span class="sess-inav-dot' + (it.answers[i] !== undefined ? ' done' : '') + (i === it.page ? ' on' : '') + '"></span>';
        }).join('') +
        '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('askNext') + '>' + esc(T('session.ask.next')) + '</button></div>'
      : '<div class="dhint">' + esc(it.multi ? T('session.ask.multiHint') : T('session.ask.singleHint')) + '</div>';
    var ready = it.questions.every(function (_, i) { return it.answers[i] !== undefined; })
      || (!!q.other && !!(UI().askOtherDraft || '').trim());
    return '<div class="sess-interaction">' +
      '<div class="sess-interaction-head"><button type="button" class="dicon" title="' + esc(T('session.ask.minimise')) + '" ' + act('askMin') + '>–</button>' +
        '<span>' + esc(T('session.ask.waiting')) + (q.header ? '（' + esc(q.header) + '）' : '') + '：' + esc(q.question) + '</span></div>' +
      '<div class="sess-interaction-list">' + opts + '</div>' + other + nav +
      '<div class="sess-interaction-foot"><button type="button" class="dbtn dbtn-primary" ' + (ready ? '' : 'disabled') + ' title="' + esc(ready ? '' : T('session.ask.submitDisabled')) + '" ' + act('askSubmit') + '>' + esc(T('session.ask.submit')) + '</button></div>' +
    '</div>';
  }

  /* ---------- `/` 指令菜单（产品里是 SlashMenu；这里只还原两条可用命令）
     独立成一个区域渲染：会话流式刷新时不会把输入框连同菜单一起重画（打字不丢焦点），
     菜单本身只跟着 slashQuery 变。 ---------- */
  function slashItems(q) {
    var all = [
      { k: '/stop', desc: T('session.slash.stop') },
      { k: '/compact', desc: T('session.slash.compact') },
    ];
    return all.filter(function (it) { return it.k.indexOf(q) === 0; });
  }
  function slashBoxHtml() {
    var v = UI().slashQuery || '';
    if (v.charAt(0) !== '/') return '';
    var items = slashItems(v.split(' ')[0]);
    return items.length ? items.map(function (it) {
      return '<button type="button" class="sess-slash-item" data-act="slashPick" data-k="' + it.k + '">' +
        '<span class="mono">' + esc(it.k) + '</span><span class="dim">' + esc(it.desc) + '</span>' +
        '<span class="bug-status pending">' + esc(T('session.slash.cmdTag')) + '</span></button>';
    }).join('') + '<div class="dhint">' + esc(T('session.slash.demo')) + '</div>'
      : '<div class="sess-slash-item dis">' + esc(T('session.slash.empty')) + '</div>';
  }
  function updateSlash(value) { st({ slashQuery: value || '' }); }
  function runSlash(cmd, key) {
    var s = S().sessions[key];
    if (!s) return;
    if (cmd === '/compact') {
      s.entries.push({ kind: 'assistant', seq: s.entries.length + 1, at: Date.now(), text: T('session.slash.compacted') });
      s.ctx = 6;
      E.act.toast(T('session.slash.compacted'));
      st({ slashQuery: '' });
      return;
    }
    if (cmd === '/stop') {
      st({ slashQuery: '' });
      if (key.indexOf('card:') === 0) E.act.cardStop(Number(key.split(':')[1]));
      else E.act.taskStop(Number(key.split(':')[1]));
      E.act.toast(T('session.slash.stopped'));
      return;
    }
    st({ slashQuery: '' });
    E.act.toast(T('session.slash.demo'));
  }

  /* 审批卡（SessionView 的 approval 分支）：批准 / 本会话内批准 / 拒绝 */
  function approvalHtml(it) {
    return '<div class="sess-interaction approval">' +
      '<div class="sess-interaction-head"><span>' + esc(T('session.approval.title')) + esc(it.action || it.tool || '') + '</span></div>' +
      '<pre class="sess-interaction-pre">' + esc(JSON.stringify(it.input || {}, null, 2)) + '</pre>' +
      '<div class="sess-interaction-foot">' +
        '<button type="button" class="dbtn dbtn-sm dbtn-primary" ' + act('approve', 'data-k="approved"') + '>' + esc(T('session.approval.approve')) + '</button>' +
        '<button type="button" class="dbtn dbtn-sm" ' + act('approve', 'data-k="approved_session"') + '>' + esc(T('session.approval.approveSession')) + '</button>' +
        '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('approve', 'data-k="rejected"') + '>' + esc(T('session.approval.reject')) + '</button>' +
      '</div></div>';
  }

  function sessFootHtml(s, q) {
    var ph = T('session.composer.default');
    if (q === 'interaction_pending') ph = T('session.composer.waitingAnswer');
    else if (q === 'running' || q === 'starting') ph = T('session.composer.running');
    else if (q === 'queued_serial' || q === 'server_queued' || q === 'foreign_busy') ph = T('session.composer.busyProject');
    var queued = s.msgs.filter(function (m) { return m.state === 'queue'; });
    var server = s.msgs.filter(function (m) { return m.state === 'server'; });
    var rows = queued.concat(server).map(function (m) {
      return '<div class="sess-queue" title="' + esc(m.text) + '"><span class="sess-queue-tag' + (m.state === 'server' ? ' on' : '') + '">' + esc(m.tag) + '</span>' +
        '<span class="sess-queue-text">' + esc(m.text.slice(0, 60)) + '</span>' +
        (m.state === 'queue' ? '<button type="button" class="dlink" title="' + esc(T('session.composer.injectTitle')) + '" ' + act('inject') + '>' + esc(T('session.composer.inject')) + '</button>' : '') +
      '</div>';
    }).join('');
    if (s.pendingDeliver) {
      rows += '<div class="sess-queue" title="' + esc(T('session.composer.deliverNowTitle')) + '"><span class="sess-queue-tag on">' + esc(T('session.composer.deliverTag')) + '</span>' +
        '<span class="sess-queue-text">' + esc(T('session.composer.deliverText')) + '</span>' +
        '<button type="button" class="dlink" ' + act('sessDeliver') + '>' + esc(T('session.composer.deliverNow')) + '</button></div>';
    }
    var busy = q === 'running' || q === 'starting' || q === 'queued_serial' || q === 'server_queued';
    return '<div class="sess-queuelist">' + rows + '</div>' +
      '<div class="sess-composer">' +
        '<textarea class="sess-input" data-input="sessMsg" data-fk="sessMsg" rows="2" placeholder="' + esc(ph) + '">' + esc(UI().sessMsgDraft || '') + '</textarea>' +
        '<div class="sess-composer-bar">' +
          '<button type="button" class="dicon" title="' + esc(T('session.composer.attach')) + '" ' + act('demoUncovered') + '>＋</button>' +
          '<select class="sess-sel" data-sel="perm">' +
            ['manual', 'yolo', 'auto'].map(function (k) {
              return '<option value="' + k + '"' + (s.permission === k ? ' selected' : '') + '>' + esc(T('session.perm.' + k)) + '</option>';
            }).join('') + '</select>' +
          '<select class="sess-sel" data-sel="effort">' +
            ['low', 'medium', 'high', 'xhigh'].map(function (k) {
              return '<option value="' + k + '"' + (s.effort === k ? ' selected' : '') + '>' + esc(T('session.effortLabel') + ' ' + k) + '</option>';
            }).join('') + '</select>' +
          '<span class="sess-ring" title="' + esc(T('session.ringTitle')) + '">' + Math.min(99, Math.round(s.entries.length * 2.4)) + '%</span>' +
          '<span class="dtool-gap"></span>' +
          '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('sessStop') + '>' + esc(queued.length ? T('session.composer.cancelQueue') : T('session.composer.stop')) + '</button>' +
          '<button type="button" class="dbtn dbtn-sm dbtn-primary" ' + act('sessSend') + '>' + esc(busy ? T('session.composer.queue') : T('session.composer.send')) + '</button>' +
        '</div>' +
      '</div>';
  }

  /* ======================================================================
     十一、引导条 / toast / 覆盖说明
     ====================================================================== */
  function coachHtml() {
    var ui = UI();
    if (!ui.coachOn) return '<div class="coach-bar dim">' + esc(T('coach.done')) +
      '<span class="dtool-gap"></span><button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('coachToggle') + '>' + esc(T('top.coach')) + '</button></div>';
    var steps = T('coach.steps');
    var i = Math.min(ui.coachIdx, steps.length - 1);
    var step = steps[i];
    return '<div class="coach-bar">' +
      '<span class="coach-step">' + esc(T('coach.step') + (i + 1) + '/' + steps.length) + '</span>' +
      '<div class="coach-text"><b>' + esc(step.t) + '</b><span>' + esc(step.h) + '</span></div>' +
      '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('coachNext') + '>' + esc(T('coach.next')) + '</button>' +
      '<button type="button" class="dbtn dbtn-sm dbtn-ghost" ' + act('coachSkip') + '>' + esc(T('coach.skip')) + '</button>' +
    '</div>';
  }

  function toastHtml() {
    return S().toasts.map(function (x) { return '<div class="dtoast-item">' + esc(x.text) + '</div>'; }).join('');
  }

  /* ======================================================================
     十二、渲染与区域同步
     ====================================================================== */
  function regions() {
    return {
      'side': sideHtml,
      'head': headHtml,
      'tabs': tabsHtml,
      'board-tool': boardToolHtml,
      'board-cols': boardColsHtml,
      'task-list': taskListHtml,
      'mon-head': monHeadHtml,
      'mon-cases': monitorCasesHtml,
      'mon-chart': monitorChartHtml,
      'mon-detail': monitorDetailHtml,
      'mon-events': eventsHtml,
      'bug-detail': function () { var cur = null; S().bugs.forEach(function (b) { if (b.dir === UI().bugOpen) cur = b; }); return bugDetailHtml(cur); },
      'stress-detail': function () {
        var list = S().tasks.filter(function (tk) { return tk.task_type === 'stress'; });
        var cur = null; list.forEach(function (tk) { if (tk.id === UI().stressOpen) cur = tk; });
        return stressDetailHtml(cur || list[0] || null);
      },
      'sess-sub': function () { var s = S().sessions[UI().sessKey]; return s ? sessSubHtml(s, sessQ()) : ''; },
      'sess-entries': function () { var s = S().sessions[UI().sessKey]; return s ? sessEntriesHtml(s) : ''; },
      'sess-foot': function () { var s = S().sessions[UI().sessKey]; return s ? sessFootHtml(s, sessQ()) : ''; },
      'sess-slash': function () {
        var html = slashBoxHtml();
        return html || '';
      },
    };
  }
  function sessQ() {
    var key = UI().sessKey;
    if (!key) return 'idle';
    if (key.indexOf('card:') === 0) {
      var c = E.q.card(Number(key.split(':')[1]));
      return c ? E.q.queueStateOf(c) : 'idle';
    }
    var tk = E.q.task(Number(key.split(':')[1]));
    return tk ? (E.q.taskQueueState(tk) || 'idle') : 'idle';
  }

  function render() {
    var s = S();
    document.documentElement.dataset.skin = s.prefs.skin;
    document.documentElement.style.setProperty('--fs', String(s.prefs.fs));    if (s.screen === 'login') {
      app.innerHTML = viewLogin();
      layer.hidden = true; layer.innerHTML = '';
      coachEl.hidden = true;
    } else if (s.screen === 'settings') {
      app.innerHTML = viewSettings();
      var m1 = modalHtml();
      layer.hidden = !m1; layer.innerHTML = m1;
    } else {
      app.innerHTML = viewApp();
      var m2 = modalHtml();
      layer.hidden = !m2; layer.innerHTML = m2;
    }
    syncNow();
    renderCoach();
    renderToast();
    syncTopHeight();
  }

  /* 顶栏在窄屏会折成两行：侧栏抽屉的起始位置跟着实测高度走 */
  function syncTopHeight() {
    var el = document.querySelector('.dtop');
    if (el) document.documentElement.style.setProperty('--dtop-h', el.offsetHeight + 'px');
  }
  window.addEventListener('resize', syncTopHeight);

  function renderCoach() {
    var show = S().screen !== 'login' && S().ui.coachOn;
    document.body.classList.toggle('has-coach', show);
    if (S().screen === 'login') { coachEl.hidden = true; return; }
    coachEl.hidden = false;
    coachEl.innerHTML = coachHtml();
  }
  function renderToast() {
    var html = toastHtml();
    toastEl.hidden = !html;
    toastEl.innerHTML = html;
  }

  /* 区域签名：只有签名变了才重画，避免打字/选中被打断 */
  var SIGS = {
    'side': function () { return S().projects.length + '|' + countStr(); },
    'head': function () { var p = S().curProj; return p ? p.name + p.archived : 'none'; },
    'tabs': function () { return S().tab; },
    'board-tool': function () { return S().board.mode + '|' + S().board.search; },
    'board-cols': function () { return boardSig(); },
    'task-list': function () { return JSON.stringify(S().tasks.map(function (t) { return [t.id, t.status, t.current_round, t.new_bugs, t.ended_at]; })) + '|' + (UI().taskOpen || 0) + '|' + (UI().taskSearch || ''); },
    'mon-cases': function () { return JSON.stringify(S().cases.map(function (c) { return c.id + c.status; })) + '|' + (UI().monitorCase || ''); },
    'mon-head': function () { var l = S().live; return (l ? l.phase + l.round + (l.currentCase || '') : 'idle') + '|' + Math.floor(S().now / 5000); },
    'mon-chart': function () { return String(UI().monitorChart) + caseSig() + bugSig(); },
    'mon-detail': function () { return (UI().monitorCase || '') + '|' + (S().live ? S().live.currentCase : ''); },
    'mon-events': function () { return S().events.length + '|' + (UI().eventFilter || 'all'); },
    'bug-detail': function () { return (UI().bugOpen || '') + (UI().bugTab || '') + bugSig(); },
    'stress-detail': function () { return (UI().stressOpen || '') + (UI().stressTab || '') + (S().stress.run ? S().stress.run.series.length : 0) + JSON.stringify(S().tasks.filter(function (t) { return t.task_type === 'stress'; }).map(function (t) { return [t.id, t.status, t.current_round]; })); },
    'sess-sub': function () { return sessQ() + '|' + entriesSig() + '|' + (UI().askIndex ? 1 : 0); },
    'sess-entries': function () { return entriesSig() + '|' + (UI().askMin ? 1 : 0) + '|' + JSON.stringify(interactionSig()); },
    'sess-foot': function () { var s = S().sessions[UI().sessKey]; return sessQ() + '|' + (s ? JSON.stringify(s.msgs.map(function (m) { return m.id + m.state; })) : '') + '|' + (s ? s.pendingDeliver : ''); },
    'sess-slash': function () { return String(UI().slashQuery || ''); },
  };
  function countStr() {
    var c = { todo: 0, doing: 0, blocked: 0, review: 0, done: 0 };
    S().board.cards.forEach(function (x) { c[x.column]++; });
    return JSON.stringify(c);
  }
  function caseSig() { return S().cases.map(function (c) { return c.id + c.status; }).join(','); }
  function bugSig() { return S().bugs.map(function (b) { return b.dir + b.status; }).join(','); }
  function entriesSig() { var s = S().sessions[UI().sessKey]; return s ? String(s.entries.length) + ':' + (s.waiting ? 1 : 0) : '0'; }
  function interactionSig() {
    var s = S().sessions[UI().sessKey];
    if (!s || !s.interaction) return 0;
    return { p: s.interaction.page, a: s.interaction.answers };
  }
  function boardSig() {
    var s = S();
    var cards = s.board.cards.map(function (c) {
      return [c.id, c.column, c.title, c.description, c.unread, c.parent, c.worktree, c.scheduled_at,
        E.q.queueStateOf(c), c.blockKind, c.answerPending, UI().cardEdit === c.id].join('~');
    }).join('|');
    var tasks = s.tasks.map(function (x) { return [x.id, x.status, x.current_round].join('~'); }).join('|');
    return cards + '#' + tasks + '#' + JSON.stringify(s.board.filters) + JSON.stringify(s.board.sorts) + '#' + s.board.search + '#' + s.board.mode;
  }

  function syncNow() {
    var map = regions();
    Object.keys(map).forEach(function (k) {
      var el = document.querySelector('[data-r="' + k + '"]');
      if (!el) return;
      if (k === 'board-cols' && dragging.id) return;      // 拖拽中不重画看板
      var sig = SIGS[k] ? SIGS[k]() : '';
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      var active = document.activeElement;
      var fk = active && active.dataset ? active.dataset.fk : null;
      var caret = active && active.selectionStart;
      var html = map[k]();
      el.hidden = !html;                      // 空区域直接收起（`/` 菜单就靠这条开合）
      el.innerHTML = html;
      if (fk) {
        var next = document.querySelector('[data-fk="' + fk + '"]');
        if (next) { next.focus(); try { next.selectionStart = next.selectionEnd = caret; } catch (e) {} }
      }
    });
  }

  /* ======================================================================
     十三、事件绑定
     ====================================================================== */
  function draftFrom(node) {
    var out = {};
    node.querySelectorAll('[data-f]').forEach(function (el) {
      out[el.getAttribute('data-f')] = el.value;
    });
    return out;
  }
  function inputVal(sel) {
    var el = document.querySelector(sel);
    return el ? el.value : '';
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var a = el.getAttribute('data-act');
    var id = Number(el.getAttribute('data-id') || 0);
    var ui = UI();
    var s = S();
    switch (a) {
      case 'noop': return;
      case 'tab': E.act.setTab(el.getAttribute('data-k')); break;
      case 'setScreen': E.act.setScreen(el.getAttribute('data-k')); break;
      case 'toggleSide': st({ sideOpen: !ui.sideOpen }); break;
      case 'addProject': st({ projOpen: true, projIsNew: true, projDraft: null }); break;
      case 'editProject': st({ projOpen: true, projIsNew: false, projDraft: null }); break;
      case 'saveProject': {
        var d = draftFrom(layer);
        if (!d.name || !d.name.trim()) { E.act.toast(T('proj.needName')); break; }
        if (s.projects.length) { s.curProj.name = d.name; s.curProj.project_dir = d.dir; st({ projOpen: false }); E.act.toast(T('proj.saved')); }
        else E.act.createProject(d);
        st({ projOpen: false });
        break;
      }
      case 'archiveProject': if (s.curProj) { s.curProj.archived = !s.curProj.archived; st({}); } break;
      case 'pickProject': break;
      case 'logout': E.act.logout(); break;
      case 'boardSettings': s.board.settingsOpen = true; st({}); break;
      case 'openTrash': st({ trashOpen: true }); break;
      case 'closeModal': st({ projOpen: false, newTaskOpen: false, detailCard: null, sessKey: null, trashOpen: false, startMenuFor: null, rejectFor: null, wtFor: null, depFor: null, legendOpen: false, contFor: null, bugDlg: null, taskLogFor: null, detailEdit: false });
        s.board.settingsOpen = false; break;
      case 'openLegend': st({ legendOpen: true }); break;
      case 'quickAdd': {
        var ta = document.querySelector('[data-input="quick"]');
        var txt = ta ? ta.value : '';
        if (!txt.trim()) { E.act.cardCreate('未命名任务', false); } else { E.act.cardCreate(txt, false); }
        if (ta) ta.value = '';
        break;
      }
      case 'cardStart': {
        var r = E.act.cardStart(id, {});
        if (r && r.needDep) st({ depFor: id }); else st({ startMenuFor: null });
        break;
      }
      case 'startMenu': st({ startMenuFor: id }); break;
      case 'wtOpen': st({ startMenuFor: null, wtFor: id }); break;
      case 'wtStart': E.act.cardStart(id, { worktree: true }); st({ wtFor: null }); break;
      case 'cardForce': { var c1 = E.q.card(id); if (c1) c1.blockKind = ''; E.act.cardStart(id, { force: true }); st({ depFor: null }); break; }
      case 'cardStop': E.act.cardStop(id); break;
      case 'cardReview': E.act.cardMove(id, 'review'); break;
      case 'cardRetry': E.act.cardRetry(id); break;
      case 'cardPass': E.act.cardPass(id); break;
      case 'cardRejectOpen': st({ rejectFor: id, rejectText: '' }); break;
      case 'rejectOk': E.act.cardReject(id, inputVal('[data-input="rejectText"]')); st({ rejectFor: null }); break;
      case 'cardReopen': E.act.cardReopen(id); break;
      case 'cardTrash': E.act.cardTrash(id); break;
      case 'restore': E.act.cardRestore(id); break;
      case 'purge': if (window.confirm(T('board.purgeConfirm'))) E.act.cardPurge(id); break;
      case 'emptyTrash': if (window.confirm(T('board.clearConfirm'))) E.act.cardEmptyTrash(); break;
      case 'cardDetail': st({ detailCard: id, detailEdit: false }); break;
      case 'detailEditOn': { var c2 = E.q.card(id || ui.detailCard); st({ detailEdit: true, detailEditText: (c2.title + '\n' + c2.description).trim() }); break; }
      case 'detailCancel': st({ detailEdit: false }); break;
      case 'detailSave': {
        var txt = inputVal('[data-input="detailEdit"]') || ui.detailEditText || '';
        var parts = txt.split('\n');
        E.act.cardSave(ui.detailCard, (parts.shift() || '').trim(), parts.join('\n').trim());
        st({ detailEdit: false });
        break;
      }
      case 'cleanWt': E.act.cardCleanWorktree(Number(el.getAttribute('data-id')) || ui.detailCard); break;
      case 'cardSession': {
        var card3 = E.q.card(id);
        if (!card3 || !card3.session_id) { E.act.toast(T('board.noSession')); break; }
        st({ sessKey: 'card:' + id, detailCard: null, askMin: false, askIndex: false });
        break;
      }
      case 'commentSave': E.act.cardComment(Number(el.getAttribute('data-id')), inputVal('[data-input="comment"]'), false); break;
      case 'commentDeliver': E.act.cardComment(Number(el.getAttribute('data-id')), inputVal('[data-input="comment"]'), true); break;
      case 'cardEditTitle': {
        var card4 = E.q.card(id);
        st({ cardEdit: id, cardEditText: card4.title });
        setTimeout(function () { var t2 = document.querySelector('[data-input="titleEdit"]'); if (t2) { t2.focus(); t2.select(); } }, 0);
        break;
      }
      case 'newTask': st({ newTaskOpen: true, taskDraft: { type: 'normal', endStage: 'report', stopType: 'rounds', stopValue: '2', retest: '全部失败用例' } }); break;
      case 'ntType': { var d2 = Object.assign({}, ui.taskDraft, { type: el.getAttribute('data-k') }); st({ taskDraft: d2, newTaskOpen: true }); break; }
      case 'ntEnd': st({ taskDraft: Object.assign({}, ui.taskDraft, { endStage: el.getAttribute('data-k') }), newTaskOpen: true }); break;
      case 'ntStop': st({ taskDraft: Object.assign({}, ui.taskDraft, { stopType: el.getAttribute('data-k') }), newTaskOpen: true }); break;
      case 'ntRetest': st({ taskDraft: Object.assign({}, ui.taskDraft, { retest: el.getAttribute('data-k') }), newTaskOpen: true }); break;
      case 'ntSubmit': {
        var d3 = Object.assign({}, ui.taskDraft, draftFrom(layer));
        var tk = E.act.createTask({
          name: d3.name, type: d3.type, endStage: d3.endStage, stopType: d3.stopType,
          stopValue: d3.stopValue, other: d3.other, dateFrom: d3.dateFrom, dateTo: d3.dateTo, retest: d3.retest,
        });
        st({ newTaskOpen: false, taskDraft: null });
        if (s.tab !== 'board') E.act.setTab('board');
        break;
      }
      case 'taskToggle': st({ taskOpen: ui.taskOpen === id ? null : id }); break;
      case 'taskStop': E.act.taskStop(id); break;
      case 'taskRestart': E.act.taskRestart(id); break;
      case 'taskDelete': E.act.taskDelete(id); break;
      case 'taskContinue': st({ contFor: id }); break;
      case 'contOk': E.act.taskContinue(id, { stopValue: inputVal('[data-f="contRounds"]') }); st({ contFor: null }); break;
      case 'taskLog': st({ taskLogFor: id }); break;
      case 'taskSession': {
        var tk2 = E.q.task(id);
        if (!tk2 || !tk2.session_id) { E.act.toast(T('board.noSession')); break; }
        st({ sessKey: 'task:' + id, askMin: false, askIndex: false });
        break;
      }
      case 'chartPrev': st({ monitorChart: (ui.monitorChart + 4) % 5 }); break;
      case 'chartNext': st({ monitorChart: (ui.monitorChart + 1) % 5 }); break;
      case 'monCase': st({ monitorCase: el.getAttribute('data-id') }); break;
      case 'evFilter': st({ eventFilter: el.getAttribute('data-k') }); break;
      case 'bugOpen': st({ bugOpen: el.getAttribute('data-dir') }); break;
      case 'bugTab': st({ bugTab: el.getAttribute('data-k') }); break;
      case 'bugRetestOpen': st({ bugDlg: { kind: 'retest', dir: ui.bugOpen }, retestScope: 'retest_only' }); break;
      case 'bugFixOpen': st({ bugDlg: { kind: 'fix', dir: ui.bugOpen }, fixEnd: 'fix' }); break;
      case 'bugRejectOpen': st({ bugDlg: { kind: 'reject', dir: ui.bugOpen } }); break;
      case 'retestScope': st({ retestScope: el.getAttribute('data-k') }); break;
      case 'fixEnd': st({ fixEnd: el.getAttribute('data-k') }); break;
      case 'bugRetestOk': E.act.bugRetest(ui.bugOpen, ui.retestScope || 'retest_only'); st({ bugDlg: null }); break;
      case 'bugFixOk': E.act.bugFix(ui.bugOpen, { endStage: ui.fixEnd || 'fix', note: inputVal('[data-input="fixNote"]') }); st({ bugDlg: null }); break;
      case 'bugRejectOk': E.act.bugReject(ui.bugOpen, inputVal('[data-input="rejectReason"]')); st({ bugDlg: null }); break;
      case 'stressOpen': st({ stressOpen: id }); break;
      case 'stressTab': st({ stressTab: el.getAttribute('data-k') }); break;
      case 'stressRerun': E.act.stressRerun(Number(el.getAttribute('data-id'))); break;
      case 'stressStop': E.act.stressStop(Number(el.getAttribute('data-id'))); break;
      case 'stressRestart': E.act.taskRestart(Number(el.getAttribute('data-id'))); break;
      case 'stressDiag': E.act.toast(T('settings.notCovered')); break;
      case 'setSection': st({ settingsSection: el.getAttribute('data-k') }); break;
      case 'skin': E.act.prefs({ skin: el.getAttribute('data-k') }); break;
      case 'fs': E.act.prefs({ fs: Number(el.getAttribute('data-v')) }); break;
      case 'demoUncovered': E.act.toast(T('settings.notCovered')); break;
      case 'coachNext': E.act.coach.next(); break;
      case 'coachSkip': E.act.coach.skip(); break;
      case 'coachToggle': E.act.coach.toggle(); break;
      case 'toggleAskIndex': st({ askIndex: !ui.askIndex }); break;
      case 'askMin': st({ askMin: !ui.askMin }); break;
      case 'askOpt': {
        var sess = s.sessions[ui.sessKey];
        if (!sess || !sess.interaction) break;
        var it = sess.interaction;
        var qq = it.questions[it.page];
        var o = qq.options[Number(el.getAttribute('data-i'))];
        if (it.multi) {
          var cur = it.answers[it.page] || [];
          var k = cur.indexOf(o.label);
          if (k >= 0) cur.splice(k, 1); else cur.push(o.label);
          it.answers[it.page] = cur;
        } else it.answers[it.page] = o.label;
        st({});
        break;
      }
      case 'askPrev': { var s1 = s.sessions[ui.sessKey]; if (s1 && s1.interaction) s1.interaction.page = Math.max(0, s1.interaction.page - 1); st({}); break; }
      case 'askNext': { var s2 = s.sessions[ui.sessKey]; if (s2 && s2.interaction) s2.interaction.page = Math.min(s2.interaction.questions.length - 1, s2.interaction.page + 1); st({}); break; }
      case 'approve': {
        var sA = s.sessions[ui.sessKey];
        if (!sA || !sA.interaction) break;
        var decision = el.getAttribute('data-k');
        var answers = {}; answers[0] = decision;
        E.act.answer(Number(ui.sessKey.split(':')[1]), ui.sessKey, answers);
        if (decision !== 'rejected') E.act.toast(T('session.approval.approved'));
        break;
      }
      case 'askSubmit': {
        var s3 = s.sessions[ui.sessKey];
        if (!s3 || !s3.interaction) break;
        var other = inputVal('[data-input="askOther"]');
        if (other) s3.interaction.answers[s3.interaction.page] = other;
        E.act.answer(Number(ui.sessKey.split(':')[1]), ui.sessKey, s3.interaction.answers);
        st({ askMin: false });
        break;
      }
      case 'sessSend': {
        var val = inputVal('[data-input="sessMsg"]');
        E.act.sessionSend(ui.sessKey, val, false);
        var ta2 = document.querySelector('[data-input="sessMsg"]'); if (ta2) ta2.value = '';
        st({ sessMsgDraft: '' });
        break;
      }
      case 'inject': {
        var val2 = inputVal('[data-input="sessMsg"]');
        E.act.sessionSend(ui.sessKey, val2 || (s.sessions[ui.sessKey].msgs.filter(function (m) { return m.state === 'queue'; })[0] || {}).text || '', true);
        var ta3 = document.querySelector('[data-input="sessMsg"]'); if (ta3) ta3.value = '';
        st({ sessMsgDraft: '', slashQuery: '' });
        break;
      }
      case 'sessStop': {
        var key = ui.sessKey;
        if (key.indexOf('card:') === 0) E.act.cardStop(Number(key.split(':')[1]));
        else E.act.taskStop(Number(key.split(':')[1]));
        break;
      }
      case 'sessPass': E.act.cardPass(Number(ui.sessKey.split(':')[1])); st({ sessKey: null }); break;
      case 'sessDeliver': E.act.deliverNow(Number(ui.sessKey.split(':')[1])); break;
      case 'slashPick': {
        var cmd = el.getAttribute('data-k');
        runSlash(cmd, ui.sessKey);
        var taS = document.querySelector('[data-input="sessMsg"]');
        if (taS) { taS.value = ''; taS.focus(); }
        st({ sessMsgDraft: '', slashQuery: '' });
        break;
      }
      default: break;
    }
  });

  /* 表单提交（登录） */
  document.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (ev.target.closest('[data-act="loginForm"]')) E.act.login();
  });

  /* 输入：把草稿写进 state（区域签名不含草稿，所以不会触发重画） */
  document.addEventListener('input', function (ev) {
    var el = ev.target;
    var kind = el.getAttribute && el.getAttribute('data-input');
    if (!kind) return;
    if (kind === 'search') E.act.setSearch(el.value);
    else if (kind === 'taskSearch') st({ taskSearch: el.value });
    else if (kind === 'sessMsg') { st({ sessMsgDraft: el.value }); updateSlash(el.value); }
    else if (kind === 'quick') st({ quickDraft: el.value });
    else if (kind === 'rejectText') st({ rejectText: el.value });
    else if (kind === 'titleEdit') st({ cardEditText: el.value });
    else if (kind === 'detailEdit') st({ detailEditText: el.value });
    else if (kind === 'askOther') st({ askOtherDraft: el.value });
  });

  /* 下拉：过滤/排序/皮肤等 */
  document.addEventListener('change', function (ev) {
    var el = ev.target;
    var sel = el.getAttribute && el.getAttribute('data-sel');
    if (!sel) return;
    if (sel === 'filter') E.act.setFilter(el.getAttribute('data-col'), el.value);
    else if (sel === 'sort') E.act.setSort(el.getAttribute('data-col'), el.value);
    else if (sel === 'mode') E.act.setMode(el.value);
    else if (sel === 'dep') E.act.cardDep(UI().detailCard, el.value);
    else if (sel === 'perm' || sel === 'effort') {
      var sess = S().sessions[UI().sessKey];
      if (sess) { sess[sel === 'perm' ? 'permission' : 'effort'] = el.value; st({}); }
    }
  });

  /* 标题行内编辑快捷键 */
  document.addEventListener('keydown', function (ev) {
    var el = ev.target;
    var kind = el.getAttribute && el.getAttribute('data-input');
    if (!kind) return;
    if (kind === 'quick' && ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      var txt = el.value;
      E.act.cardCreate(txt.trim() ? txt : '未命名任务', ev.ctrlKey || ev.metaKey);
      el.value = '';
    }
    if (kind === 'titleEdit' && (ev.key === 'Enter' || ev.key === 'Escape')) {
      ev.preventDefault();
      if (ev.key === 'Enter') {
        var parts = el.value.split('\n');
        E.act.cardSave(UI().cardEdit, (parts.shift() || '').trim(), parts.join('\n').trim());
      }
      st({ cardEdit: null });
    }
    if (kind === 'sessMsg' && ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      var v = el.value.trim();
      if (v.charAt(0) === '/' && slashItems(v).length) {   // /xxx 直接回车 = 执行该命令
        runSlash(v, UI().sessKey);
        el.value = '';
        st({ sessMsgDraft: '', slashQuery: '' });
        return;
      }
      E.act.sessionSend(UI().sessKey, el.value, false);
      el.value = '';
      st({ sessMsgDraft: '', slashQuery: '' });
    }
  });

  /* ---------- 拖拽（HTML5 DnD；指针设备可用，触屏走按钮路径） ---------- */
  document.addEventListener('dragstart', function (ev) {
    var card = ev.target.closest('[data-card]');
    if (!card) return;
    dragging.id = Number(card.getAttribute('data-card'));
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', String(dragging.id)); } catch (e) {}
    card.classList.add('is-drag');
  });
  document.addEventListener('dragover', function (ev) {
    var col = ev.target.closest('[data-drop]');
    if (!col) return;
    ev.preventDefault();
    var key = col.getAttribute('data-drop');
    if (dragging.over !== key) {
      dragging.over = key;
      document.querySelectorAll('.board-col').forEach(function (n) {
        n.classList.toggle('dragover', n.getAttribute('data-col') === key);
      });
    }
  });
  document.addEventListener('drop', function (ev) {
    var col = ev.target.closest('[data-drop]');
    if (!col) return;
    ev.preventDefault();
    var id = dragging.id;
    dragging.id = null; dragging.over = null;
    document.querySelectorAll('.board-col').forEach(function (n) { n.classList.remove('dragover'); });
    if (id) {
      var target = col.getAttribute('data-drop');
      if (target === 'doing') {
        var r = E.act.cardStart(id, {});
        if (r && r.needDep) st({ depFor: id });
      } else if (target === 'blocked') {
        E.act.cardBlock(id);
      } else E.act.cardMove(id, target);
    }
    render();
  });
  document.addEventListener('dragend', function () {
    dragging.id = null; dragging.over = null;
    document.querySelectorAll('.board-col').forEach(function (n) { n.classList.remove('dragover'); });
  });

  /* ---------- 顶栏控件 ---------- */
  var speedSel = document.getElementById('speed');
  if (speedSel) speedSel.addEventListener('change', function () { E.act.setSpeed(speedSel.value); });
  var coachBtn = document.getElementById('coachBtn');
  if (coachBtn) coachBtn.addEventListener('click', function () { E.act.coach.toggle(); });
  var resetBtn = document.getElementById('resetBtn');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    if (window.confirm(T('top.resetConfirm'))) { E.reset(); E.act.toast(T('toast.reset')); render(); }
  });
  var tagBtn = document.getElementById('dtopTag');
  if (tagBtn) { tagBtn.style.cursor = 'pointer'; tagBtn.addEventListener('click', function () { st({ legendOpen: true }); }); }

  /* ---------- 启动 ---------- */
  E.on(function () {
    if (S().screen === 'login') { if (app.dataset.screen !== 'login') { app.dataset.screen = 'login'; render(); } return; }
    if (S().screen === 'settings' && app.dataset.screen !== 'settings') { app.dataset.screen = 'settings'; render(); return; }
    if (app.dataset.screen !== 'app') { app.dataset.screen = 'app'; render(); return; }
    /* 结构级变化（弹窗开关、tab、选中）→ 整体重画 */
    var sig = structSig();
    if (app.dataset.struct !== sig) { app.dataset.struct = sig; render(); return; }
    syncNow();
    renderCoach();
    renderToast();
  });

  function structSig() {
    var ui = UI(), s = S();
    return [s.screen, s.tab, ui.projOpen, ui.newTaskOpen, ui.detailCard, ui.sessKey, ui.trashOpen,
      s.board.settingsOpen, ui.startMenuFor, ui.rejectFor, ui.wtFor, ui.depFor, ui.legendOpen,
      ui.contFor, ui.bugDlg && ui.bugDlg.kind, ui.taskLogFor, ui.sideOpen, ui.settingsSection,
      ui.bugOpen, ui.bugTab, ui.taskOpen, ui.stressOpen, ui.stressTab, ui.detailEdit,
      ui.monitorChart, ui.eventFilter, ui.coachOn, ui.coachIdx, s.prefs.skin, s.prefs.fs,
      s.screen === 'settings' ? 'set' : ''].join('|');
  }

  E.start();
  render();
})();
