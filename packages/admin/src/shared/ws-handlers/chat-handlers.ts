import type { WsClient } from '../ws-client-types'
import { useChatStore, noteLinkDrop } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { generateId } from '@/shared/utils'
import { postToFace } from '@/features/editor/face-bridge'

/** Marker the LLM emits to request a screenshot of the user's bound window.
 *  Injected as an instruction by use-chat when a capture source is bound.
 *  Detected here on turn completion → grab a frame → send it back as an image
 *  message. The trailing-newline tolerance keeps it robust if the model wraps
 *  it on its own line. */
const CAPTURE_MARKER = /<<<CAPTURE>>>/

/** Marker the LLM emits to drive its visual "face" (see `self` skill +
 *  `.halo/canvas/self.html`). The payload between the markers is a line of
 *  face JS, forwarded VERBATIM to the open preview — Halo never parses it.
 *  Non-greedy dot-all because payloads legitimately contain `>`, `(`, and
 *  newlines (e.g. `self.play([{...}])`). Global: a reply may carry several. */
const SHOW_MARKER = /<<<SHOW:([\s\S]*?)>>>/g

/** Ids of assistant messages we've already acted on, so the duplicate
 *  `chat:complete` events emitted when a message queue drains (server sends
 *  one per drained turn) don't fire the screenshot twice for one reply. */
const handledCaptureMsgIds = new Set<string>()

/** Keys (`${msgId}#${occurrenceIndex}`) of SHOW markers already forwarded.
 *  Unlike capture (once per turn), a single reply may carry multiple SHOW
 *  markers — each must fire exactly once, in order, and survive the duplicate
 *  `chat:complete` events from queue drain. */
const handledShowKeys = new Set<string>()

/**
 * On turn completion, forward any `<<<SHOW: …>>>` payloads in the just-finished
 * assistant reply to the live face preview, in order. Each (message, occurrence)
 * fires exactly once. Sends nothing back over WS, so it can never cause a loop.
 * If no face preview is open the post is a harmless no-op (empty registry).
 */
function maybeHandleShow(): void {
  const store = useChatStore.getState()
  const last = [...store.messages].reverse().find((m) => m.role === 'assistant' && !m.taskId)
  if (!last) return
  let i = 0
  for (const m of last.content.matchAll(SHOW_MARKER)) {
    const key = `${last.id}#${i++}`
    if (handledShowKeys.has(key)) continue
    handledShowKeys.add(key)
    const payload = m[1].trim()
    if (payload) postToFace(payload)
  }
}

/**
 * On turn completion, if the just-finished assistant reply contains the
 * capture marker and a source is bound (desktop shell only), grab a frame of
 * that source and send it back as a new image message so the LLM can see it.
 * Best-effort: any failure (no bridge, window closed, grab error) sends a
 * short text note instead of an image, never throws.
 */
