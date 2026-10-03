import { useSyncExternalStore } from 'react'
import { createStore, useStore, type StateCreator, type StoreApi } from 'zustand'
import type { ChatMessage, ContentBlock, ToolCallInfo } from '@/shared/types'
import { generateId } from '@/shared/utils'
import { isMainConversationMessage, inferMessageType } from '@/shared/types'

/** How long an EMPTY optimistic streaming placeholder may sit with zero
 *  events before it's treated as abandoned. Normal turns produce something
 *  (stream text / thinking block / tool call) well before this; a placeholder
 *  still empty after 30s almost always means the chat send vanished into a
 *  zombie socket (root cause: .halo/tmp/idle-reconnect-msg-loss.md). */
export const STREAMING_PLACEHOLDER_STALE_MS = 30_000

/** An empty streaming placeholder that has received no event for the stale
 *  window. Shared by the chat-handlers watchdog (which converges these) and
 *  the state-handlers snapshot guard (which must NOT let one of these block
 *  a snapshot replace forever — the R4 amplifier in the RCA). Emptiness
 *  checks contentBlocks too: a thinking-only turn keeps `content === ''`
 *  while blocks stream in, and that's a live turn, not a zombie. */
export function isStaleStreamingPlaceholder(m: ChatMessage, now: number = Date.now()): boolean {
  return !!m.streaming && !m.content && !m.toolCalls?.length && !m.contentBlocks?.length
    && now - m.timestamp > STREAMING_PLACEHOLDER_STALE_MS
}

/** Wall-clock of the most recent WS `_disconnected` edge. Module-level, not
 *  store state — nothing renders from it. The watchdog only converges
 *  placeholders that lived through a link drop; a healthy connection's long
 *  legitimate silences (first-token latency on a big context / provider
 *  backoff, turns queued behind a compact, long tools after reattach) never
 *  see one, so they can't be misdiagnosed as lost. */
let lastLinkDropAt = 0
export function noteLinkDrop(): void {
  lastLinkDropAt = Date.now()
}

/**
 * Identity of a server-pushed system notification, for redelivery dedup.
 *
 * Notifications (`chat:system`, `chat:queued`, `session:compacted`) were the
 * only server-driven message class with NO dedup: each arrival did a plain
 * `addMessage({ id: generateId() })`, so any redelivery of the same logical
 * notification rendered another bubble. The two neighbouring event classes
 * already reconcile — `chat:stream` accumulates into the turn's text block by
 * `turnId`, and `agent:tool_call` drops rows whose `toolUseId` is already
 * present — and the server assigns notifications a fresh `genId()` on both the
 * live push and the persisted `messageLog` row, so ids can never be matched.
 * Content identity is therefore the only available key.
 *
 * Key = notification-ness + taskId scope + exact text. Deliberately NOT
 * time-windowed or count-based: a redelivery carries byte-identical text in
 * the same scope, which is exactly what this collapses.
 *
 * Why this can't eat two genuinely different notifications:
 *  - Compact preflight embeds the live token count ("Compacting context (161K
 *    tokens)…"), and the result line embeds the compacted count
 *    ("Auto-compacted 246 older messages"). Two real compactions of a moving
 *    conversation differ in those numbers (verified against a 3549-message
 *    production log: consecutive real preflights read 161K then 163K).
 *  - Only an ADJACENT run is collapsed (the scan stops at the first
 *    non-notification message). Two identical notifications separated by any
 *    user turn / assistant reply / tool row both survive, so "user triggered
 *    /compact twice" keeps both bubbles — the conversation in between breaks
 *    the run. This is the guard that makes content-keying safe: a redelivery
 *    always lands with no intervening conversation, a genuine repeat does not.
 */
function notificationKey(m: ChatMessage): string | null {
  if (m.role !== 'system') return null
  if (inferMessageType(m) !== 'notification') return null
  return `${m.taskId ?? ''}\u0000${m.content}`
}

/**
 * True when an identical notification already sits at the tail of the log,
 * scanning back only across the current adjacent notification run.
 */
function hasAdjacentDuplicateNotification(messages: ChatMessage[], key: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = notificationKey(messages[i])
    // First non-notification message ends the adjacent run — anything identical
    // beyond it is a legitimate repeat in a later part of the conversation.
    if (candidate === null) return false
    if (candidate === key) return true
  }
  return false
}

