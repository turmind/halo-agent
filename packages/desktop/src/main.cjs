const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Menu, desktopCapturer, systemPreferences, Notification, crashReporter } = require('electron')
const { spawn, spawnSync, execFile, execSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const http = require('node:http')

// Override "Electron" branding in dev. In packaged builds, macOS reads the
// app name from Info.plist (CFBundleName), populated from electron-builder's
// productName — this only affects `electron .` runs.
app.setName('Halo')

// Local-only crash dumps: without this, native crashes (main/renderer/GPU)
// vanish without a trace — the Crashpad dir stays empty and post-mortem
// debugging of user reports is impossible. Minidumps land under
// app.getPath('crashDumps') (%APPDATA%\Halo\Crashpad on Windows,
// ~/Library/Application Support/Halo/Crashpad on macOS). Never uploaded.
crashReporter.start({ uploadToServer: false })

// Desktop is a single-user, self-contained launcher: we always pick a free
// port at startup and pass it to the spawned server. The user-facing
// HALO_PORT env is intentionally ignored here (it would only matter if
// someone tried to attach a second client to the same server, which is not
// a desktop scenario). CLI / web deployments still honor HALO_PORT — the
// server reads it directly from its own env.
let PORT = 0
const HALO_HOME = path.join(os.homedir(), '.halo')
const LOG_DIR = path.join(HALO_HOME, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'desktop.log')

let serverProcess = null
let mainWindow = null
let splashWindow = null

// Keep last N lines of server stderr/stdout so a crash dialog can show
// what actually failed. The packaged app has no console the user can see.
const TAIL_MAX = 80
const serverTail = []
// First port the desktop server tries. The window loads http://127.0.0.1:PORT,
// and localStorage is partitioned by origin — so a STABLE port keeps the
// origin stable, which is what makes localStorage (last folder, open session,
// expanded tree, editor tabs) actually persist across restarts. A random
// listen(0) port changed the origin every launch and silently wiped all of it.
const PREFERRED_PORT = 9527

// Is this port free to bind on loopback right now?
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

// Pick a port for the desktop server: prefer PREFERRED_PORT, then scan upward
// for the first free one. Sequential (not random) so the origin — and thus
// localStorage — stays stable across restarts in the common case, while still
// stepping aside if 9527 is genuinely taken (another instance / unrelated app).
async function findFreePort() {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 100; port++) {
    if (await isPortFree(port)) return port
  }
  // Extremely unlikely (100 consecutive ports busy) — fall back to an
  // OS-assigned port so we at least boot.
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function appendServerOutput(buf) {
  const text = buf.toString()
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, text) } catch {}
  for (const line of text.split('\n')) {
    if (!line) continue
    serverTail.push(line)
    if (serverTail.length > TAIL_MAX) serverTail.shift()
  }
}

// Desktop-side diagnostics into the same desktop.log the server writes to.
// Timestamped because these are rare lifecycle events (server exit, process
// crashes) where "when" matters for correlating with user reports.
function logDesktop(msg) {
  const line = `[desktop] ${new Date().toISOString()} ${msg}\n`
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line) } catch {}
}

function resolveRuntimePaths() {
  // Packaged: resources/server-runtime + resources/admin-out + resources/node (extraResources)
  // Dev (pnpm dev from packages/desktop): repo monorepo layout, system node
  if (app.isPackaged) {
    const resRoot = process.resourcesPath
    // Helper is asarUnpacked (electron-builder.yml) — the unpacked tree
    // mirrors the asar layout under app.asar.unpacked/.
    const helperScript = path.join(resRoot, 'app.asar.unpacked', 'src', 'setup-helper.mjs')
    // Win build stages `node.exe`; mac/linux stage `node` (no extension).
    const nodeBin = process.platform === 'win32'
      ? path.join(resRoot, 'node.exe')
      : path.join(resRoot, 'node')
    return {
      serverEntry: path.join(resRoot, 'server-runtime', 'dist', 'index.js'),
      serverCwd: path.join(resRoot, 'server-runtime'),
      adminOut: path.join(resRoot, 'admin-out'),
      nodeBin,
      helperScript,
      cliEntry: path.join(resRoot, 'cli-runtime', 'dist', 'index.js'),
    }
  }
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  return {
    serverEntry: path.join(repoRoot, 'packages', 'server', 'dist', 'index.js'),
    serverCwd: path.join(repoRoot, 'packages', 'server'),
    adminOut: path.join(repoRoot, 'packages', 'admin', 'out'),
    nodeBin: process.env.HALO_NODE_BIN || 'node',
    helperScript: path.join(__dirname, 'setup-helper.mjs'),
    cliEntry: path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js'),
  }
}

