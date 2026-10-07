// dsh-autocommit: 把 kimi-code 的 session_autocommit hook 移植为 DSH 原生 Cordis 插件。
//
// 与 kimi hook 的触发点对应关系（kimi 事件 → DSH 扩展点）：
//   Stop                   → agent/turn-stopping（serial，靠 agent.steer() 强制再跑一步）
//   PreToolUse(让行工具)     → tools/pre-execute（返回 {kind:'deny', reason}）
//   PermissionRequest      → approval/request（DSH 侧是真瀑布，可决策；kimi 侧即发即忘）
//   SubagentStart/Stop     → 不用事件追踪：agent.session.header 的 origin/delegationDepth
//                            已能判定子代理回合，省掉 kimi 的 flock 状态文件 + 3h TTL
//   读 wire.jsonl 算改动文件 → session/event 在线累积 tool/call（进程内，不碰会话日志格式）
//
// 判定算法与 kimi 保持一致：「本会话写类工具碰过的文件」∩「git status 脏路径」，
// 宁可漏、不可错（bash 的间接产物识别不了，属已知边界，不会被提交）。
// 安全阀沿用同名 env / 标记文件；日志单独一份 session_autocommit.dsh.log，便于与
// kimi 侧日志区分。
//
// 设计约束：
//   - 任何监听器都必须自己吞异常（插件跑在 harness 进程内，抛出去会打断当前工具调用/回合）。
//   - 不做任何 unasked 的写操作：默认只「挡 + 提示模型去提交」；自行提交仅在
//     commitOnApproval=true（默认 false）时发生，且只在审批弹窗路径上。

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, dirname, join, relative, resolve, sep } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-autocommit'
export const inject = ['sessionProjections']

/** 会话钩子根目录（与 kimi 侧同一目录，标记文件/日志同源）。 */
const HOOKS_DIR = join(homedir(), '.kimi-code', 'hooks')
const GLOBAL_OFF_MARKER = join(HOOKS_DIR, 'session_autocommit.off')
const DRY_RUN_MARKER = join(HOOKS_DIR, 'session_autocommit.dryrun')
const REPO_OFF_MARKER = '.kimi-autocommit-off'
const DEFAULT_LOG = join(HOOKS_DIR, 'logs', 'session_autocommit.dsh.log')

/** 写类工具名子串特征与 args 中的路径键（与 kimi 的 WRITE_TOOL_HINTS/WRITE_ARG_KEYS 同口径）。 */
const WRITE_TOOL_HINTS = ['edit', 'write', 'replace', 'create', 'rename', 'delete',
  'move', 'patch', 'insert', 'append', 'update']
const WRITE_ARG_KEYS = ['file_path', 'path', 'file', 'filename', 'old_path',
  'new_path', 'old_file', 'new_file']
/** DSH 的让行工具（对应 kimi 的 AskUserQuestion / ExitPlanMode）。 */
const ASK_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])

const GIT_TIMEOUT_MS = 20_000
const MAX_MESSAGE_FILES = 20
const TITLE_MAX = 60
const DEFAULT_TITLE = '(未命名会话)'

/** 读取配置并填默认值；config 来自 profile patch 的条目。 */
function normalizeConfig(raw) {
  const c = raw ?? {}
  return {
    enabled: c.enabled !== false,
    dryRun: c.dryRun === true,
    commitOnApproval: c.commitOnApproval === true,
    maxBlocks: Number.isInteger(c.maxBlocks) && c.maxBlocks > 0 ? c.maxBlocks : 2,
    blockWindowMs: Number.isInteger(c.blockWindowMs) && c.blockWindowMs > 0 ? c.blockWindowMs : 900_000,
    logPath: typeof c.logPath === 'string' && c.logPath.length > 0 ? c.logPath : DEFAULT_LOG,
  }
}

