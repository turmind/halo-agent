#!/usr/bin/env node
/**
 * Stage server runtime + admin static export into resources/, ready for
 * electron-builder to copy via `extraResources`.
 *
 *   resources/
 *   ├── server-runtime/
 *   │   ├── dist/                ← compiled server JS
 *   │   ├── templates/           ← agent / skill / prompt templates
 *   │   ├── package.json
 *   │   └── node_modules/        ← via pnpm deploy (incl. better-sqlite3, node-pty)
 *   └── admin-out/               ← Next.js static export
 *
 * We use `pnpm deploy` to flatten the server's workspace deps into a
 * portable node_modules, so the dmg is self-contained at runtime
 * (system node is still required — node binary itself is not bundled yet).
 */
import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const RES_DIR = path.join(DESKTOP_ROOT, 'resources')
const SERVER_RT = path.join(RES_DIR, 'server-runtime')
const CLI_RT = path.join(RES_DIR, 'cli-runtime')
const ADMIN_OUT_DST = path.join(RES_DIR, 'admin-out')
const NODE_BIN_DST = path.join(RES_DIR, 'node')
const DIST_DIR = path.join(DESKTOP_ROOT, 'dist')

const CLI_DIR = path.join(REPO_ROOT, 'packages', 'cli')
const CLI_PUB = path.join(CLI_DIR, 'dist-pub')

// Pin to the same node major the native modules (better-sqlite3, node-pty)
// were prebuilt against — see packages/server/package.json deps and the
// engines field in repo root.
const NODE_VERSION = 'v22.11.0'

// Target arch for the staged runtime. Defaults to host arch; pass
// `--arch=x64` (or set HALO_TARGET_ARCH=x64) to cross-stage for an
// Intel mac when building from Apple Silicon. We can't validate the
// resulting dmg on this host — only x64-on-x64 or rosetta proves it.
const TARGET_ARCH = (() => {
  const argFlag = process.argv.find((a) => a.startsWith('--arch='))
  if (argFlag) return argFlag.slice('--arch='.length)
  if (process.env.HALO_TARGET_ARCH) return process.env.HALO_TARGET_ARCH
  return process.arch === 'arm64' ? 'arm64' : 'x64'
})()
if (TARGET_ARCH !== 'arm64' && TARGET_ARCH !== 'x64') {
  console.error(`[stage] invalid arch ${TARGET_ARCH} (expected arm64 or x64)`)
  process.exit(1)
}

// Target platform — defaults to current OS. Pass `--platform=win32` (or
// HALO_TARGET_PLATFORM=win32) to stage a Windows build from a mac host.
const TARGET_PLATFORM = (() => {
  const argFlag = process.argv.find((a) => a.startsWith('--platform='))
  if (argFlag) return argFlag.slice('--platform='.length)
  if (process.env.HALO_TARGET_PLATFORM) return process.env.HALO_TARGET_PLATFORM
  return process.platform === 'win32' ? 'win32' : 'darwin'
})()
if (TARGET_PLATFORM !== 'darwin' && TARGET_PLATFORM !== 'win32') {
  console.error(`[stage] invalid platform ${TARGET_PLATFORM} (expected darwin or win32)`)
  process.exit(1)
}
console.log(`[stage] target: ${TARGET_PLATFORM}-${TARGET_ARCH}`)

// Fast mode: re-sync only the build outputs (server dist + templates +
// admin-out) into an already-staged resources/, skipping the network/install
// heavy lifting (cli-runtime npm install, pnpm deploy of node_modules,
// node binary download, prebuild-install). For the "I only changed server/
// admin TS and want a new build" loop — turns a ~1h stage into seconds.
// Requires a prior full stage for the SAME target (a `.stage-meta` marker
// records it); otherwise it errors out and tells you to run a full stage.
const FAST = process.argv.includes('--fast') || process.env.HALO_STAGE_FAST === '1'
const STAGE_META = path.join(RES_DIR, '.stage-meta')

function run(cmd, cwd = REPO_ROOT) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd })
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }) }

