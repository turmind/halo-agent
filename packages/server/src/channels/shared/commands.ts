import fs from 'node:fs'
import path from 'node:path'
import type { SessionManager } from '../../agents/session-manager.js'
import { scanAvailableAgents } from '../../agents/agent-loader.js'
import { ensureWorkspaceHalo } from '../../init.js'
import { getDisabledSet } from '../../db/index.js'
import { t, type Lang } from './i18n.js'
import { execSkillCommand } from '../../commands/skill-command.js'
import { commandRegistry } from '../../commands/index.js'
import { config } from '../../config.js'
import { enqueueEvoRun } from '../../evolution/enqueue.js'

export interface CommandContext {
  sm: SessionManager
  userId: string
  sessionPrefix: string
  accessLevel: 'full' | 'workspace' | 'readonly'
  channelLabel: string
  activeOverrides: Map<string, string>
  workspacePath: string
  lang: Lang
  /** Structured channel origin — used by skills (e.g. cron) to know "I was
   *  invoked from inside this chat, default targets/recipients accordingly".
   *  Absent for admin / WS / CLI invocations. */
  channel?: ChannelContext
}

export interface ChannelContext {
  /** 'telegram' | 'wechat' | 'web' | future. */
  type: string
  /** Account id (telegram bot account, wechat ilink account). */
  accountId: string
  /** Chat id of the conversation the user is in: telegram chat id, wechat
   *  openId. Absent when the channel doesn't have a per-conversation id
   *  (e.g. SSE web). */
  chatId?: string
}

export interface CommandResult {
  text: string
  switchTo?: string
  workspace?: { path: string }
  /** True when the command kicked the agent (sent a user message under
   *  the hood — currently only `execSkillCommand`). The channel handler
   *  should keep its event stream open and forward agent events until
   *  the next `complete`, otherwise the skill body's response is dropped
   *  and the session ends up busy from the user's POV. */
  startedTurn?: boolean
  /** When `startedTurn` is true, the session id the agent is running on.
   *  Channels use this to subscribe to the right session. */
  sessionId?: string
}

export function findActiveSessionId(
  sm: SessionManager,
  userId: string,
  sessionPrefix: string,
  activeOverrides: Map<string, string>,
  accessLevel?: 'full' | 'workspace' | 'readonly',
): string | null {
  const override = activeOverrides.get(userId)

  // Full-access users can switch to any session (cross-channel). The
  // override might point at a session belonging to a different channel,
  // so we resolve it via direct id lookup rather than the prefix-scoped
  // path below.
  if (override && accessLevel === 'full') {
    if (sm.getSessionById(override)) return override
    activeOverrides.delete(userId)
    return null
  }

  // Channel-scoped path. The override (if any) must live under this
  // channel's prefix to be honored; otherwise fall back to "latest in
  // prefix" which is a single indexed query, not a full-table scan.
  if (override && override.startsWith(sessionPrefix)) {
    if (sm.getSessionById(override)) return override
    activeOverrides.delete(userId)
  }

  const latest = sm.findLatestByPrefix(sessionPrefix)
  if (!latest) {
    activeOverrides.delete(userId)
    return null
  }
  return latest.id
}

