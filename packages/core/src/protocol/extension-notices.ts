/**
 * Generic extension backend access, notices and file-less Canvas contracts.
 * Types/constants only. Implementations validate untrusted input at ingress.
 * Source of truth for the browser-hooks workers; see browser-extension.md.
 */
import type { ExtensionFrameBase, ExtensionLang, ExtensionTheme, ExtensionThemeVars } from './extension-frames.js'
import type { ExtensionCapability, ExtensionPlatform } from './extension-types.js'

// Hook 1 — shell environment and proxy-owned caller identity.
export const EXTENSION_BACKENDS_ENV = 'HALO_EXT_BACKENDS'
export const EXTENSION_NODE_ENV = 'HALO_EXT_NODE'
export const EXTENSION_CALLER_HEADER = 'x-halo-caller'
export const EXTENSION_VIEW_CONTEXT_HEADER = 'x-halo-view-context'
export const EXTENSION_VIEW_CONTEXT_QUERY = '_halo_context'
export const EXTENSION_ACCESS_TTL_MS = 15 * 60 * 1000

/** Serialized as HALO_EXT_BACKENDS; accessKey is never a command argument. */
export interface ExtensionBackendAccess {
  url: string
  accessKey: string
  /** ISO 8601, absolute expiry. */
  expiresAt: string
}
export type ExtensionBackendAccessMap = Record<string, ExtensionBackendAccess>

/** Admin-supplied routing metadata, validated by the proxy; never authority. */
export interface ExtensionViewContext {
  /** Canonical absolute workspace path, matching the existing Admin API. */
  projectId: string
  sessionId?: string
}

interface ExtensionCallerBase {
  /** Non-secret reference, bound to the extension's current backend generation. */
  bindingId: string
  projectId: string
  /** Opaque human-input marker; null before any accepted Admin chat message. */
  userTurnId: string | null
}
export interface ExtensionSessionCaller extends ExtensionCallerBase {
  kind: 'session'
  sessionId: string
  rootSessionId: string
  agentId: string
}
export interface ExtensionAdminCaller extends ExtensionCallerBase {
  kind: 'admin'
  sessionId?: string
  rootSessionId?: string
  agentId?: string
}
/** base64url(JSON) in X-Halo-Caller, overwritten by the proxy on HTTP and WS. */
export type ExtensionCaller = ExtensionSessionCaller | ExtensionAdminCaller

export type ExtensionCallerRevocationReason =
  | 'session-stopped' | 'session-deleted' | 'access-changed'
  | 'skill-changed' | 'extension-changed' | 'shutdown'
export interface ExtensionCallerRevokedMessage {
  type: 'halo:caller:revoked'
  bindingId: string
  reason: ExtensionCallerRevocationReason
}
/** Updates the backend's handoff fence, not an already-issued bearer's marker. */
export interface ExtensionCallerUpdatedMessage {
  type: 'halo:caller:updated'
  bindingId: string
  userTurnId: string
}

// Generic Canvas surface. Worker B adds these to the existing manifest/frame unions.
export interface ExtensionCanvasDeclaration {
  title?: string
  title_zh?: string
  icon?: string
}
export interface ExtensionCanvasContext extends ExtensionViewContext {
  viewId: string
}
export interface ExtensionCanvasTab extends ExtensionCanvasContext {
  kind: 'extension'
  extensionId: string
}
/** Extension/workspace/session come from the validated notice envelope. */
export interface ExtensionCanvasOpenAction {
  type: 'open-canvas'
  viewId: string
  title?: string
}
export interface ExtensionCanvasInitFrame extends ExtensionFrameBase {
  type: 'init'
  view: 'canvas'
  protocol: 1
  context: ExtensionCanvasContext
  capabilities: ExtensionCapability[]
  theme: ExtensionTheme
  themeVars: ExtensionThemeVars
  platform: ExtensionPlatform
  lang: ExtensionLang
  immersive?: true
}
/** Focus the host-provided session's composer; never sends a chat message. */
export interface ExtensionFocusChatFrame extends ExtensionFrameBase {
  type: 'focus-chat'
}

// Hook 2 — notices are backend IPC -> core -> authenticated Admin WS.
export const EXTENSION_NOTICE_LIMITS = {
  messageChars: 2000,
  labelChars: 80,
  idChars: 128,
  viewIdChars: 128,
  minTtlMs: 1000,
  maxTtlMs: 30 * 60 * 1000,
  pendingPerExtensionWorkspace: 32,
} as const

export type ExtensionNoticeLevel = 'info' | 'warning'
export type ExtensionNoticeAnswer = 'confirm' | 'cancel'
export type ExtensionNoticeDecision = ExtensionNoticeAnswer | 'expired' | 'withdrawn'
export type ExtensionNoticeErrorCode = 'invalid-notice' | 'unknown-binding' | 'denied' | 'limit-exceeded'
export type ExtensionNoticeResponseStatus = 'accepted' | 'already-resolved' | 'expired' | 'denied'
export interface ExtensionNotice {
  /** Unique within one backend generation; changed consent needs a new id. */
  id: string
  message: string
  level: ExtensionNoticeLevel
  expiresInMs: number
  action?: ExtensionCanvasOpenAction
  confirmation?: { confirmLabel: string; cancelLabel: string }
}
export interface ExtensionNoticeRecord extends ExtensionViewContext {
  extensionId: string
  /** Opaque backend incarnation, not extension version. */
  generation: string
  notice: ExtensionNotice
  /** Core-calculated ISO 8601 deadline; reconnect never extends it. */
  expiresAt: string
}

export type ExtensionNoticeBackendMessage =
  | { type: 'halo:notice'; requestId: string; bindingId: string; notice: ExtensionNotice }
  | { type: 'halo:notice:withdraw'; id: string }
export type ExtensionNoticeHostMessage =
  | { type: 'halo:notice:accepted'; requestId: string; id: string; generation: string; expiresAt: string }
  | { type: 'halo:notice:error'; requestId: string; code: ExtensionNoticeErrorCode }
  | { type: 'halo:notice:result'; id: string; generation: string; decision: ExtensionNoticeDecision }
/** Additive to existing ready/busy/halo:pid IPC, not a replacement for it. */
export type ExtensionBackendHostMessage =
  | ExtensionNoticeHostMessage | ExtensionCallerRevokedMessage | ExtensionCallerUpdatedMessage

export interface ExtensionNoticeRespondFrame {
  type: 'extension:notice:respond'
  extensionId: string
  generation: string
  id: string
  decision: ExtensionNoticeAnswer
}
export type ExtensionNoticeServerFrame =
  | ({ type: 'extension:notice' } & ExtensionNoticeRecord)
  | { type: 'extension:notice:snapshot'; projectId: string; notices: ExtensionNoticeRecord[] }
  | { type: 'extension:notice:resolved'; extensionId: string; generation: string; id: string; decision: ExtensionNoticeDecision }
  | { type: 'extension:notice:response'; extensionId: string; generation: string; id: string; status: ExtensionNoticeResponseStatus }
