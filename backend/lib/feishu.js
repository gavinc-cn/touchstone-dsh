/**
 * 飞书出站推送族（M7-R2）——`feishu.py` 的**出站半**：`:31-1038`（常量 / 事件闸门接线 /
 * 渲染 / 入队 / 卡片构建族 / plan 方案文档族 / 业务侧语义函数）+ `:2599-2678`（投递线程）。
 *
 * Python 是 oracle：本文件的每一处文案、键序、截断长度、退避数值都对着 `feishu.py` 的对应
 * 行写，**不按直觉改写**。对拍判据见 `tools/parity/cases-mod/feishu_outbound.json`。
 *
 * ## 与相邻车道的接缝（**写清楚，别假装它们不存在**）
 *
 * 1. **配置读助手**（`user_config`/`app_config`/`notify_events`/`hook_of`）在 `feishu_cfg.js`
 *    （M7-R1）**已实现**——本文件**import 后原样再导出**，绝不重写第二份（两份实现在对拍里
 *    会漂移成两个事实）。`notifyEvents`/`hookOf` 因此是本模块的公开口，但归属 R1。
 *
 * 2. **REST 车道**（`feishu_rest.js`，M7-R4）：`_docx_create` 与 DM 卡片发送要调飞书 REST。
 *    本文件**懒 import**（`loadRestLane()`）而不是静态 import，理由是并行车道可能尚未落地，
 *    静态 import 会让整个模块 import 失败（连纯函数都用不了）。**失败不吞**：导入失败/接口
 *    不符一律抛 `RestLaneUnavailable`（`name='FeishuRestError'`，与 R4 的类同形），由
 *    `attachPlan`/`dmInteractionCard` 按 oracle 的口径**留痕到 stderr**（Python 侧这两处
 *    本来就是 best-effort + print，见 `feishu.py:934-936`/`:964-966`）。
 *
 * 3. **入站/对话/接线缝**（M7.5 与 R3）：`startNotifier` 里 Python 还调了 `feishu_conv.start()`
 *    （注册 chat 消息终态钩子）——那是**对话车道**的接线，本文件**不调**（`feishu_conv.js`
 *    尚不存在，静默 try 会变成「装好了其实没接」）。`setFailureNotifier`（runner.js）与
 *    `optionalHook('feishuCardReview')`（board.js）的注入同样不在本文件范围内：这里只把
 *    `cardBlocked`/`cardReview`/`taskFailed` 按 oracle 形参表备好，供后来注入者调用。
 *
 * 4. **`session_id` → 方案文本**（`planSessionTexts`）：Python 函数内懒 import `sessparse`
 *    是为了避开模块级循环依赖；Node 侧 `sessparse.js` 不 import 本文件（只有 node 内置 +
 *    `zstd-frames.js`），**没有环** ⇒ 用静态 import。Node 的 `await import()` 会把 async
 *    传染给整条同步调用链（Python 侧是同步函数），故这里刻意静态化。
 *
 * ## 跨运行时的已知分歧（逐条登记，不藏）
 *   - **错误文案**：Python `urlopen` 的 `URLError/OSError` 文案（`<urlopen error [Errno 111] …>`）
 *     与 Node 的 `ECONNREFUSED` 家族天然不同；坏 payload 的 `Expecting value: line 1 column 1`
 *     与 `JSON.parse` 的 `Unexpected token` 同理。**只有 `code=<n> <msg>` 这一支是两侧同形的**
 *     （飞书自己的业务码+文案），用例也只钉这一支。
 *   - **3xx 重定向**：`urllib` 的 `HTTPRedirectHandler` 会自动跟随（301/302/303 把 POST 降级成
 *     GET、307 保 body，最多 10 跳），本实现**不跟随**：非 2xx 直接按失败档返回
 *     `HTTP Error <status>: <reason>`（＝Python `HTTPError.__str__` 的形态）。真实飞书 webhook
 *     不重定向，故这条只在「被中间件改写」的部署里显形——登记未验，**没有对拍覆盖**。
 *   - **浮点**：`str(1.0)`/`repr` 的 int-vs-float 信息在 JS 里不存在（同 `pyjson.js` 文件头），
 *     只影响错误文案与卡片上的数字形态。
 *
 * 零 npm 依赖：只用 `node:crypto` / `node:http` / `node:https` 与同仓库的 db/pyjson/lib/sessparse。
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import {
  feishuOutboxDue, feishuOutboxMark, feishuOutboxPush, getFeishuBindingByUser, getProject,
} from './db.js';
import {
  FEISHU_DEFAULT_EVENTS, FEISHU_EVENTS, appConfig, hookOf, notifyEvents,
  projectLang, userLang,
} from './feishu_cfg.js';
import * as i18n from './i18n.js';
import { PY_WS, pyStrip } from './lib.js';
import { pyJsonDumps } from './pyjson.js';
import * as sessparse from './sessparse.js';

// 配置读助手（R1）原样再导出：本模块的调用方（routes/**）按 feishu.py 的名字取它们。
export { FEISHU_DEFAULT_EVENTS, FEISHU_EVENTS, appConfig, hookOf, notifyEvents };

// --------------------------------------------------------------------------
// 常量（逐条对齐 feishu.py:31-69 / :605-614）
// --------------------------------------------------------------------------

/** 重试退避（秒）：3 次后标 failed 留痕。对齐 `feishu.RETRY_DELAYS`(feishu.py:36) */
export const RETRY_DELAYS = Object.freeze([60, 300, 1800]);

/** webhook POST 超时（秒），对齐 `feishu.SEND_TIMEOUT`(feishu.py:37) */
export const SEND_TIMEOUT = 5;

/** 发送线程轮询间隔（秒），对齐 `feishu._TICK`(feishu.py:38) */
export const TICK = 1.0;

/** kind → [通知标题, 是否附站点链接]，对齐 `feishu._EVENT_META`(feishu.py:41) */
export const EVENT_META = Object.freeze({
  blocked_interaction: Object.freeze(['🤔 卡片等待回复', true]),
  task_failed: Object.freeze(['❌ 任务失败', true]),
  card_review: Object.freeze(['📋 卡片待审核', false]),
});

/** 多子题渲染截断（飞书卡片元素/文本都有长度上限，超长会整条被拒收），feishu.py:49-51 */
export const Q_TEXT_MAX = 500;   // 单题题面
export const Q_OPT_MAX = 100;    // 单选项 label
export const Q_DESC_MAX = 160;   // 选项描述次行 / 题目补充说明

/** 多选类「卡片点选」暂存态上限，feishu.py:56-58（暂存本体在 M7.5 入站车道） */
export const MQ_TTL = 1800;
export const MQ_MAX_BUCKETS = 64;
export const MQ_FORM_MAX_BYTES = 950;   // 飞书 form 元素硬限 1000

/**
 * 不可远程作答（`board._iw_interaction` 的 `answerable=false`）时的**统一引导文案**，
 * 逐字对齐 `feishu._NO_REMOTE_ANSWER_HINT`(feishu.py:68)（换行处是 Python 的隐式拼接）。
 */
export const NO_REMOTE_ANSWER_HINT = '该等待不支持远程作答（提问由 dsh 直跑会话发起），'
  + '请在 dsh 会话窗口作答';

/** plan 方案增强族常量，feishu.py:611-614 */
export const PLAN_ENV = 'TS_FEISHU_PLAN';
export const PLAN_INLINE_MAX = 1500;
export const PLAN_DOC_MAX = 20000;
export const PLAN_DOC_TTL = 1800;
export const MD_BLOCK_MAX = 1800;
export const ASK_TOOL = 'ask_user_question';
export const DOC_TIMEOUT = 8;

/** 列名常量的可读别名（`feishu_hooks` / `feishu_outbox` 的列名在 db.js 里是 snake_case） */
const RETRY_MAX = RETRY_DELAYS.length;

// --------------------------------------------------------------------------
// Python 语义小工具（只在本地用；`maskWebhook`/`maskOpenId`/`pyJsonDumps` 一律复用既有实现）
// --------------------------------------------------------------------------

/**
 * Python 真值口径（`""`/`0`/`None`/`False`/空容器为假）。
 * `feishu_cfg.js` 里有一份同名私有函数，但它没导出、且本文件不许改它 ⇒ 这里自带一份，
 * 语义与那份逐字相同。
 */
function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `dict.get(key, default)`：**键存在但值为 None 时返回 None**（不是 default） */
function dictGet(dict, key, dflt = undefined) {
  return Object.hasOwn(dict, key) ? dict[key] : dflt;
}

/** Python `str(x)`（浮点的 int/float 偏差见文件头「跨运行时的已知分歧」） */
function pyStr(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') return pyRepr(value);
  return String(value);
}

/** Python `repr(str)`（单引号口径：含 `'` 且不含 `"` 时改用双引号，与 CPython 同规则） */
function pyQuote(text) {
  const s = String(text);
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(new RegExp(quote, 'g'), `\\${quote}`);
  return quote + body + quote;
}

