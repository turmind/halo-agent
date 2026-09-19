import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { compress } from 'hono/compress'
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
import { createDataPreviewRoutes } from './routes/data-preview.js'
import { createGitRoutes } from './routes/git.js'
import { createAgentConfigRoutes } from './routes/agent-configs.js'
import { createSkillRoutes } from './routes/skills.js'
import { createSettingsRoutes, onSettingsChange } from './routes/settings.js'
import { createEvolutionRoutes } from './routes/evolution.js'
import { createSessionRoutes } from './routes/sessions.js'
import { createSessionArchiveRoutes } from './routes/session-archive.js'
import { createShowRoutes } from './routes/halo-city.js'
import { createMetricsRoutes } from './routes/metrics.js'
import { createCommandRoutes } from './routes/commands.js'
import { createAgentCoreRoutes, setupAgentCoreWebSocket } from './routes/agentcore.js'
import { commandRegistry } from './commands/index.js'
import { DISPATCH_COMMANDS } from './channels/shared/commands.js'
import { setupWebSocketHandler } from './ws/handler.js'
import { setBroadcastWss } from './ws/broadcast.js'
import { SessionManagerRegistry } from './agents/session-manager-registry.js'
import { claimWorkspaceRuntime } from './agents/workspace-runtime-lock.js'
import { setRelayRegistry } from './agents/relay.js'
import { createChannelDb, setChannelDb } from './db/channel-db.js'
import { createCronDb, setCronDb } from './db/cron-db.js'
import { createRunsDb, setRunsDb, listRunningWorkspaces } from './db/runs-db.js'
import { startCronDaemon, stopCronDaemon } from './cron/runner.js'
import { createCronRoutes } from './routes/cron.js'
import { createEvoDb, setEvoDb } from './db/evo-db.js'
import { setEvoSpawner, startEvoTicker, stopEvoTicker } from './evolution/ticker.js'
import { startArchiveDaemon, stopArchiveDaemon } from './evolution/archive.js'
import { realEvoSpawner } from './evolution/spawn.js'
import { bootChannels, shutdownChannels } from './channels/registry.js'
import { defaultChannelDescriptors } from './channels/descriptors.js'
import { createAuthRoutes, authMiddleware, getTokenFromCookieHeader, isAuthenticated } from './middleware/auth.js'
import { initLogger } from './logger.js'
import { initObservability, shutdownObservability } from './observability/otel.js'
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

/** Runtime git sha, source builds only. Published bundles already carry the
 *  sha inside HALO_VERSION (build-bundle.mjs stamps `x.y.z-<sha>`); a source
 *  checkout runs plain tsc output where the version is just 'dev', so probe
 *  .git once at boot to let /api/health answer "which commit is deployed?".
 *  Guarded to the monorepo case — PROJECT_ROOT falls back to cwd for bundle
 *  installs, and probing an unrelated user repo there would report a foreign
 *  sha. */
function readGitSha(): string | null {
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'pnpm-workspace.yaml')) || !fs.existsSync(path.join(PROJECT_ROOT, '.git'))) return null
  try {
    const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf-8' })
    if (rev.status !== 0) return null
    const sha = rev.stdout.trim()
    if (!sha) return null
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf-8' }).stdout.trim().length > 0
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return null
  }
}
const GIT_SHA = readGitSha()

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

// Amazon Bedrock AgentCore Runtime mode: auth is terminated upstream by
// AgentCore (SigV4/OAuth), each session runs in its own microVM, and the only
// exposed surface is /ping + /invocations + WS /ws (routes/agentcore.ts).
// So: no password/JWT gate, no single-instance lock, no channels/cron/evo.
const AGENTCORE = config.server.runtimeMode === 'agentcore'

// HALO_PASSWORD env (plaintext) is a first-class credential, not just a login
// bypass: the Docker/CI flow (`halo setup -y && HALO_PASSWORD=... halo server
// start`) never stores a scrypt hash, so the gate must accept either. The
// login path in middleware/auth.ts already compares env plaintext first.
if (!AGENTCORE && ((!config.server.password && !config.server.passwordEnvPlaintext) || !config.server.jwtSecret)) {
  process.stderr.write('\x1b[31m[Server] admin password not configured. Run `halo setup` to set one, or set the HALO_PASSWORD env.\x1b[0m\n')
  process.exit(1)
}