/**
 * Incremental hot-path indexes (perf audit P0-2). Every streaming event used
 * to rescan the whole messages array — and toolUseId dedup nested-scanned
 * every tool call of every message — O(session length) per chunk, O(n²)
 * accumulated over a long conversation. These two structures make slot
 * resolution and toolUseId dedup O(1):
 *
 *  - `streamingIdx`: task scope (taskId ?? '') → index of that scope's live
 *    streaming assistant message. A hint, not an oracle: every read
 *    revalidates against the live array and falls back to the original
 *    backwards scan (repairing the entry) on any mismatch.
 *  - `toolUseIdIdx`: toolUseId → index of the message holding that tool
 *    call. Exact by construction — updated on every append, rebuilt on every
 *    wholesale replace — because replay dedup drops events on a bare hit.
 *
 * Per store (one per chat tab), held outside the reactive state since nothing
 * renders from them. They MUST be reset in lockstep with the array they
 * describe — a stale index is worse than a scan. The three log reset points
 * all funnel through two actions: setMessages (snapshot full replace AND
 * reattach-replay rebuild, which is `setMessages(takeReplaySnapshot())` in
 * chat-handlers) rebuilds, and clear() empties. Positions never shift
 * otherwise — messages are appended or element-replaced in place — with one
 * exception: placeAroundStreaming, the only reorder / split path (it mirrors
 * the server's flushCompletedAssistantMessage), which also rebuilds.
 */
interface StoreLocals {
  streamingIdx: Map<string, number>
  toolUseIdIdx: Map<string, number>
  /** Log index where the live round — everything since the last
   *  `chat:complete` — starts (see takeRoundReplies). Everything below it was
   *  loaded wholesale or already handed out, and never moves: the one reorder
   *  path, placeAroundStreaming, works from the root streaming bubble on, and
   *  that bubble always postdates the cursor (complete settles every root
   *  bubble before taking; loaded logs carry none). Reset by the same two
   *  actions as the indexes above. */
  roundStart: number
  /** Most recent `state:snapshot` payload, stashed by state-handlers on EVERY
   *  snapshot — including the ones whose replace was skipped because a stream
   *  was in flight. A reattach replay (`chat:followup` with `replay: true`,
   *  see server ws/handler.ts) declares the server authoritative for the
   *  in-flight turn: the client resets to this settled log and rebuilds the
   *  turn from the replayed events, instead of appending onto its locally-held
   *  partial copy (which duplicated the pre-drop streamed text). */
  lastSnapshot: { sessionId: string; messages: ChatMessage[] } | null
}

function taskKey(taskId?: string): string {
  return taskId ?? ''
}

/** Record one message's index entries (append + rebuild paths). */
function indexMessage(ix: StoreLocals, m: ChatMessage, i: number): void {
  if (m.role === 'assistant' && m.streaming) ix.streamingIdx.set(taskKey(m.taskId), i)
  if (m.toolCalls) {
    for (const tc of m.toolCalls) {
      if (tc.toolUseId) ix.toolUseIdIdx.set(tc.toolUseId, i)
    }
  }
  if (m.contentBlocks) {
    for (const b of m.contentBlocks) {
      if (b.type === 'tool_call' && b.toolCall.toolUseId) ix.toolUseIdIdx.set(b.toolCall.toolUseId, i)
    }
  }
}

/** Rebuild both indexes from a full log — the wholesale-replace reset path. */
function rebuildMessageIndexes(ix: StoreLocals, messages: ChatMessage[]): void {
  ix.streamingIdx.clear()
  ix.toolUseIdIdx.clear()
  for (let i = 0; i < messages.length; i++) {
    indexMessage(ix, messages[i], i)
  }
}

/** Drop streaming-index entries whose message no longer streams — hygiene
 *  after the flag sweeps (complete / converge / send-failed) so the next
 *  event's fast path doesn't start from a dead hint. O(#live scopes). */
function pruneStreamingIdx(ix: StoreLocals, messages: ChatMessage[]): void {
  for (const [key, i] of ix.streamingIdx) {
    const m = messages[i]
    if (!m || m.role !== 'assistant' || !m.streaming || taskKey(m.taskId) !== key) {
      ix.streamingIdx.delete(key)
    }
  }
}

/**
 * Index of the task scope's last streaming assistant message — the target
 * every streaming event mutates. O(1) on a valid hint; original backwards
 * scan (repairing the hint) when the hint is missing or stale.
 */
function findStreamingIdx(ix: StoreLocals, messages: ChatMessage[], taskId?: string): number {
  const key = taskKey(taskId)
  const hint = ix.streamingIdx.get(key)
  if (hint !== undefined) {
    const m = messages[hint]
    if (m && m.role === 'assistant' && m.streaming && m.taskId === taskId) return hint
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.streaming && m.taskId === taskId) {
      ix.streamingIdx.set(key, i)
      return i
    }
  }
  ix.streamingIdx.delete(key)
  return -1
}

/**
 * When a streaming event arrives with a turnId that doesn't match the current
 * streaming assistant's last block, it means a new server turn has begun
 * (e.g. user sent a 2nd message during a narrow window where the server's
 * `complete` event hadn't reached the frontend yet). Finalize the stale
 * streaming assistant and append a fresh one so the new turn's content lands
 * after any user messages added in between — instead of back-appending into
 * the previous bubble and visually displacing the user's question.
 *
 * Returns the slot index alongside the (possibly replaced) array so callers
 * mutate it directly instead of re-scanning; `copied` says whether `messages`
 * is already a fresh array (split/append happened) or still the caller's.
 */