/** Python `repr(x)`（**浅层**向：容器/集合按同规则递归；类实例给 `{...}`——只服务错误文案） */
function pyRepr(value) {
  if (typeof value === 'string') return pyQuote(value);
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => pyRepr(v)).join(', ')}]`;
  if (value instanceof Set) return `{${[...value].map((v) => pyRepr(v)).join(', ')}}`;
  if (value instanceof Error) return errRepr(value);
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${pyQuote(k)}: ${pyRepr(v)}`).join(', ')}}`;
  }
  return String(value);
}

/** 异常的 repr（`f"{e!r}"` 的可用子集：`FeishuRestError('…')` 形态） */
function errRepr(error) {
  if (error instanceof Error) return `${error.name || 'Error'}(${pyQuote(error.message)})`;
  return pyRepr(error);
}

/** 异常文案（`str(e)` 的可用子集；Python `str(e)` 就是 message） */
function errText(error) {
  if (error instanceof Error) return error.message;
  return pyStr(error);
}

/** Python `str(x or "")`：假值先归一成空串，再 `str()` */
function pyStrOrEmpty(value) {
  return pyStr(pyTruthy(value) ? value : '');
}

/** 按**码点**计数（Python `len(str)`）。lib.js 的 `sliceCodePoints` 没导出 ⇒ 本地一份 */
function cpLen(text) {
  return Array.from(text).length;
}

/** Python `text[:n]`（码点口径） */
function cpSlice(text, n) {
  return Array.from(text).slice(0, n).join('');
}

/** Python `text.rstrip()` */
const PY_RSTRIP_RE = new RegExp(`${PY_WS}+$`);
/** Python `text.lstrip()` */
const PY_LSTRIP_RE = new RegExp(`^${PY_WS}+`);
function pyRstrip(text) {
  return String(text).replace(PY_RSTRIP_RE, '');
}
function pyLstrip(text) {
  return String(text).replace(PY_LSTRIP_RE, '');
}

/** Python `str.splitlines()` 的行边界（`\r\n` 算一行；顺序敏感，`\r\n` 必须在前） */
const SPLIT_LINES_RE = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/;
function pyFirstLine(text) {
  const parts = String(text).split(SPLIT_LINES_RE);
  return parts.length ? parts[0] : '';
}

/**
 * `(value or "")[:limit]`（Python 切片语义：`str` 按码点、`list` 先切片再 repr、
 * 数字/布尔/dict 抛 TypeError）。
 */
function clipField(value, limit) {
  const v = pyTruthy(value) ? value : '';
  if (typeof v === 'string') return cpSlice(v, limit);
  if (Array.isArray(v)) return pyRepr(v.slice(0, limit));
  throw new TypeError(`不支持切片的值类型: ${typeof v}（Python 侧同一处会抛 TypeError）`);
}

/** 往 stderr 留痕（Python 侧对应几处 `print(..., file=sys.stderr, flush=True)`） */
function stderrLine(text) {
  process.stderr.write(`${text}\n`);
}

/** 普通对象判定（排除 null / 数组；`isinstance(x, dict)` 的可用子集） */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// --------------------------------------------------------------------------
// 渲染（feishu.py:146-219）
// --------------------------------------------------------------------------

/**
 * 飞书自定义机器人签名，对齐 `feishu.sign`(feishu.py:146)：
 * `base64(hmac_sha256(key=f"{ts}\n{secret}", msg=b""))`。
 *
 * **注意 key/msg 的位置**：Python 原式 `hmac.new(string_to_sign.encode("utf-8"),
 * digestmod=sha256)` **只给了 key**、没给 msg ⇒ 被签名的是空串，`f"{ts}\n{secret}"` 是
 * **密钥**。照直觉写成「key=secret, msg=ts」会与飞书对不上（用例三条固定向量钉住这点）。
 * @param {string} secret
 * @param {string|number} ts
 * @returns {string} base64 文本
 */
export function sign(secret, ts) {
  const key = Buffer.from(`${ts}\n${secret}`, 'utf8');
  return crypto.createHmac('sha256', key).digest('base64');
}

/**
 * text 消息体，对齐 `feishu._payload`(feishu.py:154)：`json.dumps({"msg_type": "text",
 * "content": {"text": text}}, ensure_ascii=False)` —— 键序 `msg_type`→`content`、分隔符
 * `", "`/`": "`、中文与换行**不转义**，故必须走 `pyJsonDumps`（`JSON.stringify` 会全错）。
 * timestamp/sign 在发送时刻补（队列重试后旧签会过期）。
 * @param {string} text
 * @returns {string}
 */
export function payload(text) {
  return pyJsonDumps({ msg_type: 'text', content: { text } });
}

/**
 * 单选项归一 → `{id, label, description}`，对齐 `feishu._option_view`(feishu.py:246)：
 * 兼容 dsh `AskUserQuestionOption` 的 dict（label/description）与旧形态的纯字符串
 * （测试替身/旧插件仍可能给 str，直接 `.get` 会炸穿推送）。
 * @param {unknown} raw
 * @returns {{id: string, label: string, description: string}}
 */
export function optionView(raw) {
  if (isPlainObject(raw)) {
    const label = raw.label || raw.text || raw.value || '';
    return {
      id: pyStr(raw.id || label),
      label: pyStr(label),
      description: pyStr(raw.description || ''),
    };
  }
  return { id: pyStr(raw || ''), label: pyStr(raw || ''), description: '' };
}

/**
 * 截断长文本（空值归一为空串；超限加省略号），对齐 `feishu._clip_text`(feishu.py:240)。
 * `str(text or "").strip()` 的 strip 走 lib.js 的 `pyStrip`（Python 空白集合，不是 JS `trim`）。
 */
export function clipText(text, limit) {
  const s = pyStrip(pyStrOrEmpty(text));
  return cpLen(s) <= limit ? s : `${cpSlice(s, limit)}…`;
}

/**
 * `interaction.questions`（1-4 题）→ 逐题渲染视图，对齐 `feishu._question_views`(feishu.py:257)。
 * 视图：`{no, header, question, body, options:[{no,label,description}], multi_select,
 * allow_other, other_label}`。
 * @param {unknown[]} qs
 * @returns {object[]}
 */
export function questionViews(qs, lang = 'zh') {
  const views = [];
  let index = 0;
  for (const raw of qs) {
    index += 1;
    const q = isPlainObject(raw) ? raw : {};
    const options = [];
    let j = 0;
    for (const o of (q.options || [])) {
      j += 1;
      const ov = optionView(o);
      options.push({
        no: j,
        label: clipText(ov.label, Q_OPT_MAX),
        description: clipText(ov.description, Q_DESC_MAX),
      });
    }
    views.push({
      no: index,
      header: clipText(q.header, 60),
      question: clipText(q.question, Q_TEXT_MAX),
      body: clipText(q.body || q.detail, Q_DESC_MAX),
      options,
      multi_select: pyTruthy(q.multi_select),
      allow_other: pyTruthy(q.allow_other),
      other_label: clipText(q.other_label || i18n.t('api', '其他', lang), 40),
    });
  }
  return views;
}

/**
 * 能力标注（多选/可自定义）→ 一行文本；无标注返回空串。
 * 括号与分隔符也是文案的一部分（中文全角、英文半角），故一并走词典。
 */
function capsLine(caps, lang = 'zh') {
  if (!caps.length) return '';
  const sep = i18n.t('api', '；', lang);
  return i18n.t('api', '（{caps}）', lang, { caps: caps.join(sep) });
}

/**
 * 单题提问 ctx → 单题视图，对齐 `feishu._single_question_view`(feishu.py:286)：
 * `ctx.questions` 优先，旧调用面/测试替身只给平面字段时按平面字段兜底。
 */
export function singleQuestionView(ctx, lang = 'zh') {
  const qs = (ctx.questions || []).filter((q) => pyTruthy(q));
  if (qs.length) return questionViews(qs, lang)[0];
  const opts = [];
  let i = 0;
  for (const o of (ctx.options || [])) {
    i += 1;
    const ov = optionView(o);
    opts.push({ no: i, label: clipText(ov.label, Q_OPT_MAX), description: '' });
  }
  return {
    no: 1,
    header: '',
    question: clipText(ctx.question, Q_TEXT_MAX),
    body: '',
    options: opts,
    multi_select: pyTruthy(ctx.multi_select),
    allow_other: pyTruthy(ctx.allow_other),
    other_label: clipText(ctx.other_label || i18n.t('api', '其他', lang), 40),
  };
}

/**
 * 多子题 → 群 webhook 文本行，对齐 `feishu._question_text_lines`(feishu.py:340)
 * （msg_type=text 不渲染 markdown，按纯文本排版）。
 * @param {object[]} views
 * @returns {string[]}
 */
export function questionTextLines(views, lang = 'zh') {
  const lines = [];
  for (const v of views) {
    const title = v.header || i18n.t('api', '第 {no} 题', lang, { no: v.no });
    const head = i18n.t('api', '【{no}/{total} {title}】', lang,
      { no: v.no, total: views.length, title });
    lines.push(v.question ? `${head}${v.question}` : head);
    if (v.body) lines.push(`  ${v.body}`);
    for (const o of v.options) {
      lines.push(`  ${o.no}) ${o.label}`);
      if (o.description) lines.push(`     ${o.description}`);
    }
    const caps = [];
    if (v.multi_select) caps.push(i18n.t('api', '多选', lang));
    if (v.allow_other) {
      caps.push(i18n.t('api', '可自定义：{label}', lang, { label: v.other_label }));
    }
    if (caps.length) {
      lines.push('  ' + i18n.t('api', '（{caps}）', lang,
        { caps: caps.join(i18n.t('api', '；', lang)) }));
    }
  }
  return lines;
}

/**
 * 多子题作答语法回执，对齐 `feishu._multi_answer_help`(feishu.py:2299)（在 `:2399`
 * 一族的作答解析里共用；出站侧 `render` 也调它）。
 * @param {string|number} cid
 * @param {unknown[]} qs
 * @returns {string}
 */
export function multiAnswerHelp(cid, qs, lang = 'zh') {
  const marks = Array.from({ length: qs.length },
    (_, k) => i18n.t('api', '{no}:<选项序号>', lang, { no: k + 1 })).join(' ');
  return i18n.t('api',
    '该提问含 {n} 道子题：可在卡片上逐题点选（点满自动送达），'
    + '或回复「作答 {cid} {marks}」一次答全；多选写「1:2,3」，自定义写「1:文字」',
    lang, { n: qs.length, cid, marks });
}

/**
 * 不可远程作答的统一引导（`NO_REMOTE_ANSWER_HINT` 的语言化视图）：
 * 常量本身保持中文（对拍/测试按字面引用），出站时按 `lang` 查词典。
 * @param {'zh'|'en'|string} [lang]
 * @returns {string}
 */
export function noRemoteAnswerHint(lang = 'zh') {
  return i18n.t('api', NO_REMOTE_ANSWER_HINT, lang);
}

/**
 * 事件 → 通知文案，对齐 `feishu._render`(feishu.py:160)：首行标题 `[项目名]`，按 kind 拼
 * 卡片/任务/提问/选项/错误/pipeline 跳过 行，末行可选站点链接；凭据永不入文案。
 *
 * **逐字节判据**（用例里有六种分支的固定向量）：标题行取项目名（项目不存在 ⇒ `#<id>`）、
 * 卡片行/任务行的截断长度（60/50 码点）、审批档的三行 + 同意/拒绝指令、
 * 不可作答档的统一引导、多子题档的逐题完整展示 + 一条指令答全、`base_url` 为空或该 kind
 * 的 `_EVENT_META` 第二项为 False 时**不附**「详情：」行。
 * @param {string} kind
 * @param {object} ctx
 * @param {number} projectId
 * @param {string} [baseUrl]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export function render(kind, ctx, projectId, baseUrl = '', options = {}) {
  const lang = options.lang || 'zh';
  const meta = EVENT_META[kind];
  if (meta === undefined) throw new TypeError(`未知事件类别: ${kind}（Python 侧是 KeyError）`);
  const [head, withLink] = meta;
  const proj = getProject(projectId, options);
  const title = i18n.t('api', head, lang);
  const lines = [`${title} [${proj ? proj.name : `#${projectId}`}]`];
  if ('card_id' in ctx) {
    lines.push(i18n.t('api', '卡片 #{cid} {title}', lang,
      { cid: pyStr(ctx.card_id), title: clipField(ctx.title, 60) }));
  }
  if ('task_id' in ctx) {
    lines.push(i18n.t('api', '任务 #{tid} {name}（{type}）', lang, {
      tid: pyStr(ctx.task_id), name: clipField(ctx.name, 50),
      type: pyStrOrEmpty(ctx.type),
    }));
  }
  const cid = ctx.card_id;
  if (ctx.kind === 'approval') {
    // 审批等待：动作/工具/内容摘要 + 同意/拒绝指令（比通用「agent 提问」行更准确）
    lines.push(i18n.t('api', '审批请求：{action}', lang, {
      action: pyStr(ctx.action || ctx.tool || i18n.t('api', '工具调用', lang)),
    }));
    if (pyTruthy(ctx.tool)) {
      lines.push(i18n.t('api', '工具：{tool}', lang, { tool: ctx.tool }));
    }
    if (pyTruthy(ctx.input)) {
      lines.push(i18n.t('api', '内容：{input}', lang,
        { input: cpSlice(pyStr(ctx.input), 200) }));
    }
    lines.push(i18n.t('api', '飞书回复「同意 {cid}」批准，「拒绝 {cid}」拒绝；'
      + '「同意 {cid} 会话」本会话内同类调用自动放行', lang, { cid }));
  } else {
    const qs = (ctx.questions || []).filter((q) => pyTruthy(q));
    if (qs.length > 1) {
      // 多子题：逐题完整展示（旧实现只渲染首题 q0，其余子题在飞书上不可见）
      lines.push(i18n.t('api', 'agent 提问（共 {n} 题）：', lang, { n: qs.length }));
      lines.push(...questionTextLines(questionViews(qs, lang), lang));
    } else if (pyTruthy(ctx.question)) {
      lines.push(i18n.t('api', 'agent 提问：{question}', lang,
        { question: ctx.question }));
      let i = 0;
      for (const o of (ctx.options || [])) {
        i += 1;
        lines.push(`  ${i}) ${pyStr(o)}`);
      }
    }
    if (kind === 'blocked_interaction') {
      const nQ = qs.length || (pyTruthy(ctx.questions_count) ? ctx.questions_count : 0);
      if (!pyTruthy(ctx.answerable)) {
        // 不可远程作答的等待（answerable=false）：引导回 dsh 会话窗口（见常量注释）
        lines.push(i18n.t('api', NO_REMOTE_ANSWER_HINT, lang));
      } else if (nQ > 1) {
        // 多子题：一条指令按题号逐题答全（表单卡超 form 体积硬限时同样走这条）
        const filled = qs.length ? qs : Array.from({ length: Number(nQ) }, () => null);
        lines.push(multiAnswerHelp(cid, filled, lang));
      } else {
        const tips = [i18n.t('api', '飞书回复「作答 {cid} <选项序号>」按选项作答',
          lang, { cid })];
        if (pyTruthy(ctx.multi_select)) {
          tips.push(i18n.t('api', '多选逗号分隔（作答 {cid} 1,3）', lang, { cid }));
        }
        if (pyTruthy(ctx.allow_other)) {
          tips.push(i18n.t('api', '「作答 {cid} <文字>」自定义回答', lang, { cid }));
        }
        lines.push(tips.join(i18n.t('api', '；', lang)));
      }
    }
  }
  if (pyTruthy(ctx.error)) {
    lines.push(i18n.t('api', '错误：{error}', lang,
      { error: cpSlice(pyStr(ctx.error), 200) }));
  }
  if (pyTruthy(ctx.skipped_n)) {
    lines.push(i18n.t('api', 'pipeline 后段 {n} 条已连带跳过', lang,
      { n: pyStr(ctx.skipped_n) }));
  }
  if (withLink) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (base) lines.push(i18n.t('api', '详情：{url}', lang, { url: base }));
  }
  return lines.join('\n');
}

