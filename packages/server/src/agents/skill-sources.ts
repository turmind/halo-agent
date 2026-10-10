/**
 * Skill sources — the one place that knows where skill folders live and which
 * one wins. Three sources, highest precedence first; a higher one wholly
 * overrides a lower one with the same id (SKILL.md plus every resource file,
 * no per-file fallback — same whole-folder rule as agents):
 *
 *   1. workspace  `<ws>/.halo/skills/<id>/`
 *   2. global     `~/.halo/global/skills/<id>/`
 *   3. extension  `~/.halo/global/extensions/<extId>/skills/<id>/` — shipped by
 *                 an installed canvas extension, gone when it is uninstalled.
 *                 Read-only: the skills routes refuse writes, /skill delete
 *                 refuses, evo is told never to patch them. Copying the folder
 *                 into global or workspace is how a user customises one.
 *
 * Every skill reader (session build, slash commands, /skill verbs, the skills
 * route, Settings → Skills, evo's listing) goes through listSkillDirs /
 * skillSourceDir; writers still only ever write global or workspace.
 *
 * Read from disk on every call, never from the server's in-memory extension
 * registry, so CLI / TUI / cron child processes see exactly what the server
 * sees. Kept free of agent-loader imports: settings-schema needs this, and
 * agent-loader → agent-loop → config → settings-schema would close a cycle.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { extensionsRoot, isExtensionId, MANIFEST_FILE, readExtensionDir } from '../extensions/registry.js'
import { createMtimeCache } from '../routes/mtime-cache.js'

export const GLOBAL_SKILLS_DIR = path.join(homedir(), '.halo', 'global', 'skills')

/** A skill id must be a single path segment — same shape as the `{{<id>.params}}`
 *  namespace convention. Reject anything with `.`, `/`, `\` so a malformed
 *  `agent.yaml` skills entry can't `..`-traverse out of the skills dir. */
export const SKILL_ID_RE = /^[\w-]+$/

export type SkillScope = 'workspace' | 'global' | 'extension'

const SKILL_SCOPES: readonly SkillScope[] = ['workspace', 'global', 'extension']

/** Is skill `id` disabled in this workspace? `disabledSet` is
 *  getDisabledSet(db, 'skill'), keyed `scope:id`; a row in any scope turns the
 *  id off (the rule loadSkillMetadata applies). Every disabled check goes
 *  through here — a bare-id `.has(id)` never matches. */
export function isSkillDisabled(disabledSet: Set<string>, id: string): boolean {
  return SKILL_SCOPES.some((scope) => disabledSet.has(`${scope}:${id}`))
}

export interface SkillDir {
  id: string
  /** The skill folder: SKILL.md + resource files (+ optional config.yaml). */
  dir: string
  scope: SkillScope
  /** Owning extension id, for scope 'extension'. */
  extId?: string
  /** A higher-precedence source has a folder with this id — this one never loads. */
  overridden: boolean
}

/** Sub-directories of one skills dir, symlinks followed (as every scanner did
 *  before this module). Missing dir = none. */
function childDirs(parent: string): string[] {
  let names: string[]
  try { names = fs.readdirSync(parent) } catch { return [] }
  return names.filter((n) => {
    try { return fs.statSync(path.join(parent, n)).isDirectory() } catch { return false }
  })
}

/** Manifest verdict per manifest mtime: a scan costs readdir + stat, and a
 *  manifest is only re-validated after a (re)install rewrote it. */
const _manifestOk = createMtimeCache<boolean>()
/** Extensions whose ignored folders were already reported, keyed by manifest
 *  mtime — one warning per changed extension, not one per listing. */
const _warned = new Set<string>()

/**
 * Skill folders shipped by installed extensions, extension ids in sorted order.
 * An extension counts only when its manifest passes the registry's own
 * validator (readExtensionDir); a folder counts only with a SKILL.md (others
 * are skipped silently). A skill id must be a SKILL_ID_RE id equal to
 * `<extId>` or starting with `<extId>-`; anything else is ignored with one
 * `[Skills]` warning. Two extensions can still claim one id (`foo`'s `foo-bar`
 * vs extension `foo-bar`'s `foo-bar`) — the lower extension id keeps it.
 *
 * Manifest `platforms` is deliberately not consulted: it only decides where the
 * viewer UI is offered; an extension's skills load on every platform.
 */
