import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Contract for the extension skill's configurable hub: `hub_repo` →
 * HALO_HUB_REPO (URL normalization + platform detection, the per-platform
 * release pickers `models update` uses — fixtures are real GitHub / Codeberg /
 * gitlab.com API responses, trimmed and re-tagged), and `install <id>` via
 * `<hub_base>/<id>/update.json` (hub_base → HALO_HUB_BASE, default derived
 * from a GitHub hub_repo) end to end against a local https hub.
 * Runs the real ext.sh under bash; HOME is redirected so no real install dir
 * is touched.
 */

const SERVER_ROOT = path.resolve(import.meta.dirname, '..')
const EXT = path.join(SERVER_ROOT, 'templates', 'skills', 'extension', 'templates', 'ext.sh')
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'extension-hub')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ext-hub-'))

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: path.join(tmpRoot, 'home'),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GITHUB_TOKEN: '', GITLAB_TOKEN: '', GITEA_TOKEN: '', HALO_HUB_REPO: '', HALO_HUB_BASE: '',
  ...extra,
})

/** Run `source ext.sh; <script>` with $1.. = args. ($0 must not be ext.sh
 *  itself, or its sourced-vs-executed guard sees "executed".) */
function fn(script: string, args: string[] = [], input?: string, extra: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `source "$EXT"; ${script}`, 'test', ...args], { env: env({ EXT, ...extra }), input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

function ext(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync('bash', [EXT, ...args], { env: env(extra), encoding: 'utf8' })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('hub_url + hub_platform', () => {
  const cases: Array<[string, string, string]> = [
    ['', 'https://github.com/turmind/halo-hub', 'github'],
    ['{{extension.params.hub_repo}}', 'https://github.com/turmind/halo-hub', 'github'],
    ['turmind/halo-hub', 'https://github.com/turmind/halo-hub', 'github'],
    ['https://github.com/o/r', 'https://github.com/o/r', 'github'],
    ['https://github.com/o/r.git', 'https://github.com/o/r.git', 'github'],
    ['https://github.com/o/r/', 'https://github.com/o/r', 'github'],
    ['https://gitlab.com/g/sub/r', 'https://gitlab.com/g/sub/r', 'gitlab'],
    ['https://codeberg.org/o/r', 'https://codeberg.org/o/r', 'gitea'],
    ['https://git.invalid/gitea/o/r', 'https://git.invalid/gitea/o/r', 'git'], // `gitea` in the path, not the host
    ['git@host:o/r.git', 'git@host:o/r.git', 'git'],
    ['ssh://git@host/o/r.git', 'ssh://git@host/o/r.git', 'git'],
    ['file:///srv/hub.git', 'file:///srv/hub.git', 'git'],
    ['/srv/hub', '/srv/hub', 'git'],
  ]
  it.each(cases)('%j → %s (%s)', (input, url, platform) => {
    // `.invalid` never resolves → the unknown-host probe fails fast → git
    const r = fn('u=$(hub_url "$1"); echo "$u"; hub_platform "$u"', [input])
    expect(r.out.split('\n')).toEqual([url, platform])
  })

  it('an existing local dir becomes its absolute path', () => {
    const dir = path.join(tmpRoot, 'some-hub')
    fs.mkdirSync(dir, { recursive: true })
    const r = fn('cd "$1/.." && hub_url "./some-hub/"', [dir])
    expect(r.out).toBe(dir)
  })

  it('release API endpoints per platform (.git dropped, GitLab path url-encoded)', () => {
    expect(fn('hub_releases_api github https://github.com/o/r.git').out).toBe('https://api.github.com/repos/o/r/releases?per_page=100')
    expect(fn('hub_releases_api gitlab https://gitlab.com/g/sub/r').out).toBe('https://gitlab.com/api/v4/projects/g%2Fsub%2Fr/releases?per_page=100')
    expect(fn('hub_releases_api gitea https://codeberg.org/o/r').out).toBe('https://codeberg.org/api/v1/repos/o/r/releases?limit=50')
  })
})

describe('unknown https host → probe Gitea, then GitLab, else git', () => {
  let server: http.Server
  let base = ''
  let mode: 'gitea' | 'gitlab' | 'none' = 'none'
  const run = promisify(execFile)

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const json = (mode === 'gitea' && req.url === '/api/v1/repos/o/r')
        || (mode === 'gitlab' && req.url === '/api/v4/projects/o%2Fr')
      if (json) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }
      else { res.writeHead(404, { 'content-type': 'text/html' }); res.end('nope') }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => { server.close() })

  it.each(['gitea', 'gitlab', 'none'] as const)('%s', async (m) => {
    mode = m
    // async exec: the server lives in this process's event loop
    const { stdout } = await run('bash', ['-c', 'source "$EXT"; hub_platform "$1"', 'test', `${base}/o/r`], { env: env({ EXT }) })
    expect(stdout.trim()).toBe(m === 'none' ? 'git' : m)
  })
})