/**
 * 旁路事件入队，对齐 `feishu.push_event`(feishu.py:222)：
 * hook 选择 → events 过滤 → 渲染 → 幂等入 outbox（记项目所有者 user_id）。
 *
 * **永不抛出**（任何异常吞掉，绝不影响业务主流程）——这是本函数唯一的不变量；
 * dedup 键默认 `kind:project_id:card_id|task_id`，`ctx.dedup_key` 显式给了就优先。
 * @param {number} projectId
 * @param {string} kind
 * @param {object} ctx
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {void}
 */
export function pushEvent(projectId, kind, ctx, options = {}) {
  try {
    const h = hookOf(projectId, options);
    if (h === null || !h.events.has(kind)) return;
    // 语言按项目所有者解析一次（R22；TS_I18N=0 ⇒ zh 且不读偏好，与 Python 同口径）
    const lang = projectLang(projectId, options);
    const text = render(kind, ctx, projectId, h.base_url || '',
      { ...options, lang });
    const dedup = ctx.dedup_key
      || `${kind}:${projectId}:${ctx.card_id || ctx.task_id || ''}`;
    feishuOutboxPush(h.target, h.secret, payload(text), dedup, h.user_id || 0, options);
  } catch {
    // 照抄 Python 的 `except Exception: pass`：推送是旁路，失败的可见性由 outbox 行承担
  }
}

// --------------------------------------------------------------------------
// 交互卡片构建族（feishu.py:310-585；DM 单聊推送用，REST 经 `restSendCard`）
// --------------------------------------------------------------------------

/**
 * 单题**多选**且可远程作答 → `[mini 表单元素 or null, 指引文案]`，对齐
 * `feishu._single_multi_select_pick`(feishu.py:310)。
 *
 * 多选组件 `multi_select_static` 按飞书官方规定**只能内嵌表单容器**，故给「单题 mini 表单 +
 * 提交按钮」；表单 JSON 超 `MQ_FORM_MAX_BYTES`（飞书 form 元素 1000 字节硬限，超限必被
 * `230099/11310` 拒收且整卡静默丢失）或该题没有选项时**不发控件**，只回文本作答指引。
 * @param {string|number} cid
 * @param {object} ctx
 * @returns {[object|null, string]}
 */
export function singleMultiSelectPick(cid, ctx, lang = 'zh', otherTail = true) {
  const q = singleQuestionView(ctx, lang);
  const tail = (otherTail && q.allow_other)
    ? i18n.t('api', '；自定义文字回复「作答 {cid} <文字>」', lang, { cid }) : '';
  if (!q.options.length) {
    return [null, q.allow_other
      ? i18n.t('api', '请回复「作答 {cid} <文字>」作答', lang, { cid })
      : i18n.t('api', '该提问没有可选选项，请到站点会话窗口处理', lang)];
  }
  const form = multiSelectForm(cid, q, i18n.t('api', '提交作答', lang), lang);
  if (formCharLen(form) > MQ_FORM_MAX_BYTES) {
    return [null, i18n.t('api',
      '多选题：请回复「作答 {cid} 1,3」（逗号分隔序号）{tail}', lang, { cid, tail })];
  }
  return [form, i18n.t('api',
    '多选题：勾选后点「提交作答」送达；也可回复「作答 {cid} 1,3」（逗号分隔序号）{tail}',
    lang, { cid, tail })];
}

/**
 * 多子题 → DM 卡片逐题 markdown 元素（**只读**展示），对齐
 * `feishu._question_card_blocks`(feishu.py:333)。
 */
export function questionCardBlocks(views, lang = 'zh') {
  return views.map((v) => questionMdElement(v, views.length, lang));
}

/**
 * 单题 → markdown 元素，对齐 `feishu._question_md_element`(feishu.py:363)
 * （「只读展示」与「逐题点选卡」共用同一份排版，避免两处漂移）。
 */
export function questionMdElement(v, n, lang = 'zh') {
  const title = v.header || v.question
    || i18n.t('api', '第 {no} 题', lang, { no: v.no });
  const md = [`**${v.no}/${n} ${title}**`];
  if (v.header && v.question) md.push(v.question);
  if (v.body) md.push(v.body);
  for (const o of v.options) {
    md.push(`${o.no}) ${o.label}`);
    if (o.description) md.push(`　　${o.description}`);   // 全角缩进：描述次行
  }
  const caps = [];
  if (v.multi_select) caps.push(i18n.t('api', '多选', lang));
  if (v.allow_other) caps.push(i18n.t('api', '可自定义：{label}', lang, { label: v.other_label }));
  const line = capsLine(caps, lang);
  if (line) md.push(line);
  return { tag: 'markdown', content: md.join('\n') };
}

/**
 * 表单 JSON 的**码点数**，对齐 Python 的 `len(json.dumps(form, ensure_ascii=False))`。
 *
 * 常量名里的 "BYTES" 是历史命名（飞书 form 元素硬限 1000 字节），但 Python 量的确实是
 * `len(str)` ＝ **码点个数**，不是 UTF-8 字节数。照抄同一口径：改用 `Buffer.byteLength`
 * 会把中文算成 3 字节，等于把「装得下」误判成「装不下」而**少发控件**。
 * @param {object} form
 * @returns {number}
 */
function formCharLen(form) {
  return cpLen(pyJsonDumps(form));
}

/**
 * 多选题 → **单题 mini 表单**，对齐 `feishu._multi_select_form`(feishu.py:432)。
 * 提交按钮与组件同带 `t=mq/c/n`：飞书表单提交帧走**按钮**的 behaviors.value，
 * 组件值在 `action.form_value[<组件 name>]`（数组）。
 */
export function multiSelectForm(cid, v, btnText = '', lang = 'zh') {
  return {
    tag: 'form',
    name: `mqf${cid}_${v.no}`,
    elements: [
      {
        tag: 'multi_select_static',
        name: `mq${cid}_${v.no}`,
        placeholder: { tag: 'plain_text', content: i18n.t('api', '请选择（可多选）', lang) },
        options: v.options.map((o) => ({
          text: { tag: 'plain_text', content: o.label },
          value: String(o.no),
        })),
        behaviors: [{ type: 'callback', value: { t: 'mq', c: cid, n: v.no } }],
      },
      {
        tag: 'button',
        name: `mqs${cid}_${v.no}`,
        form_action_type: 'submit',
        type: 'primary',
        text: {
          tag: 'plain_text',
          content: btnText || i18n.t('api', '提交第 {no} 题', lang, { no: v.no }),
        },
        behaviors: [{ type: 'callback', value: { t: 'mq', c: cid, n: v.no } }],
      },
    ],
  };
}

/**
 * 自定义回答 → **单题 mini 表单**（`input` 输入框 + 提交按钮），2026-10-26 新增，
 * 对齐 `feishu._custom_input_form`(feishu.py:596)。
 *
 * 飞书官方《输入框》嵌套规则：「要结合使用输入框组件与按钮组件，你需将输入框组件
 * 与按钮组件内嵌于表单容器中」；表单容器只能放卡片根级。用户输入的文字在提交回调里
 * 以 `action.form_value[<输入框 name>]`（**字符串**）带回——2026-10-25 真机探针定论，
 * 且 `action.value` 取的是**提交按钮**的 behaviors.value，故 `t=ao` 挂在按钮上
 * （输入框上带同值只作冗余兜底，与 `multiSelectForm` 同款做法）。
 *
 * @param {string|number} cid 卡号
 * @param {number} no 题号（1 起；单题卡恒 1，多子题卡按题号区分）
 * @param {string} lang
 * @returns {object} 表单元素（体积由 `customInputElem` 校验）
 */
export function customInputForm(cid, no, lang = 'zh') {
  const btn = no > 1
    ? i18n.t('api', '提交第 {no} 题自定义回答', lang, { no })
    : i18n.t('api', '提交自定义回答', lang);
  return {
    tag: 'form',
    name: `aof${cid}_${no}`,
    elements: [
      {
        tag: 'input',
        name: `ao${cid}_${no}`,
        placeholder: { tag: 'plain_text', content: i18n.t('api', '输入自定义回答', lang) },
        max_length: 1000,          // 飞书输入框组件上限（1~1000，默认 1000）
        behaviors: [{ type: 'callback', value: { t: 'ao', c: cid, n: no } }],
      },
      {
        tag: 'button',
        name: `aos${cid}_${no}`,
        form_action_type: 'submit',
        type: 'primary',
        text: { tag: 'plain_text', content: btn },
        behaviors: [{ type: 'callback', value: { t: 'ao', c: cid, n: no } }],
      },
    ],
  };
}

/**
 * `customInputForm` 的体积预算版：装得进 form 硬限返回元素，否则 `null`
 * （绝不发出必被 `230099/11310` 拒收的卡；与多选 mini 表单同款守卫）。
 */
export function customInputElem(cid, no, lang = 'zh') {
  const form = customInputForm(cid, no, lang);
  return formCharLen(form) > MQ_FORM_MAX_BYTES ? null : form;
}

/**
 * 多子题 → 「逐题点选卡」元素，对齐 `feishu._multi_click_elements`(feishu.py:803)：
 * 返回 `[elements, 只能文本作答的题号列表, 发过输入框的题号列表, 发过多选表单的题号列表]`。
 * 单选放**根级** `select_static`；多选包一层单题 mini 表单（超预算或没选项 ⇒ 不该题
 * 有控件，绝不发出必被拒的卡）；`allow_other` 的题追加「自定义回答输入框」mini 表单
 * （2026-10-26）——「有控件」= 选项控件或输入框任一发出，两者都发不出才进 textOnly。
 */
