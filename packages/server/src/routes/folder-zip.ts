import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { ZipFile } from 'yazl'
import { IGNORED_SEGMENTS } from '../ws/file-watcher.js'
import { isHiddenHostPath, isHiddenWorkspacePath } from '../tools/sandbox.js'

/**
 * Folder download (`GET /api/files/download-folder`): one walk that decides
 * what goes in (the plan — also the `estimate=1` answer), then a zip that
 * yazl builds while it streams, one file open at a time, paced by the
 * response's backpressure. Nothing is buffered whole, on disk or in memory;
 * the plan holds paths + sizes only.
 */

export interface FolderZipLimits {
  maxFiles: number
  maxWalkMs: number
}

export const DEFAULT_FOLDER_ZIP_LIMITS: FolderZipLimits = { maxFiles: 200_000, maxWalkMs: 10_000 }

/** A refusal that maps onto an HTTP status (root not accessible, limits hit). */
export class FolderZipError extends Error {
  constructor(readonly status: 403 | 413, message: string) {
    super(message)
  }
}

type ExcludeReason = 'ignored' | 'blocked' | 'symlink' | 'unreadable'

const REASON_TITLES: Record<ExcludeReason, string> = {
  ignored: 'Build, cache and VCS folders (excluded by default)',
  blocked: 'Always excluded: secrets and Halo runtime state',
  symlink: 'Skipped symlinks (folder links are never followed; file links must stay inside the workspace)',
  unreadable: 'Skipped: unreadable, or a name a zip cannot hold',
}

/** Paths printed per reason in `_halo-excluded.txt`; the rest is a count. */
const EXCLUDED_LIST_CAP = 1000

/** Exported for the tests. */
export const EXCLUDED_LIST_NAME = '_halo-excluded.txt'

const IGNORED_SET = new Set(IGNORED_SEGMENTS)

/** Already-compressed formats are stored — deflating them burns CPU for ~0%. */
const STORED_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'jxl',
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv',
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'lz4', 'br',
  'jar', 'war', 'apk', 'ipa', 'whl', 'dmg',
  'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub',
  'woff', 'woff2',
])

class ExcludedLog {
  readonly counts: Partial<Record<ExcludeReason, number>> = {}
  /** Default-excluded folder name → occurrences (the dialog's breakdown). */
  readonly ignoredNames: Record<string, number> = {}
  private readonly paths: Partial<Record<ExcludeReason, string[]>> = {}
  total = 0

  add(reason: ExcludeReason, entry: string): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1
    this.total++
    const list = (this.paths[reason] ??= [])
    if (list.length < EXCLUDED_LIST_CAP) list.push(entry)
  }

  toText(folderName: string): string {
    const lines = [`Left out of ${folderName}.zip (paths relative to ${folderName}/)`]
    for (const reason of Object.keys(REASON_TITLES) as ExcludeReason[]) {
      const count = this.counts[reason]
      if (!count) continue
      const list = this.paths[reason] ?? []
      lines.push('', `## ${REASON_TITLES[reason]} — ${count}`, ...list)
      if (count > list.length) lines.push(`… and ${count - list.length} more`)
    }
    return lines.join('\n') + '\n'
  }
}

interface PlanItem {
  /** Zip entry name (POSIX, relative to the download root). */
  rel: string
  /** Real path to read; absent for an empty-directory entry. */
  abs?: string
  mtimeMs: number
  mode?: number
}

export interface FolderZipPlan {
  items: PlanItem[]
  files: number
  bytes: number
  excluded: ExcludedLog
}

function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + path.sep)
}

function isEnvName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.')
}

/** yazl turns `\` into `/` (so `a\b.txt` collides with `a/b.txt`) and throws
 *  mid-stream on a `..` segment or a leading `X:` — legal Linux names. */
function isZipUnsafeName(name: string, topLevel: boolean): boolean {
  return name.includes('\\') || (topLevel && /^[A-Za-z]:/.test(name))
}

/**
 * Credential stores blocked from the zip on top of the sandbox's hidden host
 * list, matched relative to the home dir (a home dir can be a workspace).
 * Zip-only on purpose: adding these to DEFAULT_HIDDEN_* would also hide them
 * from sandboxed agents and break kubectl / gcloud & co.
 */
