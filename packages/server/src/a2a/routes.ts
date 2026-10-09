/**
 * A2A v1.0 inbound — JSON-RPC binding (plans/a2a.md §5–7).
 *
 * Own thin handler, not the SDK's DefaultRequestHandler: task state here is
 * DERIVED from the halo session (reply_to cycle + the quiet gate in
 * deliverRelayReport), not owned by an executor / event bus, so a client
 * disconnect or a restart never strands a task. Mountable at any prefix with
 * pluggable strategies (exposure.ts) — `/a2a` + home-relative paths today.
 *
 *   POST <prefix>/<rel>[/]                         JSON-RPC
 *   GET  <prefix>/<rel>/.well-known/agent-card.json  card (same auth as RPC)
 */
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import crypto from 'node:crypto'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import type { SessionManager } from '../agents/session-manager.js'
import { readReplyTo, writeReplyTo, clearReplyTo, listActiveChildren, A2A_CHANNEL_PREFIX } from '../agents/relay.js'
import { resolveDefaultAgentId } from '../channels/shared/commands.js'
import { sessionAccess } from '../channels/shared/accounts.js'
import { sessionPrefix } from '../channels/shared/session-prefix.js'
import { checkUrl } from './url-policy.js'
import { parseMessageParts, fetchImageUrls, saveImage } from './files.js'
import { buildCard, etagOf, homeStrategies, type A2ACaller, type A2AStrategies } from './exposure.js'
import {
  BOOT_AT, createTask, findTaskByMessageId, getTask, touchTask, transition, onTaskEvent, statusUpdateJson,
  putPushConfig, listPushConfigs, getPushConfig, deletePushConfig, pushConfigJson, listTasks, parsePageToken, type TaskEvent,
} from './tasks.js'
import { A2A_VERSION, CARD_SUFFIX, RPC, RpcError, TERMINAL, rowState, rpcError, rpcResult, taskJson, type TaskRow } from './wire.js'

/** Card capability + gate for SendStreamingMessage / SubscribeToTask. */
const STREAMING = true
/** Bounded wait for a blocking SendMessage; past it the WORKING task is
 *  returned and the client continues with GetTask / SubscribeToTask
 *  (documented deviation from "MUST block", plans/a2a.md §7). */
const BLOCKING_WAIT_MS = 10 * 60_000
/** Fits a message's 10 MB of images (base64 ≈ 13.4 MB) plus its text. */
const MAX_BODY = 16 * 1024 * 1024
const SSE_KEEPALIVE_MS = 15_000

interface Ctx { c: Context; sm: SessionManager; workspace: string; caller: A2ACaller; ownsRuntimes: boolean }
type Params = Record<string, unknown>

function str(v: unknown): string { return typeof v === 'string' ? v : '' }

function sessionPrefixFor(caller: A2ACaller): string { return sessionPrefix('a2a', caller.accountId) }

/** A task is visible to its own account; a full token sees every A2A task of its workspace. */
function visibleTask(x: Ctx, id: string): TaskRow {
  const row = id ? getTask(id) : null
  if (!row || row.workspace !== x.workspace || (row.account_id !== x.caller.accountId && x.caller.accessLevel !== 'full')) {
    throw new RpcError(RPC.TASK_NOT_FOUND, `task not found: ${id}`)
  }
  return reconcileStale(x, row)
}

/**
 * Lazy FAILED for a task orphaned by a restart: WORKING, untouched since
 * before this process booted, and its session idle with a quiet subtree.
 * Only on a server that does NOT own workspace runtimes (dev): an owner's
 * boot sweep nudges interrupted roots itself (run ledger) and its resumed run
 * completes the task — failing it here could race that nudge.
 */
