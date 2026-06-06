import { Hono } from 'hono'
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import YAML from 'yaml'
import { loadSettingsSchema, type SchemaSection, type SchemaField } from '../settings-schema.js'

const GLOBAL_SETTINGS_PATH = path.join(homedir(), '.halo', 'secrets', 'settings.yaml')

async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return YAML.parse(content) ?? {}
  } catch {
    return {}
  }
}

async function writeSettingsFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, YAML.stringify(data, { lineWidth: 120 }), 'utf-8')
}

/** Plain deep merge: workspace values override global leaf-by-leaf. */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const baseVal = result[key]
    const overVal = override[key]
    if (
      baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      overVal && typeof overVal === 'object' && !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>)
    } else {
      result[key] = overVal
    }
  }
  return result
}

type SettingsChangeListener = () => void
const _changeListeners: SettingsChangeListener[] = []

export function onSettingsChange(fn: SettingsChangeListener): void {
  _changeListeners.push(fn)
}

function notifySettingsChange(): void {
  for (const fn of _changeListeners) fn()
}

/** Read a dotted leaf from a YAML tree. Values are flat scalars now —
 *  the legacy `{value, default, ...}` self-describing leaf shape is gone. */
function readLeaf(tree: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.')
  let cur: unknown = tree
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** Mask a secret string for transport — keep first/last chars so user can recognize it. */
function maskSecretValue(s: string): string {
  if (!s) return ''
  // Pass-through env-var placeholders so the user can see "this is wired to env".
  if (/^<<[A-Z_][A-Z0-9_]*>>$/.test(s)) return s
  if (s.length <= 6) return '*'.repeat(s.length)
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-2)}`
}

interface ResolvedField {
  key: string
  kind: 'param' | 'secret'
  type?: 'string' | 'int' | 'float' | 'boolean' | 'enum'
  options?: string[]
  /** Display labels parallel to `options` for `type: 'enum'` (e.g. "中文"
   *  for `zh-CN`). Optional — UI falls back to the option code. */
  optionLabels?: string[]
  description?: string
  description_zh?: string
  default?: string
  secret?: boolean
  /** Field is only honored at the global layer; workspace overrides ignored
   *  at runtime. UI should disable the workspace input. */
  globalOnly?: boolean
  /** Effective value as stored — already masked if `secret:true`. */
  value: string | null
  /** Whether a non-empty value exists at any layer. */
  hasValue: boolean
  /** Where the value came from. `unset` means no layer has it. */
  source: 'workspace' | 'global' | 'unset'
  /** True when scope=workspace and the displayed value comes from global. */
  inheritedFromGlobal: boolean
}

interface ResolvedSection {
  namespaceId: string
  source: SchemaSection['source']
  displayName: string
  displayName_zh?: string
  description?: string
  description_zh?: string
  fields: ResolvedField[]
}

/** Resolve declared sections against current settings, computing source + masking. */
function resolveSections(
  sections: SchemaSection[],
  globalTree: Record<string, unknown>,
  workspaceTree: Record<string, unknown> | null,
): ResolvedSection[] {
  return sections.map((section) => {
    const fields: ResolvedField[] = section.fields.map((f) => fieldFor(section, f, globalTree, workspaceTree))
    return {
      namespaceId: section.namespaceId,
      source: section.source,
      displayName: section.displayName,
      displayName_zh: section.displayName_zh,
      description: section.description,
      description_zh: section.description_zh,
      fields,
    }
  })
}

function fieldFor(
  section: SchemaSection,
  f: SchemaField,
  globalTree: Record<string, unknown>,
  workspaceTree: Record<string, unknown> | null,
): ResolvedField {
  // For `general`, the namespace prefix isn't repeated (paths like
  // `general.compact.keep_messages`); for everything else, paths are
  // `<id>.<kind>s.<key>`.
  const dotPath = section.namespaceId === 'general'
    ? `general.${f.key}`
    : `${section.namespaceId}.${f.kind}s.${f.key}`

  const wsRaw = workspaceTree ? readLeaf(workspaceTree, dotPath) : undefined
  const gRaw = readLeaf(globalTree, dotPath)
  const wsStr = wsRaw == null || wsRaw === '' ? undefined : String(wsRaw)
  const gStr = gRaw == null || gRaw === '' ? undefined : String(gRaw)

  let raw: string | undefined
  let source: 'workspace' | 'global' | 'unset' = 'unset'
  let inheritedFromGlobal = false
  if (wsStr !== undefined) { raw = wsStr; source = 'workspace' }
  else if (gStr !== undefined) { raw = gStr; source = 'global'; inheritedFromGlobal = workspaceTree !== null }

  const value = raw === undefined ? null : (f.secret ? maskSecretValue(raw) : raw)
  return {
    key: f.key,
    kind: f.kind,
    type: f.type,
    options: f.options,
    optionLabels: f.optionLabels,
    description: f.description,
    description_zh: f.description_zh,
    default: f.default,
    secret: f.secret,
    globalOnly: f.globalOnly,
    value,
    hasValue: raw !== undefined,
    source,
    inheritedFromGlobal,
  }
}

/** Walk a settings tree and find namespaces whose `secrets`/`params` keys
 *  aren't covered by any declared schema section — these are "orphans" the
 *  user can clean up. The general section's keys are never considered orphan
 *  because we don't enumerate every possible general key here. */
function detectOrphans(
  tree: Record<string, unknown>,
  declared: SchemaSection[],
): Array<{ namespaceId: string; kind: 'param' | 'secret'; key: string }> {
  const declaredMap = new Map<string, Set<string>>()
  for (const s of declared) {
    if (s.namespaceId === 'general') continue
    for (const f of s.fields) declaredMap.set(`${s.namespaceId}.${f.kind}s.${f.key}`, new Set([f.key]))
  }
  const out: Array<{ namespaceId: string; kind: 'param' | 'secret'; key: string }> = []
  for (const [namespaceId, nsVal] of Object.entries(tree)) {
    // `general` is the only namespace that doesn't follow the
    // `<id>.{params|secrets}.<key>` pattern — its declared keys are
    // enumerated by the built-in schema, so anything else there isn't
    // really an orphan in the same sense (it'd be a typo or rogue edit).
    if (namespaceId === 'general') continue
    if (!nsVal || typeof nsVal !== 'object') continue
    for (const kindWord of ['params', 'secrets'] as const) {
      const block = (nsVal as Record<string, unknown>)[kindWord]
      if (!block || typeof block !== 'object') continue
      for (const k of Object.keys(block as Record<string, unknown>)) {
        const path = `${namespaceId}.${kindWord}.${k}`
        if (!declaredMap.has(path)) {
          out.push({ namespaceId, kind: kindWord === 'params' ? 'param' : 'secret', key: k })
        }
      }
    }
  }
  return out
}

export function createSettingsRoutes() {
  const app = new Hono()

  // GET /settings/schema?projectId=xxx — declared schema + resolved values
  app.get('/settings/schema', async (c) => {
    const projectId = c.req.query('projectId')
    const globalTree = await readSettingsFile(GLOBAL_SETTINGS_PATH)
    let workspaceTree: Record<string, unknown> | null = null
    if (projectId) {
      workspaceTree = await readSettingsFile(path.join(projectId, '.halo', 'settings.yaml'))
    }
    // Pass projectId so the schema also surfaces this workspace's
    // private skills (their config.yaml declarations end up under
    // Settings → Skills alongside global ones).
    const declared = loadSettingsSchema(projectId ?? undefined)
    const sections = resolveSections(declared, globalTree, workspaceTree)
    // Detect orphans against the merged tree (workspace overlay), so
    // workspace-only orphans show up too.
    const merged = workspaceTree ? deepMerge(globalTree, workspaceTree) : globalTree
    const orphans = detectOrphans(merged, declared)
    return c.json({
      scope: workspaceTree ? 'workspace' : 'global',
      sections,
      orphans,
    })
  })

  /** Backstop for `globalOnly: true` schema fields. UI disables these inputs
   *  in the workspace view, but a hand-rolled HTTP client could still PATCH
   *  them — so we reject server-side too. Returns null if the key is fine,
   *  otherwise the offending dotted path. */
  function rejectGlobalOnlyAtWorkspace(scope: 'global' | 'workspace', dottedKeys: string[]): string | null {
    if (scope !== 'workspace') return null
    const declared = loadSettingsSchema()
    const globalOnly = new Set<string>()
    for (const section of declared) {
      for (const f of section.fields) {
        if (f.globalOnly !== true) continue
        const dotPath = section.namespaceId === 'general'
          ? `general.${f.key}`
          : `${section.namespaceId}.${f.kind}s.${f.key}`
        globalOnly.add(dotPath)
      }
    }
    return dottedKeys.find((k) => globalOnly.has(k)) ?? null
  }

  /** Flatten a nested record into dotted keys for rejection scanning. */
  function flattenDotted(tree: Record<string, unknown>, prefix = ''): string[] {
    const out: string[] = []
    for (const [k, v] of Object.entries(tree)) {
      const next = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...flattenDotted(v as Record<string, unknown>, next))
      } else {
        out.push(next)
      }
    }
    return out
  }

  // PUT /settings
  app.put('/settings', async (c) => {
    const body = await c.req.json<{
      scope: 'global' | 'workspace'
      projectId?: string
      settings: Record<string, unknown>
    }>()

    if (body.scope === 'workspace') {
      if (!body.projectId) return c.json({ error: 'projectId required for workspace settings' }, 400)
      const offending = rejectGlobalOnlyAtWorkspace('workspace', flattenDotted(body.settings))
      if (offending) return c.json({ error: `${offending} is global-only and cannot be set per workspace` }, 400)
      const wsPath = path.join(body.projectId, '.halo', 'settings.yaml')
      await writeSettingsFile(wsPath, body.settings)
    } else {
      await writeSettingsFile(GLOBAL_SETTINGS_PATH, body.settings)
    }

    notifySettingsChange()
    return c.json({ ok: true })
  })

  // PATCH /settings
  app.patch('/settings', async (c) => {
    const body = await c.req.json<{
      scope: 'global' | 'workspace'
      projectId?: string
      key: string
      value: unknown
    }>()

    let filePath: string
    if (body.scope === 'workspace') {
      if (!body.projectId) return c.json({ error: 'projectId required for workspace settings' }, 400)
      const offending = rejectGlobalOnlyAtWorkspace('workspace', [body.key])
      if (offending) return c.json({ error: `${offending} is global-only and cannot be set per workspace` }, 400)
      filePath = path.join(body.projectId, '.halo', 'settings.yaml')
    } else {
      filePath = GLOBAL_SETTINGS_PATH
    }

    const current = await readSettingsFile(filePath)

    const parts = body.key.split('.')
    let target: Record<string, unknown> = current
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') {
        target[parts[i]] = {}
      }
      target = target[parts[i]] as Record<string, unknown>
    }
    target[parts[parts.length - 1]] = body.value

    await writeSettingsFile(filePath, current)
    notifySettingsChange()
    return c.json({ ok: true })
  })

  // DELETE /settings
  app.delete('/settings', async (c) => {
    const body = await c.req.json<{
      scope: 'global' | 'workspace'
      projectId?: string
      key: string
    }>()

    let filePath: string
    if (body.scope === 'workspace') {
      if (!body.projectId) return c.json({ error: 'projectId required for workspace settings' }, 400)
      filePath = path.join(body.projectId, '.halo', 'settings.yaml')
    } else {
      filePath = GLOBAL_SETTINGS_PATH
    }

    const current = await readSettingsFile(filePath)

    const parts = body.key.split('.')
    let target: Record<string, unknown> = current
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') return c.json({ ok: true })
      target = target[parts[i]] as Record<string, unknown>
    }
    delete target[parts[parts.length - 1]]

    await writeSettingsFile(filePath, current)
    return c.json({ ok: true })
  })

  return app
}
