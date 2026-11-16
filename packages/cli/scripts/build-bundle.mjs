#!/usr/bin/env node
/**
 * Build the code-split ESM bundle for `@turmind/halo` and stage the
 * publishable layout under packages/cli/dist-pub/ (HALO_RELEASE=1) or
 * packages/cli/dist-dev/ (default — desktop staging, local tests).
 *
 * Layout produced:
 *
 *   dist-pub/  (or dist-dev/)
 *   ├── package.json     ← rewritten with publish-time fields
 *   ├── README.md
 *   ├── LICENSE
 *   ├── bin/
 *   │   └── halo.js    ← `#!/usr/bin/env node` shim
 *   ├── dist/
 *   │   ├── index.js     ← entry (cli + server + core + their npm deps)
 *   │   ├── evo-wrapper.js ← evo wrapper entry, spawned by evolution/spawn.ts
 *   │   ├── <name>-<hash>.js ← shared / lazily import()ed chunks, flat beside index.js
 *   │   ├── feishu-sdk.cjs ← Lark SDK + its deps, import()ed on first Feishu connect
 *   │   └── third-party-licenses.txt ← license texts of every bundled package
 *   ├── templates/       ← copied from packages/server/templates/
 *   ├── bundled-docs/    ← copied from .halo/docs/ (the user-facing subset)
 *   └── admin-out/       ← copied from packages/admin/out/
 *
 * Path-resolution at runtime (in the bundled `dist/index.js`):
 *   - TEMPLATES_DIR     = __dirname/../templates       (= dist-pub/templates)
 *   - bundled-docs cand = __dirname/../bundled-docs    (= dist-pub/bundled-docs)
 *   - admin-out cand    = __dirname/../admin-out       (= dist-pub/admin-out)
 *
 * Every chunk sits directly in dist/, so `__dirname` is dist/ in all of them.
 *
 * Only native modules (+ xterm, see EXTERNAL_DEPS) stay npm dependencies, so
 * the user's npm install fetches the right prebuilt binaries for their platform.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lockfileIntegrityGate } from './lockfile-integrity.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CLI_ROOT      = path.resolve(__dirname, '..')
const REPO_ROOT     = path.resolve(CLI_ROOT, '..', '..')
const SERVER_ROOT   = path.resolve(REPO_ROOT, 'packages', 'server')
const ADMIN_ROOT    = path.resolve(REPO_ROOT, 'packages', 'admin')
const IS_RELEASE    = process.env.HALO_RELEASE === '1'
// Release bundles (`HALO_RELEASE=1`) stage into dist-pub/; everything else
// (desktop stage-runtime, local bundle tests) into dist-dev/. Physically
// separate so a sha-suffixed dev build can never sit in dist-pub/ and get
// `npm publish`ed by mistake — happened three times (0.1.8, 0.2.1, 1.3.4)
// when the Windows build re-ran this script after the npm publish.
const OUT_NAME      = IS_RELEASE ? 'dist-pub' : 'dist-dev'
const PUB_DIR       = path.resolve(CLI_ROOT, OUT_NAME)

// ── 0. Clean ───────────────────────────────────────────────────────────────
fs.rmSync(PUB_DIR, { recursive: true, force: true })
fs.mkdirSync(path.join(PUB_DIR, 'dist'), { recursive: true })
fs.mkdirSync(path.join(PUB_DIR, 'bin'),  { recursive: true })

console.log(`[build-bundle] cleaned ${OUT_NAME}/`)

// ── TEMPLATE_VERSION gate ──────────────────────────────────────────────────
//
// Server startup only reseeds ~/.halo/global/ when the on-disk stamp is
// strictly below the compiled TEMPLATE_VERSION (index.ts). A templates/ edit
// without a bump therefore never reaches existing installs — it has shipped
// that way four times. Refuse to bundle when templates/ differs from the
// previous release tag and the number didn't move. Also covers the desktop
// packages: stage-runtime.mjs runs this script on both its full and fast paths.
function templateVersionGate() {
  const git = (args) => execSync(`git ${args}`, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  let baseTag
  try {
    // Compare against the PREVIOUS release: at publish time HEAD carries the
    // freshly cut tag and a diff against it would be vacuously empty.
    const taggedHead = git('tag --points-at HEAD').length > 0
    baseTag = git(`describe --tags --abbrev=0 --match "v*" ${taggedHead ? 'HEAD~1' : 'HEAD'}`)
  } catch {
    console.log('[build-bundle] no git / no release tag reachable — skipping TEMPLATE_VERSION gate')
    return
  }
  const changed = git(`diff --name-only ${baseTag} -- packages/server/templates`).split('\n').filter(Boolean)
  if (changed.length === 0) return
  const readVersion = (src) => Number(/TEMPLATE_VERSION = (\d+)/.exec(src)?.[1])
  const was = readVersion(git(`show ${baseTag}:packages/server/src/init.ts`))
  const now = readVersion(fs.readFileSync(path.join(SERVER_ROOT, 'src', 'init.ts'), 'utf-8'))
  if (!(now > was)) {
    console.error(`[build-bundle] FATAL: ${changed.length} file(s) under packages/server/templates changed since ${baseTag} but TEMPLATE_VERSION is still ${now} — bump it in packages/server/src/init.ts or existing installs never reseed:\n  ${changed.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`[build-bundle] TEMPLATE_VERSION gate: ${was} → ${now} (${changed.length} template file(s) since ${baseTag})`)
}
templateVersionGate()

// Release-only: the five workspace packages carry independent `version`
// fields and nothing syncs them. A lagging one ships a build whose
// `halo --version` / admin sidebar disagree with the tag (happened at 0.1.9:
// cli + desktop bumped, server still 0.1.8, core/admin at 0.1.0).
function lockstepVersionGate() {
  if (!IS_RELEASE) return
  const pkgs = ['core', 'server', 'admin', 'cli', 'desktop']
  const versions = pkgs.map((p) => [p, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', p, 'package.json'), 'utf-8')).version])
  const distinct = new Set(versions.map(([, v]) => v))
  if (distinct.size > 1) {
    console.error(`[build-bundle] FATAL: package versions out of lockstep (HALO_RELEASE=1):\n  ${versions.map(([p, v]) => `${p.padEnd(8)} ${v}`).join('\n  ')}`)
    process.exit(1)
  }
  console.log(`[build-bundle] lockstep gate: all 5 packages at ${versions[0][1]}`)
}
lockstepVersionGate()

// Every `resolution:` in pnpm-lock.yaml must carry `integrity`. The pre-release
// `pnpm update -r --prod --no-save` (deploy.md) drops it from tarball-URL deps
// — admin's `xlsx` from the SheetJS CDN lost it at both 2.3.1 and 2.3.2 — and
// `pnpm install --frozen-lockfile` then fails with
// ERR_PNPM_MISSING_TARBALL_INTEGRITY. Runs on every build, like the
// TEMPLATE_VERSION gate: a line scan of the lockfile is a few ms.
lockfileIntegrityGate(path.join(REPO_ROOT, 'pnpm-lock.yaml'))

// ── 1. esbuild bundle ──────────────────────────────────────────────────────
//
// Every npm dep is bundled except EXTERNAL_DEPS, which stay the published
// package's only dependencies (ranges from server's package.json):
// - better-sqlite3, node-pty, @parcel/watcher: native
//   bindings — npm install fetches the right prebuilt binary per platform.
// - @xterm/headless, @xterm/addon-serialize: pure JS, but terminal-manager.ts
//   loads them with a synchronous createRequire on the first terminal; bundled
//   they would be either on the heap at startup or async, which changes when
//   `terminal:start` replies.
// A new native dep must be added here — esbuild can't bundle a `.node` binding.
const EXTERNAL_DEPS = ['better-sqlite3', 'node-pty', '@parcel/watcher', '@xterm/headless', '@xterm/addon-serialize']
// Optional requires inside bundled deps (ws → bufferutil / utf-8-validate,
// node-fetch → encoding). npm never installed them, so they stay external and
// unresolvable: the deps' try/catch fallbacks run exactly as before.
const OPTIONAL_UNINSTALLED = ['bufferutil', 'utf-8-validate', 'encoding']
const EXTERNAL = [...EXTERNAL_DEPS, ...OPTIONAL_UNINSTALLED]

// `react-devtools-core` is imported by `ink/build/devtools.js` at the top
// level even though devtools UI is opt-in via env. We don't ship it. Stub
// it with an empty module so the bundle resolves without dragging in the
// 30+MB devtools tree.
const stubReactDevtoolsPlugin = {
  name: 'stub-react-devtools-core',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({
      path: args.path,
      namespace: 'stub-rdt',
    }))
    b.onLoad({ filter: /.*/, namespace: 'stub-rdt' }, () => ({
      contents: 'export default { connectToDevTools: () => {} }',
      loader: 'js',
    }))
  },
}