function reconcileStale(x: Pick<Ctx, 'sm' | 'ownsRuntimes'>, row: TaskRow): TaskRow {
  if (x.ownsRuntimes || row.state !== 'working' || row.updated_at >= BOOT_AT) return row
  const sid = row.context_id
  if (x.sm.isSessionRunning(sid) || x.sm.isSessionCompacting(sid) || x.sm.hasQueuedMessages(sid)) return row
  if (listActiveChildren(x.sm.getDb(), sid).length > 0) return row
  const failed = transition(row.id, 'failed', { statusText: 'Interrupted by a server restart on the remote. Send again on the same context to resume.' })
  if (failed) releaseReplyTo(x.sm, sid, row.id)
  return failed ?? getTask(row.id) ?? row
}

/** Drop the session's back-pointer if it still names this task (a newer
 *  task on the same context must keep its own). */
function releaseReplyTo(sm: SessionManager, sid: string, taskId: string): void {
  const to = readReplyTo(sm.getDb(), sid)
  if (to && 'a2a' in to && to.a2a === taskId) clearReplyTo(sm.getDb(), sid)
}

/** The live (WORKING) task a context's reply_to points at, if any. */
function liveTaskOf(x: Ctx, contextId: string): TaskRow | null {
  const to = readReplyTo(x.sm.getDb(), contextId)
  if (!to || !('a2a' in to)) return null
  const row = getTask(to.a2a)
  if (!row || row.state !== 'working') return null
  const fresh = reconcileStale(x, row)
  return fresh.state === 'working' ? fresh : null
}

type PushConfigInput = Parameters<typeof putPushConfig>[1]

/** Validate a push config (URL policy) without writing anything — callers
 *  validate before creating rows so a refusal can't strand a task. */
async function parsePushConfig(raw: unknown): Promise<PushConfigInput> {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Params
  const url = str(c.url)
  if (!url) throw new RpcError(RPC.INVALID_PARAMS, 'push config url required')
  const refused = await checkUrl(url)
  if (refused) throw new RpcError(RPC.INVALID_PARAMS, `push url not allowed: ${refused}`)
  const auth = c.authentication as Params | undefined
  return {
    id: str(c.id) || undefined,
    url,
    token: str(c.token) || undefined,
    authentication: auth ? { scheme: str(auth.scheme), credentials: str(auth.credentials) } : undefined,
  }
}

function isUniqueViolation(err: unknown): boolean {
  return String((err as { code?: unknown })?.code ?? '').startsWith('SQLITE_CONSTRAINT')
}

/** SendMessage / SendStreamingMessage routing (plans/a2a.md §6). Returns the
 *  task the message landed in; the session work is already under way. */
