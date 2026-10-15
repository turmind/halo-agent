/**
 * 1.x → 2.0 session conversion.
 *
 * 1.x kept a session in one `<seg>.json` (UI `messages` + model `rawMessages`
 * + a metadata header) with archive segments `<seg>.arch.<n>.json.gz`. 2.0
 * keeps `<seg>.ui.jsonl` + `<seg>.raw.jsonl` + `<seg>.ui.arch.<n>.<h>.jsonl.gz`
 * and all metadata in the session's db row (design/storage.md).
 *
 * Lifetime:
 *  - The AUTOMATIC migration (session-log.ts `openLog`'s ENOENT branch →
 *    `migrateOnMissingLog`) ships in 2.0 only; 2.1 deletes that one branch.
 *  - This file — `migrateLegacySession`, `migrateWorkspaceSessions` — and the
 *    `halo sessions migrate v1 v2` command stay long-term, for users upgrading
 *    from 1.x. So it may only use the storage layer's PUBLIC functions
 *    (readers, replaceUILog / replaceRawLog / writeArchiveSegment, db helpers),
 *    never writer caches or other internals a later refactor could move.
 *
 * A converted session's 1.x files are deleted once the 2.0 files read back
 * equal to them (ruling 2026-10-15) — a downgrade to 1.x no longer sees it.
 */
import fsSync from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { eq } from 'drizzle-orm'
import type { SessionMessage } from './session-types.js'
import { readUILog, readRawLog, replaceUILog, replaceRawLog, uiLogPath, rawLogPath } from './session-log.js'
import { countArchiveSegments, readArchiveSegment, writeArchiveSegment } from './session-archive.js'
import { openHaloDb, internalSessionsDb, type HaloDb } from '../db/index.js'
import { agentSessions } from '../db/schema.js'
import { globalInternalSessionsDir } from '../paths.js'

interface LegacyFile {
  id?: string
  agentName?: string
  title?: string
  description?: string
  createdAt?: string
  updatedAt?: string
  contextTokens?: number
  totalOutputTokens?: number
  parentSessionId?: string
  archiveCount?: number
  archivedUserCount?: number
  messages?: SessionMessage[]
  rawMessages?: unknown[]
  output?: unknown
  lastActivityAt?: unknown
}

/** A 1.x session as read from disk. `segs` = the committed segments that
 *  convert (readable, non-empty, in order — 2.0 numbers them 1..k);
 *  `unreadable` = committed segment numbers that can't be read (kept on disk,
 *  never deleted: nothing converted them). */
interface Legacy {
  data: LegacyFile
  messages: SessionMessage[]
  raw: unknown[]
  segs: SessionMessage[][]
  unreadable: number[]
}

function isInternalDir(dir: string): boolean {
  return path.resolve(path.dirname(dir)) === path.resolve(globalInternalSessionsDir())
}

function legacySegmentPath(dir: string, seg: string, n: number): string {
  return path.join(dir, `${seg}.arch.${n}.json.gz`)
}

/** Throws when `<seg>.json` is missing or unparsable. */
function readLegacy(dir: string, seg: string): Legacy {
  const data = JSON.parse(fsSync.readFileSync(path.join(dir, `${seg}.json`), 'utf-8')) as LegacyFile
  const committed = typeof data.archiveCount === 'number' ? data.archiveCount : 0
  const segs: SessionMessage[][] = []
  const unreadable: number[] = []
  for (let n = 1; n <= committed; n++) {
    try {
      const messages = JSON.parse(gunzipSync(fsSync.readFileSync(legacySegmentPath(dir, seg, n))).toString('utf-8')) as SessionMessage[]
      if (messages.length > 0) segs.push(messages)
    } catch {
      unreadable.push(n)
    }
  }
  return {
    data,
    messages: Array.isArray(data.messages) ? data.messages : [],
    raw: Array.isArray(data.rawMessages) ? data.rawMessages : [],
    segs,
    unreadable,
  }
}

/** The db that holds rows for sessions in `dir`: `<ws>/.halo/sessions/<agent>/`
 *  → `<ws>/.halo/halo.db` (null when it doesn't exist — never created here);
 *  internal-sessions → the global internal db. */
