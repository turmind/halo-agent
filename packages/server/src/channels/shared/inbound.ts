/**
 * Shared inbound skeleton for the four IM channels (telegram / wechat /
 * slack / feishu).
 *
 * Before this module each channel handler carried its own copy of the same
 * ~200-line tail: get-or-create session → goal-route overlay → busy hint →
 * responder listener registration → appendUserMessage + sendUserMessage.
 * The copies drifted independently, which is exactly how two audited bugs
 * happened (audit A, 2026-08-06):
 *
 *   - A-M2: the wechat responder closure captured `fromUserId` at listener-
 *     registration time, so a session later driven by a different user (via
 *     full-access `/session switch`) kept replying to the FIRST user.
 *   - A-M5: the four command-dispatch sites ignored `CommandResult.startedTurn`
 *     — a skill command on a fresh session kicked the agent without any
 *     listener attached, and the reply was silently dropped.
 *
 * The structural fixes live here, not per channel:
 *
 *   - The **reply route** (where to send + per-message credentials like the
 *     wechat context token) is a per-session value refreshed on EVERY inbound
 *     message; responders read it lazily at send time via `bridge.getRoute`.
 *     A listener registered once can therefore never lock onto a stale
 *     destination. Route entries are dropped with their listener, so the map
 *     can't grow past the listener set (the `sessionContextTokens` leak).
 *   - `dispatchChannelCommand` wraps the shared `dispatchCommand` and, when
 *     the result says `startedTurn`, wires route + listener exactly like the
 *     plain-message path — no channel can forget it again.
 *
 * What stays channel-side (deliberately, these are real semantic differences,
 * not drift): message parsing, media download/ingest, slash-command gating
 * (slack `!cmd` alias + DM-only, feishu p2p-only, telegram bot.command
 * registration, wechat `/qr`), the send primitives (thread routing, passive
 * reply window), and post-command effects (workspace restart, wechat
 * switchTo listener migration).
 */
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import type { SessionManager } from '../../agents/session-manager.js'
import type { SessionManagerRegistry } from '../../agents/session-manager-registry.js'
import type { ChannelDb } from '../../db/channel-db.js'
import { resolveGoalRoute } from '../../agents/goal-mode.js'
import { claimWorkspaceRuntime } from '../../agents/workspace-runtime-lock.js'
import { rememberLastActiveChat, type AccountAccessLevel } from './accounts.js'
import {
  findActiveSessionId, dispatchCommand, resolveDefaultAgentId,
  type CommandContext, type CommandResult,
} from './commands.js'
import { busyHint } from './busy-hint.js'
import type { Lang } from './i18n.js'

/** Shape every channel's event-adapter responder already satisfies
 *  (TelegramResponder / WechatResponder / SlackResponder / FeishuResponder). */
export interface ChannelResponder {
  handle(event: AgentSessionEvent): void
  /** May return a promise that settles once every buffered chunk has been
   *  sent (slack / feishu / wechat serialize their sends — audit A-L3). The
   *  bridge keeps the reply route alive until it settles. */
  close(): void | Promise<void>
}

/** A route value, or an updater deriving the next route from the previous one
 *  (wechat uses this to keep a still-valid context token when a newer message
 *  arrives without one). `Route` must not itself be a function type. */
export type RouteInit<Route> = Route | ((prev: Route | undefined) => Route)

/**
 * Per-account bookkeeping for session event listeners and their reply routes.
 * Owned by the account runner/state so `stopAccount` can tear everything down
 * via `closeAll()`. One bridge per running account.
 */
export class InboundBridge<Route> {
  /** Channel name — used as the log prefix (`[telegram] …`) and the
   *  `[channel: X | user: Y]` agent-input tag. */
  readonly channel: string
  private makeResponder: (sessionId: string) => ChannelResponder
  private unsubscribers = new Map<string, () => void>()
  private routes = new Map<string, Route>()

  constructor(opts: { channel: string; makeResponder: (sessionId: string) => ChannelResponder }) {
    this.channel = opts.channel
    this.makeResponder = opts.makeResponder
  }

  /** Refresh the reply route for a session. Called on every inbound message
   *  BEFORE `ensureListener`, so a responder always sends to the latest
   *  origin (audit A-M2 — never lock the first user/chat in). */
  setRoute(sessionId: string, route: RouteInit<Route>): void {
    const next = typeof route === 'function'
      ? (route as (prev: Route | undefined) => Route)(this.routes.get(sessionId))
      : route
    this.routes.set(sessionId, next)
  }

  /** Read at send time by the channel's responder deps. `undefined` only when
   *  no message ever set a route (the responder should skip the send). */
  getRoute(sessionId: string): Route | undefined {
    return this.routes.get(sessionId)
  }