/** 追加一行审计日志；日志不可写时静默（不因日志失败影响主流程）。 */
function logLine(logPath, ...parts) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19)
    appendFileSync(logPath, `${stamp} | ${parts.map((p) => String(p)).join(' | ')}\n`, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 环境变量按真值语义判断（1/true/yes/on）。 */
function envFlag(names) {
  for (const n of names) {
    const v = String(process.env[n] ?? '').trim().toLowerCase()
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  }
  return false
}

/** 环境变量按假值语义判断（0/false/no/off）。 */
function envOff(names) {
  for (const n of names) {
    const v = String(process.env[n] ?? '').trim().toLowerCase()
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return true
  }
  return false
}

/** 在指定目录执行一条 git 命令；异常/超时返回 {code:null, out:''}。 */
function git(repo, args) {
  return new Promise((done) => {
    execFile('git', ['-C', repo, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 << 20 },
      (err, stdout) => {
        if (err) {
          done({ code: typeof err.code === 'number' ? err.code : null, out: String(stdout ?? '') })
          return
        }
        done({ code: 0, out: String(stdout ?? '') })
      })
  })
}

/** cwd 所在 git 仓库根（绝对路径）；非仓库/异常返回 undefined。 */
async function repoRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const { code, out } = await git(cwd, ['rev-parse', '--show-toplevel'])
  const root = out.trim()
  return code === 0 && root.length > 0 ? root : undefined
}

/** 仓库当前未提交改动涉及的路径集合（仓库相对路径）。 */
async function dirtyPaths(repo) {
  const { code, out } = await git(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain'])
  if (code !== 0) return new Set()
  const paths = new Set()
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    let p = line.slice(3)
    if (p.includes(' -> ')) p = p.slice(p.lastIndexOf(' -> ') + 4)
    p = p.trim()
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
    }
    if (p.length > 0) paths.add(p)
  }
  return paths
}

/** merge/rebase/cherry-pick 进行中返回 true（此时不提交，避免把冲突态当改动）。 */
async function gitInProgress(repo) {
  const { code, out } = await git(repo, ['rev-parse', '--git-dir'])
  if (code !== 0) return false
  const raw = out.trim()
  const dir = isAbsolute(raw) ? raw : resolve(repo, raw)
  return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']
    .some((n) => existsSync(join(dir, n)))
}

/** 把候选路径归一化为仓库相对路径（'/' 分隔）；不在仓库内/异常返回 undefined。 */
function normRepoPath(p, cwd, root) {
  try {
    const abs = resolve(isAbsolute(p) ? p : join(cwd, p))
    const rel = relative(root, abs)
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
    return rel.split(sep).join('/')
  } catch {
    return undefined
  }
}

/** 工具名是否写类（子串匹配，与 kimi 同口径）。 */
function isWriteTool(toolName) {
  const n = String(toolName ?? '').toLowerCase()
  if (n.length === 0) return false
  return WRITE_TOOL_HINTS.some((h) => n.includes(h))
}

/** 从工具参数里取候选路径（best-effort，可能是相对路径）。 */
function pathsFromArgs(args) {
  const out = []
  if (typeof args !== 'object' || args === null) return out
  for (const key of WRITE_ARG_KEYS) {
    const v = args[key]
    if (typeof v === 'string' && v.trim().length > 0) out.push(v.trim())
  }
  return out
}

/** 会话短标记：DSH 的 id 形如 session-<uuid>，kimi 的形如 session_<uuid>，两种前缀都剥掉。 */
function shortId(sessionId) {
  let i = String(sessionId ?? '').replace(/^session[-_]/, '')
  i = i.replace(/[^0-9A-Za-z]/g, '')
  if (i.length < 6) return '--AGENT-- '
  return `--${i.slice(0, 6).toUpperCase()}-- `
}

/** 提交消息用的标题清洗：去换行/引号/反引号/$，压缩空白并截断。 */
function cleanTitle(title) {
  const t = String(title ?? DEFAULT_TITLE).replace(/[\n\r]/g, ' ')
    .replaceAll('"', "'").replaceAll('`', '').replaceAll('$', '')
  const squeezed = t.split(/\s+/).filter(Boolean).join(' ')
  return squeezed.length > 0 ? squeezed.slice(0, TITLE_MAX) : DEFAULT_TITLE
}

/** 阻断消息里的文件缩略清单。 */
function fileLines(files) {
  const shown = files.slice(0, MAX_MESSAGE_FILES).map((f) => `  - ${f}`).join('\n')
  return files.length > MAX_MESSAGE_FILES ? `${shown}\n  ...（共 ${files.length} 个）` : shown
}