const HOME_BLOCKED_DIRS = ['.kube', '.config/gcloud', '.azure', '.terraform.d']
const HOME_BLOCKED_FILES = [
  '.cargo/credentials', '.cargo/credentials.toml', '.pgpass', '.pypirc', '.vault-token',
  '.zsh_history', '.python_history', '.psql_history', '.mysql_history', '.node_repl_history', '.lesshst',
]
let homeBlocked: { home: string; dirs: string[]; files: Set<string> } | null = null

function isHomeCredentialPath(real: string): boolean {
  // Re-derived when HOME changes (tests swap it); realpath'd like the sandbox lists.
  const home = os.homedir()
  if (homeBlocked?.home !== home) {
    let realHome = home
    try { realHome = realpathSync(home) } catch { /* missing home: keep it lexical */ }
    homeBlocked = {
      home,
      dirs: HOME_BLOCKED_DIRS.map((rel) => path.join(realHome, rel)),
      files: new Set(HOME_BLOCKED_FILES.map((rel) => path.join(realHome, rel))),
    }
  }
  return homeBlocked.files.has(real) || homeBlocked.dirs.some((dir) => isUnder(real, dir))
}

/**
 * Always blocked, include=excluded or not: the sandbox's hidden host list
 * (~/.ssh, ~/.halo/secrets … — a home dir can be a workspace) plus the
 * zip-only credential stores above, and the workspace runtime table
 * (.halo/sessions, logs, evo, dbs), plus `.halo/settings.yaml`. Judged against
 * the nearest `.halo/` ancestor too, so a nested workspace inside the folder
 * keeps its sessions out of the zip.
 */
function isBlockedPath(real: string, wsReal: string): boolean {
  if (isHiddenHostPath(real) || isHomeCredentialPath(real) || isHiddenWorkspacePath(real, wsReal)) return true
  const marker = `${path.sep}.halo${path.sep}`
  const i = real.lastIndexOf(marker)
  if (i < 0) return false
  const base = real.slice(0, i)
  return isHiddenWorkspacePath(real, base) || real === path.join(base, '.halo', 'settings.yaml')
}

/**
 * Walk `root` (an existing directory inside `projectPath`) without reading
 * contents. Directory symlinks are never followed; a file symlink is kept
 * only when its target is a regular file inside the workspace that passes
 * the blocked checks. Throws FolderZipError past the limits, and the signal's
 * AbortError when the client goes away mid-walk.
 */
