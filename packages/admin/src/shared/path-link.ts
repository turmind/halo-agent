import { api } from '@/shared/api-client'

/**
 * Chat path links: inline code / markdown-link text that looks like a file
 * path opens in the canvas, the same as a click in the file tree. Recognition
 * is syntax only — existence is checked on click (one `/fs/stat`), never at
 * render. The opener is the main Explorer's tree panel (EditorPanel,
 * tree-only), registered through `setPathOpener`.
 */

export interface PathRef {
  /** The path as written, line suffix stripped (`~`, `\`, drive letter kept). */
  path: string
  line?: number
  column?: number
}

export type PathTarget =
  /** `path`: workspace-relative, `/`-separated — the file tree's / store's keys ('' = the root). `abs`: for `/fs/stat`. */
  | { kind: 'workspace'; path: string; abs: string }
  /** `path`: as written (`~` expanded) — the server's `path.isAbsolute` judges it, never rewritten here. */
  | { kind: 'external'; path: string }

const LINE_SUFFIX = /^(.+?)(?::(\d+)(?::(\d+))?)?$/
const FORBIDDEN = /[\s()=<>|;,*?]/
const EXT = /\.[A-Za-z][A-Za-z0-9]{0,9}$/
/** Drive letter, on a `\`→`/` normalized string. */
const DRIVE = /^[A-Za-z]:\//

const toSlash = (p: string) => p.replace(/\\/g, '/')
const trimSlash = (p: string) => p.replace(/\/+$/, '')

/** `text` → a path reference, or null when it doesn't look like one. */
export function parsePathRef(text: string): PathRef | null {
  if (!text || FORBIDDEN.test(text) || text.includes('://') || text.startsWith('-')) return null
  const m = LINE_SUFFIX.exec(text)
  if (!m) return null
  const raw = m[1]
  const p = toSlash(raw)
  // A colon only as the drive letter's (`C:\`, `c:/`) — the `:line[:col]` suffix is already off.
  const colon = p.indexOf(':')
  if (colon !== -1 && (colon !== 1 || !DRIVE.test(p) || p.includes(':', 2))) return null
  // A leading backslash is UNC (`\\server\share\…`) or an escape (`\n`, `\d+`), never a path otherwise.
  if (raw.startsWith('\\') && !/^\/\/[^/]+\/[^/]/.test(p)) return null
  // `//cdn.example.com/x.js` — a protocol-relative URL.
  if (raw.startsWith('//')) return null
  // Bare `/`, `~/`, `./`, `..` — no name in it.
  if (!/[^/~.]/.test(p)) return null
  // No separator → only a file name with an extension (`2.1.3`, `v2.1.2` fail: it must start with a letter).
  if (!p.includes('/') && !EXT.test(p)) return null
  return { path: raw, ...(m[2] ? { line: Number(m[2]) } : {}), ...(m[3] ? { column: Number(m[3]) } : {}) }
}

/** Windows-style root (drive letter or a `\`): compare `\`-insensitive and case-insensitive. */
function looksWindows(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || p.includes('\\')
}

/** `abs` relative to `root` in the tree's `/` form, '' for the root itself, null when outside. */
export function workspaceRelative(abs: string, root: string): string | null {
  const win = looksWindows(root)
  const r = trimSlash(toSlash(root))
  const a = trimSlash(toSlash(abs))
  const [ca, cr] = win ? [a.toLowerCase(), r.toLowerCase()] : [a, r]
  if (ca === cr) return ''
  if (!ca.startsWith(`${cr}/`)) return null
  return a.slice(r.length + 1)
}

function joinRoot(root: string, rel: string): string {
  return rel ? `${root.replace(/[\\/]+$/, '')}/${rel}` : root
}

/** Where `raw` (a PathRef path) points from workspace `root`. `home` expands `~`;
 *  null for a `~` path means it can't be resolved. */
export function resolvePathRef(raw: string, root: string, home: string | null): PathTarget | null {
  let path = raw
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    if (!home) return null
    path = home + raw.slice(1)
  }
  const norm = toSlash(path)
  if (!norm.startsWith('/') && !DRIVE.test(norm)) {
    const rel = trimSlash(norm.replace(/^(\.\/)+/, ''))
    return { kind: 'workspace', path: rel, abs: joinRoot(root, rel) }
  }
  const rel = workspaceRelative(norm, root)
  if (rel !== null) return { kind: 'workspace', path: rel, abs: joinRoot(root, rel) }
  return { kind: 'external', path }
}

/** What a click came to: opened, or the one-line hint to show instead. */
export type OpenPathResult = 'ok' | 'missing' | 'tooLarge' | 'outside'

/** The main Explorer's tree panel registers itself (EditorPanel, tree-only);
 *  Skills / Agents panels never do — their stores aren't the canvas. */
let opener: ((ref: PathRef) => Promise<OpenPathResult>) | null = null
export function setPathOpener(fn: typeof opener): () => void {
  opener = fn
  return () => { if (opener === fn) opener = null }
}
export function openPath(ref: PathRef): Promise<OpenPathResult> {
  return opener ? opener(ref) : Promise.resolve('missing')
}

/** Server home dir for `~/` links — fetched once; a failure is retried next time. */
let home: Promise<string | null> | null = null
export function homeDir(): Promise<string | null> {
  home ??= api.fs.home().then((r) => r.home, () => { home = null; return null })
  return home
}