if (!AGENTCORE) acquireSingleInstanceLock(path.join(HALO_HOME, 'global', 'server.lock'))

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

// OTel providers first (the logger interceptors forward to the OTel logger
// when export is enabled), then the file logger before any console.log calls.
await initObservability()
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
// `credentials` is tied to that mode, NOT always on: "reflect any Origin +
// Allow-Credentials: true" is the one combination that lets an arbitrary
// site's page make cookie-authenticated calls into a user's halo. Nothing
// halo ships needs it in the default mode — the admin panel is same-origin
// (cookie flows without CORS at all), and the cross-origin consumers
// (web-demo, halo-city, ACP adapter) authenticate with the `x-token`
// web-channel header, which is *not* a credential in the CORS sense.
// Deployments that genuinely need a cookie to ride cross-origin (e.g. halo
// behind an SSO proxy, frontend on a sibling subdomain sharing the parent
// domain's auth cookie) list that origin in `cors_origins` and get
// credentials back — with a known peer instead of "whoever asked".
//
// Note: `Access-Control-Allow-Origin: *` can't be combined with
// `credentials: true` per the CORS spec, hence reflecting the incoming Origin
// instead of a literal '*' in allowlist mode.
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
  credentials: allowlist.length > 0,
}))

// Response compression (gzip/deflate via Node's global CompressionStream).
// Covers /api/* JSON (multi-MB session archive segments) and the serveStatic
// admin assets below. SSE is safe: hono's compressible content-type regex
// explicitly excludes text/event-stream, and streamSSE sets Transfer-Encoding
// (also skipped). Responses under 1 KiB pass through uncompressed.
app.use('/*', compress({ threshold: 1024 }))

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
    gitSha: GIT_SHA,
  })
})

// ------------------------------------------------------------------
// Mount routes
// ------------------------------------------------------------------

const fileRoutes = createFileRoutes()
app.route('/api', fileRoutes)

const dataPreviewRoutes = createDataPreviewRoutes()
app.route('/api', dataPreviewRoutes)

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
// Run ledger global db (which sessions the server is mid-run on; see
// agents/run-ledger.ts). Same singleton pattern.
setRunsDb(createRunsDb(path.join(HALO_HOME, 'global')))
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
if (!AGENTCORE) {
  startEvoTicker()
  startArchiveDaemon()
}
// Server owns the workspace runtime (holds server.lock) — reconcile
// crash-orphaned sub-sessions when each workspace's manager is first built.
// CLI/TUI registries deliberately omit this so they never disturb a running
// server's sessions on the shared db. Ownership is additionally verified
// per-workspace via `.halo/runtime.lock` (two servers with different
// HALO_HOME can share one workspace — server.lock can't see that), so this
// flag means "reconcile if the workspace claim succeeds", not "always".
const registry = new SessionManagerRegistry({ reconcileOrphansOnBoot: true })
setRelayRegistry(registry)

