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
// Object commands declare their builtin verbs here so completion UIs (admin
// palette, TUI) can suggest them. Keep in sync with SUBCOMMAND_ROUTES — skill
// verbs (e.g. agent create/update) come from the skill's SKILL.md instead.
commandRegistry.registerDescriptor({ name: 'session', slashName: '/session', description: 'Manage sessions', type: 'server', argHint: '<verb>', source: 'builtin', verbs: [
  { name: 'new', builtin: true, desc: 'Start a new session' },
  { name: 'list', builtin: true, desc: 'List recent sessions' },
  { name: 'switch', builtin: true, desc: 'Switch to a session by index' },
  { name: 'stop', builtin: true, desc: 'Stop the running agent task' },
  { name: 'interrupt', builtin: true, desc: 'Interrupt the running task' },
  { name: 'compact', builtin: true, desc: 'Compress conversation context' },
  { name: 'context', builtin: true, desc: 'Show context window + agent info' },
] })
commandRegistry.registerDescriptor({ name: 'ws',      slashName: '/ws',      description: 'Manage the workspace', type: 'server', argHint: '<verb>', source: 'builtin', verbs: [
  { name: 'info', builtin: true, desc: 'Show the current workspace' },
  { name: 'switch', builtin: true, desc: 'Switch workspace (absolute path)' },
  { name: 'setup', builtin: true, desc: 'Set up the .halo knowledge files' },
  { name: 'tidy', builtin: true, desc: 'Tidy/prune the .halo knowledge files' },
  { name: 'share', builtin: true, desc: 'Package the workspace config as a shareable zip' },
] })
commandRegistry.registerDescriptor({ name: 'evo',     slashName: '/evo',     description: 'Queue an evolution run on this session', type: 'server', argHint: '[hint]', source: 'builtin' })
// Object command: list/switch/desc/delete run as builtin verbs (work on every
// agent); create/update fall through to the `agent` skill. Always registered
// so it doesn't depend on the skill being whitelisted.
commandRegistry.registerDescriptor({ name: 'agent',   slashName: '/agent',   description: 'Manage agents', type: 'server', argHint: '<verb>', source: 'builtin', verbs: [
  { name: 'list', builtin: true, desc: 'List usable agents' },
  { name: 'switch', builtin: true, desc: 'Start a session with an agent' },
  { name: 'desc', builtin: true, desc: "Show an agent's model / tools / skills" },
  { name: 'delete', builtin: true, desc: 'Delete an agent (workspace or global)' },
  { name: 'create', desc: 'Create a new agent' },
  { name: 'update', desc: 'Modify an existing agent' },
] })
commandRegistry.registerDescriptor({ name: 'skill',   slashName: '/skill',   description: 'Manage skills', type: 'server', argHint: '<verb>', source: 'builtin', verbs: [
  { name: 'list', builtin: true, desc: 'List all skills (with disabled/overridden flags)' },
  { name: 'desc', builtin: true, desc: "Show a skill's description and status" },
  { name: 'disable', builtin: true, desc: 'Disable a skill (this workspace)' },
  { name: 'enable', builtin: true, desc: 'Enable a skill (this workspace)' },
  { name: 'delete', builtin: true, desc: 'Delete a skill (workspace or global)' },
  { name: 'create', desc: 'Create a new skill' },
  { name: 'update', desc: 'Modify an existing skill' },
] })

/** Names (no leading slash) of every registered builtin command. Single source
 *  of truth for channels that need to enumerate commands — e.g. Telegram's
 *  `bot.command()` registration and Slack's `/`→`!` rewrite — so adding a
 *  command here can't silently drift out of a hardcoded per-channel list. */
export function builtinCommandNames(): string[] {
  return commandRegistry.listDescriptors()
    .filter((d) => d.source === 'builtin')
    .map((d) => d.name)
}
