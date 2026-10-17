/**
 * Per-extension user state that must outlive an update — today only the
 * on / off switch. One file, `~/.halo/global/extensions/.state.json`:
 *
 *   { "glb": { "disabled": true } }
 *
 * An id without an entry is on. The file sits beside the extension dirs, not
 * inside one: an update swaps the whole `<id>/` directory (install.ts), so a
 * flag in there would be lost; and as a direct child of the root its atomic
 * rename trips extensions/watcher.ts like any install does. Dot-named, so the
 * scanner, ext.sh `list` and skill-sources never take it for an extension.
 *
 * This module is the only reader / writer in the server — callers go through
 * these functions, never the file. (ext.sh `remove` carries a node one-off
 * that drops an id the same way; it can't import this.)
 *
 * Read from disk, cached by (mtime, size): the scanner, skill-sources (also
 * in CLI / cron children) and the routes all see the same switch without
 * sharing memory. A file that isn't a JSON object reads as "everything on"
 * (warned once per change) and is never overwritten — writes refuse.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { globalExtensionsDir } from '../paths.js'

export interface ExtensionState {
  disabled?: boolean
}

type States = Record<string, ExtensionState>

export class ExtensionStateError extends Error {}

/** Resolved per call so tests can redirect HOME. */
export function extensionStatePath(): string {
  return path.join(globalExtensionsDir(), '.state.json')
}

/** null states = the file exists but isn't a JSON object. */
let cache: { key: string; states: States | null; disabled: Set<string> } | null = null

function load(): { states: States | null; disabled: Set<string> } {
  const file = extensionStatePath()
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return { states: {}, disabled: new Set() } // no file = nothing switched off
  }
  const key = `${file}:${st.mtimeMs}:${st.size}`
  if (cache?.key === key) return cache
  let states: States | null = null
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) states = raw as States
  } catch { /* unreadable / not JSON → null below */ }
  if (!states) console.warn(`[Extensions] ${file} is not a JSON object — treating every extension as on; fix or delete the file`)
  const disabled = new Set(Object.entries(states ?? {}).filter(([, s]) => isEntry(s) && s.disabled === true).map(([id]) => id))
  cache = { key, states, disabled }
  return cache
}

function isEntry(v: unknown): v is ExtensionState {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Ids switched off. Includes ids no longer installed (a manual `rm -rf`
 *  leaves its entry; a reinstall of that id then starts off). */
export function disabledExtensionIds(): ReadonlySet<string> {
  return load().disabled
}

/** Read-modify-write via tmp + rename. `fn` mutates a copy and says whether
 *  anything changed; nothing changed = no write (so no watcher event). */
function update(fn: (states: States) => boolean): boolean {
  const { states } = load()
  if (!states) throw new ExtensionStateError(`${extensionStatePath()} is not a JSON object — fix or delete it first`)
  const next = structuredClone(states)
  if (!fn(next)) return false
  const file = extensionStatePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  fs.renameSync(tmp, file)
  cache = null
  return true
}

/** Switch `id` off (`true`) or on. Returns false when it already was —
 *  idempotent, no write. An entry left empty is dropped, other fields kept. */
export function setExtensionDisabled(id: string, disabled: boolean): boolean {
  return update((states) => {
    const cur = isEntry(states[id]) ? states[id] : {}
    if ((cur.disabled === true) === disabled) return false
    const { disabled: _, ...rest } = cur
    if (disabled) states[id] = { ...rest, disabled: true }
    else if (Object.keys(rest).length > 0) states[id] = rest
    else delete states[id]
    return true
  })
}

/** Drop everything stored for `id` (uninstall), so a reinstall starts fresh.
 *  Returns false when there was nothing — or the file is unreadable: the
 *  uninstall already happened, and that file is never overwritten. */
export function forgetExtension(id: string): boolean {
  if (!load().states) return false
  return update((states) => {
    if (!Object.hasOwn(states, id)) return false
    delete states[id]
    return true
  })
}
