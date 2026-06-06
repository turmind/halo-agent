#!/usr/bin/env node
/**
 * Build a single-file ESM bundle for `@turmind/halo` and stage the
 * publishable layout under packages/cli/dist-pub/.
 *
 * Layout produced:
 *
 *   dist-pub/
 *   ├── package.json     ← rewritten with publish-time fields
 *   ├── README.md
 *   ├── LICENSE
 *   ├── bin/
 *   │   └── halo.js    ← `#!/usr/bin/env node` shim
 *   ├── dist/
 *   │   └── index.js     ← esbuild bundle (cli + server + core)
 *   ├── templates/       ← copied from packages/server/templates/
 *   ├── bundled-docs/    ← copied from .halo/docs/ (the user-facing subset)
 *   └── admin-out/       ← copied from packages/admin/out/
 *
 * Path-resolution at runtime (in the bundled `dist/index.js`):
 *   - TEMPLATES_DIR     = __dirname/../templates       (= dist-pub/templates)
 *   - bundled-docs cand = __dirname/../bundled-docs    (= dist-pub/bundled-docs)
 *   - admin-out cand    = __dirname/../admin-out       (= dist-pub/admin-out)
 *
 * Native modules (better-sqlite3, node-pty) are kept external so the user's
 * npm install can fetch the right prebuilt binaries for their platform.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CLI_ROOT      = path.resolve(__dirname, '..')
const REPO_ROOT     = path.resolve(CLI_ROOT, '..', '..')
const SERVER_ROOT   = path.resolve(REPO_ROOT, 'packages', 'server')
const ADMIN_ROOT    = path.resolve(REPO_ROOT, 'packages', 'admin')
const PUB_DIR       = path.resolve(CLI_ROOT, 'dist-pub')

// ── 0. Clean ───────────────────────────────────────────────────────────────
fs.rmSync(PUB_DIR, { recursive: true, force: true })
fs.mkdirSync(path.join(PUB_DIR, 'dist'), { recursive: true })
fs.mkdirSync(path.join(PUB_DIR, 'bin'),  { recursive: true })

console.log('[build-bundle] cleaned dist-pub/')

// ── 1. esbuild bundle ──────────────────────────────────────────────────────
//
// Externals: any package with a native binding stays external so npm install
// at the user's machine resolves the right prebuilt binary. Keep the list
// short — the rest gets bundled to keep the install footprint flat.

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

// Build the external list explicitly: every dep declared in cli + server +
// core's package.json, except @halo/* workspace packages. esbuild bundles
// what's not external — so @halo/* (workspace, reached through pnpm's
// symlinks) gets inlined automatically, no plugin needed.
function readDepsList() {
  const cli    = JSON.parse(fs.readFileSync(path.join(CLI_ROOT,    'package.json'), 'utf-8'))
  const server = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf-8'))
  const core   = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'core', 'package.json'), 'utf-8'))
  const names = new Set()
  for (const pkg of [cli, server, core]) {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (name.startsWith('@halo/')) continue   // workspace — inline
      names.add(name)
    }
  }
  return [...names]
}

const EXTERNAL = readDepsList()

// Output an ESM bundle. We only bundle our own source (`@halo/*` workspace
// packages); every npm dep (Hono, aws-sdk, ink, drizzle, etc.) stays external
// and gets installed by `npm install` at the user's machine.
//
// Why not bundle deps:
// - Dynamic `require('buffer')` inside transitive cjs deps (aws-smithy chain)
//   breaks under esbuild's ESM-from-CJS shim.
// - Several deps use `import.meta.url` natively, which only round-trips
//   correctly when the consumer is also ESM.
// - Bundling 50+MB of aws-sdk doesn't speed install — npm dedupes anyway.
//
// What we DO bundle: the three workspace packages (`@turmind/halo-cli`,
// `@turmind/halo-server`, `@turmind/halo-core`) so the user gets a single entry file.
// Their imports of bare-name third-party packages stay as imports and
// resolve at runtime.
// Hard timeout — if esbuild hangs, abort within 60s rather than burn CPU.
const TIMEOUT_MS = 60_000
const buildPromise = build({
  entryPoints: [path.join(CLI_ROOT, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(PUB_DIR, 'dist', 'index.js'),
  external: EXTERNAL,
  plugins: [stubReactDevtoolsPlugin],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})

const timer = setTimeout(() => {
  console.error('[build-bundle] esbuild hung for 60s — aborting')
  process.exit(2)
}, TIMEOUT_MS)
timer.unref()

await buildPromise
clearTimeout(timer)

console.log('[build-bundle] bundled dist/index.js')

// ── 2. bin shim ────────────────────────────────────────────────────────────
fs.writeFileSync(
  path.join(PUB_DIR, 'bin', 'halo.js'),
  "#!/usr/bin/env node\nimport '../dist/index.js'\n",
  { mode: 0o755 },
)
fs.chmodSync(path.join(PUB_DIR, 'bin', 'halo.js'), 0o755)
console.log('[build-bundle] wrote bin/halo.js')

// ── 3. copy templates / bundled-docs / admin-out ──────────────────────────

function copyTree(src, dst) {
  if (!fs.existsSync(src)) {
    console.warn(`[build-bundle] missing source ${src}, skipping`)
    return
  }
  fs.cpSync(src, dst, { recursive: true })
}

copyTree(
  path.join(SERVER_ROOT, 'templates'),
  path.join(PUB_DIR, 'templates'),
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
  copyTree(docsSrc, path.join(PUB_DIR, 'bundled-docs'))
  console.log(`[build-bundle] copied bundled-docs/ from ${path.relative(REPO_ROOT, docsSrc)}`)
}

const adminOut = path.join(ADMIN_ROOT, 'out')
if (fs.existsSync(adminOut)) {
  copyTree(adminOut, path.join(PUB_DIR, 'admin-out'))
  console.log('[build-bundle] copied admin-out/')
} else {
  console.warn('[build-bundle] WARNING: packages/admin/out/ not found — run `pnpm --filter @turmind/halo-admin build` first')
}

// ── 4. emit publish-ready package.json ─────────────────────────────────────

const cliPkg = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf-8'))

// Read native deps' versions from cli or server package.json so the published
// package depends on them with the right ranges.
const serverPkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf-8'))

// Runtime dependencies: every npm dep the bundle leaves external must be
// installable by the user's `npm install`. Merge cli + server + core's deps,
// dedupe by name (pick the latest range — they should match in monorepo).
function mergeDeps(pkgs) {
  const out = {}
  for (const pkg of pkgs) {
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (range.startsWith('workspace:')) continue   // skip workspace refs
      out[name] = range
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

const corePkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'core', 'package.json'), 'utf-8'))
const dependencies = mergeDeps([cliPkg, serverPkg, corePkg])

const pubPkg = {
  name: '@turmind/halo',
  version: cliPkg.version,
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
console.log('[build-bundle] DONE — staged at packages/cli/dist-pub/')
console.log(`  total size:    ${fmt(dirSize(PUB_DIR))}`)
console.log(`  bundle:        ${fmt(fs.statSync(path.join(PUB_DIR, 'dist', 'index.js')).size)}`)
console.log(`  templates:     ${fmt(dirSize(path.join(PUB_DIR, 'templates')))}`)
console.log(`  bundled-docs:  ${fmt(dirSize(path.join(PUB_DIR, 'bundled-docs')))}`)
console.log(`  admin-out:     ${fmt(dirSize(path.join(PUB_DIR, 'admin-out')))}`)
console.log('')
console.log('Next:')
console.log('  cd packages/cli/dist-pub')
console.log('  npm pack --dry-run        # preview tarball contents')
console.log('  npm publish               # release to registry')
