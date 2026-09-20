/**
 * `@turmind/halo-core/protocol` — the wire contract shared by server and admin:
 * the persisted session-message shape and every admin WebSocket frame.
 *
 * Pure types + one helper; deliberately free of node-only imports so the admin
 * (browser bundle) can import it without dragging in `simple-git` etc. from the
 * package root.
 */
export type { ToolCallEntry, ContentBlockEntry, MessageType, SessionMessage } from './session-message.js'
export { inferMessageType } from './session-message.js'
export type {
  WsClientMessage,
  WsServerMessage,
  WsServerMessageType,
  WsFrame,
  WsStateSnapshot,
  WsUsageData,
} from './ws-frames.js'