// Sanity: make sure builds are fresh enough.
const serverDist = path.join(REPO_ROOT, 'packages', 'server', 'dist', 'index.js')
const adminOut = path.join(REPO_ROOT, 'packages', 'admin', 'out', 'index.html')
if (!fs.existsSync(serverDist)) {
  console.error('[stage] missing packages/server/dist/index.js — run `pnpm --filter @turmind/halo-server build` first')
  process.exit(1)
}
if (!fs.existsSync(adminOut)) {
  console.error('[stage] missing packages/admin/out/index.html — run `cd packages/admin && npx next build --no-lint` first')
  process.exit(1)
}

// Clear old packaged installers from dist/ (dmg / nsis exe / zip + their
// blockmaps). electron-builder cleans its own work dirs (mac-arm64/,
// win-unpacked/) but leaves prior-version installers behind, so dist/
// accumulates one stale artifact per version bump. Wipe them before each
// build — only the current run's artifact should remain. Note the win nsis
// name has a space ("Halo Setup 0.1.0.exe"), so match on extension.
function cleanOldArtifacts() {
  if (!fs.existsSync(DIST_DIR)) return
  for (const f of fs.readdirSync(DIST_DIR)) {
    if (/\.(dmg|exe|zip|blockmap)$/.test(f)) {
      fs.rmSync(path.join(DIST_DIR, f), { force: true })
      console.log(`[stage] removed old artifact dist/${f}`)
    }
  }
}

cleanOldArtifacts()

// Explicit fast mode (--fast / HALO_STAGE_FAST=1): re-sync outputs, never install.
if (FAST) {
  await fastResync()
  process.exit(0)
}

// Auto-fast: if the last full stage was for THIS target AND the dependency
// fingerprint (server/core/cli manifests + lockfile + target/node) is
// unchanged, the staged node_modules is still correct — skip the heavy
// install/deploy/download and just re-sync compiled outputs. This makes a
// plain `pnpm dist:*` after a code-only change as fast as `--fast`, without
// having to remember the flag. Set HALO_STAGE_FULL=1 to force a clean stage.
if (process.env.HALO_STAGE_FULL !== '1' && canAutoFast()) {
  console.log('[stage] deps unchanged since last full stage — taking fast path (set HALO_STAGE_FULL=1 to force a full re-stage)')
  await fastResync()
  process.exit(0)
}

console.log('[stage] cleaning resources/')
rmrf(SERVER_RT)
rmrf(CLI_RT)
rmrf(ADMIN_OUT_DST)
fs.mkdirSync(RES_DIR, { recursive: true })

// 0. CLI runtime (halo tui / cli / setup / acp). MUST run before the
//    server's `pnpm deploy --prod` below: build-bundle needs esbuild (a cli
//    devDep) and the --prod deploy prunes every workspace devDep.
stageCliRuntime()

// 1. pnpm deploy: produce a self-contained server tree. `--prod` skips
//    devDeps; we rely on @turmind/halo-core being listed as a runtime dep of
//    @turmind/halo-server (workspace:* gets resolved into the deployed tree).
//
//    Linker choice matters for cross-platform packaging:
//    - Default (isolated) lays out node_modules as symlinks into .pnpm/.
//      macOS follows them fine, but Windows can't resolve the mac-created
//      Unix symlinks after the tree is copied into the .exe — `import
//      'yaml'` then fails with ERR_MODULE_NOT_FOUND at server startup.
//    - `hoisted` produces a flat, real-directory node_modules (npm-style)
//      that works on every OS. We use it for Windows builds; macOS keeps
//      the lighter symlink layout it's already proven to run with.
console.log('[stage] pnpm deploy server-runtime')
const linkerFlag = TARGET_PLATFORM === 'win32' ? ' --config.node-linker=hoisted' : ''
run(`pnpm deploy --legacy --filter @turmind/halo-server --prod${linkerFlag} "${SERVER_RT}"`)

