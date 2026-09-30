import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: GET /auth/check carries the HALO_BADGE env (`badge`) on both the
 * 200 and the 401 body — it's the admin's first request (pre-login included),
 * so a dev-server tab can brand its favicon/title at runtime without a new
 * endpoint or poll. Unset/blank env → null → the admin keeps stock branding.
 *
 * Same HOME-redirect setup as auth-change-password.test.ts: jwt_secret is
 * read eagerly at config-module load, so credentials must be on disk before
 * the auth module is imported.
 */

let tmpHome: string
let app: ReturnType<typeof import('../src/middleware/auth.js')['createAuthRoutes']>

const PW = 'testpass1'

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-auth-badge-'))
  process.env.HOME = tmpHome
  delete process.env.HALO_PASSWORD
  delete process.env.HALO_BADGE

  const hash = await import('../src/middleware/password-hash.js')
  const setupConfig = await import('../src/setup-config.js')
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(PW),
    'server.jwt_secret': hash.generateJwtSecret(),
  })
  const auth = await import('../src/middleware/auth.js')
  app = auth.createAuthRoutes()
})

afterAll(() => {
  delete process.env.HALO_BADGE
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

async function check(cookie?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request('/auth/check', cookie ? { headers: { Cookie: cookie } } : undefined)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('GET /auth/check — HALO_BADGE passthrough', () => {
  it('badge set → surfaced on the pre-login 401 body', async () => {
    process.env.HALO_BADGE = 'DEV'
    const { status, json } = await check()
    expect(status).toBe(401)
    expect(json).toEqual({ authenticated: false, badge: 'DEV' })
  })

  it('badge set → surfaced on the authenticated 200 body', async () => {
    process.env.HALO_BADGE = 'DEV'
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const { status, json } = await check(cookie)
    expect(status).toBe(200)
    expect(json).toEqual({ authenticated: true, badge: 'DEV', goalModeEnabled: false })
  })

  it('unset or blank env → badge null (admin keeps stock branding)', async () => {
    delete process.env.HALO_BADGE
    expect((await check()).json).toEqual({ authenticated: false, badge: null })
    process.env.HALO_BADGE = '   '
    expect((await check()).json).toEqual({ authenticated: false, badge: null })
  })
})