async function dispatchMessage(x: Ctx, p: Params): Promise<TaskRow> {
  const msg = (p.message ?? null) as Params | null
  if (!msg || typeof msg !== 'object') throw new RpcError(RPC.INVALID_PARAMS, 'message required')
  const role = str(msg.role)
  if (role && role !== 'ROLE_USER') throw new RpcError(RPC.INVALID_PARAMS, 'message.role must be ROLE_USER')
  const parsed = parseMessageParts(msg)
  const messageId = str(msg.messageId) || null
  const contextId = str(msg.contextId)
  const taskId = str(msg.taskId)
  const cfg = (p.configuration ?? {}) as Params
  const meta = (msg.metadata ?? p.metadata ?? {}) as Params
  const hard = meta['halo/interrupt'] === true
  const pushCfg = cfg.taskPushNotificationConfig

  // Validate first, so nothing below can refuse after a task exists.
  const push = pushCfg ? await parsePushConfig(pushCfg) : null

  // Retried send (same messageId) → same task, no second dispatch (and no
  // image fetch: the dedupe runs before any url part is downloaded).
  if (messageId) {
    const dup = findTaskByMessageId(x.workspace, x.caller.accountId, messageId)
    if (dup) return reconcileStale(x, dup)
  }

  if (contextId && !contextId.startsWith(sessionPrefixFor(x.caller))) {
    throw new RpcError(RPC.INVALID_PARAMS, `unknown contextId: ${contextId} (contexts are created by the agent; omit contextId to start one)`)
  }
  if (contextId && !x.sm.getSessionById(contextId)) throw new RpcError(RPC.INVALID_PARAMS, `unknown contextId: ${contextId}`)

  // Image parts resolved (url fetched, every image saved) before any task row:
  // a fetch / limit failure refuses the send with nothing created.
  const images = await fetchImageUrls(parsed.images)
  const saved = await Promise.all(images.map((img) => saveImage(x.workspace, x.caller.accountId, { buffer: img.buffer!, mediaType: img.mediaType, filename: img.filename })))
  const text = [parsed.text, ...saved.map((p) => `[图片已保存: ${p}]`)].filter(Boolean).join('\n')

  // Those awaits re-open the window the dedupe closed: from this lookup to
  // createTask the code is synchronous, so two concurrent sends with one
  // messageId can't interleave (the losing duplicate only leaves its saved files).
  if (messageId) {
    const dup = findTaskByMessageId(x.workspace, x.caller.accountId, messageId)
    if (dup) return reconcileStale(x, dup)
  }

  let sessionId = contextId
  let task: TaskRow | null = null
  if (taskId) {
    const row = visibleTask(x, taskId)
    if (contextId && row.context_id !== contextId) throw new RpcError(RPC.INVALID_PARAMS, 'taskId does not belong to contextId')
    if (TERMINAL.has(row.state)) throw new RpcError(RPC.UNSUPPORTED, `task ${taskId} is in a terminal state; send on its contextId without taskId to start a new task`)
    sessionId = row.context_id
    task = row
  } else if (sessionId) {
    task = liveTaskOf(x, sessionId)
  }

  const newSession = !sessionId
  if (newSession) sessionId = `${sessionPrefixFor(x.caller)}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`

  const followUp = task !== null
  if (!task) {
    try {
      task = createTask({ workspace: x.workspace, contextId: sessionId, accountId: x.caller.accountId, messageId })
    } catch (err) {
      // Backstop for the UNIQUE(workspace, account, messageId) index: the
      // section above is synchronous, so only a second writer could get here.
      const dup = messageId && isUniqueViolation(err) ? findTaskByMessageId(x.workspace, x.caller.accountId, messageId) : null
      if (!dup) throw err
      return reconcileStale(x, dup)
    }
  } else {
    touchTask(task.id)
  }
  const t = task

  try {
    if (newSession) {
      const agentId = await resolveDefaultAgentId(x.sm, x.workspace)
      await x.sm.createSession(agentId, null, `A2A: ${x.caller.label || x.caller.accountId}`, undefined, sessionId, undefined, sessionAccess(x.caller.accessLevel))
    }
    if (!followUp) writeReplyTo(x.sm.getDb(), sessionId, { a2a: t.id })
    if (push) putPushConfig(t.id, push)

    const prefixed = `${A2A_CHANNEL_PREFIX}account: ${x.caller.accountId}]\n\n${text}`
    x.sm.appendUserMessage(sessionId, text)
    const vision = images.map((img) => ({ data: img.buffer!.toString('base64'), mimeType: img.mediaType }))
    const state = await x.sm.sendUserMessage(sessionId, prefixed, vision.length ? vision : undefined, sessionAccess(x.caller.accessLevel))
    // Hard interrupt: enqueue first, then abort (relay_interrupt's order) so the
    // finally never sees an empty queue and fires a spurious completion.
    if (hard && state === 'queued') x.sm.interruptSession(sessionId)
    console.debug(`[A2A] ${x.caller.accountId} → ${x.workspace}/${sessionId} task ${t.id} (${followUp ? 'follow-up' : 'new'}, ${state}${hard ? ', hard' : ''})`)
  } catch (err) {
    // A task created here whose message never reached the session would stay
    // WORKING forever (and a messageId retry would dedupe onto it): fail it.
    // A follow-up's task belongs to the turn already running — leave it.
    if (!followUp) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.+$/, '')
      transition(t.id, 'failed', { statusText: `Dispatch failed on the remote: ${why}. Send again with a new messageId.` })
      releaseReplyTo(x.sm, sessionId, t.id)
    }
    throw err
  }
  return getTask(t.id) ?? t
}

