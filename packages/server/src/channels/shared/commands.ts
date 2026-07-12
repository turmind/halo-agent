import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import type { SessionManager } from '../../agents/session-manager.js'
import { scanAvailableAgents, GLOBAL_AGENTS_DIR, GLOBAL_SKILLS_DIR, loadAgentYaml, parseSkillFrontmatter } from '../../agents/agent-loader.js'
import { ensureWorkspaceHalo } from '../../init.js'
import { getDisabledSet, toggleDisabled } from '../../db/index.js'
import { t, type Lang } from './i18n.js'
import { execSkillCommand, getCommandSkillInfo } from '../../commands/skill-command.js'
import { commandRegistry } from '../../commands/index.js'
import { enqueueEvoRun } from '../../evolution/enqueue.js'
import {
  GOAL_AGENT_ID, initialGoalState, writeGoalState, setWorkerBackptr, clearWorkerBackptr,
  findLatestGoal, goalDir, fmtElapsed,
} from '../../agents/goal-mode.js'

// ── Command alias expansion ──────────────────────────────────────────────────

const ALIASES_FILE = path.join(os.homedir(), '.halo', 'global', 'aliases.yaml')

interface AliasCache {
  mtime: number
  top: Record<string, string>
  verb: Record<string, string>
}

let aliasCache: AliasCache | null = null

function loadAliases(): { top: Record<string, string>; verb: Record<string, string> } {
  try {
    const stat = fs.statSync(ALIASES_FILE)
    const mtime = stat.mtimeMs
    if (aliasCache && aliasCache.mtime === mtime) return aliasCache
    const raw = fs.readFileSync(ALIASES_FILE, 'utf-8')
    const parsed = YAML.parse(raw) ?? {}
    aliasCache = { mtime, top: parsed.top ?? {}, verb: parsed.verb ?? {} }
    return aliasCache
  } catch {
    return { top: {}, verb: {} }
  }
}

/** Expand command alias. Returns potentially updated { command, arg }. */
export function expandAlias(command: string, arg: string): { command: string; arg: string } {
  const { top, verb } = loadAliases()
  let cmd = command
  let a = arg

  // 1. top-level alias: "/ss" → "/session switch"
  if (top[cmd]) {
    const parts = top[cmd].split(/\s+/)
    cmd = parts[0]
    const prefix = parts.slice(1).join(' ')
    a = prefix ? `${prefix} ${a}`.trim() : a
  }

  // 2. verb alias: first word of arg e.g. "sw" → "switch"
  const firstWord = a.split(/\s+/)[0] ?? ''
  if (firstWord && verb[firstWord]) {
    a = `${verb[firstWord]}${a.slice(firstWord.length)}`
  }

  return { command: cmd, arg: a }
}

export interface CommandContext {
  sm: SessionManager
  userId: string
  sessionPrefix: string
  accessLevel: 'full' | 'workspace' | 'readonly' | 'observer'
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
  accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer',
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
  const builtinCandidates = commandRegistry.listDescriptors().filter((d) => {
    if (d.source === 'skill') return false
    // Client-side commands (e.g. `/clear` — the admin UI clears the chat
    // pane locally) have no server handler. Channels other than the
    // admin browser would just route them to dispatchCommand, get a
    // cmd.unknown back, and confuse the user. Hide them from /help.
    if (d.type === 'client') return false
    // /evo drafts config changes — full-access only, hidden otherwise.
    if (d.name === 'evo') {
      if (ctx.accessLevel !== 'full') return false
    }
    return true
  })
  // Object commands (e.g. /agent): compute the verbs THIS user can run. None
  // runnable → the command is hidden entirely; otherwise the runnable set is
  // appended to its /help description, so a readonly channel sees exactly
  // `(list/switch/desc)` and never the full-gated verbs.
  const objectVerbs = new Map<string, string[]>()
  const builtins: typeof builtinCandidates = []
  for (const d of builtinCandidates) {
    if (isObjectCommand(d.slashName)) {
      const skillAvail = await skillCommandAvailable(ctx, d.slashName)
      const access = await verbAccessMap(d.slashName, ctx.workspacePath, skillAvail)
      const runnable = [...access.entries()]
        .filter(([, ra]) => !ra || RANK[ra] <= RANK[ctx.accessLevel])
        .map(([name]) => name)
      if (runnable.length === 0) continue
      objectVerbs.set(d.slashName, runnable)
    }
    builtins.push(d)
  }
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  // Use the channel account's *current* accessLevel (ctx.accessLevel),
  // not whatever was persisted on the session row when it was first
  // created. Without this, raising a channel from readonly → workspace
  // in the admin UI wouldn't take effect for `/help` until the next time
  // a real chat message updated the row — confusingly hiding skills the
  // user just gave themselves permission for.
  // Resolve which agent's skills to list. With an active session, use its
  // agent. Without one (e.g. right after a `/workspace` switch — the channel
  // restarts with no session yet in the new workspace), fall back to
  // `default` so skill commands still show in /help instead of vanishing
  // until the user sends a first message. Mirrors the cold-start fallback
  // in listAvailableSkillCommands.
  const helpAgentId = (active && ctx.sm.getSessionById(active)?.agentId) || 'default'
  const skills = await ctx.sm.listAvailableSkillCommandsForAgent(helpAgentId, capLevel(ctx.accessLevel))