describe('hub_pick_release (real API shapes)', () => {
  const pick = (platform: string, id: string) =>
    fn('hub_pick_release "$1" "$2"', [platform, id], fs.readFileSync(path.join(FIXTURES, `${platform}-releases.json`), 'utf8'))

  it('GitHub: newest <id>-v* skipping draft + prerelease, .zip asset', () => {
    expect(pick('github', 'demo')).toMatchObject({ code: 0, out: 'https://github.com/cli/cli/releases/download/demo-v1.2.0/demo-1.2.0.zip' })
    expect(pick('github', 'demo-viewer').out).toMatch(/\/demo-viewer-3\.0\.0\.zip$/)
  })

  it('Gitea / Forgejo (Codeberg): same shape as GitHub', () => {
    expect(pick('gitea', 'demo')).toMatchObject({ code: 0, out: 'https://codeberg.org/forgejo/forgejo/releases/download/demo-v1.2.0/demo-1.2.0.zip' })
  })

  it('GitLab: skips upcoming_release, reads assets.links[].direct_asset_url', () => {
    expect(pick('gitlab', 'demo')).toMatchObject({ code: 0, out: 'https://gitlab.com/gitlab-org/cli/-/releases/demo-v1.2.0/downloads/demo-1.2.0.zip' })
  })

  it('no matching release → exit non-zero', () => {
    for (const p of ['github', 'gitea', 'gitlab']) expect(pick(p, 'nope').code).not.toBe(0)
  })
})

describe('hub_base', () => {
  const cases: Array<[string, string, string]> = [
    ['', '', 'https://raw.githubusercontent.com/turmind/halo-hub/main/extensions'],
    ['{{extension.params.hub_base}}', '{{extension.params.hub_repo}}', 'https://raw.githubusercontent.com/turmind/halo-hub/main/extensions'],
    ['', 'o/r', 'https://raw.githubusercontent.com/o/r/main/extensions'],
    ['', 'https://github.com/o/r.git', 'https://raw.githubusercontent.com/o/r/main/extensions'],
    ['https://mirror.example/ext/', 'o/r', 'https://mirror.example/ext'],
    ['', 'https://gitlab.com/g/r', ''],
    ['', '/srv/hub', ''],
  ]
  it.each(cases)('hub_base %j, hub_repo %j → %j', (base, repo, out) => {
    expect(fn('hub_base "$1" "$2"', [base, repo]).out).toBe(out)
  })
})