// Build version for GET /api/health → shown in the admin settings sidebar.
// Packaged: read the `halo-version` stamp staged by stage-runtime.mjs. Dev
// (`electron .`): compute `<version>-<sha>` live from git, same scheme as the
// staged stamp and the CLI bundle. Falls back to the bare package version.
function resolveVersion() {
  if (app.isPackaged) {
    try { return fs.readFileSync(path.join(process.resourcesPath, 'halo-version'), 'utf8').trim() } catch {}
  }
  const base = require('../package.json').version
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return sha ? `${base}-${sha}` : base
  } catch { return base }
}

function configHasPassword() {
  // Cheap regex over secrets/config.yaml. We don't pull in a yaml parser
  // here; the field is "      value: \"...\"" right under "  password:" and
  // is empty on first run. Treat any non-empty quoted value as "set".
  const cfgPath = path.join(HALO_HOME, 'secrets', 'config.yaml')
  if (!fs.existsSync(cfgPath)) return false
  const txt = fs.readFileSync(cfgPath, 'utf8')
  const m = txt.match(/^\s*password:\s*\n\s*value:\s*"([^"]*)"/m)
  return !!(m && m[1] && m[1].length > 0)
}

function runHelper(args, stdin) {
  const { nodeBin, helperScript } = resolveRuntimePaths()
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [helperScript, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `helper exited ${code}`))
    })
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end() } else { child.stdin.end() }
  })
}

async function ensureHaloHome() {
  // Always run — the server's ensureHaloHome is idempotent and follows a
  // per-category force-overwrite policy (see packages/server/src/init.ts),
  // so it MUST run every launch for template upgrades to reach existing
  // installs. Gating on `.template-version` existence froze upgraders at
  // whatever version they first installed: reinstalling the app never
  // touches ~/.halo (user data), so new built-in skills like `send-file`
  // never got seeded. init is a cheap file-copy pass; running it every
  // launch is the intended behavior.
  console.log('[desktop] seeding/refreshing ~/.halo via setup-helper init')
  await runHelper(['init'])
}

function showSetupWindow() {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 480, height: 540,
      resizable: false, minimizable: false, maximizable: false,
      title: 'Halo — Setup',
      backgroundColor: '#0a0a0a',
      webPreferences: {
        // Renderer needs `require('electron')` for ipcRenderer in the simple
        // setup form. This window only loads our own static HTML.
        nodeIntegration: true,
        contextIsolation: false,
      },
    })
    win.removeMenu?.()
    win.loadFile(path.join(__dirname, 'setup-window.html'))

    let settled = false
    const handler = async (_evt, password) => {
      try {
        await runHelper(['set-password'], password)
        settled = true
        win.close()
        resolve()
      } catch (e) {
        // Surface the error back to the renderer so it can re-enable the button.
        throw e
      }
    }
    ipcMain.handle('halo:set-password', handler)
    win.on('closed', () => {
      ipcMain.removeHandler('halo:set-password')
      if (!settled) reject(new Error('Setup cancelled'))
    })
  })
}

