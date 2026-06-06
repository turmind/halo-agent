import { Hono } from 'hono'
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import { GLOBAL_SKILLS_DIR, parseSkillFrontmatter } from '../agents/agent-loader.js'
import { getWorkspaceDb, getDisabledSet, toggleDisabled } from '../db/index.js'
const GLOBAL_SETTINGS_PATH = path.join(homedir(), '.halo', 'secrets', 'settings.yaml')

/** Default settings entry for a newly created skill (self-describing format) */
function defaultSkillSettings() {
  return {
    model: {
      value: '',
      description: 'Model override (empty = use default)',
      options: [
        '',
        'global.anthropic.claude-sonnet-4-6',
        'global.anthropic.claude-haiku-4-5-20251001',
        'global.anthropic.claude-opus-4-6',
      ],
    },
  }
}

async function readYamlFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return YAML.parse(content) ?? {}
  } catch {
    // Try legacy JSON fallback
    try {
      const jsonPath = filePath.replace(/\.yaml$/, '.json')
      return JSON.parse(await fs.readFile(jsonPath, 'utf-8'))
    } catch {
      return {}
    }
  }
}

async function writeYamlFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, YAML.stringify(data, { lineWidth: 120 }), 'utf-8')
}

/** Add a skill entry to settings.yaml */
async function addSkillSettings(settingsPath: string, skillId: string): Promise<void> {
  const settings = await readYamlFile(settingsPath)
  if (!settings.skills || typeof settings.skills !== 'object') settings.skills = {}
  const skills = settings.skills as Record<string, unknown>
  if (!skills[skillId]) {
    skills[skillId] = defaultSkillSettings()
    await writeYamlFile(settingsPath, settings)
  }
}

/** Remove a skill entry from settings.yaml */
async function removeSkillSettings(settingsPath: string, skillId: string): Promise<void> {
  const settings = await readYamlFile(settingsPath)
  if (settings.skills && typeof settings.skills === 'object') {
    const skills = settings.skills as Record<string, unknown>
    if (skills[skillId]) {
      delete skills[skillId]
      await writeYamlFile(settingsPath, settings)
    }
  }
}

interface SkillMeta {
  id: string
  name: string
  description: string
  path: string
  scope: 'global' | 'workspace'
  command?: string
  /** True when a workspace skill with the same id exists and shadows this one at runtime */
  overridden?: boolean
  disabled?: boolean
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}


function toSkillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nEnter the skill prompt here.\n`
}

/**
 * Per-SKILL.md parse cache. Same shape as the agent yaml cache in
 * agent-configs.ts — re-stat each file on every request, only
 * re-read+parse when mtime moved. Skips the legacy yaml fallback in
 * the hot path; that branch is only hit on first read of a legacy
 * skill, after which the cache covers it.
 */
interface SkillCacheEntry {
  mtimeMs: number
  meta: { name: string; description: string; command?: string }
}
const _skillMdCache = new Map<string, SkillCacheEntry>()

/** Scan a skills directory and return skill metadata. Each SKILL.md is
 *  parsed at most once per mtime change. */
async function scanSkillsDir(dir: string, scope: 'global' | 'workspace'): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = []
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return skills // directory doesn't exist
  }

  for (const entryName of names) {
    const skillDir = path.join(dir, entryName)
    try {
      const stat = await fs.stat(skillDir)
      if (!stat.isDirectory()) continue
    } catch { continue }

    const skillMdPath = path.join(skillDir, 'SKILL.md')
    try {
      const mdStat = await fs.stat(skillMdPath)
      let entry = _skillMdCache.get(skillMdPath)
      if (!entry || entry.mtimeMs !== mdStat.mtimeMs) {
        const content = await fs.readFile(skillMdPath, 'utf-8')
        const { name, description, command } = parseSkillFrontmatter(content)
        entry = {
          mtimeMs: mdStat.mtimeMs,
          meta: { name: name || entryName, description: description ?? '', command },
        }
        _skillMdCache.set(skillMdPath, entry)
      }
      skills.push({ id: entryName, name: entry.meta.name, description: entry.meta.description, path: skillDir, scope, command: entry.meta.command })
    } catch {
      // Fallback: try legacy skill.yaml. Cold path — not cached.
      const yamlPath = path.join(skillDir, 'skill.yaml')
      try {
        const yamlContent = await fs.readFile(yamlPath, 'utf-8')
        const m = yamlContent.match(/^name:\s*(.+)$/m)
        const d = yamlContent.match(/^description:\s*(.+)$/m)
        skills.push({ id: entryName, name: m?.[1]?.trim() || entryName, description: d?.[1]?.trim() || '', path: skillDir, scope })
      } catch {
        skills.push({ id: entryName, name: entryName, description: '', path: skillDir, scope })
      }
    }
  }
  return skills
}

export function createSkillRoutes() {
  const app = new Hono()

  // GET /skills?projectId=xxx — list skills. Returns BOTH global and workspace
  // (no merge) so the UI can show them as separate sections. When a workspace
  // skill shadows a global one at runtime, the global entry is marked
  // `overridden: true` (the agent-loader applies the same override in-memory).
  app.get('/skills', async (c) => {
    await ensureDir(GLOBAL_SKILLS_DIR)

    const globalSkills = await scanSkillsDir(GLOBAL_SKILLS_DIR, 'global')

    const projectId = c.req.query('projectId')
    let workspaceSkills: SkillMeta[] = []
    if (projectId) {
      const wsSkillsDir = path.join(projectId, '.halo', 'skills')
      workspaceSkills = await scanSkillsDir(wsSkillsDir, 'workspace')
    }

    const wsIds = new Set(workspaceSkills.map((s) => s.id))
    const globalWithFlag = globalSkills.map((s) => wsIds.has(s.id) ? { ...s, overridden: true } : s)

    // Merge disabled state from workspace DB
    const disabledSet = projectId ? getDisabledSet(getWorkspaceDb(projectId).db, 'skill') : new Set<string>()
    const allSkills = [...globalWithFlag, ...workspaceSkills]
    for (const s of allSkills) {
      s.disabled = disabledSet.has(`${s.scope}:${s.id}`)
    }

    const skills = allSkills.sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ skills })
  })

  // POST /skills — create a new skill folder
  // body.scope: 'global' | 'workspace', body.projectId required if workspace
  app.post('/skills', async (c) => {
    const body = await c.req.json<{ name: string; description?: string; scope?: 'global' | 'workspace'; projectId?: string }>()
    const id = body.name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')

    if (!id) return c.json({ error: 'Invalid skill name' }, 400)

    const scope = body.scope ?? 'global'
    let baseDir: string
    if (scope === 'workspace') {
      if (!body.projectId) return c.json({ error: 'projectId required for workspace skills' }, 400)
      baseDir = path.join(body.projectId, '.halo', 'skills')
    } else {
      baseDir = GLOBAL_SKILLS_DIR
    }

    const skillDir = path.join(baseDir, id)

    try {
      await fs.access(skillDir)
      return c.json({ error: 'Skill already exists' }, 409)
    } catch {
      // doesn't exist — good
    }

    await ensureDir(skillDir)
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), toSkillMd(body.name, body.description ?? ''), 'utf-8')

    // Add skill settings entry to the corresponding settings.yaml
    const settingsPath = scope === 'workspace' && body.projectId
      ? path.join(body.projectId, '.halo', 'settings.yaml')
      : GLOBAL_SETTINGS_PATH
    await addSkillSettings(settingsPath, id)

    const skill: SkillMeta = { id, name: body.name, description: body.description ?? '', path: skillDir, scope }
    return c.json({ skill }, 201)
  })

  // DELETE /skills/:id?scope=workspace&projectId=xxx
  app.delete('/skills/:id', async (c) => {
    const id = c.req.param('id')
    const scope = c.req.query('scope') ?? 'global'
    const projectId = c.req.query('projectId')

    let skillDir: string
    if (scope === 'workspace' && projectId) {
      skillDir = path.join(projectId, '.halo', 'skills', id)
    } else {
      skillDir = path.join(GLOBAL_SKILLS_DIR, id)
    }

    try {
      await fs.access(skillDir)
    } catch {
      return c.json({ error: 'Skill not found' }, 404)
    }

    // force: true so Windows doesn't fail on read-only files / transient file
    // locks (rm retries EBUSY/EPERM/ENOTEMPTY) — same cross-platform fix as
    // agent deletion.
    await fs.rm(skillDir, { recursive: true, force: true })

    // Remove skill settings entry from corresponding settings.yaml
    const settingsPath = scope === 'workspace' && projectId
      ? path.join(projectId, '.halo', 'settings.yaml')
      : GLOBAL_SETTINGS_PATH
    await removeSkillSettings(settingsPath, id)

    return c.json({ ok: true })
  })

  // PATCH /skills/:id/toggle — toggle disabled state in workspace DB
  app.patch('/skills/:id/toggle', async (c) => {
    const id = c.req.param('id')
    const scope = (c.req.query('scope') ?? 'global') as 'global' | 'workspace'
    const projectId = c.req.query('projectId')
    if (!projectId) return c.json({ error: 'projectId required' }, 400)
    const { db } = getWorkspaceDb(projectId)
    const disabled = toggleDisabled(db, 'skill', id, scope)
    return c.json({ ok: true, disabled })
  })

  return app
}
