import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Extension-shipped skills: `~/.halo/global/extensions/<extId>/skills/<id>/`
 * joins workspace and global as the third, lowest-precedence skill source.
 * Pinned here: precedence + `overridden`, the `<extId>` / `<extId>-*` naming
 * rule (one warning per scan), only valid-manifest extensions count, the
 * read-only REST surface (403 on create / delete, toggle allowed and honoured
 * by loadSkillMetadata), and the Settings → Skills overlay order.
 *
 * HOME is redirected BEFORE the dynamic imports (GLOBAL_SKILLS_DIR and the
 * extensions root resolve from os.homedir()).
 */

let tmpHome: string
let realHome: string | undefined
let ws: string
let sources: typeof import('../src/agents/skill-sources.js')
let loader: typeof import('../src/agents/agent-loader.js')
let schema: typeof import('../src/settings-schema.js')
let db: typeof import('../src/db/index.js')
let app: ReturnType<typeof import('../src/routes/skills.js')['createSkillRoutes']>
let extRoot: string
let globalSkills: string

function writeSkill(dir: string, name: string, config?: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} desc\n---\n# ${name}\n`)
  if (config) fs.writeFileSync(path.join(dir, 'config.yaml'), config)
}

function writeExtension(id: string, manifest: Record<string, unknown> = {}): string {
  const dir = path.join(extRoot, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), '')
  fs.writeFileSync(path.join(dir, 'halo-extension.json'), JSON.stringify({
    id, name: id, version: '1.0.0', extensions: ['.x'], entry: 'index.html', ...manifest,
  }))
  return dir
}

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-skill-sources-'))
  process.env.HOME = tmpHome
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-skill-sources-ws-'))
  sources = await import('../src/agents/skill-sources.js')
  loader = await import('../src/agents/agent-loader.js')
  schema = await import('../src/settings-schema.js')
  db = await import('../src/db/index.js')
  app = (await import('../src/routes/skills.js')).createSkillRoutes()
  extRoot = (await import('../src/extensions/registry.js')).extensionsRoot()
  globalSkills = sources.GLOBAL_SKILLS_DIR
  expect(globalSkills.startsWith(tmpHome)).toBe(true)
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
  fs.rmSync(ws, { recursive: true, force: true })
})