  /** Register the channel responder for a session exactly once. Subsequent
   *  calls are no-ops until the listener is dropped. */
  ensureListener(sm: SessionManager, sessionId: string): void {
    if (this.unsubscribers.has(sessionId)) return
    const responder = this.makeResponder(sessionId)
    const unsubscribe = sm.registerEventListener(sessionId, (event: AgentSessionEvent) => responder.handle(event))
    this.unsubscribers.set(sessionId, () => {
      // close() flushes the pending buffer — it must still see the route, so
      // the route entry is deleted after, not before. Slack/feishu/wechat send
      // their chunks serially and hand back a drain promise, so "after" means after
      // that settles; dropping the route synchronously would strand the tail
      // of a split reply with nowhere to send.
      const drained = responder.close()
      unsubscribe()
      if (drained) {
        drained
          .catch(() => { /* responders log their own send failures */ })
          .finally(() => this.routes.delete(sessionId))
      } else {
        this.routes.delete(sessionId)
      }
    })
  }

  /** Tear down one session's listener + route (wechat uses this when
   *  `/session switch` moves the conversation to another session). */
  dropListener(sessionId: string): void {
    const unsub = this.unsubscribers.get(sessionId)
    if (!unsub) return
    this.unsubscribers.delete(sessionId)
    unsub()
  }

  /** Tear down everything — stopAccount path. Each unsubscriber drops its own
   *  route once its responder has drained (see `ensureListener`), so there is
   *  deliberately no blanket `routes.clear()` here: it would delete the routes
   *  the still-in-flight sends are about to read. */
  closeAll(): void {
    const fns = [...this.unsubscribers.values()]
    this.unsubscribers.clear()
    for (const fn of fns) fn()
  }
}

/** Session-level access derived from the account level: full → null
 *  (unrestricted), observer collapses to readonly. */
function sessionAccess(accountAccessLevel: AccountAccessLevel): 'readonly' | 'workspace' | null {
  return accountAccessLevel === 'full' ? null : accountAccessLevel === 'workspace' ? 'workspace' : 'readonly'
}

/** Find the user's active session under this channel's prefix, or create one
 *  bound to the workspace's default agent. Same logic previously copied into
 *  all four handlers. */
async function getOrCreateChannelSession(args: {
  sm: SessionManager
  tagKey: string
  sessionPrefix: string
  activeOverrides: Map<string, string>
  accessLevel: 'readonly' | 'workspace' | null
  workspacePath: string
  sessionLabel: string
  setOverrideOnCreate: boolean
}): Promise<string> {
  const { sm, tagKey, sessionPrefix, activeOverrides, accessLevel, workspacePath, sessionLabel, setOverrideOnCreate } = args
  const existing = findActiveSessionId(sm, tagKey, sessionPrefix, activeOverrides, accessLevel === null ? 'full' : accessLevel)
  if (existing) return existing
  const newId = `${sessionPrefix}${Date.now().toString(36)}`
  // agentId resolved by priority (highest non-disabled, non-internal agent wins);
  // agentName omitted → createSession resolves the real agent.yaml `name`.
  const agentId = await resolveDefaultAgentId(sm, workspacePath)
  await sm.createSession(agentId, null, sessionLabel, undefined, newId, undefined, accessLevel)
  if (setOverrideOnCreate) activeOverrides.set(tagKey, newId)
  return newId
}

/**
 * The shared inbound tail: deliver one user message to the right session with
 * the responder listener guaranteed attached and the reply route refreshed.
 *
 * The busy hint is sent through the caller's channel-specific primitive and
 * is a hint ONLY — delivery continues unconditionally (`sendUserMessage`
 * queues compacting/busy sessions itself; see busy-hint.ts for the history).
 *
 * Returns the (goal-routed) session id the message went to.
 */