// The workspace packages among cli + server + core's declared deps (identified
// by their `workspace:` range, not a name prefix, so a scope rebrand can't
// miss one) — built first below, then inlined through pnpm's symlinks.
function readWorkspaceDeps() {
  const workspace = new Set()
  for (const dir of [CLI_ROOT, SERVER_ROOT, path.join(REPO_ROOT, 'packages', 'core')]) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) workspace.add(name)
    }
  }
  return [...workspace]
}

const WORKSPACE_DEPS = readWorkspaceDeps()

// A bundled package that reads its own package.json finds the halo package's
// (or nothing) once it lives in dist/. Replace that read with the values from
// the package's real package.json at build time — same result as unbundled,
// following every upgrade — and fail when the code moves instead of silently
// shipping a different value.
function pinOwnPackageJson({ pkgName, file, find, replace }) {
  const pin = {
    applied: false,
    plugin: {
      name: `pin-package-json:${pkgName}`,
      setup(b) {
        b.onLoad({ filter: file }, (args) => {
          let dir = path.dirname(args.path)
          while (!fs.existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir)
          const pkgFile = path.join(dir, 'package.json')
          const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf-8')) : {}
          const src = fs.readFileSync(args.path, 'utf-8')
          if (pkg.name !== pkgName || src.split(find).length !== 2) {
            throw new Error(`${args.path}: \`${find}\` not found once — re-check how ${pkgName} reads its package.json`)
          }
          pin.applied = true
          return { contents: src.replace(find, replace(pkg)), loader: 'js' }
        })
      },
    },
  }
  return pin
}
// With splitting, esbuild turns an `import()` of a CommonJS module into a chunk
// whose only export is `default`, while Node's own import() also exposes the
// named exports its cjs-module-lexer finds — so `const { trace } = await
// import('@opentelemetry/api')` (and the aws credential chain's `await
// import('@smithy/credential-provider-imds')`) got undefined. Route each such
// import through a wrapper that re-exports exactly the names Node exposes for
// that file, read by import()ing it in a child node process. `default` is
// `module.exports`, as in Node; the wrapper's require() shares the module's one
// instance with any static importer. A probe that fails fails the build.
// The probe exits in write()'s callback: pipe writes are async on POSIX, and
// exiting right after write() truncated the ~92 KB JSON (8 KB on macOS). The
// forced exit stays — an imported module may leave handles open.
const execFileP = promisify(execFile)
const NAMES_PROBE = `import { pathToFileURL } from 'node:url'
const ns = await import(pathToFileURL(process.argv[1]).href)
process.stdout.write(JSON.stringify(Object.keys(ns)), () => process.exit(0))`
// The export names Node's import() gives a file, in a child node process —
// at most one per core at a time (~30 probes per build, each a full module load).
const PROBE_CONCURRENCY = os.availableParallelism()
const PROBE_TIMEOUT_MS = 30_000
let probesRunning = 0
const probeQueue = []
function probeNames(abs) {
  return new Promise((resolve, reject) => {
    const run = () => {
      probesRunning++
      execFileP(process.execPath, ['--input-type=module', '-e', NAMES_PROBE, abs], { timeout: PROBE_TIMEOUT_MS })
        .then(({ stdout }) => resolve(JSON.parse(stdout)), reject)
        .finally(() => { probesRunning--; probeQueue.shift()?.() })
    }
    if (probesRunning < PROBE_CONCURRENCY) run()
    else probeQueue.push(run)
  })
}
// Hang guard for the build below: abort when it makes no progress for 60s.
// Re-armed as each probe settles, so a slow machine working through the probe
// queue isn't taken for a hang; one probe is capped at 30s, well inside it.
const HANG_TIMEOUT_MS = 60_000
let hangTimer
function armHangTimer() {
  clearTimeout(hangTimer)
  hangTimer = setTimeout(() => {
    console.error(`[build-bundle] esbuild made no progress for ${HANG_TIMEOUT_MS / 1000}s — aborting`)
    process.exit(2)
  }, HANG_TIMEOUT_MS)
  hangTimer.unref()
}
// Node's own rule: .cjs, or .js under a package.json without "type": "module".
function isCommonJs(abs) {
  if (abs.endsWith('.cjs')) return true
  if (!abs.endsWith('.js')) return false
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    const pj = path.join(dir, 'package.json')
    if (fs.existsSync(pj)) return JSON.parse(fs.readFileSync(pj, 'utf-8')).type !== 'module'
    if (path.dirname(dir) === dir) return true
  }
}
const cjsNamesCache = new Map()
const cjsNames = (abs) => {
  if (!cjsNamesCache.has(abs)) cjsNamesCache.set(abs, probeNames(abs).finally(armHangTimer))
  return cjsNamesCache.get(abs)
}
// The wrapper's path is kept relative to the repo root: esbuild prints it into
// the chunk (`// cjs-names:…` comment, `__esm` key), where an absolute path
// would ship the build machine's directory layout.
const CJS_NAMES_NS = 'cjs-names'
const cjsDynamicImportPlugin = {
  name: 'cjs-dynamic-import-names',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.kind !== 'dynamic-import' || args.pluginData?.cjsProbe) return undefined
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { cjsProbe: true } })
      if (r.errors.length > 0 || r.external || !r.path.includes(`${path.sep}node_modules${path.sep}`) || !isCommonJs(r.path)) return undefined
      return { path: path.relative(REPO_ROOT, r.path), namespace: CJS_NAMES_NS, pluginData: await cjsNames(r.path) }
    })
    b.onLoad({ filter: /.*/, namespace: CJS_NAMES_NS }, (args) => {
      const abs = path.resolve(REPO_ROOT, args.path)
      const named = args.pluginData.filter((n) => n !== 'default')
      return {
        contents: [
          `const m = require(${JSON.stringify(abs)})`,
          'export default m',
          ...named.map((n, i) => `var n${i} = m[${JSON.stringify(n)}]; export { n${i} as ${JSON.stringify(n)} }`),
        ].join('\n'),
        resolveDir: path.dirname(abs),
        loader: 'js',
      }
    })
  },
}

