import { CommandRegistry } from './registry.js'

export const commandRegistry = new CommandRegistry()

// Command descriptors — single source of truth for the frontend command
// palette, the slash-suggest popup, and `/help` text. Every command listed
// here must have a server-side handler in dispatchCommand
// (channels/shared/commands.ts) so wechat / telegram / web / web-demo
// users can run it. Admin Web UI may additionally intercept some of these
// for nicer local UX (e.g. /new / /help in use-chat.ts), but server-side
// must work too — those intercepts are an optimisation, not a contract.
//
// Pure client-only shortcuts (e.g. /clear in admin Web UI) DO NOT belong
// here. They live as hardcoded keys in the relevant frontend handler so
// non-admin channels never see them in /help and never send them to the
// server expecting a response.
//
// type field is currently only 'server'. Pre-existing 'client' values
// were a leak of an admin-UI-only concept into the cross-channel
// registry; it caused web-demo / wechat / telegram to list dead commands.

commandRegistry.registerDescriptor({ name: 'help',    slashName: '/help',    description: 'Show available commands',                type: 'server', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'new',     slashName: '/new',     description: 'Start a new session',                    type: 'server', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'list',    slashName: '/list',    description: 'List recent sessions',                   type: 'server', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'switch',  slashName: '/switch',  description: 'Switch to a session by index',           type: 'server', argHint: '<n>', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'stop',    slashName: '/stop',    description: 'Stop the running agent task',            type: 'server', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'interrupt', slashName: '/interrupt', description: 'Interrupt the running task (queued messages run next)', type: 'server', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'compact', slashName: '/compact', description: 'Compress conversation context',          type: 'server', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'context', slashName: '/context', description: 'Show context window + agent info',       type: 'server', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'ws',      slashName: '/ws',      description: 'Show or switch workspace',               type: 'server', argHint: '[path]', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'evo',     slashName: '/evo',     description: 'Queue an evolution run on this session', type: 'server', argHint: '[hint]', source: 'builtin' })
// Object command: list/switch/desc/delete run as builtin verbs (work on every
// agent); create/update fall through to the `agent` skill. Always registered
// so it doesn't depend on the skill being whitelisted.
commandRegistry.registerDescriptor({ name: 'agent',   slashName: '/agent',   description: 'Manage agents (list/switch/desc/delete; create/update via skill)', type: 'server', argHint: '<verb>', source: 'builtin' })

/** Names (no leading slash) of every registered builtin command. Single source
 *  of truth for channels that need to enumerate commands — e.g. Telegram's
 *  `bot.command()` registration and Slack's `/`→`!` rewrite — so adding a
 *  command here can't silently drift out of a hardcoded per-channel list. */
export function builtinCommandNames(): string[] {
  return commandRegistry.listDescriptors()
    .filter((d) => d.source === 'builtin')
    .map((d) => d.name)
}