// `pnpm deploy --prod` prunes the ROOT workspace's node_modules to prod-only as
// a side effect (the devDep symlinks — electron-builder, sharp, png-to-ico,
// typescript — vanish), which then breaks the very next `gen-icon` / build /
// auto-fast run. Re-install to restore the full workspace so the build can
// continue and subsequent runs aren't left with a half-pruned tree.
console.log('[stage] restoring workspace devDeps after deploy')
run('pnpm install --config.verifyDepsBeforeRun=false --config.confirmModulesPurge=false', REPO_ROOT)

// 2. The deploy command brings package.json + dist/ via "files" field, but
//    not templates/ unless it's listed. Confirm and copy if missing.
const tmplSrc = path.join(REPO_ROOT, 'packages', 'server', 'templates')
const tmplDst = path.join(SERVER_RT, 'templates')
if (!fs.existsSync(tmplDst)) {
  console.log('[stage] copying templates/ (not picked up by pnpm deploy)')
  fs.cpSync(tmplSrc, tmplDst, { recursive: true })
}

// 2b. Cross-arch fixup BEFORE trim — prebuild-install needs the deps/
//     directory to be intact (it's where the .node lands).
fetchTargetArchNatives()

// 2c. Trim native module bloat — these get included by `pnpm deploy`'s
//     hard-link from the global pnpm store, but we don't need them at
//     runtime on the target arch.
trimNativeBloat()

// Resolve the real directories of an installed package across both pnpm
// linker layouts. Windows builds use `hoisted` (flat node_modules/<pkg>);
// macOS uses the default isolated layout (node_modules/.pnpm/<pkg>@<ver>/
// node_modules/<pkg>). We must operate on the dir node actually loads, so
// return every match found under either layout.
function resolvePkgDirs(pkgName) {
  const dirs = []
  // hoisted: flat path
  const flat = path.join(SERVER_RT, 'node_modules', pkgName)
  if (fs.existsSync(flat) && !fs.lstatSync(flat).isSymbolicLink()) dirs.push(flat)
  // isolated: under .pnpm/<pkg>@<ver>/node_modules/<pkg>
  const pnpmRoot = path.join(SERVER_RT, 'node_modules', '.pnpm')
  if (fs.existsSync(pnpmRoot)) {
    for (const entry of fs.readdirSync(pnpmRoot)) {
      if (!entry.startsWith(`${pkgName}@`)) continue
      const p = path.join(pnpmRoot, entry, 'node_modules', pkgName)
      if (fs.existsSync(p)) dirs.push(p)
    }
  }
  return dirs
}

function trimNativeBloat() {
  const keepPlat = `${TARGET_PLATFORM}-${TARGET_ARCH}`
  // node-pty: drop everything but the target platform's prebuild.
  for (const ptyDir of resolvePkgDirs('node-pty')) {
    const prebuilds = path.join(ptyDir, 'prebuilds')
    if (!fs.existsSync(prebuilds)) continue
    for (const platDir of fs.readdirSync(prebuilds)) {
      if (platDir === keepPlat) continue
      fs.rmSync(path.join(prebuilds, platDir), { recursive: true, force: true })
    }
    console.log(`[stage] trimmed node-pty prebuilds (kept ${keepPlat})`)
  }
  // better-sqlite3: drop the bundled sqlite3 C source — only used when
  // compiling from source, never at runtime.
  for (const sqlDir of resolvePkgDirs('better-sqlite3')) {
    const deps = path.join(sqlDir, 'deps')
    if (!fs.existsSync(deps)) continue
    fs.rmSync(deps, { recursive: true, force: true })
    console.log(`[stage] trimmed better-sqlite3 sqlite3 source`)
  }
  // Drop server's own src/ + tests/ — pnpm deploy keeps them via the
  // package's "files" field but they're not needed once dist/ is built.
  for (const sub of ['src', 'tests', 'tsconfig.json']) {
    const p = path.join(SERVER_RT, sub)
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true })
      console.log(`[stage] removed server-runtime/${sub}`)
    }
  }
}