function startServer() {
  const { serverEntry, serverCwd, adminOut, nodeBin } = resolveRuntimePaths()
  if (!fs.existsSync(serverEntry)) {
    dialog.showErrorBox('Server bundle missing', `Expected ${serverEntry}`)
    app.exit(1)
    return
  }
  if (app.isPackaged && !fs.existsSync(nodeBin)) {
    dialog.showErrorBox('Node binary missing', `Expected ${nodeBin}`)
    app.exit(1)
    return
  }
  // macOS GUI apps launched from Finder/Dock inherit launchd's minimal PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin) — missing /usr/local/bin where the `halo`
  // launcher is installed, so the server's evo/cron `spawn('halo')` children
  // hit ENOENT. Prepend the standard CLI dirs (same set sandbox.js assumes).
  // Darwin-only: Windows PATH uses ';' and none of these dirs apply.
  const serverEnv = {
    ...process.env,
    HALO_FRONTEND_DIR: adminOut,
    HALO_PORT: String(PORT),
    HALO_VERSION: resolveVersion(),
  }
  if (process.platform === 'darwin') {
    const cliDirs = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/local/sbin', '/opt/homebrew/sbin']
    const have = new Set((serverEnv.PATH || '').split(':').filter(Boolean))
    const prepend = cliDirs.filter((d) => !have.has(d))
    serverEnv.PATH = [...prepend, serverEnv.PATH || ''].filter(Boolean).join(':')
  }
  console.log('[desktop] spawn:', nodeBin, serverEntry)
  serverProcess = spawn(nodeBin, [serverEntry], {
    cwd: serverCwd,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.on('data', (d) => { process.stdout.write(`[server] ${d}`); appendServerOutput(d) })
  serverProcess.stderr.on('data', (d) => { process.stderr.write(`[server] ${d}`); appendServerOutput(d) })
  serverProcess.on('exit', (code, sig) => {
    console.log(`[desktop] server exited code=${code} sig=${sig}`)
    // Persist the exit code — it's the single most diagnostic datum for a
    // crash report, and the dialog below vanishes as soon as the user closes
    // it. isQuitting distinguishes an expected shutdown kill from a crash.
    logDesktop(`server exited code=${code} signal=${sig} expected=${!!app.isQuitting}`)
    serverProcess = null
    if (!app.isQuitting) {
      const tail = serverTail.slice(-30).join('\n')
      dialog.showErrorBox(
        'Server stopped',
        `Halo server exited (code=${code}).\n\nFull log: ${LOG_FILE}\n\nLast output:\n${tail || '(no output)'}`
      )
      app.exit(1)
    }
  })
}

// Kill the spawned server tree. Called from before-quit (normal quit) and, on
// Windows, from process 'exit' as a catch-all (every app.exit(1) path — crash
// dialog, setup failure, health timeout — skips before-quit entirely).
// Guarded: after before-quit already killed the tree, the 'exit'-time re-run
// would only add quit latency.
let serverKillIssued = false
function killServer() {
  if (serverKillIssued || !serverProcess) return
  serverKillIssued = true
  const proc = serverProcess
  if (process.platform === 'win32') {
    // Windows has no signal semantics and no process groups: proc.kill()
    // calls TerminateProcess on the server alone, orphaning everything it
    // spawned (node-pty terminals + conhost, cli children) — they keep
    // holding port 9527 / server.lock AND an executable-image lock on
    // resources\node.exe in the install dir, which is exactly what makes the
    // NSIS over-install keep prompting "app is running" after the app was
    // closed (an orphan's parent is dead, so the installer's
    // `taskkill /im Halo.exe /T` can't reach it either). taskkill /T walks
    // the whole live tree, /F forces it. spawnSync, not spawn: this also
    // runs from process 'exit' where the event loop is gone, and even on the
    // normal quit path a fire-and-forget child races our own teardown.
    try {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {}
    return
  }
  try { proc.kill('SIGTERM') } catch {}
  // Belt-and-suspenders: if the server is wedged (e.g. chokidar/FSEvents
  // deadlock — see ws/file-watcher.ts), SIGTERM never delivers because
  // its main thread is stuck in a syscall. Force-kill after 1.5s so we
  // never leave a zombie holding port 9527 / server.lock.
  setTimeout(() => {
    try { if (!proc.killed) proc.kill('SIGKILL') } catch {}
  }, 1500).unref?.()
}

function waitForHealth(timeoutMs = 30_000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1000 }, (res) => {
        if (res.statusCode === 200) { res.resume(); resolve(); return }
        res.resume(); retry()
      })
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error('server did not become healthy in time'))
      setTimeout(tick, 300)
    }
    tick()
  })
}