async function maybeHandleCapture(wsClient: WsClient): Promise<void> {
  const store = useChatStore.getState()
  const w = window as unknown as {
    haloCapture?: { grab: (id: string) => Promise<string | null> }
    haloCamera?: { snap: (deviceId?: string) => Promise<string | null> }
  }
  const source = store.captureSource
  if (!source) return
  const isCamera = source.kind === 'camera'
  const bridge = isCamera ? w.haloCamera : w.haloCapture
  if (!bridge) return

  // Find the most recent assistant bubble (just completed) and check its text.
  const last = [...store.messages].reverse().find((m) => m.role === 'assistant' && !m.taskId)
  if (!last || handledCaptureMsgIds.has(last.id)) return
  if (!CAPTURE_MARKER.test(last.content)) return
  handledCaptureMsgIds.add(last.id)

  const project = useProjectStore.getState().activeProject
  const sessionId = store.sessionId
  if (!project || !sessionId) return

  // Same ack/resend protection as use-chat's dispatchMessage — this is a real
  // chat send and must not vanish into a zombie socket either.
  const clientMsgId = generateId()

  // The reply goes through raw wsClient.send (not use-chat's dispatchMessage),
  // so the capture instruction is NOT re-injected on it — that's what stops a
  // capture loop. We still echo a user bubble + streaming slot so the UI shows
  // the round-trip, mirroring dispatchMessage. Both paths are now JPEG: camera
  // via getUserMedia→canvas (quality 0.85), screen via NativeImage.toJPEG(85).
  const mimeType = 'image/jpeg'
  let base64: string | null = null
  try {
    // For the camera, source.id holds the chosen deviceId ('' = default); pass
    // it through so multi-camera machines snap the camera the user picked.
    base64 = isCamera ? await w.haloCamera!.snap(source.id || undefined) : await w.haloCapture!.grab(source.id)
  } catch {
    base64 = null
  }

  const failNote = isCamera
    ? `[📷 ${source.name} — 拍照失败:摄像头可能被其他应用占用或权限被关闭]`
    : `[📷 ${source.name} — 截图失败:该窗口在后台太久被系统回收了画面,切到它再让我截一次]`
  const failMsg = isCamera
    ? `[Could not take a photo from the camera — it may be in use by another app, or camera permission was revoked. Ask the user to check, then request the capture again.]`
    : `[Could not capture "${source.name}" — it was likely occluded/minimized long enough that macOS purged its rendered frame (came back blank/black). Ask the user to briefly bring that window to the foreground, then request the capture again.]`

  store.addMessage({
    id: generateId(),
    role: 'user',
    content: base64 ? `[📷 ${source.name}]` : failNote,
    timestamp: Date.now(),
    clientMsgId,
    // Show the captured frame inline on the bubble so the user can see exactly
    // what was sent to the model (the server-saved copy only appears after the
    // next snapshot, so without this the bubble would be text-only).
    ...(base64 ? { localImages: [`data:${mimeType};base64,${base64}`] } : {}),
  })
  store.addMessage({
    id: generateId(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    streaming: true,
  })

  const agentId = store.selectedAgentId
  wsClient.send({
    type: 'chat',
    sessionId,
    projectId: project.id,
    message: base64 ? (isCamera ? `[Photo from the camera]` : `[Screenshot of "${source.name}"]`) : failMsg,
    clientMsgId,
    ...(agentId !== 'default' ? { agentId } : {}),
    ...(base64 ? { images: [{ data: base64, mimeType }] } : {}),
  })
}

export function registerChatHandlers(wsClient: WsClient): () => void {
  const unsubs: Array<() => void> = []

  // ws-client gave up on a chat (no server ack after all retries): mark the
  // user bubble red + converge its placeholder so the loss is visible.
  unsubs.push(
    wsClient.on('_chat_send_failed', (data) => {
      const msg = data as { clientMsgId?: string }
      if (msg.clientMsgId) useChatStore.getState().markChatSendFailed(msg.clientMsgId)
    }),
  )

  // Streaming-placeholder watchdog. An empty placeholder whose events never
  // arrive (turn lost to a dead connection in a way the ack path doesn't
  // cover — e.g. server restarted mid-turn) would otherwise show "Thinking…"
  // forever AND block state-handlers' snapshot replace on reconnect (the R4
  // amplifier in .halo/tmp/idle-reconnect-msg-loss.md). Time-based by nature
  // (it detects the *absence* of events), so an interval — not push — is the
  // right shape here. Gated on a link drop (see noteLinkDrop) so healthy
  // turns with long pre-first-token silence are never falsely converged;
  // the sweep exits on a cheap `some()` when nothing qualifies.
  unsubs.push(wsClient.on('_disconnected', () => noteLinkDrop()))
  const watchdog = setInterval(() => {
    useChatStore.getState().convergeStaleStreaming()
  }, 5_000)
  unsubs.push(() => clearInterval(watchdog))

  unsubs.push(
    wsClient.on('chat:thinking', (data) => {
      const msg = data as { text: string; agentName?: string; taskId?: string; turnId?: string }
      useChatStore.getState().appendThinking(msg.text, msg.agentName, msg.taskId, msg.turnId)
    }),
  )

  unsubs.push(
    wsClient.on('chat:stream', (data) => {
      const msg = data as { text: string; agentName?: string; taskId?: string; turnId?: string }
      useChatStore.getState().updateLastAssistant(msg.text, msg.agentName, msg.taskId, msg.turnId)
    }),
  )

  unsubs.push(
    wsClient.on('chat:complete', (data) => {
      const msg = data as { text?: string }
      const store = useChatStore.getState()
      if (msg.text) store.updateLastAssistant(msg.text)
      store.completeAgentStreaming()
      // After the reply settles, check for a capture request marker. Fire and
      // forget — never let a capture failure break the completion handler.
      void maybeHandleCapture(wsClient)
      // Also forward any face-drive markers (<<<SHOW: …>>>) to the live preview.
      maybeHandleShow()
    }),
  )

  unsubs.push(
    wsClient.on('chat:stopped', () => {
      useChatStore.getState().completeAgentStreaming()
    }),
  )

  unsubs.push(
    // Server-side errors (model call failed, command failed, agent crashed, …)
    // arrive as `{type: 'error', error, agentName?, taskId?}`. Without this
    // handler the message is dropped on the floor and the UI sits in
    // "thinking…" forever — the user has to refresh to see anything.
    wsClient.on('error', (data) => {
      const msg = data as { error?: string; agentName?: string; taskId?: string }
      const store = useChatStore.getState()
      const text = msg.error ? `Error: ${msg.error}` : 'An unknown error occurred.'
      store.addMessage({
        id: generateId(),
        role: 'system',
        content: text,
        timestamp: Date.now(),
        agentName: msg.agentName,
      })
      // Only flip streaming off when the error belongs to the main task —
      // sub-task errors keep the parent's stream alive.
      if (!msg.taskId) store.completeAgentStreaming(msg.agentName)
    }),
  )

  unsubs.push(
    wsClient.on('chat:followup', (data) => {
      const msg = data as { agentName?: string }
      const store = useChatStore.getState()
      store.completeAgentStreaming(msg.agentName)
      store.addMessage({
        id: generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
        agentName: msg.agentName,
      })
    }),
  )

  unsubs.push(
    wsClient.on('chat:user', (data) => {
      const msg = data as { text: string }
      useChatStore.getState().addMessage({
        id: generateId(),
        role: 'user',
        content: msg.text,
        timestamp: Date.now(),
      })
    }),
  )

  unsubs.push(
    wsClient.on('chat:usage', (data) => {
      const msg = data as {
        contextTokens: number; outputTokens: number; turnId?: string; modelId?: string
        usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens: number; cacheWriteInputTokens?: number; ttftMs?: number; e2eMs?: number }
      }
      const store = useChatStore.getState()
      store.setTokenUsage(msg.contextTokens, msg.outputTokens)
      if (msg.usage) {
        store.addMessage({
          type: 'usage',
          role: 'system',
          content: `[Usage] in=${msg.usage.inputTokens} out=${msg.usage.outputTokens} cache=${msg.usage.cacheReadInputTokens}`,
          usage: msg.usage,
          turnId: msg.turnId,
          modelId: msg.modelId,
        })
      }
    }),
  )

  unsubs.push(
    wsClient.on('session:cleared', () => {
      const store = useChatStore.getState()
      if (store.messages.length > 0 || store.sessionId) {
        store.clear()
      }
    }),
  )

  unsubs.push(
    // /new (and any future command that creates a session) emits this
    // after `execNew` succeeds. We swap the chat-store session id, persist
    // it to localStorage so a refresh lands on the same session, and clear
    // the visible messages — the same end-state the old client-only
    // /clear shortcut produced, but driven by the server.
    wsClient.on('session:switched', (data) => {
      const msg = data as { sessionId?: string }
      if (!msg.sessionId) return
      const project = useProjectStore.getState().activeProject
      if (project) {
        try { localStorage.setItem(`halo_session_${project.id}`, msg.sessionId) } catch { /* ignore */ }
      }
      const store = useChatStore.getState()
      store.clear()
      store.setSessionId(msg.sessionId)
      // Subscribe to the switched-to session — the same path clicking a
      // session in the list takes. The server replies with a state:snapshot
      // (disk-seeded via getSessionView) so a session that already has a
      // transcript (e.g. G after /goal create or resume) renders its history
      // instead of a blank panel; for a fresh /new session the snapshot is
      // empty and this is a no-op.
      if (project) {
        wsClient.send({ type: 'subscribe', sessionId: msg.sessionId, projectId: project.id })
      }
    }),
  )

  unsubs.push(
    wsClient.on('session:compacted', (data) => {
      const msg = data as { message?: string; contextTokens?: number }
      const text = msg.message ?? 'Context compacted'
      const store = useChatStore.getState()
      store.setCompacting(false)
      clearCompactingFallback()
      store.setTokenUsage(msg.contextTokens ?? 0, store.outputTokens)
      store.addMessage({
        id: generateId(),
        role: 'system',
        content: text,
        timestamp: Date.now(),
      })
    }),
  )

  // Fallback timer that force-clears `isCompacting` if neither
  // `session:compacted` nor `compact:done` arrives within 60s. The
  // backend always emits one of those after a compact run, but a WS
  // reconnect or an event-processor edge case can drop the close
  // signal and leave the token ring spinning forever. 60s is well
  // above a normal compact LLM call (5-15s); if a real compact takes
  // longer the visual just goes back early — harmless.
  let compactingFallbackTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleCompactingFallback() {
    if (compactingFallbackTimer) clearTimeout(compactingFallbackTimer)
    compactingFallbackTimer = setTimeout(() => {
      useChatStore.getState().setCompacting(false)
      compactingFallbackTimer = null
    }, 60_000)
  }
  function clearCompactingFallback() {
    if (compactingFallbackTimer) {
      clearTimeout(compactingFallbackTimer)
      compactingFallbackTimer = null
    }
  }

  unsubs.push(
    wsClient.on('chat:system', (data) => {
      const msg = data as { text: string; taskId?: string; agentName?: string }
      // Auto-compact (the path that fires when the running turn crosses
      // `compressAt`) emits its preflight notice as a `chat:system` event
      // rather than the `compact:progress` channel that manual /compact
      // uses, so the token-ring's blue/pulsing state never lit up and the
      // user could keep clicking on it. Latch isCompacting=true here on
      // the root-scope preflight (taskId undefined) so the ring updates
      // and `canCompact` gates further clicks.
      //
      // Also rewrite the displayed text when the server's in-memory
      // `lastContextTokens` is 0 (happens when a session is restored
      // from disk before the next usage event lands — server's manual
      // /compact path falls back to that 0). The frontend's running
      // `contextTokens` (from chat:usage) is the more accurate value
      // at this moment, so swap it in for the user-facing string.
      let text = msg.text
      if (!msg.taskId) {
        const m = text.match(/^Compacting context \((\d+)K tokens\)…$/)
        if (m) {
          useChatStore.getState().setCompacting(true)
          scheduleCompactingFallback()
          if (m[1] === '0') {
            const ctxTokens = useChatStore.getState().contextTokens
            if (ctxTokens > 0) {
              text = `Compacting context (~${Math.round(ctxTokens / 1000)}K tokens)…`
            }
          }
        }
      }
      useChatStore.getState().addMessage({
        id: generateId(),
        role: 'system',
        content: text,
        timestamp: Date.now(),
        // taskId routes the notification into the right exchange — without
        // it sub-agent compaction notices ("Compacting context…", etc.) leak
        // into the root conversation flow.
        taskId: msg.taskId,
        agentName: msg.agentName,
      })
    }),
  )

  unsubs.push(
    wsClient.on('chat:queued', (data) => {
      const msg = data as { message?: string }
      useChatStore.getState().addMessage({
        id: generateId(),
        role: 'system',
        content: msg.message ?? 'Message queued.',
        timestamp: Date.now(),
      })
    }),
  )

  // Manual /compact emits these via `onProgress` (handler.ts), in this
  // sequence: started → summarizing → done. The first two flip the ring
  // immediately, before the `chat:system` preflight even arrives — without
  // them the ring relied solely on the regex match below, which races with
  // the LLM call and felt like "/compact 没效果" when the compact finished
  // in <1s.
  for (const evt of ['compact:progress', 'compact:started', 'compact:summarizing']) {
    unsubs.push(
      wsClient.on(evt, () => {
        useChatStore.getState().setCompacting(true)
        scheduleCompactingFallback()
      }),
    )
  }

  unsubs.push(
    wsClient.on('compact:done', () => {
      useChatStore.getState().setCompacting(false)
      clearCompactingFallback()
    }),
  )

  return () => unsubs.forEach((fn) => fn())
}
