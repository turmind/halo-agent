import path from 'node:path'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { initRuntime, createHarness, listAgents, type Harness } from './harness.js'
import { runCli } from './cli.js'
import { runTui } from './tui.js'
import type { Lang } from '@turmind/halo-server/channels/shared/i18n'

const VERSION = '0.1.0'

const HELP_TOP = `Usage: halo <command> [options]

Commands:
  setup                Initialize ~/.halo/global/ (run once after install)
  tui                  Start interactive TUI
  cli "<prompt>"       Run a one-shot prompt and exit (or pipe via stdin)
  server               Start the HTTP/WS server + admin web UI
  agents               List available agents and exit
  sessions             List recent sessions and exit
  acp                  Bridge a halo server to an ACP client (stdio)
  --help, -h           Show this help
  --version            Show version

Run \`halo <command> --help\` for command-specific options.
`

const HELP_SETUP = `Usage: halo setup [--non-interactive]

Interactive setup. Run once after install, and again any time you want to
reset the admin password, change the listen port, or update API keys.

Steps:
  1. Seed/refresh ~/.halo/global/ templates (per-category overwrite policy)
  2. Pick admin password mode: keep / set new / use HALO_PASSWORD env
  3. Prompt for listen port (default 9527; Enter to keep current)
  4. Configure model provider keys (optional sub-menu)
  5. Toggle optional skills (tavily / nova / aws-knowledge), then walk
     their secret fields

Options:
  --non-interactive, -y    Skip every prompt. Only seed templates and
                            ensure jwt_secret exists. Intended for Docker
                            / CI: pair with HALO_PASSWORD env, mount
                            ~/.halo/secrets/settings.yaml and
                            ~/.halo/global/.installed-optional-skills
                            from your image build.

Forgot the password? Blank server.password.value in
~/.halo/secrets/config.yaml and re-run \`halo setup\`.
`

const HELP_TUI = `Usage: halo tui [options]

Start the interactive TUI in the given workspace. Multi-turn chat with
slash commands (/help inside the TUI for the full list).

Options:
  -w, --workspace <path>     Workspace path (default: cwd)
  -a, --agent <id>           Agent ID (default: default)
  -s, --session <id>         Resume session by ID
  -n, --new                  Always start a new session
  --access <level>           full | workspace | readonly (default: full)
  --lang <lang>              en | zh (default: en)
  -v, --verbose              Show tool args + truncated result inline
  -h, --help                 Show this help

Examples:
  halo tui
  halo tui -v
  halo tui -w /path/to/project
  halo tui -s sid_abc123
`

const HELP_CLI = `Usage: halo cli [options] "<prompt>"
       echo "<prompt>" | halo cli [options]

Run a one-shot prompt and exit. Combines positional args + stdin into
the message; stdin is appended after positional text.

Options:
  -w, --workspace <path>     Workspace path (default: cwd)
  -a, --agent <id>           Agent ID (default: default)
  -s, --session <id>         Resume session by ID
  -n, --new                  Always start a new session
  --access <level>           full | workspace | readonly (default: full)
  --lang <lang>              en | zh (default: en)
  -f, --format <fmt>         text | json (default: text)
  -v, --verbose              Show tool calls + usage on stderr
  -h, --help                 Show this help

Exit codes: 0 = ok, 1 = error, 130 = SIGINT.

Examples:
  halo cli "review this diff"
  halo cli -w /path/to/project -a coder "fix the failing test"
  git diff | halo cli "summarize changes"
  halo cli --format json "analyze" | jq '.text'
`

const HELP_SERVER = `Usage: halo server <subcommand> [options]

Manage the HTTP/WS server lifecycle.

Subcommands:
  start [-d] [-p N]     Start the server. Foreground unless -d (daemon).
  stop [--force]        Stop the running server (SIGTERM, then SIGKILL after 5s).
  restart [-p N]        Stop + start (always daemon).
  status                Show whether the server is running and on what port.
  logs [-f] [-n N]      Tail the server log file.

Common options:
  -p, --port <n>        Listen port (default: 9527)
  -d, --daemon          Detach and run in the background (start only)
  -h, --help            Show this help

Port resolution: --port flag > HALO_PORT env > config.yaml > 9527.

Daemon logs go to ~/.halo/logs/server.log; pidfile is
~/.halo/global/server.lock.
`