// Create a new main window pointed at the local server. Callable repeatedly —
// Cmd/Ctrl+N and the macOS Dock 'activate' both open additional windows. All
// windows share the single server + its origin (so one localStorage), so a
// window remembers which workspace it's on via its own URL ?folder=, not
// localStorage (that would be shared and clobbered across windows). The
// workspace switch flow already full-reloads with ?folder=, so this works out.
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Halo',
    // Admin UI is dark-only (--background: #0a0a0a). Pre-paint dark so the
    // first frame doesn't flash white; nativeTheme.themeSource='dark' (set
    // in app.on('ready')) makes macOS render the title bar dark too.
    backgroundColor: '#0a0a0a',
    webPreferences: {
      // contextIsolation:false so preload can patch window.alert/confirm
      // directly. Safe here because we only ever load our own server origin
      // (http://127.0.0.1:9527) — no third-party content reaches this window.
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  // Track the most-recently-focused window so IPC handlers without a sender
  // (or before any focus event) have a sensible target.
  mainWindow = win
  win.on('focus', () => { mainWindow = win })
  win.loadURL(`http://127.0.0.1:${PORT}`)
  mainWindowEverShown = true
  // Hand off from the splash once the admin UI has actually painted, so there's
  // no flash of empty window between the two.
  win.webContents.once('did-finish-load', () => closeSplash())
  if (!app.isPackaged || process.env.HALO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' })
  // Admin UI registers beforeunload+preventDefault to warn on tab close.
  // In a browser that pops a "Leave site?" dialog and the user can OK; in
  // Electron the dialog is silently swallowed and navigation is blocked
  // entirely — so workspace switching (which does `location.href = ...`)
  // looks like a no-op. Auto-allow the unload.
  win.webContents.on('will-prevent-unload', (event) => { event.preventDefault() })
  win.webContents.setWindowOpenHandler(({ url }) => {
    // about:blank = window.open('') from the renderer (e.g. the print helper,
    // which writes HTML into the popup) — must stay in-app, and openExternal
    // on it would fail anyway.
    if (
      url === 'about:blank' ||
      url.startsWith(`http://127.0.0.1:${PORT}`) || url.startsWith(`http://localhost:${PORT}`)
    ) {
      return { action: 'allow' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // Same-tab navigation to a non-local URL (e.g. a plain <a href> without
  // target=_blank) would replace the whole admin UI — send it to the system
  // browser instead. Local navigations (workspace switch via location.href)
  // stay allowed.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`http://127.0.0.1:${PORT}`) || url.startsWith(`http://localhost:${PORT}`)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  // Keyboard shortcuts bound at the webContents level (before-input-event
  // fires before page handlers AND menu accelerators — preventDefault stops
  // both, which is what lets Cmd+W reach the editor instead of the macOS
  // windowMenu "Close" accelerator killing the whole window).
  win.webContents.on('before-input-event', (event, input) => {
    // Fires on every keystroke — short-circuit on the modifier before the
    // string compares so the common (unmodified) case does no extra work.
    const primary = process.platform === 'darwin' ? input.meta : input.control
    // Down-events arrive as 'keyDown' or 'rawKeyDown' depending on platform/
    // version — filter by exclusion so both work; keyUp/char must not re-fire.
    if (input.type === 'keyUp' || input.type === 'char') return
    if (!primary || input.alt || input.shift) return
    const key = input.key.toLowerCase()
    // Ctrl+N → new window. Windows/Linux only: they have no app menu (macOS-
    // only, see setupAppMenu), so there's no menu accelerator for this; and
    // binding here avoids adding a native menu bar just for one shortcut.
    // macOS uses the File menu item instead.
    if (key === 'n' && process.platform !== 'darwin' && !input.meta) {
      event.preventDefault()
      createWindow()
    }
    // Cmd/Ctrl+W → close the active editor tab. The renderer owns tab state,
    // so just forward; it calls halo:close-window back when no tab is open
    // (restoring the platform-standard "close window" meaning of Cmd+W).
    if (key === 'w') {
      event.preventDefault()
      win.webContents.send('halo:close-shortcut')
    }
    // Cmd/Ctrl+F is intentionally NOT intercepted here (unlike Cmd+W above).
    // There's no macOS menu accelerator contesting it (no Find menu item),
    // so the renderer's own DOM keydown handler (workspace-layout.tsx) can
    // own it directly — and must, so it can fall through to Monaco's native
    // find when focus is inside the code editor. Intercepting at this
    // native layer would preventDefault unconditionally and break that.
  })
  // Match results for webContents.findInPage — a webContents-instance event
  // (unlike the ipcMain.handle bridges below), so it's registered per-window
  // here. Forwarded to the renderer's find bar for the "x/y" match counter.
  win.webContents.on('found-in-page', (_event, result) => {
    win.webContents.send('halo:find-result', result)
  })
  return win
}

// Always-on-top toggle, driven by a pin button in the admin UI (preload
// exposes `window.haloPin`). Renderer can't call setAlwaysOnTop itself, so
// we bridge over IPC. 'floating' level keeps the window above other apps'
// windows on macOS, not just our own. Both handlers return the resulting
// state so the button can reflect it without a second round-trip.
// Pin acts on the window that sent the IPC (each window pins independently),
// falling back to the last-focused window if the sender is somehow gone.
ipcMain.handle('halo:pin-get', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow
  return win ? win.isAlwaysOnTop() : false
})
ipcMain.handle('halo:pin-toggle', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow
  if (!win) return false
  const next = !win.isAlwaysOnTop()
  win.setAlwaysOnTop(next, 'floating')
  return next
})

// Cmd/Ctrl+W fallback: the renderer calls this when the shortcut fires with
// no editor tab open — restoring the platform-standard "close window"
// meaning (the before-input-event handler swallowed the menu accelerator).
ipcMain.handle('halo:close-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) win.close()
})

// In-page find bridge (preload exposes `window.haloFind`). findInPage /
// stopFindInPage are webContents APIs the renderer can't call itself; both
// are fire-and-forget (results arrive via the per-window found-in-page
// forwarder above), so plain `on` rather than `handle`.
ipcMain.on('halo:find', (e, text, options) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  win?.webContents.findInPage(text, options)
})
ipcMain.on('halo:find-stop', (e, action) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  win?.webContents.stopFindInPage(action)
})