// ink reads `../package.json` for its devtools renderer name/version, only when
// DEV=true (which also tries to load the uninstalled react-devtools-core).
const inkPackagePin = pinOwnPackageJson({
  pkgName: 'ink',
  file: /[\\/]ink[\\/]build[\\/]reconciler\.js$/,
  find: "const content = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');",
  replace: (pkg) => `const content = ${JSON.stringify(JSON.stringify({ name: pkg.name, version: pkg.version }))};`,
})

// The Feishu SDK gets its own file instead of a chunk of the main build: it is
// CJS-only in spirit (reads `__dirname`, `require`s its deps), and as a split
// chunk it would share modules (axios, form-data, …) with other chunks and
// pull them all in — measured 4.6 MB vs 0.7 MB standalone. server's
// channels/feishu/lark-sdk.js is the only module importing its values and
// handler.js `import()`s it on the first connect; the main build rewrites that
// import to `./feishu-sdk.cjs` (kept external, so it stays a runtime import)
// and a second build bundles lark-sdk.js with all its deps (ws included) into
// that file.
const LARK_SDK = '@larksuiteoapi/node-sdk'
const FEISHU_SDK_SRC = path.join(SERVER_ROOT, 'dist', 'channels', 'feishu', 'lark-sdk.js')
const FEISHU_SDK_OUT = './feishu-sdk.cjs'
const feishuSdkExternalPlugin = {
  name: 'feishu-sdk-external',
  setup(b) {
    b.onResolve({ filter: /\/lark-sdk\.js$/ }, (args) =>
      path.resolve(args.resolveDir, args.path) === FEISHU_SDK_SRC ? { path: FEISHU_SDK_OUT, external: true } : undefined)
  },
}
// The SDK builds its User-Agent (`oapi-node-sdk/<version>`) from getSdkVersion(),
// which reads `__dirname/../package.json` and fell back to `unknown` once bundled.
const larkSdkVersionPin = pinOwnPackageJson({
  pkgName: LARK_SDK,
  file: /[\\/]@larksuiteoapi[\\/]node-sdk[\\/]es[\\/]index\.js$/,
  find: 'function getSdkVersion() {',
  replace: (pkg) => `function getSdkVersion() {\n    return ${JSON.stringify(pkg.version)};`,
})

