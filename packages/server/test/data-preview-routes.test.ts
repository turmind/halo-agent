import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createDataPreviewRoutes } from '../src/routes/data-preview.js'
import { DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES, setSandboxHiddenPaths } from '../src/tools/sandbox.js'

/**
 * Contract: /data-preview/* parses parquet + sqlite + csv/tsv server-side and
 * returns schema + one page of rows as plain JSON — with files.ts-grade
 * workspace path validation, strictly read-only close-per-request sqlite
 * opens (a live WAL db is immediately writable by its owner after a preview —
 * no lingering lock), and 400-with-readable-message for bad input (missing
 * table, corrupt file, wrong format) instead of a 500. CSV is streamed with
 * O(page) memory and a lazy row count (totalRows is a lower bound while
 * hasMore is true; exact once a page's scan reaches EOF).
 *
 * fixtures/sample.parquet was generated with python3 + pyarrow (snappy
 * compression), 250 rows exercising int64 beyond 2^53, nulls and binary:
 *   pq.write_table(pa.table({
 *     "id": range 1..250 (int64), "name": f"row-{i}", "score": i*0.5 (f64),
 *     "active": i%2==0, "big": 2**60+i (int64),
 *     "note": None every 10th else f"note {i}",
 *     "payload": b"\x01\x02\x03" every 5th else None (binary),
 *   }), "sample.parquet", compression="snappy")
 */

const FIXTURE_PARQUET = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.parquet')