// Reveal a file/folder in the OS file manager (Finder / Explorer / Linux file
// manager), driven by the Explorer context menu (preload exposes
// `window.haloReveal`). The renderer can't touch the shell module, so we bridge
// over IPC. A folder opens itself (openPath); a file is highlighted in its
// parent dir (showItemInFolder). fullPath is absolute — the renderer joins it
// from the workspace root before invoking.
ipcMain.handle('halo:reveal', async (_e, fullPath, isDir) => {
  if (!fullPath) return
  // The renderer joins the path with '/', so on Windows it arrives with mixed
  // separators (C:\proj/src). showItemInFolder's Win32 SHOpenFolderAndSelectItems
  // needs native separators or it fails to select — normalize to the platform's.
  const native = path.normalize(fullPath)
  if (isDir) {
    const err = await shell.openPath(native) // '' on success, message on failure
    if (err) console.error(`[Reveal] openPath failed: ${err}`)
  } else {
    shell.showItemInFolder(native)
  }
})

// Agent-finished desktop notification, driven by the admin (preload exposes
// `window.haloNotify`) when streaming ends while its window is unfocused. Acts
// on the window that sent the IPC so each window notifies for its own agent.
ipcMain.handle('halo:notify', (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  // Belt-and-suspenders: the admin already checked document.hasFocus(), but the
  // IPC round-trip has latency and focus may have changed since — if the window
  // is focused now the user is already looking at it, so don't interrupt.
  if (!win || win.isFocused()) return
  const { title, body } = payload || {}

  // Notification.isSupported() is false on headless/unsupported setups; skip the
  // native banner there but still nudge via Dock/taskbar below. On macOS the
  // first Notification auto-requests permission (no manual request needed).
  if (Notification.isSupported()) {
    const notification = new Notification({ title: title || 'Halo', body: body || '' })
    // Clicking the banner brings the (possibly minimized/background) window front.
    notification.on('click', () => { win.show(); win.focus() })
    notification.show()
  }

  if (process.platform === 'darwin') {
    // macOS: bounce the Dock icon once to draw attention (returns a request id
    // we don't need to cancel — 'informational' bounces a single time).
    app.dock?.bounce('informational')
  } else {
    // Windows: flash the taskbar button; the OS stops it when the window is
    // refocused, but clear it explicitly on 'focus' as a safeguard. Linux: some
    // DEs honor flashFrame, others ignore it — harmless where unsupported.
    win.flashFrame(true)
    win.once('focus', () => win.flashFrame(false))
  }
})