// esbuild resolves each inlined `workspace:*` dep through its package.json
// "main" (= dist/, the tsc output), NOT its TS source. So a stale or missing
// dist means the bundle silently ships old code — this is exactly how an
// acp-adapter change could get built, committed, and packaged yet never reach
// users. Build every workspace dep first (one pnpm invocation — pnpm orders
// them by the dependency graph and dedupes; tsc is incremental so unchanged
// packages cost ~nothing).
if (WORKSPACE_DEPS.length > 0) {
  const filters = WORKSPACE_DEPS.map((n) => `--filter ${n}`).join(' ')
  console.log(`[build-bundle] building workspace deps before bundling: ${WORKSPACE_DEPS.join(', ')}`)
  execSync(`pnpm ${filters} build`, { cwd: REPO_ROOT, stdio: 'inherit' })
}

// Version stamped into the bundle as a compile-time constant. The bundle is a
// single file with no package.json beside the source, so the server can't read
// its own version at runtime — esbuild's `define` replaces `process.env.HALO_VERSION`
// with this literal. Surfaced via GET /api/health + `halo --version`.
//
// We suffix the base version with the short git sha (`0.1.1-<sha>`) so every
// build is uniquely identifiable and maps exactly to a commit — telling apart
// "did my new build actually deploy?" at a glance. A dirty tree gets a
// `-dirty` marker. Falls back to the bare version if git isn't available
// (e.g. building from an unpacked tarball).
//
// EXCEPT for an npm release (`HALO_RELEASE=1`): a `-<sha>` suffix is a semver
// prerelease, which `npm install @turmind/halo` skips by default and never
// becomes `latest`. A tagged release publishes the bare base version (`0.1.1`)
// — the version number IS the identifier there, no sha needed.
const BASE_VERSION = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8')).version
function gitVersion() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0
    return `${BASE_VERSION}-${sha}${dirty ? '-dirty' : ''}`
  } catch {
    return BASE_VERSION
  }
}
const PKG_VERSION = IS_RELEASE ? BASE_VERSION : gitVersion()
console.log(`[build-bundle] version: ${PKG_VERSION}${IS_RELEASE ? ' (release)' : ''}`)