// Run ledger eager sweep: build the SessionManager NOW for every workspace
// that has leftover `running_sessions` rows, so its constructor chain
// (runtime.lock claim → orphan reconcile → sweepActiveGoals →
// sweepInterruptedRuns) fires at boot rather than whenever someone next
// opens the workspace — an interrupted root with nobody around is exactly
// the one that must nudge itself. A vanished workspace is skipped and its
// rows stay. A workspace another live server owns is skipped BEFORE the SM
// is built: getOrCreate would cache a non-owner SM for this whole process
// lifetime (never reconciles, never nudges, even after the holder exits),
// whereas skipping keeps the rows and lets the first real touch claim
// normally. claimWorkspaceRuntime is idempotent for our own pid, so the
// constructor's own claim just re-confirms.
for (const ws of listRunningWorkspaces()) {
  if (!fs.existsSync(path.join(ws, '.halo'))) continue
  if (!claimWorkspaceRuntime(ws)) continue
  try {
    registry.getOrCreate(ws)
  } catch (err) {
    console.error(`[RunLedger] Boot sweep could not open ${ws}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const sessionRoutes = createSessionRoutes(registry)
app.route('/api', sessionRoutes)

// Archived UI-log segments (scroll-up history). Separate router from
// sessions.ts so the read side of archiving sits next to nothing else.
const sessionArchiveRoutes = createSessionArchiveRoutes(registry)
app.route('/api', sessionArchiveRoutes)

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
if (!AGENTCORE) {
  bootChannels(app, defaultChannelDescriptors, { registry, db: channelDb })

  // Cron daemon runs after channels boot so every cron dispatcher is
  // registered before the first scheduled fire could happen.
  startCronDaemon()
} else {
  // AgentCore adapter: /ping + /invocations at the root (the AgentCore
  // contract paths, not under /api — no auth middleware applies to them).
  const agentcoreRoutes = createAgentCoreRoutes({ registry, workspace: config.server.agentcoreWorkspace })
  app.route('/', agentcoreRoutes)
  console.log(`[Server] AgentCore runtime mode — workspace: ${config.server.agentcoreWorkspace}`)
}

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
  // AgentCore terminates auth upstream (SigV4/OAuth) before the connection
  // reaches the container, so its /ws is open; normal mode keeps cookie auth.
  verifyClient: AGENTCORE ? undefined : (info, callback) => {
    // Authenticate WebSocket connections via cookie
    const token = getTokenFromCookieHeader(info.req.headers.cookie)
    if (isAuthenticated(token)) {
      callback(true)
    } else {
      callback(false, 401, 'Unauthorized')
    }
  },
})

if (AGENTCORE) {
  setupAgentCoreWebSocket({ wss, registry, workspace: config.server.agentcoreWorkspace })
  // No setBroadcastWss: admin broadcast frames (session:changed etc.) must
  // not leak into the AgentCore WS protocol; broadcast() no-ops unset.
} else {
  setupWebSocketHandler({ wss, registry })
  // Make `wss` reachable from non-handler code (evo wrapper, cron runner,
  // admin route mutations) so they can `broadcast({ type, ... })` without
  // having to thread the handle through every call site.
  setBroadcastWss(wss)
}

console.log(`[Server] WebSocket server ready on ws://localhost:${PORT}/ws`)

// ------------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------------

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[Server] Received ${signal}, shutting down gracefully...`)

  stopEvoTicker()
  stopArchiveDaemon()
  // Before channels drain: the 10s reconcile poll would otherwise rebuild
  // schedules (and fire new runs) while we're mid-shutdown.
  stopCronDaemon()

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
  // Last: flush buffered spans / metrics / log records (bounded to 3s) so the
  // shutdown line above and any in-flight turn spans reach the collector.
  await shutdownObservability()
  process.exit(0)
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

process.on('unhandledRejection', (reason) => {
  console.log(`[Server] Unhandled rejection: ${reason}`)
})

/**
 * An uncaught exception means some code path unwound past every handler —
 * locks half-taken, files half-written, in-memory session state possibly
 * inconsistent. Continuing to serve from that state is worse than dying: the
 * db is the source of truth and every daemon (cron / evo ticker / channels)
 * reconciles from it on boot, so a restart is a full recovery while a zombie
 * process silently corrupts.
 *
 * So: log (synchronously flushed by logger.ts's appendFileSync), then exit
 * non-zero and let the supervisor restart us — systemd (`Restart=on-failure`
 * in the unit documented in dev/deploy.md, which fires exactly on a non-zero
 * exit) or Docker's restart policy. Without a supervisor (`halo server start`
 * run bare) it's a hard stop with the stack in
 * ~/.halo/global/logs/server.log — a visible failure the user restarts,
 * rather than a wedged server answering requests from corrupt state.
 *
 * The 100ms delay is only to let already-queued stdout/WS frames drain; no
 * further work is scheduled.
 */
process.on('uncaughtException', (err) => {
  console.error(`[Server] Uncaught exception — exiting: ${err.message}`)
  console.error(err.stack)
  setTimeout(() => process.exit(1), 100)
})