export function multiClickElements(cid, views, lang = 'zh') {
  const els = [];
  const textOnly = [];
  const customForms = [];
  const multiForms = [];
  const n = views.length;
  for (const v of views) {
    els.push(questionMdElement(v, n, lang));
    let hasControl = false;
    if (v.options.length) {
      if (v.multi_select) {
        const form = multiSelectForm(cid, v, '', lang);
        if (formCharLen(form) <= MQ_FORM_MAX_BYTES) {
          els.push(form);
          multiForms.push(v.no);
          hasControl = true;
        }
      } else {
        els.push({
          tag: 'select_static',
          name: `mq${cid}_${v.no}`,
          placeholder: { tag: 'plain_text', content: i18n.t('api', '请选择', lang) },
          options: v.options.map((o) => ({
            text: { tag: 'plain_text', content: o.label },
            value: String(o.no),
          })),
          behaviors: [{ type: 'callback', value: { t: 'mq', c: cid, n: v.no } }],
        });
        hasControl = true;
      }
    }
    if (v.allow_other) {
      const cform = customInputElem(cid, v.no, lang);
      if (cform !== null) {
        els.push(cform);
        customForms.push(v.no);
        hasControl = true;
      }
    }
    if (!hasControl) textOnly.push(v.no);   // 没有可点控件：退回文本作答
  }
  return [els, textOnly, customForms, multiForms];
}

/**
 * 逐题点选卡末行指引，对齐 `feishu._multi_click_hint`(feishu.py:973)。
 * `textOnly` = 卡片上没有可点控件的题号；`multiForms` = 发了多选 mini 表单的题号；
 * `customForms` = 发了「自定义回答输入框」的题号（不再进文本补答清单）。
 */
export function multiClickHint(cid, qs, textOnly = [], multiForms = [], lang = 'zh',
  customForms = []) {
  const custom = [...new Set(customForms)].sort((a, b) => a - b);
  const customSet = new Set(custom);
  const extra = [...new Set([
    ...textOnly,
    ...qs.map((q, i) => ((q || {}).allow_other ? i + 1 : null)).filter((v) => v !== null),
  ])].filter((i) => !customSet.has(i)).sort((a, b) => a - b);
  const lines = [i18n.t('api', '逐题选择即可，答满 {n} 题自动送达 agent。', lang,
    { n: qs.length })];
  const forms = [...new Set(multiForms)].sort((a, b) => a - b);
  if (forms.length) {
    const sep = i18n.t('api', '；', lang);
    lines.push(forms.map((i) => i18n.t('api',
      '第 {i} 题是多选：勾选后点「提交第 {i} 题」', lang, { i })).join(sep));
  }
  if (custom.length) {
    const nos = custom.join(i18n.t('api', '、', lang));
    lines.push(i18n.t('api',
      '第 {nos} 题可在下方输入框填写自定义回答（点带题号的提交按钮）', lang, { nos }));
  }
  if (extra.length) {
    const nos = i18n.t('api', '、', lang);
    const values = extra.map((i) => i18n.t('api', '{i}:<值>', lang, { i })).join(' ');
    lines.push(i18n.t('api', '第 {nos} 题请回复「作答 {cid} {values}」作答', lang,
      { nos: extra.join(nos), cid, values })
      + i18n.t('api', '（自定义文字写 <文字>，可选项写序号，多选逗号分隔；'
        + '已点选的题不用重复给）', lang));
  }
  return lines.join('\n');
}

/**
 * `blocked_interaction` ctx → schema 2.0 交互卡片 dict，对齐
 * `feishu._build_interaction_card`(feishu.py:477)（DM 单聊推送用）。
 *
 * 形态分支（与 `render` 的文本分支**不是**同一套，别互相套用）：可远程作答的多子题 ⇒
 * 逐题点选卡（单选根级下拉 / 多选 mini 表单）+ 指引；不可远程作答的多子题 ⇒ 逐题只读 +
 * 统一引导；审批 ⇒ 批准/会话内批准/拒绝三按钮；单题多选 ⇒ mini 表单（装不下则文字指引）；
 * 单题单选 ⇒ 每选项一个按钮。**2026-10-26 起** `allow_other` 的题（单题单选/多选/无选项、
 * 多子题逐题）再追加「输入框 + 提交」mini 表单（`customInputForm`，回调 t=ao，
 * 见 `answerCustomText`）⇒ 单题多选/多子题卡可**同时出现多张 form**。
 * 按钮 value 精简键 `t/c/n/i`。
 * @param {object} ctx
 * @param {string} projectName
 * @returns {object}
 */
export function buildInteractionCard(ctx, projectName, lang = 'zh') {
  const kind = ctx.kind;
  const cid = ctx.card_id;
  const elements = [];
  // M6（2026-10-10）：方案先上（折叠面板 + 完整方案链接）；取不到方案时整块不出现
  if (pyTruthy(ctx.plan_inline) && kind !== 'approval') {
    elements.push({
      tag: 'collapsible_panel',
      expanded: true,
      header: {
        title: {
          tag: 'plain_text',
          content: i18n.t('api', '📄 agent 的方案 / 回答（点标题可折叠）', lang),
        },
      },
      elements: [{ tag: 'markdown', content: ctx.plan_inline }],
    });
  }
  if (pyTruthy(ctx.plan_doc_url) && kind !== 'approval') {
    elements.push({
      tag: 'markdown',
      content: i18n.t('api', '📄 [查看完整方案（飞书文档）]({url})', lang,
        { url: pyStr(ctx.plan_doc_url) }),
    });
  }
  if (kind === 'approval') {
    const rawAction = ctx.action || ctx.tool;
    const action = pyTruthy(rawAction) ? pyStr(rawAction)
      : i18n.t('api', '工具调用', lang);
    const lines = [i18n.t('api', '**审批请求**：{action}', lang, { action })];
    if (pyTruthy(ctx.tool)) {
      lines.push(i18n.t('api', '工具：{tool}', lang, { tool: pyStr(ctx.tool) }));
    }
    if (pyTruthy(ctx.input)) {
      lines.push(i18n.t('api', '内容：{input}', lang,
        { input: cpSlice(pyStr(ctx.input), 200) }));
    }
    elements.push({ tag: 'markdown', content: lines.join('\n') });
    for (const [label, t, style] of [
      ['✅ 批准', 'p', 'primary'],
      ['🔁 会话内批准', 's', 'default'],
      ['⛔ 拒绝', 'd', 'danger'],
    ]) {
      elements.push({
        tag: 'button',
        type: style,
        text: { tag: 'plain_text', content: i18n.t('api', label, lang) },
        behaviors: [{ type: 'callback', value: { t, c: cid } }],
      });
    }
  } else {
    const qs = (ctx.questions || []).filter((q) => pyTruthy(q));
    if (qs.length > 1) {
      const views = questionViews(qs, lang);
      elements.push({
        tag: 'markdown',
        content: [
          i18n.t('api', '**agent 提问（共 {n} 题）**', lang, { n: qs.length }),
          i18n.t('api', '卡片 #{cid} {title}', lang,
            { cid: pyStr(cid), title: clipField(ctx.title, 60) }),
        ].join('\n'),
      });
      if (pyTruthy(ctx.answerable)) {
        // 可远程作答：逐题点选（单选根级下拉 / 多选 mini 表单）；允许自定义的题
        // 另给「输入框 + 提交」mini 表单（2026-10-26）；放不下控件的题走文本补答
        const [clickEls, textOnly, customForms, multiForms] =
          multiClickElements(cid, views, lang);
        elements.push(...clickEls);
        elements.push({
          tag: 'markdown',
          content: multiClickHint(cid, qs, textOnly, multiForms, lang, customForms),
        });
      } else {
        elements.push(...questionCardBlocks(views, lang));
        elements.push({ tag: 'markdown', content: noRemoteAnswerHint(lang) });
      }
    } else {
      const question = pyTruthy(ctx.question) ? pyStr(ctx.question)
        : i18n.t('api', 'agent 正在等待你的回答', lang);
      const md = [
        i18n.t('api', '**agent 提问**：{question}', lang, { question }),
        i18n.t('api', '卡片 #{cid} {title}', lang,
          { cid: pyStr(cid), title: clipField(ctx.title, 60) }),
      ];
      let i = 0;
      for (const o of (ctx.options || [])) {
        i += 1;
        md.push(`${i}) ${pyStr(o)}`);
      }
      elements.push({ tag: 'markdown', content: md.join('\n') });
      const view = singleQuestionView(ctx, lang);
      let hint = null;
      if (!pyTruthy(ctx.answerable)) {
        hint = noRemoteAnswerHint(lang);
      } else if ((ctx.questions_count || qs.length || 0) > 1) {
        hint = i18n.t('api', '该提问含 {n} 道子题，请到站点会话窗口逐题作答', lang,
          { n: pyStr(ctx.questions_count || qs.length) });
      } else if (pyTruthy(ctx.multi_select)) {
        // 单题多选：多选 mini 表单（装不下/无选项时只给文本指引）；
        // 2026-10-26：允许自定义的题再加一个「输入框 + 提交」mini 表单
        const [form, pickHint] = singleMultiSelectPick(cid, ctx, lang, false);
        hint = pickHint;
        if (form !== null) elements.push(form);
        if (view.allow_other) {
          const cform = customInputElem(cid, 1, lang);
          if (cform !== null) {
            elements.push(cform);
            hint = form !== null
              ? i18n.t('api',
                '多选题：勾选后点「提交作答」；自定义文字在下方输入框'
                + '填写后点「提交自定义回答」（也可回复「作答 {cid} <文字>」）',
                lang, { cid: pyStr(cid) })
              : i18n.t('api',
                '在下方输入框填写自定义回答后点「提交自定义回答」，'
                + '也可回复「作答 {cid} <文字>」', lang, { cid: pyStr(cid) });
          } else {
            hint += i18n.t('api', '；自定义文字回复「作答 {cid} <文字>」',
              lang, { cid: pyStr(cid) });
          }
        }
      }
      if (pyTruthy(ctx.answerable) && !hint && kind === 'question') {
        let k = 0;
        for (const o of (ctx.options || [])) {
          k += 1;
          elements.push({
            tag: 'button',
            type: k === 1 ? 'primary' : 'default',
            text: { tag: 'plain_text', content: `${k}) ${pyStr(o)}` },
            behaviors: [{ type: 'callback', value: { t: 'a', c: cid, i: k } }],
          });
        }
        if (view.allow_other) {
          const cform = customInputElem(cid, 1, lang);
          if (cform !== null) {
            elements.push(cform);
            hint = i18n.t('api',
              '自定义回答：在下方输入框填写后点「提交自定义回答」，'
              + '也可回复「作答 {cid} <文字>」', lang, { cid: pyStr(cid) });
          } else {
            hint = i18n.t('api', '自定义回答请回复「作答 {cid} <文字>」', lang,
              { cid: pyStr(cid) });
          }
        }
      }
      if (hint) elements.push({ tag: 'markdown', content: hint });
    }
  }
  return {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: i18n.t('api', '🤔 卡片等待回复 [{name}]', lang,
          { name: pyStr(projectName) }),
      },
      template: 'orange',
    },
    body: { elements },
  };
}

// --------------------------------------------------------------------------
// REST 车道缝（M7-R4 的 `feishu_rest.js`）
// --------------------------------------------------------------------------

/** REST 车道不可用的响亮失败（`name`/`code` 与 R4 的 `FeishuRestError` 同形，便于按名判定） */
export class RestLaneUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeishuRestError';
    this.code = null;
  }
}

let REST_LANE = null;

/**
 * 懒加载 REST 车道（**不外抛成静默成功**：导入失败/接口不符一律抛 `RestLaneUnavailable`）。
 * 懒加载的理由见文件头接缝②；接口冻结为 `rest(method, path, {params, jsonBody, cfg, timeout})`
 * 与 `tenantToken(cfg)`（本文件只用到 `rest`/`restSendCard`/`FeishuRestError`）。
 * @returns {Promise<object>} `feishu_rest.js` 的模块命名空间
 */