function dbForSessionDir(dir: string): HaloDb | null {
  if (isInternalDir(dir)) return internalSessionsDb()
  const haloDir = path.dirname(path.dirname(dir))
  return fsSync.existsSync(path.join(haloDir, 'halo.db')) ? openHaloDb(haloDir) : null
}

function mainUsers(messages: SessionMessage[]): number {
  let n = 0
  for (const m of messages) if (m.role === 'user' && !m.taskId) n++
  return n
}

function toMs(iso: string | undefined, fallback: number): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : fallback
}

/** Fill the row's NULL metadata columns from the legacy header; create the
 *  row for an internal session (1.x kept none in the global db). Never
 *  overwrites a value the row already has, so a re-run is a no-op. */
function backfillRow(dir: string, seg: string, legacy: Legacy): void {
  const db = dbForSessionDir(dir)
  if (!db) return
  const { data } = legacy
  const id = typeof data.id === 'string' && data.id ? data.id : seg
  let row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()
  if (!row && isInternalDir(dir)) {
    const created = toMs(data.createdAt, Date.now())
    db.insert(agentSessions).values({
      id,
      parentId: data.parentSessionId ?? null,
      agentId: path.basename(dir),
      agentName: data.agentName ?? path.basename(dir),
      description: data.description ?? data.title ?? '',
      createdAt: created,
      updatedAt: toMs(data.updatedAt, created),
    }).onConflictDoNothing().run()
    row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()
  }
  if (!row) return
  const set: Partial<typeof agentSessions.$inferInsert> = {}
  if (row.title === null && data.title) set.title = data.title
  if (row.exchangeCount === null) set.exchangeCount = mainUsers(legacy.messages) + (data.archivedUserCount ?? 0)
  if (row.contextTokens === null && typeof data.contextTokens === 'number') set.contextTokens = data.contextTokens
  if (row.totalOutputTokens === null && typeof data.totalOutputTokens === 'number') set.totalOutputTokens = data.totalOutputTokens
  if (row.output === null && typeof data.output === 'string') set.output = data.output
  if (row.lastActivityAt === null && typeof data.lastActivityAt === 'string') set.lastActivityAt = data.lastActivityAt
  if (Object.keys(set).length > 0) db.update(agentSessions).set(set).where(eq(agentSessions.id, id)).run()
}