const HELP_AGENTS = `Usage: halo agents [options]

List available agents in the workspace (workspace > global precedence).

Options:
  -w, --workspace <path>     Workspace path (default: cwd)
  -h, --help                 Show this help
`

const HELP_SESSIONS = `Usage: halo sessions [options]

List recent sessions persisted in the workspace.

Options:
  -w, --workspace <path>     Workspace path (default: cwd)
  -h, --help                 Show this help
`

const HELP_ACP = `Usage: halo acp --host <h> --port <p> --token <t> --workspace <path> [--agent-id <id>]

Bridge a running halo server to an ACP (Agent Client Protocol) client
such as Claude Code. Reads JSON-RPC requests on stdin, writes responses
+ session/update notifications on stdout. Stderr is for diagnostics.

Flags:
  --host <h>             halo server hostname / IP
  --port <p>             halo server port (e.g. 9527)
  --token <t>            web-channel token (admin → Channels → Web → copy
                          token). For multi-workspace use, must be a
                          full-access token.
  --workspace <path>     absolute path of the workspace to drive. One
                          adapter process binds to one workspace; run N
                          adapters with the same token to drive N
                          workspaces concurrently.
  --agent-id <id>        optional agent profile (default: 'default')

ACP method coverage:
  initialize, authenticate, session/new, session/prompt, session/cancel.
  session/load, reverse fs/terminal, requestPermission are NOT
  implemented — see .halo/docs/dev/acp-adapter.md for the full matrix.
`

const HELP_BY_CMD: Record<string, string> = {
  setup: HELP_SETUP,
  tui: HELP_TUI,
  cli: HELP_CLI,
  server: HELP_SERVER,
  agents: HELP_AGENTS,
  sessions: HELP_SESSIONS,
  acp: HELP_ACP,
}

/** Parse common harness-related flags shared by tui / cli / agents / sessions. */
interface HarnessFlags {
  workspace?: string
  agent?: string
  session?: string
  new?: boolean
  access: 'full' | 'workspace' | 'readonly'
  lang: Lang
  positionals: string[]
  // cli-only
  format: 'text' | 'json'
  verbose: boolean
}

function parseHarnessFlags(argv: string[]): HarnessFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workspace: { type: 'string', short: 'w' },
      agent: { type: 'string', short: 'a' },
      session: { type: 'string', short: 's' },
      new: { type: 'boolean', short: 'n', default: false },
      format: { type: 'string', short: 'f', default: 'text' },
      verbose: { type: 'boolean', short: 'v', default: false },
      access: { type: 'string', default: 'full' },
      lang: { type: 'string', default: 'en' },
    },
  })
  return {
    workspace: values.workspace,
    agent: values.agent,
    session: values.session,
    new: values.new,
    access: (values.access as 'full' | 'workspace' | 'readonly') ?? 'full',
    lang: (values.lang as Lang) ?? 'en',
    positionals,
    format: (values.format as 'text' | 'json') ?? 'text',
    verbose: values.verbose ?? false,
  }
}

async function buildHarnessFromFlags(flags: HarnessFlags): Promise<Harness> {
  return createHarness({
    workspace: flags.workspace ?? process.cwd(),
    agentId: flags.agent,
    sessionId: flags.session,
    newSession: flags.new,
    accessLevel: flags.access,
    lang: flags.lang,
  })
}

function attachSigint(harness: Harness): void {
  // First hit: graceful stop + destroy; second hit: hard exit.
  let sigintCount = 0
  process.on('SIGINT', () => {
    sigintCount++
    if (sigintCount >= 2) {
      process.stderr.write('\nForce exit.\n')
      process.exit(130)
    }
    harness.stop().finally(() => {
      harness.destroy()
      process.exit(130)
    })
  })
}

