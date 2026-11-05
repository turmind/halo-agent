import { Hono } from 'hono'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { asyncBufferFromFile, parquetMetadataAsync, parquetSchema, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { readableRealPath, resolveProjectPath, systemPath, validatePath } from './workspace-path.js'

/**
 * Tabular data previews (Parquet / SQLite / CSV / TSV) for the admin editor.
 *
 * All formats are parsed server-side and returned as schema + one page of
 * rows in a shared wire shape — large files never travel to the browser, and
 * the admin renders them with a single table component.
 *
 * SQLite opens are strictly read-only (`readonly` + `fileMustExist`) and
 * closed per request, so previewing a live db (e.g. the workspace's own
 * `.halo/halo.db`) leaves no lingering lock — the owner keeps writing
 * (covered by the no-lingering-lock route test; concurrent read+write is
 * WAL's own readers-don't-block-writers guarantee). SQLite may still
 * (re)create the `-shm`/`-wal` coordination sidecars when reading a
 * WAL-mode db; that is standard WAL behavior and harmless (`immutable=1`
 * would avoid it but breaks reading a db that's being written).
 */

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/** A rendered cell — always a JSON scalar so the admin table stays dumb. */
type Cell = string | number | boolean | null

/** Convert one raw value (sqlite row / hyparquet row) into a JSON-safe cell. */
function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      // int64 beyond 2^53 would silently lose precision as a JS number.
      return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
        ? Number(value)
        : value.toString()
  }
  if (value instanceof Date) return value.toISOString()
  // Covers Buffer (sqlite BLOB) and Uint8Array (parquet BYTE_ARRAY) — never
  // inline binary into JSON.
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`
  // Nested parquet values (LIST / STRUCT) — stringify for display.
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString()
    if (v instanceof Uint8Array) return `<blob ${v.byteLength} bytes>`
    return v
  })
}

/** Quote a SQL identifier (table names can't be bound as parameters). */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

// A single CSV row larger than this is almost certainly a binary file renamed
// .csv (no newlines for megabytes) — bail instead of buffering it into memory,
// which would break the O(page) promise.
const MAX_ROW_CHARS = 1_000_000

const QUOTE = 34
const CR = 13
const LF = 10
const COMMA = 44
const SEMI = 59
const TAB = 9

/**
 * Minimal RFC 4180 streaming tokenizer. Fed decoded text chunk by chunk;
 * carries quote / CRLF state across chunk boundaries so quoted commas,
 * escaped quotes ("") and newlines inside quotes all parse correctly.
 * Liberal where RFC is strict: a quote mid-unquoted-field is literal, junk
 * after a closing quote is appended, an unterminated quote at EOF flushes
 * what accumulated. Blank lines are skipped (matches the old SheetJS-based
 * preview and csv-parse's skip_empty_lines).
 *
 * onRow returning true stops the scan (caller then destroys the stream).
 */
class CsvScanner {
  private field = ''
  private row: string[] = []
  private inQuotes = false
  private quotePending = false // saw a quote inside a quoted field — "" escape or close?
  private sawCR = false // saw \r at chunk end — swallow a following \n
  private rowChars = 0
  done = false

  constructor(
    private delim: number,
    private onRow: (row: string[]) => boolean,
  ) {}

  push(text: string): void {
    for (let i = 0; i < text.length && !this.done; i++) {
      const c = text.charCodeAt(i)
      // Every consumed char counts toward the row cap — delimiters and quotes
      // included. Counting only appended field chars lets a delimiter flood
      // (megabytes of pure commas = millions of empty fields) bypass the
      // guard and balloon the row array instead of the field string.
      if (++this.rowChars > MAX_ROW_CHARS) {
        throw new Error('Row exceeds 1MB — file may not be valid CSV/TSV')
      }
      if (this.sawCR) {
        this.sawCR = false
        if (c === LF) continue // the \n of a \r\n
      }
      if (this.quotePending) {
        this.quotePending = false
        if (c === QUOTE) {
          this.field += '"'
          continue
        }
        this.inQuotes = false // quote closed; fall through to process c
      }
      if (this.inQuotes) {
        if (c === QUOTE) this.quotePending = true
        else this.field += text[i]
        continue
      }
      if (c === QUOTE && this.field === '') {
        this.inQuotes = true
        continue
      }
      if (c === this.delim) {
        this.endField()
        continue
      }
      if (c === LF) {
        this.endRow()
        continue
      }
      if (c === CR) {
        this.endRow()
        this.sawCR = true
        continue
      }
      this.field += text[i]
    }
  }

  /** EOF — flush a final row that wasn't newline-terminated. */
  flush(): void {
    if (this.done) return
    this.quotePending = false
    this.inQuotes = false
    if (this.field !== '' || this.row.length > 0) this.endRow()
  }

  private endField(): void {
    this.row.push(this.field)
    this.field = ''
  }

  private endRow(): void {
    this.endField()
    const row = this.row
    this.row = []
    this.rowChars = 0
    if (row.length === 1 && row[0] === '') return // blank line
    if (this.onRow(row)) this.done = true
  }
}

/**
 * Sniff the delimiter from the file's first line (the header): count `,` `;`
 * and tab outside quoted sections, pick the most frequent (comma wins ties —
 * it's the format's namesake). SheetJS auto-detected European `;` CSVs; the
 * streaming route must too, or those files silently parse as one column.
 * Reads at most 64KB — a header longer than that hits MAX_ROW_CHARS during
 * the real scan anyway.
 */
async function sniffDelimiter(absolutePath: string): Promise<number> {
  const fh = await fs.open(absolutePath, 'r')
  let head: string
  try {
    const buf = Buffer.alloc(65536)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    head = new TextDecoder('utf-8').decode(buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
  const nl = head.search(/[\r\n]/)
  const line = nl === -1 ? head : head.slice(0, nl)
  const counts: Record<number, number> = { [COMMA]: 0, [SEMI]: 0, [TAB]: 0 }
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    if (c === QUOTE) inQuotes = !inQuotes
    else if (!inQuotes && c in counts) counts[c]++
  }
  if (counts[SEMI] > counts[COMMA] && counts[SEMI] >= counts[TAB]) return SEMI
  if (counts[TAB] > counts[COMMA] && counts[TAB] > counts[SEMI]) return TAB
  return COMMA
}

/**
 * Stream one page out of a CSV/TSV file: header (first row) + rows
 * [offset, offset+limit) of the data rows after it.
 *
 * totalRows strategy — lazy, not exact: we scan only until the
 * offset+limit+1-th data row (the sentinel proving another page exists),
 * then destroy the stream. An exact count would read the whole file on
 * EVERY page turn — a 1GB CSV costs seconds of sequential I/O + parsing per
 * click, which defeats the "large files open instantly" goal. The trade-off:
 * while hasMore is true, totalRows is only the known lower bound
 * (offset+limit+1) and the UI shows "N+ rows"; once the user reaches the
 * last page (EOF before the sentinel) totalRows becomes exact. Files
 * smaller than one page past the current offset therefore always get exact
 * totals automatically.
 *
 * Memory is O(page): rows before `offset` are counted and discarded, at most
 * limit+1 rows are ever buffered. The event loop yields between chunks (fs
 * read stream async iteration); per-chunk work is a ~64KB char scan.
 */
async function scanCsvPage(
  absolutePath: string,
  delim: number,
  offset: number,
  limit: number,
): Promise<{ columns: Array<{ name: string; type: string }>; rows: string[][]; totalRows: number; hasMore: boolean }> {
  let header: string[] | null = null
  let seen = 0 // data rows consumed (skipped or paged), excluding the sentinel
  const page: string[][] = []
  let hasMore = false

  const scanner = new CsvScanner(delim, (row) => {
    if (header === null) {
      header = row
      return false
    }
    if (seen < offset) {
      seen++
      return false
    }
    if (page.length < limit) {
      page.push(row)
      seen++
      return false
    }
    hasMore = true // the offset+limit+1-th data row exists
    return true
  })

  const stream = createReadStream(absolutePath)
  // TextDecoder handles multi-byte UTF-8 split across chunks (stream: true),
  // strips a leading BOM by default, and replaces invalid bytes with U+FFFD
  // instead of throwing.
  const decoder = new TextDecoder('utf-8')
  try {
    for await (const chunk of stream) {
      scanner.push(decoder.decode(chunk as Buffer, { stream: true }))
      if (scanner.done) break // breaking the async iterator destroys the stream
    }
  } finally {
    stream.destroy()
  }
  if (!scanner.done) {
    scanner.push(decoder.decode())
    scanner.flush()
  }

  // Ragged files: widen to the widest row on this page so no cell is
  // silently hidden; extra columns beyond the header render unnamed.
  const headerRow: string[] = header ?? []
  const width = page.reduce((m, r) => Math.max(m, r.length), headerRow.length)
  const columns = Array.from({ length: width }, (_, i) => ({ name: headerRow[i] ?? '', type: '' }))
  const rows = page.map((r) => (r.length === width ? r : [...r, ...Array<string>(width - r.length).fill('')]))
  return { columns, rows, totalRows: hasMore ? seen + 1 : seen, hasMore }
}

function errText(err: unknown): string {
  if ((err as { code?: string }).code === 'SQLITE_NOTADB') return 'File is not a SQLite database'
  return err instanceof Error ? err.message : String(err)
}

export function createDataPreviewRoutes() {
  const app = new Hono()

  // Same (projectId, path) resolution as files.ts /files/download. Relative
  // path → confined to the workspace. Absolute path → anywhere on the host
  // under /fs/raw's rules (no `..`, judged by realpath, hidden lists answer
  // like a missing file): the admin's read-only tabs for files outside the
  // workspace (chat path links). Same trust boundary as /fs/raw — admin cookie
  // only (not in PUBLIC_PATHS), and every endpoint here is read-only (sqlite
  // opens `readonly`).
  async function resolveDataFile(
    projectId: string | undefined,
    filePath: string | undefined,
  ): Promise<{ absolutePath: string } | { error: string; status: 400 | 403 | 404 }> {
    if (!filePath || !projectId) return { error: 'path and projectId are required', status: 400 }
    const projectPath = await resolveProjectPath(projectId)
    if (!projectPath) return { error: 'Project not found', status: 404 }
    let absolutePath: string
    if (path.isAbsolute(filePath)) {
      const target = systemPath(filePath)
      if (!target) return { error: 'absolute path without .. required', status: 400 }
      try {
        absolutePath = await readableRealPath(target)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EACCES' || code === 'EPERM') return { error: (err as Error).message, status: 403 }
        return { error: 'File not found', status: 404 }
      }
    } else {
      if (!validatePath(filePath, projectPath)) return { error: 'Path traversal not allowed', status: 403 }
      absolutePath = path.resolve(projectPath, filePath)
    }
    try {
      const stat = await fs.stat(absolutePath)
      if (stat.isDirectory()) return { error: 'Path is a directory', status: 400 }
    } catch {
      return { error: 'File not found', status: 404 }
    }
    return { absolutePath }
  }

  function parsePagination(offsetRaw: string | undefined, limitRaw: string | undefined) {
    const offsetNum = parseInt(offsetRaw ?? '0', 10)
    const limitNum = parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10)
    return {
      offset: Math.max(isNaN(offsetNum) ? 0 : offsetNum, 0),
      limit: Math.min(Math.max(isNaN(limitNum) ? DEFAULT_LIMIT : limitNum, 1), MAX_LIMIT),
    }
  }

  function openSqlite(absolutePath: string): Database.Database {
    const db = new Database(absolutePath, { readonly: true, fileMustExist: true })
    // INTEGER is int64 — default mode rounds through a double and corrupts
    // large values (verified: ...983 reads back as ...000). toCell() folds
    // safe bigints back to numbers for the wire.
    db.defaultSafeIntegers(true)
    return db
  }

  // GET /data-preview/sqlite/tables?path=&projectId= — list tables + row counts
  app.get('/data-preview/sqlite/tables', async (c) => {
    const resolved = await resolveDataFile(c.req.query('projectId'), c.req.query('path'))
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)

    let db: Database.Database | null = null
    try {
      db = openSqlite(resolved.absolutePath)
      const names = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as Array<{ name: string }>
      // count(*) per table is a synchronous full-table scan — on a multi-GB
      // db this loop can hold the event loop for seconds. Accepted for now
      // (admin-only, low-frequency, previewed dbs are small); the real fix if
      // it bites: lazy rowCount (fetch per table on selection) or a cheap
      // max(rowid) estimate.
      const tables = names.map(({ name }) => ({
        name,
        rowCount: Number((db!.prepare(`SELECT count(*) AS c FROM ${quoteIdent(name)}`).get() as { c: bigint }).c),
      }))
      return c.json({ tables })
    } catch (err) {
      return c.json({ error: errText(err) }, 400)
    } finally {
      db?.close()
    }
  })

  // GET /data-preview/sqlite/rows?path=&projectId=&table=&offset=&limit= — one page of rows
  app.get('/data-preview/sqlite/rows', async (c) => {
    const resolved = await resolveDataFile(c.req.query('projectId'), c.req.query('path'))
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)
    const table = c.req.query('table')
    if (!table) return c.json({ error: 'table is required' }, 400)
    const { offset, limit } = parsePagination(c.req.query('offset'), c.req.query('limit'))

    let db: Database.Database | null = null
    try {
      db = openSqlite(resolved.absolutePath)
      // Identifiers can't be parameterized — gate on actual membership first.
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
      if (!exists) return c.json({ error: `Table not found: ${table}` }, 400)

      const totalRows = Number((db.prepare(`SELECT count(*) AS c FROM ${quoteIdent(table)}`).get() as { c: bigint }).c)
      // count(*) + OFFSET both scan synchronously — deep pages of a huge
      // table block the event loop for the scan duration. Accepted for now
      // (admin-only preview, 100-row pages); the real fix is keyset
      // pagination (WHERE rowid > ?) instead of OFFSET.
      const stmt = db.prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`)
      const columns = stmt.columns().map((col) => ({ name: col.name, type: col.type ?? '' }))
      const rows = (stmt.raw().all(limit, offset) as unknown[][]).map((row) => row.map(toCell))
      return c.json({ table, columns, rows, totalRows, offset, limit })
    } catch (err) {
      return c.json({ error: errText(err) }, 400)
    } finally {
      db?.close()
    }
  })

  // GET /data-preview/parquet?path=&projectId=&offset=&limit= — schema + one page of rows
  app.get('/data-preview/parquet', async (c) => {
    const resolved = await resolveDataFile(c.req.query('projectId'), c.req.query('path'))
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)
    const { offset, limit } = parsePagination(c.req.query('offset'), c.req.query('limit'))

    try {
      // asyncBufferFromFile slices with fs streams — hyparquet then reads only
      // the footer + the row groups covering [rowStart, rowEnd), never the
      // whole file.
      const file = await asyncBufferFromFile(resolved.absolutePath)
      const metadata = await parquetMetadataAsync(file)
      const totalRows = Number(metadata.num_rows)
      const columns = parquetSchema(metadata).children.map(({ element }) => ({
        name: element.name,
        type: element.logical_type?.type ?? element.converted_type ?? element.type ?? (element.num_children ? 'GROUP' : ''),
      }))
      const rowStart = Math.min(offset, totalRows)
      const rowEnd = Math.min(offset + limit, totalRows)
      // utf8:false only affects plain BYTE_ARRAY with no STRING/UTF8 logical
      // type (true binary) — those stay Uint8Array and become blob
      // placeholders instead of mojibake text. Real string columns are
      // unaffected (decoded via their logical type).
      const objects = rowStart < rowEnd
        ? await parquetReadObjects({ file, metadata, compressors, rowStart, rowEnd, utf8: false })
        : []
      const rows = objects.map((row) => columns.map((col) => toCell(row[col.name])))
      return c.json({ columns, rows, totalRows, offset, limit })
    } catch (err) {
      // hyparquet throws readable messages for wrong/corrupt files
      // (e.g. "parquet file invalid (footer != PAR1)").
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // GET /data-preview/csv?path=&projectId=&offset=&limit= — header + one page of rows
  // Streamed: memory stays O(page) regardless of file size. `hasMore` +
  // lower-bound totalRows until the last page (see scanCsvPage).
  app.get('/data-preview/csv', async (c) => {
    const resolved = await resolveDataFile(c.req.query('projectId'), c.req.query('path'))
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)
    const { offset, limit } = parsePagination(c.req.query('offset'), c.req.query('limit'))

    try {
      // .tsv is authoritative (tab); anything else sniffs the header line so
      // European semicolon-CSVs don't silently parse as a single column.
      const delim = resolved.absolutePath.toLowerCase().endsWith('.tsv')
        ? TAB
        : await sniffDelimiter(resolved.absolutePath)
      const { columns, rows, totalRows, hasMore } = await scanCsvPage(resolved.absolutePath, delim, offset, limit)
      return c.json({ columns, rows, totalRows, hasMore, offset, limit })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  return app
}
