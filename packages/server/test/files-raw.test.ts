import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileRoutes } from '../src/routes/files.js'

/**
 * Contract: PUT /files/raw replaces the bytes of an EXISTING workspace file
 * (binary-safe — PUT /files is utf-8 text only). It is the save path for
 * canvas preview extensions (design §4.4 / §6.3):
 *  - the target must already exist → 404 otherwise (save never creates);
 *  - `expectMtime` = the mtime the client loaded; a differing on-disk mtime
 *    means someone else wrote the file → 409 with the current mtime so the
 *    host can offer overwrite / discard / cancel;
 *  - success returns the new mtime + size the client stores for its next save.
 */

let tmp: string
let ws: string
const app = createFileRoutes()

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-files-raw-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'model.glb'), Buffer.from([1, 2, 3]))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function put(file: string, body: Uint8Array, expectMtime?: number, flags: { create?: boolean; append?: boolean; root?: string } = {}) {
  const q = new URLSearchParams({ path: file, projectId: ws })
  if (expectMtime !== undefined) q.set('expectMtime', String(expectMtime))
  if (flags.create) q.set('create', '1')
  if (flags.append) q.set('append', '1')
  if (flags.root !== undefined) q.set('root', flags.root)
  return app.request(`/files/raw?${q}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' } })
}

describe('PUT /files/raw', () => {
  it('404 when the file does not exist — save never creates', async () => {
    const res = await put('missing.glb', new Uint8Array([9]))
    expect(res.status).toBe(404)
    expect(fs.existsSync(path.join(ws, 'missing.glb'))).toBe(false)
  })

  it('409 with the current mtime when expectMtime is stale; disk untouched', async () => {
    const current = fs.statSync(path.join(ws, 'model.glb')).mtimeMs
    const res = await put('model.glb', new Uint8Array([9, 9]), current - 5000)
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; mtime: number; size: number }
    expect(body.error).toBe('conflict')
    expect(body.mtime).toBe(current)
    expect(body.size).toBe(3)
    expect(fs.readFileSync(path.join(ws, 'model.glb'))).toEqual(Buffer.from([1, 2, 3]))
  })

  it('200 writes the raw bytes when expectMtime matches (and when omitted)', async () => {
    const current = fs.statSync(path.join(ws, 'model.glb')).mtimeMs
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x00, 0xff])
    const res = await put('model.glb', bytes, current)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; path: string; mtime: number; size: number }
    expect(body.ok).toBe(true)
    expect(body.path).toBe('model.glb')
    expect(body.size).toBe(6)
    expect(body.mtime).toBe(fs.statSync(path.join(ws, 'model.glb')).mtimeMs)
    expect(fs.readFileSync(path.join(ws, 'model.glb'))).toEqual(Buffer.from(bytes))

    // No expectMtime → unconditional overwrite (the host's "overwrite" retry).
    const res2 = await put('model.glb', new Uint8Array([1]))
    expect(res2.status).toBe(200)
    expect(fs.readFileSync(path.join(ws, 'model.glb'))).toEqual(Buffer.from([1]))
  })

  it('403 on path traversal, 400 without path/projectId', async () => {
    const res = await app.request(`/files/raw?path=..%2Foutside.glb&projectId=${encodeURIComponent(ws)}`, { method: 'PUT', body: new Uint8Array([1]) })
    expect(res.status).toBe(403)
    expect((await app.request('/files/raw?path=model.glb', { method: 'PUT', body: new Uint8Array([1]) })).status).toBe(400)
  })
})

/**
 * Contract (htrans protocol §5): the bundle extensions' fs write / append.
 *  - `create=1`: a missing file is created, parents `mkdir -p`, instead of 404;
 *  - `append=1`: bytes are appended (create-first with `create=1`), and
 *    `expectMtime` is ignored;
 *  - traversal 403 / directory 400 / response shape unchanged.
 */
describe('PUT /files/raw create / append', () => {
  it('create=1 makes a missing file and its parent directories', async () => {
    const res = await put('m.htrans/shots/000750.jpg', new Uint8Array([0xff, 0xd8]), undefined, { create: true })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; path: string; mtime: number; size: number }
    expect(body).toMatchObject({ ok: true, path: 'm.htrans/shots/000750.jpg', size: 2 })
    expect(body.mtime).toBe(fs.statSync(path.join(ws, 'm.htrans/shots/000750.jpg')).mtimeMs)
    expect(fs.readFileSync(path.join(ws, 'm.htrans/shots/000750.jpg'))).toEqual(Buffer.from([0xff, 0xd8]))
  })

  it('create=1 on an existing file overwrites it', async () => {
    const res = await put('m.htrans/shots/000750.jpg', new Uint8Array([7]), undefined, { create: true })
    expect(res.status).toBe(200)
    expect(fs.readFileSync(path.join(ws, 'm.htrans/shots/000750.jpg'))).toEqual(Buffer.from([7]))
  })

  it('append=1 without create still 404s on a missing file', async () => {
    const res = await put('m.htrans/nope.md', new Uint8Array([1]), undefined, { append: true })
    expect(res.status).toBe(404)
    expect(fs.existsSync(path.join(ws, 'm.htrans/nope.md'))).toBe(false)
  })

  it('append=1&create=1 creates, then appends in order; size grows; expectMtime is ignored', async () => {
    const enc = new TextEncoder()
    const r1 = await put('m.htrans/transcript.md', enc.encode('[00:00:01] a\n'), undefined, { create: true, append: true })
    expect(r1.status).toBe(200)
    const r2 = await put('m.htrans/transcript.md', enc.encode('[00:00:02] b\n'), 1, { create: true, append: true }) // stale expectMtime → no 409
    expect(r2.status).toBe(200)
    const body = await r2.json() as { size: number }
    expect(body.size).toBe(26)
    expect(fs.readFileSync(path.join(ws, 'm.htrans/transcript.md'), 'utf-8')).toBe('[00:00:01] a\n[00:00:02] b\n')
  })

  it('a directory target is still 400 and traversal still 403 with the flags', async () => {
    expect((await put('m.htrans', new Uint8Array([1]), undefined, { create: true, append: true })).status).toBe(400)
    const q = new URLSearchParams({ path: '../escape/x.md', projectId: ws, create: '1', append: '1' })
    const res = await app.request(`/files/raw?${q}`, { method: 'PUT', body: new Uint8Array([1]) })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false)
  })

  it('GET /files/download on a missing file is 404 (bundle fs read → not-found), not 500', async () => {
    const res = await app.request(`/files/download?path=m.htrans%2Fnope.txt&projectId=${encodeURIComponent(ws)}&inline=1`)
    expect(res.status).toBe(404)
  })

  // Review fix: a bundle deleted / renamed mid-recording must not be
  // recreated at its old path by the next append's mkdir -p.
  it('root=<dir>: writes inside an existing root; missing root / outside root → 404, nothing created', async () => {
    const ok = await put('m.htrans/audio/seg-1.pcm', new Uint8Array([1, 2]), undefined, { create: true, append: true, root: 'm.htrans' })
    expect(ok.status).toBe(200)
    expect(fs.readFileSync(path.join(ws, 'm.htrans/audio/seg-1.pcm'))).toEqual(Buffer.from([1, 2]))

    const gone = await put('gone.htrans/transcript.md', new Uint8Array([1]), undefined, { create: true, append: true, root: 'gone.htrans' })
    expect(gone.status).toBe(404)
    expect(await gone.json()).toEqual({ error: 'Bundle root not found' })
    expect(fs.existsSync(path.join(ws, 'gone.htrans'))).toBe(false)

    // Root that is a file, a path outside the root, and the root itself all refuse.
    expect((await put('model.glb/x.md', new Uint8Array([1]), undefined, { create: true, root: 'model.glb' })).status).toBe(404)
    expect((await put('other/x.md', new Uint8Array([1]), undefined, { create: true, root: 'm.htrans' })).status).toBe(404)
    expect(fs.existsSync(path.join(ws, 'other'))).toBe(false)
    expect((await put('m.htrans', new Uint8Array([1]), undefined, { create: true, root: 'm.htrans' })).status).toBe(404)
    // Root traversal is still a 403.
    expect((await put('m.htrans/x.md', new Uint8Array([1]), undefined, { create: true, root: '../' })).status).toBe(403)
  })
})