export async function execHelp(ctx: CommandContext, extraCommands?: Array<string | { head: string; desc: string }>): Promise<CommandResult> {
  // Single source of truth: builtin descriptors + skill descriptors scoped to
  // the *active session's agent* (mirrors `/api/commands?sessionId=...`).
  // Without this, channels like WeChat / Telegram never see skill commands —
  // the registry only ever holds builtins until someone hits the REST route.
  const builtins = commandRegistry.listDescriptors().filter((d) => {
    if (d.source === 'skill') return false
    // Client-side commands (e.g. `/clear` — the admin UI clears the chat
    // pane locally) have no server handler. Channels other than the
    // admin browser would just route them to dispatchCommand, get a
    // cmd.unknown back, and confuse the user. Hide them from /help.
    if (d.type === 'client') return false
    // /note only shows when self-evolution is on and the user can actually
    // trigger it. Keeps the help list relevant to the channel's permissions.
    if (d.name === 'note') {
      if (config.evolution.level !== 'L1') return false
      if (ctx.accessLevel === 'readonly') return false
    }
    return true
  })
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  // Use the channel account's *current* accessLevel (ctx.accessLevel),
  // not whatever was persisted on the session row when it was first
  // created. Without this, raising a channel from readonly → workspace
  // in the admin UI wouldn't take effect for `/help` until the next time
  // a real chat message updated the row — confusingly hiding skills the
  // user just gave themselves permission for.
  const skills = active
    ? await ctx.sm.listAvailableSkillCommandsForAgent(
        ctx.sm.getSessionById(active)?.agentId ?? 'default',
        ctx.accessLevel,
      )
    : []

  // Two-pass render so descriptions align: first compute each command's
  // "head" (slashName + argHint), then pad to the longest head before
  // appending the description.
  const rows: Array<{ head: string; desc: string }> = [...builtins, ...skills]
    .sort((a, b) => a.slashName.localeCompare(b.slashName))
    .map((d) => {
      const arg = d.argHint ? ` ${d.argHint}` : ''
      const showArg = d.name === 'ws' && ctx.accessLevel !== 'full' ? '' : arg
      // Builtin descriptions live in i18n under `cmd.<name>`; skills keep
      // their SKILL.md description (currently English-only). A few commands
      // have access-level-aware variants (e.g. /ws is read-only without
      // `full`) — fall through to the generic key when no variant exists.
      let desc: string
      if (d.source === 'builtin') {
        const variantKey = ctx.accessLevel !== 'full' ? `cmd.${d.name}.readonly` : ''
        const variant = variantKey ? t(variantKey, ctx.lang) : variantKey
        const generic = t(`cmd.${d.name}`, ctx.lang)
        desc = (variant && variant !== variantKey) ? variant : (generic !== `cmd.${d.name}` ? generic : d.description)
      } else {
        desc = d.description
      }
      return { head: `${d.slashName}${showArg}`, desc }
    })

  // Accept channel-specific extras as either pre-formatted strings (legacy)
  // or {head, desc} pairs (new — joins the alignment grid below).
  for (const extra of extraCommands ?? []) {
    if (typeof extra === 'string') {
      // Best-effort split on " — " (em-dash with spaces) so legacy strings
      // still align. If the separator isn't there, fall back to a no-desc row.
      const idx = extra.indexOf(' — ')
      if (idx >= 0) rows.push({ head: extra.slice(0, idx).trim(), desc: extra.slice(idx + 3).trim() })
      else rows.push({ head: extra.trim(), desc: '' })
    } else {
      rows.push(extra)
    }
  }

  const headWidth = Math.max(...rows.map((r) => r.head.length), 0)
  const items = rows.map((r) => r.desc ? `  ${r.head.padEnd(headWidth)}  ${r.desc}` : `  ${r.head}`)

  return { text: [t('help.title', ctx.lang), ...items].join('\n') }
}

export function execStop(ctx: CommandContext): CommandResult {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('stop.no_session', ctx.lang) }
  if (!ctx.sm.isSessionRunning(active)) return { text: t('stop.already_idle', ctx.lang) }
  ctx.sm.stopSession(active).catch(() => {})
  return { text: t('stop.done', ctx.lang) }
}

export function execInterrupt(ctx: CommandContext): CommandResult {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('interrupt.no_session', ctx.lang) }
  if (!ctx.sm.isSessionRunning(active)) return { text: t('interrupt.already_idle', ctx.lang) }
  // Abort the in-flight turn now (including a command mid-run); the server
  // then folds any messages queued while busy into one follow-up turn. Unlike
  // /stop, this re-runs rather than ending the session.
  ctx.sm.interruptSession(active)
  return { text: t('interrupt.done', ctx.lang) }
}

export function execCompact(ctx: CommandContext, logPrefix: string): CommandResult {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('compact.no_session', ctx.lang) }
  ctx.sm.compactSession(active).catch((err) => {
    console.log(`[${logPrefix}] /compact ${active}: ${String(err)}`)
  })
  return { text: t('compact.started', ctx.lang) }
}

export async function execNew(ctx: CommandContext): Promise<CommandResult> {
  const disabledSet = getDisabledSet(ctx.sm.getDb(), 'agent')
  const all = await scanAvailableAgents(ctx.workspacePath, disabledSet)
  const top = all.filter((a) => !a.disabled).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]
  const agentId = top?.id ?? 'default'
  const agentName = top?.name ?? 'default'
  const newId = `${ctx.sessionPrefix}${Date.now().toString(36)}`
  const accessLevel = ctx.accessLevel === 'full' ? null : ctx.accessLevel === 'workspace' ? 'workspace' : 'readonly'
  try {
    await ctx.sm.createSession(agentId, null, ctx.channelLabel, agentName, newId, undefined, accessLevel)
    ctx.activeOverrides.set(ctx.userId, newId)
    return { text: t('new.done', ctx.lang), switchTo: newId }
  } catch (err) {
    return { text: t('new.failed', ctx.lang, { error: err instanceof Error ? err.message : String(err) }) }
  }
}

