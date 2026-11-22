import type { WsClient } from '../ws-client-types'
import { reduceNotice, useExtensionNotices } from '@/features/extensions/notice-store'

export function registerExtensionHandlers(client: WsClient): () => void {
  useExtensionNotices.setState({ connected: client.connected })
  const off = [
    client.on('extension:notice', (frame) => useExtensionNotices.setState((s) => reduceNotice(s, frame))),
    client.on('extension:notice:snapshot', (frame) => useExtensionNotices.setState((s) => reduceNotice(s, frame))),
    client.on('extension:notice:resolved', (frame) => useExtensionNotices.setState((s) => reduceNotice(s, frame))),
    client.on('extension:notice:response', (frame) => useExtensionNotices.setState((s) => reduceNotice(s, frame))),
    client.on('_connected', () => useExtensionNotices.setState({ connected: true })),
    client.on('_disconnected', () => useExtensionNotices.setState({ connected: false, syncedProject: null, pending: [] })),
  ]
  return () => off.forEach((fn) => fn())
}
