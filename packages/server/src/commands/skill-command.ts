import fs from 'node:fs/promises'
import path from 'node:path'
import type { CommandDescriptor } from './types.js'
import { commandRegistry } from './index.js'
import { GLOBAL_SKILLS_DIR, loadAgentYaml, parseSkillFrontmatter, type SkillVerb } from '../agents/agent-loader.js'
import { buildRenderContext, renderMdBody } from '../prompts/md-vars.js'
import { getDisabledSet } from '../db/index.js'
import { t, type Lang } from '../channels/shared/i18n.js'
import type { SessionManager } from '../agents/session-manager.js'

interface SkillCommandEntry {
  id: string
  name: string
  description: string
  command: string
  skillPath: string
  requiresAccess?: 'full' | 'workspace' | 'readonly'
  verbs?: SkillVerb[]
}

async function scanDir(dir: string): Promise<SkillCommandEntry[]> {
  const entries: SkillCommandEntry[] = []
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return entries
  }
  for (const entryName of names) {
    const skillDir = path.join(dir, entryName)
    try {
      const stat = await fs.stat(skillDir)
      if (!stat.isDirectory()) continue
    } catch { continue }
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    try {
      const content = await fs.readFile(skillMdPath, 'utf-8')
      const { name, description, command, requiresAccess, verbs, userInvocable } = parseSkillFrontmatter(content)
      // `user-invocable: false` (standard): never a slash command — skip the
      // command entirely so it can't be listed or dispatched. The model can
      // still activate the skill (loadSkillMetadata doesn't read this flag).
      if (userInvocable === false) {
        entries.push({ id: entryName, name: name || entryName, description: description ?? '', command: '', skillPath: skillMdPath, requiresAccess, verbs })
        continue
      }
      // Skills without a `command:` are cached too (command='') — their verbs
      // still feed object-command help — they just never become slash-command
      // descriptors below.
      entries.push({ id: entryName, name: name || entryName, description: description ?? '', command: command ?? '', skillPath: skillMdPath, requiresAccess, verbs })
    } catch { /* skip */ }
  }
  return entries
}

let cachedEntries: SkillCommandEntry[] = []

/** Verbs + object-level access of the skill behind an object command, even
 *  when a builtin command shadows the skill from the descriptor list (e.g.
 *  `/agent`). Reads the full scan (cachedEntries), not just listed descriptors,
 *  so `/agent help` can show create/update (skill verbs) alongside the builtin
 *  verbs, and gate them by the skill's requiresAccess. Empty for a command with
 *  no backing skill. */
export async function getCommandSkillInfo(
  slashCommand: string,
  workspaceRoot?: string,
): Promise<{ skillId?: string; verbs: SkillVerb[]; requiresAccess?: 'full' | 'workspace' | 'readonly' }> {
  await scanSkillDescriptors(workspaceRoot)
  const cmd = slashCommand.startsWith('/') ? slashCommand : `/${slashCommand}`
  const entry = cachedEntries.find((e) => {
    const slash = e.command.startsWith('/') ? e.command : `/${e.command}`
    return slash === cmd
  })
  return { skillId: entry?.id, verbs: entry?.verbs ?? [], requiresAccess: entry?.requiresAccess }
}

