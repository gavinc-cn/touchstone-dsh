/* ==========================================================================
   Touchstone 在线 Demo —— 模拟引擎
   设计语境与维护约定见 website/README.md

   这个文件里没有任何网络请求：它是一个跑在浏览器里的「平台替身」，把产品里
   可观察的机制按同一套规则重放出来：

     1) 项目级单队列 —— 一个项目同时只跑一个单元（串行档），切到并行档放开到 5
        个窗口；排队顺序 = seq 升序，队序即展示序。
     2) 卡片状态机 —— 开始/拖列/强制/停止/通过/打回/重开，容器迁移即出队。
     3) 会话模拟器 —— 一轮 = 一次会话，条目类型（think / tool_call / tool_result /
        assistant）与产品 sessparse 产出的 entry 模型一致，按节奏流式播出。
     4) 提问作答闭环 —— agent 提问 ⇒ 卡片落「阻塞 · 等待作答」并占着运行位；
        作答入队（已作答·待送达）⇒ 项目空闲时送达 ⇒ 会话续跑。
     5) 任务引擎 —— 六类任务 × 七阶段，轮次推进、停止条件、终点>生成报告时连带
        创建后段（pipeline）任务；产物（用例、bug 报告）写进案例库/Bug 报告。

   凡是机械规则，尽量与 server.py / board.py / waitq.py 的判定同构；凡是产品里
   由后端测量的量（真实 SSE、真实文件系统），这里都由脚本按节奏生成，页面里已
   显著标注「静态模拟」。
   ========================================================================== */