  // Two-pass render so descriptions align: first compute each command's
  // "head" (slashName + argHint), then pad to the longest head before
  // appending the description.
  const rows: Array<{ head: string; desc: string }> = [...builtins, ...skills]
    .sort((a, b) => a.slashName.localeCompare(b.slashName))
    .map((d) => {
      const arg = d.argHint ? ` ${d.argHint}` : ''
      // Builtin descriptions live in i18n under `cmd.<name>`; skills keep
      // their SKILL.md description (currently English-only). A few commands
      // have access-level-aware variants (e.g. /workspace is read-only without
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
      // Object command: show only the verbs THIS user can run (computed above).
      const runnable = objectVerbs.get(d.slashName)
      if (runnable) desc = `${desc} (${runnable.join('/')})`
      return { head: `${d.slashName}${arg}`, desc }
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

/** Resolve the entry agent for a channel-created session: highest-priority
 *  non-disabled, non-internal agent. On equal priority, workspace-scoped
 *  agents win over global ones (workspace agents are listed last by
 *  scanAvailableAgents, so the secondary sort key flips the tie in their
 *  favour). Falls back to 'default' only when no eligible agent exists. */
export async function resolveDefaultAgentId(sm: SessionManager, workspacePath: string): Promise<string> {
  const disabledSet = getDisabledSet(sm.getDb(), 'agent')
  const all = await scanAvailableAgents(workspacePath, disabledSet)
  const top = all
    .filter((a) => !a.disabled && !a.internal)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.scope === 'workspace' ? -1 : 1))[0]
  return top?.id ?? 'default'
}

export async function execNew(ctx: CommandContext): Promise<CommandResult> {
  // Same entry-agent resolution as channel auto-create (resolveDefaultAgentId):
  // highest-priority non-disabled, non-internal agent, workspace wins ties.
  // agentName omitted → createSession resolves the real agent.yaml `name`.
  const agentId = await resolveDefaultAgentId(ctx.sm, ctx.workspacePath)
  const newId = `${ctx.sessionPrefix}${Date.now().toString(36)}`
  const accessLevel = ctx.accessLevel === 'full' ? null : ctx.accessLevel === 'workspace' ? 'workspace' : 'readonly'
  try {
    await ctx.sm.createSession(agentId, null, ctx.channelLabel, undefined, newId, undefined, accessLevel)
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
  // Sort by createdAt DESC so session indices are stable during a
  // conversation. The DB query sorts by updatedAt (most-recently-active
  // first) which is useful for the admin panel, but for channel /list and
  // /switch it causes index drift: sending a message bumps updatedAt,
  // shuffling the numbering and making `/session switch N` unreliable.
  return sessions.sort((a, b) => b.createdAt - a.createdAt)
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

export function execSessionInfo(ctx: CommandContext): CommandResult {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('list.empty', ctx.lang) }

  const rootId = active.split('>')[0]

  // Access check for non-full users: the root must belong to their prefix.
  if (ctx.accessLevel !== 'full' && !rootId.startsWith(ctx.sessionPrefix)) {
    return { text: t('switch.readonly', ctx.lang) }
  }

  const root = ctx.sm.getSessionById(rootId)
  const descendants = ctx.sm.listDescendants([rootId])
  const all = root ? [root, ...descendants] : descendants
  if (all.length === 0) return { text: t('list.empty', ctx.lang) }

  const locale = ctx.lang === 'zh' ? 'zh-CN' : 'en-US'
  const rootTitle = ctx.sm.getSessionTitle(rootId)
  const titleLabel = ctx.lang === 'zh' ? '会话树' : 'Session tree'
  const lines: string[] = [
    `🌳 ${titleLabel} · root: ${rootId.slice(-12)}${rootTitle ? ` · ${rootTitle.slice(0, 24)}` : ''}`,
  ]

  const createdLabel = ctx.lang === 'zh' ? '建' : 'new '
  const activeLabel = ctx.lang === 'zh' ? '活' : 'act '
  for (const s of all) {
    const depth = s.id.split('>').length - 1
    const agentLabel = s.agentName || ctx.sm.getSessionTitle(s.id) || s.agentId
    const status = s.archivedAt ? '📦' : s.stoppedAt ? '⏹' : '🟢'
    const created = new Date(s.createdAt).toLocaleString(locale, { hour12: false })
    const updated = new Date(s.updatedAt).toLocaleString(locale, { hour12: false })
    const bullet = depth === 0 ? '→ ' : `${'  '.repeat(depth)}├ `
    lines.push(`${bullet}${agentLabel} · ${status} · ${createdLabel}${created} · ${activeLabel}${updated}`)
  }

  return { text: lines.join('\n') }
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
 * /note is the manual evo trigger and works at every level (L0 = manual only,
 * L1 = also auto on pre-compact) — so it's not gated on level, only on access.
 *
 * Refused when:
 *   - the user's accessLevel is 'readonly' (channel guests can't trigger evo)
 *   - no active root session in this workspace for the user
 */
export function execNote(ctx: CommandContext, arg: string): CommandResult {
  // Evolution drafts config changes — full only.
  if (ctx.accessLevel !== 'full') {
    return { text: t('evo.full_only', ctx.lang) }
  }
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('evo.no_session', ctx.lang) }

  // /evo only works on root sessions — sub-agent sessions are the parent
  // root's responsibility. Hierarchical ids use `>` to separate parent and
  // child (`root>child>grandchild`); a root id has no `>`.
  if (active.includes('>')) return { text: t('evo.no_session', ctx.lang) }

  const result = enqueueEvoRun({
    sm: ctx.sm,
    workspacePath: ctx.workspacePath,
    sourceSessionId: active,
    trigger: 'note',
    userHint: arg.trim() || null,
  })
  if (!result.ok) {
    console.error(`[evo] /evo ${result.reason}: ${result.error}`)
    if (result.reason === 'snapshot_failed') return { text: t('evo.snapshot_failed', ctx.lang) }
    return { text: t('evo.queue_failed', ctx.lang) }
  }
  return { text: t('evo.queued', ctx.lang) }
}

// ── /goal verbs (goal mode — see docs/plans/loop-mode.md) ────────────────────

/** Format one goal's status block (shared by create-refusal and /goal status). */
function formatGoalStatus(goalSessionId: string, s: import('../../agents/goal-mode.js').GoalState, lang: Lang): string {
  const lines = [
    t('goal.status_head', lang, { status: s.status, round: s.round, cap: s.caps.maxRounds }),
    t('goal.status_meta', lang, {
      elapsed: s.startedAt ? fmtElapsed(Date.now() - s.startedAt) : '-',
      noProgress: s.noProgress,
      decisions: s.delegatedCount,
    }),
    `worker: ${s.workerSessionId}`,
    `goal session: ${goalSessionId}`,
  ]
  if (s.haltReason) lines.push(t('goal.status_halt', lang, { reason: s.haltReason }))
  return lines.join('\n')
}

/**
 * `/goal create [description]` — mint G (the goal session), write the binding
 * (G's `goal` JSON + W's back-pointer), and kick G's intake. Goals are
 * serialized per workspace (loop-mode.md open-question #3): a second create
 * while one is active prints the active goal's status instead.
 */
async function execGoalCreate(ctx: CommandContext, arg: string): Promise<CommandResult> {
  const active = findLatestGoal(ctx.sm.getDb(), { activeOnly: true })
  if (active) {
    return { text: `${t('goal.already_active', ctx.lang)}\n${formatGoalStatus(active.goalSessionId, active.state, ctx.lang)}` }
  }
  const workerId = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!workerId) return { text: t('goal.no_session', ctx.lang) }
  // The worker must be a root session — sub-agents report to their parent,
  // not to a goal session (the delivery point is root-only).
  if (workerId.includes('>')) return { text: t('goal.no_session', ctx.lang) }
  if (workerId.startsWith('goal_')) return { text: t('goal.cannot_bind_goal', ctx.lang) }

