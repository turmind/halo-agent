/**
 * UI-log archiving — the UI log only ever grows, so once the active
 * `<seg>.ui.jsonl` passes `ARCHIVE_SIZE_THRESHOLD` all but the newest exchange
 * moves out into a gzipped, immutable segment next to it. Raw history is never
 * archived (compaction rewrites it).
 *
 * Segments: `<seg>.ui.arch.<N>.<h>.jsonl.gz` — N counts up from 1, `h` hashes
 * the segment's first message id, the content is one merged message per line.
 * (1.x segments are converted by legacy-migrate.ts; nothing here reads them.)
 *
 * No counter is stored anywhere. The archive commit is the atomic rewrite of
 * the active file (segment first, then the active file without the archived
 * head), and the committed count is the number of segment files — after one
 * content check: if the highest segment's first id is still the active file's
 * first row, the rewrite never landed (crash in between), so that segment is
 * uncommitted and ignored; the next archive picks the same N and replaces it.
 */
import fsSync from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { SessionMessage } from './session-types.js'
import { atomicWriteFileSync, readFirstUIRowId, uiLogPath } from './session-log.js'

/**
 * Active-file size above which a turn end archives. Bytes, not an exchange
 * count: file size is what makes the log slow to read, parse and ship, and
 * exchange size varies by ~three orders of magnitude. Self-limiting: after an
 * archive the file restarts at one exchange, so it must grow another 3MB of
 * real content before the next one fires. No setting: one number, tuned once.
 */
export const ARCHIVE_SIZE_THRESHOLD = 3 * 1024 * 1024

interface SegmentFile {
  n: number
  name: string
  /** Hash of the segment's first message id (from the file name). */
  hash: string
}

export function firstIdHash(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 12)
}

function listSegmentFiles(dir: string, seg: string): SegmentFile[] {
  let names: string[]
  try { names = fsSync.readdirSync(dir) } catch { return [] }
  const prefix = `${seg}.ui.arch.`
  const out: SegmentFile[] = []
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.jsonl.gz')) continue
    const m = /^(\d+)\.([0-9a-f]{12})$/.exec(name.slice(prefix.length, -'.jsonl.gz'.length))
    if (m) out.push({ n: Number(m[1]), name, hash: m[2] })
  }
  return out.sort((a, b) => a.n - b.n)
}

function committedSegments(dir: string, seg: string): SegmentFile[] {
  const files = listSegmentFiles(dir, seg)
  // Numbers must run 1..k; anything past a gap was never reachable.
  let k = 0
  while (k < files.length && files[k].n === k + 1) k++
  const segs = files.slice(0, k)
  if (segs.length === 0) return segs
  const first = readFirstUIRowId(uiLogPath(dir, seg))
  if (first !== null && segs[k - 1].hash === firstIdHash(first)) return segs.slice(0, -1)
  return segs
}

/** Committed segment count (see the module comment). One directory listing
 *  plus the active file's first few KB. */
export function countArchiveSegments(dir: string, seg: string): number {
  return committedSegments(dir, seg).length
}

function readSegmentFile(dir: string, s: SegmentFile): SessionMessage[] | null {
  try {
    const text = gunzipSync(fsSync.readFileSync(path.join(dir, s.name))).toString('utf-8')
    const out: SessionMessage[] = []
    for (const line of text.split('\n')) if (line) out.push(JSON.parse(line) as SessionMessage)
    return out
  } catch {
    return null
  }
}

/** Read committed segment `n`. Null when it doesn't exist, isn't committed,
 *  or is unreadable. */
export function readArchiveSegment(dir: string, seg: string, n: number): SessionMessage[] | null {
  const s = committedSegments(dir, seg).find((f) => f.n === n)
  return s ? readSegmentFile(dir, s) : null
}

/**
 * Write segment `n` (= committed count + 1), tmp + rename. Every segment file
 * numbered `>= n` is by definition uncommitted (a crash leftover, possibly
 * holding a different first row) and is removed first, so exactly one file
 * carries each number.
 */
export function writeArchiveSegment(dir: string, seg: string, n: number, messages: SessionMessage[]): void {
  fsSync.mkdirSync(dir, { recursive: true })
  for (const s of listSegmentFiles(dir, seg)) {
    if (s.n >= n) { try { fsSync.unlinkSync(path.join(dir, s.name)) } catch { /* raced */ } }
  }
  const body = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
  atomicWriteFileSync(path.join(dir, `${seg}.ui.arch.${n}.${firstIdHash(messages[0].id)}.jsonl.gz`), gzipSync(body))
}

/**
 * Index to split the UI log at: `messages[0..cut)` is archivable, `[cut..]`
 * stays. 0 = nothing to archive. The split is the start of the newest main
 * user exchange (`role === 'user'` without `taskId` — the subset the admin
 * renders and deleteExchange counts on), so a turn is never cut in half.
 */
export function archiveSplitIndex(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === 'user' && !messages[i].taskId) return i
  }
  return 0
}
