const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Menu, desktopCapturer, systemPreferences } = require('electron')
const { spawn, execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const http = require('node:http')

// Override "Electron" branding in dev. In packaged builds, macOS reads the
// app name from Info.plist (CFBundleName), populated from electron-builder's
// productName — this only affects `electron .` runs.
app.setName('Halo')

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

function createWindow() {
  mainWindow = new BrowserWindow({
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
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`)
  mainWindowEverShown = true
  // Hand off from the splash once the admin UI has actually painted, so there's
  // no flash of empty window between the two.
  mainWindow.webContents.once('did-finish-load', () => closeSplash())
  if (!app.isPackaged || process.env.HALO_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' })
  // Admin UI registers beforeunload+preventDefault to warn on tab close.
  // In a browser that pops a "Leave site?" dialog and the user can OK; in
  // Electron the dialog is silently swallowed and navigation is blocked
  // entirely — so workspace switching (which does `location.href = ...`)
  // looks like a no-op. Auto-allow the unload.
  mainWindow.webContents.on('will-prevent-unload', (event) => { event.preventDefault() })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${PORT}`) || url.startsWith(`http://localhost:${PORT}`)) {
      return { action: 'allow' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Always-on-top toggle, driven by a pin button in the admin UI (preload
// exposes `window.haloPin`). Renderer can't call setAlwaysOnTop itself, so
// we bridge over IPC. 'floating' level keeps the window above other apps'
// windows on macOS, not just our own. Both handlers return the resulting
// state so the button can reflect it without a second round-trip.
ipcMain.handle('halo:pin-get', () => (mainWindow ? mainWindow.isAlwaysOnTop() : false))
ipcMain.handle('halo:pin-toggle', () => {
  if (!mainWindow) return false
  const next = !mainWindow.isAlwaysOnTop()
  mainWindow.setAlwaysOnTop(next, 'floating')
  return next
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
// base64 size reasonable) and matches by id. Returns base64 PNG, or null if
// the window is gone (closed since it was bound) or stays blank/black.
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
      return match.thumbnail.toPNG().toString('base64')
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
    dialog.showErrorBox('Server failed to start', String(err))
    app.exit(1)
    return
  }
  createWindow()
})

// Don't quit when the (transient) setup window closes — startup runs the
// sequence setup-window → close → start server → main window. If we
// quit on window-all-closed during that gap, before-quit kills the
// server we just started. Only honor window-all-closed once the main
// window has existed at least once.
let mainWindowEverShown = false
app.on('window-all-closed', () => {
  if (mainWindowEverShown) app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
  if (!serverProcess) return
  const proc = serverProcess
  if (process.platform === 'win32') {
    // Windows has no signal semantics and no process groups: proc.kill()
    // calls TerminateProcess on the server alone, orphaning everything it
    // spawned (node-pty terminals, cli children) — they keep holding the
    // port / server.lock. taskkill /T walks the whole tree, /F forces it.
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']) } catch {}
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
})