async function loadRestLane() {
  if (REST_LANE !== null) return REST_LANE;
  let lane;
  try {
    lane = await import('./feishu_rest.js');
  } catch (error) {
    throw new RestLaneUnavailable(
      '飞书 REST 车道不可用（backend/lib/feishu_rest.js 缺失或导入失败）：'
      + `${errText(error)}——本调用需要 M7-R4 的 REST 车道`,
    );
  }
  if (typeof lane.rest !== 'function' || typeof lane.FeishuRestError !== 'function') {
    throw new RestLaneUnavailable(
      '飞书 REST 车道接口不符：需要导出 rest(method, path, {params, jsonBody, cfg, timeout})'
      + ' 与 FeishuRestError',
    );
  }
  REST_LANE = lane;
  return REST_LANE;
}

// --------------------------------------------------------------------------
// plan 方案文档族（feishu.py:605-936）
// --------------------------------------------------------------------------

/** 作答方案增强总闸，对齐 `feishu.plan_enabled`(feishu.py:617)：`TS_FEISHU_PLAN=0` 关闭 */
export function planEnabled() {
  return (process.env[PLAN_ENV] || '1') !== '0';
}

/** 北京时间字符串，对齐 `feishu._beijing_now`(feishu.py:622)（容器时区=UTC，一律按 UTC+8 落） */
export function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 会话转录 → 提问前的「方案/回答」文本 `{assistant, think}`，对齐
 * `feishu._plan_session_texts`(feishu.py:628)：取「最后一次 `ask_user_question` **之前**」的
 * 末条 assistant 与末条 think；读不到/解析异常 ⇒ 两项皆空串（方案取数失败绝不影响卡片发送）。
 * @param {string} sid
 * @returns {{assistant: string, think: string}}
 */
export function planSessionTexts(sid) {
  const empty = { assistant: '', think: '' };
  const s = pyStrip(pyStr(sid == null ? '' : sid));
  if (!s) return empty;
  try {
    const res = sessparse.load('dsh', s, 'main') || {};
    const entries = res.entries || [];
    if (!res.found || !entries.length) return empty;
    let cut = entries.length;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i] || {};
      if (e.kind === 'tool_call' && e.name === ASK_TOOL) {
        cut = i;
        break;
      }
    }
    let assistant = '';
    let think = '';
    for (const raw of entries.slice(0, cut).reverse()) {
      const e = raw || {};
      if (e.kind === 'assistant' && !assistant) assistant = pyStrip(pyStr(e.text || ''));
      else if (e.kind === 'think' && !think) think = pyStrip(pyStr(e.text || ''));
      if (assistant && think) break;
    }
    return { assistant, think };
  } catch {
    return empty;
  }
}

/**
 * 卡内折叠摘要（上限 `PLAN_INLINE_MAX`）：只取末条 assistant 回答，对齐
 * `feishu._plan_inline_markdown`(feishu.py:671)。
 *
 * 2026-10-18 用户裁定：卡上不要「思考摘录」——think 不进卡（此前 assistant 短于
 * 200 字时会补 think 摘录，该行为已退场）。assistant 为空 ⇒ 返回空串，调用方不挂
 * 面板（完整方案文档链接仍会发）。
 * @param {object} ctx
 * @param {{assistant?: string, think?: string}} texts
 * @returns {string}
 */
export function planInlineMarkdown(ctx, texts, lang = 'zh') {
  const a = pyStrip(pyStrOrEmpty((texts || {}).assistant));
  if (!a) return '';
  let md = a;
  if (cpLen(md) > PLAN_INLINE_MAX) {
    md = pyRstrip(cpSlice(md, PLAN_INLINE_MAX))
      + i18n.t('api', '\n\n…（摘要已截断，完整内容见下方飞书文档）', lang);
  }
  return md;
}

/**
 * 提问**全文**（不截断）→ markdown，对齐 `feishu._plan_question_md`(feishu.py:689)。
 * 与卡片渲染（按 `Q_TEXT_MAX`/`Q_OPT_MAX`/`Q_DESC_MAX` 截断）刻意分开：文档承载的正是
 * 卡片放不下的完整信息。
 * @param {object} ctx
 * @returns {string}
 */
export function planQuestionMd(ctx, lang = 'zh') {
  const qs = (ctx.questions || []).filter((q) => pyTruthy(q));
  const lines = [];
  if (!qs.length) {
    const q = pyStrip(pyStrOrEmpty(ctx.question));
    if (q) lines.push(q);
    let i = 0;
    for (const o of (ctx.options || [])) {
      i += 1;
      lines.push(`${i}) ${optionView(o).label}`);
    }
    return lines.join('\n');
  }
  const n = qs.length;
  let i = 0;
  for (const q of qs) {
    i += 1;
    const title = pyStr(q.header || q.question
      || i18n.t('api', '第 {no} 题', lang, { no: i }));
    lines.push(`### ${i}/${n} ${title}`);
    if (q.header && q.question) lines.push(pyStr(q.question));
    const body = pyStrip(pyStrOrEmpty(q.body));
    if (body) lines.push(body);
    let j = 0;
    for (const o of (q.options || [])) {
      j += 1;
      const ov = optionView(o);
      lines.push(`${j}) ${ov.label}`);
      if (ov.description) lines.push(`　　${ov.description}`);   // 全角缩进：描述次行
    }
    const caps = [];
    if (q.multi_select) caps.push(i18n.t('api', '多选', lang));
    if (q.allow_other) {
      caps.push(i18n.t('api', '可自定义：{label}', lang,
        { label: q.other_label || i18n.t('api', '其他', lang) }));
    }
    const line = capsLine(caps, lang);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * 文档标题：卡号 + 题头，对齐 `feishu._plan_doc_title`(feishu.py:729)。
 * @param {object} ctx
 * @returns {string}
 */
export function planDocTitle(ctx, lang = 'zh') {
  const head = pyFirstLine(pyStrip(pyStr(ctx.header || ctx.question
    || i18n.t('api', '提问', lang))));
  return clipText(i18n.t('api', '卡 {cid} · {head}', lang,
    { cid: pyStr(ctx.card_id), head }), 80);
}

/**
 * 完整方案文档正文（markdown，经 `mdBlocks` 转飞书块），对齐
 * `feishu._plan_doc_markdown`(feishu.py:734)：提问**全文** + 末条 assistant 回答 +
 * 作答指引；2026-10-18 起**不含 think 摘录**（用户裁定思考内容不进任何飞书产物）；
 * 整体按 `PLAN_DOC_MAX` 截断（码点）。
 * @param {object} ctx
 * @param {{assistant?: string, think?: string}} texts
 * @param {string} [projectName]
 * @returns {string}
 */
export function planDocMarkdown(ctx, texts, projectName = '', lang = 'zh') {
  const cid = pyStr(ctx.card_id);
  const a = pyStrip(pyStrOrEmpty((texts || {}).assistant));
  const lines = [
    i18n.t('api', '# 卡 {cid} · agent 的方案与提问', lang, { cid }), '',
    i18n.t('api', '- 项目：{name}', lang,
      { name: pyStr(pyTruthy(projectName) ? projectName : '—') }),
    i18n.t('api', '- 卡片：{title}', lang,
      { title: cpSlice(pyStrOrEmpty(ctx.title), 60) }),
    i18n.t('api', '- 时间：{time}（北京时间）', lang, { time: beijingNow() }),
  ];
  const sid = pyStrip(pyStrOrEmpty(ctx.session_id));
  if (sid) lines.push(i18n.t('api', '- 会话：{sid}', lang, { sid }));
  if (a) lines.push('', i18n.t('api', '## agent 的方案 / 回答', lang), '', a);
  lines.push('', i18n.t('api', '## 提问（全文）', lang), '',
    planQuestionMd(ctx, lang));
  lines.push('', i18n.t('api', '## 如何作答', lang), '',
    i18n.t('api', '- 在飞书聊天里点卡片上的选项按钮 / 下拉即完成作答'
      + '（多选题勾选后点「提交」）；', lang),
    i18n.t('api', '- 也可以直接回复：「作答 {cid} <序号>」（多选逗号分隔，'
      + '如 `作答 {cid} 1,3`），或「作答 {cid} <自定义文字>」写自由文本；',
    lang, { cid }),
    i18n.t('api', '- 点选与文本作答可混用，已点选的题不必重复给。', lang));
  let md = lines.join('\n');
  if (cpLen(md) > PLAN_DOC_MAX) {
    md = cpSlice(md, PLAN_DOC_MAX) + i18n.t('api', '\n\n…（正文已截断）', lang);
  }
  return md;
}

/**
 * 清掉 docx 文本块**不渲染**的行内 markdown 记号，对齐 `feishu._md_plain`(feishu.py:768)。
 *
 * 逐点照抄三条正则：Python 的 `.` **不匹配 `\n`**（故 JS 侧一律写 `[^\n]` 而不是 `.`，
 * 否则 `**a\nb**` 这类跨行会被误吞）。
 * @param {string} s
 * @returns {string}
 */
export function mdPlain(s) {
  let out = String(s);
  out = out.replace(/\*\*([^\n]+?)\*\*/g, '$1');
  out = out.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '$1');
  out = out.replace(/~~([^\n]+?)~~/g, '$1');
  return out.replace(/`/g, '');
}

/**
 * 极简 markdown → 飞书文档块，对齐 `feishu._md_blocks`(feishu.py:777)：
 * 标题(3/4/5)/项目符号(12)/有序(13)/引用(15)/代码(14)/分隔线(22)/正文(2)；
 * 表格分隔行（`| --- | --- |`）丢弃（飞书块不支持表格）；超长段落按 `MD_BLOCK_MAX`
 * **码点**切块；产出恒为合法块形状，绝不抛。
 * @param {string} text
 * @returns {object[]}
 */
export function mdBlocks(text) {
  const blocks = [];
  let inCode = false;
  const buf = [];

  const mk = (bt, key, content) => ({
    block_type: bt,
    [key]: {
      elements: [{
        text_run: {
          content,
          text_element_style: { bold: bt === 3 || bt === 4 || bt === 5 },
        },
      }],
      style: {},
    },
  });
  const addText = (bt, key, s) => {
    if (!s) return;
    const cps = Array.from(s);
    for (let i = 0; i < cps.length; i += MD_BLOCK_MAX) {
      blocks.push(mk(bt, key, cps.slice(i, i + MD_BLOCK_MAX).join('')));
    }
  };
  const flushCode = () => {
    if (buf.length) {
      addText(14, 'code', buf.join('\n'));
      buf.length = 0;
    }
  };

  const source = pyTruthy(text) ? pyStr(text) : '';
  for (const raw of source.split('\n')) {
    const line = pyRstrip(raw);
    if (pyStrip(line).startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      buf.push(line);
      continue;
    }
    const s = mdPlain(line);
    if (!pyStrip(s)) continue;
    if (/^\|[\s\-:|]+\|$/.test(pyStrip(s))) continue;      // 表格分隔行：丢
    if (s.startsWith('### ')) addText(5, 'heading3', s.slice(4));
    else if (s.startsWith('## ')) addText(4, 'heading2', s.slice(3));
    else if (s.startsWith('# ')) addText(3, 'heading1', s.slice(2));
    else if (pyStrip(s) === '---') blocks.push({ block_type: 22, divider: {} });
    else if (pyLstrip(s).startsWith('> ')) addText(15, 'quote', pyLstrip(s).slice(2));
    else if (new RegExp(`^${PY_WS}*[-*] `).test(s)) {
      addText(12, 'bullet', s.replace(new RegExp(`^${PY_WS}*[-*] `), ''));
    } else if (new RegExp(`^${PY_WS}*\\d+[.)] `).test(s)) {
      addText(13, 'ordered', s.replace(new RegExp(`^${PY_WS}*\\d+[.)] `), ''));
    } else addText(2, 'text', s);
  }
  flushCode();
  return blocks;
}

/**
 * 建飞书云文档并授权给用户 → 返回规范链接，对齐 `feishu._docx_create`(feishu.py:842)。
 *
 * 配方（2026-10-10 真机实测通过）：① 建文档；② 写正文（**单次 ≤50 块**）；
 * ③ PATCH 链接分享「组织内可阅读」（**必做**：文档默认归应用所有，不做这步用户打不开）；
 * ④ POST 把用户加成协作者（**best-effort**：失败只留痕，第③步已保证可读）；
 * ⑤ metas/batch_query（带 `with_url=true`）取规范链接，漏了会 `code=0` 静默回空串 ⇒
 * 此时按租户域名兜底拼链接。任一步失败抛 REST 车道的 `FeishuRestError`。
 *
 * **Node 侧是 async**（REST 走 fetch）：Python 是同步函数，调用链 `attachPlan` 因此也是 async，
 * 见文件头接缝②。
 * @param {string} title
 * @param {string} mdText
 * @param {object} cfg 用户应用凭据
 * @param {string} [openId]
 * @param {number} [timeout]
 * @returns {Promise<string>} 文档链接
 */
export async function docxCreate(title, mdText, cfg, openId, timeout = DOC_TIMEOUT) {
  const lane = await loadRestLane();
  const body = (await lane.rest('POST', '/open-apis/docx/v1/documents', {
    jsonBody: { title }, cfg, timeout,
  })) || {};
  const doc = (((body.data || {}).document || {}).document_id) || '';
  if (!doc) throw new lane.FeishuRestError('建文档成功但没拿到 document_id');
  const blocks = mdBlocks(mdText);
  for (let i = 0; i < blocks.length; i += 50) {
    await lane.rest('POST', `/open-apis/docx/v1/documents/${doc}/blocks/${doc}/children`, {
      jsonBody: { children: blocks.slice(i, i + 50), index: i }, cfg, timeout,
    });
  }
  await lane.rest('PATCH', `/open-apis/drive/v1/permissions/${doc}/public`, {
    params: { type: 'docx' },
    jsonBody: { link_share_entity: 'tenant_readable', external_access_entity: 'open' },
    cfg,
    timeout,
  });
  if (openId) {
    try {
      // need_notification=false：文档链接已在卡上，再加一条「分享给你」的通知就是重复打扰
      await lane.rest('POST', `/open-apis/drive/v1/permissions/${doc}/members`, {
        params: { type: 'docx', need_notification: 'false' },
        jsonBody: { member_type: 'openid', member_id: openId, perm: 'full_access' },
        cfg,
        timeout,
      });
    } catch (error) {
      if (!(error instanceof lane.FeishuRestError)) throw error;
      stderrLine('feishu docx: 加协作者失败（第③步链接分享已可读，继续）: '
        + errRepr(error));
    }
  }
  const meta = (await lane.rest('POST', '/open-apis/drive/v1/metas/batch_query', {
    params: { user_id_type: 'open_id' },
    jsonBody: { request_docs: [{ doc_token: doc, doc_type: 'docx' }], with_url: true },
    cfg,
    timeout,
  })) || {};
  const metas = (meta.data || {}).metas || [];
  const url = (metas.length ? (metas[0].url || '') : '') || '';
  return url || `https://feishu.cn/docx/${doc}`;      // 兜底：域名由飞书 301/302 重定向
}