async function cmdSetup(argv: string[] = []): Promise<void> {
  const { ensureHaloHome, readInstalledOptionalSkills, writeInstalledOptionalSkills } = await import('@turmind/halo-server/init')
  const { hashPassword, generateJwtSecret } = await import('@turmind/halo-server/middleware/password-hash')
  const { updateConfigLeaves, configLeafSet, readConfigLeaf } = await import('@turmind/halo-server/setup-config')
  const { readSetting, writeSetting, maskSecret } = await import('@turmind/halo-server/setup-settings')
  const { listModelProviders, listOptionalSkills, listRequiredSkillsWithSecrets } = await import('@turmind/halo-server/setup-providers')
  const { promptText, promptPassword, promptSelect, promptMultiSelect } = await import('./setup-prompts.js')

  // `--non-interactive` (alias `-y`) — for Dockerfile / CI: skip all prompts,
  // only run the file seeding + ensure jwt_secret exists. Password is left
  // empty in config.yaml so runtime falls back to HALO_PASSWORD env.
  // Optional skills / model secrets must be pre-staged via the layout
  // documented in getting-started.md (mount `~/.halo/secrets/settings.yaml`
  // and `~/.halo/global/.installed-optional-skills` into the container).
  const nonInteractive = argv.includes('--non-interactive') || argv.includes('-y')

  const haloHome = path.join(homedir(), '.halo')
  const globalDir = path.join(haloHome, 'global')

  // 1. Seed / refresh templates. ensureHaloHome's policy is "platform-owned
  //    files always overwrite, user-owned files left alone, config.yaml leaf-merged".
  ensureHaloHome(haloHome)
  process.stderr.write(`[setup] ${haloHome}/ ready\n`)

  if (nonInteractive) {
    // Make sure jwt_secret is set (cookie signing) — generate if missing.
    if (!configLeafSet('server.jwt_secret')) {
      updateConfigLeaves({ 'server.jwt_secret': generateJwtSecret() })
    }
    // HALO_PORT env can override the listed port at runtime; nothing to do here.
    process.stderr.write(`[setup] non-interactive mode — skipping prompts\n`)
    if (!process.env.HALO_PASSWORD || process.env.HALO_PASSWORD.length === 0) {
      if (!configLeafSet('server.password')) {
        process.stderr.write(`[setup] WARNING: no password set. Either set HALO_PASSWORD env, or re-run \`halo setup\` interactively.\n`)
      }
    }
    process.stderr.write(`[setup] done\n`)
    return
  }

  process.stderr.write('\n')

  // 2. Admin password — single-select with three modes.
  await stepPassword()

  // 3. Listen port (Enter to keep current).
  await stepPort()

  // 4. Model provider secrets (optional sub-menu).
  await stepModelProviders()

  // 5. Optional skills (toggle list + post-install secret walk).
  await stepOptionalSkills()

  // 6. Required-skill secrets that have non-empty `params:` declarations
  //    (e.g. send-file currently doesn't, but if any required skill ever
  //    needs a secret, walk them once at the end).
  await stepRequiredSkillSecrets()

  // Make sure jwt_secret is set even when the user declined to touch the password
  // (config.yaml leaf-merge ensures the field exists; this fills it on first run
  // when the leaf was just created with `value: ""`).
  if (!configLeafSet('server.jwt_secret')) {
    updateConfigLeaves({ 'server.jwt_secret': generateJwtSecret() })
  }

  process.stderr.write('\n[setup] done\n')

  // ── step impls ─────────────────────────────────────────────────────────

  async function stepPassword(): Promise<void> {
    const passwordSet = configLeafSet('server.password')
    const envSet = process.env.HALO_PASSWORD ? process.env.HALO_PASSWORD.length > 0 : false

    const options = passwordSet || envSet
      ? [
          { value: 'keep',  label: 'Keep current' },
          { value: 'set',   label: 'Set / change password' },
          { value: 'env',   label: 'Use HALO_PASSWORD env (no hash stored)' },
        ]
      : [
          // First-time setup must produce a working credential — no "keep" option.
          { value: 'set',   label: 'Set a new password' },
          { value: 'env',   label: 'Use HALO_PASSWORD env (no hash stored)' },
        ]

    const choice = await promptSelect('Admin password (you can also re-run `halo setup` later):', options)
    if (choice == null) abort()
    if (choice === 'keep') {
      process.stderr.write('[setup] password unchanged\n\n')
      return
    }
    if (choice === 'env') {
      // Clear any stored hash so the env takes effect at runtime. JWT must
      // still exist for cookie signing.
      updateConfigLeaves({ 'server.password': '' })
      if (!configLeafSet('server.jwt_secret')) {
        updateConfigLeaves({ 'server.jwt_secret': generateJwtSecret() })
      }
      process.stderr.write('[setup] using HALO_PASSWORD env (set it before launching server)\n\n')
      return
    }
    // 'set'
    const plain = await collectPassword()
    if (plain == null) abort()
    const hash = await hashPassword(plain)
    const jwt = generateJwtSecret()
    updateConfigLeaves({ 'server.password': hash, 'server.jwt_secret': jwt })
    process.stderr.write('[setup] password + jwt_secret saved\n\n')
  }

  async function collectPassword(): Promise<string | null> {
    while (true) {
      const a = await promptPassword('New password')
      if (a == null) return null
      if (a.length < 4) {
        process.stderr.write('  Password must be at least 4 characters.\n')
        continue
      }
      const b = await promptPassword('Confirm password')
      if (b == null) return null
      if (a !== b) {
        process.stderr.write("  Passwords don't match. Try again.\n")
        continue
      }
      return a
    }
  }

  async function stepPort(): Promise<void> {
    const currentPort = typeof readConfigLeaf('server.port') === 'number'
      ? String(readConfigLeaf('server.port'))
      : '9527'
    const next = await promptText(`Listen port (Enter to keep ${currentPort})`, currentPort)
    if (next == null) abort()
    if (next === currentPort) {
      process.stderr.write('\n')
      return
    }
    const n = parseInt(next, 10)
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      process.stderr.write(`  Invalid port: ${next} — keeping ${currentPort}.\n\n`)
      return
    }
    updateConfigLeaves({ 'server.port': n })
    process.stderr.write(`[setup] port saved (${n})\n\n`)
  }

  async function stepModelProviders(): Promise<void> {
    const providers = listModelProviders()
    if (providers.length === 0) return

    const enter = await promptSelect('Configure model provider keys now? (you can also re-run `halo setup` later)', [
      { value: 'skip', label: 'Skip' },
      { value: 'go',   label: 'Configure...' },
    ])
    if (enter == null) abort()
    if (enter === 'skip') {
      process.stderr.write('\n')
      return
    }

    while (true) {
      const opts = providers.map((p) => ({
        value: p.id,
        label: p.displayName,
        hint: providerStatusHint(p.id, p.fields),
      }))
      opts.push({ value: '__done__', label: '── Done', hint: '' })

      const pick = await promptSelect('Pick a provider to configure (Done when finished):', opts)
      if (pick == null) abort()
      if (pick === '__done__') break
      const provider = providers.find((p) => p.id === pick)
      if (!provider) continue
      await configureSecretGroup(provider.id, provider.bucket, provider.fields)
    }
    process.stderr.write('\n')
  }

  async function stepOptionalSkills(): Promise<void> {
    const skills = listOptionalSkills()
    if (skills.length === 0) return

    const enter = await promptSelect('Install / configure optional skills? (you can also re-run `halo setup` later)', [
      { value: 'skip', label: 'Skip' },
      { value: 'go',   label: 'Open menu...' },
    ])
    if (enter == null) abort()
    if (enter === 'skip') {
      process.stderr.write('\n')
      return
    }

    const installed = new Set(readInstalledOptionalSkills(globalDir))
    const opts = skills.map((s) => ({
      value: s.id,
      label: s.name,
      hint: s.description.slice(0, 80),
      checked: installed.has(s.id),
    }))

    const picked = await promptMultiSelect('Toggle optional skills (space to toggle, enter to confirm):', opts)
    if (picked == null) abort()
    const newSet = new Set(picked)

    // Persist marker — init.ts force-copies these from templates/optional-skills/
    // on every server start, so updates propagate. We trigger the same loop now
    // so the user can configure secrets immediately after setup.
    writeInstalledOptionalSkills(globalDir, [...newSet].sort())
    // Re-run ensureHaloHome so the actual skill files get copied right now
    // (without restarting the server). This is a no-op for already-synced skills.
    ensureHaloHome(haloHome)

    // For each newly-installed skill that has secret/param fields, walk them.
    for (const id of newSet) {
      const skill = skills.find((s) => s.id === id)
      if (!skill || skill.fields.length === 0) continue
      process.stderr.write(`\n— ${skill.name} (${skill.id}) —\n`)
      await configureSecretGroup(skill.id, skill.bucket, skill.fields)
    }
    process.stderr.write('\n')
  }

  async function stepRequiredSkillSecrets(): Promise<void> {
    const skills = listRequiredSkillsWithSecrets()
    if (skills.length === 0) return
    process.stderr.write('Required skills with configurable values:\n')
    for (const skill of skills) {
      await configureSecretGroup(skill.id, skill.bucket, skill.fields)
    }
    process.stderr.write('\n')
  }

  function providerStatusHint(id: string, fields: Array<{ key: string; secret?: boolean }>): string {
    if (fields.length === 0) return '[no keys needed]'
    const filled = fields.filter((f) => {
      const v = readSetting(`${id}.secrets.${f.key}`)
      return v != null && v.length > 0
    }).length
    if (filled === 0) return '[not configured]'
    if (filled === fields.length) return '[configured]'
    return `[${filled}/${fields.length} configured]`
  }

  /** For each declared field, show its current state (masked if secret) and let
   *  the user keep / change / clear it. Bucket is `secrets` for providers and
   *  `params` for skills. */
  async function configureSecretGroup(
    namespaceId: string,
    bucket: 'secrets' | 'params',
    fields: Array<{ key: string; description: string; secret?: boolean; envFallback?: string }>,
  ): Promise<void> {
    if (fields.length === 0) {
      process.stderr.write(`  ${namespaceId}: no configurable values\n`)
      return
    }
    for (const field of fields) {
      const dotPath = `${namespaceId}.${bucket}.${field.key}`
      const current = readSetting(dotPath)
      const isSet = current != null && current.length > 0

      // Env fallback semantics: a yaml `default: <<NAME>>` means runtime
      // will read process.env.NAME if the user leaves the field unset.
      // We surface this so the user knows "leaving blank ≠ broken".
      const envName = field.envFallback
      const envVal = envName ? process.env[envName] : undefined
      const envHasVal = envVal != null && envVal.length > 0

      const display = isSet
        ? (field.secret ? maskSecret(current!) : current!)
        : envName
          ? (envHasVal
              ? `(unset — will use env $${envName} = ${field.secret ? maskSecret(envVal!) : envVal})`
              : `(unset — will use env $${envName}, currently empty)`)
          : '(not set)'
      process.stderr.write(`  ${field.key}: ${display}\n`)
      if (field.description) {
        process.stderr.write(`    \x1b[2m${field.description}\x1b[0m\n`)
      }

      // Build action list. The "keep / skip" label adapts to the current
      // state and the existence of an env fallback.
      const keepLabel = isSet
        ? 'Keep current value'
        : envName
          ? `Use env $${envName}`
          : 'Skip (leave unset)'

      const action = await promptSelect('  ?', [
        { value: 'keep',   label: keepLabel },
        { value: 'change', label: isSet ? 'Change' : 'Set explicit value' },
        ...(isSet ? [{ value: 'clear', label: 'Clear' }] : []),
      ])
      if (action == null) abort()
      if (action === 'keep') continue
      if (action === 'clear') {
        writeSetting(dotPath, null)
        process.stderr.write(`    cleared\n`)
        continue
      }
      // 'change'
      const skipHint = envName ? `Enter to use env $${envName}` : 'Enter to leave unset'
      const promptLabel = `  New ${field.key} (${skipHint})`
      const newVal = field.secret
        ? await promptPassword(promptLabel)
        : await promptText(promptLabel)
      if (newVal == null) abort()
      if (newVal.length === 0) {
        // Empty input == leave the existing value alone (or stay unset on
        // first-time setup). Treat as a no-op rather than a clear.
        process.stderr.write(`    skipped\n`)
        continue
      }
      writeSetting(dotPath, newVal)
      process.stderr.write(`    saved\n`)
    }
  }

  function abort(): never {
    process.stderr.write('[setup] aborted\n')
    process.exit(130)
  }
}

