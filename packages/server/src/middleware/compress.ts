/**
 * Response compression: hono's `compress`, plus the two things it leaves out.
 *
 * 1. Its `threshold` is only checked against a `Content-Length` header, and
 *    `c.json` / `c.text` / `c.body(string)` never set one, so a 100-byte
 *    `/api/health` got gzipped. Before compress looks, a compressible body
 *    with no length is read up to `threshold` bytes: if it ends there, it's
 *    rebuilt with a `Content-Length` (compress then passes it through); if
 *    not, the bytes already read are replayed ahead of the rest of the
 *    stream. Never buffered whole: session archives run to several MB.
 * 2. compress never touches a 304, but RFC 9110 §15.4.5 wants the `Vary`
 *    the 200 would carry, so a 304 gets `Accept-Encoding` merged into it.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { compress, COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/compress'

/** Same as compress's `varyAcceptEncodingRegExp`. */
const VARY_ACCEPT_ENCODING_RE = /(?:^|,)\s*accept-encoding\s*(?:,|$)/i

export function compressResponses(threshold: number): MiddlewareHandler {
  const inner = compress({ threshold })
  return (c, next) => inner(c, async () => {
    await next()
    if (c.res.status === 304) varyAcceptEncoding(c)
    else await setProbedLength(c, threshold)
  })
}

function varyAcceptEncoding(c: Context): void {
  const vary = c.res.headers.get('Vary')
  if (vary === '*' || (vary && VARY_ACCEPT_ENCODING_RE.test(vary))) return
  c.header('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding')
}

async function setProbedLength(c: Context, threshold: number): Promise<void> {
  const res = c.res
  const type = res.headers.get('Content-Type')
  if (
    res.headers.has('Content-Length') || res.headers.has('Content-Encoding') || res.headers.has('Transfer-Encoding') ||
    c.req.method === 'HEAD' || res.status === 204 || res.status === 206 ||
    !res.body || !type || !COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type)
  ) return

  const reader = res.body.getReader()
  const head: Uint8Array[] = []
  let size = 0
  while (size < threshold) {
    const { done, value } = await reader.read()
    if (done) {
      // The c.res setter merges the old response's headers in, so the
      // length goes on after the assignment.
      c.res = new Response(Buffer.concat(head, size), res)
      c.res.headers.set('Content-Length', String(size))
      return
    }
    head.push(value)
    size += value.byteLength
  }
  c.res = new Response(new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const chunk = head.shift()
      if (chunk) return ctrl.enqueue(chunk)
      const { done, value } = await reader.read()
      if (done) ctrl.close()
      else ctrl.enqueue(value)
    },
    cancel: (reason) => reader.cancel(reason),
  }), res)
}