/**
 * `(卡, 提问)` → 已建文档链接的记账表，对齐 `feishu._PLAN_DOCS`(feishu.py:611)。
 *
 * Python 的键是二元 tuple `(int(card_id), str(qid))`；JS 用 `\u0000` 拼接的字符串等价表达
 * （qid 不可能含 NUL；Python tuple 的 `(1, "2")` 与 `(1, 2)` 不同键，这里 `int()` 后拼同样区分）。
 * @type {Map<string, {url: string, at: number}>}
 */
const PLAN_DOCS = new Map();

function planDocKey(cardId, qid) {
  return `${cardId}\u0000${qid}`;
}

/** 取该 (卡, 提问) 已建文档链接，对齐 `feishu._plan_doc_get`(feishu.py:890)（顺带清过期记录） */
export function planDocGet(cardId, qid) {
  const now = Date.now() / 1000;
  for (const [k, v] of [...PLAN_DOCS.entries()]) {
    if (now - (v.at || 0) > PLAN_DOC_TTL) PLAN_DOCS.delete(k);
  }
  const v = PLAN_DOCS.get(planDocKey(cardId, qid));
  return v ? (v.url || '') : '';
}

/** 记账（同一提问只建一次文档；上限截断防无界增长），对齐 `feishu._plan_doc_put`(feishu.py:899) */
export function planDocPut(cardId, qid, url) {
  PLAN_DOCS.set(planDocKey(cardId, qid), { url, at: Date.now() / 1000 });
  while (PLAN_DOCS.size > 128) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of PLAN_DOCS.entries()) {
      if ((v.at || 0) < oldestAt) {
        oldestAt = v.at || 0;
        oldestKey = k;
      }
    }
    PLAN_DOCS.delete(oldestKey);
  }
}

/**
 * 把「方案」挂到卡片上下文，对齐 `feishu._attach_plan`(feishu.py:906)：
 * `plan_inline`（卡内折叠摘要）+ `plan_doc_url`（文档链接）。
 *
 * best-effort：**绝不外抛**——方案是锦上添花，卡本身必须发出去。失败**留痕到 stderr**
 * （Python 同款 print），不是静默成功。无会话直接返回，不发无意义文档；同一 (卡, 提问)
 * 只建一次文档。
 * @param {object} ctx 原地修改（挂 `plan_inline`/`plan_doc_url`）
 * @param {string} projectName
 * @param {object} cfg
 * @param {string} [openId]
 * @returns {Promise<void>}
 */
export async function attachPlan(ctx, projectName, cfg, openId = '', lang = 'zh') {
  try {
    const sid = pyStrip(pyStrOrEmpty(ctx.session_id));
    if (!sid) return;
    const texts = planSessionTexts(sid);
    const inline = planInlineMarkdown(ctx, texts, lang);
    if (inline) ctx.plan_inline = inline;
    const cid = Math.trunc(Number(ctx.card_id || 0)) || 0;
    const qid = pyStrOrEmpty(ctx.qid);
    const cached = planDocGet(cid, qid);
    if (cached) {
      ctx.plan_doc_url = cached;
      return;
    }
    const md = planDocMarkdown(ctx, texts, projectName, lang);
    if (!pyStrip(md)) return;
    const url = await docxCreate(planDocTitle(ctx, lang), md, cfg, openId);
    if (url) {
      planDocPut(cid, qid, url);
      ctx.plan_doc_url = url;
    }
  } catch (error) {
    stderrLine('feishu docx: 建方案文档失败（卡照发，仅卡内摘要）: ' + errRepr(error));
  }
}

// --------------------------------------------------------------------------
// 业务侧语义函数（board / runner 钩子调用；feishu.py:939-1034）
// --------------------------------------------------------------------------

/**
 * 旁路：向项目所有者的飞书单聊发交互卡片，对齐
 * `feishu._dm_interaction_card`(feishu.py:939)。
 *
 * **受 `notifyEvents` 闸门约束**（2026-10-10 修实障：此前只看绑定与凭据 ⇒ 用户关掉全部
 * 事件后卡片仍持续送达），再要求账号绑定 + 应用凭据齐全才发。卡片是即时交互载体，
 * **不走 outbox**（过期提问的分钟级重试无意义）；失败仅留痕——群 webhook 文本推送
 * （`pushEvent`）始终是主通道，不受影响。
 *
 * Node 侧是 async（REST 走 fetch）；异常**内部吞掉并留痕**（照抄 Python 的 except + print）。
 * @param {number} projectId
 * @param {object} ctx
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<void>} 永不 reject
 */
export async function dmInteractionCard(projectId, ctx, options = {}) {
  try {
    if (!notifyEvents(projectId, options).has('blocked_interaction')) return;
    const proj = getProject(projectId, options);
    const owner = (proj ? proj.user_id : 0) || 0;
    const binding = getFeishuBindingByUser(owner, options);
    const cfg = appConfig(owner, options);
    if (!binding || !cfg) return;
    const name = proj ? proj.name : `#${projectId}`;
    // 语言归属 = 收件人（项目所有者）；入口解析一次、向下传
    const lang = userLang(owner, options);
    // 审批卡不做方案文档（它的「背景」由审批请求本身给出，建文档没意义）；开关可回滚
    if (planEnabled() && pyStrOrEmpty(ctx.kind) !== 'approval') {
      await attachPlan(ctx, name, cfg, binding.open_id || '', lang);
    }
    const lane = await loadRestLane();
    await lane.restSendCard(binding.open_id, buildInteractionCard(ctx, name, lang), cfg);
  } catch (error) {
    stderrLine('feishu outbound: DM 交互卡片发送失败: ' + errRepr(error));
  }
}

/**
 * 卡片交互等待（`board._iw_apply` block 分支调用），对齐
 * `feishu.card_blocked`(feishu.py:969)：qid 进 `dedup_key` 防同一提问在重试窗口内重复推送。
 *
 * **形参表照 Python**（3 位 + 本仓库的 `options` 末位）；内部从 card/interaction 拼 ctx
 * （提问带 `questions_count`/`multi_select`/`allow_other`，审批带 `tool`/`action`/`input`），
 * 然后 `pushEvent`（同步）+ 旁路 DM 卡片（不 await，Python 侧同为「发完即走」）。
 * @param {number} projectId
 * @param {object} card 看板卡行（db 行即可，内部转普通对象）
 * @param {object} interaction
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {void}
 */
export function cardBlocked(projectId, card, interaction, options = {}) {
  const c = isPlainObject(card) ? card : { ...card };
  if (!('id' in c)) throw new TypeError('card 缺少 id（Python 侧此处是 KeyError）');
  const kind = pyStrOrEmpty(interaction.kind);
  const qs = (interaction.questions || []).filter((q) => pyTruthy(q));
  const q0 = qs.length ? qs[0] : {};
  const ctx = {
    card_id: c.id,
    title: c.title || '',
    kind,
    // 方案取数（attachPlan 读会话转录）与建文档去重都要这两个键；缺了它们整块自动跳过
    session_id: pyStrOrEmpty(c.session_id),
    qid: pyStrOrEmpty(interaction.qid),
    question: interaction.question || '',
    // 选项展示名取 label（交互归一后的字段）：旧代码取不存在的 text 字段，
    // 推送里选项序号后恒空白
    options: (interaction.options || []).map((o) => o.label || o.text || ''),
    answerable: pyTruthy(interaction.answerable),
    dedup_key: `card:${c.id}:interaction:${interaction.qid || ''}`,
  };
  if (kind === 'approval') {
    ctx.tool = interaction.tool || '';
    ctx.action = interaction.action || '';
    ctx.input = interaction.input || '';
  } else {
    ctx.questions_count = qs.length;
    ctx.multi_select = pyTruthy(dictGet(q0, 'multi_select', interaction.multi_select));
    ctx.allow_other = pyTruthy(dictGet(q0, 'allow_other', interaction.allow_other));
    // 逐题视图透传：多子题按题能力取组件；组不成表单时同一份数据供逐题只读展示
    ctx.questions = qs.map((q) => ({
      id: pyStrOrEmpty(q.id),
      question: q.question || '',
      header: q.header || '',
      body: q.body || '',
      options: (q.options || []).map((o) => optionView(o)),
      multi_select: pyTruthy(q.multi_select),
      allow_other: pyTruthy(q.allow_other),
      other_label: q.other_label || '',
    }));
  }
  pushEvent(projectId, 'blocked_interaction', ctx, options);
  // 旁路：不 await（Python 同为发完即走）。dmInteractionCard 内部自吞异常，不会 reject；
  // 末尾的 catch 只防御「留痕函数本身抛」这种不可能路径，且**不改变**可观测结果。
  dmInteractionCard(projectId, ctx, options).catch(() => {});
}