/**
 * Sessions visible to the current channel user.
 *
 * Full-access users (admin / server-side) see every session in the workspace
 * — necessary for support / cross-channel orchestration.
 * Readonly / workspace users only see sessions their own prefix owns —
 * other users on the same channel exist but their titles are not exposed.
 *
 * `execList` and `execSwitch` share this filter so list indices line up with
 * what switch will accept.
 */
/** Hard cap on what `/list` returns from the db. Render layer slices to
 *  20 (see `execList`'s `slice(0, 20)`); the larger fetch is intentional
 *  for cases where the user wants to scroll/page in a future revision. */
const CHANNEL_LIST_LIMIT = 50

function visibleSessions(ctx: CommandContext) {
  // rootOnly: channel /list / /switch is for picking a conversation to
  // resume. Sub-agent sessions are internal — surfacing them lets the user
  // accidentally jump into a sub-agent's history mid-task. Both full-access
  // and prefix-scoped paths skip subs.
  const { sessions } = ctx.sm.listSessions(
    ctx.accessLevel === 'full'
      ? { rootOnly: true, limit: CHANNEL_LIST_LIMIT }
      : { rootOnly: true, prefix: ctx.sessionPrefix, limit: CHANNEL_LIST_LIMIT },
  )
  return sessions
}

export function execList(ctx: CommandContext): CommandResult {
  const sessions = visibleSessions(ctx)
  if (sessions.length === 0) return { text: t('list.empty', ctx.lang) }

  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  const lines = [t('list.title', ctx.lang)]
  const locale = ctx.lang === 'zh' ? 'zh-CN' : 'en-US'
  sessions.slice(0, 50).forEach((s, i) => {
    const marker = s.id === active ? '→ ' : '  '
    const ts = new Date(s.createdAt).toLocaleString(locale, { hour12: false })
    const title = ctx.sm.getSessionTitle(s.id)
    const preview = (title || s.description || '').slice(0, 24)
    let tag: string
    if (s.id.startsWith(ctx.sessionPrefix)) tag = ctx.lang === 'zh' ? '[我]' : '[me]'
    else if (s.id.startsWith('tg_')) tag = '[tg]'
    else if (s.id.startsWith('wx_')) tag = '[wx]'
    else if (s.id.startsWith('web_')) tag = '[web]'
    else tag = '[admin]'
    lines.push(`${marker}${i + 1}. ${tag} ${ts} ${preview}`)
  })
  lines.push('')
  lines.push(ctx.accessLevel === 'full'
    ? t('list.switch_full', ctx.lang)
    : t('list.switch_readonly', ctx.lang))
  return { text: lines.join('\n') }
}

export function execSwitch(ctx: CommandContext, arg: string): CommandResult {
  const sessions = visibleSessions(ctx)
  if (sessions.length === 0) return { text: t('switch.empty', ctx.lang) }
  const idx = parseInt(arg || '', 10)
  if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) {
    return { text: t('switch.usage', ctx.lang, { max: sessions.length }) }
  }
  const target = sessions[idx - 1]
  // Defense-in-depth: visibleSessions already filters non-full users to
  // their prefix, but keep this check in case the filter ever drifts.
  if (ctx.accessLevel !== 'full' && !target.id.startsWith(ctx.sessionPrefix)) {
    return { text: t('switch.readonly', ctx.lang) }
  }
  ctx.activeOverrides.set(ctx.userId, target.id)
  const locale = ctx.lang === 'zh' ? 'zh-CN' : 'en-US'
  const ts = new Date(target.createdAt).toLocaleString(locale, { hour12: false })
  return { text: t('switch.done', ctx.lang, { idx, time: ts, desc: (target.description || '').slice(0, 40) }), switchTo: target.id }
}

