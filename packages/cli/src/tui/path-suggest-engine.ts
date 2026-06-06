import fs from 'node:fs'
import path from 'node:path'
import type { PathItem } from './components/path-suggest.js'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** What kind of `@` reference is currently being typed.
 *  - file/image: insert file content / image (resolveRefs, client-side)
 *  - scope: a directory whose INSTRUCTIONS.md gets injected for the turn
 *    (server-side @scope expansion) — so completion lists directories only. */
type RefKind = 'file' | 'image' | 'scope'

interface ActiveRef {
  /** Where the partial path starts in the input string. */
  pathStart: number
  /** The current partial path (may be empty). */
  partial: string
  kind: RefKind
}

/**
 * Look for an unfinished `@`-prefixed reference at end-of-input. Forms:
 *   1. `@<partial>`           — bare @, kind defaults to 'file'
 *   2. `@file <partial>`      — explicit file reference
 *   3. `@image <partial>`     — explicit image reference
 *   4. `@scope <partial>`     — directory whose INSTRUCTIONS.md is injected
 *
 * The partial may be quoted: `@file "some path/...`. Once a closing quote
 * or terminating space appears the ref is finalized and we stop suggesting.
 *
 * We only detect at end-of-string because TextInput's cursor is always at
 * the end of the value when the user is typing.
 */
export function detectActiveRef(value: string): ActiveRef | null {
  // Form 2/3/4: explicit @file/@image/@scope with a space before the path.
  const reExplicit = /@(file|image|scope)\s+(?:"([^"]*)|(\S*))$/
  const mExplicit = value.match(reExplicit)
  if (mExplicit) {
    const fullMatch = mExplicit[0]
    const kind = mExplicit[1] as RefKind
    const quoted = mExplicit[2]
    const unquoted = mExplicit[3]
    const partial = quoted !== undefined ? quoted : (unquoted ?? '')
    const pathStart = (mExplicit.index ?? 0) + fullMatch.length - partial.length
    return { pathStart, partial, kind }
  }

  // Form 1: bare `@<partial>` (preceded by start-of-string or whitespace).
  // Treat as 'file'; image extensions get auto-detected by the caller anyway.
  const reBare = /(^|\s)@(?:"([^"]*)|(\S*))$/
  const mBare = value.match(reBare)
  if (mBare) {
    const leadingWs = mBare[1] ?? ''
    const quoted = mBare[2]
    const unquoted = mBare[3]
    const partial = quoted !== undefined ? quoted : (unquoted ?? '')
    // pathStart points at the first char after `@` (or `@"`).
    const pathStart = (mBare.index ?? 0) + leadingWs.length + 1 + (quoted !== undefined ? 1 : 0)
    return { pathStart, partial, kind: 'file' }
  }

  return null
}

/** Resolve the directory to list and the basename prefix to filter against. */
function resolveDirAndPrefix(partial: string, workspace: string): { absDir: string; displayDir: string; prefix: string } {
  if (partial === '') {
    return { absDir: workspace, displayDir: '.', prefix: '' }
  }
  const absBase = path.isAbsolute(partial) ? partial : path.join(workspace, partial)
  if (partial.endsWith('/')) {
    // Listing inside this directory.
    return { absDir: absBase, displayDir: partial.replace(/\/$/, '') || '/', prefix: '' }
  }
  // Last segment is the prefix; everything before is the dir.
  const dirAbs = path.dirname(absBase)
  const prefix = path.basename(absBase)
  const dirRel = path.dirname(partial)
  return { absDir: dirAbs, displayDir: dirRel === '.' ? '.' : dirRel, prefix }
}

/**
 * List files+dirs inside the active partial's resolved directory, filtered by
 * its basename prefix. Returns an empty array on errors (missing dir etc.) so
 * the popup just disappears rather than throwing.
 */
export function scanCandidates(partial: string, workspace: string, kind: RefKind): { items: PathItem[]; cwdLabel: string } {
  const { absDir, displayDir, prefix } = resolveDirAndPrefix(partial, workspace)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return { items: [], cwdLabel: displayDir }
  }
  const items: PathItem[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue          // hide dotfiles by default
    if (prefix && !e.name.toLowerCase().startsWith(prefix.toLowerCase())) continue
    const isDir = e.isDirectory()
    const ext = path.extname(e.name).toLowerCase()
    const isImage = IMAGE_EXTS.has(ext)
    // For @image, hide non-dir non-image files to keep the list focused.
    if (kind === 'image' && !isDir && !isImage) continue
    // @scope targets a directory — never suggest files.
    if (kind === 'scope' && !isDir) continue
    // Build the path that should replace the partial when picked.
    let insertPath: string
    if (path.isAbsolute(partial)) {
      insertPath = path.join(absDir, e.name)
    } else if (partial.endsWith('/') || partial === '') {
      insertPath = partial + e.name
    } else {
      // Partial had a basename prefix — replace just that prefix portion.
      const dirRel = path.dirname(partial)
      insertPath = (dirRel === '.' ? '' : dirRel + '/') + e.name
    }
    items.push({ name: e.name, insertPath, isDir, isImage })
  }
  // Dirs first, alphabetical.
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return { items, cwdLabel: displayDir }
}

/**
 * Compose the new input value after picking a candidate. Resolves three
 * concerns at once:
 *   1. Replace the in-flight partial with the picked path.
 *   2. Normalize the leading marker to `@file ` or `@image ` so resolveRefs
 *      can later parse it (bare `@path` is shorthand at the popup level only).
 *   3. Quote paths with spaces; append `/` and stay open for directories so
 *      the user can keep descending.
 */
export function applyPathPick(value: string, ref: ActiveRef, pick: PathItem): string {
  // Walk back from ref.pathStart to find where the `@…` marker begins. This
  // lets us rewrite bare `@partial` into the canonical `@file path` form.
  let markerStart = ref.pathStart - 1     // skip the @
  if (value[markerStart - 1] === '"') markerStart -= 1   // and a possible opening quote

  // If the marker was already `@file ` / `@image ` / `@scope `, walk back over those too.
  const explicitMatch = value.slice(0, markerStart + 1).match(/@(file|image|scope)\s+$/)
  if (explicitMatch) markerStart = (explicitMatch.index ?? markerStart) // start of the @
  else {
    // bare `@` — point markerStart at the @ itself.
    markerStart = ref.pathStart - 1 - (value[ref.pathStart - 1] === '"' ? 1 : 0)
  }

  const before = value.slice(0, markerStart)
  // Pick the canonical kind for the rewritten marker. @scope is preserved
  // verbatim (it's a directory ref, never file/image); otherwise @image is
  // honored if typed, else the file's extension decides.
  const kind: RefKind = ref.kind === 'scope'
    ? 'scope'
    : ref.kind === 'image' ? 'image' : (pick.isImage ? 'image' : 'file')
  const needsQuote = pick.insertPath.includes(' ')
  // @scope only ever picks directories; a picked dir (any kind) stays open
  // so the popup re-opens to keep descending. A picked file closes with a
  // trailing space so the user can keep typing the prompt.
  const path = pick.isDir
    ? (needsQuote ? `"${pick.insertPath}/` : `${pick.insertPath}/`)
    : (needsQuote ? `"${pick.insertPath}" ` : `${pick.insertPath} `)
  return `${before}@${kind} ${path}`
}