export async function planFolderZip(
  root: string,
  projectPath: string,
  opts: { includeIgnored: boolean; limits: FolderZipLimits; signal?: AbortSignal },
): Promise<FolderZipPlan> {
  const [rootReal, wsReal] = await Promise.all([fs.realpath(root), fs.realpath(projectPath)])
  if (isBlockedPath(rootReal, wsReal)) throw new FolderZipError(403, 'Path is not accessible')

  const { includeIgnored, limits, signal } = opts
  const deadline = Date.now() + limits.maxWalkMs
  const plan: FolderZipPlan = { items: [], files: 0, bytes: 0, excluded: new ExcludedLog() }
  const { excluded } = plan

  const walkTimeout = () =>
    new FolderZipError(413, `This folder took longer than ${limits.maxWalkMs / 1000} s to scan — download a subfolder instead.`)

  function addFile(rel: string, abs: string, st: { size: number; mtimeMs: number; mode: number }): void {
    if (++plan.files > limits.maxFiles) {
      throw new FolderZipError(413, `This folder has more than ${limits.maxFiles.toLocaleString('en-US')} files — download a subfolder instead.`)
    }
    plan.bytes += st.size
    plan.items.push({ rel, abs, mtimeMs: st.mtimeMs, mode: st.mode })
  }

  async function addSymlink(linkPath: string, rel: string, name: string): Promise<boolean> {
    if (isEnvName(name)) { excluded.add('blocked', rel); return false }
    const real = await fs.realpath(linkPath).catch(() => null)
    const st = real ? await fs.stat(real).catch(() => null) : null
    if (!real || !st?.isFile() || !isUnder(real, wsReal) || isBlockedPath(real, wsReal) || isEnvName(path.basename(real))) {
      excluded.add('symlink', st?.isDirectory() ? `${rel}/` : rel)
      return false
    }
    addFile(rel, real, st)
    return true
  }

  /** True when the directory contributed an entry (or is logged as unreadable). */
  async function walk(dirReal: string, rel: string): Promise<boolean> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dirReal, { withFileTypes: true })
    } catch (err) {
      if (!rel) throw err
      excluded.add('unreadable', `${rel}/ (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
      return true
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    // The walk is stat-bound: one await per file put a 200k-file tree right
    // at the 10 s cap. Stat this directory's files 64 at a time up front.
    const fileStats = new Map<string, import('node:fs').Stats | NodeJS.ErrnoException>()
    const toStat = entries.filter((e) => e.isFile() && !isEnvName(e.name) && !isZipUnsafeName(e.name, !rel))
    for (let i = 0; i < toStat.length; i += 64) {
      signal?.throwIfAborted()
      if (Date.now() > deadline) throw walkTimeout()
      await Promise.all(toStat.slice(i, i + 64).map(async (e) => {
        fileStats.set(e.name, await fs.stat(path.join(dirReal, e.name)).catch((err: NodeJS.ErrnoException) => err))
      }))
    }
    let nonEmpty = false
    for (const e of entries) {
      signal?.throwIfAborted()
      if (Date.now() > deadline) throw walkTimeout()
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childReal = path.join(dirReal, e.name)
      if (isZipUnsafeName(e.name, !rel)) {
        excluded.add('unreadable', `${childRel}${e.isDirectory() ? '/' : ''} (name not valid in a zip)`)
        continue
      }
      if (e.isSymbolicLink()) {
        if (await addSymlink(childReal, childRel, e.name)) nonEmpty = true
      } else if (e.isDirectory()) {
        if (isBlockedPath(childReal, wsReal)) {
          excluded.add('blocked', `${childRel}/`)
        } else if (!includeIgnored && IGNORED_SET.has(e.name)) {
          excluded.add('ignored', `${childRel}/`)
          excluded.ignoredNames[e.name] = (excluded.ignoredNames[e.name] ?? 0) + 1
        } else {
          if (!(await walk(childReal, childRel))) {
            const st = await fs.stat(childReal).catch(() => null)
            plan.items.push({ rel: childRel, mtimeMs: st?.mtimeMs ?? Date.now() })
          }
          nonEmpty = true
        }
      } else if (e.isFile()) {
        if (isEnvName(e.name) || isBlockedPath(childReal, wsReal)) {
          excluded.add('blocked', childRel)
          continue
        }
        const st = fileStats.get(e.name)!
        if (st instanceof Error) {
          excluded.add('unreadable', `${childRel} (${st.code ?? 'error'})`)
          continue
        }
        addFile(childRel, childReal, st)
        nonEmpty = true
      } else {
        // FIFO / socket / device — reading one would block or never end.
        excluded.add('unreadable', `${childRel} (not a regular file)`)
      }
    }
    return nonEmpty
  }

  await walk(rootReal, '')
  return plan
}

/** The `estimate=1` JSON body. */
export function planSummary(plan: FolderZipPlan): { files: number; bytes: number; excluded: Record<string, number>; ignoredNames: Record<string, number> } {
  return { files: plan.files, bytes: plan.bytes, excluded: { ...plan.excluded.counts }, ignoredNames: { ...plan.excluded.ignoredNames } }
}

// yazl internals: an entry whose data is fully written (Entry.FILE_DATA_DONE).
const YAZL_ENTRY_DONE = 3

/**
 * yazl's lazy-stream callback, handing `stream` over once and then dropping
 * it. A parked entry keeps this callback (via doFileDataPump) for the rest of
 * the download, so it must not pin the finished stream: ~1.2 KB/file, ~250 MB
 * at the 200k cap. Module-level on purpose — an arrow inside the loop would
 * share the iteration's closure context (entryData, source, handle) with the
 * stream handlers and keep all of it alive regardless.
 */
function handOverOnce(stream: Readable): (cb: (err: Error | null, s: Readable) => void) => void {
  let held: Readable | null = stream
  return (cb) => {
    const s = held!
    held = null
    cb(null, s)
  }
}

/**
 * Stream `plan` as a zip. A file is opened only once the previous one has
 * been consumed, so at most two descriptors are open and reading follows the
 * consumer's pace. A file that fails to open is skipped and a read error
 * mid-file ends that entry early — either way it lands in `_halo-excluded.txt`,
 * since the status line is long gone. Abort (client disconnect or the
 * response stream closing) stops the loop and destroys the zip stream.
 */
export function streamFolderZip(plan: FolderZipPlan, folderName: string, signal?: AbortSignal): Readable {
  const zip = new ZipFile()
  const output = zip.outputStream
  const total = plan.files
  let written = 0
  let finished = false
  let stopped = false
  let current: Readable | null = null

  const stop = (why: string): void => {
    if (stopped || finished) return
    stopped = true
    console.log(`[Files] Folder download ${why} after ${written}/${total} files: ${folderName}`)
    current?.destroy()
    output.destroy()
  }
  signal?.addEventListener('abort', () => stop('aborted by client'), { once: true })
  // The client may have left during the walk's last fs call (after its last
  // throwIfAborted) — a listener added now never fires for that.
  if (signal?.aborted) stop('aborted by client')
  output.on('end', () => {
    finished = true
    console.log(`[Files] Folder download done: ${folderName} (${written} files, ${plan.excluded.total} excluded)`)
  })
  output.on('close', () => stop('closed'))
  zip.on('error', (err) => {
    console.log(`[Files] Folder zip error: ${err.message}`)
    stop('failed')
  })

  // yazl's pumpEntries() rescans `entries` from index 0 for the first
  // unfinished entry on every add / finish — O(n²): ~27 s of CPU for 100k
  // files. Entries are written strictly in order, so finished ones are parked
  // here and spliced back before end() (the central directory needs them all).
  // Real fix belongs upstream (a cursor in pumpEntries); yazl is pinned exact.
  // A done entry's pump closure (pumpFileDataReadStream's scope) is dead
  // weight from here on — dropped too: ~200 B/file.
  type YazlEntry = { state: number; doFileDataPump?: unknown }
  const internal = zip as unknown as { entries: YazlEntry[] }
  const parked: YazlEntry[] = []
  const park = (): void => {
    while (internal.entries.length > 0 && internal.entries[0].state === YAZL_ENTRY_DONE) {
      const entry = internal.entries.shift()!
      entry.doFileDataPump = undefined
      parked.push(entry)
    }
  }

  void (async () => {
    // Empty-dir entries first, while nothing is in flight: each one is written
    // synchronously on add, so park() keeps the stack flat. Queued behind an
    // in-flight file instead, they drain in one recursive pumpEntries chain
    // when it finishes — ~5k of them overflow the stack, and the RangeError
    // from that stream handler is an uncaughtException (server exit).
    for (const item of plan.items) {
      if (item.abs) continue
      if (stopped) return
      park()
      zip.addEmptyDirectory(item.rel, { mtime: new Date(item.mtimeMs) })
    }
    for (const item of plan.items) {
      if (!item.abs) continue
      if (stopped) return
      park()
      const mtime = new Date(item.mtimeMs)
      let handle: fs.FileHandle
      try {
        handle = await fs.open(item.abs, 'r')
      } catch (err) {
        plan.excluded.add('unreadable', `${item.rel} (${(err as NodeJS.ErrnoException).code ?? 'error'})`)
        continue
      }
      if (stopped) { await handle.close(); return }
      const source = handle.createReadStream()
      const entryData = new PassThrough()
      let read = 0
      source.on('data', (chunk: string | Buffer) => { read += chunk.length })
      source.on('error', (err: NodeJS.ErrnoException) => {
        if (stopped) return
        plan.excluded.add('unreadable', `${item.rel} (${err.code ?? 'read error'} after ${read} bytes — truncated in zip)`)
        entryData.end()
      })
      // A stop() mid-file destroys the source; release the loop with it.
      source.on('close', () => { if (stopped) entryData.destroy() })
      source.pipe(entryData)
      current = source
      const consumed = new Promise<void>((resolve) => { entryData.once('end', resolve); entryData.once('close', resolve) })
      const ext = path.extname(item.rel).slice(1).toLowerCase()
      zip.addReadStreamLazy(item.rel, { mtime, mode: item.mode, compress: !STORED_EXTS.has(ext) }, handOverOnce(entryData))
      await consumed
      current = null
      if (stopped) return
      written++
    }
    if (stopped) return
    park()
    if (plan.excluded.total > 0) {
      zip.addBuffer(Buffer.from(plan.excluded.toText(folderName), 'utf8'), EXCLUDED_LIST_NAME, { mtime: new Date() })
    }
    internal.entries = parked.concat(internal.entries)
    zip.end()
  })().catch((err: unknown) => {
    console.log(`[Files] Folder zip error: ${err instanceof Error ? err.message : String(err)}`)
    stop('failed')
  })

  return output
}