/**
 * 卡片落 review 待审核，对齐 `feishu.card_review`(feishu.py:1022)（默认 events 不含此 kind，
 * 项目级开启才推）。形参表照 Python：`(project_id, card)` 两位。
 * @param {number} projectId
 * @param {object} card
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {void}
 */
export function cardReview(projectId, card, options = {}) {
  const c = isPlainObject(card) ? card : { ...card };
  if (!('id' in c)) throw new TypeError('card 缺少 id（Python 侧此处是 KeyError）');
  pushEvent(projectId, 'card_review', { card_id: c.id, title: c.title || '' }, options);
}

/**
 * 任务 failed/interrupted（runner 各终态写点调用），对齐
 * `feishu.task_failed`(feishu.py:1029)：形参表照 Python
 * `(project_id, task_id, name, ttype, error, skipped_n=0)`，末位多一个本仓库的 `options`。
 *
 * **已知形态差异**：Python 的 `skipped_n` 是关键字实参，而 mod-run 的 `kwargs` 在 Node 侧会
 * 合并成**末位对象** ⇒ 将来若要用 `kwargs` 驱动 `skipped_n`，它会落到 `options` 位上。
 * 用 `args` 传第 6 位则两边都对（用例未驱动本函数，登记在 M7-R2 未验项里）。
 * @param {number} projectId
 * @param {number} taskId
 * @param {string} name
 * @param {string} ttype
 * @param {string} error
 * @param {number} [skippedN]
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {void}
 */
export function taskFailed(projectId, taskId, name, ttype, error, skippedN = 0, options = {}) {
  pushEvent(projectId, 'task_failed', {
    task_id: taskId, name, type: ttype, error, skipped_n: skippedN,
  }, options);
}

// --------------------------------------------------------------------------
// 投递线程（feishu.py:2599-2678）
// --------------------------------------------------------------------------

/** `code == 0` 的 Python 口径（`False == 0`、`0.0 == 0` 都为真；`!==` 会把 `false` 误判） */
function pyEqZero(value) {
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'bigint') return value === 0n;
  return value === 0;
}

/**
 * 同步发一枪 POST（`node:http`/`node:https`），逐字节照抄 Python `urllib` 的线上形态：
 * ```
 * POST <path?query> HTTP/1.1
 * Accept-Encoding: identity
 * Content-Length: <n>
 * Host: <host[:port]>          # 默认端口不写端口
 * User-Agent: Python-urllib/3.12
 * Content-Type: application/json
 * Connection: close
 * ```
 * 头序/大小写/值都是**实测**的 oracle 形态（`doc_ai/plan/202610/20261014_1930_M7…` §1.4），
 * 不是「Node 习惯怎么发就怎么发」。**不跟随 3xx**（见文件头「跨运行时的已知分歧」）。
 * @param {string} target
 * @param {Buffer} bodyBytes
 * @returns {Promise<{status: number, statusMessage: string, body: Buffer}>}
 */