function ensureStreamingSlot(
  ix: StoreLocals,
  messages: ChatMessage[],
  agentName?: string,
  taskId?: string,
  turnId?: string,
): { messages: ChatMessage[]; slotIdx: number; copied: boolean } {
  if (!turnId) return { messages, slotIdx: findStreamingIdx(ix, messages, taskId), copied: false }

  // Match by taskId scope so root and sub-agents are split independently:
  // root events (taskId=undefined) don't fall into sub-agent bubbles, and
  // sub-agent events split per-turn within their OWN bubble. Earlier this
  // function early-returned when `taskId` was truthy, which made every
  // sub-agent turn glomp into one giant bubble (no splits ever happened
  // for sub-agents).
  const i = findStreamingIdx(ix, messages, taskId)
  const msg = i === -1 ? undefined : messages[i]
  // agentName compatibility check from the original scan. The original
  // `continue`d past an incompatible slot looking for an older one, but a
  // scope only ever has one live slot (every creation path converges the
  // previous one first), so the deeper scan could only end at "not found" —
  // appending a fresh slot either way.
  if (msg && !(agentName && msg.agentName && msg.agentName.toLowerCase() !== agentName.toLowerCase())) {
    const blocks = msg.contentBlocks ?? []
    const lastBlockTurnId = blocks.length > 0 ? blocks[blocks.length - 1].turnId : undefined
    if (!lastBlockTurnId || lastBlockTurnId === turnId) return { messages, slotIdx: i, copied: false }

    const next = [...messages]
    next[i] = { ...msg, streaming: false }
    next.push({
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      agentName,
      taskId,
    })
    ix.streamingIdx.set(taskKey(taskId), next.length - 1)
    return { messages: next, slotIdx: next.length - 1, copied: true }
  }
  // No streaming slot found — create one (e.g. message from another channel)
  const next = [...messages, {
    id: generateId(),
    role: 'assistant' as const,
    content: '',
    timestamp: Date.now(),
    streaming: true,
    agentName,
    taskId,
  }]
  ix.streamingIdx.set(taskKey(taskId), next.length - 1)
  return { messages: next, slotIdx: next.length - 1, copied: true }
}

/** content / toolCalls / contentBlocks of a message holding exactly `blocks` —
 *  the three views the streaming actions keep in lockstep. */
function fieldsFromBlocks(blocks: ContentBlock[]): Pick<ChatMessage, 'content' | 'toolCalls' | 'contentBlocks'> {
  let content = ''
  const toolCalls: ToolCallInfo[] = []
  for (const b of blocks) {
    if (b.type === 'text') content += b.text
    else if (b.type === 'tool_call') toolCalls.push(b.toolCall)
  }
  return { content, toolCalls, contentBlocks: blocks }
}

/**
 * Lay out a main user / notification row that arrives while the main bubble S
 * streams, the way the server persists it: before logging such a row,
 * ui-log-builder runs flushCompletedAssistantMessage — S's content up to its
 * first pending tool_call is flushed ABOVE the row, the rest stays in the turn
 * buffer and lands BELOW it. Returns the log the row is appended to (`prefix`)
 * and the live bubble that follows the row (`slot`); null = plain append.
 */
function placeAroundStreaming(
  ix: StoreLocals,
  messages: ChatMessage[],
  message: ChatMessage,
): { prefix: ChatMessage[]; slot: ChatMessage } | null {
  if (message.role === 'assistant' || !isMainConversationMessage(message)) return null
  const i = findStreamingIdx(ix, messages)
  if (i === -1) return null
  const s = messages[i]
  const blocks = s.contentBlocks ?? []
  const firstPending = blocks.findIndex((b) => b.type === 'tool_call' && !b.toolCall.output)
  const nothingCompleted = firstPending === -1 ? !blocks.some((b) => b.type === 'tool_call') : firstPending === 0
  // Server flush is a no-op here (its streamBuffer.trim() gate) — S persists
  // whole below the row, so carry it there.
  if (!s.content.trim() && nothingCompleted) {
    return { prefix: [...messages.slice(0, i), ...messages.slice(i + 1)], slot: s }
  }
  // Split: the completed head settles in place; the pending tail (or a fresh
  // empty slot) keeps streaming below the row.
  const prefix = [...messages]
  prefix[i] = firstPending === -1
    ? { ...s, streaming: false }
    : { ...s, ...fieldsFromBlocks(blocks.slice(0, firstPending)), streaming: false }
  return {
    prefix,
    slot: {
      id: generateId(),
      role: 'assistant',
      timestamp: Date.now(),
      streaming: true,
      agentName: s.agentName,
      ...fieldsFromBlocks(firstPending === -1 ? [] : blocks.slice(firstPending)),
    },
  }
}

