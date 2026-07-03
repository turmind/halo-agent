import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebSocketServer } from 'ws'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))


import { createFileRoutes } from './routes/files.js'
import { createGitRoutes } from './routes/git.js'
import { createAgentConfigRoutes } from './routes/agent-configs.js'
import { createSkillRoutes } from './routes/skills.js'
import { createSettingsRoutes, onSettingsChange } from './routes/settings.js'
import { createEvolutionRoutes } from './routes/evolution.js'
import { createSessionRoutes } from './routes/sessions.js'
import { createShowRoutes } from './routes/show.js'
import { createMetricsRoutes } from './routes/metrics.js'
import { createCommandRoutes } from './routes/commands.js'
import { commandRegistry } from './commands/index.js'
import { DISPATCH_COMMANDS } from './channels/shared/commands.js'
import { setupWebSocketHandler } from './ws/handler.js'
import { setBroadcastWss } from './ws/broadcast.js'
import { SessionManagerRegistry } from './agents/session-manager-registry.js'
import { createChannelDb, setChannelDb } from './db/channel-db.js'
import { createCronDb, setCronDb } from './db/cron-db.js'
import { startCronDaemon } from './cron/runner.js'
import { createCronRoutes } from './routes/cron.js'
import { createEvoDb, setEvoDb } from './db/evo-db.js'
import { setEvoSpawner, startEvoTicker, stopEvoTicker } from './evolution/ticker.js'
import { startArchiveDaemon, stopArchiveDaemon } from './evolution/archive.js'
import { realEvoSpawner } from './evolution/spawn.js'
import { bootChannels, shutdownChannels } from './channels/registry.js'
import { defaultChannelDescriptors } from './channels/descriptors.js'
import { createAuthRoutes, authMiddleware, getTokenFromCookieHeader, isAuthenticated } from './middleware/auth.js'
import { initLogger } from './logger.js'
import { config, reloadSandboxConfig } from './config.js'
import { initBwrapCheck, isBwrapCached, setSandboxHiddenPaths } from './tools/sandbox.js'
import { ensureHaloHome, readSeedVersion, TEMPLATE_VERSION } from './init.js'
import { ensureSshAgent } from './git-ssh.js'

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

const PORT = config.server.port

/** App version, surfaced via GET /api/health. In the published bundle this is
 *  replaced with a string literal by esbuild's `define` (see cli's
 *  build-bundle.mjs); under `tsx` dev it's undefined, so fall back to 'dev'. */
const HALO_VERSION = process.env.HALO_VERSION ?? 'dev'

/** Walk up from cwd looking for the monorepo root (pnpm-workspace.yaml). */
function findProjectRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  console.log(`[Server] Warning: monorepo root (pnpm-workspace.yaml) not found from ${process.cwd()}, falling back to cwd`)
  return process.cwd()
}

/**
 * Acquire a single-instance lock. On Linux uses flock(1) for an OS-level
 * advisory lock that auto-releases on process exit (even SIGKILL). Falls back
 * to PID-probe on systems without flock (macOS, Windows).
 *
 * flock trick: we open the lock file, pass the fd to `flock -n` via stdio[3].
 * flock acquires the lock on the open file description and exits. The parent
 * still holds a fd to the same description, so the lock persists until the
 * parent process exits and the OS closes all its fds.
 */