async function cmdAgents(flags: HarnessFlags): Promise<void> {
  await initRuntime()
  const workspace = path.resolve(flags.workspace ?? process.cwd())
  const agents = await listAgents(workspace)
  if (agents.length === 0) {
    process.stderr.write('No agents found.\n')
    return
  }
  for (const a of agents) {
    const scope = a.scope === 'workspace' ? '[ws]' : '[global]'
    const desc = a.description ? ` — ${a.description}` : ''
    process.stdout.write(`${scope} ${a.id}${desc}\n`)
  }
}

async function cmdSessions(flags: HarnessFlags): Promise<void> {
  await initRuntime()
  const workspace = path.resolve(flags.workspace ?? process.cwd())
  const { listSessions } = await import('./harness.js')
  const sessions = listSessions(workspace)
  if (sessions.length === 0) {
    process.stderr.write('No sessions found.\n')
    return
  }
  for (const s of sessions) {
    const ts = new Date(s.createdAt).toISOString().slice(0, 19).replace('T', ' ')
    const desc = (s.description || '').slice(0, 40)
    process.stdout.write(`${s.id}  ${ts}  ${desc}\n`)
  }
}

async function cmdTui(flags: HarnessFlags): Promise<void> {
  await initRuntime()
  const harness = await buildHarnessFromFlags(flags)
  attachSigint(harness)
  try {
    await runTui(harness, { verbose: flags.verbose })
  } finally {
    await harness.stop().catch(() => { /* best-effort */ })
    harness.destroy()
  }
}

