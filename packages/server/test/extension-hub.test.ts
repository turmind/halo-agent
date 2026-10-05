import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Contract for the extension skill's configurable hub (`hub_repo` param →
 * HALO_HUB_REPO): URL normalization + platform detection, the per-platform
 * release pickers (fixtures are real GitHub / Codeberg / gitlab.com API
 * responses, trimmed and re-tagged), and the git-tag install path end to end.
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
  GITHUB_TOKEN: '', GITLAB_TOKEN: '', GITEA_TOKEN: '', HALO_HUB_REPO: '',
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

describe('hub_pick_tag', () => {
  it('highest semver, prereleases and longer ids skipped', () => {
    const refs = ['demo-v1.0.0', 'demo-v1.9.0', 'demo-v1.10.0', 'demo-v2.0.0-alpha', 'demo-viewer-v5.0.0', 'other-v9.9.9']
      .map((t) => `0123abcd\trefs/tags/${t}`).join('\n')
    expect(fn('hub_pick_tag demo', [], refs).out).toBe('demo-v1.10.0')
    expect(fn('hub_pick_tag nope', [], refs).out).toBe('')
  })
})

describe('git mode end to end', () => {
  const repo = path.join(tmpRoot, 'hub-repo')
  const installed = () => path.join(tmpRoot, 'home', '.halo', 'global', 'extensions', 'demo')
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], { env: env(), encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  const release = (version: string, extra: Record<string, string> = {}) => {
    const dir = path.join(repo, 'extensions', 'demo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'halo-extension.json'), JSON.stringify({ id: 'demo', name: 'Demo', version, extensions: ['.demo'], entry: 'index.html' }))
    fs.writeFileSync(path.join(dir, 'index.html'), `<p>${version}</p>`)
    for (const [f, body] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      fs.writeFileSync(path.join(dir, f), body)
    }
    git('add', '-A')
    git('commit', '-qm', version)
    git('tag', `demo-v${version}`)
  }

  beforeAll(() => {
    fs.mkdirSync(repo, { recursive: true })
    git('init', '-q')
    release('1.0.0')
    release('1.9.0')
    release('1.10.0', { 'src/main.js': '//', 'package.json': '{}' })
    release('2.0.0-alpha')
  })

  it('installs the highest non-prerelease tag, minus build inputs (local path)', () => {
    const r = ext(['install', 'demo'], { HALO_HUB_REPO: repo })
    expect(r).toMatchObject({ code: 0, out: 'installed demo 1.10.0' })
    expect(fs.readFileSync(path.join(installed(), 'index.html'), 'utf8')).toBe('<p>1.10.0</p>')
    expect(fs.existsSync(path.join(installed(), 'src'))).toBe(false)
    expect(fs.existsSync(path.join(installed(), 'package.json'))).toBe(false)
  })

  it('file:// URL works the same', () => {
    expect(ext(['install', 'demo'], { HALO_HUB_REPO: `file://${repo}` })).toMatchObject({ code: 0, out: 'installed demo 1.10.0' })
  })

  it('a tag with a build step is refused and the previous install stays', () => {
    release('3.0.0', { 'fetch-deps.sh': '#!/bin/sh\n' })
    const r = ext(['install', 'demo'], { HALO_HUB_REPO: repo })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('demo needs a build step — install it from a release zip')
    expect(fs.readFileSync(path.join(installed(), 'index.html'), 'utf8')).toBe('<p>1.10.0</p>')
  })

  it('unknown id → clear error', () => {
    const r = ext(['install', 'nope'], { HALO_HUB_REPO: repo })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('no release for nope')
  })
})

describe('models update (https release hubs only)', () => {
  it.each([
    ['a local repo path', () => path.join(tmpRoot, 'hub-repo'), /need an https release hub/],
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