describe('install <id> via update.json (local https hub)', () => {
  const run = promisify(execFile)
  const installed = () => path.join(tmpRoot, 'home', '.halo', 'global', 'extensions', 'demo')
  let server: https.Server
  let hub = ''
  let caFile = ''
  let routes: Record<string, (res: http.ServerResponse) => void> = {}

  const zipOf = async (version: string, m: Record<string, unknown> = {}) => {
    const { default: JSZip } = await import('jszip')
    const z = new JSZip()
    z.file('demo/halo-extension.json', JSON.stringify({ id: 'demo', name: 'Demo', version, extensions: ['.demo'], entry: 'index.html', ...m }))
    z.file('demo/index.html', `<p>${version}</p>`)
    return z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
  }
  /** Serve demo `version` at <hub>/demo/: update.json via a redirect, the zip relative to it. */
  const publish = async (version: string, opts: { zip?: Buffer; json?: Record<string, unknown> } = {}) => {
    const zip = opts.zip ?? await zipOf(version)
    const body = JSON.stringify({ id: 'demo', version, url: `../files/demo-${version}.zip`, sha256: createHash('sha256').update(zip).digest('hex'), ...opts.json })
    routes = {
      '/hub/demo/update.json': (res) => { res.writeHead(302, { location: '/mirror/demo/update.json' }); res.end() },
      '/mirror/demo/update.json': (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body) },
      [`/mirror/files/demo-${version}.zip`]: (res) => { res.writeHead(200); res.end(zip) },
    }
  }
  /** Async: the hub lives in this process's event loop. */
  const install = async (extra: Record<string, string> = {}) => {
    try {
      const { stdout, stderr } = await run('bash', [EXT, 'install', 'demo'], { env: env({ HALO_HUB_BASE: hub, CURL_CA_BUNDLE: caFile, ...extra }) })
      return { code: 0, out: stdout.trim(), err: stderr.trim() }
    } catch (e) {
      const err = e as { code: number; stdout: string; stderr: string }
      return { code: err.code, out: err.stdout.trim(), err: err.stderr.trim() }
    }
  }

  beforeAll(async () => {
    const dir = path.join(tmpRoot, 'tls')
    fs.mkdirSync(dir, { recursive: true })
    const gen = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ], { encoding: 'utf-8' })
    if (gen.status !== 0) throw new Error(`openssl failed: ${gen.stderr}`)
    caFile = path.join(dir, 'cert.pem')
    server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(caFile) }, (req, res) => {
      const handler = routes[req.url ?? '']
      if (handler) handler(res)
      else { res.writeHead(404); res.end('nope') }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    hub = `https://127.0.0.1:${(server.address() as { port: number }).port}/hub/`
  })
  afterAll(() => { server.close() })

  it('reads update.json (after a redirect), resolves a relative url against it, checks sha256 + id + version, installs', async () => {
    await publish('1.2.0')
    expect(await install()).toMatchObject({ code: 0, out: 'installed demo 1.2.0' })
    expect(fs.readFileSync(path.join(installed(), 'index.html'), 'utf8')).toBe('<p>1.2.0</p>')
  })

  it('refuses a sha256 mismatch, a version or id mismatch, and a non-https url; the previous install stays', async () => {
    await publish('1.3.0', { json: { sha256: 'b'.repeat(64) } })
    let r = await install()
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/sha256 mismatch/)

    await publish('1.3.0', { zip: await zipOf('1.2.9') })
    r = await install()
    expect(r.err).toContain('manifest version "1.2.9" does not match update.json "1.3.0"')

    await publish('1.3.0', { json: { id: 'other' } })
    r = await install()
    expect(r.err).toMatch(/invalid update.json .*id "other" does not match "demo"/)

    await publish('1.3.0', { json: { url: 'http://127.0.0.1:9/demo.zip' } })
    r = await install()
    expect(r.err).toMatch(/url must be https/)

    expect(fs.readFileSync(path.join(installed(), 'index.html'), 'utf8')).toBe('<p>1.2.0</p>')
  })

  it('no update.json (404) → clear error', async () => {
    routes = {}
    const r = await install()
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('no update.json for demo at ')
  })

  it('refuses an http hub_base, and says so when no base can be derived', async () => {
    let r = await install({ HALO_HUB_BASE: 'http://127.0.0.1:9/hub' })
    expect(r.err).toContain('hub_base must be an https URL')
    r = await install({ HALO_HUB_BASE: '', HALO_HUB_REPO: 'https://gitlab.com/g/r' })
    expect(r.err).toContain('no hub_base set and hub_repo is not a GitHub repo')
  })

  it('reinstall keeps the on / off state; remove drops only that id from it (a reinstall starts on)', async () => {
    // A local zip — the hub plays no part in the state rule.
    const zipPath = path.join(tmpRoot, 'demo-4.0.0.zip')
    fs.writeFileSync(zipPath, await zipOf('4.0.0'))
    const stateFile = path.join(path.dirname(installed()), '.state.json')
    fs.writeFileSync(stateFile, JSON.stringify({ demo: { disabled: true }, other: { disabled: true } }))
    expect(ext(['install', zipPath])).toMatchObject({ code: 0, out: 'installed demo 4.0.0' })
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ demo: { disabled: true }, other: { disabled: true } })
    expect(ext(['list']).out).not.toContain('.state')
    expect(ext(['remove', 'demo'])).toMatchObject({ code: 0, out: 'removed demo' })
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ other: { disabled: true } })
    // An unreadable state file is left as it is; the remove still succeeds.
    expect(ext(['install', zipPath]).code).toBe(0)
    fs.writeFileSync(stateFile, '{ broken')
    expect(ext(['remove', 'demo'])).toMatchObject({ code: 0, out: 'removed demo' })
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('{ broken')
    fs.rmSync(stateFile)
  })

  it('a fresh install (dir gone, entry left by a manual rm -rf) starts on; a failed state write only warns', async () => {
    const { default: JSZip } = await import('jszip')
    const z = new JSZip()
    z.file('halo-extension.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '4.0.0', extensions: ['.demo'], entry: 'index.html' }))
    z.file('index.html', '<p>4.0.0</p>')
    const zipPath = path.join(tmpRoot, 'demo-4.0.0-fresh.zip')
    fs.writeFileSync(zipPath, await z.generateAsync({ type: 'nodebuffer' }))
    const root = path.dirname(installed())
    const stateFile = path.join(root, '.state.json')
    fs.rmSync(installed(), { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ demo: { disabled: true }, other: { disabled: true } }))
    expect(ext(['install', zipPath])).toMatchObject({ code: 0, out: 'installed demo 4.0.0' })
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ other: { disabled: true } })

    // The state write fails (a preload makes node's rename throw): remove
    // still removes and exits 0, with a warning; the file is left as it was.
    fs.writeFileSync(stateFile, JSON.stringify({ demo: { disabled: true } }))
    const preload = path.join(tmpRoot, 'fail-rename.cjs')
    fs.writeFileSync(preload, 'require("fs").renameSync = () => { throw new Error("EPERM") }\n')
    const r = ext(['remove', 'demo'], { NODE_OPTIONS: `--require=${preload}` })
    expect(r).toMatchObject({ code: 0, out: 'removed demo' })
    expect(r.err).toContain('warning: could not clear the on / off state of demo')
    expect(fs.existsSync(installed())).toBe(false)
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ demo: { disabled: true } })
    fs.rmSync(stateFile)
  })
})

