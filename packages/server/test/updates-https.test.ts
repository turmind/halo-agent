import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import type http from 'node:http'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { httpsGet, HttpsGetError } from '../src/updates/https-get.js'
import { parseAllowlist } from '../src/a2a/url-policy.js'
import { downloadPackage, fetchUpdateJson } from '../src/updates/extension-fetch.js'

/**
 * Contract for the update downloader (updates/https-get.ts) and the
 * update.json fetch on top of it (updates/extension-fetch.ts), against a
 * local self-signed TLS server: https only (redirects too), the redirect cap,
 * the byte cap (declared and streamed), one deadline for the whole call, the
 * URL policy for author-chosen URLs, and the update.json error codes the
 * admin turns into grey text (404 → not-found).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-upd-https-'))
let server: https.Server
let base: string
const realCa = https.globalAgent.options.ca

const ZIP = Buffer.from('pretend this is a zip')
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex')
let routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {}

beforeAll(async () => {
  const gen = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'),
  ], { encoding: 'utf-8' })
  if (gen.status !== 0) throw new Error(`openssl failed: ${gen.stderr}`)
  const cert = fs.readFileSync(path.join(tmp, 'cert.pem'))
  // httpsGet uses the global agent — trust the test CA there, restore after.
  https.globalAgent.options.ca = cert
  server = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert }, (req, res) => {
    const handler = routes[req.url ?? '']
    if (handler) handler(req, res)
    else { res.statusCode = 404; res.end('nope') }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  https.globalAgent.options.ca = realCa
  server.closeAllConnections()
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function reply(status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(status, headers); res.end(body) }
}
const redirect = (to: string) => reply(302, '', { location: to })
const opts = { maxBytes: 1024, timeoutMs: 2_000 }

async function rejection(p: Promise<unknown>): Promise<HttpsGetError> {
  try { await p } catch (err) { return err as HttpsGetError }
  throw new Error('expected a rejection')
}

describe('httpsGet', () => {
  it('returns a 2xx body and the final URL after relative and absolute redirects', async () => {
    routes = { '/a': redirect('/b'), '/b': redirect(`${base}/c`), '/c': reply(200, 'hello') }
    const r = await httpsGet(`${base}/a`, opts)
    expect(r.status).toBe(200)
    expect(r.body.toString()).toBe('hello')
    expect(r.url).toBe(`${base}/c`)
  })

  it('reports a non-2xx as a status with an empty body, not an error', async () => {
    routes = {}
    const r = await httpsGet(`${base}/missing`, opts)
    expect(r.status).toBe(404)
    expect(r.body.length).toBe(0)
  })

  it('refuses http, before and after a redirect', async () => {
    expect((await rejection(httpsGet('http://127.0.0.1/x', opts))).code).toBe('refused')
    routes = { '/down': redirect('http://127.0.0.1/x') }
    expect((await rejection(httpsGet(`${base}/down`, opts))).code).toBe('refused')
  })

  it('refuses credentials in the URL', async () => {
    expect((await rejection(httpsGet(`https://u:p@127.0.0.1/x`, opts))).code).toBe('refused')
  })

  it('caps redirects', async () => {
    routes = { '/loop': redirect('/loop') }
    expect((await rejection(httpsGet(`${base}/loop`, opts))).code).toBe('redirects')
  })

  it('caps the body by Content-Length and while streaming', async () => {
    routes = {
      '/declared': reply(200, Buffer.alloc(2048)),
      '/chunked': (_req, res) => { res.writeHead(200); res.write(Buffer.alloc(800)); res.write(Buffer.alloc(800)); res.end() },
    }
    expect((await rejection(httpsGet(`${base}/declared`, opts))).code).toBe('too-large')
    expect((await rejection(httpsGet(`${base}/chunked`, opts))).code).toBe('too-large')
  })

  it('times out the whole call', async () => {
    routes = { '/hang': () => { /* never answers */ } }
    const started = Date.now()
    expect((await rejection(httpsGet(`${base}/hang`, { ...opts, timeoutMs: 300 }))).code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('applies the URL policy to author-chosen URLs: loopback refused unless listed', async () => {
    routes = { '/ok': reply(200, 'hi') }
    const strict = parseAllowlist('')
    expect((await rejection(httpsGet(`${base}/ok`, { ...opts, allowlist: strict }))).code).toBe('refused')
    // Hostname form goes through the guarded DNS lookup instead of the literal check.
    const port = (server.address() as AddressInfo).port
    expect((await rejection(httpsGet(`https://localhost:${port}/ok`, { ...opts, allowlist: strict }))).code).toBe('refused')
    const listed = parseAllowlist('127.0.0.0/8,::1/128')
    expect((await httpsGet(`${base}/ok`, { ...opts, allowlist: listed })).body.toString()).toBe('hi')
  })
})