// Screen/window capture for the "let the AI see an app" feature. The admin UI
// (preload exposes `window.haloCapture`) lets the user bind a window/screen,
// then the LLM asks for a frame on demand via a <<<CAPTURE>>> marker. Capture
// uses desktopCapturer's thumbnail (a single still frame — no getUserMedia
// video stream needed). Desktop + macOS/Windows only; bail elsewhere.
const CAPTURE_SUPPORTED = process.platform === 'darwin' || process.platform === 'win32'

// List screens + windows with small preview thumbnails for the source picker.
ipcMain.handle('halo:capture-list', async () => {
  if (!CAPTURE_SUPPORTED) return []
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 200, height: 150 },
    fetchWindowIcons: true,
  })
  return sources.map((s) => {
    // An empty thumbnail means macOS hasn't granted Screen Recording — the
    // frame comes back blank. Flag it (blank:true, thumb:null) so the UI shows
    // a placeholder + permission hint instead of a broken <img>.
    const blank = s.thumbnail.isEmpty()
    return {
      id: s.id,
      name: s.name,
      thumb: blank ? null : s.thumbnail.toDataURL(),
      blank,
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }
  })
})

// When a window has sat occluded/minimized long enough for macOS to reclaim
// its backing store, desktopCapturer hands back a frame that's NOT empty (it
// has pixel data) but is essentially all black — so isEmpty() passes and the
// black image gets sent to the model. Detect that by sparse-sampling pixels
// (toBitmap is BGRA; full 1920×1080 scan is wasteful, every ~997th pixel is
// plenty) and treating "almost every sample is near-black" as a failed grab.
function isMostlyBlack(image) {
  const buf = image.toBitmap() // BGRA, 4 bytes/pixel
  if (buf.length < 4) return true
  const pxCount = buf.length / 4
  const step = Math.max(1, Math.floor(pxCount / 1000)) * 4
  let sampled = 0
  let dark = 0
  for (let i = 0; i + 2 < buf.length; i += step) {
    sampled++
    // BGRA: buf[i]=B, buf[i+1]=G, buf[i+2]=R. Near-black if all channels low.
    if (buf[i] <= 8 && buf[i + 1] <= 8 && buf[i + 2] <= 8) dark++
  }
  return sampled > 0 && dark / sampled > 0.99
}

// Grab a full-res-ish frame of a previously-listed source. Re-fetches sources
// at a large thumbnailSize (vision models downsample anyway; 1920 wide keeps
// base64 size reasonable) and matches by id. Returns base64 JPEG (quality 85 —
// a screenshot is photographic enough that JPEG is far smaller than lossless
// PNG, matching the camera path), or null if the window is gone (closed since
// it was bound) or stays blank/black.
ipcMain.handle('halo:capture-grab', async (_e, sourceId) => {
  if (!CAPTURE_SUPPORTED || !sourceId) return null
  // macOS returns an unusable frame in two distinct ways: an EMPTY frame while
  // WindowServer hasn't finished rendering yet (after a Space switch/un-
  // minimize/under load — electron/electron#24412), and an all-BLACK frame once
  // the OS has purged a long-occluded window's backing store (#30593). Both are
  // intermittent/recoverable on a redraw, so probe a few times with a short
  // delay. A genuinely-closed source returns null immediately (no retry).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(200)
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1920, height: 1080 },
    })
    const match = sources.find((s) => s.id === sourceId)
    if (!match) return null  // window is gone — no point retrying
    if (!match.thumbnail.isEmpty() && !isMostlyBlack(match.thumbnail)) {
      return match.thumbnail.toJPEG(85).toString('base64')
    }
  }
  return null  // empty/black after retries (window occluded/minimized too long)
})