async function cmdCli(flags: HarnessFlags): Promise<void> {
  await initRuntime()

  // Combine positional args + stdin into the prompt.
  let message = flags.positionals.join(' ')
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    const stdinContent = Buffer.concat(chunks).toString('utf-8').trim()
    if (stdinContent) {
      message = message ? `${message}\n\n${stdinContent}` : stdinContent
    }
  }

  if (!message) {
    process.stderr.write('No prompt provided. Pass a prompt or pipe via stdin.\n')
    process.exitCode = 1
    return
  }

  const harness = await buildHarnessFromFlags(flags)
  attachSigint(harness)
  try {
    const exitCode = await runCli(harness, message, { format: flags.format, verbose: flags.verbose })
    process.exitCode = exitCode
  } finally {
    await harness.stop().catch(() => { /* best-effort */ })
    harness.destroy()
  }
}

// ---------------------------------------------------------------------------
// `halo server` subcommand cluster
// ---------------------------------------------------------------------------

const SERVER_LOCK_PATH = path.join(homedir(), '.halo', 'global', 'server.lock')
const SERVER_LOG_PATH = path.join(homedir(), '.halo', 'logs', 'server.log')

/** Read the PID stored in the server lockfile. Returns null if unreadable. */
function readServerPid(): number | null {
  try {
    const txt = fs.readFileSync(SERVER_LOCK_PATH, 'utf-8').trim()
    const n = parseInt(txt, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** True when a process with the given pid is alive (signal 0 = check only). */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return null
  return n
}

async function cmdServer(argv: string[]): Promise<void> {
  // First positional is the subcommand. No subcommand → print help.
  const sub = argv[0]
  if (!sub || sub === '--help' || sub === '-h') {
    process.stderr.write(HELP_SERVER)
    return
  }
  const subArgs = argv.slice(1)

  switch (sub) {
    case 'start':   return cmdServerStart(subArgs, /* daemon */ false)
    case 'stop':    return cmdServerStop(subArgs)
    case 'restart': return cmdServerRestart(subArgs)
    case 'status':  return cmdServerStatus()
    case 'logs':    return cmdServerLogs(subArgs)
    default:
      process.stderr.write(`Unknown subcommand: halo server ${sub}\n\n${HELP_SERVER}`)
      process.exitCode = 1
  }
}

async function cmdServerStart(argv: string[], _unused: boolean): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      port: { type: 'string', short: 'p' },
      daemon: { type: 'boolean', short: 'd', default: false },
    },
  })
  void _unused

  if (values.port !== undefined) {
    const n = parsePort(values.port)
    if (n == null) {
      process.stderr.write(`Invalid port: ${values.port}\n`)
      process.exitCode = 1
      return
    }
    process.env.HALO_PORT = String(n)
  }

  // Bail if a server is already running, regardless of mode.
  const existing = readServerPid()
  if (existing != null && isAlive(existing)) {
    process.stderr.write(`Server already running (PID ${existing}).\n`)
    process.exitCode = 1
    return
  }

  if (!values.daemon) {
    // Foreground: import the server module — its top-level statements take
    // over the process (lock, listen, signal handlers).
    await import('@turmind/halo-server')
    return
  }

  // Daemon: spawn a child process and detach. We re-exec the same `halo`
  // binary with `server start` (no -d) so the child runs foreground inside
  // its own session.
  const { spawn } = await import('node:child_process')
  fs.mkdirSync(path.dirname(SERVER_LOG_PATH), { recursive: true })
  const out = fs.openSync(SERVER_LOG_PATH, 'a')

  // Pass through --port to the child via env (set above) so we don't need to
  // reconstruct the flag list.
  const child = spawn(process.argv[0]!, [process.argv[1]!, 'server', 'start'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()

  // Poll the pidfile for up to 10s — server startup includes template seeding,
  // bwrap probe, etc., which can take a few seconds on a cold cache.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const pid = readServerPid()
    if (pid != null && isAlive(pid) && pid !== process.pid) {
      process.stderr.write(`Server started (PID ${pid}). Logs: ${SERVER_LOG_PATH}\n`)
      return
    }
    if (child.exitCode != null) {
      // Child died before writing the lockfile.
      process.stderr.write(`Failed to start daemon (child exited code ${child.exitCode}) — check logs at ${SERVER_LOG_PATH}\n`)
      process.exitCode = 1
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  process.stderr.write(`Server didn't write a pidfile within 10s — check logs at ${SERVER_LOG_PATH}\n`)
  process.exitCode = 1
}

async function cmdServerStop(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: { force: { type: 'boolean', default: false } },
  })
  const pid = readServerPid()
  if (pid == null || !isAlive(pid)) {
    process.stderr.write('Server not running.\n')
    return
  }

  if (values.force) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
    process.stderr.write(`Server killed (PID ${pid}).\n`)
    return
  }

  // Graceful: SIGTERM, poll up to 5s, then SIGKILL.
  try { process.kill(pid, 'SIGTERM') } catch { /* race */ }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      process.stderr.write(`Server stopped (PID ${pid}).\n`)
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  // Still alive — force kill.
  try { process.kill(pid, 'SIGKILL') } catch { /* race */ }
  process.stderr.write(`Server didn't exit gracefully; killed (PID ${pid}).\n`)
}