export async function deliverInbound<Route>(args: {
  sm: SessionManager
  db: ChannelDb
  accountId: string
  bridge: InboundBridge<Route>
  /** Chat key cached on the account row for cron delivery (channel format). */
  chatKey: string
  /** Key into activeOverrides — the channel's per-user (tg/wx) or
   *  per-user-per-thread (slack/feishu) identity. */
  tagKey: string
  sessionPrefix: string
  activeOverrides: Map<string, string>
  accountAccessLevel: AccountAccessLevel
  workspacePath: string
  /** Description for a newly created session, e.g. `Telegram: 42`. */
  sessionLabel: string
  /** slack/feishu pin the fresh session as the thread's active override;
   *  tg/wx rely on latest-by-prefix. */
  setOverrideOnCreate?: boolean
  /** Reply route for this session as of THIS message (audit A-M2). */
  route: RouteInit<Route>
  lang: Lang
  sendHint: (text: string) => Promise<void>
  /** Text for the UI log (clean, no channel tag). */
  uiText: string
  /** Text the agent sees (channel tag is prepended here). Differs from
   *  `uiText` only for wechat's image-only placeholder. */
  agentText: string
  /** `user:` value in the agent-input tag (display id, not tagKey). */
  userTag: string
  /** Optional `thread:` value in the agent-input tag (slack/feishu). */
  threadTag?: string
  images?: Array<{ data: string; mimeType: string }>
}): Promise<string> {
  const {
    sm, db, accountId, bridge, chatKey, tagKey, sessionPrefix, activeOverrides,
    accountAccessLevel, workspacePath, sessionLabel, setOverrideOnCreate = false,
    route, lang, sendHint, uiText, agentText, userTag, threadTag, images,
  } = args

  // Cache the most-recent chat id on the account so cron jobs targeting this
  // account know where to deliver. Cheap config patch — only writes when the
  // value actually changed.
  rememberLastActiveChat(db, accountId, chatKey)

  const accessLevel = sessionAccess(accountAccessLevel)
  // Goal-mode overlay: a goal-bound worker's inbound chat diverts to its goal
  // session (the binding rows above are untouched — see docs/plans/loop-mode.md).
  const sessionId = resolveGoalRoute(sm.getDb(), await getOrCreateChannelSession({
    sm, tagKey, sessionPrefix, activeOverrides, accessLevel, workspacePath, sessionLabel, setOverrideOnCreate,
  }))

  // Hint only — the message is delivered either way (sendUserMessage queues a
  // compacting/busy session).
  const hint = busyHint(sm, sessionId, lang)
  if (hint) await sendHint(hint)

  bridge.setRoute(sessionId, route)
  bridge.ensureListener(sm, sessionId)

  const agentInput = `[channel: ${bridge.channel} | user: ${userTag}${threadTag ? ` | thread: ${threadTag}` : ''}]\n${agentText}`
  sm.appendUserMessage(sessionId, uiText)
  sm.sendUserMessage(sessionId, agentInput, images?.length ? images : undefined, accessLevel).catch((err) => {
    console.log(`[${bridge.channel}] sendUserMessage ${sessionId}: ${String(err)}`)
  })
  return sessionId
}

/**
 * Account-start counterpart of the route + listener wiring in `deliverInbound`.
 *
 * Routes and listeners live only in this process and were only ever created
 * by an inbound message, so after a server restart a session that resumes on
 * its own (run-ledger restart nudge, queued turn, admin-typed message) had no
 * listener: its replies fell through to the global handler and never reached
 * the chat until the user wrote again. Channels call this from `startAccount`
 * with the destination persisted on the account row; it re-wires the user's
 * latest existing root session (goal-routed, like inbound) and never creates
 * one. Returns the wired session id, or null when there is nothing to restore.
 */
export function restoreChannelRoute<Route>(args: {
  registry: SessionManagerRegistry
  /** Already resolved via `resolveAccountWorkspace` (exists, `.halo/` in place). */
  workspacePath: string
  bridge: InboundBridge<Route>
  sessionPrefix: string
  route: RouteInit<Route>
}): string | null {
  const { registry, workspacePath, bridge, sessionPrefix, route } = args
  // Boot-time first touch: same ownership gate as the run-ledger eager sweep
  // in index.ts — building the SessionManager of a workspace another live
  // process owns would cache a non-owner manager for this process lifetime.
  const sm = registry.peek(workspacePath)
    ?? (claimWorkspaceRuntime(workspacePath) ? registry.getOrCreate(workspacePath) : undefined)
  if (!sm) {
    console.warn(`[${bridge.channel}] reply route not restored for ${sessionPrefix}*: ${workspacePath} runtime is owned by another live process (.halo/runtime.lock)`)
    return null
  }
  const latest = sm.findLatestByPrefix(sessionPrefix)
  if (!latest) return null
  const sessionId = resolveGoalRoute(sm.getDb(), latest.id)
  bridge.setRoute(sessionId, route)
  bridge.ensureListener(sm, sessionId)
  return sessionId
}

/**
 * `dispatchCommand` + the startedTurn contract the IM channels used to drop
 * (audit A-M5): when a skill command kicks an agent turn, wire the reply
 * route + responder listener exactly like the plain-message path, so the
 * skill body's response reaches the user even when the session never saw a
 * regular message before. Wiring happens right after dispatch returns — the
 * responders buffer-and-flush on `complete`, so the same-tick gap is the
 * same one the web channel's SSE path already accepts.
 *
 * `route` may be undefined when the channel can't build a reply route for
 * this invocation (defensive — all current call sites can); the turn still
 * runs, we just log instead of wiring a responder that could never send.
 */
export async function dispatchChannelCommand<Route>(
  ctx: CommandContext,
  command: string,
  arg: string,
  opts: {
    bridge: InboundBridge<Route>
    route: RouteInit<Route> | undefined
    channelName: string
    extraHelpLines?: Array<string | { head: string; desc: string }>
  },
): Promise<CommandResult | null> {
  const { bridge, route, channelName, extraHelpLines } = opts
  const result = await dispatchCommand(ctx, command, arg, { channelName, extraHelpLines })
  if (result?.startedTurn && result.sessionId) {
    if (route !== undefined) {
      bridge.setRoute(result.sessionId, route)
      bridge.ensureListener(ctx.sm, result.sessionId)
    } else {
      console.log(`[${bridge.channel}] startedTurn on ${result.sessionId} but no reply route — skill output will not reach the user`)
    }
  }
  return result
}