export function extensionSkillDirs(): Array<Omit<SkillDir, 'overridden'>> {
  const root = extensionsRoot()
  let extIds: string[]
  try { extIds = fs.readdirSync(root) } catch { return [] }
  const out: Array<Omit<SkillDir, 'overridden'>> = []
  const taken = new Set<string>()
  // isExtensionId also drops the installer's `.tmp-*` / `.old-*` staging dirs.
  for (const extId of extIds.filter(isExtensionId).sort()) {
    const extDir = path.join(root, extId)
    const ids = childDirs(path.join(extDir, 'skills'))
    if (ids.length === 0) continue // the common case — no manifest read at all
    const manifest = path.join(extDir, MANIFEST_FILE)
    let mtimeMs: number
    try { mtimeMs = fs.statSync(manifest).mtimeMs } catch { continue }
    const ok = _manifestOk.get(manifest, mtimeMs)
      ?? _manifestOk.set(manifest, mtimeMs, !('error' in readExtensionDir(extDir)))
    if (!ok) continue
    const ignored: string[] = []
    for (const id of ids.sort()) {
      const dir = path.join(extDir, 'skills', id)
      // No SKILL.md = not a skill (it would claim the id, list, and never
      // load; a lone config.yaml would still grow a Settings section).
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue
      if (!SKILL_ID_RE.test(id) || (id !== extId && !id.startsWith(`${extId}-`)) || taken.has(id)) {
        ignored.push(id)
        continue
      }
      taken.add(id)
      out.push({ id, dir, scope: 'extension', extId })
    }
    const warnKey = `${manifest}@${mtimeMs}`
    if (ignored.length > 0 && !_warned.has(warnKey)) {
      _warned.add(warnKey)
      console.warn(`[Skills] extension "${extId}": ignoring skills/${ignored.join(', skills/')} — an extension skill id must be "${extId}" or start with "${extId}-", and be unique across extensions`)
    }
  }
  return out
}

/** Every skill folder on disk, highest precedence first: workspace, global,
 *  extensions. Shadowed folders are kept and flagged `overridden` (the admin
 *  lists them dimmed); callers after the effective set skip those. */
export function listSkillDirs(workspaceRoot?: string): SkillDir[] {
  const out: SkillDir[] = []
  const seen = new Set<string>()
  const add = (s: Omit<SkillDir, 'overridden'>): void => {
    out.push({ ...s, overridden: seen.has(s.id) })
    seen.add(s.id)
  }
  if (workspaceRoot) {
    const wsDir = path.join(workspaceRoot, '.halo', 'skills')
    for (const id of childDirs(wsDir)) add({ id, dir: path.join(wsDir, id), scope: 'workspace' })
  }
  for (const id of childDirs(GLOBAL_SKILLS_DIR)) add({ id, dir: path.join(GLOBAL_SKILLS_DIR, id), scope: 'global' })
  for (const s of extensionSkillDirs()) add(s)
  return out
}

/** Source dir for one skill id — the by-id form of listSkillDirs' precedence:
 *  the first existing folder of workspace > global > extension wins wholly.
 *  Extensions are only scanned for an id neither workspace nor global has.
 *  Null for a malformed id; when nothing exists the global path comes back
 *  (callers probe its SKILL.md and get a miss). */
export function skillSourceDir(skillId: string, workspaceRoot?: string): string | null {
  if (!SKILL_ID_RE.test(skillId)) return null
  if (workspaceRoot) {
    const wsDir = path.join(workspaceRoot, '.halo', 'skills', skillId)
    if (fs.existsSync(wsDir)) return wsDir
  }
  const globalDir = path.join(GLOBAL_SKILLS_DIR, skillId)
  if (fs.existsSync(globalDir)) return globalDir
  return extensionSkillDirs().find((s) => s.id === skillId)?.dir ?? globalDir
}