// macOS gates screen capture behind a "Screen Recording" permission; report it
// so the UI can prompt. Other platforms have no equivalent gate → 'granted'.
ipcMain.handle('halo:capture-permission', () => {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('screen')
})

// Open the macOS Screen Recording settings pane (can't trigger the grant
// dialog programmatically; the user toggles Halo on there).
ipcMain.handle('halo:capture-open-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  }
})

// Webcam (camera) permission for the "let the AI take a photo" feature. Unlike
// Screen Recording, macOS DOES expose a programmatic prompt for the camera —
// askForMediaAccess shows the TCC dialog on first use and resolves true once
// granted (false if previously denied, since macOS then won't re-prompt). The
// renderer's getUserMedia would trigger the same prompt, but asking from main
// first lets the UI show a clear "denied → open Settings" path. Non-mac has no
// gate → granted.
ipcMain.handle('halo:camera-request', async () => {
  if (process.platform !== 'darwin') return true
  return systemPreferences.askForMediaAccess('camera')
})

// Open the macOS Camera settings pane (for the re-enable-after-deny case).
ipcMain.handle('halo:camera-open-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')
  }
})

function setDockIconIfDev() {
  // Packaged builds get the icon from the .app bundle (mac.icon in
  // electron-builder). In dev (running raw `electron .`), the Dock shows
  // Electron's default unless we set it manually.
  if (app.isPackaged || process.platform !== 'darwin') return
  const iconPath = path.join(__dirname, '..', 'resources', 'icon.png')
  if (fs.existsSync(iconPath) && app.dock) app.dock.setIcon(iconPath)
}

// macOS only: install a `halo` launcher into /usr/local/bin so the CLI/TUI
// is reachable from any terminal. The DMG has no install script (unlike the
// Windows NSIS installer, which does this automatically), so we expose it as
// an explicit menu action — no silent PATH mutation. Same model as VS Code's
// "Shell Command: Install 'code' command in PATH".
//
// The launcher is a tiny shell script (not a symlink): it must invoke the
// bundled node against the cli-runtime bundle, both living inside the .app, so
// a single-file symlink wouldn't carry the node+entry pairing.
function installCliCommand() {
  const { nodeBin, cliEntry } = resolveRuntimePaths()
  if (!fs.existsSync(cliEntry)) {
    dialog.showErrorBox('CLI not bundled', `Expected ${cliEntry}`)
    return
  }
  const target = '/usr/local/bin/halo'
  const script = `#!/bin/sh\nexec "${nodeBin}" "${cliEntry}" "$@"\n`

  // Try a plain write first (works when /usr/local/bin exists and is user-
  // writable, e.g. Homebrew on Apple Silicon chowns it). Fall back to an
  // osascript admin prompt that mkdirs the dir + writes the file as root.
  try {
    fs.mkdirSync('/usr/local/bin', { recursive: true })
    fs.writeFileSync(target, script, { mode: 0o755 })
    dialog.showMessageBox({ type: 'info', message: "'halo' command installed", detail: `Run \`halo tui\` or \`halo cli\` from any terminal.\n\nInstalled at ${target}` })
    return
  } catch { /* needs privileges — fall through */ }

  // base64 the script so quoting survives the nested sh -c inside osascript.
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  const shellCmd = `mkdir -p /usr/local/bin && echo ${b64} | base64 --decode > '${target}' && chmod 755 '${target}'`
  const osa = `do shell script "${shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`
  execFile('osascript', ['-e', osa], (err) => {
    if (err) {
      dialog.showErrorBox('Install failed', `Could not write ${target}.\n\n${err.message}`)
      return
    }
    dialog.showMessageBox({ type: 'info', message: "'halo' command installed", detail: `Run \`halo tui\` or \`halo cli\` from any terminal.\n\nInstalled at ${target}` })
  })
}

