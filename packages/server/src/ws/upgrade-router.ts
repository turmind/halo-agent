/**
 * http `upgrade` listener that routes WebSocket handshakes by exact pathname
 * to `noServer` ws servers. One listener for every WS endpoint: a ws server
 * attached with `{ server, path }` aborts every other path's handshake with
 * 400, so a second endpoint can't simply attach alongside the first.
 *
 * Runs before any auth, outside every request handler, on raw client input —
 * a throw here is an uncaught exception that takes the process down. Hence
 * the plain `split('?')` (`new URL()` throws on a request-target like `//[`)
 * and the Map (a plain-object lookup would resolve `/__proto__`-style keys).
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

export function createUpgradeRouter(routes: ReadonlyMap<string, UpgradeHandler>): UpgradeHandler {
  return (req, socket, head) => {
    const handler = routes.get((req.url ?? '/').split('?')[0])
    if (handler) handler(req, socket, head)
    else socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  }
}