  const gId = `goal_${Date.now().toString(36)}`
  const accessLevel = ctx.accessLevel === 'full' ? null : 'workspace' // create is gated at workspace+
  try {
    await ctx.sm.createSession(GOAL_AGENT_ID, null, `Goal for ${workerId}`, undefined, gId, undefined, accessLevel, '🎯 Goal')
  } catch (err) {
    return { text: t('goal.create_failed', ctx.lang, { error: err instanceof Error ? err.message : String(err) }) }
  }
  fs.mkdirSync(goalDir(ctx.workspacePath, gId), { recursive: true })
  writeGoalState(ctx.sm.getDb(), gId, initialGoalState(gId, workerId))
  setWorkerBackptr(ctx.sm.getDb(), workerId, gId)

  // Kick G's intake (fire and forget — channels subscribed via switchTo see
  // the greeting; others catch up on the user's next message, which the
  // routing overlay delivers to G).
  const hint = arg.trim()
  const kick = `[goal-mode] Intake started via /goal create.${hint ? ` The user's initial goal description: "${hint}".` : ''} Call goal_context (its workerRecent field carries the worker's recent dialogue for scene), then begin the intake conversation with the user.`
  // Persist the kick to G's UI transcript BEFORE dispatch — mirrors the channel
  // inbound path (appendUserMessage, then sendUserMessage). sendUserMessage
  // alone only feeds the LLM context: the kick (and the user's goal hint) never
  // reached the on-disk UI log, so G's transcript opened with tool noise and
  // the hint was invisible after any reload.
  ctx.sm.appendUserMessage(gId, kick)
  ctx.sm.sendUserMessage(gId, kick).catch((err) => {
    console.error(`[GoalMode] intake kick failed for ${gId}: ${err instanceof Error ? err.message : String(err)}`)
  })
  return { text: t('goal.created', ctx.lang, { goal: gId, worker: workerId }), switchTo: gId }
}

/** `/goal status` — print the latest goal's state from the db. */
function execGoalStatus(ctx: CommandContext): CommandResult {
  const latest = findLatestGoal(ctx.sm.getDb())
  if (!latest) return { text: t('goal.none', ctx.lang) }
  return { text: formatGoalStatus(latest.goalSessionId, latest.state, ctx.lang) }
}

/** `/goal pause` — interrupt the whole formation (W + subtree, then G) and
 *  mark the goal paused. Paused lifts the routing overlay so the user can
 *  talk to W directly (manual-takeover escape hatch). */
async function execGoalPause(ctx: CommandContext): Promise<CommandResult> {
  const latest = findLatestGoal(ctx.sm.getDb(), { activeOnly: true })
  if (!latest || latest.state.status !== 'running') return { text: t('goal.not_running', ctx.lang) }
  const { goalSessionId, state } = latest
  // Status first: the worker's abort still runs runSession's finally → the
  // delivery point must already see `paused` and skip the round.
  state.status = 'paused'
  writeGoalState(ctx.sm.getDb(), goalSessionId, state)
  await ctx.sm.stopSession(state.workerSessionId)
  await ctx.sm.stopSession(goalSessionId)
  return { text: t('goal.paused', ctx.lang) }
}

/** `/goal resume` — paused → running, nudge G to re-dispatch. */
async function execGoalResume(ctx: CommandContext): Promise<CommandResult> {
  const latest = findLatestGoal(ctx.sm.getDb(), { activeOnly: true })
  if (!latest || latest.state.status !== 'paused') return { text: t('goal.not_paused', ctx.lang) }
  const { goalSessionId, state } = latest
  state.status = 'running'
  writeGoalState(ctx.sm.getDb(), goalSessionId, state)
  // Append-then-send, same as the create kick — see execGoalCreate.
  const nudge = '[goal-mode] The user resumed the goal. Call goal_context, re-read GOAL_SPEC.md and your own transcript (the user may have made manual changes while paused), then re-dispatch the current work order to the worker via query_session.'
  ctx.sm.appendUserMessage(goalSessionId, nudge)
  ctx.sm.sendUserMessage(goalSessionId, nudge).catch((err) => {
    console.error(`[GoalMode] resume nudge failed for ${goalSessionId}: ${err instanceof Error ? err.message : String(err)}`)
  })
  return { text: t('goal.resumed', ctx.lang), switchTo: goalSessionId }
}

/** `/goal clear` — tear down the binding (any non-terminal state) and return
 *  the surface to W. The goal record stays on G's row as history. */
async function execGoalClear(ctx: CommandContext): Promise<CommandResult> {
  const latest = findLatestGoal(ctx.sm.getDb(), { activeOnly: true })
  if (!latest) return { text: t('goal.none_active', ctx.lang) }
  const { goalSessionId, state } = latest
  state.status = 'cleared'
  writeGoalState(ctx.sm.getDb(), goalSessionId, state)
  clearWorkerBackptr(ctx.sm.getDb(), state.workerSessionId)
  await ctx.sm.stopSession(state.workerSessionId)
  await ctx.sm.stopSession(goalSessionId)
  return { text: t('goal.cleared', ctx.lang, { worker: state.workerSessionId }) }
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
  '/help', '/workspace', '/evo', '/session', '/agent', '/skill', '/goal',
] as const

export async function dispatchCommand(
  ctx: CommandContext,
  command: string,
  arg: string,
  opts?: { channelName?: string; extraHelpLines?: Array<string | { head: string; desc: string }> },
): Promise<CommandResult | null> {
  // Expand aliases before routing — affects all channels uniformly.
  ;({ command, arg } = expandAlias(command, arg))
  switch (command) {
    case '/help': return execHelp(ctx, opts?.extraHelpLines)
    case '/workspace': return routeObjectOrSkill(ctx, command, arg)
    case '/evo': return execNote(ctx, arg)
    // Session lifecycle is an object command: /session new|list|switch|stop|…
    case '/session': return routeObjectOrSkill(ctx, command, arg)
    // `/agent` is a builtin object command: its list/switch/desc/delete verbs
    // are deterministic builtin code, so it works on EVERY agent regardless of
    // whether the `agent` skill is whitelisted. create/update fall through to
    // the agent skill. Explicit case (not default) so it's always registered
    // and the startup descriptor↔dispatch assertion is satisfied.
    case '/agent': return routeObjectOrSkill(ctx, command, arg)
    case '/skill': return routeObjectOrSkill(ctx, command, arg)
    // Goal mode (docs/plans/loop-mode.md): all verbs are builtin (no backing
    // skill) — create/status/pause/resume/clear in SUBCOMMAND_ROUTES.
    case '/goal': return routeObjectOrSkill(ctx, command, arg)
    default:
      // Skill-defined slash commands — same routing, but
      // reached only when the command isn't a builtin above.
      return routeObjectOrSkill(ctx, command, arg)
  }
}

/** Shared routing for object/skill commands: try the noun-verb builtin verbs
 *  first (deterministic), else fall through to the same-named skill (LLM). */
async function routeObjectOrSkill(
  ctx: CommandContext,
  command: string,
  arg: string,
): Promise<CommandResult | null> {
  const routed = await tryRouteSubcommand(ctx, command, arg)
  if (routed !== NOT_ROUTED) return routed

  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (active) {
    // Pass ctx.accessLevel — the channel account's *current* level — so a
    // recent admin-side change (readonly → workspace, etc.) takes effect
    // immediately. Without this we'd gate against the session row's stale
    // snapshot.
    const result = await execSkillCommand(command, arg, ctx.sm, active, ctx.workspacePath, ctx.channel, capLevel(ctx.accessLevel), ctx.lang)
    // 'ok' means execSkillCommand kicked sendUserMessage — the agent is now
    // running on `active`. Surface that so the channel keeps its event stream
    // open for the skill body's response.
    if (result === 'ok') return { text: t('skill.activated', ctx.lang, { cmd: command }), startedTurn: true, sessionId: active }
    if (result !== 'not_found') return { text: result }
  }
  return null
}

/** Sentinel: this command/verb has no builtin subcommand handler — caller
 *  should fall through to the skill path. Distinct from a handler returning
 *  `null` (which is a real "handled, no reply" result). */
const NOT_ROUTED = Symbol('not-routed')

/** A builtin subcommand handler. `subArg` is the args after the verb
 *  (e.g. for `/agent switch coder`, verb=`switch`, subArg=`coder`). */
type SubcommandHandler = (ctx: CommandContext, subArg: string) => Promise<CommandResult | null> | CommandResult | null

/** A builtin verb: handler + hardcoded access gate + i18n description key.
 *  All code-level (NOT from SKILL.md) — builtin verbs are part of the builtin
 *  command and must work (and be listable) even when the backing skill isn't
 *  installed/whitelisted. `requiresAccess` unset → open to everyone. `descKey`
 *  is an i18n key so builtin verb help is localized. */
interface BuiltinVerb {
  handler: SubcommandHandler
  requiresAccess?: 'full' | 'workspace' | 'readonly'
  descKey: string
}

/**
 * noun-verb subcommand table. Keyed by object command (`/agent`) → verb
 * (`list`) → { handler, requiresAccess }. A verb NOT in this table falls
 * through to the object's skill (LLM-driven, e.g. `/agent create`, gated by
 * the skill's own requiresAccess in execSkillCommand). Per-verb access is
 * hardcoded here so read-only verbs (list/desc) and destructive ones (delete)
 * can differ under one `/agent` command.
 */
const SUBCOMMAND_ROUTES: Record<string, Record<string, BuiltinVerb>> = {
  '/workspace': {
    // info/switch are builtin; setup/tidy/share fall through to the `workspace`
    // skill (same name as the command — standard semantics), whose verbs:
    // declare their own access.
    info: { handler: (ctx) => execWsInfo(ctx), descKey: 'verb.workspace.info' },
    switch: { handler: (ctx, subArg) => execWsSwitch(ctx, subArg), requiresAccess: 'full', descKey: 'verb.workspace.switch' },
  },
  '/session': {
    // All open to readonly: new/switch operate within the caller's own access
    // level (the created/target session inherits it), and list/context/stop/
    // interrupt/compact were never gated as top-level commands either.
    new: { handler: (ctx) => execNew(ctx), descKey: 'verb.session.new' },
    list: { handler: (ctx) => execList(ctx), descKey: 'verb.session.list' },
    info: { handler: (ctx) => execSessionInfo(ctx), descKey: 'verb.session.info' },
    switch: { handler: (ctx, subArg) => execSwitch(ctx, subArg), descKey: 'verb.session.switch' },
    stop: { handler: (ctx) => execStop(ctx), descKey: 'verb.session.stop' },
    interrupt: { handler: (ctx) => execInterrupt(ctx), descKey: 'verb.session.interrupt' },
    compact: { handler: (ctx) => execCompact(ctx, 'session'), descKey: 'verb.session.compact' },
    context: { handler: (ctx) => execContext(ctx), descKey: 'verb.session.context' },
  },
  '/agent': {
    // list/desc are pure reads; switch creates a session that inherits the
    // caller's own access level (no escalation) — all open to readonly.
    list: { handler: (ctx) => execAgentList(ctx), descKey: 'verb.agent.list' },
    switch: { handler: (ctx, subArg) => execAgentSwitch(ctx, subArg), descKey: 'verb.agent.switch' },
    desc: { handler: (ctx, subArg) => execAgentDesc(ctx, subArg), descKey: 'verb.agent.desc' },
    delete: { handler: (ctx, subArg) => execAgentDelete(ctx, subArg), requiresAccess: 'full', descKey: 'verb.agent.delete' },
  },
  '/skill': {
    // list/desc are pure reads — open to readonly. disable toggles a
    // workspace-level DB flag (workspace). delete removes files (full).
    list: { handler: (ctx) => execSkillList(ctx), descKey: 'verb.skill.list' },
    desc: { handler: (ctx, subArg) => execSkillDesc(ctx, subArg), descKey: 'verb.skill.desc' },
    disable: { handler: (ctx, subArg) => execSkillSetDisabled(ctx, subArg, true), requiresAccess: 'workspace', descKey: 'verb.skill.disable' },
    enable: { handler: (ctx, subArg) => execSkillSetDisabled(ctx, subArg, false), requiresAccess: 'workspace', descKey: 'verb.skill.enable' },
    delete: { handler: (ctx, subArg) => execSkillDelete(ctx, subArg), requiresAccess: 'full', descKey: 'verb.skill.delete' },
  },
  '/goal': {
    // Goal mode drives an autonomous multi-round loop (G dispatches work
    // orders that write files, runs shell checks, consumes rounds of model
    // budget) — user ruling: full-access only, all verbs including status.
    create: { handler: (ctx, subArg) => execGoalCreate(ctx, subArg), requiresAccess: 'full', descKey: 'verb.goal.create' },
    status: { handler: (ctx) => execGoalStatus(ctx), requiresAccess: 'full', descKey: 'verb.goal.status' },
    pause: { handler: (ctx) => execGoalPause(ctx), requiresAccess: 'full', descKey: 'verb.goal.pause' },
    resume: { handler: (ctx) => execGoalResume(ctx), requiresAccess: 'full', descKey: 'verb.goal.resume' },
    clear: { handler: (ctx) => execGoalClear(ctx), requiresAccess: 'full', descKey: 'verb.goal.clear' },
  },
}

type Access = 'full' | 'workspace' | 'readonly'
// observer ranks with readonly for command gating — globally-scoped but
// read-only, so it's the capability floor (it can run only readonly-level verbs).
const RANK = { readonly: 0, observer: 0, workspace: 1, full: 2 } as const

/** Collapse observer→readonly for capability-layer consumers (skill listing,
 *  skill exec, session building) that only know full/workspace/readonly.
 *  observer's "global" is a visibility-layer concept; capability-wise it's
 *  read-only. The single chokepoint enforcing the "observer never reaches the
 *  sandbox as observer" invariant. */
function capLevel(a: 'full' | 'workspace' | 'readonly' | 'observer'): 'full' | 'workspace' | 'readonly' {
  return a === 'observer' ? 'readonly' : a
}

/** Is this slash command an object command (has builtin verbs)? */
function isObjectCommand(command: string): boolean {
  return command in SUBCOMMAND_ROUTES
}

/**
 * The single source of verb-level access for a command. Returns `{ verb →
 * requiresAccess }` for every verb the command exposes, applying ONE rule
 * symmetrically to builtin and skill verbs:
 *
 *   verb's own requiresAccess  (builtin: SUBCOMMAND_ROUTES; skill: SKILL.md verbs)
 *     ?? the skill's object-level requiresAccess
 *     ?? open (undefined)
 *
 * Every consumer — the router gate, /agent help, and /help visibility — derives
 * from this map, so there's no second place where verb permissions are decided.
 */
async function verbAccessMap(
  command: string,
  workspaceRoot?: string,
  /** Whether the backing skill is available to the current agent (whitelisted,
   *  not disabled). Builtin verbs (list/switch/...) are part of the builtin
   *  command and always included; skill verbs (create/update) only when the
   *  skill is available — so an agent without the `agent` skill doesn't see
   *  create/update. Defaults true for callers that have no agent context. */
  skillVerbsAvailable = true,
): Promise<Map<string, Access | undefined>> {
  const builtins = SUBCOMMAND_ROUTES[command] ?? {}
  const { verbs, requiresAccess: objectRA } = await getCommandSkillInfo(command, workspaceRoot)
  const map = new Map<string, Access | undefined>()
  // Declared verbs (from the skill's `verbs:`): builtin verbs take their gate
  // from SUBCOMMAND_ROUTES, skill verbs from their own requiresAccess; either
  // falls back to the object-level gate. Skill verbs are skipped when the skill
  // isn't available to this agent.
  for (const v of verbs) {
    const isBuiltin = v.name in builtins
    if (!isBuiltin && !skillVerbsAvailable) continue
    const own = isBuiltin ? builtins[v.name].requiresAccess : v.requiresAccess
    map.set(v.name, own ?? objectRA)
  }
  // Builtin verbs not declared in `verbs:` still exist — include them.
  for (const [name, b] of Object.entries(builtins)) {
    if (!map.has(name)) map.set(name, b.requiresAccess ?? objectRA)
  }
  return map
}

/** Is the skill backing an object command available to the session's agent
 *  (whitelisted in agent.yaml, not disabled)? Decides whether skill verbs
 *  (create/update) show up; builtin verbs don't depend on this. Checks the
 *  whitelist by skill id directly — NOT via the command list, which excludes
 *  commands shadowed by a builtin (like /agent), so that exclusion mustn't make
 *  the skill look unavailable. */
async function skillCommandAvailable(ctx: CommandContext, command: string): Promise<boolean> {
  const { skillId } = await getCommandSkillInfo(command, ctx.workspacePath)
  if (!skillId) return false
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  const agentId = (active && ctx.sm.getSessionById(active)?.agentId) || 'default'
  const yamlConfig = await loadAgentYaml(agentId, ctx.workspacePath)
  if (!yamlConfig?.skills?.includes(skillId)) return false
  if (getDisabledSet(ctx.sm.getDb(), 'skill').has(skillId)) return false
  return true
}

// ── /agent builtin verbs ─────────────────────────────────────────────────────
// Deterministic agent management. create / update are NOT here — they fall
// through to the `agent` skill (LLM-driven, needs to author yaml + AGENT.md).

/** Usable agents: deduped (workspace overrides global), internal + disabled
 *  excluded. Shared by every /agent verb so they see the same set. */
async function loadUsableAgents(ctx: CommandContext) {
  const disabledSet = getDisabledSet(ctx.sm.getDb(), 'agent')
  const all = await scanAvailableAgents(ctx.workspacePath, disabledSet)
  const seen = new Map<string, typeof all[0]>()
  for (const a of all) {
    if (a.disabled || a.internal) continue
    if (!seen.has(a.id) || a.scope === 'workspace') seen.set(a.id, a)
  }
  return [...seen.values()]
}

/** Resolve an agent by 1-based index or by id/name, against the usable set. */
function resolveAgent(agents: Awaited<ReturnType<typeof loadUsableAgents>>, arg: string) {
  const idx = parseInt(arg, 10)
  if (Number.isInteger(idx) && idx >= 1 && idx <= agents.length) return agents[idx - 1]
  return agents.find((a) => a.id === arg || a.name === arg)
}

export async function execAgentList(ctx: CommandContext): Promise<CommandResult> {
  const agents = await loadUsableAgents(ctx)
  if (agents.length === 0) return { text: t('agents.empty', ctx.lang) }
  const activeSessionId = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  const currentAgentId = activeSessionId ? ctx.sm.getSessionById(activeSessionId)?.agentId : undefined
  const lines = [t('agents.title', ctx.lang)]
  agents.forEach((a, i) => {
    const scope = a.scope === 'workspace' ? '[ws]' : (ctx.lang === 'zh' ? '[全局]' : '[global]')
    const desc = a.description ? ` — ${a.description.slice(0, 30)}` : ''
    const current = a.id === currentAgentId ? ' ◀' : ''
    lines.push(`  ${i + 1}. ${scope} ${a.id}${desc}${current}`)
  })
  return { text: lines.join('\n') }
}

export async function execAgentSwitch(ctx: CommandContext, arg: string): Promise<CommandResult> {
  if (!arg) return { text: t('agent.usage', ctx.lang) }
  const agents = await loadUsableAgents(ctx)
  if (agents.length === 0) return { text: t('agents.empty', ctx.lang) }
  const agent = resolveAgent(agents, arg)
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

export async function execAgentDesc(ctx: CommandContext, arg: string): Promise<CommandResult> {
  if (!arg) return { text: t('agent.usage', ctx.lang) }
  const agents = await loadUsableAgents(ctx)
  const agent = resolveAgent(agents, arg)
  if (!agent) return { text: t('agent.not_found', ctx.lang, { name: arg }) }
  const lines = [
    `**${agent.name}** (${agent.id}) ${agent.scope === 'workspace' ? '[ws]' : '[global]'}`,
    agent.description ? `\n${agent.description}` : '',
    `\n**Model:** ${agent.model}`,
    agent.tools.length ? `**Tools:** ${agent.tools.join(', ')}` : '',
    agent.skills.length ? `**Skills:** ${agent.skills.join(', ')}` : '',
  ].filter(Boolean)
  return { text: lines.join('\n') }
}

export async function execAgentDelete(ctx: CommandContext, arg: string): Promise<CommandResult> {
  // Access ('full') is gated at the router (SUBCOMMAND_ROUTES) before we get here.
  if (!arg) return { text: t('agent.delete_usage', ctx.lang) }
  const agents = await loadUsableAgents(ctx)
  const agent = resolveAgent(agents, arg)
  if (!agent) return { text: t('agent.not_found', ctx.lang, { name: arg }) }
  // Built-in agents are re-seeded on restart — deleting won't stick.
  const dir = agent.scope === 'workspace'
    ? path.join(ctx.workspacePath, '.halo', 'agents', agent.id)
    : path.join(GLOBAL_AGENTS_DIR, agent.id)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return { text: t('agent.delete_done', ctx.lang, { name: agent.name, scope: agent.scope }) }
  } catch (err) {
    return { text: t('agent.failed', ctx.lang, { error: err instanceof Error ? err.message : String(err) }) }
  }
}

// ── /skill builtin verbs ─────────────────────────────────────────────────────
// Deterministic skill management. create / update fall through to the `skill`
// skill (LLM-driven, authors SKILL.md files).

interface ScannedSkill {
  id: string
  name: string
  description: string
  scope: 'global' | 'workspace'
  disabled: boolean
  overridden: boolean
}

/** Scan global + workspace skills. Workspace wholly overrides a same-id global
 *  (the global row is kept but flagged `overridden`). `disabled` comes from the
 *  workspace DB (disabled_items), keyed `scope:id`. */
function scanSkills(ctx: CommandContext): ScannedSkill[] {
  const disabledSet = getDisabledSet(ctx.sm.getDb(), 'skill')
  const out: ScannedSkill[] = []
  const scanOne = (dir: string, scope: 'global' | 'workspace') => {
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { return }
    for (const id of names) {
      const mdPath = path.join(dir, id, 'SKILL.md')
      if (!fs.existsSync(mdPath)) continue
      try {
        const { name, description } = parseSkillFrontmatter(fs.readFileSync(mdPath, 'utf-8'))
        out.push({
          id, name: name || id, description: description ?? '', scope,
          disabled: disabledSet.has(`${scope}:${id}`), overridden: false,
        })
      } catch { /* skip unparsable */ }
    }
  }
  scanOne(GLOBAL_SKILLS_DIR, 'global')
  scanOne(path.join(ctx.workspacePath, '.halo', 'skills'), 'workspace')
  const wsIds = new Set(out.filter((s) => s.scope === 'workspace').map((s) => s.id))
  for (const s of out) if (s.scope === 'global' && wsIds.has(s.id)) s.overridden = true
  return out
}

/** Resolve a skill by 1-based index (against the list order) or by id. */
function resolveSkill(skills: ScannedSkill[], arg: string): ScannedSkill | undefined {
  const idx = parseInt(arg, 10)
  if (Number.isInteger(idx) && idx >= 1 && idx <= skills.length) return skills[idx - 1]
  // Prefer the workspace copy when both scopes have the id (it's the live one).
  return skills.find((s) => s.id === arg && s.scope === 'workspace') ?? skills.find((s) => s.id === arg)
}

export function execSkillList(ctx: CommandContext): CommandResult {
  const skills = scanSkills(ctx)
  if (skills.length === 0) return { text: t('skills.empty', ctx.lang) }
  const lines = [t('skills.title', ctx.lang)]
  skills.forEach((s, i) => {
    const scope = s.scope === 'workspace' ? '[ws]' : (ctx.lang === 'zh' ? '[全局]' : '[global]')
    const flags = [
      s.disabled ? (ctx.lang === 'zh' ? '已禁用' : 'disabled') : '',
      s.overridden ? (ctx.lang === 'zh' ? '被覆盖' : 'overridden') : '',
    ].filter(Boolean).join(', ')
    const desc = s.description ? ` — ${s.description.slice(0, 40)}` : ''
    lines.push(`  ${i + 1}. ${scope} ${s.id}${desc}${flags ? ` (${flags})` : ''}`)
  })
  return { text: lines.join('\n') }
}

export function execSkillDesc(ctx: CommandContext, arg: string): CommandResult {
  if (!arg) return { text: t('skill.usage_desc', ctx.lang) }
  const skills = scanSkills(ctx)
  const skill = resolveSkill(skills, arg)
  if (!skill) return { text: t('skill.not_found', ctx.lang, { name: arg }) }
  const lines = [
    `**${skill.name}** (${skill.id}) ${skill.scope === 'workspace' ? '[ws]' : '[global]'}`,
    skill.description ? `\n${skill.description}` : '',
    skill.disabled ? `\n⚠ ${ctx.lang === 'zh' ? '此 skill 已在本 workspace 禁用' : 'Disabled in this workspace'}` : '',
    skill.overridden ? `\n⚠ ${ctx.lang === 'zh' ? '被同名 workspace skill 覆盖' : 'Overridden by a same-id workspace skill'}` : '',
  ].filter(Boolean)
  return { text: lines.join('\n') }
}

export function execSkillSetDisabled(ctx: CommandContext, arg: string, disable: boolean): CommandResult {
  if (!arg) return { text: t(disable ? 'skill.usage_disable' : 'skill.usage_enable', ctx.lang) }
  const skills = scanSkills(ctx)
  const skill = resolveSkill(skills, arg)
  if (!skill) return { text: t('skill.not_found', ctx.lang, { name: arg }) }
  // toggleDisabled flips; only flip when the current state differs from the
  // requested one, so `disable` on an already-disabled skill is a no-op.
  if (skill.disabled === disable) {
    return { text: t(disable ? 'skill.already_disabled' : 'skill.already_enabled', ctx.lang, { name: skill.id }) }
  }
  toggleDisabled(ctx.sm.getDb(), 'skill', skill.id, skill.scope)
  return { text: t(disable ? 'skill.disabled_done' : 'skill.enabled_done', ctx.lang, { name: skill.id }) }
}

export function execSkillDelete(ctx: CommandContext, arg: string): CommandResult {
  if (!arg) return { text: t('skill.usage_delete', ctx.lang) }
  const skills = scanSkills(ctx)
  const skill = resolveSkill(skills, arg)
  if (!skill) return { text: t('skill.not_found', ctx.lang, { name: arg }) }
  // Built-in skills are re-seeded on restart — deleting won't stick (same as agents).
  const dir = skill.scope === 'workspace'
    ? path.join(ctx.workspacePath, '.halo', 'skills', skill.id)
    : path.join(GLOBAL_SKILLS_DIR, skill.id)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return { text: t('skill.delete_done', ctx.lang, { name: skill.id, scope: skill.scope }) }
  } catch (err) {
    return { text: t('skill.delete_failed', ctx.lang, { error: err instanceof Error ? err.message : String(err) }) }
  }
}

/** Route `/<obj> <verb> <rest>`:
 *   - command isn't an object command (no SUBCOMMAND_ROUTES entry) → NOT_ROUTED
 *   - verb empty or `help` → builtin help listing the object's verbs
 *   - verb has a builtin handler → run it (deterministic)
 *   - verb has no handler → NOT_ROUTED (falls through to the skill, e.g. create)
 */
async function tryRouteSubcommand(
  ctx: CommandContext,
  command: string,
  arg: string,
): Promise<CommandResult | null | typeof NOT_ROUTED> {
  const handlers = SUBCOMMAND_ROUTES[command]
  if (!handlers) return NOT_ROUTED

  const trimmed = arg.trim()
  const verb = trimmed.split(/\s+/)[0] ?? ''

  // Bare / help: list only the verbs this user is allowed to run.
  if (verb === '' || verb === 'help') return renderObjectHelp(ctx, command)

  // Gate EVERY verb here from the one access map (builtin + skill, same rule),
  // before dispatching. This is the single enforcement point — skill verbs are
  // gated here too, not left to execSkillCommand, so verb-level access holds
  // even with no object-level requiresAccess. Unset → open to everyone.
  const required = (await verbAccessMap(command, ctx.workspacePath)).get(verb)
  if (required && RANK[required] > RANK[ctx.accessLevel]) {
    return { text: t('skill.access_required', ctx.lang, { cmd: `${command} ${verb}`, required, current: ctx.accessLevel }) }
  }

  const builtin = handlers[verb]
  // No builtin handler → fall through to the skill (e.g. `/agent create`),
  // already access-checked above.
  if (!builtin) return NOT_ROUTED

  const subArg = trimmed.slice(verb.length).trim()
  return builtin.handler(ctx, subArg)
}

/** Build the `/cmd help` listing from the object command's declared `verbs`.
 *  Lists builtin verbs and skill verbs together so the user sees the full set
 *  in one place, regardless of which side actually handles each. */
async function renderObjectHelp(ctx: CommandContext, command: string): Promise<CommandResult> {
  // Two verb sources, merged into one listing:
  //   - builtin verbs (SUBCOMMAND_ROUTES): always listed (they don't depend on
  //     the skill being installed); desc is localized via i18n.
  //   - skill verbs (SKILL.md `verbs:`): listed only if the skill is available
  //     to this agent (whitelisted, not disabled); desc stays English (SKILL.md).
  // Each then filtered by the user's access. This is why an agent WITHOUT the
  // `agent` skill still sees list/switch/desc/delete.
  const builtins = SUBCOMMAND_ROUTES[command] ?? {}
  const skillAvail = await skillCommandAvailable(ctx, command)
  const access = await verbAccessMap(command, ctx.workspacePath, skillAvail)
  const canRun = (verb: string): boolean => {
    const required = access.get(verb)
    return !required || RANK[required] <= RANK[ctx.accessLevel]
  }

  const rows: Array<{ name: string; desc: string }> = []
  // Builtin verbs first, in declared order.
  for (const [name, b] of Object.entries(builtins)) {
    if (canRun(name)) rows.push({ name, desc: t(b.descKey, ctx.lang) })
  }
  // Skill verbs (only those not shadowed by a builtin), if the skill is available.
  if (skillAvail) {
    const { verbs: skillVerbs } = await getCommandSkillInfo(command, ctx.workspacePath)
    for (const v of skillVerbs) {
      if (v.name in builtins) continue
      if (canRun(v.name)) rows.push({ name: v.name, desc: v.desc ?? '' })
    }
  }

  if (rows.length === 0) {
    return { text: t('verb.none', ctx.lang, { cmd: command }) }
  }
  const width = Math.max(...rows.map((r) => r.name.length))
  const lines = rows.map((r) => `  ${command} ${r.name.padEnd(width)}  ${r.desc}`.trimEnd())
  return { text: `${command} actions:\n${lines.join('\n')}` }
}

export function execWsInfo(ctx: CommandContext): CommandResult {
  return { text: t('workspace.current', ctx.lang, { path: ctx.workspacePath }) }
}

export function execWsSwitch(ctx: CommandContext, arg: string): CommandResult {
  // Access ('full') is gated at the router (SUBCOMMAND_ROUTES) before we get here.
  if (!arg) return { text: t('workspace.switch_usage', ctx.lang) }

  // Resolve path: bare name → $HOME/<name>, ~/... → $HOME/...
  let target = arg.trim()
  if (target.startsWith('~/')) {
    target = path.join(os.homedir(), target.slice(2))
  } else if (!target.startsWith('/')) {
    target = path.join(os.homedir(), target)
  }

  if (!fs.existsSync(target)) return { text: t('workspace.not_found', ctx.lang, { path: target }) }
  if (target === ctx.workspacePath) return { text: t('workspace.same', ctx.lang) }
  ensureWorkspaceHalo(target)
  return { text: t('workspace.done', ctx.lang, { path: target }), workspace: { path: target } }
}