describe('data-preview routes', () => {
  let ws: string
  let outside: string
  let boundaryField: string
  const app = createDataPreviewRoutes()

  const get = async (route: string, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString()
    const res = await app.request(`${route}?${qs}`)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-data-preview-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-data-preview-outside-'))
    fs.writeFileSync(path.join(outside, 'secret.db'), 'outside the workspace')
    // Real data files outside the workspace — the admin's read-only external
    // tabs pass them by absolute path.
    fs.writeFileSync(path.join(outside, 'ext.csv'), 'k,v\na,1\nb,2\n')
    const extDb = new Database(path.join(outside, 'ext.db'))
    extDb.exec(`CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3)`)
    extDb.close()
    fs.mkdirSync(path.join(outside, 'hidden'))
    fs.writeFileSync(path.join(outside, 'hidden', 'h.csv'), 'a\n1\n')
    fs.symlinkSync(path.join(outside, 'hidden', 'h.csv'), path.join(outside, 'h-link.csv'))

    fs.copyFileSync(FIXTURE_PARQUET, path.join(ws, 'sample.parquet'))
    fs.writeFileSync(path.join(ws, 'fake.parquet'), 'not really a parquet file at all')
    fs.writeFileSync(path.join(ws, 'garbage.db'), 'not a sqlite database, just text padding padding')

    // CSV fixtures: RFC 4180 edge cases (quoted delimiter / escaped quote /
    // newline inside quotes), BOM, TSV, empty / header-only, CRLF, 250 data
    // rows to exercise pagination + the lazy hasMore count.
    const csvLines = ['id,name,note']
    for (let i = 1; i <= 250; i++) csvLines.push(`${i},row-${i},note ${i}`)
    fs.writeFileSync(path.join(ws, 'plain.csv'), csvLines.join('\n') + '\n')
    fs.writeFileSync(
      path.join(ws, 'tricky.csv'),
      // CRLF line endings; row 1 has a quoted comma, an escaped "" and a
      // newline inside quotes; row 2 is plain.
      'id,text,tail\r\n1,"a, ""quoted"" value\nsecond line",end\r\n2,plain,done\r\n',
    )
    fs.writeFileSync(path.join(ws, 'bom.csv'), '\uFEFFa,b\n1,2\n')
    fs.writeFileSync(path.join(ws, 'empty.csv'), '')
    fs.writeFileSync(path.join(ws, 'header-only.csv'), 'x,y,z\n')
    fs.writeFileSync(path.join(ws, 'data.tsv'), 'col1\tcol2\nv1\tv,2\nv3\tv4\n')
    // Lone-\r (old Mac) line endings.
    fs.writeFileSync(path.join(ws, 'maccr.csv'), 'a,b\r1,2\r3,4\r')
    // Delimiter sniffing: European semicolon CSV; and a header whose
    // semicolons all sit inside quotes (must not fool the sniffer).
    fs.writeFileSync(path.join(ws, 'semi.csv'), 'a;b;c\n1;2,5;3\n')
    fs.writeFileSync(path.join(ws, 'quoted-semis.csv'), 'a,"b;;;;;",c\n1,2,3\n')
    // Delimiter flood (reviewer's attack shape): 4MB of pure commas, no
    // newline — one giant row of empty fields. Must 400, not balloon memory.
    fs.writeFileSync(path.join(ws, 'comma-flood.csv'), ','.repeat(4 * 1024 * 1024))
    // Chunk-boundary fixture: fs.createReadStream default highWaterMark is
    // 64KB, so token state must carry across push() calls. Engineered so the
    // `""` escape straddles byte 65536 (quotePending carry) and row 1's CRLF
    // terminator straddles byte 131072 (sawCR carry); the quoted field itself
    // spans the first boundary (inQuotes carry) and contains a literal \n.
    const CHUNK = 64 * 1024
    const pre = 'id,text\r\n1,"'
    const part1 = 'A\n' + 'x'.repeat(CHUNK - 1 - pre.length - 2)
    const part2 = 'y'.repeat(2 * CHUNK - 2 - (pre.length + part1.length + 2))
    boundaryField = part1 + '"' + part2
    const boundary = pre + part1 + '""' + part2 + '"\r\n2,tail\n'
    // Pin the engineering — if these drift the test silently stops covering
    // the boundary carries.
    expect([boundary[CHUNK - 1], boundary[CHUNK]]).toEqual(['"', '"'])
    expect([boundary[2 * CHUNK - 1], boundary[2 * CHUNK]]).toEqual(['\r', '\n'])
    fs.writeFileSync(path.join(ws, 'boundary.csv'), boundary)

    // WAL-mode db mirroring a live workspace halo.db: BLOB column, big int64,
    // NULLs, and >100 rows to exercise pagination.
    const db = new Database(path.join(ws, 'app.db'))
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, weight REAL, data BLOB, big INTEGER)`)
    db.exec(`CREATE TABLE empty_table (a TEXT, b INTEGER)`)
    const ins = db.prepare('INSERT INTO items (label, weight, data, big) VALUES (?, ?, ?, ?)')
    for (let i = 1; i <= 150; i++) {
      ins.run(
        i % 7 === 0 ? null : `item-${i}`,
        i * 1.5,
        i % 10 === 0 ? Buffer.alloc(32, i) : null,
        2n ** 60n + BigInt(i),
      )
    }
    db.close()
  })

  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  // ── sqlite ──

  it('sqlite/tables lists tables with row counts', async () => {
    const { status, body } = await get('/data-preview/sqlite/tables', { path: 'app.db', projectId: ws })
    expect(status).toBe(200)
    expect(body.tables).toEqual([
      { name: 'empty_table', rowCount: 0 },
      { name: 'items', rowCount: 150 },
    ])
  })

  it('sqlite/rows returns first page with schema, blob placeholder, exact big ints, NULLs', async () => {
    const { status, body } = await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws, table: 'items' })
    expect(status).toBe(200)
    expect(body.totalRows).toBe(150)
    expect(body.offset).toBe(0)
    expect(body.limit).toBe(100)
    const columns = body.columns as Array<{ name: string; type: string }>
    expect(columns.map((c) => c.name)).toEqual(['id', 'label', 'weight', 'data', 'big'])
    expect(columns[1].type).toBe('TEXT')
    const rows = body.rows as Array<Array<unknown>>
    expect(rows).toHaveLength(100)
    // row 1: id=1, label=item-1, weight=1.5, data=NULL, big=2^60+1 (as string — beyond 2^53)
    expect(rows[0]).toEqual([1, 'item-1', 1.5, null, (2n ** 60n + 1n).toString()])
    // row 7: label is NULL
    expect(rows[6][1]).toBeNull()
    // row 10: BLOB → placeholder, not binary
    expect(rows[9][3]).toBe('<blob 32 bytes>')
  })

  it('sqlite/rows paginates with offset/limit', async () => {
    const { body } = await get('/data-preview/sqlite/rows', {
      path: 'app.db', projectId: ws, table: 'items', offset: '140', limit: '25',
    })
    expect(body.offset).toBe(140)
    expect((body.rows as unknown[]).length).toBe(10) // 150 total → last page has 10
    expect((body.rows as Array<Array<unknown>>)[0][0]).toBe(141)
  })

  it('sqlite/rows on an empty table returns schema and zero rows', async () => {
    const { status, body } = await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws, table: 'empty_table' })
    expect(status).toBe(200)
    expect(body.totalRows).toBe(0)
    expect(body.rows).toEqual([])
    expect((body.columns as Array<{ name: string }>).map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('sqlite/rows 400s on a nonexistent table (and on injection-shaped names)', async () => {
    const missing = await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws, table: 'nope' })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('Table not found: nope')
    const inject = await get('/data-preview/sqlite/rows', {
      path: 'app.db', projectId: ws, table: 'items"; DROP TABLE items; --',
    })
    expect(inject.status).toBe(400)
    // Pin the rejection path: sqlite_master membership check, not a SQL
    // syntax error from the name reaching a query.
    expect(inject.body.error).toBe('Table not found: items"; DROP TABLE items; --')
  })

  it('sqlite preview leaves no lingering lock — the live writer writes fine right after', async () => {
    // Scope note: by the time get() resolves, the route's finally has already
    // closed its readonly connection — so this pins "preview leaves the db
    // immediately writable" (no lock / WAL-handle residue), NOT concurrent
    // read+write (WAL's readers-don't-block-writers is SQLite's own
    // guarantee, not re-proven here).
    const writer = new Database(path.join(ws, 'app.db'))
    try {
      const { status } = await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws, table: 'items' })
      expect(status).toBe(200)
      writer.prepare('INSERT INTO items (label) VALUES (?)').run('written-after-preview')
      const count = writer.prepare('SELECT count(*) c FROM items').get() as { c: number }
      expect(count.c).toBe(151)
      writer.prepare('DELETE FROM items WHERE label = ?').run('written-after-preview')
    } finally {
      writer.close()
    }
  })

  it('sqlite 400s with a readable error on a non-sqlite file', async () => {
    const { status, body } = await get('/data-preview/sqlite/tables', { path: 'garbage.db', projectId: ws })
    expect(status).toBe(400)
    expect(body.error).toBe('File is not a SQLite database')
  })

  // ── parquet ──

  it('parquet returns schema + first page with exact big ints, nulls, blob placeholder', async () => {
    const { status, body } = await get('/data-preview/parquet', { path: 'sample.parquet', projectId: ws })
    expect(status).toBe(200)
    expect(body.totalRows).toBe(250)
    expect(body.offset).toBe(0)
    const columns = body.columns as Array<{ name: string; type: string }>
    expect(columns.map((c) => c.name)).toEqual(['id', 'name', 'score', 'active', 'big', 'note', 'payload'])
    expect(columns[1].type).toBe('STRING') // logical type surfaced
    const rows = body.rows as Array<Array<unknown>>
    expect(rows).toHaveLength(100)
    expect(rows[0][0]).toBe(1)
    expect(rows[0][1]).toBe('row-1')
    expect(rows[0][2]).toBe(0.5)
    expect(rows[0][3]).toBe(true) // fixture: active = (0-based index) % 2 == 0
    expect(rows[0][4]).toBe((2n ** 60n).toString()) // int64 > 2^53 → exact string
    expect(rows[0][6]).toBe('<blob 3 bytes>') // binary → placeholder
    expect(rows[10][5]).toBeNull() // note is null every 10th row (i=11 → index 10)
  })

  it('parquet paginates with offset/limit and clamps past-the-end reads', async () => {
    const page = await get('/data-preview/parquet', { path: 'sample.parquet', projectId: ws, offset: '200', limit: '100' })
    expect(page.body.offset).toBe(200)
    expect((page.body.rows as unknown[]).length).toBe(50)
    expect((page.body.rows as Array<Array<unknown>>)[0][0]).toBe(201)
    const past = await get('/data-preview/parquet', { path: 'sample.parquet', projectId: ws, offset: '9999' })
    expect(past.status).toBe(200)
    expect(past.body.rows).toEqual([])
  })

  it('parquet 400s with a readable error on a non-parquet file', async () => {
    const { status, body } = await get('/data-preview/parquet', { path: 'fake.parquet', projectId: ws })
    expect(status).toBe(400)
    expect(String(body.error)).toMatch(/parquet/i)
  })

  // ── csv / tsv ──

  it('csv first page: header as columns, lazy totalRows lower bound + hasMore', async () => {
    const { status, body } = await get('/data-preview/csv', { path: 'plain.csv', projectId: ws })
    expect(status).toBe(200)
    expect(body.columns).toEqual([
      { name: 'id', type: '' }, { name: 'name', type: '' }, { name: 'note', type: '' },
    ])
    const rows = body.rows as string[][]
    expect(rows).toHaveLength(100)
    expect(rows[0]).toEqual(['1', 'row-1', 'note 1'])
    expect(rows[99]).toEqual(['100', 'row-100', 'note 100'])
    // Lazy count: scan stopped at the 101st data row — lower bound, not 250.
    expect(body.totalRows).toBe(101)
    expect(body.hasMore).toBe(true)
  })

  it('csv last page: exact totalRows once EOF is reached', async () => {
    const { body } = await get('/data-preview/csv', { path: 'plain.csv', projectId: ws, offset: '200', limit: '100' })
    const rows = body.rows as string[][]
    expect(rows).toHaveLength(50)
    expect(rows[0]).toEqual(['201', 'row-201', 'note 201'])
    expect(body.totalRows).toBe(250)
    expect(body.hasMore).toBe(false)
  })

  it('csv offset far past EOF returns empty page with exact total', async () => {
    const { status, body } = await get('/data-preview/csv', { path: 'plain.csv', projectId: ws, offset: '99999' })
    expect(status).toBe(200)
    expect(body.rows).toEqual([])
    expect(body.totalRows).toBe(250)
    expect(body.hasMore).toBe(false)
  })

  it('csv handles RFC 4180: quoted comma, escaped quote, newline in quotes, CRLF', async () => {
    const { body } = await get('/data-preview/csv', { path: 'tricky.csv', projectId: ws })
    const rows = body.rows as string[][]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(['1', 'a, "quoted" value\nsecond line', 'end'])
    expect(rows[1]).toEqual(['2', 'plain', 'done'])
    expect(body.totalRows).toBe(2)
  })

  it('csv strips BOM from the first header cell', async () => {
    const { body } = await get('/data-preview/csv', { path: 'bom.csv', projectId: ws })
    expect(body.columns).toEqual([{ name: 'a', type: '' }, { name: 'b', type: '' }])
    expect(body.rows).toEqual([['1', '2']])
  })

  it('csv empty file and header-only file return zero rows', async () => {
    const empty = await get('/data-preview/csv', { path: 'empty.csv', projectId: ws })
    expect(empty.status).toBe(200)
    expect(empty.body.columns).toEqual([])
    expect(empty.body.rows).toEqual([])
    expect(empty.body.totalRows).toBe(0)

    const headerOnly = await get('/data-preview/csv', { path: 'header-only.csv', projectId: ws })
    expect(headerOnly.status).toBe(200)
    expect((headerOnly.body.columns as unknown[]).length).toBe(3)
    expect(headerOnly.body.rows).toEqual([])
    expect(headerOnly.body.totalRows).toBe(0)
  })

  it('tsv splits on tab (comma stays literal)', async () => {
    const { body } = await get('/data-preview/csv', { path: 'data.tsv', projectId: ws })
    expect(body.columns).toEqual([{ name: 'col1', type: '' }, { name: 'col2', type: '' }])
    expect(body.rows).toEqual([['v1', 'v,2'], ['v3', 'v4']])
  })

  it('csv handles lone-\\r (old Mac) line endings', async () => {
    const { body } = await get('/data-preview/csv', { path: 'maccr.csv', projectId: ws })
    expect(body.columns).toEqual([{ name: 'a', type: '' }, { name: 'b', type: '' }])
    expect(body.rows).toEqual([['1', '2'], ['3', '4']])
  })

  it('csv sniffs a semicolon delimiter; quoted semicolons do not fool it', async () => {
    const semi = await get('/data-preview/csv', { path: 'semi.csv', projectId: ws })
    expect(semi.body.columns).toEqual([
      { name: 'a', type: '' }, { name: 'b', type: '' }, { name: 'c', type: '' },
    ])
    expect(semi.body.rows).toEqual([['1', '2,5', '3']]) // European decimal comma intact

    const quoted = await get('/data-preview/csv', { path: 'quoted-semis.csv', projectId: ws })
    expect((quoted.body.columns as Array<{ name: string }>).map((c) => c.name)).toEqual(['a', 'b;;;;;', 'c'])
    expect(quoted.body.rows).toEqual([['1', '2', '3']])
  })

  it('csv carries tokenizer state across 64KB stream chunks (inQuotes / "" escape / CRLF)', async () => {
    const { status, body } = await get('/data-preview/csv', { path: 'boundary.csv', projectId: ws })
    expect(status).toBe(200)
    expect(body.columns).toEqual([{ name: 'id', type: '' }, { name: 'text', type: '' }])
    const rows = body.rows as string[][]
    expect(rows).toHaveLength(2)
    expect(rows[0][0]).toBe('1')
    // The chunk-straddling "" resolved to one literal quote, the quoted \n
    // preserved, the field not split or truncated at either boundary.
    expect(rows[0][1]).toBe(boundaryField)
    expect(rows[1]).toEqual(['2', 'tail'])
    expect(body.totalRows).toBe(2)
  })

  it('csv 400s on a delimiter flood (megabytes of commas, no newline) without buffering it', async () => {
    const { status, body } = await get('/data-preview/csv', { path: 'comma-flood.csv', projectId: ws })
    expect(status).toBe(400)
    expect(body.error).toBe('Row exceeds 1MB — file may not be valid CSV/TSV')
  })

  // ── shared guards ──

  it('rejects path traversal out of the workspace on all four endpoints', async () => {
    const escape = `../${path.basename(outside)}/secret.db`
    for (const route of ['/data-preview/sqlite/tables', '/data-preview/sqlite/rows', '/data-preview/parquet', '/data-preview/csv']) {
      const { status, body } = await get(route, { path: escape, projectId: ws, table: 'items' })
      expect(status).toBe(403)
      expect(body.error).toBe('Path traversal not allowed')
    }
  })

  it('absolute path outside the workspace (read-only external tab) reads csv and sqlite', async () => {
    const csv = await get('/data-preview/csv', { path: path.join(outside, 'ext.csv'), projectId: ws })
    expect(csv.status).toBe(200)
    expect(csv.body.rows).toEqual([['a', '1'], ['b', '2']])
    const tables = await get('/data-preview/sqlite/tables', { path: path.join(outside, 'ext.db'), projectId: ws })
    expect(tables.status).toBe(200)
    expect(tables.body.tables).toEqual([{ name: 't', rowCount: 3 }])
    const rows = await get('/data-preview/sqlite/rows', { path: path.join(outside, 'ext.db'), projectId: ws, table: 't' })
    expect(rows.status).toBe(200)
    expect(rows.body.rows).toEqual([[1], [2], [3]])
  })

  it('absolute path with a .. segment → 400', async () => {
    const { status, body } = await get('/data-preview/csv', { path: `${ws}/../${path.basename(outside)}/ext.csv`, projectId: ws })
    expect(status).toBe(400)
    expect(body.error).toBe('absolute path without .. required')
  })

  it('sandbox-hidden absolute paths (direct or via a symlink) answer exactly like a missing file', async () => {
    setSandboxHiddenPaths([path.join(outside, 'hidden')], [])
    try {
      for (const p of [path.join(outside, 'hidden', 'h.csv'), path.join(outside, 'h-link.csv'), path.join(outside, 'nope.csv')]) {
        const { status, body } = await get('/data-preview/csv', { path: p, projectId: ws })
        expect(status, p).toBe(404)
        expect(body).toEqual({ error: 'File not found' })
      }
    } finally {
      setSandboxHiddenPaths(DEFAULT_HIDDEN_DIRS, DEFAULT_HIDDEN_FILES)
    }
  })

  it('400s on missing params, 404s on missing project / file', async () => {
    expect((await get('/data-preview/parquet', { projectId: ws })).status).toBe(400)
    expect((await get('/data-preview/parquet', { path: 'sample.parquet' })).status).toBe(400)
    expect((await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws })).status).toBe(400) // no table
    expect((await get('/data-preview/parquet', { path: 'sample.parquet', projectId: path.join(ws, 'nope') })).status).toBe(404)
    expect((await get('/data-preview/parquet', { path: 'missing.parquet', projectId: ws })).status).toBe(404)
    expect((await get('/data-preview/csv', { path: 'missing.csv', projectId: ws })).status).toBe(404)
  })
})