/** 构造交模型提交的提示（自包含、可执行，与 kimi 的 advise_reason 同义）。 */
function buildReason({ event, tool, files, prefix, title }) {
  const head = `[自动检查点] 本次会话还有 ${files.length} 个文件未提交：\n${fileLines(files)}\n`
  const how = `逐文件 \`git add -- <路径>\`（禁止 \`git add -A\`/\`.\`/\`-u\`），`
    + `提交消息首行用 "${prefix}<一句话摘要>"，正文一行 "session: (${title})"；`
    + `只提交本次会话改动的文件，不要动工作区中其他未提交改动。`
  return event === 'stop'
    ? `${head}请先提交这些文件再结束回合：${how}提交完成后即可正常结束。`
    : `${head}请先提交这些文件，然后重新调用 ${tool || '该工具'} 提出同一个问题：${how}`
}

/** 逐文件显式暂存 + 提交（仅供 approval 路径的可选自提交使用）。 */
async function commitFiles(repo, files, prefix, title, event) {
  const add = await git(repo, ['add', '--', ...files])
  if (add.code !== 0) return { ok: false, detail: `add-failed rc=${add.code}` }
  const subject = `${prefix}chore(checkpoint): ${title}`
  const commit = await git(repo, ['commit', '-m', subject, '-m', `session: (${title})`, '-m', `auto-checkpoint: ${event}`])
  if (commit.code !== 0) return { ok: false, detail: `commit-failed rc=${commit.code}` }
  const head = await git(repo, ['rev-parse', '--short', 'HEAD'])
  return { ok: true, detail: head.out.trim() || '?' }
}

/**
 * 判断某个 agent 的会话是否为子代理回合。
 * DSH 的 SessionHeader 带 origin/delegationDepth，不必像 kimi 那样靠 SubagentStart/Stop
 * 维护「活跃子代理集合」+ TTL（子代理产物由主回合的检查点统一提交）。
 */