function postJson(target, bodyBytes) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(String(target));
    } catch (error) {
      reject(new Error(`unknown url type: ${String(target)}`));
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error(`unknown url type: ${url.protocol}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = url.port ? Number(url.port) : defaultPort;
    const hostHeader = port === defaultPort ? url.hostname : `${url.hostname}:${port}`;
    const req = mod.request({
      hostname: url.hostname,
      port,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      headers: {
        'Accept-Encoding': 'identity',
        'Content-Length': String(bodyBytes.length),
        Host: hostHeader,
        'User-Agent': 'Python-urllib/3.12',
        'Content-Type': 'application/json',
        Connection: 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        statusMessage: res.statusMessage || '',
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(SEND_TIMEOUT * 1000, () => {
      req.destroy(new Error(`timed out after ${SEND_TIMEOUT}s`));
    });
    req.end(bodyBytes);
  });
}

/**
 * 同步发送一条 outbox 行，对齐 `feishu._send_one`(feishu.py:2607)：发送时刻补
 * timestamp/sign（secret 不落日志，错误摘要只含飞书返回 code/msg），返回 `[ok, err]`。
 *
 * 不外抛（坏 URL/网络/非 JSON 响应都转错误串）——外抛会让投递线程该行永不标记、每秒空转重试。
 * 唯一的例外照抄 Python：payload 解析出的值**不是 dict** 而 secret 非空时，
 * `body["timestamp"] = ts` 会抛 TypeError（Python 同样在 try 之外）。
 * @param {{id: number, retries: number, payload: string, secret: string, target: string}} row
 * @returns {Promise<[boolean, string]>}
 */
export async function sendOne(row) {
  const ts = String(Math.trunc(Date.now() / 1000));
  let body;
  try {
    body = JSON.parse(row.payload);
  } catch (error) {
    return [false, cpSlice(errText(error), 200)];
  }
  if (row.secret) {
    if (!isPlainObject(body)) {
      throw new TypeError('payload 不是 JSON 对象，无法补 timestamp/sign（Python 同处抛 TypeError）');
    }
    body.timestamp = ts;
    body.sign = sign(row.secret, ts);
  }
  let out;
  let resp;
  try {
    resp = await postJson(row.target, Buffer.from(pyJsonDumps(body), 'utf8'));
  } catch (error) {
    return [false, cpSlice(errText(error), 200)];
  }
  if (resp.status < 200 || resp.status >= 300) {
    // Python 侧 urlopen 对 4xx/5xx 抛 HTTPError，文案形态＝`HTTP Error <code>: <reason>`
    return [false, cpSlice(`HTTP Error ${resp.status}: ${resp.statusMessage}`, 200)];
  }
  try {
    out = JSON.parse(resp.body.toString('utf8'));
  } catch (error) {
    return [false, cpSlice(errText(error), 200)];
  }
  if (isPlainObject(out)) {
    if (pyEqZero(dictGet(out, 'code'))) return [true, ''];
    return [false, cpSlice(`code=${pyStr(dictGet(out, 'code'))} `
      + `${pyStr(dictGet(out, 'msg', ''))}`, 200)];
  }
  return [false, cpSlice(pyStr(out), 200)];
}

/**
 * 发送 + 落账，对齐 `feishu._send_one_and_mark`(feishu.py:2635)：
 * 成功标 `sent`（`retries` **不变**、`next_at=0`、`last_error=''`）；
 * 失败 `retries+1` 按 `RETRY_DELAYS` 退避续期 `pending`，第 4 次（`n > 3`）标 `failed` 留痕。
 * @param {{id: number, retries: number, payload: string, secret: string, target: string}} row
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<boolean>}
 */
export async function sendOneAndMark(row, options = {}) {
  const [ok, err] = await sendOne(row);
  if (ok) {
    feishuOutboxMark(row.id, 'sent', row.retries, 0, '', options);
    return true;
  }
  const n = row.retries + 1;
  if (n > RETRY_MAX) {
    feishuOutboxMark(row.id, 'failed', n, 0, err, options);
  } else {
    feishuOutboxMark(row.id, 'pending', n, Date.now() / 1000 + RETRY_DELAYS[n - 1], err,
      options);
  }
  return false;
}

/**
 * 投递线程循环（对齐 `feishu._send_loop`(feishu.py:2651)）：每轮取到期 pending 行逐条发送，
 * **双层 `except: pass`**（单行失败不影响整轮、整轮失败不影响下一轮）。
 *
 * Node 没有 daemon 线程：等价物是 `setInterval` + `.unref()`（不阻塞进程退出）。
 * Python 先跑一轮体再 `sleep(1)` ⇒ 这里同样**先立刻跑一轮**再起定时器。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {NodeJS.Timeout} 定时器句柄（已 unref；测试用 clearInterval 收尾）
 */
export function sendLoop(options = {}) {
  const tick = async () => {
    try {
      for (const row of feishuOutboxDue(Date.now() / 1000, 5, options)) {
        try {
          await sendOneAndMark(row, options);
        } catch {
          // 内层 except：单行坏数据（如 payload 非 dict + 非空 secret）不该拖垮整轮
        }
      }
    } catch {
      // 外层 except：取行失败（库被锁/表缺）同样只跳过本轮
    }
  };
  tick().catch(() => {});
  const timer = setInterval(() => { tick().catch(() => {}); }, TICK * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** `_SENDER_STARTED`(feishu.py:39)：幂等守卫（模块级，长驻进程内只起一次） */
let SENDER_STARTED = false;

/**
 * 幂等启动投递线程，对齐 `feishu.start_notifier`(feishu.py:2665-2678)。
 *
 * 副作用有两个（照 oracle 的顺序）：① `feishu_conv.start(options)` 注册 chat 的消息终态
 * 钩子（M7.5-R3 接线：**这是本模块唯一的接线点，漏掉则回流全哑且无任何报错**）；
 * ② 起投递线程 `sendLoop`（未配置时空转）。
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {NodeJS.Timeout|null} 首次调用返回定时器句柄；重复调用返回 `null`（no-op）
 */
export function startNotifier(options = {}) {
  if (SENDER_STARTED) return null;
  SENDER_STARTED = true;
  feishuConv.start(options);         // = feishu.py:2676（注册终态钩子；幂等，单一注册位）
  return sendLoop(options);          // = 起 feishu-notifier 投递线程
}

/** 仅供测试/自检：重置 `_SENDER_STARTED` 守卫（Python 侧可直接 poke 模块全局，Node 不行） */
export function resetSenderStarted() {
  SENDER_STARTED = false;
}

// ==========================================================================
// M7-R3：个人配置写口 / 绑定码 / 入站闸门
// （`feishu.py:1617-1653` 的 `start_inbound_for` + `:2004-2060` 的绑定码/绑定 +
//   `:3152-3174` 的 `save_user_config`）
// ==========================================================================
//
// 本节**只在文件末尾追加**（R2 车道已冻结本文件上半部分）：已有的函数、常量、私有助手
// （`pyTruthy` / `dictGet` / `pyStr` / `pyStrOrEmpty` / `pyStrip`）原样复用，不重写、不改口径。
// 三处 import 也放在末尾——ESM 的 import 声明会被提升，语义与置顶完全相同（Node 24 实测）。
//
// ══ 三条「照抄才不失真」的口径 ═════════════════════════════════════════════════════
// 1. **`str(v or "").strip()` 落库**（`feishu.py:3166-3169`）：五个字符串键走 `str()`，
//    容器**走 Python repr**（`["a"]`⇒`"['a']"`、`{"a":1}`⇒`"{'a': 1}"`）——用 `JSON.stringify`
//    兜底会差引号与空格。故复用模块私有的 `pyStrOrEmpty` + `lib.js:pyStrip`，不另写一份。
// 2. **两个开关走 Python `bool()`**（`:3164-3165`）：非空串一律真（`"0"`⇒1）、空容器一律假
//    （`[]`/`{}`⇒0）。JS 的 `Boolean([])`/`Boolean({})` 都是 true ⇒ 必须过 `pyTruthy`。
// 3. **`start_inbound_for` 的 stderr 行逐字相同**（`:1639-1641`）：凭据缺失时的文案是
//    `feishu inbound: 用户 {user_id} 应用凭据缺失，长连接未启动`（用户 id 是数字，不是用户名）。
//
// ══ M7 的边界（**不许伪造成 true**）═══════════════════════════════════════════════
// 入站 WS 长连接是 M7.5 的本体（`feishu_ws.js` + `feishu_inbound.js` + `feishu_conv.js`）。
// 本节的 `startInboundFor` 只做「闸门 + 注册表查询 + stderr 一行」，**不建线程**：
//   - 凭据缺失 ⇒ 打 oracle 逐字相同的行 + 回 `false`（这一档与 oracle 完全一致）；
//   - 凭据齐全 ⇒ **本轮也回 `false`**，另打一行说明「入站长连接未移植（M7.5 接线）」。
// 为什么凭据齐全也不能回 true：oracle 里这一位是 `threading.Thread.start()` 的**真实结果**，
// M7 没有对应物。回 true 会让 `POST /api/me/feishu-cfg` 的 `inbound_started` 变成
// 「保存后立刻为 true」，而实际一条连接都没建立——页面据此显示「已连接」是**假成功**。
//
// ══ 已知分歧（登记，不擅自「修」）═════════════════════════════════════════════════
// `feishu_user_cfgs.json` 是**合法 JSON 但非对象**（`null`/`[]`/`123`/`"x"`，只有手工改库
// 才可能）时，oracle 在 `cfg.get(...)`/`cfg[k]=...` 上抛 AttributeError/TypeError ⇒ 连接被
// 掐断。本节里：
//   - `saveUserConfig` 走 `requireCfgDict` **同形抛 TypeError**（由 `dispatchSafely` 收口成
//     `res.destroy()`）——比 oracle 早一步（写在赋值/落库之前），但**不可观测**：非对象的
//     `json.dumps` 重写是幂等的（`null`→`null`、`[]`→`[]`），库里字节不变。
//   - `startInboundFor` 走 R1 冻结的 `feishu_cfg.js:appConfig`（对 `[]`/`123` **宽松**：
//     `[].app_id` 是 undefined ⇒ 判为「凭据缺失」）。这是 R1 已登记的已知分歧
//     （`feishu_cfg.js` 文件头末条），本节不另造第二套口径。

/** 绑定码字符集（去易混字符 `0/1/I/L/O`）。对齐 `feishu._BIND_ALPHABET`(feishu.py:2009) */
export const _BIND_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** 绑定码有效期（秒）。对齐 `feishu._BIND_TTL`(feishu.py:2010) */
export const _BIND_TTL = 600;

/**
 * 绑定码注册表（`code → [user_id, expires(秒)]`），**进程内存态、不入库**。
 * 对齐 `feishu._BIND_CODES`(feishu.py:2011)。语义照抄：
 *   - 换码（`makeBindCode`）**不清理旧条目**——旧码靠 TTL 判死，`bindUser` 的 pop 顺手清；
 *   - 进程重启即全丢；无 TTL 回显（响应里只有 `code`）。
 * 导出只为「单测能直接钉住注册表形态」；产品代码只用 `makeBindCode`/`bindUser`。
 */
export const _BIND_CODES = new Map();

/**
 * 生成 6 位绑定码并登记。对齐 `feishu.make_bind_code`(feishu.py:2019)。
 *
 * `secrets.choice(_BIND_ALPHABET)` ↔ `crypto.randomInt(len)`：两者都是**均匀**取一个字符
 * （`Math.random()*32` 也行但分布口径不同，故显式用 CSPRNG，与 `secrets` 同族）。
 * 无幂等、无 TTL 回显；同一次调用只写一个条目。
 * @param {number} userId
 * @returns {string} 6 位码（字符集 `_BIND_ALPHABET`）
 */
export function makeBindCode(userId) {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += _BIND_ALPHABET[crypto.randomInt(_BIND_ALPHABET.length)];
  }
  _BIND_CODES.set(code, [userId, Date.now() / 1000 + _BIND_TTL]);
  return code;
}

/**
 * 校验绑定码并绑定（open_id 侧发起）。`null`=成功，字符串=错误文案。
 * 对齐 `feishu.bind_user`(feishu.py:2028-2036)。三处易错点照抄：
 *   ① 码先 `(code or "").strip().upper()` 归一（大小写/首尾空白都容忍，`null`/`""` 归一成空串）；
 *   ② **先 pop 再判**——校验失败（未知/过期）也照样出表，重放同一个码只会失败一次；
 *   ③ `db.set_feishu_binding` 的「换绑归零」语义（同 user_id 旧行先删）在 db 层，本函数不管。
 * @param {string} code 用户报出的绑定码
 * @param {string} openId 飞书号 open_id
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string|null}
 */
export function bindUser(code, openId, options = {}) {
  const key = String(code || '').trim().toUpperCase();
  const item = _BIND_CODES.get(key);
  _BIND_CODES.delete(key);
  if (item === undefined) {
    // 无效码没有身份可依 ⇒ 中文兜底（R22）
    return i18n.t('api', '绑定码无效或已被使用', 'zh');
  }
  const [userId, expires] = item;
  // 过期码知道码所属 user_id ⇒ 用该用户的偏好（可能在站点切过英文）
  const lang = userLang(userId, options);
  if (Date.now() / 1000 > expires) {
    return i18n.t('api', '绑定码已过期，请到站点重新生成', lang);
  }
  setFeishuBinding(openId, userId, 0, options);
  return null;
}

/**
 * 非普通对象的配置 ⇒ 同形抛（Python 在 `cfg.get`/`cfg[k]=` 上抛 AttributeError/TypeError）。
 * 由 `dispatchSafely` 收口成 `res.destroy()`（只断这一条连接）。理由见本节「已知分歧」。
 * @param {unknown} cfg
 * @returns {object}
 */
function requireCfgDict(cfg) {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    const name = cfg === null ? 'NoneType' : Array.isArray(cfg) ? 'list' : typeof cfg;
    throw new TypeError(`'${name}' object has no attribute 'get'`);
  }
  return cfg;
}

/**
 * 保存用户飞书配置并即时反馈（服务端设置页唯一写口）。
 * 对齐 `feishu.save_user_config`(feishu.py:3152-3174)。逐条照抄：
 *   ① `push_enabled` / `enabled` 两个开关：**带键才写**，值过 Python `bool()` 后落 1/0；
 *   ② 五个字符串键 `default_webhook`/`default_secret`/`base_url`/`app_id`/`app_secret`：
 *      **带键才写**（缺省=不改）、显式空串/假值=清除，值走 `str(v or "").strip()`；
 *   ③ 整对象覆盖落库（`db.set_feishu_user_cfg`，JSON 文本走 `pyJsonDumps`）；
 *   ④ 落库**之后**才 `startInboundFor`（幂等拉起入站长连接）；
 *   ⑤ `verify` 只在 `app_config(user_id)` 非 None（App ID + Secret **两件齐全**）时算，
 *      否则恒 `None`——即「凭据不全 ⇒ 零网络请求」。
 *
 * `verifyCredentials` 是 R5 冻结的凭据快检（`feishu_provision.js`，签名
 * `(userId, options={}) → Promise<{ok, detail}>`，**绝不抛出**）——本函数**真调**它；
 * 网络路径的用例不触发（会把 `app_id`/`app_secret` 同时写成真值才会走到）。
 * @param {number} userId
 * @param {object} body 请求体（**必是普通对象**：`server.py:_read_json` 已把非 dict 折成 `{}`）
 * @param {{db?: object, dbPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{inbound_started: boolean, verify: object|null}>}
 */
export async function saveUserConfig(userId, body, options = {}) {
  const cfg = requireCfgDict(userConfig(userId, options));
  // M11：换应用前后的凭据快照（自动「确认切换」卡片用旧应用凭据发，见函数尾）
  const oldCfg = { app_id: cfg.app_id || '', app_secret: cfg.app_secret || '' };
  // 推送总控（2026-10-10）：与旧 `enabled` 是两个独立开关，缺省=不改（不在 body 里就不动）
  if (Object.hasOwn(body, 'push_enabled')) cfg.push_enabled = pyTruthy(body.push_enabled) ? 1 : 0;
  if (Object.hasOwn(body, 'enabled')) cfg.enabled = pyTruthy(body.enabled) ? 1 : 0;
  for (const key of ['default_webhook', 'default_secret', 'base_url', 'app_id', 'app_secret']) {
    if (Object.hasOwn(body, key)) cfg[key] = pyStrip(pyStrOrEmpty(body[key]));
  }
  setFeishuUserCfg(userId, cfg, options);
  const started = startInboundFor(userId, options);
  const verify = appConfig(userId, options) ? await verifyCredentials(userId, options) : null;
  // M11：手工换应用（非扫码路径）同样发「确认切换」卡片——旧连接还活着时用旧应用通道
  // 通知用户点确认。后台发（不阻塞保存响应）；条件在 maybeSendSwitchCard 里复核，
  // 凭据没变/线程没跑时是零请求空转；自动卡片故障绝不反噬保存主流程。
  if (Object.hasOwn(body, 'app_id') || Object.hasOwn(body, 'app_secret')) {
    void maybeSendSwitchCard(userId, oldCfg, options).catch(() => {});
  }
  return { inbound_started: Boolean(started), verify };
}

/**
 * 入站长连接闸门 + 真拉起（`feishu.start_inbound_for`，feishu.py:1628-1645）。
 *
 * **M7.5-R2 接线（2026-10-15）**：M7 的占位实现（凭据齐全也回 `false`、不建线程）已由
 * `backend/lib/feishu_inbound.js:startInboundFor` 取代——本函数现在是**薄转发**，
 * 实现在入站车道那个文件里（线程句柄/`wsRun`/stderr 三行都在那儿）。
 * 语义照 oracle 的三段：① 注册表 `is_alive()` 幂等短路 → ② `app_config` 缺失 ⇒
 * 打逐字 stderr 行 + `false` → ③ 建「线程」、**先登记后 start**、回 `true`。
 * 末位 `options` 沿用本文件既有的注入约定（`db`/`dbPath`/`env`），并透传给入站实现
 * （那里还认 `clientClass`/`wsClient`/`now`/`log`/`rest`/`board`/`conv`/`slash`/`dbmod`）。
 *
 * ⚠与 M7 占位的行为差异（**调用方要重读**）：凭据齐全时现在回 `true` 并真的发起长连接，
 * 于是 `POST /api/me/feishu-cfg` 的 `inbound_started` 会随之为 `true`
 * （`backend/test/feishu-me-routes.test.mjs` 里钉住旧占位语义的两条用例因此失效，
 * 见 M7.5-R2 交付报告）。
 * @param {number} userId
 * @param {object} [options]
 * @returns {boolean} 是否真的拉起了**新**连接
 */
export function startInboundFor(userId, options = {}) {
  return inboundStartFor(userId, options);
}

/**
 * 服务启动遍历全部用户配置逐个拉起（`feishu.start_inbound_all`，feishu.py:1648-1656）。
 * 顺序 = `db.list_feishu_user_cfgs()` 的行序；返回**新**启动的连接数。
 * ⚠无 try/except ⇒ 任一用户抛异常即中断其余用户（半启动），与 oracle 同形。
 * @param {object} [options]
 * @returns {number}
 */
export function startInboundAll(options = {}) {
  return inboundStartAll(options);
}

// 本节新增的依赖（ESM import 声明提升，等价于置顶；放末尾以严守「只追加」的写作用域）
import { setFeishuBinding, setFeishuUserCfg } from './db.js';
import { inboundStatus, userConfig } from './feishu_cfg.js';
import { startInboundAll as inboundStartAll, maybeSendSwitchCard,
  startInboundFor as inboundStartFor } from './feishu_inbound.js';
import * as feishuConv from './feishu_conv.js';
import { verifyCredentials } from './feishu_provision.js';