function sameEnds(got: SessionMessage[], want: SessionMessage[]): boolean {
  return got.length === want.length
    && (want.length === 0 || (got[0].id === want[0].id && got[got.length - 1].id === want[want.length - 1].id))
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Fresh conversion check: the 2.0 files, read back through the 2.0 readers,
 *  equal the legacy session — segment count and per-segment row count / end
 *  ids, UI row count / end ids, raw count / end messages. Null = ok. */
function verifyConverted(dir: string, seg: string, legacy: Legacy): string | null {
  const k = countArchiveSegments(dir, seg)
  if (k !== legacy.segs.length) return `archive segments read back ${k}, expected ${legacy.segs.length}`
  for (let i = 0; i < k; i++) {
    const got = readArchiveSegment(dir, seg, i + 1)
    if (!got || !sameEnds(got, legacy.segs[i])) return `archive segment ${i + 1} does not match`
  }
  const ui = readUILog(uiLogPath(dir, seg))
  if (!ui || !sameEnds(ui, legacy.messages)) return `UI log read back ${ui?.length ?? 0} rows, expected ${legacy.messages.length}`
  const raw = readRawLog(rawLogPath(dir, seg)) ?? []
  const want = legacy.raw
  if (raw.length !== want.length || (want.length > 0 && (!sameJson(raw[0], want[0]) || !sameJson(raw[raw.length - 1], want[want.length - 1])))) {
    return `raw log read back ${raw.length} messages, expected ${want.length}`
  }
  return null
}

/** Leftover check (2.0 files committed before this run, 1.x files still
 *  there): the session may have moved on since — new rows, archives — so the
 *  1.x UI history must be an id-prefix of the 2.0 one (segments, then the
 *  active log). Raw is not compared: compaction legitimately rewrites it.
 *  Null = ok. */
function verifyPreserved(dir: string, seg: string, legacy: Legacy): string | null {
  const ids: string[] = []
  const k = countArchiveSegments(dir, seg)
  for (let n = 1; n <= k; n++) {
    const got = readArchiveSegment(dir, seg, n)
    if (!got) return `archive segment ${n} unreadable`
    for (const m of got) ids.push(m.id)
  }
  for (const m of readUILog(uiLogPath(dir, seg)) ?? []) ids.push(m.id)
  let i = 0
  for (const s of [...legacy.segs, legacy.messages]) {
    for (const m of s) {
      if (ids[i] !== m.id) return 'the 2.0 UI history does not contain the 1.x one'
      i++
    }
  }
  return null
}

/** Delete a converted session's 1.x files: `<seg>.json`, every
 *  `<seg>.arch.<n>.json.gz` except committed ones that couldn't be read (not
 *  converted), and leftover `<seg>.json.tmp.*` — by directory listing. */
function deleteLegacyFiles(dir: string, seg: string, legacy: Legacy): void {
  const keep = new Set(legacy.unreadable.map((n) => `${seg}.arch.${n}.json.gz`))
  for (const name of fsSync.readdirSync(dir)) {
    const hit = name === `${seg}.json`
      || name.startsWith(`${seg}.json.tmp.`)
      || /^\d+\.json\.gz$/.test(name.startsWith(`${seg}.arch.`) ? name.slice(seg.length + 6) : '')
    if (hit && !keep.has(name)) fsSync.rmSync(path.join(dir, name), { force: true })
  }
  if (keep.size > 0) console.warn(`[LegacyMigrate] ${path.join(dir, seg)}: kept unreadable 1.x segment(s) ${legacy.unreadable.join(', ')}`)
}

// ── Cross-process conversion lock: `<seg>.migrating` ────────────────────
//
// Several processes open the same session files (the server, a cron-spawned
// `halo cli`, the TUI, the migrate command), and each converts on first open.
// Two conversions of one session at once go wrong: a late replace overwrites
// what the first converter's caller already appended, and a rollback deletes
// files the other one committed. So a conversion runs under a lock file
// created with O_EXCL and holding the converter's pid:
//  - held by a live pid: wait up to MIGRATION_LOCK_WAIT_MS, checking every
//    MIGRATION_LOCK_STEP_MS (Atomics.wait — the conversion is synchronous on
//    every path) for the lock's release or the conversion having landed
//    (conversionLanded); past the wait, fail (the open throws, as for a
//    failed conversion);
//  - held by a dead pid (crashed mid-conversion): take it over;
//  - after taking the lock, check again: the holder before us has usually
//    finished the conversion (`ui.jsonl` there) — release, nothing to do.
// The conversion is synchronous and never re-enters itself (its read-back
// finds `ui.jsonl` and opens it directly), so a lock naming this process's own
// pid is a dead predecessor's under a reused pid.

const MIGRATION_LOCK_WAIT_MS = 10_000
const MIGRATION_LOCK_STEP_MS = 50

function migrationLockPath(dir: string, seg: string): string {
  return path.join(dir, `${seg}.migrating`)
}

/** The automatic trigger's condition, re-checked under the lock: 1.x file
 *  present, UI log (the conversion's commit marker) not yet. */
function conversionPending(dir: string, seg: string): boolean {
  return !fsSync.existsSync(uiLogPath(dir, seg)) && fsSync.existsSync(path.join(dir, `${seg}.json`))
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Pid in a lock file; null = no lock; 0 = empty / unreadable content. */
function lockHolder(lock: string): number | null {
  try {
    return parseInt(fsSync.readFileSync(lock, 'utf-8').trim(), 10) || 0
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function tryCreateLock(lock: string): boolean {
  let fd: number
  try {
    fd = fsSync.openSync(lock, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try { fsSync.writeSync(fd, String(process.pid)) } finally { fsSync.closeSync(fd) }
  return true
}

function lockIsStale(lock: string, pid: number): boolean {
  if (pid === process.pid) return true
  if (pid > 0) return !isPidAlive(pid)
  // Empty: a holder between its O_EXCL create and the pid write (µs) — or one
  // that died right there, once the file is older than any wait.
  try { return Date.now() - fsSync.statSync(lock).mtimeMs > MIGRATION_LOCK_WAIT_MS } catch { return false }
}

/** Remove a dead holder's lock. Moved aside first (rename is atomic: of two
 *  processes taking over at once, one moves it); when what moved isn't the
 *  dead holder's file — another taker already replaced it with its own live
 *  lock — it goes back. */
function takeOverLock(lock: string, deadPid: number): void {
  const aside = `${lock}.tmp.${process.pid}.${Date.now().toString(36)}`
  try {
    fsSync.renameSync(lock, aside)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (lockHolder(aside) !== deadPid) {
    try { fsSync.linkSync(aside, lock) } catch { /* re-created meanwhile: that holder stands */ }
  }
  fsSync.rmSync(aside, { force: true })
  console.warn(`[LegacyMigrate] ${lock}: took over from dead pid ${deadPid || '(none)'}`)
}

/** The holder's conversion landed: `ui.jsonl` there AND the 1.x file gone.
 *  `ui.jsonl` alone is not enough — the holder writes it at its commit and only
 *  then reads it back to verify; a waiter appending in between would fail that
 *  check and the holder's rollback would delete what it appended. */
function conversionLanded(dir: string, seg: string): boolean {
  return fsSync.existsSync(uiLogPath(dir, seg)) && !fsSync.existsSync(path.join(dir, `${seg}.json`))
}

/** Take the session's conversion lock, waiting out a live holder. False when
 *  the holder's conversion landed while waiting — nothing to do, nothing held. */
function acquireMigrationLock(dir: string, seg: string): boolean {
  const lock = migrationLockPath(dir, seg)
  const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS
  for (;;) {
    if (tryCreateLock(lock)) return true
    const pid = lockHolder(lock)
    if (pid === null) continue                       // released just now
    if (lockIsStale(lock, pid)) { takeOverLock(lock, pid); continue }
    if (Date.now() > deadline) {
      throw new Error(`another process (pid ${pid}) has been converting this session for over ${MIGRATION_LOCK_WAIT_MS / 1000}s (${lock})`)
    }
    sleepSync(MIGRATION_LOCK_STEP_MS)
    if (conversionLanded(dir, seg)) return false
  }
}

/** Run `fn` under the session's conversion lock when `needed()` still holds
 *  once the lock is had; false when it didn't (another process did it). */
function underMigrationLock(dir: string, seg: string, needed: () => boolean, fn: () => void): boolean {
  if (!acquireMigrationLock(dir, seg)) return false
  try {
    if (!needed()) return false
    fn()
    return true
  } finally {
    releaseMigrationLock(dir, seg)
  }
}

function holdsMigrationLock(dir: string, seg: string): boolean {
  try { return lockHolder(migrationLockPath(dir, seg)) === process.pid } catch { return false }
}

function releaseMigrationLock(dir: string, seg: string): void {
  if (holdsMigrationLock(dir, seg)) fsSync.rmSync(migrationLockPath(dir, seg), { force: true })
}

/**
 * Convert one 1.x session (`<dir>/<seg>.json`) to 2.0 files, then delete the
 * 1.x files, under the session's conversion lock (above). Returns false when
 * nothing was pending once the lock was had — another process converted it.
 * Depends on no in-memory state. Throws on an unreadable legacy file, a
 * failed check or a lock wait timeout — the 1.x files are then left as they
 * were.
 *
 * Order — `ui.jsonl` is the commit marker:
 *   1. `rawMessages` → `raw.jsonl` as-is (already the compacted context);
 *   2. committed 1.x archive segments (n ≤ header `archiveCount`) → 2.0
 *      segment files 1..k;
 *   3. db back-fill (NULL columns only; internal sessions get their row);
 *   4. `messages` → `ui.jsonl` (tmp + rename) — the commit;
 *   5. read the 2.0 files back and compare (verifyConverted). A mismatch
 *      un-commits (removes the new files, `ui.jsonl` first): the session stays
 *      1.x, so a later run retries the full conversion instead of taking the
 *      leftover path below;
 *   6. delete the 1.x files.
 * A crash before 4 leaves no `ui.jsonl`: the next open converts again,
 * overwriting 1–3 (each write atomic, the back-fill idempotent). A crash
 * between 4 and 6 leaves both formats: `halo sessions migrate v1 v2` finishes
 * it (verifyPreserved + delete) — the automatic path never sees the session
 * again.
 */
export function migrateLegacySession(dir: string, seg: string): boolean {
  return underMigrationLock(dir, seg, () => conversionPending(dir, seg), () => convertLocked(dir, seg))
}

function convertLocked(dir: string, seg: string): void {
  const legacy = readLegacy(dir, seg)

  replaceRawLog(rawLogPath(dir, seg), legacy.raw)
  legacy.segs.forEach((messages, i) => writeArchiveSegment(dir, seg, i + 1, messages))

  try {
    backfillRow(dir, seg, legacy)
  } catch (err) {
    // The row is a cache of what the logs already prove (count / title can be
    // re-derived later); a db problem must not leave the session unreadable.
    console.warn(`[LegacyMigrate] ${seg}: db back-fill failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  replaceUILog(uiLogPath(dir, seg), legacy.messages)

  const mismatch = verifyConverted(dir, seg, legacy)
  // Undo only what this process wrote: still the lock holder, and the 1.x
  // file still there (otherwise these 2.0 files may be another converter's).
  if (mismatch && (!holdsMigrationLock(dir, seg) || !fsSync.existsSync(path.join(dir, `${seg}.json`)))) {
    throw new Error(`check after conversion failed: ${mismatch}; lost the conversion lock — nothing undone`)
  }
  if (mismatch) {
    fsSync.rmSync(uiLogPath(dir, seg), { force: true })
    fsSync.rmSync(rawLogPath(dir, seg), { force: true })
    for (const name of fsSync.readdirSync(dir)) {
      if (name.startsWith(`${seg}.ui.arch.`)) fsSync.rmSync(path.join(dir, name), { force: true })
    }
    throw new Error(`check after conversion failed: ${mismatch}; 1.x files kept`)
  }

  deleteLegacyFiles(dir, seg, legacy)
  console.log(`[LegacyMigrate] migrated ${path.join(dir, seg)} (${legacy.messages.length} UI, ${legacy.raw.length} raw, ${legacy.segs.length} segment(s))`)
}

/** Finish a session whose 2.0 files were committed but whose 1.x files are
 *  still there (crash between commit and delete): check, then delete — under
 *  the conversion lock, so a conversion in flight elsewhere (committed, not
 *  yet verified) finishes first. False when that one already deleted them.
 *  Throws on a failed check — the 1.x files are then kept. */
function cleanUpLegacy(dir: string, seg: string): boolean {
  const pending = () => fsSync.existsSync(uiLogPath(dir, seg)) && fsSync.existsSync(path.join(dir, `${seg}.json`))
  return underMigrationLock(dir, seg, pending, () => {
    const legacy = readLegacy(dir, seg)
    const mismatch = verifyPreserved(dir, seg, legacy)
    if (mismatch) throw new Error(`1.x files kept: ${mismatch}`)
    deleteLegacyFiles(dir, seg, legacy)
  })
}

/** A session's pending 1.x conversion failed — it can't be opened until the
 *  conversion succeeds. Loaders that otherwise swallow read errors (and open
 *  the session empty) let this one through. */
export class LegacyConversionError extends Error {}

/** Sessions whose failed conversion was already logged in full. Log dedupe
 *  only — never state: every open retries, the disk decides. */
const loggedFailures = new Set<string>()

/**
 * The automatic 2.0 trigger, called from session-log.ts `openLog` when a UI
 * log is missing and on every raw-log open (raw is written first, so a
 * `raw.jsonl` without its `ui.jsonl` may be half a conversion). Converts when
 * the session has a 1.x `<seg>.json` but no `<seg>.ui.jsonl`; returns true
 * when a conversion was pending — converted here, or by another process while
 * this one waited for its lock — so the caller re-opens; false when nothing
 * was pending.
 *
 * Throws when the conversion fails: opening the session empty would let its
 * next write start a fresh 2.0 log beside the unconverted 1.x history (the
 * session then reads as truncated). The error names the reason and the
 * command; the next open tries again.
 * Ships in 2.0 only — 2.1 deletes the call (this function then goes unused).
 */
export function migrateOnMissingLog(filePath: string): boolean {
  const m = /^(.*)\.(?:ui|raw)\.jsonl$/.exec(path.basename(filePath))
  if (!m) return false
  const dir = path.dirname(filePath)
  const seg = m[1]
  if (fsSync.existsSync(uiLogPath(dir, seg)) || !fsSync.existsSync(path.join(dir, `${seg}.json`))) return false
  try {
    migrateLegacySession(dir, seg)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const key = path.join(dir, seg)
    if (!loggedFailures.has(key)) {
      loggedFailures.add(key)
      console.error(`[LegacyMigrate] ${key}: ${reason}`)
    }
    throw new LegacyConversionError(`${seg}: 1.x conversion failed: ${reason} — run \`halo sessions migrate v1 v2\``)
  }
  return true
}

// ── One-shot command: `halo sessions migrate v1 v2` ─────────────────────

export interface MigrateSummary {
  /** Converted and their 1.x files deleted. */
  migrated: number
  /** Already converted, leftover 1.x files deleted now. */
  cleaned: number
  /** Already 2.0, nothing to do. */
  skipped: number
  failed: Array<{ id: string; reason: string }>
}

/** Same liveness rule as workspace-runtime-lock.ts: EPERM = the pid exists
 *  under another uid, i.e. alive — false-dead is the dangerous direction. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Pid of a live process holding `<root>/.halo/runtime.lock`, or null.
 *  Read-only: never claims the lock. */
export function liveRuntimeHolder(root: string): number | null {
  let pid = 0
  try { pid = parseInt(fsSync.readFileSync(path.join(root, '.halo', 'runtime.lock'), 'utf-8').trim(), 10) || 0 } catch { return null }
  return pid > 0 && pid !== process.pid && isPidAlive(pid) ? pid : null
}

function migrateDir(dir: string, label: string, out: MigrateSummary): void {
  let names: string[]
  try { names = fsSync.readdirSync(dir) } catch { return }
  const legacy = new Set(names.filter((n) => n.endsWith('.json') && !n.includes('.arch.')).map((n) => n.slice(0, -'.json'.length)))
  for (const name of names) {
    if (name.endsWith('.ui.jsonl') && !legacy.has(name.slice(0, -'.ui.jsonl'.length))) out.skipped++
  }
  for (const seg of legacy) {
    try {
      // False = another process (a server opening the session) did it meanwhile.
      if (fsSync.existsSync(uiLogPath(dir, seg))) {
        if (cleanUpLegacy(dir, seg)) out.cleaned++
        else out.skipped++
      } else if (migrateLegacySession(dir, seg)) out.migrated++
      else out.skipped++
    } catch (err) {
      out.failed.push({ id: `${label}/${seg}`, reason: err instanceof Error ? err.message : String(err) })
    }
  }
}

function agentDirs(base: string): string[] {
  try {
    return fsSync.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * Convert every 1.x session of a workspace (`<root>/.halo/sessions/*\/`) plus
 * the global internal sessions (`~/.halo/global/internal-sessions/*\/`), and
 * finish any left between commit and delete. Idempotent: a second run finds
 * no 1.x files. Throws when a live server holds the workspace's runtime.lock
 * (kept as the conservative default: concurrent conversions of one session
 * are serialized by its `<seg>.migrating` lock, so running beside a server —
 * one holding runtime.lock or not — is safe; a session the server converts
 * meanwhile counts as skipped).
 */
export function migrateWorkspaceSessions(root: string): MigrateSummary {
  const holder = liveRuntimeHolder(root)
  if (holder !== null) {
    throw new Error(
      `A server (pid ${holder}) is running on this workspace. Stop it first (\`halo server stop\`, or `
      + `\`systemctl --user stop halo\` under systemd), migrate, then start it again. Also stop any other `
      + `server that has this workspace open (e.g. a HALO_BADGE=DEV instance) — it doesn't hold runtime.lock.`,
    )
  }
  const out: MigrateSummary = { migrated: 0, cleaned: 0, skipped: 0, failed: [] }
  const sessions = path.join(root, '.halo', 'sessions')
  for (const agent of agentDirs(sessions)) migrateDir(path.join(sessions, agent), agent, out)
  const internal = globalInternalSessionsDir()
  for (const agent of agentDirs(internal)) migrateDir(path.join(internal, agent), agent, out)
  return out
}