describe('skill sources', () => {
  it('no extensions root → no extension skills, skillSourceDir falls back to the global path', () => {
    expect(fs.existsSync(extRoot)).toBe(false)
    expect(sources.extensionSkillDirs()).toEqual([])
    expect(sources.skillSourceDir('nope', ws)).toBe(path.join(globalSkills, 'nope'))
    expect(sources.skillSourceDir('../x', ws)).toBeNull()
  })

  it('valid extension: naming rule enforced, invalid manifests and staging dirs ignored, warned once', () => {
    const tool = writeExtension('tool')
    writeSkill(path.join(tool, 'skills', 'tool'), 'Tool')
    writeSkill(path.join(tool, 'skills', 'tool-extra'), 'Tool Extra')
    writeSkill(path.join(tool, 'skills', 'other'), 'Other')        // not tool / tool-* → ignored
    writeSkill(path.join(tool, 'skills', 'tool.bad'), 'Bad')       // not a SKILL_ID_RE id → ignored
    // Invalid manifest (no entry file) → the extension's skills never count.
    const broken = writeExtension('broken')
    fs.rmSync(path.join(broken, 'index.html'))
    writeSkill(path.join(broken, 'skills', 'broken'), 'Broken')
    // Installer staging dir — not an extension id.
    writeSkill(path.join(extRoot, '.tmp-tool', 'skills', 'tool'), 'Staged')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first = sources.extensionSkillDirs()
      expect(first).toEqual([
        { id: 'tool', dir: path.join(tool, 'skills', 'tool'), scope: 'extension', extId: 'tool' },
        { id: 'tool-extra', dir: path.join(tool, 'skills', 'tool-extra'), scope: 'extension', extId: 'tool' },
      ])
      sources.extensionSkillDirs()
      const skillWarns = warn.mock.calls.filter((c) => String(c[0]).startsWith('[Skills]'))
      expect(skillWarns).toHaveLength(1)
      expect(String(skillWarns[0][0])).toContain('skills/other')
      expect(String(skillWarns[0][0])).toContain('skills/tool.bad')
    } finally {
      warn.mockRestore()
    }
  })

  it('a folder without SKILL.md is not a skill — no id claimed, no Settings section', () => {
    const empty = path.join(extRoot, 'tool', 'skills', 'tool-empty')
    fs.mkdirSync(empty, { recursive: true })
    fs.writeFileSync(path.join(empty, 'config.yaml'), 'params:\n  - key: orphan\n')
    try {
      expect(sources.extensionSkillDirs().map((s) => s.id)).not.toContain('tool-empty')
      expect(sources.skillSourceDir('tool-empty')).toBe(path.join(globalSkills, 'tool-empty'))
      expect(schema.loadSettingsSchema().find((s) => s.namespaceId === 'tool-empty')).toBeUndefined()
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  it('two extensions claiming one id → the lower extension id keeps it', () => {
    const toolExtra = writeExtension('tool-extra')
    writeSkill(path.join(toolExtra, 'skills', 'tool-extra'), 'Dup')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dirs = sources.extensionSkillDirs().filter((s) => s.id === 'tool-extra')
      expect(dirs).toHaveLength(1)
      expect(dirs[0].extId).toBe('tool')
    } finally {
      warn.mockRestore()
      fs.rmSync(toolExtra, { recursive: true, force: true })
    }
  })

  it('precedence workspace > global > extension, shadowed folders flagged overridden', () => {
    writeSkill(path.join(globalSkills, 'tool-extra'), 'Global Tool Extra')
    expect(sources.skillSourceDir('tool', ws)).toBe(path.join(extRoot, 'tool', 'skills', 'tool'))
    expect(sources.skillSourceDir('tool-extra', ws)).toBe(path.join(globalSkills, 'tool-extra'))

    writeSkill(path.join(ws, '.halo', 'skills', 'tool'), 'Workspace Tool')
    expect(sources.skillSourceDir('tool', ws)).toBe(path.join(ws, '.halo', 'skills', 'tool'))
    // Without a workspace the extension copy is still the effective one.
    expect(sources.skillSourceDir('tool')).toBe(path.join(extRoot, 'tool', 'skills', 'tool'))

    const listed = sources.listSkillDirs(ws).map((s) => [s.scope, s.id, s.overridden])
    expect(listed).toEqual([
      ['workspace', 'tool', false],
      ['global', 'tool-extra', false],
      ['extension', 'tool', true],
      ['extension', 'tool-extra', true],
    ])
    fs.rmSync(path.join(ws, '.halo', 'skills', 'tool'), { recursive: true, force: true })
    fs.rmSync(path.join(globalSkills, 'tool-extra'), { recursive: true, force: true })
  })

  it('Settings → Skills: extension config.yaml surfaces, global overlays it', () => {
    const extTool = path.join(extRoot, 'tool', 'skills', 'tool')
    fs.writeFileSync(path.join(extTool, 'config.yaml'), 'params:\n  - key: from_ext\n')
    const section = () => schema.loadSettingsSchema(ws).find((s) => s.source === 'skill' && s.namespaceId === 'tool')
    expect(section()?.fields.map((f) => f.key)).toEqual(['from_ext'])
    expect(section()?.displayName).toBe('Tool')

    writeSkill(path.join(globalSkills, 'tool'), 'Global Tool', 'params:\n  - key: from_global\n')
    expect(section()?.fields.map((f) => f.key)).toEqual(['from_global'])
    expect(section()?.displayName).toBe('Global Tool')
    fs.rmSync(path.join(globalSkills, 'tool'), { recursive: true, force: true })
  })
})

describe('skills routes — extension scope is read-only', () => {
  it('GET lists extension skills with scope + extId', async () => {
    const res = await app.request(`/skills?projectId=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(200)
    const { skills } = await res.json() as { skills: Array<{ id: string; scope: string; extId?: string; disabled?: boolean }> }
    const tool = skills.find((s) => s.id === 'tool')
    expect(tool).toMatchObject({ scope: 'extension', extId: 'tool', disabled: false })
  })

  it('POST / DELETE with scope=extension → 403, and DELETE never falls through to a same-id global skill', async () => {
    const post = await app.request('/skills', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'tool-new', scope: 'extension' }),
    })
    expect(post.status).toBe(403)
    expect(fs.existsSync(path.join(globalSkills, 'tool-new'))).toBe(false)

    writeSkill(path.join(globalSkills, 'tool'), 'Global Tool')
    const del = await app.request(`/skills/tool?scope=extension&projectId=${encodeURIComponent(ws)}`, { method: 'DELETE' })
    expect(del.status).toBe(403)
    expect(fs.existsSync(path.join(globalSkills, 'tool', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(extRoot, 'tool', 'skills', 'tool', 'SKILL.md'))).toBe(true)
    fs.rmSync(path.join(globalSkills, 'tool'), { recursive: true, force: true })
  })

  it('toggle scope=extension disables it: GET shows disabled, loadSkillMetadata drops it', async () => {
    const before = await loader.loadSkillMetadata(['tool', 'tool-extra'], ws, db.getDisabledSet(db.getWorkspaceDb(ws).db, 'skill'))
    expect(before.map((s) => s.id)).toEqual(['tool', 'tool-extra'])
    expect(before[0].path).toBe(path.join(extRoot, 'tool', 'skills', 'tool', 'SKILL.md'))

    const res = await app.request(`/skills/tool/toggle?scope=extension&projectId=${encodeURIComponent(ws)}`, { method: 'PATCH' })
    expect(await res.json()).toEqual({ ok: true, disabled: true })

    const disabled = db.getDisabledSet(db.getWorkspaceDb(ws).db, 'skill')
    expect(disabled.has('extension:tool')).toBe(true)
    const after = await loader.loadSkillMetadata(['tool', 'tool-extra'], ws, disabled)
    expect(after.map((s) => s.id)).toEqual(['tool-extra'])

    const { skills } = await (await app.request(`/skills?projectId=${encodeURIComponent(ws)}`)).json() as { skills: Array<{ id: string; disabled?: boolean }> }
    expect(skills.find((s) => s.id === 'tool')?.disabled).toBe(true)
  })

  it('uninstalling the extension removes its skills on the next read', () => {
    fs.rmSync(path.join(extRoot, 'tool'), { recursive: true, force: true })
    expect(sources.extensionSkillDirs()).toEqual([])
    expect(loader.resolveSkillPath('tool', ws)).toBeNull()
  })
})
