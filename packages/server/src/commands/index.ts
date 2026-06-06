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
commandRegistry.registerDescriptor({ name: 'agents',  slashName: '/agents',  description: 'List available agents',                  type: 'server', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'agent',   slashName: '/agent',   description: 'Start a session with a specific agent',  type: 'server', argHint: '<name|index>', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'ws',      slashName: '/ws',      description: 'Show or switch workspace',               type: 'server', argHint: '[path]', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'note',    slashName: '/note',    description: 'Queue an evolution run on this session (requires evolution.level: L1)', type: 'server', argHint: '[hint]', source: 'builtin' })
