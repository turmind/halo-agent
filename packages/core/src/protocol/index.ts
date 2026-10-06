/**
 * `@turmind/halo-core/protocol` — the wire contract shared by server and admin:
 * the persisted session-message shape, every admin WebSocket frame, and the
 * canvas-extension shapes (installed-extension snapshot + host↔iframe frames).
 *
 * Pure types + one helper + one constant; deliberately free of node-only imports so the admin
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
export type {
  ExtensionCapability,
  ExtensionPlatform,
  ExtensionPriority,
  ExtensionSettingField,
  ExtensionSettings,
  ExtensionInfo,
  ExtensionError,
  ExtensionsSnapshot,
} from './extension-types.js'
export type {
  ExtensionFrameBase,
  ExtensionTheme,
  ExtensionLang,
  ExtensionFsOp,
  ExtensionFsErrorCode,
  ExtensionFsEntry,
  ExtensionHostFrame,
  ExtensionClientFrame,
  ExtensionHostFrameType,
  ExtensionClientFrameType,
} from './extension-frames.js'
export { EXTENSION_PROTOCOL_VERSION } from './extension-frames.js'