describe('fetchUpdateJson / downloadPackage', () => {
  const good = { id: 'glb', version: '1.2.0', url: 'glb-1.2.0.zip', sha256: ZIP_SHA }

  it('reads update.json and resolves url against the final (redirected) URL', async () => {
    routes = { '/hub/glb/update.json': redirect('/mirror/glb/update.json'), '/mirror/glb/update.json': reply(200, JSON.stringify(good)) }
    const r = await fetchUpdateJson('glb', `${base}/hub/glb/update.json`, { fromManifest: false })
    expect(r).toEqual({ info: { id: 'glb', version: '1.2.0', url: `${base}/mirror/glb/glb-1.2.0.zip`, sha256: ZIP_SHA } })
  })

  it('maps 404 to not-found, bad JSON / bad fields to invalid, other failures to unreachable', async () => {
    routes = {
      '/bad-json': reply(200, '{nope'),
      '/bad-id': reply(200, JSON.stringify({ ...good, id: 'other' })),
      '/gone': reply(410, ''),
      '/boom': reply(500, ''),
    }
    expect(await fetchUpdateJson('glb', `${base}/missing`, { fromManifest: false })).toMatchObject({ code: 'not-found' })
    expect(await fetchUpdateJson('glb', `${base}/gone`, { fromManifest: false })).toMatchObject({ code: 'not-found' })
    expect(await fetchUpdateJson('glb', `${base}/bad-json`, { fromManifest: false })).toMatchObject({ code: 'invalid' })
    expect(await fetchUpdateJson('glb', `${base}/bad-id`, { fromManifest: false })).toMatchObject({ code: 'invalid', error: expect.stringMatching(/does not match/) })
    expect(await fetchUpdateJson('glb', `${base}/boom`, { fromManifest: false })).toMatchObject({ code: 'unreachable' })
    expect(await fetchUpdateJson('glb', 'http://127.0.0.1/x', { fromManifest: false })).toMatchObject({ code: 'refused' })
  })

  it('refuses a manifest-source URL on loopback under the default URL policy', async () => {
    routes = { '/glb/update.json': reply(200, JSON.stringify(good)) }
    expect(await fetchUpdateJson('glb', `${base}/glb/update.json`, { fromManifest: true })).toMatchObject({ code: 'refused' })
  })

  it('downloads a package whose sha256 matches, refuses one that does not', async () => {
    routes = { '/glb.zip': reply(200, ZIP) }
    const info = { id: 'glb', version: '1.2.0', url: `${base}/glb.zip`, sha256: ZIP_SHA }
    expect((await downloadPackage(info, { fromManifest: false, maxBytes: 1024 })).equals(ZIP)).toBe(true)
    await expect(downloadPackage({ ...info, sha256: 'b'.repeat(64) }, { fromManifest: false, maxBytes: 1024 })).rejects.toThrow(/sha256 mismatch/)
    await expect(downloadPackage(info, { fromManifest: false, maxBytes: 4 })).rejects.toMatchObject({ code: 'too-large' })
    await expect(downloadPackage({ ...info, url: `${base}/nope.zip` }, { fromManifest: false, maxBytes: 1024 })).rejects.toThrow(/HTTP 404/)
  })
})