/** Resolve when the task is terminal, or after `ms`, or when `signal` aborts. */
function waitTerminal(taskId: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); off(); signal.removeEventListener('abort', done); resolve() }
    const off = onTaskEvent(taskId, (e) => { if (e.kind === 'terminal') done() })
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done)
    const row = getTask(taskId)
    if (!row || TERMINAL.has(row.state)) done()
  })
}

async function sendMessage(x: Ctx, p: Params): Promise<unknown> {
  const task = await dispatchMessage(x, p)
  const cfg = (p.configuration ?? {}) as Params
  if (cfg.returnImmediately !== true && !TERMINAL.has(task.state)) {
    // The run continues whatever happens to this request: state lives in the
    // session + a2a.db, the waiter only decides when to answer.
    await waitTerminal(task.id, BLOCKING_WAIT_MS, x.c.req.raw.signal)
  }
  return { task: taskJson(getTask(task.id) ?? task) }
}

function cancelTask(x: Ctx, p: Params): unknown {
  const row = visibleTask(x, str(p.id))
  if (row.state === 'canceled') return taskJson(row)
  if (TERMINAL.has(row.state)) throw new RpcError(RPC.NOT_CANCELABLE, `task ${row.id} is already ${row.state}`)
  const canceled = transition(row.id, 'canceled', { statusText: 'Canceled by the caller.' })
  releaseReplyTo(x.sm, row.context_id, row.id)
  // Fire-and-forget: Cancel must not block on the turn unwinding.
  x.sm.stopSession(row.context_id).catch((err) => console.error(`[A2A] stop for cancel ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`))
  return taskJson(canceled ?? getTask(row.id)!)
}

function listTasksRpc(x: Ctx, p: Params): unknown {
  const pageSize = p.pageSize === undefined ? 50 : Number(p.pageSize)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RpcError(RPC.INVALID_PARAMS, 'pageSize must be 1..100')
  const token = str(p.pageToken)
  const cursor = token ? parsePageToken(token) : null
  if (token && !cursor) throw new RpcError(RPC.INVALID_PARAMS, 'invalid pageToken')
  let after: number | undefined
  if (p.statusTimestampAfter !== undefined) {
    after = Date.parse(str(p.statusTimestampAfter))
    if (Number.isNaN(after)) throw new RpcError(RPC.INVALID_PARAMS, 'statusTimestampAfter must be an ISO-8601 timestamp')
  }
  const state = p.status ? rowState(str(p.status)) : undefined
  if (p.status && !state && p.status !== 'TASK_STATE_UNSPECIFIED') throw new RpcError(RPC.INVALID_PARAMS, `unknown status ${String(p.status)}`)
  const include = p.includeArtifacts === true
  const res = listTasks({
    workspace: x.workspace,
    accountId: x.caller.accessLevel === 'full' ? null : x.caller.accountId,
    contextId: str(p.contextId) || undefined,
    state: state || undefined,
    after,
    withFileCounts: include,
  }, pageSize, cursor)
  // Never inline file bytes in a list (100 tasks × MBs): GetTask carries them.
  return { tasks: res.rows.map((r) => taskJson(reconcileStale(x, r), include, false)), nextPageToken: res.next, pageSize, totalSize: res.total }
}

async function createPushConfigRpc(x: Ctx, p: Params): Promise<unknown> {
  const row = visibleTask(x, str(p.taskId))
  if (TERMINAL.has(row.state)) throw new RpcError(RPC.UNSUPPORTED, `task ${row.id} is in a terminal state`)
  return pushConfigJson(putPushConfig(row.id, await parsePushConfig(p)))
}

const METHODS: Record<string, (x: Ctx, p: Params) => unknown> = {
  SendMessage: sendMessage,
  GetTask: (x, p) => taskJson(visibleTask(x, str(p.id))),
  ListTasks: listTasksRpc,
  CancelTask: cancelTask,
  CreateTaskPushNotificationConfig: createPushConfigRpc,
  GetTaskPushNotificationConfig: (x, p) => {
    const row = visibleTask(x, str(p.taskId))
    const cfg = getPushConfig(row.id, str(p.id))
    if (!cfg) throw new RpcError(RPC.TASK_NOT_FOUND, `push config not found: ${str(p.id)}`)
    return pushConfigJson(cfg)
  },
  ListTaskPushNotificationConfigs: (x, p) => ({ configs: listPushConfigs(visibleTask(x, str(p.taskId)).id).map(pushConfigJson), nextPageToken: '' }),
  DeleteTaskPushNotificationConfig: (x, p) => { deletePushConfig(visibleTask(x, str(p.taskId)).id, str(p.id)); return null },
  GetExtendedAgentCard: () => { throw new RpcError(RPC.UNSUPPORTED, 'extended agent card is not supported') },
}