async function cmdServerRestart(argv: string[]): Promise<void> {
  // restart accepts -p/--port like start; no -d (always daemon).
  await cmdServerStop([])
  await cmdServerStart([...argv, '-d'], false)
}

async function cmdServerStatus(): Promise<void> {
  const pid = readServerPid()
  if (pid == null || !isAlive(pid)) {
    process.stderr.write('not running\n')
    process.exitCode = 1
    return
  }
  // Try to read the configured port — useful info for the user.
  let port: string | undefined
  try {
    const { config } = await import('@turmind/halo-server/config')
    port = String(config.server.port)
  } catch { /* best-effort */ }
  process.stderr.write(`running (PID ${pid}${port ? `, port ${port}` : ''})\n`)
}

// ---------------------------------------------------------------------------
// `halo acp` — bridge a running halo server to an ACP client over stdio.
// Implementation lives in `@turmind/halo-acp-adapter`; this is just the dispatcher.
// ---------------------------------------------------------------------------

async function cmdAcp(argv: string[]): Promise<void> {
  const mod = await import('@turmind/halo-acp-adapter')
  mod.main(argv)
}

async function cmdServerLogs(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      follow: { type: 'boolean', short: 'f', default: false },
      lines: { type: 'string', short: 'n' },
    },
  })
  if (!fs.existsSync(SERVER_LOG_PATH)) {
    process.stderr.write(`No log file at ${SERVER_LOG_PATH}\n`)
    return
  }
  const { spawn } = await import('node:child_process')
  const args: string[] = []
  if (values.follow) args.push('-f')
  if (values.lines !== undefined) args.push('-n', values.lines)
  args.push(SERVER_LOG_PATH)
  const child = spawn('tail', args, { stdio: 'inherit' })
  await new Promise<void>((resolve) => child.on('exit', () => resolve()))
}

