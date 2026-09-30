import { api } from '@/shared/api-client'
import { useGoalStore } from './goal-store'

export interface SlashCommand {
  name: string
  description: string
  type: 'client' | 'server'
  argHint?: string
  source?: 'builtin' | 'skill'
  skillId?: string
  /** Declared sub-actions of an object command (e.g. /agent list|create…).
   *  Drives second-stage completion: type the command + space → pick a verb. */
  verbs?: Array<{ name: string; desc?: string }>
}

const CLIENT_FALLBACK: SlashCommand[] = [
  { name: '/session', description: 'Manage sessions (new/list/switch/stop/interrupt/compact/context)', type: 'server', argHint: '<verb>' },
  { name: '/clear', description: 'Clear chat (alias for /session new)', type: 'client' },
  { name: '/help', description: 'Show available commands', type: 'client' },
]

let serverCommands: SlashCommand[] = []

export async function refreshCommands(projectId?: string, sessionId?: string, agentId?: string): Promise<void> {
  try {
    const data = await api.commands.list(projectId, sessionId, agentId)
    serverCommands = data.commands.map((d) => ({
      name: d.slashName,
      description: d.description,
      type: d.type,
      argHint: d.argHint,
      source: d.source,
      skillId: d.skillId,
      verbs: d.verbs,
    }))
  } catch {
    serverCommands = []
  }
}

export function getCommands(): SlashCommand[] {
  const commands = serverCommands.length > 0 ? serverCommands : CLIENT_FALLBACK
  return useGoalStore.getState().enabled ? commands : commands.filter((cmd) => cmd.name !== '/goal')
}

export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return []
  const lower = input.toLowerCase()
  return getCommands().filter((cmd) => cmd.name.startsWith(lower))
}

/** Second-stage completion: after `/cmd ` (command typed in full + space),
 *  suggest its verbs filtered by the partial verb typed so far. Returns []
 *  for non-object commands or when a verb is already complete (followed by
 *  more args). */
export function matchVerbs(text: string): Array<{ cmd: SlashCommand; verb: { name: string; desc?: string } }> {
  const m = text.match(/^(\/\S+)\s+(\S*)$/)
  if (!m) return []
  const cmd = getCommands().find((c) => c.name === m[1].toLowerCase())
  if (!cmd?.verbs?.length) return []
  const partial = m[2].toLowerCase()
  return cmd.verbs
    .filter((v) => v.name.startsWith(partial) && v.name !== partial)
    .map((verb) => ({ cmd, verb }))
}