(function () {
  'use strict';

  var TICK = 250;            // 心跳：250ms 一拍
  var HOLD_START = 900;      // 启动宽限（starting → running）
  var HOLD_SEND = 1500;      // 送达单元耗时（补位器下一拍把答卷递进去的可见延迟）
  var INTERACTION_HOLD = 1200;

  /* ---------- 文案快捷取用 ---------- */
  function t(path) { return window.T(path); }

  /* ---------- 时间（虚拟时钟：随演示速度推进，好让「删除于/创建时间」动起来） ---------- */
  var S = null;              // 全量状态，见 reset()

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
           pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtHM(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function rid(n) {
    var s = '', h = 'abcdef0123456789';
    for (var i = 0; i < (n || 6); i++) s += h[Math.floor(Math.random() * 16)];
    return s;
  }
  function newSid() { return 'session_' + rid(8) + '-' + rid(4) + '-' + rid(4); }

  /* ======================================================================
     状态构造：初始（登录页，未建项目）
     ====================================================================== */
  function reset(keepSpeed) {
    var speed = keepSpeed && S ? S.speed : 2;
    S = {
      screen: 'login',            // login | app | settings
      speed: speed,
      now: Date.now(),                   // 虚拟时钟从当前时间起（随演示速度推进）
      user: null,
      projects: [],
      curProj: null,
      tab: 'board',
      prefs: { skin: 'starlight', fs: 1 },
      board: {
        mode: 'serial',
        search: '',
        filters: {},              // 列 → all|dev|test
        sorts: {},                // 列 → 排序方案
        cards: [], seq: 391, trash: [], trashSeq: 900,
        settingsOpen: false, jira: { url: '', user: '', token: '' },
      },
      queue: [],                  // 统一队列单元
      tasks: [], seqTask: 97,
      cases: [], bugs: [], events: [],
      live: null,
      stress: { nextRun: 1 },
      sessions: {},               // key → session
      ui: {
        projOpen: false, projDraft: null,
        newTaskOpen: false, taskDraft: null,
        detailCard: null, sessKey: null,
        trashOpen: false, rejectFor: null, rejectText: '',
        wtFor: null, wtPreview: null,
        cardEdit: null, cardEditText: '',
        taskOpen: null, bugOpen: null, bugTab: 'report',
        stressOpen: null, stressTab: 'plan',
        monitorCase: null, monitorChart: 0, eventFilter: 'all',
        coachIdx: 0, coachOn: true,
        answeredOnce: false, sawBug: false, startedCard: false,
      },
      toasts: [],
      logs: [],                   // 调试用（不进 UI）
      tickCount: 0,
    };
    seedProject();               // 冷启动时先不建项目；这里只准备「示例项目」的物料
    S.projects = [];
    S.curProj = null;
    S.screen = 'login';
  }

  /* ======================================================================
     示例项目（用户点「保存」后才挂上；物料在这里备好）
     ====================================================================== */
  var SEED = null;              // 由 seedProject() 生成，createProject() 时装载

  function seedProject() {
    var sd = t('seed');
    SEED = {
      project: {
        id: 1,
        name: sd.projectName,
        project_dir: sd.projectDir,
        work_dir: sd.workDir,
        env_tag: sd.envTag,
        guide_text: sd.projectPrompt,
        agent: t('proj.agentVal'),
        archived: false,
        counts: { doing: 0, blocked: 1, review: 1 },
      },
      cards: [
        mkSeedCard(391, 'blocked', sd.cards.c1, { blockKind: 'interaction', blockText: t('board.badgeWait') }),
        mkSeedCard(392, 'todo', sd.cards.c2, {}),
        mkSeedCard(393, 'todo', sd.cards.c3, { dep: 392 }),
        mkSeedCard(394, 'review', sd.cards.c4, {}),
        mkSeedCard(395, 'todo', sd.cards.c5, {}),
        mkSeedCard(388, 'done', sd.cards.c6, {}),
        mkSeedCard(389, 'done', sd.cards.c7, {}),
        mkSeedCard(390, 'done', sd.cards.c8, {}),
      ],
      tasks: [
        { id: 94, name: sd.taskDone.name, task_type: 'regression', status: 'done', current_round: 1,
          stop_type: 'rounds', stop_value: '1', start_stage: 'execute', end_stage: 'report',
          created_at: fmtTime(S.now - 2 * 86400000), started_at: fmtTime(S.now - 2 * 86400000 + 60000),
          ended_at: fmtTime(S.now - 2 * 86400000 + 900000), new_cases: 3, new_bugs: 1, rounds: 1,
          other: sd.taskDone.other, session_id: newSid(), auto_fix: 1, retest: '全部失败用例', model: t('tasks.byType') },
        { id: 96, name: sd.taskStress.name, task_type: 'stress', status: 'done', current_round: 1,
          stop_type: 'rounds', stop_value: '1', start_stage: '', end_stage: '',
          created_at: fmtTime(S.now - 86400000), started_at: fmtTime(S.now - 86400000 + 30000),
          ended_at: fmtTime(S.now - 86400000 + 660000), new_cases: 0, new_bugs: 0, rounds: 1,
          other: sd.taskStress.other, session_id: newSid(), auto_fix: 0, retest: '不复测', model: t('tasks.byType'),
          load: { runs: [seedLoadRun()], charts: true } },
      ],
      cases: sd.cases.map(function (c) {
        return { id: c.id, name: c.name, mod: c.mod, status: c.status, last: fmtTime(S.now - 7200000), bug: c.status === 'fail' ? 'bug_report' : '' };
      }),
      bugs: sd.bugs.map(function (b, i) {
        return { dir: b.dir, title: b.title, status: b.status, cases: b.cases, note: b.note,
                 created: fmtTime(S.now - (i + 1) * 86400000), last_task: i === 0 ? 94 : null };
      }),
      events: [
        { at: fmtTime(S.now - 86400000), kind: '阶段', text: 'R 复测 · 按变更文件粗筛候选用例' },
        { at: fmtTime(S.now - 86400000 + 30000), kind: '开始', text: '第 1 轮开始' },
        { at: fmtTime(S.now - 86400000 + 120000), kind: '用例', text: 'FS0001 下单金额为 0 应被拒绝' },
        { at: fmtTime(S.now - 86400000 + 180000), kind: '通过', text: 'FS0001 通过（0.8s）' },
        { at: fmtTime(S.now - 86400000 + 240000), kind: '失败', text: 'FS0007 币种缺失返回参数错误 · 返回 500' },
        { at: fmtTime(S.now - 86400000 + 300000), kind: '新Bug', text: '20261006_1512_FS_退款签名未校验' },
      ],
    };
  }

  /* 种子压测运行：一条 60 秒的曲线，好让「压测日志」页进来就有东西看 */
  function seedLoadRun() {
    var series = [], metrics = { total: 0, err: 0, p95: 0, rps: 0, errRate: 0 };
    for (var s = 0; s <= 60; s += 2) {
      var ramp = Math.min(1, s / 10);
      var rps = Math.round((330 + Math.sin(s / 4) * 40) * (0.5 + 0.5 * ramp));
      var p50 = Math.round(30 + ramp * 10 + Math.sin(s / 5) * 4);
      var p95 = Math.round(p50 * 1.9);
      var p99 = Math.round(p95 * 1.35);
      var err = Math.round((0.3 + (s > 40 ? 0.9 : 0.2) + Math.sin(s / 7) * 0.2) * 100) / 100;
      metrics.total += rps * 2;
      metrics.err += Math.round(rps * 2 * err / 100);
      metrics.rps = rps; metrics.p95 = p95; metrics.errRate = err;
      series.push({ s: s, rps: rps, p50: p50, p95: p95, p99: p99, err: err });
    }
    return { key: '20261006_0930', status: 'ok', started: fmtTime(S.now - 86400000 + 60000), elapsed: 60, series: series, metrics: metrics };
  }

  function mkSeedCard(id, column, copy, extra) {    var c = {
      id: id, title: copy.title, description: copy.desc, column: column,
      created_at: fmtTime(S.now - (400 - id) * 3600000),
      updated_at: fmtTime(S.now - (400 - id) * 1800000),
      order: id,
      unread: false, queueState: '', blockKind: '', blockText: '',
      answerPending: false, running: false, worktree: '', scheduled_at: '',
      parent: 0, origin: '', jira: '', last_error: '', session_id: null,
      comments: [],
    };
    Object.keys(extra || {}).forEach(function (k) { c[k] = extra[k]; });
    if (id === 391) {
      c.comments = [{ at: fmtTime(S.now - 3600000), text: t('seed.comments')[0].text, delivered: true }];
    }
    return c;
  }

  /* ======================================================================
     会话模型
     ====================================================================== */
  function mkSession(key, title, script) {
    var s = {
      sid: newSid(), key: key, title: title, script: script, step: 0,
      hold: 0, waiting: false, interaction: null, answered: 0,
      entries: [], msgs: [], ctx: 6, model: 'deepseek-chat', effort: 'high',
      permission: 'manual', created: fmtTime(S.now), closed: false,
    };
    S.sessions[key] = s;
    return s;
  }

  function ent(s, kind, payload) {
    var e = { kind: kind, seq: s.entries.length + 1, at: S.now };
    Object.keys(payload || {}).forEach(function (k) { e[k] = payload[k]; });
    s.entries.push(e);
    return e;
  }

  /* ======================================================================
     队列单元
     ====================================================================== */
  function unit(kind, ref, label, sessionKey) {
    var u = {
      id: kind + ':' + ref + ':' + (S.queue.length + 1),
      kind: kind, ref: ref, label: label, sessionKey: sessionKey,
      state: 'waiting', seq: nextSeq(), hold: 0, born: S.now,
    };
    S.queue.push(u);
    return u;
  }
  function nextSeq() {
    var max = 0;
    S.queue.forEach(function (u) { if (u.seq > max) max = u.seq; });
    return max + 10;
  }
  function unitOf(kind, ref) {
    for (var i = S.queue.length - 1; i >= 0; i--) {
      var u = S.queue[i];
      if (u.kind === kind && u.ref === ref && (u.state === 'waiting' || u.state === 'starting' || u.state === 'running')) return u;
    }
    return null;
  }
  function answerUnitOf(ref) { return unitOf('a', ref); }

  function activeUnits() {
    return S.queue.filter(function (u) { return u.state === 'starting' || u.state === 'running'; });
  }
  function windowSize() { return S.board.mode === 'parallel' ? 5 : 1; }

  /* 派生态：卡片 queue_state（口径与 queueBadge.js 的八枚举一致）
     优先级：待送达 > 等待作答 > 启动中 > 运行中 > 排队中 > 空闲
     （提问挂起时 c: 行仍在前缀内占着运行位，但展示态必须是「等待作答」） */
  function queueStateOf(card) {
    var u = unitOf('c', card.id) || unitOf('ext', card.id);
    if (card.answerPending) return 'answer_pending';
    if (card.blockKind === 'interaction') return 'interaction_pending';
    if (u && u.state === 'starting') return 'starting';
    if ((u && u.state === 'running') || card.running) return 'running';
    if (u && u.state === 'waiting') return 'queued_serial';
    return 'idle';
  }
  /* 位次：等待区里排第几位（前缀=运行中的单元不计数） */
  function posOf(kind, ref) {
    var waiting = S.queue.filter(function (u) { return u.state === 'waiting'; })
      .sort(function (a, b) { return a.seq - b.seq; });
    for (var i = 0; i < waiting.length; i++) {
      if (waiting[i].kind === kind && waiting[i].ref === ref) return i + 1;
    }
    return 0;
  }
  function taskQueueState(task) {
    var u = unitOf('t', task.id);
    if (!u) return '';
    if (u.state === 'starting') return 'starting';
    if (u.state === 'running') return 'running';
    return 'queued_serial';
  }

  /* ======================================================================
     调度：补位（与 runner 的窗口闸同构）
     占位口径（与服务端行口径对齐）：
       - 运行位只被「真在干活」的单元占着：挂起在交互上的会话（等作答/等审批）
         会实时收口、让出位子（产品：挂起 interaction 态「行随实况收口，队列继续」），
         否则一个没人回答的提问会把整个项目钉死；
       - a: 行（送达答卷）不占位，但要排在等待区最前，窗口一有余量先送；
       - 独立 worktree 卡（ext:）不入队、不占位。
     ====================================================================== */
  /* 挂起在交互上的会话（等作答/等审批）：行还在，但不再占运行位 */
  function isSuspended(u) {
    var s = S.sessions[u.sessionKey];
    return !!(s && s.waiting);
  }
  /* 真正占着运行位的单元 */
  function slotHolders() {
    return activeUnits().filter(function (u) {
      return u.kind !== 'ext' && u.kind !== 'a' && !isSuspended(u);
    });
  }

  function schedule() {
    var win = windowSize();
    var holders = slotHolders().length;
    /* 一条队、seq 升序；a: 行被插在「运行前缀之后、等待区最前」（seq 最小），
       所以窗口一有余量先送答卷 —— 这就是产品里「死锁豁免在补位器选择性折抵」的
       可观察结果：提问的会话挂起时让出运行位，答卷回来时优先补位。 */
    var waiting = S.queue.filter(function (u) { return u.state === 'waiting' && u.kind !== 'ext'; })
      .sort(function (a, b) { return a.seq - b.seq; });
    while (holders < win && waiting.length) {
      var u = waiting.shift();
      if (u.kind === 'a') {
        var s = S.sessions[u.sessionKey];
        if (!s || !s.waiting) continue;          // 会话已不再等待：这份答卷作废
        u.state = 'running';
        u.hold = HOLD_SEND;
      } else {
        startUnit(u);
        holders++;
      }
    }
  }

  function startUnit(u) {
    u.state = 'starting';
    u.hold = HOLD_START;
    if (u.kind === 'c') { var c = card(u.ref); if (c) { c.running = true; c.blockKind = 'queue'; } }
    if (u.kind === 't') {
      var tk = task(u.ref);
      if (tk) {
        tk.status = 'running';
        tk.started_at = tk.started_at || fmtTime(S.now);
        /* 监控面板的数据源：live.json 那一份在真实平台里由 agent 写，这里随任务起跑重置 */
        S.live = {
          taskId: tk.id, round: (tk.rounds || 0) + 1, phase: 'R', phaseLabel: t('monitor.phases')[0],
          currentCase: null, stats: { proposal: 0, stored: 0, rejected: 0, executed: 0, pass: 0, fail: 0, skip: 0, bugs: 0 },
        };
      }
    }
    pushEvent('开始', (u.kind === 't' ? '任务 #' + u.ref : '卡片 #' + u.ref) + ' 开始执行');
  }

  function finishUnit(u) {
    u.state = 'done';
    u.doneAt = S.now;
    if (u.kind === 'c' || u.kind === 'ext') {
      var c = card(u.ref);
      if (c) {
        c.running = false;
        if (c.column === 'doing') { c.blockKind = ''; c.column = 'review'; c.unread = true; toast(t('toast.finished')); }
      }
    }
    if (u.kind === 't') { /* 任务收尾在 pump 的任务分支里处理 */ }
    if (u.kind === 'm') { var s1 = S.sessions[u.sessionKey]; if (s1) s1.msgs = s1.msgs.filter(function (m) { return m.id !== u.ref; }); }
    if (u.kind === 'a') { /* 见 deliverAnswer */ }
  }

  /* ======================================================================
     会话推进（一拍一步）
     ====================================================================== */
  function pump(u, dt) {
    var s = S.sessions[u.sessionKey];
    if (!s) { finishUnit(u); return; }
    if (s.hold > 0) {
      s.hold -= dt;
      if (s.hold > 0) return;
      if (s.afterHold) { var fn = s.afterHold; s.afterHold = null; fn(); }
    }
    if (s.waiting && !s.resumed) return;      // 停在提问上：占着运行位等作答
    s.resumed = false;
    var guard = 0;
    while (guard++ < 40) {
      if (s.hold > 0) return;
      if (s.step >= s.script.length) { closeSession(u, s); return; }
      var st = s.script[s.step++];
      runStep(u, s, st);
      if (s.waiting) return;
    }
  }

  function closeSession(u, s) {
    s.closed = true;
    ent(s, 'assistant', { text: s.outro || t('toast.finished') });
    if (u.kind === 't') { settleTask(u); return; }
    finishUnit(u);
  }

  function runStep(u, s, st) {
    switch (st.k) {
      case 'think':
        ent(s, 'think', { text: st.text });
        s.hold = st.dur || 700;
        break;
      case 'say':
        ent(s, 'assistant', { text: st.text });
        s.hold = st.dur || 900;
        break;
      case 'tool':
        ent(s, 'tool_call', { name: st.name, args: st.args });
        s.hold = 420;
        s.afterHold = function () { ent(s, 'tool_result', { name: st.name, result: st.result, err: !!st.err }); };
        break;
      case 'case':                                   // 用例产出/执行
        caseStep(st);
        s.hold = st.dur || 500;
        break;
      case 'bug':
        bugStep(st);
        s.hold = st.dur || 600;
        break;
      case 'phase':
        if (S.live) { S.live.phase = st.phase; S.live.phaseLabel = t('monitor.phases')[st.idx] || ''; }
        pushEvent('阶段', st.text || (t('monitor.phases')[st.idx] || ''));
        s.hold = 500;
        break;
      case 'ask':
        askStep(u, s, st);
        break;
      case 'approval':
        /* 审批代答：仅「逐条确认」档下真的停下来问；yolo/auto 直接放行
           （与产品一致：manual = 平台接管审批代答） */
        if (s.permission === 'manual') approvalStep(u, s, st);
        else s.hold = 200;
        break;
      case 'stats':
        if (S.live) {
          S.live.stats = S.live.stats || { proposal: 0, stored: 0, rejected: 0, executed: 0, pass: 0, fail: 0, skip: 0, bugs: 0 };
          Object.keys(st.set || {}).forEach(function (k) { S.live.stats[k] += st.set[k]; });
        }
        s.hold = 300;
        break;
      case 'outro':
        s.outro = st.text;
        s.hold = 600;
        break;
      case 'load':                                    // 压测：进入发压
        startStressRun(u, s, st);
        return;
      default:
        s.hold = 300;
    }
  }

  /* ---------- 用例 ---------- */
  function caseStep(st) {
    if (st.add) {
      var maxN = 0;
      S.cases.forEach(function (c) { var n = Number(String(c.id).replace(/\D/g, '')); if (n > maxN) maxN = n; });
      var id = 'FS' + pad(maxN + 1);
      S.cases.push({ id: id, name: st.add.name, mod: st.add.mod, status: 'pending', last: fmtTime(S.now), bug: '' });
      pushEvent('用例', id + ' ' + st.add.name);
      if (S.live) {
        S.live.stats.proposal += 1;
        S.live.stats.stored += 1;
        var owner = task(S.live.taskId);
        if (owner) owner.new_cases = (owner.new_cases || 0) + 1;
      }
      return;
    }
    if (st.run) {
      var c = null;
      for (var i = 0; i < S.cases.length; i++) {
        if (S.cases[i].name === st.run) c = S.cases[i];
      }
      if (!c) return;
      c.status = st.status;
      c.last = fmtTime(S.now);
      S.live && (S.live.currentCase = c.id);
      pushEvent(st.status === 'pass' ? '通过' : (st.status === 'fail' ? '失败' : '用例'), c.id + ' ' + c.name + (st.note ? ' · ' + st.note : ''));
      if (S.live) {
        S.live.stats.executed += 1;
        if (st.status === 'pass') S.live.stats.pass += 1;
        if (st.status === 'fail') S.live.stats.fail += 1;
      }
    }
  }

  /* ---------- bug 报告 ---------- */
  function bugStep(st) {
    var dir = fmtTime(S.now).replace(/[- :]/g, '').slice(0, 13) + '_FS_' + st.slug;
    var b = { dir: dir, title: st.title, status: '待分析', cases: st.cases || [], note: st.note || '', created: fmtTime(S.now), last_task: S.live ? S.live.taskId : null };
    S.bugs.unshift(b);
    S.ui.sawBug = true;
    pushEvent('新Bug', dir);
    if (S.live) {
      S.live.stats.bugs += 1;
      var own = task(S.live.taskId);
      if (own) own.new_bugs = (own.new_bugs || 0) + 1;
    }
    toast('🐛 ' + st.title);
  }

  /* ---------- 提问：卡片/任务停下来等人 ---------- */
  function askStep(u, s, st) {
    s.waiting = true;
    s.resumed = false;
    s.interaction = {
      qid: 'q' + rid(6), header: st.header, questions: st.questions,
      page: 0, answers: {}, multi: !!st.multi, submitted: false,
    };
    ent(s, 'tool_call', { name: 'ask_user_question', args: { header: st.header, question: st.questions[0].question } });
    if (u.kind === 'c' || u.kind === 'ext') {
      var c = card(u.ref);
      if (c) { c.column = 'blocked'; c.blockKind = 'interaction'; c.blockText = t('board.badgeWait'); c.running = false; c.unread = true; }
      /* 卡片会让出/占用运行位：产品里 c: 行仍在运行前缀内（占位），这里保持占位 */
    }
    pushEvent('阶段', 'agent 提问：' + st.questions[0].question.slice(0, 24) + '…');
    s.hold = INTERACTION_HOLD;
  }

  /* ---------- 审批：manual 档下每个工具调用都要用户点头 ---------- */
  function approvalStep(u, s, st) {
    s.waiting = true;
    s.resumed = false;
    s.interaction = {
      qid: 'ap' + rid(6), kind: 'approval', action: st.action, tool: st.tool, input: st.input,
      submitted: false, answers: {}, questions: [],
    };
    if (u.kind === 'c' || u.kind === 'ext') {
      var c = card(u.ref);
      if (c) { c.column = 'blocked'; c.blockKind = 'interaction'; c.blockText = t('board.badgeWait'); c.running = false; c.unread = true; }
    }
    pushEvent('阶段', 'agent 请求审批：' + st.tool);
    s.hold = INTERACTION_HOLD;
  }

  /* ======================================================================
     用户动作
     ====================================================================== */
  function login() {
    S.user = { name: t('shell.user'), admin: true };
    S.screen = 'app';
    toast(t('toast.loggedIn'));
  }

  function createProject(draft) {
    var p = JSON.parse(JSON.stringify(SEED.project));
    p.name = draft.name || p.name;
    p.project_dir = draft.dir || p.project_dir;
    p.work_dir = draft.workdir || p.work_dir;
    p.env_tag = draft.env || p.env_tag;
    p.guide_text = draft.prompt || p.guide_text;
    p.created_at = fmtTime(S.now);
    S.projects = [p];
    S.curProj = p;
    // 装载示例物料（有历史的看板/案例库/bug 报告，好让演示一进来就有东西看）
    S.board.cards = JSON.parse(JSON.stringify(SEED.cards));
    S.tasks = JSON.parse(JSON.stringify(SEED.tasks));
    S.cases = JSON.parse(JSON.stringify(SEED.cases));
    S.bugs = JSON.parse(JSON.stringify(SEED.bugs));
    S.events = JSON.parse(JSON.stringify(SEED.events));
    S.board.seq = 396;
    S.seqTask = 97;
    S.tab = 'board';
    toast(t('proj.created'));
    /* 种子里的阻塞卡：预先挂一个「已问待答」的会话，进去就能作答 */
    seedBlockedCardSession();
    /* 种子压测任务：补一份方案包 */
    seedStressPlan();
  }

  function seedBlockedCardSession() {
    var c = card(391);
    if (!c) return;
    var q = t('seed.blockedQuestion');
    var s = mkSession('card:' + c.id, c.title, scriptCardAfterAnswer(c));
    s.waiting = true;
    s.step = 0;
    s.interaction = {
      qid: 'q' + rid(6), header: q.header,
      questions: [{ question: q.question, options: q.options, multi_select: false, other: true }],
      page: 0, answers: {}, multi: false, submitted: false,
    };
    ent(s, 'think', { text: '先确认改动范围：重试封装与幂等键是两件事，但都在回调路径上。' });
    ent(s, 'tool_call', { name: 'ask_user_question', args: { header: q.header, question: q.question } });
    c.session_id = s.sid;
    c.blockKind = 'interaction';
    c.blockText = t('board.badgeWait');
    c.running = false;
  }

  function seedStressPlan() {
    var st = task(96);
    if (st) st.session_id = st.session_id || newSid();
  }

  /* ---------- 看板：建卡 ---------- */
  function cardCreate(text, queueNow) {
    text = (text || '').trim();
    var lines = text.split('\n');
    var title = (lines.shift() || '').trim();
    var desc = lines.join('\n').trim();
    var c = {
      id: ++S.board.seq, title: title, description: desc, column: 'todo',
      created_at: fmtTime(S.now), updated_at: fmtTime(S.now), order: S.board.seq,
      unread: false, queueState: '', blockKind: '', blockText: '', answerPending: false,
      running: false, worktree: '', scheduled_at: '', parent: 0, origin: '', jira: '',
      last_error: '', session_id: null, comments: [],
    };
    S.board.cards.push(c);
    toast(t('toast.cardCreated'));
    if (queueNow) cardStart(c.id, {});
    return c;
  }

  function cardStart(id, opt) {
    opt = opt || {};
    var c = card(id);
    if (!c || c.column === 'done') return;
    if (c.parent) {
      var p = card(c.parent);
      if (p && p.column !== 'done' && !opt.force) { return { needDep: p }; }
    }
    if (opt.worktree) {
      c.worktree = (SEED.project.work_dir) + '/worktrees/card_' + c.id;
      c.column = 'doing';
      c.blockKind = '';
      var su = unit('ext', c.id, c.title, 'card:' + c.id);
      su.state = 'running';                       // 独立 worktree：不入队、不占运行位
      mkSession('card:' + c.id, c.title, scriptCardDev(c));
      c.session_id = S.sessions['card:' + c.id].sid;
      c.running = true;
      toast(t('toast.worktree'));
      return { ok: true };
    }
    c.column = 'doing';
    c.blockKind = 'queue';
    mkSession('card:' + c.id, c.title, scriptCardDev(c));
    c.session_id = S.sessions['card:' + c.id].sid;
    if (opt.force) {
      var fu = unit('c', c.id, c.title, 'card:' + c.id);
      fu.state = 'running';
      c.running = true;
      c.blockKind = '';
      toast(t('toast.forced'));
      return { ok: true };
    }
    unit('c', c.id, c.title, 'card:' + c.id);
    toast(t('toast.started'));
    return { ok: true };
  }

  function cardStop(id) {
    var c = card(id);
    if (!c) return;
    var u = unitOf('c', c.id);
    if (u) u.state = 'cancelled';
    var w = unitOf('ext', c.id);
    if (w) w.state = 'cancelled';
    var s = S.sessions['card:' + c.id];
    if (s) s.closed = true;
    c.running = false; c.blockKind = ''; c.answerPending = false;
    c.column = 'review';
    toast(t('toast.stopped'));
  }

  function cardMove(id, column, index) {
    var c = card(id);
    if (!c || c.column === column) return;
    if (column === 'doing') { cardStart(id, {}); return; }
    /* 容器迁移即出队：离开「正在开发」⇒ 行终态化 */
    var u = unitOf('c', id) || unitOf('ext', id);
    if (u) u.state = 'cancelled';
    var a = unitOf('a', id);
    if (a) a.state = 'cancelled';
    c.running = false;
    c.answerPending = false;
    if (column !== 'blocked') c.blockKind = '';
    if (column === 'done') c.blockKind = '';
    c.column = column;
    c.updated_at = fmtTime(S.now);
    var s = S.sessions['card:' + id];
    if (s && column !== 'done') s.closed = true;
  }

  /* 拖到「阻塞」列：手动阻塞（block_kind=manual），卡不再持运行位 */
  function cardBlock(id) {
    var c = card(id);
    if (!c) return;
    var u = unitOf('c', id) || unitOf('ext', id);
    if (u) u.state = 'cancelled';
    var a = unitOf('a', id);
    if (a) a.state = 'cancelled';
    var s = S.sessions['card:' + id];
    if (s) { s.closed = true; s.waiting = false; }
    c.running = false;
    c.answerPending = false;
    c.column = 'blocked';
    c.blockKind = 'manual';
    c.blockText = '';
    c.updated_at = fmtTime(S.now);
  }

  function cardPass(id) {
    cardMove(id, 'done');
    var c = card(id);
    if (c) { c.unread = false; }
    toast(t('toast.passed'));
  }
  function cardReopen(id) { cardMove(id, 'review'); toast(t('toast.reopened')); }
  function cardRetry(id) {
    var c = card(id);
    if (!c) return;
    c.blockKind = ''; c.blockText = '';
    cardStart(id, {});
  }
  function cardReject(id, text) {
    var c = card(id);
    if (!c) return;
    var s = S.sessions['card:' + c.id];
    if (s) {
      if (text) s.msgs.push({ id: 'm' + rid(4), text: text, state: 'queue', tag: t('session.composer.queueTag') });
      unit('m', s.msgs[s.msgs.length - 1].id, text, 'card:' + c.id);
    }
    cardMove(id, 'todo');
    toast(t('toast.rejected'));
  }

  /* ---------- 回收站 ---------- */
  function cardTrash(id) {
    var c = card(id);
    if (!c) return;
    cardMove(id, 'todo');
    S.board.cards = S.board.cards.filter(function (x) { return x.id !== id; });
    c.trashed_at = fmtTime(S.now);
    S.board.trash.unshift(c);
    toast(t('toast.trashed'));
  }
  function cardRestore(id) {
    var i = -1;
    S.board.trash.forEach(function (c, k) { if (c.id === id) i = k; });
    if (i < 0) return;
    var c = S.board.trash.splice(i, 1)[0];
    c.column = 'todo';
    S.board.cards.push(c);
    toast(t('toast.restored'));
  }
  function cardPurge(id) {
    S.board.trash = S.board.trash.filter(function (c) { return c.id !== id; });
    toast(t('toast.purged'));
  }
  function cardEmptyTrash() { S.board.trash = []; toast(t('toast.cleared')); }

  /* ---------- 卡片详情 ---------- */
  function cardSave(id, title, desc) {
    var c = card(id);
    if (!c) return;
    c.title = title; c.description = desc; c.updated_at = fmtTime(S.now);
    toast(t('toast.saved'));
  }
  function cardSchedule(id, when) { var c = card(id); if (c) c.scheduled_at = when; }
  function cardDep(id, parent) { var c = card(id); if (c) c.parent = Number(parent) || 0; }
  function cardComment(id, text, deliver) {
    var c = card(id);
    if (!c || !text.trim()) return;
    c.comments.push({ at: fmtTime(S.now), text: text, delivered: !!deliver });
    if (deliver) {
      var s = S.sessions['card:' + c.id];
      if (s) { s.msgs.push({ id: 'm' + rid(4), text: text, state: 'queue', tag: t('session.composer.queueTag') }); unit('m', s.msgs[s.msgs.length - 1].id, text, 'card:' + c.id); }
    }
    toast(t('toast.saved'));
  }
  function cardCleanWorktree(id) {
    var c = card(id);
    if (!c) return;
    var u = unitOf('ext', id);
    if (u) u.state = 'cancelled';
    c.worktree = ''; c.running = false;
    toast(t('toast.saved'));
  }

  /* ---------- 作答：入队 → 待送达 → 送达 → 会话续跑 ---------- */
  function answer(cardIdOrTaskId, key, answers) {
    var s = S.sessions[key];
    if (!s || !s.interaction) return;
    s.interaction.answers = answers;
    s.interaction.submitted = true;
    S.ui.answeredOnce = true;
    var isCard = key.indexOf('card:') === 0;
    var ref = Number(key.split(':')[1]);
    /* 会话记录里补一条用户条目（产品里 user 条目即会话里的提问/回答） */
    var txt = Object.keys(answers).map(function (q) { return answers[q]; }).join('；');
    ent(s, 'user', { text: txt });
    if (isCard) {
      var c = card(ref);
      if (c) { c.answerPending = true; c.unread = true; c.column = 'doing'; }
    }
    s.pendingDeliver = true;                       // 待送达行（输入区上方那条）
    /* a: 行插在「运行前缀之后、等待区最前」（insert_after_prefix 语义） */
    var minSeq = 1e9;
    S.queue.forEach(function (u) { if (u.state === 'waiting' && u.seq < minSeq) minSeq = u.seq; });
    var au = unit('a', ref, 'answer:' + key, key);
    au.seq = (minSeq === 1e9 ? nextSeq() : minSeq - 1);
    if (activeUnits().length === 0) { /* 空闲：下一拍补位即送达 */ }
    var busy = slotHolders().length >= windowSize();
    toast(busy ? t('toast.answeredQueued') : t('toast.answered'));
  }

  function deliverNow(cardId) {
    var au = unitOf('a', cardId);
    if (!au) return;
    au.state = 'running';
    au.hold = HOLD_SEND;
    deliverAnswer(au);
  }

  function deliverAnswer(au) {
    var s = S.sessions[au.sessionKey];
    if (!s) return;
    var isCard = au.sessionKey.indexOf('card:') === 0;
    var ref = Number(au.sessionKey.split(':')[1]);
    if (isCard) {
      var c = card(ref);
      if (c) { c.answerPending = false; c.blockKind = ''; c.blockText = ''; c.column = 'doing'; }
    }
    var wasApproval = s.interaction && s.interaction.kind === 'approval';
    var decision = wasApproval ? s.interaction.answers[0] : '';
    s.waiting = false;
    s.resumed = true;
    s.interaction = null;
    s.pendingDeliver = false;
    au.state = 'done';
    if (wasApproval && decision === 'rejected') {
      /* 拒绝这次工具调用：本轮到此为止（产品里 agent 会改走别的路子，这里直接收口） */
      s.outro = t('session.approval.rejectedNote');
      s.step = s.script.length;
      ent(s, 'assistant', { text: s.outro });
      s.hold = 300;
    }
    /* 送达后会话恢复运行：产品里由 card_started 补回运行行 —— 这里补一个运行中的 c:/t: 单元 */
    var u = unitOf('c', ref) || unitOf('t', ref);
    if (!u) {
      var nu = unit(isCard ? 'c' : 't', ref, s.title, au.sessionKey);
      nu.state = 'running';
      nu.hold = 0;
      if (isCard) { var cc = card(ref); if (cc) { cc.running = true; cc.blockKind = ''; } }
      if (!isCard) { var tt = task(ref); if (tt) tt.status = 'running'; }
    }
    pushEvent('开始', '作答送达，会话继续');
    toast(t('toast.deliveredBye'));
  }

  /* ---------- 会话消息（发送 / 立即注入） ---------- */
  function sessionSend(key, text, inject) {
    var s = S.sessions[key];
    if (!s || !text.trim()) return;
    var m = { id: 'm' + rid(4), text: text.trim(), state: 'queue', tag: t('session.composer.queueTag') };
    s.msgs.push(m);
    if (inject && s.runningNow) {
      m.state = 'server';
      m.tag = t('session.composer.serverTag');
      ent(s, 'user', { text: m.text });
      s.hold = 200;
      s.afterHold = function () { ent(s, 'assistant', { text: '收到，已经插进当前这一轮 —— 继续按这个方向做。' }); };
      toast(t('toast.saved'));
      return;
    }
    var u = unit('m', m.id, m.text, key);
    if (activeUnits().length === 0) { /* 空闲：下一拍起跑 */ }
    toast(t('toast.queued'));
    return u;
  }

  /* ---------- 任务 ---------- */
  function createTask(d) {
    var sd = t('seed');
    var type = d.type || 'normal';
    var name = (d.name || '').trim();
    if (!name) {
      name = type === 'normal' ? ('探索：' + sd.projectName + ' 下单链路')
        : type === 'regression' ? ('回归：' + sd.projectName + ' 变更后重跑')
          : type === 'retest_bug' ? '复测：按提交范围' : ('压测：' + sd.projectName + ' 下单链路');
    }
    var tk = {
      id: S.seqTask++, name: name, task_type: type, status: 'queued', current_round: 0,
      stop_type: d.stopType || 'rounds', stop_value: d.stopValue || '1',
      start_stage: type === 'normal' ? 'gen_case' : (type === 'regression' ? 'execute' : ''),
      end_stage: d.endStage || (type === 'normal' || type === 'regression' ? 'report' : ''),
      date_from: d.dateFrom || '', date_to: d.dateTo || '',
      other: d.other || '', auto_fix: type === 'normal' || type === 'regression' ? 1 : 0,
      retest: d.retest || '不复测', model: t('tasks.byType'),
      created_at: fmtTime(S.now), started_at: '', ended_at: '',
      new_cases: 0, new_bugs: 0, rounds: 0, error: '', session_id: null, load: null,
    };
    S.tasks.unshift(tk);
    if (type === 'stress') { tk.load = { runs: [], charts: true }; }
    var key = 'task:' + tk.id;
    var s = mkSession(key, tk.name, type === 'stress' ? scriptStress(tk) : scriptTask(tk, type));
    tk.session_id = s.sid;
    unit('t', tk.id, tk.name, key);
    toast(type === 'stress' ? t('nt.ok') : t('nt.ok'));
    return tk;
  }

  /* 后段任务：探索/回归终点 > 生成报告时连带创建（单轮，报告分析→终点） */
  function spawnPipeline(parent, endStage) {
    var p = {
      id: S.seqTask++, name: parent.name + '·后段', task_type: 'pipeline', status: 'queued',
      current_round: 0, stop_type: 'rounds', stop_value: '1',
      start_stage: 'analyze', end_stage: endStage, parent_task_id: parent.id,
      other: '', auto_fix: 0, retest: '不复测', model: t('tasks.byType'),
      created_at: fmtTime(S.now), started_at: '', ended_at: '', new_cases: 0, new_bugs: 0,
      rounds: 0, error: '', session_id: null, load: null,
    };
    S.tasks.push(p);
    var key = 'task:' + p.id;
    var s = mkSession(key, p.name, scriptPipeline(p));
    p.session_id = s.sid;
    unit('t', p.id, p.name, key);
    return p;
  }

  /* 一轮结束：判停止条件 → 再来一轮 或 收口 */
  function settleTask(u) {
    var tk = task(u.ref);
    if (!tk) return;
    tk.rounds += 1;
    tk.current_round = tk.rounds;
    var again = false;
    if (tk.stop_type === 'rounds') again = tk.rounds < Number(tk.stop_value || 1);
    else if (tk.stop_type === 'bugs') again = tk.new_bugs < Number(tk.stop_value || 1);
    else if (tk.stop_type === 'duration' || tk.stop_type === 'deadline') again = tk.rounds < 1;
    if (again) {
      var nu = unit('t', tk.id, tk.name, u.sessionKey);
      var s = S.sessions[u.sessionKey];
      s.step = 0; s.closed = false;
      s.script = scriptRound(tk);
      S.sessions[u.sessionKey] = s;
      nu.sessionKey = u.sessionKey;
      u.state = 'done';
      pushEvent('阶段', '第 ' + (tk.rounds + 1) + ' 轮入队');
      return;
    }
    tk.status = 'done';
    tk.ended_at = fmtTime(S.now);
    S.live = null;
    u.state = 'done';
    toast(t('toast.finished'));
    /* 终点在「生成报告」之后 ⇒ 连带创建后段任务 */
    if ((tk.task_type === 'normal' || tk.task_type === 'regression') &&
        tk.end_stage && stageIdx(tk.end_stage) > stageIdx('report')) {
      var p = spawnPipeline(tk, tk.end_stage);
      toast(t('nt.pipelineOk'));
      S.logs.push('pipeline #' + p.id);
    }
    /* 压测：agent 轮结束后进入发压运行 */
    if (tk.task_type === 'stress') { startStressLoadRuns(tk); }
  }

  function stageIdx(k) {
    return ['gen_case', 'execute', 'report', 'analyze', 'fix', 'deploy', 'retest'].indexOf(k);
  }

  function taskStop(id) {
    var tk = task(id);
    if (!tk) return;
    var u = unitOf('t', id);
    if (u) u.state = 'cancelled';
    var s = S.sessions['task:' + id];
    if (s) s.closed = true;
    tk.status = 'stopped';
    tk.ended_at = fmtTime(S.now);
    if (tk.load) tk.load.running = false;
    S.live = null;
    toast(t('stress.stopOk'));
  }
  function taskRestart(id) {
    var tk = task(id);
    if (!tk) return;
    tk.rounds = 0; tk.current_round = 0; tk.status = 'queued'; tk.error = ''; tk.ended_at = '';
    tk.new_cases = 0; tk.new_bugs = 0;
    if (tk.load) tk.load.runs = [];
    var key = 'task:' + tk.id;
    var s = mkSession(key, tk.name, tk.task_type === 'stress' ? scriptStress(tk) : scriptTask(tk, tk.task_type));
    tk.session_id = s.sid;
    unit('t', tk.id, tk.name, key);
    toast(t('tasks.ops.restart'));
  }
  function taskContinue(id, d) {
    var tk = task(id);
    if (!tk) return;
    tk.stop_value = String(Number(tk.rounds) + Number(d && d.stopValue || 1));
    tk.status = 'queued';
    var key = 'task:' + tk.id;
    var s = S.sessions[key] || mkSession(key, tk.name, scriptRound(tk));
    s.step = 0; s.closed = false;
    s.script = scriptRound(tk);
    unit('t', tk.id, tk.name, key);
    toast(t('tasks.ops.cont'));
  }
  function taskDelete(id) {
    S.tasks = S.tasks.filter(function (x) { return x.id !== id; });
    S.queue = S.queue.filter(function (u) { return !(u.kind === 't' && u.ref === id); });
    toast(t('toast.saved'));
  }

  /* ---------- Bug 报告动作（复测/修复/拒绝都会创建任务） ---------- */
  function bugRetest(dir, scope) {
    var b = bug(dir);
    if (!b) return;
    var tk = createTask({ type: 'retest_bug', name: '复测 ' + b.title, stopValue: '1', endStage: scope === 'deploy_retest' ? 'retest' : (scope === 'deploy_only' ? 'deploy' : 'retest') });
    b.last_task = tk.id;
    toast(t('toast.queued'));
  }
  function bugFix(dir, d) {
    var b = bug(dir);
    if (!b) return;
    var tk = createTask({ type: 'fix', name: '修复 ' + b.title, stopValue: '1', endStage: (d && d.endStage) || 'fix', other: (d && d.note) || '' });
    b.last_task = tk.id;
    toast(t('toast.queued'));
  }
  function bugReject(dir, reason) {
    var b = bug(dir);
    if (!b) return;
    b.status = '已拒绝';
    b.note = reason;
    createTask({ type: 'reject', name: '修例 ' + b.title, stopValue: '1', other: reason });
    toast(t('toast.queued'));
  }

  /* ---------- 压测 ---------- */
  function startStressRun(u, s, st) {
    var tk = task(u.ref);
    if (!tk) return;
    tk.load = tk.load || { runs: [], charts: true };
    var run = { key: keyNow(), status: 'running', started: fmtTime(S.now), elapsed: 0, series: [], metrics: { total: 0, err: 0, p95: 0, rps: 0 } };
    tk.load.runs.unshift(run);
    tk.load.running = true;
    S.stress.run = run;
    S.stress.taskId = tk.id;
    pushEvent('阶段', '发压开始（' + run.key + '）');
    s.hold = 200;
    s.afterHold = function () { /* 发压期间由 tickStress 推进 */ };
    u.loadRun = run;
    u.state = 'running';
    u.stress = true;
  }

  function startStressLoadRuns(tk) {
    tk.load = tk.load || { runs: [], charts: true };
    if (tk.load.runs.length === 0) {
      tk.load.runs.unshift({ key: keyNow(), status: 'ok', started: fmtTime(S.now), elapsed: 300 });
    }
  }

  function keyNow() {
    var d = new Date(S.now);
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function tickStress(dt) {
    var run = S.stress.run;
    if (!run) return;
    run.elapsed += dt / 1000;
    var sec = Math.floor(run.elapsed);
    if (run.series.length <= sec) {
      var base = 380 + Math.sin(sec / 3) * 60 + Math.random() * 25;
      var ramp = Math.min(1, sec / 8);
      var rps = Math.round(base * (0.45 + 0.55 * ramp));
      var p50 = Math.round(28 + ramp * 12 + Math.random() * 6);
      var p95 = Math.round(p50 * 1.9 + Math.random() * 10);
      var p99 = Math.round(p95 * 1.35 + Math.random() * 12);
      var err = Math.round((Math.random() * 1.4 + (sec > 20 ? 0.6 : 0.2)) * 100) / 100;
      run.metrics.total += rps;
      run.metrics.err += Math.round(rps * err / 100);
      run.metrics.rps = rps;
      run.metrics.p95 = p95;
      run.metrics.errRate = err;
      run.series.push({ s: sec, rps: rps, p50: p50, p95: p95, p99: p99, err: err });
    }
    if (run.elapsed >= 60) {   // 演示里 60s 收口（真实宽限/上限见 loadgen）
      run.status = 'ok';
      run.elapsed = 60;
      S.stress.run = null;
      var tk = task(S.stress.taskId);
      if (tk) {
        tk.load.running = false;
        tk.status = 'done';
        tk.rounds = 1;
        tk.current_round = 1;
        tk.ended_at = fmtTime(S.now);
      }
      pushEvent('阶段', '发压结束，报告已生成（' + run.key + '）');
      var u = tk ? unitOf('t', tk.id) : null;
      if (u && u.stress) u.state = 'done';     // 压测单元：发压结束即收口
      S.live = null;
      toast(t('stress.report'));
    }
  }

  function stressRerun(id) {
    var tk = task(id);
    if (!tk) return;
    tk.load = tk.load || { runs: [], charts: true };
    var run = { key: keyNow(), status: 'running', started: fmtTime(S.now), elapsed: 0, series: [], metrics: { total: 0, err: 0, p95: 0, rps: 0 } };
    tk.load.runs.unshift(run);
    S.stress.run = run;
    S.stress.taskId = tk.id;
    toast(t('stress.rerunOk'));
  }
  function stressStop(id) {
    var tk = task(id);
    if (tk && S.stress.run) { S.stress.run.status = 'stopped'; }
    S.stress.run = null;
    if (tk) tk.load.running = false;
    toast(t('stress.stopOk'));
  }

  /* ======================================================================
     会话脚本（演示内容）
     ====================================================================== */
  function scriptTask(tk, type) {
    var sd = t('seed');
    if (type === 'regression') {
      return [
        { k: 'think', text: '先按重跑指令锁定范围：订单模块 + FS0007。' },
        { k: 'tool', name: 'run_case', args: { case: 'FS0007' }, result: 'FAIL · 期望 400 参数错误，实际 500' },
        { k: 'case', run: 'FS0007 币种缺失返回参数错误', status: 'fail', note: '返回 500' },
        { k: 'stats', set: { executed: 1, fail: 1 } },
        { k: 'say', text: 'FS0007 复现了：币种缺失时没有前置校验，直接落到库存服务报错。' },
        { k: 'phase', idx: 6, phase: 'cluster', text: '失败聚类' },
        { k: 'bug', slug: 'currency_missing_500', title: '币种缺失返回 500 而非参数错误', cases: ['FS0007'], note: '缺前置校验。' },
        { k: 'phase', idx: 2, phase: 'report', text: '生成报告' },
        { k: 'outro', text: '本轮结束：跑了 1 条用例，新增 1 份 bug 报告。' },
      ];
    }
    if (type === 'retest_bug') {
      return [
        { k: 'think', text: '复测范围来自提交区间，先看影响面再逐条跑。' },
        { k: 'tool', name: 'git_log', args: { range: 'origin/main..HEAD' }, result: '3 commits · order/OrderService.java, payment/Callback.java' },
        { k: 'case', run: 'FS0004 退款签名错误应拒绝', status: 'pass', note: '0.9s' },
        { k: 'stats', set: { executed: 1, pass: 1 } },
        { k: 'say', text: '签名校验已经生效，复测通过。' },
        { k: 'outro', text: '复测通过：关联用例全部通过，报告状态可置「已修复」。' },
      ];
    }
    if (type === 'fix' || type === 'reject') {
      return [
        { k: 'think', text: '先读 bug 报告与关联用例，确认改哪里。' },
        { k: 'tool', name: 'read_file', args: { path: 'src/main/java/payment/Callback.java' }, result: '（文件内容，182 行）' },
        { k: 'say', text: '问题定位在回调入口没有验签分支，直接进业务处理。' },
        { k: 'approval', action: 'edit', tool: 'edit_file', input: { path: 'src/main/java/payment/Callback.java' } },
        { k: 'tool', name: 'edit_file', args: { path: 'src/main/java/payment/Callback.java' }, result: '已写入：校验 HMAC 与时间戳窗口' },
        { k: 'case', run: 'FS0004 退款签名错误应拒绝', status: 'pass', note: '1.1s' },
        { k: 'stats', set: { executed: 1, pass: 1 } },
        { k: 'phase', idx: 8, phase: 'wrapup', text: '收尾' },
        { k: 'outro', text: '修复完成并通过复测。平台不自动提交 —— 需要提交时你在会话里说一声。' },
      ];
    }
    /* normal（探索）：生成用例 → 测试 → 生成报告，中间会问你一次 */
    return [
      { k: 'think', text: '先看被测目录结构与现有案例库，避免重复造用例。' },
      { k: 'tool', name: 'read_file', args: { path: 'AGENTS.md' }, result: '（项目说明，38 行）' },
      { k: 'tool', name: 'bash', args: { cmd: 'export_cases.py export free_style' }, result: '已导出 9 条用例索引' },
      { k: 'phase', idx: 1, phase: 'angle', text: '从变更与接口面找测试角度' },
      { k: 'say', text: '下单接口只有金额下限校验，边界值这组是空的。' },
      { k: 'stats', set: { proposal: 1 } },
      { k: 'phase', idx: 3, phase: 'generate', text: '生成用例' },
      { k: 'case', add: { seq: 10, name: '下单金额为负数应被拒绝', mod: '订单' } },
      { k: 'case', run: '下单金额为负数应被拒绝', status: 'fail', note: '返回 200 且生成订单' },
      { k: 'stats', set: { executed: 1, fail: 1 } },
      { k: 'say', text: '负数金额被接受了 —— 这条是真 bug，不是用例写错。' },
      { k: 'ask', header: '环境与范围', questions: [{
        header: '环境与范围',
        question: '这条用例我是在本地起的服务上跑的。要我顺手把 test4 环境的同一组边界值也跑一遍吗？',
        options: [
          { label: '跑 test4，一起比一遍', description: '会用 deploy.sh 部署到 test4 再跑同一组用例；多花几分钟，但能看出环境差异。' },
          { label: '只跑本地，先在案例库留档', description: '这一轮只保留本地结果，test4 留给下一次回归任务。' },
          { label: '先别跑，我要先看这条 bug', description: '停下来，等你确认这条 bug 的严重程度再决定。' },
        ],
        multi_select: false, other: true,
      }] },
      { k: 'phase', idx: 6, phase: 'cluster', text: '失败聚类' },
      { k: 'bug', slug: 'negative_amount', title: '下单金额为负数未被拒绝', cases: [], note: '缺下限校验，直接生成订单。' },
      { k: 'phase', idx: 2, phase: 'report', text: '生成报告' },
      { k: 'outro', text: '本轮结束：新增 1 条用例、1 份 bug 报告；用例库与报告都在工作目录下。' },
    ];
  }

  function scriptRound(tk) {
    return [
      { k: 'say', text: '续跑第 ' + (tk.rounds + 1) + ' 轮：先复跑上一轮的失败用例。' },
      { k: 'tool', name: 'run_case', args: { case: 'FS0007' }, result: 'FAIL · 仍返回 500' },
      { k: 'case', run: 'FS0007 币种缺失返回参数错误', status: 'fail', note: '仍失败' },
      { k: 'stats', set: { executed: 1, fail: 1 } },
      { k: 'outro', text: '本轮结束。' },
    ];
  }

  function scriptPipeline(tk) {
    return [
      { k: 'think', text: '后段任务：起点=报告分析，基于前段的失败聚类给出处置方案。' },
      { k: 'tool', name: 'list_bugs', args: { status: '待分析' }, result: '1 份待分析报告' },
      { k: 'say', text: '两处失败都指向缺失的前置校验，属于同一类问题。' },
      { k: 'outro', text: '后段收尾：已给出处置建议，等待人工决定是否修复。' },
    ];
  }

  function scriptStress(tk) {
    return [
      { k: 'think', text: '按压测说明确认目标与关注接口，先出声明式场景。' },
      { k: 'tool', name: 'write_file', args: { path: 'free_style/load/task_' + tk.id + '/scenario.json' }, result: '已写入：3 档并发（10/50/100），每档 60s' },
      { k: 'tool', name: 'write_file', args: { path: 'free_style/load/task_' + tk.id + '/charts.json' }, result: '已写入：吞吐 / 延迟分位 / 错误率' },
      { k: 'say', text: '方案包就绪：run.py 会用统一指标通道写 .web/task_' + tk.id + '_metrics_<运行键>.jsonl。' },
      { k: 'load' },
    ];
  }

  function scriptCardDev(c) {
    return [
      { k: 'think', text: '读卡片描述，先确认要动的文件与现有用例。' },
      { k: 'tool', name: 'read_file', args: { path: 'src/main/java/order/OrderService.java' }, result: '（文件内容，264 行）' },
      { k: 'say', text: '改动集中在回调查询路径上，我把重试策略抽出来，再补一条幂等检查。' },
      { k: 'approval', action: 'edit', tool: 'edit_file', input: { path: 'src/main/java/order/OrderService.java' } },
      { k: 'tool', name: 'edit_file', args: { path: 'src/main/java/order/OrderService.java' }, result: '已写入：RetryPolicy + 幂等键校验' },
      { k: 'case', run: 'FS0003 重复回调只记一次账', status: 'pass', note: '0.7s' },
      { k: 'stats', set: { executed: 1, pass: 1 } },
      { k: 'outro', text: '改完并自测通过。要我提交的话说一声 —— 平台不替你 commit。' },
    ];
  }

  function scriptCardAfterAnswer(c) {
    return [
      { k: 'say', text: '好，按你选的来。先把重试封装抽出来，幂等键一起收口。' },
      { k: 'tool', name: 'edit_file', args: { path: 'src/main/java/payment/CallbackService.java' }, result: '已写入：RetryPolicy 注入 + idempotency_key 校验' },
      { k: 'case', run: 'FS0003 重复回调只记一次账', status: 'pass', note: '0.6s' },
      { k: 'stats', set: { executed: 1, pass: 1 } },
      { k: 'outro', text: '重试与幂等一起改完，重复记账用例通过。' },
    ];
  }

  /* ======================================================================
     事件流（监控面板）
     ====================================================================== */
  function pushEvent(kind, text) {
    S.events.push({ at: fmtTime(S.now), kind: kind, text: text });
    if (S.events.length > 200) S.events.shift();
  }

  function toast(msg) {
    S.toasts.push({ id: 't' + rid(4), text: msg, at: Date.now() });
    if (S.toasts.length > 4) S.toasts.shift();
  }

  /* ======================================================================
     查询小工具
     ====================================================================== */
  function card(id) { for (var i = 0; i < S.board.cards.length; i++) if (S.board.cards[i].id === id) return S.board.cards[i]; return null; }
  function task(id) { for (var i = 0; i < S.tasks.length; i++) if (S.tasks[i].id === id) return S.tasks[i]; return null; }
  function bug(dir) { for (var i = 0; i < S.bugs.length; i++) if (S.bugs[i].dir === dir) return S.bugs[i]; return null; }
  function cardsOf(col) { return S.board.cards.filter(function (c) { return c.column === col; }); }
  function taskEntriesOf(col) {
    var map = { queued: 'doing', running: 'doing', failed: 'review', interrupted: 'review', stopped: 'review', done: 'done' };
    return S.tasks.filter(function (x) { return map[x.status] === col; });
  }
  function caseStats() {
    var st = { pass: 0, fail: 0, retest: 0, pending: 0 };
    S.cases.forEach(function (c) { st[c.status] = (st[c.status] || 0) + 1; });
    st.total = S.cases.length;
    return st;
  }

  /* ======================================================================
     引导
     ====================================================================== */
  var COACH_DONE = [
    function () { return S.screen === 'app'; },
    function () { return S.projects.length > 0; },
    function () { return !!S.tasks.filter(function (x) { return x.id >= 97; }).length; },
    function () {
      return S.queue.some(function (u) { return (u.kind === 't' || u.kind === 'c') && u.state === 'running'; });
    },
    function () { return !!S.ui.sessKey; },
    function () { return S.ui.answeredOnce; },
    function () { return S.ui.sawBug; },
    function () { return false; },
  ];

  function coachTick() {
    if (!S.ui.coachOn) return;
    var i = S.ui.coachIdx;
    if (i >= COACH_DONE.length - 1) return;
    if (COACH_DONE[i]()) S.ui.coachIdx = i + 1;
  }

  /* ======================================================================
     心跳
     ====================================================================== */
  function tick() {
    var dt = TICK * S.speed;
    S.now += dt;
    S.tickCount++;
    /* 1) 单元推进 */
    S.queue.forEach(function (u) {
      if (u.state === 'starting') {
        u.hold -= dt;
        if (u.hold <= 0) {
          u.state = 'running';
          if (u.kind === 'c') { var c = card(u.ref); if (c) { c.running = true; c.blockKind = ''; c.unread = true; } }
          var s = S.sessions[u.sessionKey];
          if (s) s.runningNow = true;
        }
        return;
      }
      if (u.state === 'running') {
        if (u.stress) { u.hold = 0; return; }        // 发压单元由 tickStress 推进
        var s2 = S.sessions[u.sessionKey];
        if (s2) s2.runningNow = true;
        pump(u, dt);
      }
    });
    /* 2) 送达单元：跑完即送达 */
    S.queue.forEach(function (u) {
      if (u.kind !== 'a' || u.state !== 'running') return;
      u.hold -= dt;
      if (u.hold <= 0) deliverAnswer(u);
    });
    /* 3) 消息单元：短会话 */
    S.queue.forEach(function (u) {
      if (u.kind !== 'm' || u.state !== 'running') return;
      u.hold -= dt;
      if (u.hold > 0) return;
      var s = S.sessions[u.sessionKey];
      if (s) {
        ent(s, 'user', { text: u.label });
        ent(s, 'assistant', { text: '收到，我按这条继续推进。' });
        s.msgs = s.msgs.filter(function (m) { return m.id !== u.ref; });
      }
      u.state = 'done';
    });
    /* 4) 清理终态单元 + 释放卡片 running */
    S.queue = S.queue.filter(function (u) {
      if (u.state === 'done' || u.state === 'cancelled') {
        if (S.now - (u.doneAt || S.now) > 400) return false;
      }
      return true;
    });
    /* 5) 补位 */
    schedule();
    /* 6) 压测发压推进 */
    tickStress(dt);
    /* 7) 引导推进 */
    coachTick();
    /* 8) 过期 toast 清理 */
    var real = Date.now();
    S.toasts = S.toasts.filter(function (x) { return real - x.at < 2600; });
    emit();
  }

  /* ======================================================================
     订阅与启动
     ====================================================================== */
  var subs = [];
  function emit() { for (var i = 0; i < subs.length; i++) subs[i](S); }

  var timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(tick, TICK);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  /* ======================================================================
     对外接口
     ====================================================================== */
  var API = {
    start: start, stop: stop, reset: function () { reset(true); emit(); },
    on: function (fn) { subs.push(fn); },
    /* 状态只读口（UI 不改状态，一律走 actions） */
    get state() { return S; },
    /* 派生查询 */
    q: {
      card: card, task: task, bug: bug, cardsOf: cardsOf, taskEntriesOf: taskEntriesOf,
      queueStateOf: queueStateOf, posOf: posOf, taskQueueState: taskQueueState,
      unitOf: unitOf, answerUnitOf: answerUnitOf, activeUnits: activeUnits,
      windowSize: windowSize, caseStats: caseStats, fmtTime: fmtTime, fmtHM: fmtHM,
      stageIdx: stageIdx,
      taskCol: function (st) {
        var map = { queued: 'doing', running: 'doing', failed: 'review', interrupted: 'review', stopped: 'review', done: 'done' };
        return map[st] || '';
      },
      waitingList: function () {
        return S.queue.filter(function (u) { return u.state === 'waiting'; }).sort(function (a, b) { return a.seq - b.seq; });
      },
    },
    /* 写口 */
    act: {
      login: login,
      logout: function () { reset(true); S.screen = 'login'; emit(); },
      createProject: function (d) { createProject(d); emit(); },
      setTab: function (k) { S.tab = k; emit(); },
      setScreen: function (k) { S.screen = k; emit(); },
      setMode: function (m) { S.board.mode = m; toast(m === 'parallel' ? t('toast.modeParallel') : t('toast.modeSerial')); emit(); },
      setSpeed: function (v) { S.speed = Number(v) || 1; emit(); },
      setSearch: function (v) { S.board.search = v; emit(); },
      setFilter: function (col, v) { S.board.filters[col] = v; emit(); },
      setSort: function (col, v) { S.board.sorts[col] = v; emit(); },
      cardCreate: cardCreate, cardStart: cardStart, cardStop: cardStop, cardMove: cardMove, cardBlock: cardBlock,
      cardPass: cardPass, cardReopen: cardReopen, cardRetry: cardRetry, cardReject: cardReject,
      cardTrash: cardTrash, cardRestore: cardRestore, cardPurge: cardPurge, cardEmptyTrash: cardEmptyTrash,
      cardSave: cardSave, cardSchedule: cardSchedule, cardDep: cardDep, cardComment: cardComment,
      cardCleanWorktree: cardCleanWorktree,
      answer: answer, deliverNow: deliverNow, sessionSend: sessionSend,
      createTask: createTask, taskStop: taskStop, taskRestart: taskRestart, taskContinue: taskContinue, taskDelete: taskDelete,
      bugRetest: bugRetest, bugFix: bugFix, bugReject: bugReject,
      stressRerun: stressRerun, stressStop: stressStop,
      toast: toast,
      ui: function (patch) { Object.keys(patch).forEach(function (k) { S.ui[k] = patch[k]; }); emit(); },
      coach: { next: function () { S.ui.coachIdx = Math.min(S.ui.coachIdx + 1, COACH_DONE.length - 1); emit(); },
               skip: function () { S.ui.coachOn = false; emit(); },
               toggle: function () { S.ui.coachOn = !S.ui.coachOn; if (S.ui.coachOn && S.ui.coachIdx >= COACH_DONE.length - 1) S.ui.coachIdx = 0; emit(); } },
      prefs: function (p) { Object.keys(p).forEach(function (k) { S.prefs[k] = p[k]; }); emit(); },
    },
    coachSteps: function () { return t('coach.steps'); },
  };

  window.TS_ENGINE = API;
  reset(false);
})();