function acquireSingleInstanceLock(lockFile: string): void {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  const fd = fs.openSync(lockFile, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644)

  const result = spawnSync('flock', ['-n', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
  })
  if (result.error) {
    // flock command not available — fall back to PID probe
    const content = readLockPid(fd)
    if (content > 0 && isProcessAlive(content)) {
      fs.closeSync(fd)
      console.error(`[Server] another halo server is already running (pid ${content}). kill it first.`)
      process.exit(1)
    }
  } else if (result.status !== 0) {
    // flock says the lock is held — but the previous holder might be a
    // dead process whose fds the kernel hasn't reaped yet (rare on Linux,
    // also covers macOS where flock comes from homebrew + the previous
    // server got SIGKILL'd while spinning in a stuck FS event-loop).
    // If the recorded PID is gone, treat the lock as stale, drop it,
    // and continue. Same probe the no-flock fallback uses below.
    const content = readLockPid(fd)
    if (content > 0 && !isProcessAlive(content)) {
      console.warn(`[Server] removing stale server.lock (pid ${content} not running)`)
    } else {
      fs.closeSync(fd)
      console.error(`[Server] another halo server is already running${content > 0 ? ` (pid ${content})` : ''}. kill it first.`)
      process.exit(1)
    }
  }

  fs.ftruncateSync(fd)
  fs.writeSync(fd, String(process.pid))
  fs.fsyncSync(fd)
  // fd intentionally kept open — holds the flock until process exits
}

function readLockPid(fd: number): number {
  try {
    const buf = Buffer.alloc(32)
    const n = fs.readSync(fd, buf, 0, 32, 0)
    return parseInt(buf.subarray(0, n).toString('utf-8').trim(), 10) || 0
  } catch { return 0 }
}

function isProcessAlive(pid: number): boolean {
  // On Windows `process.kill(pid, 0)` only tells us *some* process owns that
  // pid — and Windows recycles pids aggressively (after a reboot the stale
  // server.lock pid is very likely reused by an unrelated process). That made
  // a left-over lock from a previous install falsely read as "Halo still
  // running" and the new server exited 1 ("kill it first"). So on Windows we
  // additionally confirm the pid actually belongs to a node process via
  // tasklist; anything else (or an error) means the lock is stale → not alive.
  if (process.platform === 'win32') {
    try {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf-8',
        windowsHide: true,
      })
      if (out.status !== 0 || !out.stdout) return false
      return /"node\.exe"/i.test(out.stdout)
    } catch {
      return false
    }
  }
  try { process.kill(pid, 0); return true } catch { return false }
}

const PROJECT_ROOT = findProjectRoot()
const HALO_HOME = path.join(homedir(), '.halo')

// ~/.halo/ must be initialized via `halo setup` before the server can run.
// First-time seeding only happens through `halo setup` so users / ops have an
// explicit moment when state gets created.
if (!fs.existsSync(path.join(HALO_HOME, 'global', '.template-version'))) {
  process.stderr.write('\x1b[31m[Server] ~/.halo/global/ not initialized. Run `halo setup` first.\x1b[0m\n')
  process.exit(1)
}

