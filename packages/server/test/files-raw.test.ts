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

function put(file: string, body: Uint8Array, expectMtime?: number) {
  const q = new URLSearchParams({ path: file, projectId: ws })
  if (expectMtime !== undefined) q.set('expectMtime', String(expectMtime))
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
