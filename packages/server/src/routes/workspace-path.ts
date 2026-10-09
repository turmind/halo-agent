import fs from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Shared (projectId, path) → filesystem resolution for /api routes that read
 * files on behalf of the admin. Imported by files.ts, data-preview.ts and
 * git.ts (which used to carry a private copy of the same two helpers).
 */

/** projectId is an absolute workspace path (admin contract). Null when missing. */
export async function resolveProjectPath(projectId: string): Promise<string | null> {
  if (path.isAbsolute(projectId)) {
    try {
      await fs.access(projectId)
      return projectId
    } catch {
      return null
    }
  }
  return null
}

/**
 * Resolve a path following symlinks, tolerating a non-existent leaf: realpath
 * the longest existing ancestor, re-append the missing tail. Same shape as
 * tools/sandbox.ts realpathBounded — a lexical `path.resolve` does NOT follow
 * symlinks, so `ws/escape -> /etc` passes a prefix check and escapes.
 */
function realpathBounded(filePath: string): string {
  let prefix = path.resolve(filePath)
  const tail: string[] = []
  while (!existsSync(prefix)) {
    const parent = path.dirname(prefix)
    if (parent === prefix) break // filesystem root
    tail.unshift(path.basename(prefix))
    prefix = parent
  }
  let realPrefix: string
  try {
    realPrefix = realpathSync(prefix)
  } catch {
    realPrefix = prefix // race: vanished between existsSync and realpath
  }
  return tail.length > 0 ? path.join(realPrefix, ...tail) : realPrefix
}

// Validate that a resolved path is within the project workspace (prevent traversal).
// Match on a path-segment boundary, not a raw string prefix — otherwise a sibling
// dir whose name starts with the project name (e.g. `myapp-secret` vs `myapp`)
// passes startsWith and escapes the sandbox.
//
// Both sides are realpath'd (symlinks followed): a workspace-internal symlink
// pointing OUTSIDE the workspace (agents can create them) must not smuggle
// reads/writes out of bounds, while a symlink pointing at another path INSIDE
// the workspace still validates (both sides collapse under the same real root).
// A symlinked workspace root itself also keeps working — the target path
// resolves under the same realpath'd root. Narrow TOCTOU window remains
// (component swapped between check and use), same accepted trade-off as
// tools/sandbox.ts assertPathAllowed.
export function validatePath(filePath: string, projectPath: string): boolean {
  const resolved = realpathBounded(path.resolve(projectPath, filePath))
  const proj = realpathBounded(projectPath)
  return resolved === proj || resolved.startsWith(proj + path.sep)
}

/**
 * Single-segment id guard for :params / body ids that get joined into
 * filesystem paths (agent ids, skill ids, session ids). Hono URL-decodes
 * `%2F` / `%2e` into route params, so "a URL segment can't contain /"
 * does NOT hold — `/agent-configs/..%2F..%2Fetc` reaches `path.join` as
 * `../../etc` and escapes the base directory (traversal read/write/rm).
 *
 * The whitelist is the union of every real id charset:
 *   - agent / skill ids: name slug `[a-z0-9\u4e00-\u9fff-]` (CJK names
 *     allowed — see the slug rule in agent-configs.ts POST) plus
 *     `__internal__` platform agents
 *   - session ids: `sid_…`, `s-…`, `web_<hex>_…`, `tg_<n>_…`, `wx_…`,
 *     `cron-<id>`, `a2a_<account>_…`, and slack/feishu thread ids which embed
 *     `:` and `.` (`slack_C123:1699.123_x`); `>` is the hierarchical-id
 *     separator (session files are leaf-named, but a full id is still a
 *     harmless literal filename char on POSIX)
 *
 * `.` / `..` are rejected explicitly (path navigation); any other dotted
 * name (`a..b`) is a literal single segment and cannot traverse.
 */
export function isSafeIdSegment(id: string): boolean {
  if (id === '.' || id === '..') return false
  return /^[\w.:>\u4e00-\u9fff-]+$/.test(id)
}