// Cross-arch / cross-platform fixup: when staging for an arch or OS that
// differs from the host, pnpm deploy hard-links host-native binaries. Re-
// fetch the right combo via prebuild-install.
function fetchTargetArchNatives() {
  const hostPlatform = process.platform === 'win32' ? 'win32' : 'darwin'
  if (TARGET_ARCH === process.arch && TARGET_PLATFORM === hostPlatform) return
  console.log(`[stage] cross-staging — re-fetching ${TARGET_PLATFORM}-${TARGET_ARCH} native binaries`)
  // better-sqlite3 — re-fetch into every copy node might load (flat +
  // .pnpm). node-pty ships multi-platform prebuilds, no fixup needed.
  for (const pkg of resolvePkgDirs('better-sqlite3')) {
    console.log(`[stage] prebuild-install better-sqlite3 (${TARGET_PLATFORM}-${TARGET_ARCH}) in ${pkg}`)
    execSync(
      `npx --yes prebuild-install --runtime=node --target=22.11.0 --arch=${TARGET_ARCH} --platform=${TARGET_PLATFORM}`,
      { cwd: pkg, stdio: 'inherit' },
    )
  }
  // @parcel/watcher loads a per-platform optional dep package
  // (`@parcel/watcher-<platform>-<arch>`), so pnpm deploy on the host only
  // brought the host's. Install the TARGET's binary package next to the main
  // @parcel/watcher so `require('@parcel/watcher-win32-x64')` resolves at
  // runtime on the packaged app.
  installParcelWatcherBinary()
}

// Ensure the @parcel/watcher native binary for the TARGET platform/arch is
// present in server-runtime. parcel resolves `@parcel/watcher-<plat>-<arch>`
// (linux adds a -glibc/-musl suffix) via require; we npm-install that exact
// package as a sibling so it's found regardless of host.
function installParcelWatcherBinary() {
  const watcherDirs = resolvePkgDirs('@parcel/watcher')
  if (watcherDirs.length === 0) return
  // win32/darwin have no libc suffix; linux desktop builds aren't produced here.
  const pkgName = `@parcel/watcher-${TARGET_PLATFORM}-${TARGET_ARCH}`
  for (const wDir of watcherDirs) {
    const target = path.join(wDir, 'node_modules', `@parcel`, `watcher-${TARGET_PLATFORM}-${TARGET_ARCH}`)
    if (fs.existsSync(target)) continue
    console.log(`[stage] installing ${pkgName} into ${wDir}`)
    execSync(`npm install --no-save --no-audit --no-fund "${pkgName}@2.5.6"`, { cwd: wDir, stdio: 'inherit' })
  }
}

