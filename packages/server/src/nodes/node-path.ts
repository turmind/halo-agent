/**
 * Path handling on a `halo node` machine. Folder mode (`--root`) confines every
 * file op and node_run's cwd to the root; whole-machine mode only resolves.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `~/` expansion — the same rule as the local file tools' resolvePath. */
export function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

/**
 * Absolute in-root path to operate on, or null when `p` lands outside `root`
 * (already realpath'd). Realpaths the longest existing prefix and re-appends
 * the not-yet-existing tail (a file about to be written), like sandbox.ts
 * realpathBounded — but walks up with lstat, not existsSync: existsSync follows
 * a dangling symlink, so `root/link -> /outside/new` would count as "missing",
 * stay unresolved, pass the prefix check, and the write would follow the link
 * out of root. lstat sees the link itself; realpath of it then fails → refused.
 * Prefix test via path.relative, so `/x/root-other` isn't inside `/x/root` and
 * Windows drive letters compare correctly.
 * Known narrow TOCTOU window (a component swapped for a symlink between this
 * check and the tool's syscall) — accepted, same as the local tools.
 */
export function resolveInRoot(root: string, p: string): string | null {
  let prefix = path.resolve(root, expandHome(p))
  const tail: string[] = []
  for (;;) {
    try { fs.lstatSync(prefix); break } catch { /* ENOENT → walk up */ }
    const parent = path.dirname(prefix)
    if (parent === prefix) break
    tail.unshift(path.basename(prefix))
    prefix = parent
  }
  let real: string
  try { real = fs.realpathSync.native(prefix) } catch { return null }
  const full = path.join(real, ...tail)
  const rel = path.relative(root, full)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) ? full : null
}