export interface ChatStore {
  messages: ChatMessage[]
  isStreaming: boolean
  sessionId: string | null
  pendingMessages: string[]
  /** Token usage from the model (updated via WS events) */
  contextTokens: number
  outputTokens: number
  /** Max context window from agent.yaml (sent by server on subscribe) */
  maxContextTokens: number
  /** Whether a compact operation is in progress */
  isCompacting: boolean
  /** Selected agent for new sessions (default: 'default') */
  selectedAgentId: string
  /** Count of agents selectable for a new chat (set by AgentSelector after it
   *  loads + filters out disabled/internal/overridden). 0 means every agent is
   *  disabled — the composer blocks sending since nothing can answer. -1 = not
   *  yet loaded, treated as "allow" so we never block on first paint. */
  usableAgentCount: number
  /** Access level the next message runs at (input-box selector). Seeded
   *  from the session's snapshot; reset to full on clear (new session). */
  accessLevel: 'full' | 'workspace' | 'readonly'
  /** Host has an OS sandbox (/api/health `sandbox`). false → selector is
   *  locked to full. null = not yet known. */
  sandboxAvailable: boolean | null
  /** Bound source for the "let the AI see something" capture feature — either a
   *  shared screen/window (`kind:'screen'`, grabbed via desktopCapturer) or the
   *  webcam (`kind:'camera'`, grabbed via getUserMedia). Desktop-only, in-memory
   *  (window ids don't survive a restart). When set, use-chat injects a
   *  <<<CAPTURE>>> prompt and chat-handlers grabs a frame when the LLM emits the
   *  marker. Only one bound at a time. null = nothing bound. */
  captureSource: { id: string; name: string; thumb: string; kind: 'screen' | 'camera' } | null

  addMessage(msg: Partial<ChatMessage> & { role: ChatMessage['role']; content: string }): void
  appendThinking(text: string, agentName?: string, taskId?: string, turnId?: string): void
  updateLastAssistant(text: string, agentName?: string, taskId?: string, turnId?: string): void
  addToolCallToLastAssistant(toolCall: ToolCallInfo, agentName?: string, taskId?: string, turnId?: string): void
  updateLastToolCallResult(result: string, agentName?: string, taskId?: string, toolUseId?: string): void
  completeStreaming(): void
  /** `batchBoundary`: a queued turn follows on the server — close the bubbles
   *  but don't report a settled turn (no finish chime between drained turns). */
  completeAgentStreaming(agentName?: string, taskId?: string, batchBoundary?: boolean): void
  /** The live round's main assistant bubbles in log order, each returned
   *  once — chat-handlers acts on their SHOW / CAPTURE markers at
   *  `chat:complete`. A round spans several bubbles (the head an interjection
   *  split off, a turnId split, the follow-up answering a queued message), so
   *  scanning only the last one missed the rest. */
  takeRoundReplies(): ChatMessage[]
  /** Stash the latest `state:snapshot` log (see StoreLocals.lastSnapshot). */
  noteSnapshot(sessionId: string, messages: ChatMessage[]): void
  /** Settled log for a replay rebuild — only if the stash belongs to the
   *  session this store is on (guards a late replay racing a session change). */
  takeReplaySnapshot(): ChatMessage[] | null
  /** The server re-routed this send to another session (`session:switched`
   *  with clientMsgId) — drop the optimistic user bubble and the empty
   *  placeholder right after it, so this tab doesn't spin over a message
   *  that landed elsewhere. */
  dropOptimisticSend(clientMsgId: string): void
  setSessionId(id: string): void
  setMessages(messages: ChatMessage[]): void
  setTokenUsage(context: number, output: number): void
  setMaxContextTokens(max: number): void
  setCompacting(v: boolean): void
  setSelectedAgentId(id: string): void
  setUsableAgentCount(n: number): void
  setAccessLevel(level: 'full' | 'workspace' | 'readonly'): void
  setSandboxAvailable(v: boolean): void
  setCaptureSource(source: { id: string; name: string; thumb: string; kind: 'screen' | 'camera' } | null): void
  addPendingMessage(text: string): void
  removePendingMessage(index: number): void
  shiftPendingMessage(): string | undefined
  /** ws-client exhausted the chat ack retries — mark the user bubble red and
   *  converge its (empty) streaming placeholder so "Thinking…" doesn't spin
   *  forever over a message the server never received. */
  markChatSendFailed(clientMsgId: string): void
  /** Watchdog sweep: converge empty streaming placeholders that have gone
   *  STREAMING_PLACEHOLDER_STALE_MS with zero events (see chat-handlers). */
  convergeStaleStreaming(): void
  clear(): void
}

export type ChatStoreApi = StoreApi<ChatStore>

/** App-wide values every tab's store mirrors — not per session: the agent
 *  picker's usable count, host sandbox capability, the bound capture source.
 *  Setters fan out to every live store; new stores start from here. */
type SharedFields = Pick<ChatStore, 'usableAgentCount' | 'sandboxAvailable' | 'captureSource'>
const shared: SharedFields = { usableAgentCount: -1, sandboxAvailable: null, captureSource: null }

/** Every store not yet disposed — one per loaded chat tab. */
const liveStores = new Set<ChatStoreApi>()

function setShared(patch: Partial<SharedFields>): void {
  Object.assign(shared, patch)
  for (const s of liveStores) s.setState(patch)
}