// Stage the CLI runtime (halo tui / cli / setup / acp) as a self-contained
// tree under resources/cli-runtime: the esbuild single-file bundle + its own
// flat prod node_modules. It's deliberately separate from server-runtime —
// the CLI is an in-process client (imports @turmind/halo-server modules, reads
// ~/.halo directly, never starts the HTTP server or grabs server.lock), so
// it can run alongside the desktop app's server. Isolating it costs ~38MB of
// CLI-only deps (ink/react/marked/…) but keeps zero risk of perturbing the
// server tree the Electron app boots.
function stageCliRuntime() {
  // 1. Build the esbuild bundle + publishable layout (dist-pub/). build-bundle
  //    needs esbuild (a cli devDep) — this is why stageCliRuntime() runs before
  //    the server's `pnpm deploy --prod` prunes workspace devDeps.
  console.log('[stage] building cli bundle (dist-pub)')
  run('node scripts/build-bundle.mjs', CLI_DIR)

  // 2. Copy the dist-pub skeleton (bundle + templates + bundled-docs + admin-out
  //    + package.json) into cli-runtime. build-bundle leaves no node_modules,
  //    so this is the lean tree; deps are installed next.
  console.log('[stage] copying cli bundle → cli-runtime')
  fs.cpSync(CLI_PUB, CLI_RT, { recursive: true })

  // 3. Install prod deps with npm (not pnpm): dist-pub/package.json is a plain
  //    flat dependency list, and npm produces a flat real-directory
  //    node_modules with no symlinks — cross-platform safe (the same reason
  //    server-runtime uses node-linker=hoisted for Windows).
  console.log('[stage] npm install --omit=dev (cli-runtime)')
  execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', {
    cwd: CLI_RT,
    stdio: 'inherit',
  })

  // 4. Native fixup for the target. better-sqlite3 ships one prebuild per
  //    platform/arch — npm installed the host's, so re-fetch when cross-staging.
  //    node-pty ships all platforms' prebuilds; just trim to the target.
  const keepPlat = `${TARGET_PLATFORM}-${TARGET_ARCH}`
  const hostPlatform = process.platform === 'win32' ? 'win32' : 'darwin'
  const sqlDir = path.join(CLI_RT, 'node_modules', 'better-sqlite3')
  if ((TARGET_ARCH !== process.arch || TARGET_PLATFORM !== hostPlatform) && fs.existsSync(sqlDir)) {
    console.log(`[stage] prebuild-install better-sqlite3 (${keepPlat}) in cli-runtime`)
    execSync(
      `npx --yes prebuild-install --runtime=node --target=22.11.0 --arch=${TARGET_ARCH} --platform=${TARGET_PLATFORM}`,
      { cwd: sqlDir, stdio: 'inherit' },
    )
    fs.rmSync(path.join(sqlDir, 'deps'), { recursive: true, force: true })
  }
  const ptyPrebuilds = path.join(CLI_RT, 'node_modules', 'node-pty', 'prebuilds')
  if (fs.existsSync(ptyPrebuilds)) {
    for (const platDir of fs.readdirSync(ptyPrebuilds)) {
      if (platDir !== keepPlat) fs.rmSync(path.join(ptyPrebuilds, platDir), { recursive: true, force: true })
    }
    console.log(`[stage] trimmed cli-runtime node-pty prebuilds (kept ${keepPlat})`)
  }
}

// 3. admin out
console.log('[stage] copying admin-out/')
fs.cpSync(path.join(REPO_ROOT, 'packages', 'admin', 'out'), ADMIN_OUT_DST, { recursive: true })

// 4. node binary (for the server child process). We bundle it because
//    Electron's own ELECTRON_RUN_AS_NODE uses the embedded node 20, but
//    the native modules in server-runtime were built for node 22.
//    Always re-stage so a previous arch/platform binary doesn't carry over.
//
// macOS:   tar.gz, contains bin/node (no extension), needs strip+codesign
// Windows: zip,    contains node.exe at root, no strip/codesign step.
const NODE_BIN_DST_FILE = TARGET_PLATFORM === 'win32'
  ? path.join(RES_DIR, 'node.exe')
  : NODE_BIN_DST
const archiveExt = TARGET_PLATFORM === 'win32' ? 'zip' : 'tar.gz'
// Node binary download mirror. nodejs.org is often slow/unreliable from China,
// so default to the npmmirror mirror (same host the repo's ~/.npmrc already
// uses for electron). Override with $HALO_NODE_MIRROR; the path layout
// (`<base>/<version>/node-...`) matches both nodejs.org and the npmmirror.
const NODE_MIRROR = process.env.HALO_NODE_MIRROR ?? 'https://npmmirror.com/mirrors/node'
const archUrl = `${NODE_MIRROR}/${NODE_VERSION}/node-${NODE_VERSION}-${TARGET_PLATFORM === 'win32' ? 'win' : 'darwin'}-${TARGET_ARCH}.${archiveExt}`
// Cache downloaded node archives outside resources/ (which gets wiped on
// every full stage) so re-stages reuse the ~30MB download. One subdir per
// target — win32-x64 / darwin-x64 / darwin-arm64 — so switching build targets
// never clobbers another target's cached archive.
const CACHE_DIR = path.join(DESKTOP_ROOT, '.node-cache', `${TARGET_PLATFORM}-${TARGET_ARCH}`)
const archFile = path.join(CACHE_DIR, `node-${NODE_VERSION}.${archiveExt}`)
const extractRoot = path.join(RES_DIR, `node-${NODE_VERSION}-${TARGET_PLATFORM === 'win32' ? 'win' : 'darwin'}-${TARGET_ARCH}`)