// ESM output with code splitting: the workspace packages and their npm deps
// are bundled, and every `import()` in the source becomes its own chunk, so a
// dep reached only through a lazy import (TUI, OTel, Telegram, WeCom, jimp, …)
// is still read from disk only when that path runs — as it was from
// node_modules. Loading the server pulls in only its static import graph.
//
// What keeps the deps' runtime behavior unchanged:
// - `conditions: []` drops esbuild's default `module` condition, so each
//   package resolves to the same file Node picks (`node` / `import` /
//   `default`) — e.g. @smithy/core's dist-cjs and @opentelemetry/api's
//   build/src rather than their ESM builds. Costs ~4 MB of less-shaken CJS.
// - The banner gives every chunk a real `require`, which esbuild's CJS shim
//   uses for `require('buffer')`-style calls in bundled CJS deps (without it
//   they throw "Dynamic require of … is not supported").
// - `__dirname` is not defined: the CJS deps that read it either guard on
//   `typeof __dirname` (@aws-sdk/util-user-agent-node) or only print it.
// - No `process.env.NODE_ENV` define: react still picks its build at runtime.
// Second entry: the evo wrapper. The server spawns it as its own process
// (`node <dir of spawn.ts's code>/evo-wrapper.js`, evolution/spawn.ts), which
// in the bundle means `dist/evo-wrapper.js` beside index.js. Without it every
// evo run on an npm install died at `Cannot find module` and timed out
// (1.6.0–2.0.4). Its `argv[1] === import.meta.url` entry guard holds only while
// the wrapper module's own code lands in evo-wrapper.js, not a shared chunk —
// checked after the build.
const EVO_WRAPPER_SRC = path.join(SERVER_ROOT, 'dist', 'evolution', 'evo-wrapper.js')
const DIST_DIR = path.join(PUB_DIR, 'dist')
const buildPromise = Promise.all([build({
  entryPoints: {
    index: path.join(CLI_ROOT, 'src', 'index.ts'),
    'evo-wrapper': EVO_WRAPPER_SRC,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  splitting: true,
  outdir: DIST_DIR,
  // Flat in dist/: init.ts, spawn.ts and server/index.ts resolve templates/,
  // evo-wrapper.js and admin-out/ from their chunk's own directory.
  chunkNames: '[name]-[hash]',
  conditions: [],
  external: EXTERNAL,
  banner: { js: "import { createRequire as __haloCreateRequire } from 'node:module'; const require = __haloCreateRequire(import.meta.url);" },
  define: {
    'process.env.HALO_VERSION': JSON.stringify(PKG_VERSION),
  },
  plugins: [stubReactDevtoolsPlugin, feishuSdkExternalPlugin, inkPackagePin.plugin, cjsDynamicImportPlugin],
  sourcemap: false,
  // The deps' in-source license comments, collected at the end of each output
  // file (third-party-licenses.txt below covers the packages' license files).
  legalComments: 'eof',
  logLevel: 'info',
  metafile: true,
}), build({
  // Third entry: dist/feishu-sdk.cjs (see LARK_SDK above), with every dep but
  // the natives bundled. `module` first: the SDK's ESM build tree-shakes down
  // to the three exports lark-sdk.js names, its CJS `main` doesn't.
  entryPoints: { 'feishu-sdk': FEISHU_SDK_SRC },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outdir: DIST_DIR,
  outExtension: { '.js': '.cjs' },
  external: EXTERNAL,
  mainFields: ['module', 'main'],
  plugins: [larkSdkVersionPin.plugin],
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'info',
  metafile: true,
})])

armHangTimer()
const [mainResult, feishuSdkResult] = await buildPromise
clearTimeout(hangTimer)

const fatal = (msg) => {
  console.error(`[build-bundle] FATAL: ${msg}`)
  process.exit(1)
}
const mainOutputs = mainResult.metafile.outputs
const outputKey = (pred) => Object.keys(mainOutputs).find(pred)
const evoKey = outputKey((k) => path.resolve(k) === path.join(DIST_DIR, 'evo-wrapper.js'))
if (!evoKey) fatal('dist/evo-wrapper.js missing — every evo run would fail with `Cannot find module` and time out.')
if (!Object.keys(mainOutputs[evoKey].inputs).some((p) => path.resolve(p) === EVO_WRAPPER_SRC)) {
  fatal('evo-wrapper.js\'s own module landed in a shared chunk — its `argv[1] === import.meta.url` entry guard would never hold.')
}
// If the lark-sdk.js rewrite ever stops matching, esbuild silently inlines the
// whole SDK into a main-build chunk. Fail instead.
const inlinedSdk = Object.keys(mainResult.metafile.inputs).filter((p) => p.includes(LARK_SDK) || p.endsWith('/lark-sdk.js'))
if (inlinedSdk.length > 0) fatal(`the Feishu SDK got inlined into the main build (${inlinedSdk[0]}) — the lark-sdk.js → ${FEISHU_SDK_OUT} rewrite didn't match.`)
for (const [pin, what] of [[larkSdkVersionPin, `${FEISHU_SDK_OUT}'s User-Agent version`], [inkPackagePin, 'ink\'s package.json read']]) {
  if (!pin.applied) fatal(`the pin for ${what} never applied — the file it patches was not bundled.`)
}

// Lazy-load gate: these deps are reached only through an `import()` on the path
// that needs them (TUI, a channel's first connect, an OTel endpoint, an image
// tool call). A static import added anywhere on the startup path would make
// esbuild hoist them into a chunk loaded on every start — invisible except on
// the heap. Walk the static-import closure of each startup root: the two
// entries, the server chunk (`halo server`) and the harness chunk (`halo cli`
// / tui / agents / sessions).
const LAZY_DEPS = /^(@opentelemetry\/.*|@wecom\/aibot-node-sdk|grammy|@grammyjs\/.*|qrcode|ink|ink-spinner|react|react-dom|react-reconciler|marked|marked-terminal|jimp|@jimp\/.*|undici)$/
const pkgOf = (input) => /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/.exec(input)?.[1]
function staticClosure(key) {
  const seen = new Set()
  const stack = [key]
  while (stack.length) {
    const k = stack.pop()
    if (seen.has(k)) continue
    seen.add(k)
    for (const i of mainOutputs[k].imports) if (i.kind === 'import-statement' && !i.external) stack.push(i.path)
  }
  return seen
}
const chunkOf = (src) => outputKey((k) => mainOutputs[k].entryPoint && path.resolve(mainOutputs[k].entryPoint) === src)
const startupRoots = [
  ['index.js', outputKey((k) => path.resolve(k) === path.join(DIST_DIR, 'index.js'))],
  ['evo-wrapper.js', evoKey],
  ['the server chunk', chunkOf(path.join(SERVER_ROOT, 'dist', 'index.js'))],
  ['the harness chunk', chunkOf(path.join(CLI_ROOT, 'src', 'harness.ts'))],
]
for (const [label, root] of startupRoots) {
  if (!root) fatal(`no output for ${label} in the metafile — the lazy-load gate can't run.`)
  const hoisted = new Set()
  for (const k of staticClosure(root)) {
    for (const input of Object.keys(mainOutputs[k].inputs)) {
      const pkg = pkgOf(input)
      if (pkg && LAZY_DEPS.test(pkg)) hoisted.add(pkg)
    }
  }
  if (hoisted.size > 0) fatal(`${[...hoisted].sort().join(', ')} statically reachable from ${label} — some startup-path module imports them without import().`)
}

// Export-names gate: every `import()` of a dep must yield the names Node's own
// import() gives the original file — the bug class cjsDynamicImportPlugin
// fixes, checked on the output rather than trusted. The chunk side is the
// metafile's `exports` (exactly what an ESM chunk's namespace holds); our own
// sources are tsc-checked and skipped. ink's devtools.js can't load unbundled
// (it needs the uninstalled react-devtools-core, stubbed above), so it has no
// reference to compare against.
const UNLOADABLE_UNBUNDLED = /[\\/]ink[\\/]build[\\/]devtools\.js$/
const dynTargets = new Set()
for (const input of Object.values(mainResult.metafile.inputs)) {
  for (const i of input.imports) if (i.kind === 'dynamic-import' && !i.external) dynTargets.add(i.path)
}
const nameDiffs = await Promise.all([...dynTargets].map(async (target) => {
  const abs = target.startsWith(`${CJS_NAMES_NS}:`) ? path.resolve(REPO_ROOT, target.slice(CJS_NAMES_NS.length + 1)) : path.resolve(target)
  if (!abs.includes(`${path.sep}node_modules${path.sep}`) || UNLOADABLE_UNBUNDLED.test(abs)) return undefined
  const chunk = outputKey((k) => mainOutputs[k].entryPoint === target)
  if (!chunk) return `${target}: no chunk in the metafile`
  const want = await (cjsNamesCache.get(abs) ?? probeNames(abs)).catch((err) => fatal(`can't load ${abs} unbundled to read its export names: ${String(err).split('\n')[0]}`))
  const got = mainOutputs[chunk].exports
  const missing = want.filter((n) => !got.includes(n))
  const extra = got.filter((n) => !want.includes(n))
  if (missing.length + extra.length === 0) return null
  return `${path.relative(REPO_ROOT, abs)} → ${path.basename(chunk)}: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`
}))
const nameErrors = nameDiffs.filter(Boolean)
if (nameErrors.length > 0) fatal(`import() of a bundled dep yields other export names than Node gives the original:\n  ${nameErrors.join('\n  ')}`)
console.log(`[build-bundle] export-names gate: ${nameDiffs.filter((d) => d === null).length} dep import() targets match Node's names`)

// The bundled packages' own LICENSE / NOTICE files no longer reach
// node_modules, and many carry no in-source license comment for esbuild to
// keep — ship their texts beside the bundle. A package that ships no license
// file (14 at 2.2.7: drizzle-orm, simple-git, agent-base, …) gets the standard
// SPDX text of its package.json license (scripts/licenses/) under a copyright
// line naming its package.json author, or its repository when there is none.
// MIT's text carries the copyright line (its `<year>` dropped — unknown);
// Apache-2.0's has none outside its how-to-apply appendix, so one is prepended.
const LICENSE_TEMPLATES_DIR = path.join(__dirname, 'licenses')
const MIT_HOLDER = '<copyright holders>'
function standardLicenseText(pkg) {
  const template = path.join(LICENSE_TEMPLATES_DIR, `${pkg.license}.txt`)
  if (typeof pkg.license !== 'string' || !fs.existsSync(template)) {
    fatal(`${pkg.name}@${pkg.version} ships no license file and its license ${JSON.stringify(pkg.license)} has no template in scripts/licenses/ — add one.`)
  }
  const person = (p) => typeof p === 'string' ? p : p?.name
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const holder = person(pkg.author) || person(pkg.contributors?.[0]) || (repo && `the ${pkg.name} authors (${repo})`)
  if (!holder) fatal(`${pkg.name}@${pkg.version} ships no license file and names no author or repository to credit.`)
  const text = fs.readFileSync(template, 'utf-8').trim()
  const licensed = text.includes(MIT_HOLDER) ? text.replace(MIT_HOLDER, holder) : `Copyright ${holder}\n\n${text}`
  return `(no license file in package; standard ${pkg.license} text for the license its package.json declares)\n\n${licensed}`
}
const bundledPkgDirs = new Set()
for (const p of [...Object.keys(mainResult.metafile.inputs), ...Object.keys(feishuSdkResult.metafile.inputs)]) {
  if (p.startsWith(`${CJS_NAMES_NS}:`)) continue // wrapper of a file input listed on its own
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/.exec(p)
  if (m) bundledPkgDirs.add(path.resolve(m[1]))
}
const licenseTexts = [...bundledPkgDirs].map((dir) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
  const { name, version } = pkg
  const files = fs.readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying|copyrightnotice)/i.test(f)).sort()
  const body = files.length > 0
    ? files.map((f) => fs.readFileSync(path.join(dir, f), 'utf-8').trim()).join('\n\n')
    : standardLicenseText(pkg)
  return { id: `${name}@${version}`, text: `${name}@${version}\n\n${body}\n` }
}).sort((a, b) => a.id.localeCompare(b.id))
fs.writeFileSync(path.join(DIST_DIR, 'third-party-licenses.txt'), licenseTexts.map((l) => l.text).join(`\n${'-'.repeat(72)}\n\n`), 'utf-8')
console.log(`[build-bundle] bundled ${Object.keys(mainOutputs).length} files + dist/feishu-sdk.cjs (${bundledPkgDirs.size} third-party packages)`)