/** SSE for SendStreamingMessage / SubscribeToTask: Task snapshot first, then
 *  interim status updates + `progress` text chunks, then the terminal Task
 *  (= GetTask) and close. A dropped client only unsubscribes. */
function streamTask(x: Ctx, id: unknown, start: () => Promise<TaskRow>): Response {
  return streamSSE(x.c, async (stream) => {
    const send = (result: unknown) => stream.writeSSE({ data: JSON.stringify(rpcResult(id, result)) })
    let task: TaskRow
    try { task = await start() } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(RPC.INTERNAL, err instanceof Error ? err.message : String(err))
      await stream.writeSSE({ data: JSON.stringify(rpcError(id, e.code, e.message)) })
      return
    }
    const queue: Array<TaskEvent | { kind: 'delta'; text: string }> = []
    let wake: (() => void) | null = null
    const push = (e: TaskEvent | { kind: 'delta'; text: string }) => { queue.push(e); wake?.() }
    const offTask = onTaskEvent(task.id, push)
    // Live text of the root's turns — a non-persisted `progress` artifact
    // (kept as-is by owner decision 2026-10-09, plans/a2a.md §14 #4). `result` stays the stored final text.
    const offDelta = x.sm.registerEventListener(task.context_id, (ev) => {
      if (ev.type === 'stream_delta' && !ev.taskId && ev.text) push({ kind: 'delta', text: ev.text })
    })
    const keepalive = setInterval(() => { void stream.write(': keepalive\n\n') }, SSE_KEEPALIVE_MS)
    stream.onAbort(() => { wake?.() })
    try {
      const first = getTask(task.id) ?? task
      await send({ task: taskJson(first) })
      if (TERMINAL.has(first.state)) return
      let progressStarted = false
      while (!stream.aborted) {
        if (queue.length === 0) await new Promise<void>((r) => { wake = r })
        wake = null
        while (queue.length > 0) {
          const e = queue.shift()!
          if (e.kind === 'delta') {
            await send({ artifactUpdate: { taskId: task.id, contextId: task.context_id, artifact: { artifactId: 'progress', name: 'progress', parts: [{ text: e.text }] }, append: progressStarted, lastChunk: false } })
            progressStarted = true
          } else if (e.kind === 'interim') {
            await send({ statusUpdate: statusUpdateJson(e.row, e.text) })
          } else {
            await send({ task: taskJson(e.row) })
            return
          }
        }
      }
    } finally {
      clearInterval(keepalive)
      offTask()
      offDelta()
    }
  })
}

export interface A2ARouteDeps {
  registry: SessionManagerRegistry
  strategies?: A2AStrategies
  ownsRuntimes: boolean
}