function isChildSession(agent) {
  const header = agent?.session?.header
  if (header === undefined) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const isDryRun = () => config.dryRun || envFlag(['DSH_AUTOCOMMIT_DRY_RUN', 'KIMI_AUTOCOMMIT_DRY_RUN']) || existsSync(DRY_RUN_MARKER)
  const isDisabled = () => !config.enabled || envOff(['DSH_AUTOCOMMIT', 'KIMI_AUTOCOMMIT']) || existsSync(GLOBAL_OFF_MARKER)
  const log = (...parts) => logLine(config.logPath, ...parts)

  /** sessionId → Set<绝对路径>：本会话写类工具碰过的文件（在线累积，替代 wire.jsonl 挖掘）。 */
  const touched = new Map()
  /** sessionId → { event → { hash, count, time } }：防循环计数（进程内，替代状态文件）。 */
  const blocks = new Map()

  log('plugin-loaded', `dryRun=${isDryRun()}`, `enabled=${config.enabled}`)

  // ① 在线累积写类工具触碰的文件；子代理会话的事件也会到达这里，其产物并入主回合检查点。
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'tool/call') return
      const data = event.data ?? {}
      if (!isWriteTool(data.name)) return
      let args
      try { args = JSON.parse(data.arguments ?? '{}') } catch { return }
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string') return
      let set = touched.get(session.id)
      if (set === undefined) { set = new Set(); touched.set(session.id, set) }
      for (const p of pathsFromArgs(args)) {
        const abs = isAbsolute(p) ? p : resolve(cwd, p)
        if (set.size < 5000) set.add(abs)
      }
    } catch (error) {
      log('error:session-event', String(error))
    }
  })

  // 会话销毁时回收内存（长跑进程里会话多了不至于无限涨）。
  ctx.on('session/disposed', (session) => {
    touched.delete(session?.id)
    blocks.delete(session?.id)
  })

  /**
   * 检查点：算出「本会话改动 ∩ git 脏路径」，需要时返回提示信息。
   * @returns {Promise<{files:string[], reason:string, prefix:string, title:string, root:string}|undefined>}
   */
  async function checkpoint(agent, event, tool) {
    try {
      const session = agent?.session
      if (session === undefined) return undefined
      if (isChildSession(agent)) { log(event, session.id, 'skip:subagent-turn'); return undefined }
      const seen = touched.get(session.id)
      if (seen === undefined || seen.size === 0) return undefined
      const cwd = session.header?.cwd
      const root = await repoRoot(cwd)
      if (root === undefined) return undefined
      if (isDisabled()) { log(event, session.id, root, 'disabled'); return undefined }
      if (existsSync(join(root, REPO_OFF_MARKER))) { log(event, session.id, root, 'disabled:repo-marker'); return undefined }
      const dirty = await dirtyPaths(root)
      if (dirty.size === 0) return undefined
      if (await gitInProgress(root)) { log(event, session.id, root, 'skip:git-in-progress'); return undefined }
      const files = []
      for (const abs of seen) {
        const rel = normRepoPath(abs, cwd, root)
        if (rel !== undefined && dirty.has(rel)) files.push(rel)
      }
      files.sort()
      if (files.length === 0) { log(event, session.id, root, 'skip:no-session-files', `dirty=${dirty.size}`); return undefined }
      const title = cleanTitle(ctx.sessionProjections?.stateOf(session, 'title'))
      const prefix = shortId(session.id)
      if (isDryRun()) {
        log(event, session.id, root, 'dry-run', `files=${files.length}`, files.slice(0, 5).join(','))
        return undefined
      }
      if (!allowBlock(session.id, event, files)) {
        log(event, session.id, root, 'loop-guard-allow', `files=${files.length}`)
        return undefined
      }
      log(event, session.id, root, 'block', `files=${files.length}`, files.slice(0, 5).join(','))
      return { files, reason: buildReason({ event, tool, files, prefix, title }), prefix, title, root }
    } catch (error) {
      log(event, 'error:checkpoint', String(error))
      return undefined
    }
  }

  /** 防循环：同一（事件, 文件集合）在窗口内最多阻断 maxBlocks 次。 */
  function allowBlock(sessionId, event, files) {
    const now = Date.now()
    const hash = files.join('\n')
    let byEvent = blocks.get(sessionId)
    if (byEvent === undefined) { byEvent = new Map(); blocks.set(sessionId, byEvent) }
    const rec = byEvent.get(event)
    const same = rec !== undefined && rec.hash === hash && now - rec.time < config.blockWindowMs
    const count = same ? rec.count + 1 : 1
    byEvent.set(event, { hash, count, time: now })
    return count <= config.maxBlocks
  }

  // ② Stop 等价物：有未提交的本次会话改动 → steer 一步，让模型先提交再结束。
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const hit = await checkpoint(agent, 'stop', undefined)
    if (hit === undefined) return
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: hit.reason }],
      source: { kind: 'dsh-autocommit' },
    }))
  })

  // ③ PreToolUse 等价物：让行工具（提问 / 退出计划）前先提交，否则拒绝该工具调用。
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!ASK_TOOLS.has(exec.name)) return next()
      const hit = await checkpoint(exec.agent, 'pretool', exec.name)
      if (hit === undefined) return next()
      return { kind: 'deny', reason: hit.reason }
    } catch (error) {
      log('pretool', 'error', String(error))
      return next()
    }
  })

  // ④ PermissionRequest 等价物：DSH 侧是真瀑布。默认只放行（不干扰审批）；
  //    开启 commitOnApproval 时按 kimi 的原语义由插件自行提交（此时模型正卡在弹窗上）。
  ctx.on('approval/request', async (req, next) => {
    try {
      if (!config.commitOnApproval || req?.agent === undefined) return next()
      const hit = await checkpoint(req.agent, 'approval', req.toolName)
      if (hit === undefined) return next()
      const result = await commitFiles(hit.root, hit.files, hit.prefix, hit.title, 'approval')
      log('approval', req.agent.session?.id, hit.root, result.ok ? 'committed' : 'commit-failed', result.detail)
    } catch (error) {
      log('approval', 'error', String(error))
    }
    return next()
  })
}
