/**
 * Admin WebSocket protocol — every frame that crosses the `/ws` socket between
 * the halo server (packages/server/src/ws/*, broadcast callers) and the admin
 * (packages/admin/src/shared/ws-client.ts + ws-handlers).
 *
 * These types DESCRIBE what producers already send; they never widen or rename
 * a wire field. Where two producers of the same `type` disagree on a field's
 * presence (live event-processor vs. handler.ts reattach replay, or several
 * broadcast call sites), the member is the superset with the field optional.
 *
 * Not covered: the AgentCore `/ws` adapter (routes/agentcore.ts) speaks its own
 * `stream` / `thinking` / `history` / … frames and is not part of this union.
 * Doc: .halo/docs/design/ws.md
 */
import type { SessionMessage } from './session-message.js'

// ── Client → Server ──────────────────────────────────────────────────

export interface WsClientMessage {
  /** `__ping__` is the app-level liveness probe (answered with `__pong__`);
   *  the rest are routed by handler.ts's top-level `switch (msg.type)`. */
  type: '__ping__' | 'chat' | 'chat:stop' | 'chat:interrupt' | 'subscribe' | `command:${string}` | 'session:clear' | 'session:delete' | 'exchange:delete' | 'terminal:start' | 'terminal:input' | 'terminal:resize' | 'terminal:close' | 'terminal:reattach'
  /** `null` is what the admin sends on chat:stop / chat:interrupt before any
   *  session is bound (its store's id is nullable); the server treats it
   *  like absent. */
  sessionId?: string | null
  projectId?: string
  message?: string
  /** exchange:delete — 0-based index of the target user turn among all
   *  role==='user' messages in the session's UI log. */
  userOrdinal?: number
  /** exchange:delete — archived-segment count the client's view was opened
   *  against (its archive anchor); the server refuses when it differs from
   *  the on-disk count, i.e. the ordinal was computed over a stale log start. */
  archiveCount?: number
  images?: Array<{ data: string; mimeType: string }>
  agentName?: string
  agentId?: string
  config?: { systemPrompt?: string; model?: string }
  data?: string
  cols?: number
  rows?: number
  cwd?: string
  terminalId?: string
  /** Workspace path the terminal belongs to. Used by terminal:start and
   *  terminal:reattach so PTYs are scoped per-workspace and tabs in
   *  different workspaces don't steal each other's terminals on reconnect. */
  workspacePath?: string
  /** Stable per-browser UUID (admin's localStorage). Combined with
   *  workspacePath as the PTY ownership key — terminals from one browser
   *  are invisible to another. */
  browserId?: string
  /** Client-generated id for `chat` messages. The client resends a chat over
   *  a fresh connection when the ack doesn't arrive (zombie-socket recovery,
   *  see admin ws-client.ts), so the server acks with this id after folding
   *  the message into the session log, and dedupes resends by it. */
  clientMsgId?: string
}

// ── Server → Client ──────────────────────────────────────────────────

/** Payload of `state:snapshot` — sent on subscribe / reattach / new-session. */
export interface WsStateSnapshot {
  recentMessages: SessionMessage[]
  /** Legacy key: no current producer sends it; the admin still reads
   *  `recentMessages ?? messages`. */
  messages?: SessionMessage[]
  sessionId?: string | null
  maxContextTokens?: number
  agentId?: string
  /** Archived-segment count at snapshot time — only the subscribe / reattach
   *  snapshots carry it; per-turn snapshots omit it. */
  archiveCount?: number
}

/** Per-call usage attached to a root-scope `chat:usage` (event-processor only;
 *  the reattach snapshot's usage frame carries just the two token counters). */
export type WsUsageData = NonNullable<SessionMessage['usage']>

export type WsServerMessage =
  // liveness
  | { type: '__pong__' }
  // chat lifecycle
  | { type: 'chat:ack'; clientMsgId: string }
  | { type: 'chat:queued'; reason: 'compact'; message: string }
  | { type: 'chat:stopped'; sessionId: string | null }
  | { type: 'chat:complete'; sessionId: string | null }
  | { type: 'chat:followup'; agentName: string; replay?: boolean }
  | { type: 'chat:thinking'; text: string; agentName: string; taskId?: string; turnId?: string; replay?: boolean }
  | { type: 'chat:stream'; text: string; agentName: string; taskId?: string; turnId?: string; replay?: boolean }
  | { type: 'chat:system'; text: string; taskId?: string; agentName?: string }
  | { type: 'chat:user'; text: string }
  | { type: 'chat:usage'; contextTokens: number; outputTokens: number; turnId?: string; modelId?: string; usage?: WsUsageData }
  // sub-agent / tool events
  | { type: 'agent:start'; agentName: string; task?: string; taskId?: string }
  | { type: 'agent:done'; agentName: string; taskId?: string }
  | { type: 'agent:context'; agentName: string; systemPrompt?: string; taskId?: string }
  | { type: 'agent:tool_call'; tool?: string; toolUseId?: string; input?: unknown; agentName: string; taskId?: string; turnId?: string; replay?: boolean }
  | { type: 'agent:tool_result'; result?: string; toolUseId?: string; agentName: string; taskId?: string; durationMs?: number; replay?: boolean }
  // errors — `code` marks an expected refusal phrased for the user (e.g.
  // `archived` from exchange:delete); `terminalId` scopes terminal failures
  | { type: 'error'; error?: string; code?: 'archived'; agentName?: string; taskId?: string; terminalId?: string }
  // session state
  | { type: 'state:snapshot'; snapshot: WsStateSnapshot }
  | { type: 'session:cleared' }
  | { type: 'session:deleted'; sessionId: string }
  | { type: 'session:switched'; sessionId: string }
  | { type: 'session:compacted'; message?: string; contextTokens: number }
  | { type: 'session:changed' }
  | { type: 'listener:released'; sessionId: string | null }
  // compaction progress (manual /compact onProgress + auto-compact co-emit)
  | { type: 'compact:started' }
  | { type: 'compact:summarizing' }
  | { type: 'compact:done' }
  // terminal
  | { type: 'terminal:ready'; terminalId: string }
  | { type: 'terminal:output'; data: string; terminalId: string }
  | { type: 'terminal:exit'; exitCode: number; terminalId: string }
  | { type: 'terminal:reattached'; terminalIds: string[] }
  // workspace file watcher (+ git ops, which report as path '.git')
  | { type: 'file:changed'; path: string; action: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' }
  // server-global broadcasts
  | { type: 'goal:changed'; goalSessionId: string; workerSessionId: string; status: 'intake' | 'running' | 'paused' | 'halted' | 'done' | 'cleared'; round: number; maxRounds: number }
  | { type: 'cron:run_changed'; jobId: string; runId: string; status: string }
  | { type: 'cron:job_changed'; jobId: string; kind?: string; lastRunStatus?: string; lastRunAt?: number }
  | { type: 'evolution:run_changed'; id: string; status?: string; kind?: 'deleted' }
  | { type: 'evolution:apply_changed'; id: string; status?: string; kind?: 'deleted' }

export type WsServerMessageType = WsServerMessage['type']

/** The frame for one server message type, e.g. `WsFrame<'chat:usage'>`. */
export type WsFrame<T extends WsServerMessageType> = Extract<WsServerMessage, { type: T }>