export async function scanSkillDescriptors(workspaceRoot?: string): Promise<CommandDescriptor[]> {
  const globalEntries = await scanDir(GLOBAL_SKILLS_DIR)
  let wsEntries: SkillCommandEntry[] = []
  if (workspaceRoot) {
    wsEntries = await scanDir(path.join(workspaceRoot, '.halo', 'skills'))
  }
  const merged = new Map<string, SkillCommandEntry>()
  for (const e of globalEntries) merged.set(e.id, e)
  for (const e of wsEntries) merged.set(e.id, e)

  // Load-time conflict detection: a skill's `command:` must not collide with a
  // builtin slash command or with another skill's. Builtins always win — the
  // dispatcher matches them first, so a colliding skill command is unreachable
  // anyway; among skills it's first-come. Colliding entries are dropped here, at
  // the single source feeding both dispatch (via cachedEntries) and the popup
  // (via the returned descriptors), so a command can never show up in the popup
  // that dispatch is unable to route to ("visible but unreachable").
  const builtinSlashes = new Set(
    commandRegistry.listDescriptors()
      .filter((d) => d.source === 'builtin')
      .map((d) => d.slashName),
  )
  const claimed = new Set(builtinSlashes)
  // `cachedEntries` (consumed by execSkillCommand) keeps EVERY skill, including
  // ones whose command is shadowed by a builtin — e.g. the `agent` skill, whose
  // /agent command is now a builtin object command but whose body still serves
  // the create/update verbs via fallback. `listed` is the subset that becomes
  // actual slash-command descriptors (shadowed ones excluded so the palette
  // never shows a command the builtin/another-skill already owns).
  cachedEntries = Array.from(merged.values())
  const listed: SkillCommandEntry[] = []
  for (const entry of cachedEntries) {
    if (!entry.command) continue // no slash command — cached for verb metadata only
    const slashName = entry.command.startsWith('/') ? entry.command : `/${entry.command}`
    if (claimed.has(slashName)) {
      // A builtin owning the name is expected for object commands (the skill
      // body still runs via fallback), so only warn on skill-vs-skill clashes.
      if (!builtinSlashes.has(slashName)) {
        console.warn(`[CommandRegistry] skill "${entry.id}" command "${slashName}" shadowed by another skill — dropped from command list`)
      }
      continue
    }
    claimed.add(slashName)
    listed.push(entry)
  }
  return listed.map((entry) => {
    const slashName = entry.command.startsWith('/') ? entry.command : `/${entry.command}`
    return {
      name: slashName.slice(1),
      slashName,
      description: entry.description,
      type: 'server' as const,
      source: 'skill' as const,
      skillId: entry.id,
      requiresAccess: entry.requiresAccess,
      verbs: entry.verbs,
    }
  })
}