rmrf(NODE_BIN_DST)
rmrf(path.join(RES_DIR, 'node.exe'))
fs.mkdirSync(CACHE_DIR, { recursive: true })
if (fs.existsSync(archFile)) {
  console.log(`[stage] reusing cached node archive ${path.basename(archFile)}`)
} else {
  console.log(`[stage] downloading node ${NODE_VERSION} ${TARGET_PLATFORM}-${TARGET_ARCH}`)
  await downloadFollow(archUrl, archFile)
}
console.log('[stage] extracting node')
if (TARGET_PLATFORM === 'win32') {
  execSync(`unzip -oq "${archFile}" -d "${RES_DIR}"`, { stdio: 'inherit' })
  fs.copyFileSync(path.join(extractRoot, 'node.exe'), NODE_BIN_DST_FILE)
} else {
  execSync(`tar -xzf "${archFile}" -C "${RES_DIR}"`, { stdio: 'inherit' })
  fs.copyFileSync(path.join(extractRoot, 'bin', 'node'), NODE_BIN_DST_FILE)
  fs.chmodSync(NODE_BIN_DST_FILE, 0o755)
}
fs.rmSync(extractRoot, { recursive: true, force: true })
// archFile intentionally kept — cached for the next stage (see CACHE_DIR).

// Ad-hoc resign is macOS-only. We deliberately skip `strip`: recent macOS
// `strip` (Xcode 26 toolchain) removes more than just debug symbols from
// the node binary — it trims the dynamic symbol table to the point where
// `dlopen()` of native addons (better-sqlite3, node-pty) crashes the
// process with SIGSEGV before any JS runs. Saving ~30MB isn't worth a
// dead binary; codesign alone is sufficient for Gatekeeper.
if (TARGET_PLATFORM === 'darwin' && process.platform === 'darwin') {
  console.log('[stage] ad-hoc signing node binary')
  execSync(`codesign --force --sign - "${NODE_BIN_DST_FILE}"`, { stdio: 'inherit' })
}

function downloadFollow(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume()
        downloadFollow(res.headers.location, dest).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`download ${url} → HTTP ${res.statusCode}`))
        res.resume()
        return
      }
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve()))
      out.on('error', reject)
    })
    req.on('error', reject)
  })
}

// Record what was fully staged so `--fast` can verify it's safe to re-sync
// against this layout (same target, node_modules + node binary present).
writeStageMeta()

console.log('[stage] done')
console.log(`  ${SERVER_RT}`)
console.log(`  ${ADMIN_OUT_DST}`)
console.log(`  ${NODE_BIN_DST}`)

function writeStageMeta() {
  fs.writeFileSync(STAGE_META, JSON.stringify({
    target: `${TARGET_PLATFORM}-${TARGET_ARCH}`,
    nodeVersion: NODE_VERSION,
    depsFingerprint: depsFingerprint(),
  }))
}

function readStageMeta() {
  try { return JSON.parse(fs.readFileSync(STAGE_META, 'utf-8')) } catch { return null }
}

// Decide whether a full stage can be skipped in favour of fastResync():
// a prior full stage for the same target, an unchanged dependency fingerprint,
// and the staged node_modules + node binary still present. Pure predicate —
// returns false (→ fall through to full stage) instead of exiting, unlike the
// explicit `--fast` path which hard-fails when prerequisites are missing.
function canAutoFast() {
  const meta = readStageMeta()
  if (!meta) return false
  if (meta.target !== `${TARGET_PLATFORM}-${TARGET_ARCH}`) return false
  if (!meta.depsFingerprint || meta.depsFingerprint !== depsFingerprint()) return false
  const nodeBin = TARGET_PLATFORM === 'win32' ? path.join(RES_DIR, 'node.exe') : NODE_BIN_DST
  for (const p of [path.join(SERVER_RT, 'node_modules'), path.join(CLI_RT, 'node_modules'), nodeBin]) {
    if (!fs.existsSync(p)) return false
  }
  return true
}