export async function execAgents(ctx: CommandContext): Promise<CommandResult> {
  const disabledSet = getDisabledSet(ctx.sm.getDb(), 'agent')
  const all = await scanAvailableAgents(ctx.workspacePath, disabledSet)
  const seen = new Map<string, typeof all[0]>()
  for (const a of all) {
    if (a.disabled) continue
    if (!seen.has(a.id) || a.scope === 'workspace') seen.set(a.id, a)
  }
  const agents = [...seen.values()]
  if (agents.length === 0) return { text: t('agents.empty', ctx.lang) }
  const activeSessionId = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  const activeSession = activeSessionId ? ctx.sm.getSessionById(activeSessionId) : null
  const currentAgentId = activeSession?.agentId
  const lines = [t('agents.title', ctx.lang)]
  agents.forEach((a, i) => {
    const scope = a.scope === 'workspace' ? '[ws]' : (ctx.lang === 'zh' ? '[全局]' : '[global]')
    const desc = a.description ? ` — ${a.description.slice(0, 30)}` : ''
    const current = a.id === currentAgentId ? ' ◀' : ''
    lines.push(`  ${i + 1}. ${scope} ${a.id}${desc}${current}`)
  })
  lines.push('')
  lines.push(t('agents.hint', ctx.lang))
  return { text: lines.join('\n') }
}

export async function execAgent(ctx: CommandContext, arg: string): Promise<CommandResult> {
  if (!arg) return { text: t('agent.usage', ctx.lang) }
  const disabledSet = getDisabledSet(ctx.sm.getDb(), 'agent')
  const all = await scanAvailableAgents(ctx.workspacePath, disabledSet)
  const seen = new Map<string, typeof all[0]>()
  for (const a of all) {
    if (a.disabled) continue
    if (!seen.has(a.id) || a.scope === 'workspace') seen.set(a.id, a)
  }
  const agents = [...seen.values()]
  if (agents.length === 0) return { text: t('agents.empty', ctx.lang) }

  const idx = parseInt(arg, 10)
  let agent: typeof agents[0] | undefined
  if (Number.isInteger(idx) && idx >= 1 && idx <= agents.length) {
    agent = agents[idx - 1]
  } else {
    agent = agents.find((a) => a.id === arg || a.name === arg)
  }
  if (!agent) return { text: t('agent.not_found', ctx.lang, { name: arg }) }

  const newId = `${ctx.sessionPrefix}${Date.now().toString(36)}`
  const accessLevel = ctx.accessLevel === 'full' ? null : ctx.accessLevel === 'workspace' ? 'workspace' : 'readonly'
  try {
    await ctx.sm.createSession(agent.id, null, ctx.channelLabel, agent.name, newId, undefined, accessLevel)
    ctx.activeOverrides.set(ctx.userId, newId)
    return { text: t('agent.done', ctx.lang, { name: agent.name }), switchTo: newId }
  } catch (err) {
    return { text: t('agent.failed', ctx.lang, { error: err instanceof Error ? err.message : String(err) }) }
  }
}

export function formatContextInfo(info: Awaited<ReturnType<SessionManager['getSessionContext']>> & {}): string {
  const pct = info.maxContextTokens > 0
    ? ((info.contextTokens / info.maxContextTokens) * 100).toFixed(1)
    : '?'
  const lines: string[] = [
    `**Workspace:** ${info.workspace}`,
    `**Agent:** ${info.agentId}`,
    `**Model:** ${info.modelId}`,
    `**Thinking:** ${info.thinkingEffort}`,
    `**Context:** ~${(info.contextTokens / 1000).toFixed(1)}K / ${(info.maxContextTokens / 1000).toFixed(0)}K (${pct}%)`,
    `**Messages:** ${info.messageCount}`,
  ]
  if (info.meta.toolNames.length > 0) {
    lines.push(`**Tools:** ${info.meta.toolNames.join(', ')}`)
  }
  if (info.meta.skillNames.length > 0) {
    lines.push(`**Skills:** ${info.meta.skillNames.join(', ')}`)
  }
  if (info.meta.mdFiles.length > 0) {
    lines.push('**Markdown:**')
    for (const f of info.meta.mdFiles) {
      lines.push(`  - ${f.label}: ${f.path}`)
    }
  }
  return lines.join('\n')
}

export async function execContext(ctx: CommandContext): Promise<CommandResult> {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('context.no_session', ctx.lang) }
  const info = await ctx.sm.getSessionContext(active)
  if (!info) return { text: t('context.not_loaded', ctx.lang) }
  return { text: formatContextInfo(info) }
}

/**
 * `/note [hint]` — queue a self-evolution run on the current root session.
 *
 * Synchronous side effects only: snapshot the session log + write a meta.json
 * + insert a `pending` row in `evolution_runs`. The ticker (running in the
 * server process) will pick the row up and spawn the evo wrapper to do the
 * actual LLM work. We return a chat:system reply right away so the user
 * doesn't wait.
 *
 * Refused when:
 *   - settings `general.evolution.level` ≠ 'L1' (off / not enabled)
 *   - the user's accessLevel is 'readonly' (channel guests can't trigger evo)
 *   - no active root session in this workspace for the user
 */