// Already-initialized installs do auto-refresh on startup when the bundled
// templates have moved ahead of the on-disk seed (typical case: user just
// `npm upgrade`d). `ensureHaloHome` is idempotent and follows the same
// platform-owned vs user-owned policy as `halo setup`, so user state survives.
{
  const seedVersion = readSeedVersion(HALO_HOME)
  if (seedVersion > 0 && seedVersion < TEMPLATE_VERSION) {
    console.log(`[Server] Templates outdated (v${seedVersion} → v${TEMPLATE_VERSION}), refreshing ~/.halo/global/`)
    try {
      ensureHaloHome(HALO_HOME)
    } catch (err) {
      console.error(`[Server] Template refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      // Non-fatal — fall through and start with the older seed.
    }
  }
}

// HALO_PASSWORD env (plaintext) is a first-class credential, not just a login
// bypass: the Docker/CI flow (`halo setup -y && HALO_PASSWORD=... halo server
// start`) never stores a scrypt hash, so the gate must accept either. The
// login path in middleware/auth.ts already compares env plaintext first.
if ((!config.server.password && !config.server.passwordEnvPlaintext) || !config.server.jwtSecret) {
  process.stderr.write('\x1b[31m[Server] admin password not configured. Run `halo setup` to set one, or set the HALO_PASSWORD env.\x1b[0m\n')
  process.exit(1)
}

acquireSingleInstanceLock(path.join(HALO_HOME, 'global', 'server.lock'))

// Sanity check: every server-handled command must have a dispatch case, and
// every dispatch case must have a registered descriptor (regardless of type
// — `client` descriptors can still go through dispatch as a server fallback,
// e.g. /help works whether or not the channel intercepts it).
//
// Catches forgotten descriptors / dispatch entries during dev. Cheap, prevents
// the silent "command shows in palette but does nothing" failure mode.
{
  const declared = new Set(
    commandRegistry.listDescriptors()
      .filter((d) => d.source === 'builtin')
      .map((d) => d.slashName),
  )
  const dispatched = new Set<string>(DISPATCH_COMMANDS)
  const declaredServer = new Set(
    commandRegistry.listDescriptors()
      .filter((d) => d.type === 'server' && d.source === 'builtin')
      .map((d) => d.slashName),
  )
  const missingDispatch = [...declaredServer].filter((n) => !dispatched.has(n))
  const orphanDispatch = [...dispatched].filter((n) => !declared.has(n))
  if (missingDispatch.length > 0) {
    throw new Error(
      `[Server] Command descriptors without a dispatch case: ${missingDispatch.join(', ')}. ` +
      `Either add a case in channels/shared/commands.ts dispatchCommand or change the descriptor type to 'client'.`,
    )
  }
  if (orphanDispatch.length > 0) {
    throw new Error(
      `[Server] Dispatch cases without a descriptor: ${orphanDispatch.join(', ')}. ` +
      `Add a registerDescriptor entry in commands/index.ts or remove the dispatch case.`,
    )
  }
}

// Initialize file logger before any console.log calls
initLogger()

await initBwrapCheck()
setSandboxHiddenPaths(config.sandbox.hiddenDirs, config.sandbox.hiddenFiles, config.sandbox.writableDirs)
onSettingsChange(() => {
  const { hiddenDirs, hiddenFiles, writableDirs } = reloadSandboxConfig()
  setSandboxHiddenPaths(hiddenDirs, hiddenFiles, writableDirs)
})
console.log(`[Server] bwrap sandbox: ${isBwrapCached() ? 'available' : 'NOT available (app-level fallback only)'}`)

// Hold one ssh-agent for the process so the built-in terminal and git children
// (both inherit process.env) share it: the user runs `ssh-add` in the terminal,
// the key loads here, push/pull picks it up. halo never sees the passphrase.
ensureSshAgent()

console.log(`[Server] Halo home: ${HALO_HOME}`)

console.log('[Server] Services initialized (ModelRuntime)')

// Auth credentials are loaded lazily from config; nothing to initialize here.
// `halo setup` populates server.password (scrypt hash) and server.jwt_secret.

// ------------------------------------------------------------------
// Create Hono app
// ------------------------------------------------------------------

const app = new Hono()

// CORS: empty `cors_origins` (the default) reflects any origin so the admin /
// TUI can be reached from arbitrary hosts (mobile, tailscale, ngrok, etc.)
// without manual allowlist tweaking. Authentication is the real security
// boundary; CORS isn't.
//
// A non-empty `cors_origins` switches to strict allowlist mode for ops who
// want to lock things down.
//
// Note: `Access-Control-Allow-Origin: *` can't be combined with
// `credentials: true` per the CORS spec, hence reflecting the incoming Origin
// instead of a literal '*'.
const allowlist = config.server.corsOrigins
app.use('/*', cors({
  origin: allowlist.length > 0
    ? (origin) => (origin && allowlist.includes(origin) ? origin : null)
    : (origin) => origin ?? '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // `x-token` is the documented auth header for the public web API
  // (/api/web/*, /api/show/state). Browser-based custom frontends — the
  // web-demo, halo-city — are cross-origin to the server, so the header has
  // to be in the CORS allowlist or the preflight strips it.
  allowHeaders: ['Content-Type', 'Authorization', 'x-token'],
  exposeHeaders: ['Content-Length'],
  maxAge: 86400,
  credentials: true,
}))

// Auth middleware — protects API routes
app.use('/api/*', authMiddleware() as never)

// ------------------------------------------------------------------
// Auth routes (public)
// ------------------------------------------------------------------

const authRoutes = createAuthRoutes()
app.route('/api', authRoutes)

// ------------------------------------------------------------------
// Health check
// ------------------------------------------------------------------

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
    engine: 'agent',
    version: HALO_VERSION,
  })
})

