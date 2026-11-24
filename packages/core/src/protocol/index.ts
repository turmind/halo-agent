/**
 * `@turmind/halo-core/protocol` — the wire contract shared by server and admin:
 * the persisted session-message shape, every admin WebSocket frame, and the
 * canvas-extension shapes (installed-extension snapshot + host↔iframe frames).
 *
 * Pure types, constants and one helper; deliberately free of node-only imports so the admin
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
  ExtensionActivity,
  ExtensionChatbar,
  ExtensionBackend,
  ExtensionBackendIsolation,
  ExtensionSettingField,
  ExtensionSettings,
  ExtensionInfo,
  ExtensionError,
  ExtensionsSnapshot,
} from './extension-types.js'
export type {
  ExtensionFrameBase,
  ExtensionTheme,
  ExtensionThemeToken,
  ExtensionThemeVars,
  ExtensionLang,
  ExtensionFsOp,
  ExtensionFsScope,
  ExtensionFsErrorCode,
  ExtensionFsEntry,
  ExtensionPickErrorCode,
  ExtensionHostFrame,
  ExtensionClientFrame,
  ExtensionHostFrameType,
  ExtensionClientFrameType,
} from './extension-frames.js'
export { EXTENSION_PROTOCOL_VERSION, EXTENSION_THEME_TOKENS } from './extension-frames.js'
export {
  EXTENSION_BACKENDS_ENV, EXTENSION_NODE_ENV, EXTENSION_CALLER_HEADER,
  EXTENSION_VIEW_CONTEXT_HEADER, EXTENSION_VIEW_CONTEXT_QUERY,
  EXTENSION_ACCESS_TTL_MS, EXTENSION_NOTICE_LIMITS,
} from './extension-notices.js'
export type {
  ExtensionBackendAccess, ExtensionBackendAccessMap, ExtensionViewContext,
  ExtensionSessionCaller, ExtensionAdminCaller, ExtensionCaller,
  ExtensionCallerRevocationReason, ExtensionCallerRevokedMessage, ExtensionCallerUpdatedMessage,
  ExtensionCanvasDeclaration, ExtensionCanvasContext, ExtensionCanvasTab,
  ExtensionCanvasOpenAction, ExtensionCanvasInitFrame, ExtensionFocusChatFrame,
  ExtensionNoticeLevel, ExtensionNoticeAnswer, ExtensionNoticeDecision,
  ExtensionNoticeErrorCode, ExtensionNoticeResponseStatus, ExtensionNotice, ExtensionNoticeRecord,
  ExtensionNoticeBackendMessage, ExtensionNoticeHostMessage, ExtensionBackendHostMessage,
  ExtensionNoticeRespondFrame, ExtensionNoticeServerFrame,
} from './extension-notices.js'
export {
  NOTIFY_TOKEN_FILE, NOTIFY_PATH, NOTIFY_WORKSPACE_ENV, NOTIFY_SESSION_ENV, NOTIFY_URL_ENV, NOTIFY_TOKEN_ENV, NOTIFY_SHELL_ENV, NOTIFY_MAX_TEXT_BYTES, NOTIFY_LABEL,
} from './notify.js'
export type { NotifyRequest } from './notify.js'
export type { UpdateScope, CoreUpdateState, CoreUpdateStatus, ExtensionUpdateState, ExtensionUpdateEntry, ExtensionsUpdateStatus } from './update-types.js'