export function execNote(ctx: CommandContext, arg: string): CommandResult {
  if (config.evolution.level !== 'L1') {
    return { text: t('note.disabled', ctx.lang) }
  }
  if (ctx.accessLevel === 'readonly') {
    return { text: t('note.readonly', ctx.lang) }
  }
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('note.no_session', ctx.lang) }

  // /note only works on root sessions — sub-agent sessions are the parent
  // root's responsibility. Hierarchical ids use `>` to separate parent and
  // child (`root>child>grandchild`); a root id has no `>`.
  if (active.includes('>')) return { text: t('note.no_session', ctx.lang) }

  const result = enqueueEvoRun({
    sm: ctx.sm,
    workspacePath: ctx.workspacePath,
    sourceSessionId: active,
    trigger: 'note',
    userHint: arg.trim() || null,
  })
  if (!result.ok) {
    console.error(`[evo] /note ${result.reason}: ${result.error}`)
    if (result.reason === 'snapshot_failed') return { text: t('note.snapshot_failed', ctx.lang) }
    return { text: t('note.queue_failed', ctx.lang) }
  }
  return { text: t('note.queued', ctx.lang) }
}

/**
 * Names of every slash command this dispatcher actually handles. Imported by
 * `commands/index.ts` to assert that every `type: 'server'` descriptor has a
 * matching case here at server startup — keeping this list and the switch
 * below aligned is otherwise manual and easy to forget.
 *
 * `/help`, `/clear` are absent: those are `type: 'client'` (handled by the
 * channel's frontend or by WS handler before reaching dispatch).
 */
export const DISPATCH_COMMANDS = [
  '/help', '/stop', '/interrupt', '/compact', '/new', '/list', '/switch',
  '/agents', '/agent', '/ws', '/context', '/note',
] as const

export async function dispatchCommand(
  ctx: CommandContext,
  command: string,
  arg: string,
  opts?: { channelName?: string; extraHelpLines?: Array<string | { head: string; desc: string }> },
): Promise<CommandResult | null> {
  switch (command) {
    case '/help': return execHelp(ctx, opts?.extraHelpLines)
    case '/stop': return execStop(ctx)
    case '/interrupt': return execInterrupt(ctx)
    case '/compact': return execCompact(ctx, opts?.channelName ?? 'unknown')
    case '/new': return execNew(ctx)
    case '/list': return execList(ctx)
    case '/switch': return execSwitch(ctx, arg)
    case '/agents': return execAgents(ctx)
    case '/agent': return execAgent(ctx, arg)
    case '/ws': return execWs(ctx, arg)
    case '/context': return execContext(ctx)
    case '/note': return execNote(ctx, arg)
    default: {
      const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
      if (active) {
        // Pass ctx.accessLevel — the channel account's *current* level —
        // so a recent admin-side change (readonly → workspace, etc.)
        // takes effect immediately. Without this we'd gate against the
        // session row's stale snapshot.
        const result = await execSkillCommand(command, arg, ctx.sm, active, ctx.workspacePath, ctx.channel, ctx.accessLevel)
        // 'ok' means execSkillCommand kicked sendUserMessage — the agent
        // is now running on `active`. Surface that so the channel keeps
        // its event stream open for the skill body's response.
        if (result === 'ok') return { text: t('skill.activated', ctx.lang, { cmd: command }), startedTurn: true, sessionId: active }
        if (result !== 'not_found') return { text: result }
      }
      return null
    }
  }
}

export function execWs(ctx: CommandContext, arg: string): CommandResult {
  if (!arg) return { text: t('ws.current', ctx.lang, { path: ctx.workspacePath }) }
  if (ctx.accessLevel !== 'full') return { text: t('ws.readonly', ctx.lang) }
  if (!path.isAbsolute(arg)) return { text: t('ws.must_abs', ctx.lang) }
  if (!fs.existsSync(arg)) return { text: t('ws.not_found', ctx.lang, { path: arg }) }
  if (arg === ctx.workspacePath) return { text: t('ws.same', ctx.lang) }
  ensureWorkspaceHalo(arg)
  return { text: t('ws.done', ctx.lang, { path: arg }), workspace: { path: arg } }
}