// ------------------------------------------------------------------
// Mount routes
// ------------------------------------------------------------------

const fileRoutes = createFileRoutes()
app.route('/api', fileRoutes)

const gitRoutes = createGitRoutes()
app.route('/api', gitRoutes)

const agentConfigRoutes = createAgentConfigRoutes()
app.route('/api', agentConfigRoutes)

const skillRoutes = createSkillRoutes()
app.route('/api', skillRoutes)

const settingsRoutes = createSettingsRoutes()
app.route('/api', settingsRoutes)

const evolutionRoutes = createEvolutionRoutes()
app.route('/api', evolutionRoutes)

const cronRoutes = createCronRoutes()
app.route('/api', cronRoutes)

const channelDb = createChannelDb(path.join(HALO_HOME, 'secrets'))
setChannelDb(channelDb)
// Self-evolution global db. Stash the instance in a module-level singleton
// so dispatcher code (`/note` handler etc.) can reach it without threading
// the handle through every caller.
setEvoDb(createEvoDb(path.join(HALO_HOME, 'global')))
// Cron tasks global db + scheduler. Same singleton pattern as evo —
// dispatcher / runner read the db via getCronDb() rather than receiving
// it via DI.
setCronDb(createCronDb(path.join(HALO_HOME, 'global')))
// Cron dispatchers are registered per-channel by `bootChannels(...)`
// further down (each descriptor's `registerCronDispatcher`). Daemon
// is started after the channels boot so the registry is fully populated
// by the time the first scheduled fire could happen.

// Ticker: every 30s, scan the evo db for pending tasks + dead heartbeats.
// Runs at every level — the level only gates how runs get *enqueued* (L0 =
// manual /note, L1 = also auto on pre-compact), never whether a queued run
// executes. A cheap no-op when the queue is empty. Started here so any
// `running` rows from a previous server process get cleaned up promptly.
setEvoSpawner(realEvoSpawner)
startEvoTicker()
startArchiveDaemon()
// Server owns the workspace runtime (holds server.lock) — reconcile
// crash-orphaned sub-sessions when each workspace's manager is first built.
// CLI/TUI registries deliberately omit this so they never disturb a running
// server's sessions on the shared db. Ownership is additionally verified
// per-workspace via `.halo/runtime.lock` (two servers with different
// HALO_HOME can share one workspace — server.lock can't see that), so this
// flag means "reconcile if the workspace claim succeeds", not "always".
const registry = new SessionManagerRegistry({ reconcileOrphansOnBoot: true })

const sessionRoutes = createSessionRoutes(registry)
app.route('/api', sessionRoutes)

// halo-city world snapshot — token-authed public endpoint (added to
// PUBLIC_PATHS in auth.ts so it bypasses the admin cookie like /api/web/*).
const showRoutes = createShowRoutes(registry)
app.route('/api', showRoutes)

const metricsRoutes = createMetricsRoutes(registry)
app.route('/api', metricsRoutes)

const commandRoutes = createCommandRoutes(commandRegistry, registry)
app.route('/api', commandRoutes)

// Boot every registered channel: registers its cron dispatcher, starts
// long-poll/SSE runners, mounts admin routes. Adding a new channel =
// add an entry to `defaultChannelDescriptors`; this block stays untouched.
bootChannels(app, defaultChannelDescriptors, { registry, db: channelDb })

