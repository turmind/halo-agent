import { eq } from 'drizzle-orm'
import { getDisabledSet, type HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { loadAgentYaml } from './agent-loader.js'
import { scanSkillDescriptors } from '../commands/skill-command.js'
import type { CommandDescriptor } from '../commands/types.js'

const VIS_RANK = { readonly: 0, workspace: 1, full: 2 } as const

/** A command's /help visibility threshold = the lowest gate among its verbs
 *  (each verb's own requiresAccess, else the command's object-level one). No
 *  verbs → just the object-level requiresAccess. undefined → no gate (some
 *  verb open to everyone). Mirrors the verb-access rule on the dispatch side;
 *  kept here (not imported) to avoid a channels→agents layering cycle. */
function commandVisibilityGate(d: CommandDescriptor): 'full' | 'workspace' | 'readonly' | undefined {
  if (!d.verbs || d.verbs.length === 0) return d.requiresAccess
  let min: number | undefined
  for (const v of d.verbs) {
    const ra = v.requiresAccess ?? d.requiresAccess
    const r = ra ? VIS_RANK[ra] : 0
    min = min === undefined ? r : Math.min(min, r)
  }
  if (min === undefined || min === 0) return undefined
  return min === VIS_RANK.full ? 'full' : 'workspace'
}

/**
 * Surface that SessionSkillCommands needs from SessionManager. Both are pure
 * reads (db row + workspace files), so the host is just db + workspaceRoot.
 */
export interface SessionSkillCommandsHost {
  readonly workspaceRoot: string
  getDb(): HaloDb
}

/**
 * SessionSkillCommands — resolves which skill-backed slash commands an agent is
 * allowed to invoke (yaml `skills:` whitelist ∩ not-disabled ∩ access gate).
 * Carved out of SessionManager (fourth knife); stateless, all reads. This is
 * the source of truth for both the slash-suggest popup and the server-side
 * permission check in execSkillCommand.
 */
export class SessionSkillCommands {
  private db: HaloDb

  constructor(private host: SessionSkillCommandsHost) {
    this.db = host.getDb()
  }

  /**
   * List skill commands the given session's agent is *allowed* to invoke.
   *
   * A skill is invokable only if:
   *   1. Its SKILL.md frontmatter declares a `command:`
   *   2. The agent's yaml has it in `skills:` (whitelist)
   *   3. It hasn't been disabled in the workspace's `disabled_items` table
   *
   * This is the source of truth for both the slash-suggest popup *and* the
   * server-side permission check in `execSkillCommand` — every channel (TUI,
   * WS, WeChat, Telegram, etc.) should call this rather than rolling its own.
   *
   * Returns an empty list if the session is unknown or its agent declares no
   * skills. Builtin commands are NOT included — combine with
   * `commandRegistry.listDescriptors()` if you also want builtins.
   */
  async listAvailableSkillCommands(sessionId: string): Promise<CommandDescriptor[]> {
    const row = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()
    if (!row) {
      // Cold start (e.g. internal-session resume) → fall back to the
      // by-agent path with no access gate, since we have no session
      // info yet.
      return this.listAvailableSkillCommandsForAgent('default')
    }
    // Persisted access_level is the source of truth. The in-memory
    // `this.sessions.get(...)` map only holds *active* sessions (agent
    // currently loaded); reading from there meant a session that wasn't
    // mid-turn fell through to "no access gate" and saw skills it lacks
    // permission for in /help.
    const access = (row.accessLevel as 'readonly' | 'workspace' | 'full' | null | undefined) ?? null
    return this.listAvailableSkillCommandsForAgent(row.agentId, access)
  }

  /** Same gate as `listAvailableSkillCommands`, but keyed off an agent id
   *  instead of a session id. Used by the admin chat UI's slash-command
   *  popup BEFORE a session exists — the user has selected an agent in the
   *  dropdown, so we know which `skills:` whitelist to filter against. */
  async listAvailableSkillCommandsForAgent(
    agentId: string,
    accessLevel?: 'readonly' | 'workspace' | 'full' | null,
  ): Promise<CommandDescriptor[]> {
    const yamlConfig = await loadAgentYaml(agentId, this.host.workspaceRoot)
    const allowed = new Set(yamlConfig?.skills ?? [])
    if (allowed.size === 0) return []
    const disabledSet = getDisabledSet(this.db, 'skill')
    const all = await scanSkillDescriptors(this.host.workspaceRoot)
    const RANK = { readonly: 0, workspace: 1, full: 2 } as const
    // null means "no gate" (CLI / pre-session admin UI), explicit 'full'
    // also means full access.
    const sessionRank = accessLevel ? RANK[accessLevel] : RANK.full
    return all.filter((d) => {
      const skillId = d.skillId ?? d.name
      if (!allowed.has(skillId)) return false
      if (disabledSet.has(skillId)) return false
      // Visibility threshold = the lowest gate among the command's verbs (each
      // verb's own requiresAccess, else the object-level one). A command with
      // no verbs just uses its object-level requiresAccess. Show it if the user
      // clears that lowest bar — which verbs exactly is refined by `/cmd help`.
      const gate = commandVisibilityGate(d)
      if (gate && RANK[gate] > sessionRank) return false
      return true
    })
  }
}
