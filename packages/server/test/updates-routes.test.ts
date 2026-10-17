import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

/**
 * Contract for /api/updates (routes/updates.ts): behind the admin cookie,
 * `scope` validated, GET / POST answer with the core status right away.
 * HALO_VERSION=dev so nothing touches the network (the checker's cadence is
 * covered in updates-core.test.ts). Every src import is dynamic: config.ts
 * reads jwt_secret at module load, so credentials go on disk first (same
 * setup as extensions-routes.test.ts).
 */

describe('/api/updates routes', () => {
  const PW = 'testpass1'
  let tmpHome: string
  let app: Hono
  let cookie: string

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-updates-routes-'))
    process.env.HOME = tmpHome
    delete process.env.HALO_PASSWORD
    // dev → the route answers without touching the network.
    process.env.HALO_VERSION = 'dev'
    const hash = await import('../src/middleware/password-hash.js')
    const setupConfig = await import('../src/setup-config.js')
    setupConfig.updateConfigLeaves({
      'server.password': await hash.hashPassword(PW),
      'server.jwt_secret': hash.generateJwtSecret(),
    })
    const auth = await import('../src/middleware/auth.js')
    const routes = await import('../src/routes/updates.js')
    app = new Hono()
    app.use('/api/*', auth.authMiddleware() as never)
    app.route('/api', auth.createAuthRoutes())
    app.route('/api', routes.createUpdateRoutes())
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')!.split(';')[0]
  })

  afterAll(() => {
    delete process.env.HALO_VERSION
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('requires the admin cookie', async () => {
    expect((await app.request('/api/updates?scope=core')).status).toBe(401)
    expect((await app.request('/api/updates/check', { method: 'POST', body: JSON.stringify({ scope: 'core' }) })).status).toBe(401)
  })

  it('validates scope', async () => {
    expect((await app.request('/api/updates', { headers: { Cookie: cookie } })).status).toBe(400)
    expect((await app.request('/api/updates?scope=extensions', { headers: { Cookie: cookie } })).status).toBe(400)
    expect((await app.request('/api/updates/check', { method: 'POST', headers: { Cookie: cookie }, body: 'nope' })).status).toBe(400)
  })

  it('GET and POST answer with the core status', async () => {
    const get = await app.request('/api/updates?scope=core', { headers: { Cookie: cookie } })
    expect(get.status).toBe(200)
    expect(await get.json()).toMatchObject({ current: 'dev', state: 'dev', checking: false })
    const post = await app.request('/api/updates/check', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'core' }),
    })
    expect(post.status).toBe(200)
    expect(await post.json()).toMatchObject({ state: 'dev' })
  })
})