// ── 2. bin shim ────────────────────────────────────────────────────────────
// Silence two always-noise Node warnings that transitive deps trigger on
// startup — a JSON-module ExperimentalWarning and the punycode DEP0040
// DeprecationWarning — which otherwise print before the TUI even paints and
// the user can do nothing about. Patch emitWarning BEFORE the app's module
// graph loads; a static `import` is hoisted above this assignment and would
// load (and warn from) the deps first, so we load the entry via dynamic import.
// The same dynamic import is what lets the Node-version gate run first: on an
// old Node the bundle dies mid-parse with an error that never names Node (v18:
// "Invalid regular expression flags"). The shim itself must stay old-Node
// parseable. Mirrors bin/halo.js (the source-checkout shim).
const SHIM = `#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('halo requires Node.js 22 or newer (found ' + process.version + '). Upgrade: https://nodejs.org/ (or \`nvm install 22\`)\\n')
  process.exit(1)
}
const emit = process.emitWarning.bind(process)
process.emitWarning = (warning, ...args) => {
  const o = args[0]
  const type = typeof o === 'string' ? o : o && o.type
  if (type === 'ExperimentalWarning' || type === 'DeprecationWarning') return
  return emit(warning, ...args)
}
await import('../dist/index.js')
`
fs.writeFileSync(path.join(PUB_DIR, 'bin', 'halo.js'), SHIM, { mode: 0o755 })
fs.chmodSync(path.join(PUB_DIR, 'bin', 'halo.js'), 0o755)
console.log('[build-bundle] wrote bin/halo.js')