/** `settled` = completeAgentStreaming just took a root turn busy → idle
 *  (see onTurnSettled). */
const chatStoreState = (ix: StoreLocals, settled: () => void): StateCreator<ChatStore> => (set, get) => ({
  messages: [],
  isStreaming: false,
  sessionId: null,
  pendingMessages: [],
  contextTokens: 0,
  outputTokens: 0,
  // 0 = unknown — we wait for the server's `state:snapshot` event to hand
  // back the agent.yaml-resolved maxTokens before rendering the ring. Using
  // a hard-coded 200K placeholder here made the ring flash with the wrong
  // ratio for ~half a second on every session load (e.g. an agent capped at
  // 20K showed 2.5% full for a moment, then snapped to 25%).
  maxContextTokens: 0,
  isCompacting: false,
  selectedAgentId: 'default',
  accessLevel: 'full',
  ...shared,

  addMessage(msg) {
    const message: ChatMessage = {
      id: msg.id ?? generateId(),
      type: msg.type,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp ?? Date.now(),
      streaming: msg.streaming,
      agentName: msg.agentName,
      taskId: msg.taskId,
      contentBlocks: msg.contentBlocks,
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolOutput: msg.toolOutput,
      systemPrompt: msg.systemPrompt,
      usage: msg.usage,
      turnId: msg.turnId,
      modelId: msg.modelId,
      durationMs: msg.durationMs,
      localImages: msg.localImages,
      clientMsgId: msg.clientMsgId,
    }
    set((state) => {
      const placed = placeAroundStreaming(ix, state.messages, message)
      // Redelivery guard for server-pushed notifications — the only message
      // class that used to append unconditionally (see notificationKey).
      // Scanned against the log the row actually follows, so a streaming
      // bubble carried below it can't shield a redelivery.
      const key = notificationKey(message)
      if (key !== null && hasAdjacentDuplicateNotification(placed?.prefix ?? state.messages, key)) {
        return state
      }
      // Filter inlined into the call so prod builds (compiler.removeConsole)
      // drop the whole O(n) evaluation along with the console.debug.
      console.debug(`[ChatStore:addMessage] role=${message.role} type=${message.type ?? '-'} streaming=${!!message.streaming} taskId=${message.taskId ?? '-'} main=${state.messages.filter(isMainConversationMessage).length}+${isMainConversationMessage(message) ? 1 : 0}`)
      let messages: ChatMessage[]
      if (placed) {
        messages = [...placed.prefix, message, placed.slot]
        rebuildMessageIndexes(ix, messages)
      } else {
        indexMessage(ix, message, state.messages.length)
        messages = [...state.messages, message]
      }
      return {
        messages,
        isStreaming: (msg.streaming && !msg.taskId) ? true : state.isStreaming,
      }
    })
  },

  appendThinking(text: string, agentName?: string, taskId?: string, turnId?: string) {
    set((state) => {
      const slot = ensureStreamingSlot(ix, state.messages, agentName, taskId, turnId)
      if (slot.slotIdx === -1) return state
      // Only the slot element is replaced — prefix references are reused, so
      // memoized rows upstream keep reference equality.
      const messages = slot.copied ? slot.messages : [...slot.messages]
      const msg = messages[slot.slotIdx]
      const blocks = [...(msg.contentBlocks ?? [])]
      const lastBlock = blocks[blocks.length - 1]
      if (lastBlock && lastBlock.type === 'thinking' && (!turnId || lastBlock.turnId === turnId)) {
        blocks[blocks.length - 1] = { type: 'thinking', text: lastBlock.text + text, turnId: turnId ?? lastBlock.turnId }
      } else {
        blocks.push({ type: 'thinking', text, turnId })
      }
      messages[slot.slotIdx] = { ...msg, contentBlocks: blocks }
      return { messages }
    })
  },

  updateLastAssistant(text: string, agentName?: string, taskId?: string, turnId?: string) {
    set((state) => {
      const slot = ensureStreamingSlot(ix, state.messages, agentName, taskId, turnId)
      if (slot.slotIdx === -1) return state
      const messages = slot.copied ? slot.messages : [...slot.messages]
      const msg = messages[slot.slotIdx]

      // Update contentBlocks: append to last text block (same turnId), or create new one
      const blocks = [...(msg.contentBlocks ?? [])]
      const lastBlock = blocks[blocks.length - 1]
      if (lastBlock && lastBlock.type === 'text' && (!turnId || lastBlock.turnId === turnId)) {
        blocks[blocks.length - 1] = { type: 'text', text: lastBlock.text + text, turnId: turnId ?? lastBlock.turnId }
      } else {
        blocks.push({ type: 'text', text, turnId })
      }

      messages[slot.slotIdx] = {
        ...msg,
        content: msg.content + text,
        contentBlocks: blocks,
      }
      return !taskId ? { messages, isStreaming: true } : { messages }
    })
  },

  addToolCallToLastAssistant(toolCall: ToolCallInfo, agentName?: string, taskId?: string, turnId?: string) {
    set((state) => {
      // Reattach replay dedup: after a mid-turn WS reconnect the server
      // re-sends the in-flight turn's tool_calls (ws/handler.ts synthesis).
      // If a row with the same toolUseId is already rendered — from the
      // snapshot or the pre-drop stream — drop the duplicate. O(1) via the
      // toolUseId index (rebuilt on every wholesale replace, so a hit is
      // always a live row, never a ghost of a dropped log).
      if (toolCall.toolUseId && ix.toolUseIdIdx.has(toolCall.toolUseId)) {
        return state
      }
      const slot = ensureStreamingSlot(ix, state.messages, agentName, taskId, turnId)
      if (slot.slotIdx === -1) return state
      const messages = slot.copied ? slot.messages : [...slot.messages]
      const msg = messages[slot.slotIdx]

      const blocks = [...(msg.contentBlocks ?? [])]
      blocks.push({ type: 'tool_call', toolCall, turnId })

      messages[slot.slotIdx] = {
        ...msg,
        toolCalls: [...(msg.toolCalls ?? []), toolCall],
        contentBlocks: blocks,
      }
      if (toolCall.toolUseId) ix.toolUseIdIdx.set(toolCall.toolUseId, slot.slotIdx)
      return { messages }
    })
  },

  updateLastToolCallResult(result: string, agentName?: string, taskId?: string, toolUseId?: string) {
    set((state) => {
      // Identity path: pair by toolUseId when the server sent one. The id is
      // provider-unique and the index points straight at the owning message —
      // after a reattach that may be a non-streaming snapshot message. Never
      // overwrite a completed entry: replayed results stay idempotent.
      if (toolUseId) {
        const i = ix.toolUseIdIdx.get(toolUseId) ?? -1
        const msg = i === -1 ? undefined : state.messages[i]
        const callIdx = msg?.toolCalls?.findIndex((tc) => tc.toolUseId === toolUseId) ?? -1
        const blockIdx = msg?.contentBlocks?.findIndex((b) => b.type === 'tool_call' && b.toolCall.toolUseId === toolUseId) ?? -1
        if (msg && (callIdx !== -1 || blockIdx !== -1)) {
          const alreadyDone = (callIdx !== -1 && msg.toolCalls![callIdx].output !== undefined)
            || (blockIdx !== -1 && (msg.contentBlocks![blockIdx] as { toolCall: ToolCallInfo }).toolCall.output !== undefined)
          if (alreadyDone) return state

          const toolCalls = msg.toolCalls ? [...msg.toolCalls] : msg.toolCalls
          if (toolCalls && callIdx !== -1) {
            toolCalls[callIdx] = { ...toolCalls[callIdx], output: result }
          }
          const blocks = msg.contentBlocks ? [...msg.contentBlocks] : msg.contentBlocks
          if (blocks && blockIdx !== -1) {
            const block = blocks[blockIdx] as { type: 'tool_call'; toolCall: ToolCallInfo; turnId?: string }
            blocks[blockIdx] = { type: 'tool_call', toolCall: { ...block.toolCall, output: result }, turnId: block.turnId }
          }
          const messages = [...state.messages]
          messages[i] = { ...msg, toolCalls, contentBlocks: blocks }
          return { messages }
        }
        // id present but its tool_call row never rendered (lost WS frame) —
        // fall through to the first-pending scan below.
      }

      // Fallback (no toolUseId — e.g. old persisted sessions replayed through
      // ui-log-builder): attach to the FIRST pending entry. Results arrive in
      // call order (agent-loop executes tool_use blocks serially), so
      // first-pending is the one this result belongs to; the old last-entry
      // overwrite cross-matched outputs on parallel-tool-call turns (same bug
      // the server fixed in ui-log-builder setToolResult). Never overwrite a
      // completed entry.
      const i = findStreamingIdx(ix, state.messages, taskId)
      const msg = i === -1 ? undefined : state.messages[i]
      if (!msg || !msg.toolCalls?.length) return state

      // Update first pending in toolCalls array
      const toolCalls = [...msg.toolCalls]
      const pendingIdx = toolCalls.findIndex((tc) => tc.output === undefined)
      if (pendingIdx !== -1) {
        toolCalls[pendingIdx] = { ...toolCalls[pendingIdx], output: result }
      }

      // Also update in contentBlocks. Preserve `turnId` on the block —
      // dropping it caused ensureStreamingSlot to see a stale "lastBlock
      // turnId=undef" later and reuse this assistant message for blocks
      // belonging to subsequent turns, collapsing 12 separate turns into
      // one giant message bubble in the live UI.
      const blocks = [...(msg.contentBlocks ?? [])]
      for (let j = 0; j < blocks.length; j++) {
        const block = blocks[j]
        if (block.type === 'tool_call' && block.toolCall.output === undefined) {
          blocks[j] = { type: 'tool_call', toolCall: { ...block.toolCall, output: result }, turnId: block.turnId }
          break
        }
      }

      const messages = [...state.messages]
      messages[i] = { ...msg, toolCalls, contentBlocks: blocks }
      return { messages }
    })
  },

  completeStreaming() {
    set((state) => {
      const messages = state.messages.map((msg) =>
        msg.streaming ? { ...msg, streaming: false } : msg,
      )
      pruneStreamingIdx(ix, messages)
      return { messages, isStreaming: false }
    })
  },

  completeAgentStreaming(agentName?: string, taskId?: string, batchBoundary?: boolean) {
    const wasStreaming = get().isStreaming
    set((state) => {
      const before = state.messages.filter(isMainConversationMessage).length
      const messages = state.messages.map((msg) => {
        if (!msg.streaming) return msg
        if (taskId && msg.taskId === taskId) return { ...msg, streaming: false }
        if (!taskId && !msg.taskId) return { ...msg, streaming: false }
        return msg
      })
      const after = messages.filter(isMainConversationMessage).length
      const stillStreaming = messages.some((m) => m.streaming && !m.taskId)
      if (before !== after) {
        console.warn(`[ChatStore:completeAgentStreaming] main msgs changed ${before} -> ${after}, agentName=${agentName}, taskId=${taskId}`)
      }
      pruneStreamingIdx(ix, messages)
      return { messages, isStreaming: stillStreaming }
    })
    if (wasStreaming && !get().isStreaming && !batchBoundary) settled()
  },

  takeRoundReplies() {
    const { messages } = get()
    const replies = messages.slice(ix.roundStart).filter((m) => m.role === 'assistant' && !m.taskId)
    ix.roundStart = messages.length
    return replies
  },

  noteSnapshot(sessionId: string, messages: ChatMessage[]) {
    ix.lastSnapshot = { sessionId, messages }
  },

  takeReplaySnapshot() {
    const sessionId = get().sessionId
    return ix.lastSnapshot && sessionId && ix.lastSnapshot.sessionId === sessionId
      ? ix.lastSnapshot.messages
      : null
  },

  dropOptimisticSend(clientMsgId: string) {
    const { messages } = get()
    const idx = messages.findIndex((m) => m.clientMsgId === clientMsgId)
    if (idx === -1) return
    const next = messages.filter((m, i) => i !== idx
      && !(i > idx && m.streaming && !m.taskId && !m.content && !m.toolCalls?.length && !m.contentBlocks?.length))
    rebuildMessageIndexes(ix, next)
    ix.roundStart = Math.min(ix.roundStart, next.length)
    set({ messages: next, isStreaming: next.some((m) => m.streaming && !m.taskId) })
  },

  setSessionId(id: string) {
    set({ sessionId: id })
  },

  setMessages(messages: ChatMessage[]) {
    // Wholesale replace — every position may have changed, so the hot-path
    // indexes must be rebuilt in lockstep (snapshot restore and the
    // reattach-replay rebuild both land here).
    rebuildMessageIndexes(ix, messages)
    // A loaded log is history — its markers must never fire.
    ix.roundStart = messages.length
    set({ messages })
  },

  setTokenUsage(context: number, output: number) {
    set({ contextTokens: context, outputTokens: output })
  },

  setMaxContextTokens(max: number) {
    if (max > 0) set({ maxContextTokens: max })
  },

  setCompacting(v: boolean) {
    set({ isCompacting: v })
  },

  setSelectedAgentId(id: string) {
    set({ selectedAgentId: id })
  },

  setUsableAgentCount(n: number) {
    setShared({ usableAgentCount: n })
  },

  setAccessLevel(level) {
    set({ accessLevel: level })
  },

  setSandboxAvailable(v) {
    setShared({ sandboxAvailable: v })
  },

  setCaptureSource(source) {
    setShared({ captureSource: source })
  },

  addPendingMessage(text: string) {
    set((state) => ({ pendingMessages: [...state.pendingMessages, text] }))
  },

  removePendingMessage(index: number) {
    set((state) => ({ pendingMessages: state.pendingMessages.filter((_, i) => i !== index) }))
  },

  shiftPendingMessage(): string | undefined {
    const current = get().pendingMessages
    if (current.length === 0) return undefined
    const [first, ...rest] = current
    set({ pendingMessages: rest })
    return first
  },

  markChatSendFailed(clientMsgId: string) {
    set((state) => {
      const idx = state.messages.findIndex((m) => m.clientMsgId === clientMsgId)
      if (idx === -1) return state
      const messages = state.messages.map((m, i) => {
        if (i === idx) return { ...m, sendFailed: true }
        // Converge the empty assistant placeholder that followed this send —
        // only an EMPTY one (a turn that produced output got its content from
        // some other, delivered message and will settle via normal events).
        if (i > idx && m.streaming && !m.taskId && !m.content && !m.toolCalls?.length && !m.contentBlocks?.length) {
          return { ...m, streaming: false, interrupted: true }
        }
        return m
      })
      pruneStreamingIdx(ix, messages)
      return { messages, isStreaming: messages.some((m) => m.streaming && !m.taskId) }
    })
  },

  convergeStaleStreaming() {
    // Only converge placeholders that lived through a link drop — created
    // before the last `_disconnected` and still empty past the stale window.
    // A placeholder on an unbroken connection is just a slow turn (first
    // token pending, queued behind other work); calling it interrupted would
    // invite the user to resend and duplicate the run. And while a compact
    // is in flight, queued turns legitimately sit empty for minutes — skip.
    if (get().isCompacting || lastLinkDropAt === 0) return
    const now = Date.now()
    const lost = (m: ChatMessage) =>
      m.timestamp <= lastLinkDropAt && isStaleStreamingPlaceholder(m, now)
    if (!get().messages.some(lost)) return
    set((state) => {
      const messages = state.messages.map((m) =>
        lost(m) ? { ...m, streaming: false, interrupted: true } : m,
      )
      pruneStreamingIdx(ix, messages)
      return { messages, isStreaming: messages.some((m) => m.streaming && !m.taskId) }
    })
  },

  clear() {
    // Preserve selectedAgentId — once the user picked an agent (or it was
    // promoted from priority), the next "new session" should still use it.
    // Resetting it back to 'default' here would override that choice every
    // time the chat is cleared.
    // Keep maxContextTokens: it's the agent's context capacity, only ever
    // supplied by `state:snapshot` (sent on WS subscribe — which does NOT
    // re-fire on /new or a session switch). Zeroing it here tripped the
    // TokenRing's `maxTokens === 0` guard, so after sending in a fresh session
    // the ring stayed hidden until a resubscribe (i.e. switching sessions)
    // refilled it. Keeping the last-known limit lets the ring light up as soon
    // as the first usage event lands — the "ring only shows after I switch
    // sessions" bug.
    rebuildMessageIndexes(ix, [])
    ix.roundStart = 0
    ix.lastSnapshot = null
    set({ messages: [], isStreaming: false, pendingMessages: [], sessionId: null, contextTokens: 0, outputTokens: 0, accessLevel: 'full' })
  },
})

