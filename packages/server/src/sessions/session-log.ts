/**
 * Session log files (2.0) — append-only JSONL, one file per half.
 *
 *   `<seg>.ui.jsonl`   UI rows: `add` / `patch` / `inflight` records
 *   `<seg>.raw.jsonl`  model history: one message per line
 *
 * No header and no metadata: agentId is the directory, the leaf id the file
 * name, everything else (title, counts, tokens, output) lives in the session's
 * db row. Spec: .halo/docs/plans/session-persistence-incremental.md (→
 * design/storage.md once synced).
 *
 * Why: 1.x kept both halves in one `<seg>.json` and every write parsed,
 * merged and re-serialized the whole file — O(file) per write on the event
 * loop (410ms per write for a 31MB session). Here a write appends only what
 * changed since the previous write; a full atomic rewrite (tmp + rename) is
 * reserved for real non-append changes (compaction, deleteExchange, archive,
 * another process having written the file).
 *
 * Change detection is by object identity against a process-local cache of
 * what this process last wrote / read: a persisted row or raw message is never
 * edited in place — every mutator replaces the object or (raw) its `content`
 * array, or changes the array length. The cache is keyed by file path and
 * validated against the file's ino / size / mtime before every write, so a
 * write by another process (cron `halo cli` child, CLI/TUI) forces a full
 * rewrite from this process's memory — the same last-writer-wins as 1.x.
 */
import fsSync from 'node:fs'
import path from 'node:path'
import type { SessionMessage, ContentBlockEntry } from './session-types.js'
import { migrateOnMissingLog } from './legacy-migrate.js'

export function uiLogPath(dir: string, seg: string): string {
  return path.join(dir, `${seg}.ui.jsonl`)
}

export function rawLogPath(dir: string, seg: string): string {
  return path.join(dir, `${seg}.raw.jsonl`)
}

/**
 * THE open of a session log file — every reader and writer below goes through
 * it (writers on the first write of a file, when they read it to rebuild their
 * cache). Null when the file doesn't exist.
 */