// ── 3. copy templates / bundled-docs / admin-out ──────────────────────────

function copyTree(src, dst, filter) {
  if (!fs.existsSync(src)) {
    console.warn(`[build-bundle] missing source ${src}, skipping`)
    return
  }
  fs.cpSync(src, dst, { recursive: true, filter })
}

// Finder drops .DS_Store into any browsed dir; gitignored, so a Mac-side
// publish would otherwise ship it (electron-builder strips it, npm doesn't).
copyTree(
  path.join(SERVER_ROOT, 'templates'),
  path.join(PUB_DIR, 'templates'),
  (src) => path.basename(src) !== '.DS_Store',
)
console.log('[build-bundle] copied templates/')

// bundled-docs: prefer packages/server/bundled-docs if it exists (set by
// packaging step), otherwise copy from monorepo .halo/docs/.
const bundledDocsCandidates = [
  path.join(SERVER_ROOT, 'bundled-docs'),
  path.join(REPO_ROOT, '.halo', 'docs'),
]
const docsSrc = bundledDocsCandidates.find((p) => fs.existsSync(p))
if (docsSrc) {
  // The bundle must never ship anything gitignored. That's the single rule —
  // *.local.md (host infra: AWS account id, internal domains, EC2/CloudFront
  // ids), plans/ and test/ (internal WIP) are all gitignored, and so is
  // anything the maintainer ignores in the future. Rather than hard-code the
  // list (which drifts out of sync with .gitignore — the root cause of the
  // 0.1.2–0.1.8 infra leak), ask git directly: gitignored → not shipped.
  //
  // `git check-ignore --stdin` answers in one call. It only works when docsSrc
  // lives inside the git work tree (the `.halo/docs` candidate does; the
  // `server/bundled-docs` packaging candidate may not, and git may be absent
  // when building from an unpacked tarball) — so we fall back to a `.local.md`
  // suffix guard, which is the one exclusion that is itself a hard security
  // requirement regardless of git.
  // Feed git every path under docsSrc — both files AND directories — so the
  // returned set contains ignored dirs (e.g. `plans`, `test`) directly, not
  // just the files under them. cpSync's filter is asked about each dir before
  // recursing, so an ignored dir in the set means we skip it whole (no empty
  // shell left behind).
  const ignored = (() => {
    try {
      const paths = []
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const f = path.join(dir, e.name)
          paths.push(f)
          if (e.isDirectory()) walk(f)
        }
      }
      walk(docsSrc)
      const out = execSync('git check-ignore --stdin', {
        cwd: docsSrc, input: paths.join('\n'), stdio: ['pipe', 'pipe', 'ignore'],
      }).toString()
      return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
    } catch {
      return null // git unavailable or docsSrc outside a work tree → fall back
    }
  })()
  const docsFilter = (p) => {
    if (p.endsWith('.local.md')) return false           // hard security guard, git-independent
    if (ignored) return !ignored.has(p)                  // primary rule: gitignored (file or dir) → excluded
    // Fallback when git can't answer: replicate the known gitignored dirs.
    const rel = path.relative(docsSrc, p)
    if (rel === 'plans' || rel.startsWith('plans' + path.sep)) return false
    if (rel === 'test' || rel.startsWith('test' + path.sep)) return false
    return true
  }
  copyTree(docsSrc, path.join(PUB_DIR, 'bundled-docs'), docsFilter)
  console.log(`[build-bundle] copied bundled-docs/ from ${path.relative(REPO_ROOT, docsSrc)}${ignored ? ` (excluded ${ignored.size} gitignored)` : ' (git unavailable — used static fallback)'}`)
}

