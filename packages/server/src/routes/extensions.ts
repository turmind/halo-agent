/**
 * Canvas preview extensions — admin API + static asset serving.
 *
 *   GET    /extensions                                installed list (valid + error entries)
 *   POST   /extensions/install                        multipart `file` = zip → install / upgrade
 *   DELETE /extensions/:id                            uninstall
 *   GET    /extensions/token                          short-lived asset token for the iframe URL
 *   GET    /extensions/:id/:version/:token/<asset>    static file from the extension dir
 *
 * The first four sit behind the admin cookie (index.ts mounts this router
 * under /api, which authMiddleware guards). The static route is what the
 * admin's sandboxed iframe loads and is NOT cookie-authed: the host iframe
 * was first shipped as `sandbox="allow-scripts"` only — an opaque origin
 * whose subresources (classic/module scripts, img, css, fetch, wasm, dynamic
 * import, Worker) are cross-site requests without any cookie — so the
 * credential moved into the URL as a PATH segment (a query string would be
 * dropped when the document resolves `./viewer.js`-style relative URLs):
 * authMiddleware lets that path shape through and this route verifies the
 * token itself. The host now also grants `allow-same-origin` (needed so a
 * cookie-auth proxy in front of halo sees its own cookie on the asset
 * requests), but this route deliberately keeps the token as its one auth
 * path. The token is only ever good for these assets — validateToken refuses
 * it as a cookie. `version` in the URL must equal the installed version: a
 * stale tab holding an old URL 404s after an upgrade (the admin treats that
 * as "reload me"), and it makes the assets safely immutable-cached.
 *
 * Install / uninstall do NOT broadcast themselves: the resulting rename / rm
 * trips extensions/watcher.ts, the single notifier for every install path.
 * They do call rescanAndBroadcast() so the response and the very next GET
 * already reflect the change without waiting for the debounce.
 */
import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { imageMimeFromExt } from '@turmind/halo-core'
import { extensionsRoot, getExtension, getSnapshot, isExtensionId } from '../extensions/registry.js'
import { ExtensionInstallError, installExtensionZip, uninstallExtension } from '../extensions/install.js'
import { rescanAndBroadcast } from '../extensions/watcher.js'
import { mintScopedToken, verifyScopedToken } from '../middleware/auth.js'

/** Upload cap. The glb viewer is ~2 MB unpacked; a drawio-class extension
 *  (draw.war is 54 MB) needs headroom. */
export const MAX_ZIP_BYTES = 100 * 1024 * 1024

/** Asset-token lifetime. It only grants reads of extension static files and
 *  the admin fetches a fresh one before every iframe mount, so short is free. */
const EXT_TOKEN_MAX_AGE = 24 * 60 * 60
const EXT_TOKEN_SCOPE = 'ext'

/** Asset MIME by extension. Images from core's shared table; the rest is what
 *  a static viewer bundle plausibly ships (`.wasm` matters — browsers refuse
 *  to `WebAssembly.instantiateStreaming` anything else). */
const ASSET_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  hdr: 'application/octet-stream', bin: 'application/octet-stream',
}

export function assetMime(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return imageMimeFromExt(ext) ?? ASSET_MIME[ext] ?? 'application/octet-stream'
}

/**
 * Resolve `<root>/<id>/<rest>` for the static route, or null when the request
 * must 404: unknown / invalid extension, version mismatch, a `..` or
 * dot-prefixed segment, or the target isn't a regular file. Hono URL-decodes
 * the param, so `rest` can arrive as `../../x` — the segment check runs
 * BEFORE any path.join, and a realpath prefix check guards symlinks.
 */