// Fingerprint of everything that decides what lands in node_modules: the
// server + cli manifests, the lockfile, and the target/node version. If this
// is unchanged since the last full stage, the staged node_modules is still
// correct and we can skip the heavy install/deploy and just re-sync the
// compiled outputs (the fast path) — turning "I only changed TS" full stages
// into seconds. Any dependency edit changes the hash and forces a real stage.
function depsFingerprint() {
  const h = crypto.createHash('sha256')
  h.update(`${TARGET_PLATFORM}-${TARGET_ARCH}|${NODE_VERSION}`)
  for (const f of [
    path.join(REPO_ROOT, 'packages', 'server', 'package.json'),
    path.join(REPO_ROOT, 'packages', 'core', 'package.json'),
    path.join(CLI_PUB, 'package.json'),
    path.join(REPO_ROOT, 'pnpm-lock.yaml'),
  ]) {
    try { h.update(fs.readFileSync(f)) } catch { h.update(`missing:${f}`) }
  }
  return h.digest('hex')
}

// Replace a staged subdir with a freshly-built source dir. Used only by fast
// mode — full stages build these in place.
function syncDir(src, dst, label) {
  if (!fs.existsSync(src)) {
    console.error(`[fast] missing source ${src} — build it first`)
    process.exit(1)
  }
  rmrf(dst)
  fs.cpSync(src, dst, { recursive: true })
  console.log(`[fast] synced ${label}`)
}

// Fast re-stage: refresh only the build outputs (server dist + templates, the
// cli esbuild bundle, admin-out) into an already-staged resources/, reusing
// the previously-installed node_modules + node binary. The cli bundle embeds
// server+core, so a server-code change must refresh it too — otherwise the
// spawned `halo cli` children would run stale code (silent correctness bug).
async function fastResync() {
  const target = `${TARGET_PLATFORM}-${TARGET_ARCH}`
  const meta = readStageMeta()
  if (meta?.target !== target) {
    console.error(`[fast] no full stage for ${target} (.stage-meta: ${meta?.target ?? 'none'}).`)
    console.error('[fast] run a full stage once first (prepack-win / prepack-dmg / prepack-dmg:x64).')
    process.exit(1)
  }
  const nodeBin = TARGET_PLATFORM === 'win32' ? path.join(RES_DIR, 'node.exe') : NODE_BIN_DST
  for (const p of [path.join(SERVER_RT, 'node_modules'), path.join(CLI_RT, 'node_modules'), nodeBin]) {
    if (!fs.existsSync(p)) {
      console.error(`[fast] staged artifact missing: ${p} — run a full stage first.`)
      process.exit(1)
    }
  }
  console.log(`[fast] re-syncing build outputs for ${target} (reusing node_modules + node binary)`)

  // 1. server-runtime: compiled dist + templates.
  syncDir(path.join(REPO_ROOT, 'packages', 'server', 'dist'), path.join(SERVER_RT, 'dist'), 'server-runtime/dist')
  syncDir(path.join(REPO_ROOT, 'packages', 'server', 'templates'), path.join(SERVER_RT, 'templates'), 'server-runtime/templates')

  // 2. cli-runtime: rebuild the esbuild bundle (cli+server+core), then refresh
  //    only the changed outputs — node_modules is left untouched.
  console.log('[fast] rebuilding cli bundle (esbuild)')
  run('node scripts/build-bundle.mjs', CLI_DIR)
  syncDir(path.join(CLI_PUB, 'dist'), path.join(CLI_RT, 'dist'), 'cli-runtime/dist')
  syncDir(path.join(CLI_PUB, 'templates'), path.join(CLI_RT, 'templates'), 'cli-runtime/templates')
  for (const sub of ['admin-out', 'bundled-docs']) {
    const src = path.join(CLI_PUB, sub)
    if (fs.existsSync(src)) syncDir(src, path.join(CLI_RT, sub), `cli-runtime/${sub}`)
  }

  // 3. resources/admin-out (served by the desktop server).
  syncDir(path.join(REPO_ROOT, 'packages', 'admin', 'out'), ADMIN_OUT_DST, 'admin-out')

  console.log('[fast] done — run electron-builder next (e.g. pnpm dist:win-fast)')
}