export async function execSkillCommand(
  slashCommand: string,
  args: string,
  sm: SessionManager,
  sessionId: string,
  workspaceRoot?: string,
  channel?: { type: string; accountId: string; chatId?: string },
  /** Override for the access-level gate. When supplied, we trust the
   *  caller's value (the channel account's *current* accessLevel) over
   *  the session row's persisted snapshot — important when the admin
   *  has just bumped the channel's permissions and the user immediately
   *  fires a slash command without sending a chat message in between
   *  (which would otherwise be the only path that updates the row). */
  channelAccessLevel?: 'readonly' | 'workspace' | 'full',
  lang: Lang = 'en',
): Promise<'not_found' | 'ok' | string> {
  // Always rescan — frontmatter changes (e.g. flipping requiresAccess on
  // a deployed skill) must take effect for subsequent invocations without
  // a server restart. Reading ~10 small SKILL.md files per slash command
  // is negligible vs. the cost of getting access-level wrong.
  await scanSkillDescriptors(workspaceRoot)
  const cmdName = slashCommand.startsWith('/') ? slashCommand.slice(1) : slashCommand
  const entry = cachedEntries.find((e) => {
    if (!e.command) return false
    const slash = e.command.startsWith('/') ? e.command : `/${e.command}`
    return slash.slice(1) === cmdName
  })
  if (!entry) return 'not_found'

  // Permission check: the session's current agent must whitelist this skill
  // in its agent.yaml `skills:` list, and the skill must not be disabled.
  // The popup also filters by this set, but this is the server-side gate —
  // a user typing the slash command manually still hits it.
  const sessionInfo = sm.getSessionById(sessionId)
  if (!sessionInfo) {
    return t('skill.no_session', lang, { session: sessionId })
  }
  const yamlConfig = await loadAgentYaml(sessionInfo.agentId, workspaceRoot)
  const allowed = new Set(yamlConfig?.skills ?? [])
  if (!allowed.has(entry.id)) {
    return t('skill.not_allowed', lang, { cmd: `/${cmdName}`, agent: sessionInfo.agentName, id: entry.id })
  }
  const disabledSet = getDisabledSet(sm.getDb(), 'skill')
  if (disabledSet.has(entry.id)) {
    return t('skill.disabled', lang, { cmd: `/${cmdName}` })
  }

  // Read the SKILL.md fresh from disk for both the access-level check
  // and the body render. Reading from the cached `entry.requiresAccess`
  // is unsafe: cachedEntries is rebuilt by scanSkillDescriptors above,
  // but workspace-scoped skills (which override global skills with the
  // same id) can drift between scans, and a frontmatter edit between
  // scans must take effect immediately. One disk read per slash command
  // is negligible.
  let body = ''
  let freshRequiresAccess: 'full' | 'workspace' | 'readonly' | undefined
  try {
    const raw = await fs.readFile(entry.skillPath, 'utf-8')
    const parsed = parseSkillFrontmatter(raw)
    body = parsed.body
    freshRequiresAccess = parsed.requiresAccess
  } catch (err) {
    return t('skill.load_failed', lang, { error: err instanceof Error ? err.message : String(err) })
  }

  // Access-level gate: skill's `requiresAccess` (set in SKILL.md
  // frontmatter) must be >= the effective access level. Source of truth
  // priority:
  //   1. `channelAccessLevel` from the caller — the channel account's
  //      *current* level. Used so a recent admin change takes effect on
  //      the very next slash command, even if no chat message has yet
  //      written through to the session row.
  //   2. `sessionInfo.accessLevel` — the persisted session row. Falls
  //      back here for callers that don't pass a channel level (CLI etc).
  // Reading from in-memory `sm.sessions.get(...)?.accessLevel` was a
  // prior bug: that map only holds active sessions, so an idle one fell
  // through to "no gate" and bypassed the check.
  if (freshRequiresAccess) {
    const sessionLevel = channelAccessLevel
      ?? ((sessionInfo.accessLevel as 'readonly' | 'workspace' | 'full' | null | undefined) ?? null)
    const RANK = { readonly: 0, workspace: 1, full: 2 } as const
    const sessionRank = sessionLevel ? RANK[sessionLevel] : RANK.full
    if (RANK[freshRequiresAccess] > sessionRank) {
      return t('skill.access_required', lang, { cmd: `/${cmdName}`, required: freshRequiresAccess, current: sessionLevel ?? 'restricted' })
    }
  }

  // Same short-form rewrite as activate_skill — see agent-loader.ts.
  body = body.replace(
    /\{\{\s*params\.([\w-][\w.-]*)\s*\}\}/g,
    (_m, key: string) => `{{${entry.id}.params.${key}}}`,
  )
  const renderCtx = await buildRenderContext({ args, workspaceRoot, agentName: undefined, channel })
  // Skills only see their own params — block any cross-namespace reach (e.g.
  // a skill body referencing another skill's api_key).
  renderCtx.allowedNamespace = entry.id
  body = renderMdBody(body, renderCtx)

  // Two distinct strings:
  //   - `displayMessage` is what the user sees in their chat history. Just
  //     a one-liner marker; without this they'd see the entire SKILL.md
  //     body (which is meant for the LLM, not the user) dumped in mid-
  //     conversation and look like nonsense.
  //   - `agentMessage` is what the LLM sees as the "user turn" — it
  //     carries the full rendered skill body so the model has the
  //     instructions it needs. Args reach the body only through `$ARGUMENTS`
  //     / `$1` placeholders (rendered above); they are NOT re-appended here.
  // The channel-specific text response ("Skill /xxx activated") is
  // already produced by the caller (dispatchCommand) and printed
  // separately in the SSE / IM stream.
  const displayMessage = `[Skill activated: /${cmdName}]${args ? ` ${args}` : ''}`
  const agentMessage = `[Skill activated: /${cmdName}]\n\n${body}`
  sm.appendUserMessage(sessionId, displayMessage)
  sm.sendUserMessage(sessionId, agentMessage).catch(() => {})
  return 'ok'
}
