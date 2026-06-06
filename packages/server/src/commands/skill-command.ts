import fs from 'node:fs/promises'
import path from 'node:path'
import type { CommandDescriptor } from './types.js'
import { GLOBAL_SKILLS_DIR, loadAgentYaml, parseSkillFrontmatter } from '../agents/agent-loader.js'
import { buildRenderContext, renderMdBody } from '../prompts/md-vars.js'
import { getDisabledSet } from '../db/index.js'
import type { SessionManager } from '../agents/session-manager.js'

interface SkillCommandEntry {
  id: string
  name: string
  description: string
  command: string
  skillPath: string
  requiresAccess?: 'full' | 'workspace' | 'readonly'
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
      const { name, description, command, requiresAccess } = parseSkillFrontmatter(content)
      if (command) {
        entries.push({ id: entryName, name: name || entryName, description: description ?? '', command, skillPath: skillMdPath, requiresAccess })
      }
    } catch { /* skip */ }
  }
  return entries
}

let cachedEntries: SkillCommandEntry[] = []

export async function scanSkillDescriptors(workspaceRoot?: string): Promise<CommandDescriptor[]> {
  const globalEntries = await scanDir(GLOBAL_SKILLS_DIR)
  let wsEntries: SkillCommandEntry[] = []
  if (workspaceRoot) {
    wsEntries = await scanDir(path.join(workspaceRoot, '.halo', 'skills'))
  }
  const merged = new Map<string, SkillCommandEntry>()
  for (const e of globalEntries) merged.set(e.id, e)
  for (const e of wsEntries) merged.set(e.id, e)
  cachedEntries = Array.from(merged.values())
  return cachedEntries.map((entry) => {
    const slashName = entry.command.startsWith('/') ? entry.command : `/${entry.command}`
    return {
      name: slashName.slice(1),
      slashName,
      description: entry.description,
      type: 'server' as const,
      source: 'skill' as const,
      skillId: entry.id,
      requiresAccess: entry.requiresAccess,
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
): Promise<'not_found' | 'ok' | string> {
  // Always rescan — frontmatter changes (e.g. flipping requiresAccess on
  // a deployed skill) must take effect for subsequent invocations without
  // a server restart. Reading ~10 small SKILL.md files per slash command
  // is negligible vs. the cost of getting access-level wrong.
  await scanSkillDescriptors(workspaceRoot)
  const cmdName = slashCommand.startsWith('/') ? slashCommand.slice(1) : slashCommand
  const entry = cachedEntries.find((e) => {
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
    return `Cannot resolve session ${sessionId} for permission check.`
  }
  const yamlConfig = await loadAgentYaml(sessionInfo.agentId, workspaceRoot)
  const allowed = new Set(yamlConfig?.skills ?? [])
  if (!allowed.has(entry.id)) {
    return `Skill /${cmdName} is not available to agent "${sessionInfo.agentName}". Add "${entry.id}" to the agent's skills list to enable.`
  }
  const disabledSet = getDisabledSet(sm.getDb(), 'skill')
  if (disabledSet.has(entry.id)) {
    return `Skill /${cmdName} is disabled for this workspace.`
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
    return `Failed to load skill: ${err instanceof Error ? err.message : String(err)}`
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
      return `Skill /${cmdName} requires ${freshRequiresAccess} access; this session has ${sessionLevel ?? 'restricted'}.`
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
  //     instructions it needs.
  // The channel-specific text response ("Skill /xxx activated") is
  // already produced by the caller (dispatchCommand) and printed
  // separately in the SSE / IM stream.
  const displayMessage = `[Skill activated: /${cmdName}]${args ? ` ${args}` : ''}`
  const agentMessage = `[Skill activated: /${cmdName}]\n\n${body}${args ? `\n\n${args}` : ''}`
  sm.appendUserMessage(sessionId, displayMessage)
  sm.sendUserMessage(sessionId, agentMessage).catch(() => {})
  return 'ok'
}
