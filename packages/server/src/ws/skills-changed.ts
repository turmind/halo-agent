/**
 * `skills:changed` — every admin skill list (slash-command popup, Skills page,
 * agent-form skill picker) re-fetches on it. Two entry points:
 *
 *   - `notifySkillsChanged` — a mutation that really changed something
 *     (REST create / delete / toggle, `/skill disable|enable|delete`). A
 *     workspace-scoped change (its `.halo/skills/`, or a disable flag in its
 *     db) goes only to sockets bound to that workspace; a global skill to all.
 *   - `skillFoldersChanged` — ws/watcher-pool.ts, after a debounced flush that
 *     touched `<root>/.halo/skills/` (an agent's file_write, a hand edit).
 *
 * Both share one key per workspace (skill folder ids + each SKILL.md's
 * frontmatter block), so the watcher stays silent for what lists can't show
 * (a body edit, a resource file, an identical rewrite) and for the echo of a
 * mutation that already announced itself — one frame per change, like the
 * extensions watcher. `~/.halo/global/skills/` has no watcher: a hand edit
 * there shows on the Skills page's window-focus refetch.
 */
import fs from 'node:fs'
import path from 'node:path'
import { broadcast, broadcastToWorkspace } from './broadcast.js'

const folderKeys = new Map<string, string>()

function folderKey(root: string): string {
  const dir = path.join(root, '.halo', 'skills')
  let ids: string[]
  try { ids = fs.readdirSync(dir).sort() } catch { return '' }
  return ids.map((id) => {
    let fm = ''
    try { fm = fs.readFileSync(path.join(dir, id, 'SKILL.md'), 'utf-8').match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? '' } catch { /* no SKILL.md (yet) */ }
    return `${id}\0${fm}`
  }).join('\n')
}

/** Re-key `root`'s skill folders; true when the key moved since the last look.
 *  The watcher pool also calls it once at watch start to seed the key. */
export function skillFoldersChanged(root: string): boolean {
  const resolved = path.resolve(root)
  const key = folderKey(resolved)
  if (folderKeys.get(resolved) === key) return false
  folderKeys.set(resolved, key)
  return true
}

/** `workspacePath` null = a global skill changed → every socket. */
export function notifySkillsChanged(workspacePath: string | null): void {
  if (!workspacePath) return broadcast({ type: 'skills:changed' })
  skillFoldersChanged(workspacePath)
  broadcastToWorkspace(workspacePath, { type: 'skills:changed' })
}