const turnSettledListeners = new Set<(store: ChatStoreApi) => void>()

/** A live store's root turn finished: a completion action (chat:complete /
 *  chat:stopped / error / followup → completeAgentStreaming) took
 *  isStreaming true → false, and it is still false once the frame's handler
 *  returns — a followup re-opens the stream in the same handler, hence the
 *  microtask. Log replaces (snapshot, reattach replay), send failures, the
 *  stale-placeholder sweep, a batch-boundary complete (more queued turns
 *  follow) and a disposed / released store never fire.
 *  Feeds the finish chime (workspace-layout). */
export function onTurnSettled(listener: (store: ChatStoreApi) => void): () => void {
  turnSettledListeners.add(listener)
  return () => { turnSettledListeners.delete(listener) }
}

/** A fresh per-tab store (see chat-tabs). Live until disposeChatStore. */
export function createChatStore(): ChatStoreApi {
  const ix: StoreLocals = { streamingIdx: new Map(), toolUseIdIdx: new Map(), roundStart: 0, lastSnapshot: null }
  const store: ChatStoreApi = createStore<ChatStore>()(chatStoreState(ix, () => queueMicrotask(() => {
    if (!liveStores.has(store) || store.getState().isStreaming) return
    for (const l of turnSettledListeners) l(store)
  })))
  liveStores.add(store)
  return store
}