function exitMissingSetup(): never {
  // Only `setup` itself, --help, --version are allowed without a populated
  // ~/.halo/. Everything else points the user there.
  process.stderr.write('\x1b[31mhalo: ~/.halo/global/ not initialized. Run `halo setup` first.\x1b[0m\n')
  process.exit(1)
}

function isHaloHomeReady(): boolean {
  // The version marker is the canonical "setup completed" sentinel.
  return fs.existsSync(path.join(homedir(), '.halo', 'global', '.template-version'))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  // Top-level help / version — never gate on setup.
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stderr.write(HELP_TOP)
    return
  }
  if (cmd === '--version') {
    process.stderr.write(`halo ${VERSION}\n`)
    return
  }

  const subArgs = argv.slice(1)

  // `halo <cmd> --help` / `-h` — print that command's own help.
  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    const text = HELP_BY_CMD[cmd] ?? HELP_TOP
    process.stderr.write(text)
    return
  }

  if (cmd === 'setup') {
    await cmdSetup(subArgs)
    return
  }

  // `halo server` lifecycle commands run without the setup gate so users
  // can stop/status/logs even on a not-yet-initialized install. `start` itself
  // re-checks setup state when it imports the server module.
  if (cmd === 'server') {
    await cmdServer(subArgs)
    return
  }

  // `halo acp` is a stdio bridge — it doesn't read ~/.halo/, only
  // talks to a remote halo server over HTTP. Skip the local setup gate.
  if (cmd === 'acp') {
    await cmdAcp(subArgs)
    return
  }

  // From here on, every subcommand needs ~/.halo/global/ populated.
  if (!isHaloHomeReady()) exitMissingSetup()

  const flags = parseHarnessFlags(subArgs)

  switch (cmd) {
    case 'tui':
      await cmdTui(flags)
      return
    case 'cli':
      await cmdCli(flags)
      return
    case 'agents':
      await cmdAgents(flags)
      return
    case 'sessions':
      await cmdSessions(flags)
      return
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP_TOP}`)
      process.exitCode = 1
  }
}

main().catch((err) => {
  process.stderr.write(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\n`)
  process.exitCode = 1
})