function openLog(filePath: string): number | null {
  try {
    return fsSync.openSync(filePath, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  // 1.x → 2.0 transition, removed in 2.1 (this branch only — legacy-migrate.ts
  // stays for `halo sessions migrate v1 v2`): a session never opened under
  // 2.0 only has its 1.x `<seg>.json`.
  if (!migrateOnMissingLog(filePath)) return null
  try { return fsSync.openSync(filePath, 'r') } catch { return null }
}

/** Whole-file read through openLog; the stat is of the same fd. */
function readLog(filePath: string): { text: string; st: fsSync.Stats } | null {
  const fd = openLog(filePath)
  if (fd === null) return null
  try {
    return { st: fsSync.fstatSync(fd), text: fsSync.readFileSync(fd, 'utf-8') }
  } finally {
    fsSync.closeSync(fd)
  }
}

/**
 * Atomic file write: temp file in the same directory, then rename over the
 * target. POSIX rename within one filesystem is atomic — readers see the old
 * or the new file, never a torn one (SIGKILL / OOM mid-write). The temp
 * suffix carries pid + ms so concurrent writers never collide. Windows: NTFS
 * rename-over-existing can fail EPERM/EBUSY when another process holds the
 * target open; not handled (Linux/macOS targets).
 */
export function atomicWriteFileSync(filePath: string, content: string | Buffer): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}`
  fsSync.writeFileSync(tmpPath, content)
  try {
    fsSync.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fsSync.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

/** Main-conversation user row — the subset exchange counts and archive cuts
 *  run over (same rule as countMainUserMessages / the admin's ordinal). */
function isMainUser(m: SessionMessage): boolean {
  return m.role === 'user' && !m.taskId
}

interface FileStamp { ino: number; size: number; mtimeMs: number }

function stampOf(st: fsSync.Stats): FileStamp {
  return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }
}

function sameStamp(a: FileStamp, st: fsSync.Stats | null): boolean {
  return !!st && st.ino === a.ino && st.size === a.size && st.mtimeMs === a.mtimeMs
}

function statOrNull(p: string): fsSync.Stats | null {
  try { return fsSync.statSync(p) } catch { return null }
}

/** Append `content` and return the file's stamp after the write (fstat on the
 *  same fd, so the cache tracks exactly what is on disk). */
function appendAndStamp(filePath: string, content: string): FileStamp {
  const fd = fsSync.openSync(filePath, 'a')
  try {
    fsSync.writeSync(fd, content)
    return stampOf(fsSync.fstatSync(fd))
  } finally {
    fsSync.closeSync(fd)
  }
}

function rewriteAndStamp(filePath: string, content: string): FileStamp {
  atomicWriteFileSync(filePath, content)
  return stampOf(fsSync.statSync(filePath))
}

/** Split JSONL text into parsed records. A last line without its newline is a
 *  torn append (crash mid-write): dropped and reported, so the caller can force
 *  a full rewrite instead of appending after the torn bytes. A bad line in the
 *  middle (external edit) is skipped. */
function parseLines(text: string, file: string): { records: unknown[]; torn: boolean; skipped: boolean } {
  const records: unknown[] = []
  let torn = false
  let skipped = false
  let start = 0
  while (start < text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(start, end)
    start = end + 1
    if (!line) { skipped = true; continue }
    if (nl === -1) { torn = true; break }
    try {
      records.push(JSON.parse(line))
    } catch {
      skipped = true
      console.warn(`[SessionLog] skipped unparsable line in ${file}`)
    }
  }
  return { records, torn, skipped }
}

// ── UI log ──────────────────────────────────────────────────────────────

/** In-flight assistant shell — every field but `contentBlocks`. */
type InflightShell = Omit<SessionMessage, 'contentBlocks'>

type UIRecord =
  | { t: 'add'; id: string; u?: 1; m: SessionMessage }
  | { t: 'patch'; id: string; m: SessionMessage }
  | { t: 'inflight'; id: string; m?: InflightShell; from: number; blocks: ContentBlockEntry[] }

export interface ParsedUILog {
  /** Merged rows; an in-flight assistant left open by a crash or still
   *  streaming in another process is appended last (where createSaveSnapshot
   *  puts it). */
  messages: SessionMessage[]
  /** True when the file can't be appended to as-is (torn tail, or an open
   *  in-flight record from another process) — the next write rewrites it. */
  needsRewrite: boolean
}

export function parseUILog(text: string, file = 'ui.jsonl'): ParsedUILog {
  const { records, torn } = parseLines(text, file)
  const rows: SessionMessage[] = []
  const index = new Map<string, number>()
  let open: { id: string; shell: InflightShell; blocks: ContentBlockEntry[] } | null = null
  for (const r of records as UIRecord[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue
    if (r.t === 'add') {
      const at = index.get(r.id)
      if (at === undefined) { index.set(r.id, rows.length); rows.push(r.m) } else rows[at] = r.m
      if (open?.id === r.id) open = null
    } else if (r.t === 'patch') {
      const at = index.get(r.id)
      if (at !== undefined) rows[at] = r.m
    } else if (r.t === 'inflight') {
      if (!open || open.id !== r.id) {
        open = { id: r.id, shell: r.m ?? ({ id: r.id } as InflightShell), blocks: r.blocks ?? [] }
      } else {
        if (r.m) open.shell = r.m
        open.blocks = open.blocks.slice(0, r.from).concat(r.blocks ?? [])
      }
    }
  }
  const messages = rows
  if (open) {
    const msg: SessionMessage = { ...open.shell, id: open.id }
    if (open.blocks.length > 0) msg.contentBlocks = open.blocks
    messages.push(msg)
  }
  return { messages, needsRewrite: torn || open !== null }
}

interface InflightCache {
  id: string
  shellJson: string
  blocks: ContentBlockEntry[]
  /** Per block: JSON at the last write when the block could still change
   *  (last block, or a tool call without output); null = final. */
  json: Array<string | null>
}

interface UICache {
  stamp: FileStamp
  /** Row ids in file order, as last written / read. */
  ids: string[]
  /** Row object → its index at the last write. Weak, so a released session's
   *  log isn't pinned in memory by this cache. */
  rows: WeakMap<SessionMessage, number>
  users: number
  inflight: InflightCache | null
}

const uiCaches = new Map<string, UICache>()

function uiCacheOf(stamp: FileStamp, rows: SessionMessage[], users: number, inflight: InflightCache | null): UICache {
  const map = new WeakMap<SessionMessage, number>()
  rows.forEach((m, i) => map.set(m, i))
  return { stamp, ids: rows.map((m) => m.id), rows: map, users, inflight }
}

function countUsers(rows: SessionMessage[]): number {
  let n = 0
  for (const m of rows) if (isMainUser(m)) n++
  return n
}

function addLine(m: SessionMessage): string {
  return JSON.stringify(isMainUser(m) ? { t: 'add', id: m.id, u: 1, m } : { t: 'add', id: m.id, m }) + '\n'
}

function shellOf(m: SessionMessage): InflightShell {
  const { contentBlocks: _blocks, ...shell } = m
  return shell
}

function blockMutable(b: ContentBlockEntry, isLast: boolean): boolean {
  return isLast || (b.type === 'tool_call' && !b.toolCall.output)
}

function inflightCacheOf(m: SessionMessage, shellJson: string): InflightCache {
  const blocks = m.contentBlocks ? [...m.contentBlocks] : []
  return {
    id: m.id, shellJson, blocks,
    json: blocks.map((b, i) => (blockMutable(b, i === blocks.length - 1) ? JSON.stringify(b) : null)),
  }
}

function inflightLine(m: SessionMessage, from: number, shell: InflightShell | undefined): string {
  const blocks = (m.contentBlocks ?? []).slice(from)
  return JSON.stringify(shell ? { t: 'inflight', id: m.id, m: shell, from, blocks } : { t: 'inflight', id: m.id, from, blocks }) + '\n'
}

/** Read and merge a UI log. Null when the file doesn't exist. `prime` records
 *  the returned rows as this process's baseline for `writeUILog` — pass it
 *  only from the loaders whose result becomes the log this process writes
 *  (the root's UIState seed, a sub-log's history), never from a view-only
 *  read, or the writer would see foreign objects and patch every row. */
export function readUILog(filePath: string, opts?: { prime?: boolean }): SessionMessage[] | null {
  const file = readLog(filePath)
  if (!file) return null
  const { text, st } = file
  const parsed = parseUILog(text, filePath)
  if (opts?.prime) {
    if (parsed.needsRewrite || st.size !== Buffer.byteLength(text)) uiCaches.delete(filePath)
    else uiCaches.set(filePath, uiCacheOf(stampOf(st), parsed.messages, countUsers(parsed.messages), null))
  }
  return parsed.messages
}

/** First row id of a UI log, read from the first few KB only (every record
 *  leads with `{"t":…,"id":"…"`) — the archive commit check (session-archive.ts)
 *  calls it per count, so it must not parse a multi-MB file. */
export function readFirstUIRowId(filePath: string): string | null {
  const fd = openLog(filePath)
  if (fd === null) return null
  try {
    const buf = Buffer.alloc(4096)
    const n = fsSync.readSync(fd, buf, 0, buf.length, 0)
    const m = /^\{"t":"(?:add|inflight)","id":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString('utf-8'))
    return m ? JSON.parse(`"${m[1]}"`) as string : null
  } finally {
    fsSync.closeSync(fd)
  }
}

export interface UIWriteResult {
  /** Main user rows in the active file after the write minus before — the
   *  caller adds it to the session row's exchange count. */
  userDelta: number
  /** Active file size after the write (bytes, from the cache — no stat). */
  size: number
}

/**
 * Persist a UI log: `rows` (finalized messages, in order) plus the optional
 * in-flight assistant. Appends only the difference against what this process
 * last wrote; rewrites the file atomically when the difference isn't an append
 * (`rewrite` forced by the caller, rows removed / reordered, another process
 * wrote the file, the in-flight row vanished without being finalized).
 *
 * Without a valid baseline the file is read once (through openLog) for the
 * main-user count it holds — the exchange-count delta is relative to it.
 */
export function writeUILog(
  filePath: string,
  rows: SessionMessage[],
  inflight: SessionMessage | null,
  opts?: { rewrite?: boolean },
): UIWriteResult {
  const cache = uiCaches.get(filePath)
  const valid = cache !== undefined && sameStamp(cache.stamp, statOrNull(filePath))
  const usersAfter = countUsers(rows)
  const usersBefore = valid ? cache.users : countUsers(readUILog(filePath) ?? [])

  let full = !valid || opts?.rewrite === true
  const patches: number[] = []
  if (!full) {
    // Same object at the same index = unchanged. A different object under the
    // same id is a replacement (deleteExchange's soft delete) → patch; a
    // different id means rows were removed or reordered → rewrite.
    const { ids, rows: known } = cache!
    if (rows.length < ids.length) full = true
    for (let i = 0; !full && i < ids.length; i++) {
      if (known.get(rows[i]) === i) continue
      if (rows[i].id !== ids[i]) full = true
      else patches.push(i)
    }
  }
  // An open in-flight row must be retired by an `add` of its id, continued by
  // the same id, or the file rewritten — otherwise readers would resurrect it.
  const open = cache?.inflight ?? null
  if (!full && open && inflight?.id !== open.id) {
    let retired = false
    for (let i = cache!.ids.length; i < rows.length; i++) if (rows[i].id === open.id) { retired = true; break }
    if (!retired) full = true
  }

  if (full) {
    let out = ''
    for (const m of rows) out += addLine(m)
    let inflightCache: InflightCache | null = null
    if (inflight) {
      const shell = shellOf(inflight)
      out += inflightLine(inflight, 0, shell)
      inflightCache = inflightCacheOf(inflight, JSON.stringify(shell))
    }
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true })
    const stamp = rewriteAndStamp(filePath, out)
    uiCaches.set(filePath, uiCacheOf(stamp, rows, usersAfter, inflightCache))
    return { userDelta: usersAfter - usersBefore, size: stamp.size }
  }

  const c = cache!
  let out = ''
  for (const i of patches) out += JSON.stringify({ t: 'patch', id: rows[i].id, m: rows[i] }) + '\n'
  for (let i = c.ids.length; i < rows.length; i++) out += addLine(rows[i])
  let inflightCache: InflightCache | null = null
  if (inflight) {
    const shell = shellOf(inflight)
    const shellJson = JSON.stringify(shell)
    const blocks = inflight.contentBlocks ?? []
    if (open && open.id === inflight.id) {
      // Same in-flight row: emit blocks from the first one that changed.
      let from = Math.min(blocks.length, open.blocks.length)
      for (let i = 0; i < from; i++) {
        if (blocks[i] !== open.blocks[i] || (open.json[i] !== null && JSON.stringify(blocks[i]) !== open.json[i])) { from = i; break }
      }
      const shellChanged = shellJson !== open.shellJson
      if (from < blocks.length || blocks.length < open.blocks.length || shellChanged) {
        out += inflightLine(inflight, from, shellChanged ? shell : undefined)
      }
    } else {
      out += inflightLine(inflight, 0, shell)
    }
    inflightCache = inflightCacheOf(inflight, shellJson)
  }
  if (out) c.stamp = appendAndStamp(filePath, out)
  for (const i of patches) c.rows.set(rows[i], i)
  for (let i = c.ids.length; i < rows.length; i++) { c.rows.set(rows[i], i); c.ids.push(rows[i].id) }
  c.users = usersAfter
  c.inflight = inflightCache
  return { userDelta: usersAfter - usersBefore, size: c.stamp.size }
}

/** Replace a UI log whole with finalized `rows` (tmp + rename). Public
 *  storage entry for writers that hold no live state (legacy-migrate.ts):
 *  the next writeUILog of this file re-reads it as its baseline. */
export function replaceUILog(filePath: string, rows: SessionMessage[]): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true })
  atomicWriteFileSync(filePath, rows.map(addLine).join(''))
  uiCaches.delete(filePath)
}

/** Whether a UI log exists — through openLog, so a session that still only
 *  has its 1.x file is migrated by the probe (see openLog). */
export function uiLogExists(filePath: string): boolean {
  const fd = openLog(filePath)
  if (fd === null) return false
  fsSync.closeSync(fd)
  return true
}

/** Size of the UI log as this process last wrote it, without a stat. 0 when
 *  this process hasn't written it. */
export function cachedUILogSize(filePath: string): number {
  return uiCaches.get(filePath)?.stamp.size ?? 0
}

// ── Raw log ─────────────────────────────────────────────────────────────

interface RawSeen { i: number; content: unknown; len: number }

interface RawCache {
  stamp: FileStamp
  count: number
  /** Message object → its index and `content` (reference + length) at the
   *  last write. Weak: a released session's history (base64 images) must not
   *  stay pinned by this cache. */
  seen: WeakMap<object, RawSeen>
  /** Byte offset where the last line starts — a change confined to the last
   *  message rewrites from here (0 when the file is empty). */
  tailStart: number
}

const rawCaches = new Map<string, RawCache>()

function contentOf(m: unknown): unknown {
  return (m as { content?: unknown } | null)?.content
}

function lenOf(content: unknown): number {
  return Array.isArray(content) ? content.length : -1
}

function noteRaw(seen: WeakMap<object, RawSeen>, m: unknown, i: number): void {
  if (m && typeof m === 'object') {
    const content = contentOf(m)
    seen.set(m, { i, content, len: lenOf(content) })
  }
}

function rawCacheOf(stamp: FileStamp, messages: unknown[], tailStart: number): RawCache {
  const seen = new WeakMap<object, RawSeen>()
  messages.forEach((m, i) => noteRaw(seen, m, i))
  return { stamp, count: messages.length, seen, tailStart }
}

/** JSONL for `messages` plus the byte offset its last line starts at,
 *  relative to the start of the returned text. */
function rawLines(messages: unknown[]): { out: string; lastStart: number } {
  let out = ''
  let bytes = 0
  let lastStart = 0
  for (const m of messages) {
    const line = JSON.stringify(m) + '\n'
    lastStart = bytes
    bytes += Buffer.byteLength(line)
    out += line
  }
  return { out, lastStart }
}

/** Read a raw log. Null when the file doesn't exist. `prime` = the result
 *  becomes the session's live `agent.messages` (see readUILog). */
export function readRawLog(filePath: string, opts?: { prime?: boolean }): unknown[] | null {
  const file = readLog(filePath)
  if (!file) return null
  const { text, st } = file
  const { records, torn, skipped } = parseLines(text, filePath)
  if (opts?.prime) {
    // A skipped line breaks "last line = last message" (tailStart): no
    // baseline, so the next write rewrites the file clean.
    if (torn || skipped || st.size !== Buffer.byteLength(text)) rawCaches.delete(filePath)
    else {
      const lastStart = text.length === 0 ? 0 : text.lastIndexOf('\n', text.length - 2) + 1
      rawCaches.set(filePath, rawCacheOf(stampOf(st), records, st.size - Buffer.byteLength(text.slice(lastStart))))
    }
  }
  return records
}

/**
 * Persist the model history. Between rewrites the history only grows, so the
 * common write appends the new messages. A change confined to the LAST
 * written message — a tool result landing in the batch's results message, a
 * merge into the trailing user turn (`content.push`) — rewrites that one line
 * in place and appends the rest (same inode). Any change to an earlier
 * message — compaction (new array), repair, image trim, deleteExchange — is a
 * full atomic rewrite: tmp + rename over `raw.jsonl`, the old content dropped
 * (as 1.x).
 */
export function writeRawLog(filePath: string, messages: unknown[]): void {
  const cache = rawCaches.get(filePath)
  const valid = cache !== undefined && sameStamp(cache.stamp, statOrNull(filePath))
  if (!valid) {
    // No baseline: this write replaces the file whole, but must still pass
    // through openLog first so a pending 1.x migration lands BEFORE it, not
    // over it.
    const fd = openLog(filePath)
    if (fd !== null) fsSync.closeSync(fd)
  }
  let full = !valid || messages.length < cache.count
  let tail = false
  for (let i = 0; !full && i < cache!.count; i++) {
    const m = messages[i]
    const seen = m && typeof m === 'object' ? cache!.seen.get(m) : undefined
    const content = contentOf(m)
    if (!seen || seen.i !== i || seen.content !== content || seen.len !== lenOf(content)) {
      if (i === cache!.count - 1) tail = true
      else full = true
    }
  }
  if (full) {
    const { out, lastStart } = rawLines(messages)
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true })
    rawCaches.set(filePath, rawCacheOf(rewriteAndStamp(filePath, out), messages, lastStart))
    return
  }
  const c = cache!
  if (tail) {
    // Overwrite from the old last line's start, then cut whatever is left of
    // it. Write first: a crash between the two leaves the new lines intact
    // plus a fragment of the old line (unparsable — skipped by parseLines),
    // never a file without the tail message.
    const from = c.count - 1
    const { out, lastStart } = rawLines(messages.slice(from))
    const fd = fsSync.openSync(filePath, 'r+')
    try {
      const bytes = Buffer.from(out)
      fsSync.writeSync(fd, bytes, 0, bytes.length, c.tailStart)
      fsSync.ftruncateSync(fd, c.tailStart + bytes.length)
      c.stamp = stampOf(fsSync.fstatSync(fd))
    } finally {
      fsSync.closeSync(fd)
    }
    c.tailStart += lastStart
    for (let i = from; i < messages.length; i++) noteRaw(c.seen, messages[i], i)
    c.count = messages.length
    return
  }
  if (messages.length === c.count) return
  const { out, lastStart } = rawLines(messages.slice(c.count))
  const before = c.stamp.size
  c.stamp = appendAndStamp(filePath, out)
  c.tailStart = before + lastStart
  for (let i = c.count; i < messages.length; i++) noteRaw(c.seen, messages[i], i)
  c.count = messages.length
}

/** Replace a raw log whole (tmp + rename) — see replaceUILog. */
export function replaceRawLog(filePath: string, messages: unknown[]): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true })
  atomicWriteFileSync(filePath, messages.map((m) => JSON.stringify(m) + '\n').join(''))
  rawCaches.delete(filePath)
}

/** Drop the writer baselines of a deleted session's files. */
export function forgetLogCaches(dir: string, seg: string): void {
  uiCaches.delete(uiLogPath(dir, seg))
  rawCaches.delete(rawLogPath(dir, seg))
}