/** Drop a closed tab's store from the shared-field fan-out and sweeps. */
export function disposeChatStore(store: ChatStoreApi): void {
  liveStores.delete(store)
}

/** Every live store — for connection-level sweeps (watchdog, send-failed). */
export function forEachChatStore(fn: (store: ChatStoreApi) => void): void {
  for (const s of liveStores) fn(s)
}

/** The store of the chat tab on screen. Starts as a standalone store so the
 *  module works before (and without) chat-tabs adopting it as its first tab. */
let activeStore = createChatStore()
const activeListeners = new Set<() => void>()

export function getActiveChatStore(): ChatStoreApi {
  return activeStore
}

export function setActiveChatStore(store: ChatStoreApi): void {
  if (store === activeStore) return
  activeStore = store
  for (const l of activeListeners) l()
}

function subscribeActiveChatStore(listener: () => void): () => void {
  activeListeners.add(listener)
  return () => { activeListeners.delete(listener) }
}

function useChatStoreHook<U>(selector: (state: ChatStore) => U): U {
  const store = useSyncExternalStore(subscribeActiveChatStore, getActiveChatStore, getActiveChatStore)
  return useStore(store, selector)
}

/** The active tab's store, in the shape of a bound zustand hook: selectors
 *  re-subscribe when the active tab changes; getState / setState act on
 *  whichever tab is active at call time. */
export const useChatStore = Object.assign(useChatStoreHook, {
  getState: (): ChatStore => activeStore.getState(),
  setState: ((...args: Parameters<ChatStoreApi['setState']>) => activeStore.setState(...args)) as ChatStoreApi['setState'],
})