// Cron daemon runs after channels boot so every cron dispatcher is
// registered before the first scheduled fire could happen.
startCronDaemon()

// ------------------------------------------------------------------
// Serve static frontend (Next.js static export)
// ------------------------------------------------------------------

// Frontend resolution priority:
//   1. HALO_FRONTEND_DIR env (explicit override)
//   2. Bundled-package layout: <dist>/../admin-out — used when the cli +
//      server are published together as a single tarball.
//   3. Monorepo sibling-package layout: <server-dist>/../../admin/out —
//      server is at packages/server/dist/, admin/out is at packages/admin/out/.
//   4. PROJECT_ROOT-relative (legacy fallback for when launched from inside repo)
function resolveFrontendDir(): string {
  if (process.env.HALO_FRONTEND_DIR) return path.resolve(process.env.HALO_FRONTEND_DIR)
  const bundled = path.resolve(__dirname, '..', 'admin-out')
  if (fs.existsSync(path.join(bundled, 'index.html'))) return bundled
  const sibling = path.resolve(__dirname, '..', '..', 'admin', 'out')
  if (fs.existsSync(path.join(sibling, 'index.html'))) return sibling
  return path.resolve(PROJECT_ROOT, 'packages', 'admin', 'out')
}
const FRONTEND_DIR = resolveFrontendDir()

app.use('/*', serveStatic({ root: path.relative(process.cwd(), FRONTEND_DIR) }))

// SPA fallback: serve index.html for any non-API route that didn't match a static file
app.get('/*', (c) => {
  const indexPath = path.join(FRONTEND_DIR, 'index.html')
  try {
    const html = fs.readFileSync(indexPath, 'utf-8')
    return c.html(html)
  } catch {
    return c.text('Frontend not built. Run: cd packages/admin && npx next build', 503)
  }
})

// ------------------------------------------------------------------
// Global error handler
// ------------------------------------------------------------------

app.onError((err, c) => {
  console.log(`[Server] Unhandled error: ${err.message}`)
  return c.json({ error: err.message }, 500)
})

// ------------------------------------------------------------------
// Start server with WebSocket support
// ------------------------------------------------------------------

const server = serve({
  fetch: app.fetch,
  port: PORT,
}, (info) => {
  console.log(`[Server] Hono server listening on http://localhost:${info.port}`)
})

const wss = new WebSocketServer({
  server: server as import('node:http').Server,
  path: '/ws',
  verifyClient: (info, callback) => {
    // Authenticate WebSocket connections via cookie
    const token = getTokenFromCookieHeader(info.req.headers.cookie)
    if (isAuthenticated(token)) {
      callback(true)
    } else {
      callback(false, 401, 'Unauthorized')
    }
  },
})

setupWebSocketHandler({ wss, registry })
// Make `wss` reachable from non-handler code (evo wrapper, cron runner,
// admin route mutations) so they can `broadcast({ type, ... })` without
// having to thread the handle through every call site.
setBroadcastWss(wss)

console.log(`[Server] WebSocket server ready on ws://localhost:${PORT}/ws`)

// ------------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------------

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[Server] Received ${signal}, shutting down gracefully...`)

  stopEvoTicker()
  stopArchiveDaemon()

  // Drain every booted channel via its descriptor's optional `shutdown`.
  // Errors are logged per-channel inside shutdownChannels — never thrown.
  await shutdownChannels()

  wss.clients.forEach((client) => {
    client.close(1001, 'Server shutting down')
  })
  wss.close()

  if (server && typeof (server as import('node:http').Server).close === 'function') {
    (server as import('node:http').Server).close()
  }

  console.log('[Server] Shutdown complete')
  process.exit(0)
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

process.on('unhandledRejection', (reason) => {
  console.log(`[Server] Unhandled rejection: ${reason}`)
})

process.on('uncaughtException', (err) => {
  console.log(`[Server] Uncaught exception: ${err.message}`)
  console.log(err.stack)
})