const adminOut = path.join(ADMIN_ROOT, 'out')
if (fs.existsSync(adminOut)) {
  copyTree(adminOut, path.join(PUB_DIR, 'admin-out'))
  console.log('[build-bundle] copied admin-out/')

  // Copy Monaco's min/vs into admin-out/monaco/vs so the editor works offline.
  // copy-monaco.mjs already stages this into admin/out during the admin `build`
  // script, so the copyTree above usually carries monaco across already. We
  // re-copy here as a backstop (monaco-editor is admin's devDependency, not
  // installed on the user's machine, so the files must ship inside admin-out).
  // Resolve from ADMIN_ROOT, NOT this script's dir: monaco-editor lives in
  // admin/node_modules, never cli's, so createRequire(import.meta.url) can't
  // find it — that silent miss is how a monaco-less 0.1.7 shipped.
  const { createRequire } = await import('node:module')
  const req = createRequire(path.join(ADMIN_ROOT, 'package.json'))
  try {
    const monacoPkg = req.resolve('monaco-editor/package.json')
    const vsSrc = path.join(path.dirname(monacoPkg), 'min', 'vs')
    const vsDst = path.join(PUB_DIR, 'admin-out', 'monaco', 'vs')
    fs.mkdirSync(path.dirname(vsDst), { recursive: true })
    fs.cpSync(vsSrc, vsDst, { recursive: true })
    console.log('[build-bundle] copied monaco min/vs → admin-out/monaco/vs')
  } catch (e) {
    console.warn(`[build-bundle] WARNING: backstop monaco copy failed: ${e.message}`)
  }

  // Hard gate: whether monaco came from admin/out or the backstop above, the
  // loader MUST exist. Without it the editor fetches loader.js, gets the 404
  // HTML fallback, and throws "Unexpected token '<'" — exactly the 0.1.7
  // regression. Never ship a silently monaco-less bundle again: fail loudly.
  const loaderJs = path.join(PUB_DIR, 'admin-out', 'monaco', 'vs', 'loader.js')
  if (!fs.existsSync(loaderJs)) {
    console.error('[build-bundle] FATAL: admin-out/monaco/vs/loader.js missing — Monaco editor would 404. Run `pnpm --filter @turmind/halo-admin build` (it runs copy-monaco) before bundling.')
    process.exit(1)
  }
  console.log('[build-bundle] verified monaco loader.js present')
} else {
  console.warn('[build-bundle] WARNING: packages/admin/out/ not found — run `pnpm --filter @turmind/halo-admin build` first')
}

// ── 4. emit publish-ready package.json ─────────────────────────────────────

const cliPkg = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8'))

// Runtime dependencies: exactly EXTERNAL_DEPS (the bundle leaves them as
// imports), with server's declared ranges.
const serverPkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf-8'))
const dependencies = Object.fromEntries(EXTERNAL_DEPS.map((name) => {
  const range = serverPkg.dependencies?.[name]
  if (!range) fatal(`external dep ${name} is not in packages/server/package.json dependencies.`)
  return [name, range]
}).sort(([a], [b]) => a.localeCompare(b)))

const pubPkg = {
  name: '@turmind/halo',
  // Same sha-suffixed version as the in-bundle constant, so `npm ls -g`,
  // `halo --version`, and GET /api/health all agree on one string.
  version: PKG_VERSION,
  description: 'Halo — multi-agent collaborative workspace. CLI + TUI + HTTP/WS server in one package.',
  type: 'module',
  license: cliPkg.license || 'MIT',
  bin: { halo: './bin/halo.js' },
  // Files included in the published tarball. Keep this exhaustive — anything
  // outside the list is excluded regardless of .gitignore.
  files: [
    'bin',
    'dist',
    'templates',
    'bundled-docs',
    'admin-out',
    'README.md',
    'LICENSE',
  ],
  dependencies,
  engines: { node: '>=22' },
  publishConfig: { access: 'public' },
  repository: {
    type: 'git',
    url: 'git+https://github.com/turmind/halo-agent.git',
  },
  keywords: ['agent', 'ai', 'multi-agent', 'workspace', 'orchestrator', 'halo', 'claude'],
}

fs.writeFileSync(
  path.join(PUB_DIR, 'package.json'),
  JSON.stringify(pubPkg, null, 2) + '\n',
  'utf-8',
)
console.log('[build-bundle] wrote package.json')

// ── 5. README + LICENSE ────────────────────────────────────────────────────

const repoLicense = path.join(REPO_ROOT, 'LICENSE')
if (fs.existsSync(repoLicense)) {
  fs.copyFileSync(repoLicense, path.join(PUB_DIR, 'LICENSE'))
}

const repoReadme = path.join(REPO_ROOT, 'README.md')
if (fs.existsSync(repoReadme)) {
  fs.copyFileSync(repoReadme, path.join(PUB_DIR, 'README.md'))
} else {
  // Minimal placeholder so npm doesn't complain about a missing README.
  fs.writeFileSync(
    path.join(PUB_DIR, 'README.md'),
    `# @turmind/halo\n\nMulti-agent collaborative workspace. Run \`halo setup\` after install.\n`,
    'utf-8',
  )
}

// ── 6. summary ─────────────────────────────────────────────────────────────

function dirSize(dir) {
  let bytes = 0
  function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.isFile()) bytes += fs.statSync(f).size
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return bytes
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

console.log('')
console.log(`[build-bundle] DONE — staged at packages/cli/${OUT_NAME}/`)
console.log(`  total size:    ${fmt(dirSize(PUB_DIR))}`)
console.log(`  dist/:         ${fmt(dirSize(DIST_DIR))} (${fs.readdirSync(DIST_DIR).length} files; index.js ${fmt(fs.statSync(path.join(DIST_DIR, 'index.js')).size)})`)
console.log(`  dependencies:  ${Object.keys(dependencies).join(', ')}`)
console.log(`  templates:     ${fmt(dirSize(path.join(PUB_DIR, 'templates')))}`)
console.log(`  bundled-docs:  ${fmt(dirSize(path.join(PUB_DIR, 'bundled-docs')))}`)
console.log(`  admin-out:     ${fmt(dirSize(path.join(PUB_DIR, 'admin-out')))}`)
console.log('')
if (IS_RELEASE) {
  console.log('Next:')
  console.log('  cd packages/cli/dist-pub')
  console.log('  npm pack --dry-run        # preview tarball contents')
  console.log('  npm publish               # release to registry — ONCE; confirm with `npm view @turmind/halo version`')
} else {
  console.log('Dev build (sha-suffixed version) — not publishable. For an npm release run with HALO_RELEASE=1.')
}