export function createA2ARoutes(deps: A2ARouteDeps): Hono {
  const strategies = deps.strategies ?? homeStrategies
  const app = new Hono()

  /** Mount-relative path → `rel` (+ whether it named the card). */
  function relOf(c: Context): { rel: string; card: boolean } {
    const routePath = c.req.routePath.replace(/\/\*$/, '')
    let raw = new URL(c.req.url).pathname.slice(routePath.length)
    raw = raw.replace(/^\/+/, '')
    const card = raw === CARD_SUFFIX || raw.endsWith(`/${CARD_SUFFIX}`)
    if (card) raw = raw.slice(0, raw.length - CARD_SUFFIX.length)
    return { rel: raw.replace(/\/+$/, ''), card }
  }

  app.get('/*', (c) => {
    const { rel, card } = relOf(c)
    if (!card) return c.json({ error: 'not found' }, 404)
    const auth = strategies.authenticate(c, rel)
    if (!auth.ok) return c.json({ error: auth.status === 401 ? 'token required' : auth.status === 429 ? 'too many failed attempts' : 'not found' }, auth.status)
    let body: string
    try {
      body = JSON.stringify(buildCard(auth.workspace, strategies.interfaceUrl(c, rel), { streaming: STREAMING, tokenAuth: strategies.tokenAuth }))
    } catch (err) {
      console.error(`[A2A] invalid agent-card.json in ${auth.workspace}: ${err instanceof Error ? err.message : String(err)}`)
      return c.json({ error: 'agent card unavailable' }, 500)
    }
    const etag = etagOf(body)
    c.header('Cache-Control', 'private, max-age=300')
    c.header('ETag', etag)
    if (c.req.header('if-none-match') === etag) return c.body(null, 304)
    return c.body(body, 200, { 'Content-Type': 'application/json' })
  })

  app.post('/*', async (c) => {
    const { rel, card } = relOf(c)
    if (card) return c.json({ error: 'not found' }, 404)
    const auth = strategies.authenticate(c, rel)
    if (!auth.ok) return c.json({ error: auth.status === 401 ? 'token required' : auth.status === 429 ? 'too many failed attempts' : 'not found' }, auth.status)

    const raw = await c.req.text()
    if (raw.length > MAX_BODY) return c.json(rpcError(null, RPC.INVALID_REQUEST, 'request too large'))
    let req: Params
    try { req = JSON.parse(raw) as Params } catch { return c.json(rpcError(null, RPC.PARSE, 'parse error')) }
    if (Array.isArray(req)) return c.json(rpcError(null, RPC.INVALID_REQUEST, 'batch requests are not supported'))
    const id = req?.id ?? null
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return c.json(rpcError(id, RPC.INVALID_REQUEST, 'invalid JSON-RPC request'))
    const version = c.req.header('a2a-version')?.trim()
    if (version !== A2A_VERSION) {
      return c.json(rpcError(id, RPC.VERSION, `A2A-Version ${version ? `"${version}"` : 'missing (treated as 0.3)'} is not supported; this agent speaks ${A2A_VERSION}`))
    }
    const params = (req.params && typeof req.params === 'object' ? req.params : {}) as Params

    let sm: SessionManager
    try { sm = deps.registry.getOrCreate(auth.workspace) } catch (err) {
      console.error(`[A2A] cannot open ${auth.workspace}: ${err instanceof Error ? err.message : String(err)}`)
      return c.json(rpcError(id, RPC.INTERNAL, 'workspace unavailable'))
    }
    const x: Ctx = { c, sm, workspace: auth.workspace, caller: auth.caller, ownsRuntimes: deps.ownsRuntimes }

    if (req.method === 'SendStreamingMessage' || req.method === 'SubscribeToTask') {
      if (!STREAMING) return c.json(rpcError(id, RPC.UNSUPPORTED, 'streaming is not supported'))
      if (req.method === 'SendStreamingMessage') return streamTask(x, id, () => dispatchMessage(x, params))
      try {
        const row = visibleTask(x, str(params.id))
        if (TERMINAL.has(row.state)) return c.json(rpcError(id, RPC.UNSUPPORTED, `task ${row.id} is in a terminal state`))
        return streamTask(x, id, async () => row)
      } catch (err) {
        const e = err as RpcError
        return c.json(rpcError(id, e.code ?? RPC.INTERNAL, e.message))
      }
    }

    const fn = METHODS[req.method]
    if (!fn) return c.json(rpcError(id, RPC.METHOD_NOT_FOUND, `method not found: ${req.method}`))
    try {
      return c.json(rpcResult(id, await fn(x, params)))
    } catch (err) {
      if (err instanceof RpcError) return c.json(rpcError(id, err.code, err.message))
      console.error(`[A2A] ${req.method} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      return c.json(rpcError(id, RPC.INTERNAL, 'internal error'))
    }
  })

  return app
}
