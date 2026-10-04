import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * general.sandbox.hidden_dirs / hidden_files are APPENDED to the built-in
 * DEFAULT_HIDDEN_* lists (deduped) — a user value used to replace them, which
 * silently un-hid ~/.ssh & co. writable_dirs is unchanged (plain list). The
 * schema placeholder must not show the default list (it would read as
 * "include these yourself").
 *
 * HOME must change before importing config (paths resolve at module load).
 */
let home: string
let settingsPath: string

function writeSettings(yaml: string): void {
  fs.writeFileSync(settingsPath, yaml)
}

beforeEach(() => {
  vi.resetModules()
  home = fs.mkdtempSync(join(tmpdir(), 'halo-sandbox-append-'))
  fs.mkdirSync(join(home, '.halo', 'secrets'), { recursive: true })
  settingsPath = join(home, '.halo', 'secrets', 'settings.yaml')
  vi.stubEnv('HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('resolveSandboxPaths', () => {
  it('unset → exactly the built-in defaults', async () => {
    const { resolveSandboxPaths } = await import('../src/config.js')
    const { DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES } = await import('../src/tools/sandbox.js')
    const p = resolveSandboxPaths()
    expect(p.hiddenDirs).toEqual(DEFAULT_HIDDEN_DIRS)
    expect(p.hiddenFiles).toEqual(DEFAULT_HIDDEN_FILES)
    expect(p.writableDirs).toEqual([])
  })

  it('user entries are appended to the defaults, deduped, defaults never dropped', async () => {
    writeSettings([
      'general:',
      '  sandbox:',
      '    hidden_dirs: "~/.kube, ~/.ssh ,~/.kube,"',
      '    hidden_files: "~/.pgpass,~/.npmrc"',
      '    writable_dirs: "~/.kiro"',
      '',
    ].join('\n'))
    const { resolveSandboxPaths } = await import('../src/config.js')
    const { DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES } = await import('../src/tools/sandbox.js')
    const p = resolveSandboxPaths()
    expect(p.hiddenDirs).toEqual([...DEFAULT_HIDDEN_DIRS, '~/.kube'])
    expect(p.hiddenFiles).toEqual([...DEFAULT_HIDDEN_FILES, '~/.pgpass'])
    expect(p.writableDirs).toEqual(['~/.kiro'])
  })

  it('reflects a settings edit without a module reload (mtime-watched)', async () => {
    const { resolveSandboxPaths } = await import('../src/config.js')
    expect(resolveSandboxPaths().hiddenDirs).not.toContain('~/.kube')
    writeSettings('general:\n  sandbox:\n    hidden_dirs: "~/.kube"\n')
    // Force a different mtime even on coarse-resolution filesystems.
    const t = new Date(Date.now() + 5000)
    fs.utimesSync(settingsPath, t, t)
    expect(resolveSandboxPaths().hiddenDirs).toContain('~/.kube')
    expect(resolveSandboxPaths().hiddenDirs).toContain('~/.ssh')
  })

  it('schema: empty default, description names the always-hidden built-ins', async () => {
    const { loadSettingsSchema } = await import('../src/settings-schema.js')
    const general = loadSettingsSchema().find((s) => s.namespaceId === 'general')!
    const dirs = general.fields.find((f) => f.key === 'sandbox.hidden_dirs')!
    const files = general.fields.find((f) => f.key === 'sandbox.hidden_files')!
    expect(dirs.default).toBe('')
    expect(files.default).toBe('')
    expect(dirs.description).toContain('~/.ssh')
    expect(dirs.description_zh).toContain('~/.ssh')
    expect(files.description).toContain('~/.git-credentials')
  })
})

describe('general schema flags', () => {
  it('only language + theme sit outside the Advanced fold', async () => {
    const { loadSettingsSchema } = await import('../src/settings-schema.js')
    const general = loadSettingsSchema().find((s) => s.namespaceId === 'general')!
    expect(general.fields.filter((f) => !f.advanced).map((f) => f.key)).toEqual(['language', 'theme'])
    expect(general.fields.some((f) => f.key === 'agent.default_provider')).toBe(false)
  })

  it('restartRequired marks exactly the boot-only keys', async () => {
    const { loadSettingsSchema } = await import('../src/settings-schema.js')
    const general = loadSettingsSchema().find((s) => s.namespaceId === 'general')!
    expect(general.fields.filter((f) => f.restartRequired).map((f) => f.key).sort()).toEqual([
      'agent.max_retries',
      'compact.keep_messages', 'compact.max_message_slice', 'compact.max_summary_input',
      'logging.level',
      'observability.capture_content', 'observability.endpoint', 'observability.headers', 'observability.service_name',
      'session.max_nesting_depth', 'session.max_queue_size',
    ])
  })
})