describe('models update (https release hubs only)', () => {
  it.each([
    ['a local repo path', () => tmpRoot, /need an https release hub/],
    ['an http URL', () => 'http://127.0.0.1:9/o/r', /need an https release hub/],
    ['an ssh git URL', () => 'git@host:o/r.git', /need an https release hub/],
    ['an https host without a release API', () => 'https://git.invalid/o/r', /has no release API/],
  ])('refuses %s', (_label, hub, msg) => {
    const r = ext(['models', 'update'], { HALO_HUB_REPO: hub(), HALO_CLI: '/bin/false' })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(msg)
  })

  it('fetches the newest models-v* zip over https only, unpacks it, and passes the CLI exit code through', async () => {
    const dir = path.join(tmpRoot, 'models-pkg')
    fs.mkdirSync(dir, { recursive: true })
    const { default: JSZip } = await import('jszip')
    const z = new JSZip()
    z.file('models/kimi.yaml', 'id: kimi\n') // wrapped in one dir → ext.sh descends
    fs.writeFileSync(path.join(dir, 'models.zip'), await z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
    fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify([
      { tag_name: 'glb-v1.1.0', assets: [{ name: 'glb-1.1.0.zip', browser_download_url: 'https://x/glb.zip' }] },
      { tag_name: 'models-v2026.10.05', assets: [{ name: 'models-2026.10.05.zip', browser_download_url: 'https://x/models.zip' }] },
    ]))
    const cli = path.join(dir, 'halo-stub.sh')
    fs.writeFileSync(cli, '#!/bin/sh\necho "cli $1 $2 $4"; ls "$3"; exit 3\n', { mode: 0o755 })
    const log = path.join(dir, 'calls.log')
    // Stub the network: hub_curl / curl record their args and drop the fixture at the -o target.
    const r = fn([
      'hub_curl() { echo "hub_curl $*" >>"$LOG"; cp "$DIR/releases.json" "${@: -1}"; }',
      'curl() { echo "curl $*" >>"$LOG"; cp "$DIR/models.zip" "${@: -1}"; }',
      'TMP=$(mktemp -d); trap \'rm -rf "$TMP"\' EXIT',
      'models_update https://github.com/o/r --yes',
    ].join('\n'), [], undefined, { LOG: log, DIR: dir, HALO_CLI: cli })
    expect(r.code).toBe(3)
    expect(r.out.split('\n')).toEqual(['cli models install --yes', 'kimi.yaml'])
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toBe('hub_curl github --proto =https --proto-redir =https https://api.github.com/repos/o/r/releases?per_page=100 -o ' + calls[0]!.split(' -o ')[1])
    expect(calls[1]).toMatch(/^curl -fsSL --proto =https --proto-redir =https https:\/\/x\/models\.zip -o /)
  })
})

describe('listRequiredSkillsWithSecrets', () => {
  it('collects only secret params; skills with none (the extension skill) are skipped', async () => {
    // Fake templates/skills: the real extension config.yaml + a mixed skill.
    const tdir = path.join(tmpRoot, 'templates')
    fs.mkdirSync(path.join(tdir, 'skills', 'extension'), { recursive: true })
    fs.copyFileSync(path.join(SERVER_ROOT, 'templates', 'skills', 'extension', 'config.yaml'), path.join(tdir, 'skills', 'extension', 'config.yaml'))
    fs.mkdirSync(path.join(tdir, 'skills', 'mixed'), { recursive: true })
    fs.writeFileSync(path.join(tdir, 'skills', 'mixed', 'config.yaml'),
      'params:\n  - { key: host, description: h }\n  - { key: token, description: t, secret: true }\n')
    vi.doMock('../src/init.js', () => ({ TEMPLATES_DIR: tdir }))
    // setup-settings resolves HOME at module load (same pattern as setup-providers-bind.test.ts).
    process.env.HOME = path.join(tmpRoot, 'home')
    const { listRequiredSkillsWithSecrets } = await import('../src/setup-providers.js')
    const skills = listRequiredSkillsWithSecrets()
    expect(skills.map((s) => s.id)).toEqual(['mixed'])
    expect(skills[0]!.fields.map((f) => f.key)).toEqual(['token'])
  })
})