export function resolveAsset(id: string, version: string, rest: string): string | null {
  if (!isExtensionId(id)) return null
  const info = getExtension(id)
  if (!info || info.version !== version) return null
  const segments = rest.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || s.includes('\\'))) return null
  let dir: string
  let real: string
  try {
    // realpath both sides: the root itself may sit under a symlink (macOS /var).
    dir = fs.realpathSync(path.join(extensionsRoot(), id))
    real = fs.realpathSync(path.join(dir, ...segments))
  } catch {
    return null
  }
  if (real !== dir && !real.startsWith(dir + path.sep)) return null
  try {
    if (!fs.statSync(real).isFile()) return null
  } catch {
    return null
  }
  return real
}

export function createExtensionRoutes() {
  const app = new Hono()

  app.get('/extensions', (c) => c.json(getSnapshot()))

  // Cookie-authed (any logged-in admin). The admin embeds the token as a path
  // segment of the iframe src so relative subresource URLs inherit it.
  app.get('/extensions/token', (c) => c.json({
    token: mintScopedToken(EXT_TOKEN_SCOPE, EXT_TOKEN_MAX_AGE),
    expiresAt: Date.now() + EXT_TOKEN_MAX_AGE * 1000,
  }))

  app.post('/extensions/install', async (c) => {
    // Refuse by declared size before buffering the body; the file.size check
    // below covers chunked uploads that carry no Content-Length.
    if (Number(c.req.header('content-length') ?? 0) > MAX_ZIP_BYTES) return c.json({ error: `zip exceeds ${MAX_ZIP_BYTES / 1024 / 1024} MB` }, 413)
    let file: File | null = null
    try {
      const form = await c.req.formData()
      const f = form.get('file')
      file = f instanceof File ? f : null
    } catch {
      return c.json({ error: 'multipart form with a `file` field is required' }, 400)
    }
    if (!file) return c.json({ error: '`file` (zip) is required' }, 400)
    if (file.size > MAX_ZIP_BYTES) return c.json({ error: `zip exceeds ${MAX_ZIP_BYTES / 1024 / 1024} MB` }, 413)
    try {
      const info = await installExtensionZip(Buffer.from(await file.arrayBuffer()))
      rescanAndBroadcast()
      return c.json(info)
    } catch (err) {
      if (err instanceof ExtensionInstallError) return c.json({ error: err.message }, 400)
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[Extensions] install failed: ${msg}`)
      return c.json({ error: msg }, 500)
    }
  })

  app.delete('/extensions/:id', (c) => {
    const id = c.req.param('id')
    if (!isExtensionId(id)) return c.json({ error: 'Invalid extension id' }, 400)
    try {
      if (!uninstallExtension(id)) return c.json({ error: 'Extension not installed' }, 404)
      rescanAndBroadcast()
      return c.json({ ok: true, id })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[Extensions] uninstall ${id} failed: ${msg}`)
      return c.json({ error: msg }, 500)
    }
  })

  // No cookie here (authMiddleware skips this path shape) — the scoped token
  // in the path is the credential.
  app.get('/extensions/:id/:version/:token/:rest{.+}', (c) => {
    if (!verifyScopedToken(c.req.param('token'), EXT_TOKEN_SCOPE)) return c.json({ error: 'Unauthorized' }, 401)
    const abs = resolveAsset(c.req.param('id'), c.req.param('version'), c.req.param('rest'))
    if (!abs) return c.json({ error: 'Not found' }, 404)
    const stat = fs.statSync(abs)
    const nodeStream = fs.createReadStream(abs)
    c.req.raw.signal?.addEventListener('abort', () => nodeStream.destroy(), { once: true })
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
      headers: {
        'Content-Type': assetMime(abs),
        'Content-Length': String(stat.size),
        // The version segment changes on every upgrade, so the URL is a
        // content address as far as the browser is concerned.
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Module scripts / fetch / wasm / dynamic import are CORS-mode
        // requests; the iframe is same-origin today so this is a no-op, kept
        // so the assets keep loading if the host ever drops allow-same-origin.
        'Access-Control-Allow-Origin': '*',
        // The token is in the URL — keep it out of Referer headers.
        'Referrer-Policy': 'no-referrer',
      },
    })
  })

  return app
}