// Build the app menu. macOS gets the extra "Install 'halo' command" item
// under the app menu; other platforms keep the default (null) menu.
function setupAppMenu() {
  if (process.platform !== 'darwin') return
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: "Install 'halo' Command in PATH", click: () => installCliCommand() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Lightweight splash shown the instant the app is ready, so first launch —
// when macOS Gatekeeper scans the whole unsigned ~580MB bundle before the
// server even boots — gives immediate visual feedback instead of a bouncing
// Dock icon and a blank screen. Closed once the real window paints.
function showSplash() {
  splashWindow = new BrowserWindow({
    width: 320, height: 280,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0a',
    show: false,
  })
  splashWindow.removeMenu?.()
  splashWindow.loadFile(path.join(__dirname, 'splash-window.html'))
  splashWindow.once('ready-to-show', () => splashWindow?.show())
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  splashWindow = null
}

app.on('ready', async () => {
  // Admin renders in dark mode unconditionally; tell macOS so the window
  // chrome (title bar, traffic-light area) follows suit.
  nativeTheme.themeSource = 'dark'
  setupAppMenu()
  setDockIconIfDev()
  showSplash()
  try {
    PORT = await findFreePort()
    console.log(`[desktop] picked free port ${PORT}`)
    await ensureHaloHome()
    // Password is required unless the user provided HALO_PASSWORD env
    // (advanced / scripted launch). Ask for one on first run only.
    const envSet = !!(process.env.HALO_PASSWORD && process.env.HALO_PASSWORD.length > 0)
    if (!envSet && !configHasPassword()) {
      // First-run password prompt — drop the splash so it doesn't sit behind
      // the setup window, then bring it back for the server-boot phase that
      // follows (still no main window until health passes).
      closeSplash()
      await showSetupWindow()
      showSplash()
    }
  } catch (err) {
    closeSplash()
    dialog.showErrorBox('Setup failed', String(err && err.message || err))
    app.exit(1)
    return
  }
  startServer()
  try { await waitForHealth() } catch (err) {
    closeSplash()
    logDesktop(`server failed health check: ${String(err)}`)
    dialog.showErrorBox('Server failed to start', String(err))
    // The child is alive but unhealthy here, and app.exit() skips before-quit
    // — kill explicitly or this path guarantees an orphaned node.exe on
    // Windows (the process 'exit' hook would also catch it; this is the
    // deterministic first line).
    killServer()
    app.exit(1)
    return
  }
  createWindow()
})

// macOS convention: closing every window doesn't quit the app — it stays in the
// Dock and clicking the icon reopens a window. Only Cmd+Q (→ before-quit) truly
// exits. Recreate a window here if the server is still running; if it somehow
// died, a click can't do anything useful, so ignore.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverProcess) createWindow()
})

// Don't quit when the (transient) setup window closes — startup runs the
// sequence setup-window → close → start server → main window. If we
// quit on window-all-closed during that gap, before-quit kills the
// server we just started. Only honor window-all-closed once the main
// window has existed at least once.
//
// Platform split: on macOS, keep running when all windows close (Cmd+Q quits
// via before-quit); on Windows/Linux there's no Dock to resummon from, so a
// windowless background app is a bug — quit as usual.
let mainWindowEverShown = false
app.on('window-all-closed', () => {
  if (!mainWindowEverShown) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
  killServer()
})

// Last-resort child cleanup, Windows-only. `app.exit()` skips before-quit/
// will-quit entirely, and on Windows an orphaned node.exe SURVIVES its parent
// (no POSIX orphan reaping, no process group) — it keeps port 9527 +
// server.lock and holds open-file locks on the install dir, which is exactly
// what makes the NSIS over-install loop on "app is running". process 'exit'
// fires on every normal Node/Electron exit path (including app.exit), and
// killServer's win32 branch is fully synchronous, so it's safe here (async
// work would be silently dropped). POSIX doesn't need this: children get
// SIGTERM'd in before-quit and a stale server.lock is pid-probed away on the
// next launch anyway.
process.on('exit', () => {
  if (process.platform === 'win32') killServer()
})

// Crash breadcrumbs for Electron's own processes. Without these a dead
// renderer/GPU/utility process leaves no trace in desktop.log — the window
// just goes blank. crashReporter (started at the top) writes the matching
// minidump into app.getPath('crashDumps').
app.on('render-process-gone', (_e, webContents, details) => {
  logDesktop(`render-process-gone reason=${details.reason} exitCode=${details.exitCode} url=${webContents.getURL()}`)
})
app.on('child-process-gone', (_e, details) => {
  logDesktop(`child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name || ''}`)
})
