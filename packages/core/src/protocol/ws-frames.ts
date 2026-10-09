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
 * Doc: .halo/docs/design/ws.md
 */
import type { SessionMessage } from './session-message.js'
import type { ExtensionsSnapshot } from './extension-types.js'

// ── Client → Server ──────────────────────────────────────────────────

export interface WsClientMessage {
  /** `__ping__` is the app-level liveness probe (answered with `__pong__`);
   *  the rest are routed by handler.ts's top-level `switch (msg.type)`. */
  type: '__ping__' | 'chat' | 'chat:stop' | 'chat:interrupt' | 'subscribe' | 'unsubscribe' | `command:${string}` | 'session:delete' | 'exchange:delete' | 'terminal:start' | 'terminal:input' | 'terminal:resize' | 'terminal:close' | 'terminal:reattach'
  /** The session the frame acts on — chat:stop / chat:interrupt / command:*
   *  included, so every open chat tab addresses its own session. `subscribe`
   *  ADDS that session to the connection's set (one connection carries every
   *  open tab; re-subscribing an already-subscribed id only re-sends its
   *  snapshot) and `unsubscribe` removes it — releasing the listener only,
   *  the agent keeps running. `null` is what the admin sends on chat:stop /
   *  chat:interrupt before any session is bound (its store's id is
   *  nullable) — nothing to act on. A chat:stop / chat:interrupt /
   *  command:* / session:delete with the field ABSENT acts on the
   *  connection's sole subscription (the one-session-per-connection form);
   *  with several subscriptions it has no target. */
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
  /** chat — access level picked in the admin input box. Applied only when
   *  the session is idle (a queued message runs at the level already set);
   *  forced to 'full' when the host has no OS sandbox. */
  accessLevel?: 'full' | 'workspace' | 'readonly'
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
  /** The session's current access level (null/absent = full) — seeds the
   *  admin's selector on subscribe / reattach / new-session. */
  accessLevel?: 'full' | 'workspace' | 'readonly' | null
}

/** Per-call usage attached to a root-scope `chat:usage` (event-processor only;
 *  the reattach snapshot's usage frame carries just the two token counters). */
export type WsUsageData = NonNullable<SessionMessage['usage']>

export type WsServerMessage =
  // liveness
  | { type: '__pong__' }
  // chat lifecycle
  | { type: 'chat:ack'; clientMsgId: string }
  | { type: 'chat:queued'; reason: 'compact'; message: string; sessionId?: string | null }
  | { type: 'chat:stopped'; sessionId: string | null }
  | { type: 'chat:complete'; sessionId: string | null; batchBoundary?: boolean }
  // Session-scoped frames carry `sessionId` (the session the listener or
  // request belongs to): one connection carries every open chat tab, and the
  // admin routes each frame to that session's tab by this id. A frame without
  // one (connection-level sends) goes to the active tab.
  | { type: 'chat:followup'; agentName: string; replay?: boolean; sessionId?: string | null }
  | { type: 'chat:thinking'; text: string; agentName: string; taskId?: string; turnId?: string; replay?: boolean; sessionId?: string | null }
  | { type: 'chat:stream'; text: string; agentName: string; taskId?: string; turnId?: string; replay?: boolean; sessionId?: string | null }
  | { type: 'chat:system'; text: string; taskId?: string; agentName?: string; sessionId?: string | null }
  | { type: 'chat:user'; text: string; sessionId?: string | null }
  | { type: 'chat:usage'; contextTokens: number; outputTokens: number; turnId?: string; modelId?: string; usage?: WsUsageData; sessionId?: string | null }
  // sub-agent / tool events
  | { type: 'agent:start'; agentName: string; task?: string; taskId?: string; sessionId?: string | null }
  | { type: 'agent:done'; agentName: string; taskId?: string; sessionId?: string | null }
  | { type: 'agent:context'; agentName: string; systemPrompt?: string; taskId?: string; sessionId?: string | null }
  | { type: 'agent:tool_call'; tool?: string; toolUseId?: string; input?: unknown; agentName: string; taskId?: string; turnId?: string; replay?: boolean; sessionId?: string | null }
  | { type: 'agent:tool_result'; result?: string; toolUseId?: string; agentName: string; taskId?: string; durationMs?: number; replay?: boolean; sessionId?: string | null }
  // errors — `code` marks an expected refusal phrased for the user (e.g.
  // `archived` from exchange:delete); `terminalId` scopes terminal failures
  | { type: 'error'; error?: string; code?: 'archived'; agentName?: string; taskId?: string; terminalId?: string; sessionId?: string | null }
  // session state
  | { type: 'state:snapshot'; snapshot: WsStateSnapshot }
  | { type: 'session:deleted'; sessionId: string }
  // A command (`switchTo`) or a goal-mode divert moved the conversation to
  // `sessionId`; the server has already added it to the connection's set.
  // `fromSessionId` is the session the request was sent from (its tab stays
  // open); `clientMsgId` is set on a divert — that chat landed in the target
  // session, so the source tab drops its optimistic copy.
  | { type: 'session:switched'; sessionId: string; fromSessionId?: string; clientMsgId?: string }
  | { type: 'session:compacted'; message?: string; contextTokens: number; sessionId?: string | null }
  | { type: 'session:changed' }
  // One frame per released session — a reclaim releases every listener the
  // connection held.
  | { type: 'listener:released'; sessionId: string }
  // compaction progress (manual /compact onProgress + auto-compact co-emit)
  | { type: 'compact:started'; sessionId?: string | null }
  | { type: 'compact:summarizing'; sessionId?: string | null }
  | { type: 'compact:done'; sessionId?: string | null }
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
  // ~/.halo/global/extensions/ changed (install / upgrade / uninstall) — full snapshot, not a diff
  | ({ type: 'extension:changed' } & ExtensionsSnapshot)
  // ~/.halo/global/models.d/ changed (hub provider configs installed / removed) — re-fetch /agent-configs/models
  | { type: 'models:changed' }

export type WsServerMessageType = WsServerMessage['type']

/** The frame for one server message type, e.g. `WsFrame<'chat:usage'>`. */
export type WsFrame<T extends WsServerMessageType> = Extract<WsServerMessage, { type: T }>
