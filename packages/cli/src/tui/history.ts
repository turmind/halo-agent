import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Persistent input history for the TUI — survives restarts, shared across
 * workspaces (shell-history semantics). Stored as a JSON array (entries may
 * contain newlines since multi-line paste landed, so a line-based format
 * would corrupt them).
 */
const HISTORY_FILE = path.join(os.homedir(), '.halo', 'global', 'tui-history.json')
const MAX_ENTRIES = 100

export function loadHistory(): string[] {
  try {
    const arr: unknown = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    if (Array.isArray(arr)) {
      return arr.filter((x): x is string => typeof x === 'string').slice(-MAX_ENTRIES)
    }
  } catch { /* first run / unreadable / corrupt — start empty */ }
  return []
}

/** Append one entry (deduped against the last) and persist. Write rate is
 *  bounded by user submits, so a sync rewrite of ≤100 entries is fine. */
export function appendHistory(entry: string): void {
  try {
    const arr = loadHistory()
    if (arr[arr.length - 1] === entry) return
    arr.push(entry)
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr.slice(-MAX_ENTRIES)))
  } catch { /* best-effort — in-memory history still works */ }
}
