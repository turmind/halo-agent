import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api, signInRequired } from '../src/shared/api-client'
import { execFs } from '../src/features/editor/previews/extension-host'
import { onFsResult, initialHostState, type HostEffect } from '../src/features/editor/previews/extension-host-logic'

/**
 * Contract: an fs request the host runs for an extension never follows a
 * redirect. An expired sign-in — Halo's own 401, or a login redirect from a
 * proxy in front of it (`opaqueredirect` under `redirect: 'manual'`) — comes
 * back as `fs-result { code: 'io', auth: true }`, never as a bare "Failed to
 * fetch" (cross-origin login page) or a fake success (same-origin login page
 * followed to a 200 HTML). 404 / 403 / network / 5xx keep their old mapping.
 */

const SIGN_IN = 'sign-in required — sign in to Halo again in another tab'
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// What a browser hands back for a redirect under `redirect: 'manual'` (not constructible).
const opaqueRedirect = () => ({
  ok: false, status: 0, statusText: '', type: 'opaqueredirect', headers: new Headers(), redirected: false,
  json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
}) as unknown as Response

/** A login proxy in front of Halo, as a browser sees it: `manual` → opaque
 *  redirect; followed → the login page (same origin) or a CORS failure. */
function loginProxy(sameOrigin: boolean) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.redirect === 'manual') return opaqueRedirect()
    if (sameOrigin) return new Response('<html><body>Sign in</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    throw new TypeError('Failed to fetch')
  })
}
const json = (status: number, body: unknown) =>
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

type FsEffect = Extract<HostEffect, { type: 'fs' }>
const fsEffects: FsEffect[] = [
  { type: 'fs', id: 1, op: 'write', path: 'audio/001.webm', buffer: new ArrayBuffer(4) },
  { type: 'fs', id: 1, op: 'append', path: 'transcript.md', buffer: new ArrayBuffer(4) },
  { type: 'fs', id: 1, op: 'read', path: 'meta.json' },
  { type: 'fs', id: 1, op: 'list', path: '' },
  { type: 'fs', id: 1, op: 'stat', path: 'meta.json' },
  { type: 'fs', id: 1, op: 'read', path: 'notes/a.txt', scope: 'workspace' },
  { type: 'fs', id: 1, op: 'read', path: '/srv/a.bin', scope: 'system' },
  { type: 'fs', id: 1, op: 'list', path: '/srv', scope: 'system' },
  { type: 'fs', id: 1, op: 'stat', path: '/srv/a.bin', scope: 'system' },
]
const label = (e: FsEffect) => `${e.scope ?? 'bundle'} ${e.op}`

/** The fs-result frame the extension would receive for `eff`. */
async function reply(eff: FsEffect) {
  const outcome = await execFs('p1', 'notes/m.htrans', eff)
  const post = onFsResult({ ...initialHostState(['media', 'fs-read'], true), ready: true }, eff.id, outcome).effects[0]
  return post.type === 'post' ? post.frame : null
}

describe('signInRequired', () => {
  it('401 and opaqueredirect are sign-in failures; anything else is not', () => {
    expect(signInRequired(new Response(null, { status: 401 }))).toEqual({ ok: false, status: 401, message: SIGN_IN, auth: true })
    expect(signInRequired(opaqueRedirect())).toEqual({ ok: false, status: 0, message: SIGN_IN, auth: true })
    for (const status of [200, 403, 404, 500]) expect(signInRequired(new Response(null, { status }))).toBeNull()
  })
})

describe('saveRaw', () => {
  it('never follows redirects', async () => {
    json(200, { mtime: 1, size: 4 })
    await api.files.saveRaw('a.bin', new ArrayBuffer(4), 'p1')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', redirect: 'manual' })
  })

  it('a cross-origin login redirect is auth, not "Failed to fetch"', async () => {
    loginProxy(false)
    expect(await api.files.saveRaw('a.bin', new ArrayBuffer(4), 'p1')).toEqual({ ok: false, status: 0, message: SIGN_IN, auth: true })
  })

  it('a same-origin login page is auth, not a fake success', async () => {
    loginProxy(true)
    expect(await api.files.saveRaw('a.bin', new ArrayBuffer(4), 'p1')).toEqual({ ok: false, status: 0, message: SIGN_IN, auth: true })
  })

  it("Halo's own 401 is auth", async () => {
    json(401, { error: 'Unauthorized' })
    expect(await api.files.saveRaw('a.bin', new ArrayBuffer(4), 'p1')).toEqual({ ok: false, status: 401, message: SIGN_IN, auth: true })
  })

  it('404, 409, 5xx and network errors keep their shape (no auth)', async () => {
    json(404, { error: 'File not found' })
    expect(await api.files.saveRaw('a.bin', new ArrayBuffer(4), 'p1')).toEqual({ ok: false, status: 404, message: 'File not found' })
    json(409, { mtime: 7 })
    expect(await api.files.saveRaw('a.bin', new ArrayBuffer(4), 'p1', 5)).toEqual({ ok: false, status: 409, mtime: 7 })
    json(500, { error: 'boom' })
    expect(await api.files.saveRaw('a.bin', new ArrayBuffer(4), 'p1')).toEqual({ ok: false, status: 500, message: 'boom' })
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch') })
    expect(await api.files.saveRaw('a.bin', new ArrayBuffer(4), 'p1')).toEqual({ ok: false, status: 0, message: 'Failed to fetch' })
  })
})

describe('extension fs requests → fs-result', () => {
  it('every op and scope fetches with redirect: manual', async () => {
    json(404, { error: 'File not found' })
    for (const eff of fsEffects) {
      fetchMock.mockClear()
      await execFs('p1', 'notes/m.htrans', eff)
      expect(fetchMock.mock.calls[0][1], label(eff)).toMatchObject({ redirect: 'manual' })
    }
  })

  for (const sameOrigin of [false, true]) {
    it(`a ${sameOrigin ? 'same' : 'cross'}-origin login redirect → io + auth on every op and scope`, async () => {
      loginProxy(sameOrigin)
      for (const eff of fsEffects) {
        expect(await reply(eff), label(eff)).toEqual({ haloExt: 1, type: 'fs-result', id: 1, ok: false, code: 'io', error: SIGN_IN, auth: true })
      }
    })
  }

  it('401 → io + auth on every op and scope', async () => {
    json(401, { error: 'Unauthorized' })
    for (const eff of fsEffects) {
      expect(await reply(eff), label(eff)).toEqual({ haloExt: 1, type: 'fs-result', id: 1, ok: false, code: 'io', error: SIGN_IN, auth: true })
    }
  })

  it('404 → not-found, 403 → denied, 5xx / network → io, none with auth', async () => {
    const cases: Array<[() => void, string, string]> = [
      [() => json(404, { error: 'File not found' }), 'not-found', 'File not found'],
      [() => json(403, { error: 'Forbidden' }), 'denied', 'Forbidden'],
      [() => json(500, { error: 'boom' }), 'io', 'boom'],
      [() => fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch') }), 'io', 'Failed to fetch'],
    ]
    for (const [arrange, code, error] of cases) {
      arrange()
      for (const eff of fsEffects) {
        expect(await reply(eff), `${label(eff)} ${code}`).toEqual({ haloExt: 1, type: 'fs-result', id: 1, ok: false, code, error })
      }
    }
  })
})
