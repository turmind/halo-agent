import { api } from '@/shared/api-client'

export interface SlashCommand {
  name: string
  description: string
  type: 'client' | 'server'
  argHint?: string
  source?: 'builtin' | 'skill'
  skillId?: string
}

const CLIENT_FALLBACK: SlashCommand[] = [
  { name: '/new', description: 'Start a new session', type: 'client' },
  { name: '/clear', description: 'Clear chat (alias for /new)', type: 'client' },
  { name: '/context', description: 'Show context window usage and agent info', type: 'server' },
  { name: '/help', description: 'Show available commands', type: 'client' },
  { name: '/compact', description: 'Compress conversation context', type: 'server' },
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
    }))
  } catch {
    serverCommands = []
  }
}

export function getCommands(): SlashCommand[] {
  return serverCommands.length > 0 ? serverCommands : CLIENT_FALLBACK
}

export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return []
  const lower = input.toLowerCase()
  return getCommands().filter((cmd) => cmd.name.startsWith(lower))
}
