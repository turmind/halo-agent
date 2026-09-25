import type { WsClient } from '../ws-client-types'
import { useChatStore, isStaleStreamingPlaceholder, noteSnapshot } from '@/features/chat/chat-store'
import { noteArchiveAnchor } from '@/features/chat/archive-store'
import { refreshGoal } from '@/features/chat/goal-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { bumpSessionBus } from '@/shared/session-bus'
import { onWsReconnect } from '@/shared/ws-reconnect'

export function registerStateHandlers(wsClient: WsClient): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    wsClient.on('state:snapshot', ({ snapshot }) => {

      if (snapshot.sessionId) {
        useChatStore.getState().setSessionId(snapshot.sessionId)
        // Anchor the scroll-up history walk. Only subscribe/reattach snapshots
        // carry `archiveCount`; the per-turn ones omit it, which is read as
        // "no archive" — safe because noteArchiveAnchor only ever re-anchors on
        // a HIGHER count, and 0 never beats a bound anchor.
        noteArchiveAnchor(snapshot.sessionId, snapshot.archiveCount ?? 0)
      }
      if (snapshot.agentId) {
        useChatStore.getState().setSelectedAgentId(snapshot.agentId)
      }
      // Only snapshots tied to an existing session carry the field; absent
      // (e.g. the pre-session connect snapshot) leaves the selector alone.
      if (snapshot.accessLevel !== undefined) {
        useChatStore.getState().setAccessLevel(snapshot.accessLevel ?? 'full')
      }
      // Don't clobber an in-flight streaming turn with a server snapshot.
      // The server emits `state:snapshot` on every WS subscribe — including
      // the auto-reconnect that fires when the connection looks stale (see
      // ws-client.reconnectIfStale). If a stale-reconnect lands while the
      // user has just sent a new message and the assistant placeholder is
      // still streaming, blindly replacing `messages` with the persisted
      // snapshot wipes both the user's new prompt AND the streaming slot
      // that incoming `chat:stream` events expect to find. The frontend
      // then re-adds them on the next chunk, but the visual flicker (and
      // any chunks that arrived in the gap) was the "messages disappearing
      // / not realtime" bug. Skip the snapshot replace entirely while
      // anything is streaming — the server-side state will be reconciled
      // by the existing chunk-handling path in chat-store.
      //
      // Exemption: an EMPTY placeholder that has sat event-less past the
      // stale window doesn't count as in-flight. Such a placeholder means
      // the turn was lost (zombie-socket send, see RCA) and no events will
      // ever converge it — treating it as in-flight made every post-reconnect
      // snapshot get skipped, so the UI stayed on "Thinking…" even after the
      // link recovered (R4 in .halo/tmp/idle-reconnect-msg-loss.md).
      const inFlight = useChatStore.getState().messages.some(
        (m) => m.streaming && !isStaleStreamingPlaceholder(m),
      )
      // Stash the snapshot even when the replace below is skipped (and even
      // when empty — the settled log of a running session's first turn IS
      // empty): if this subscribe reattached a still-running session, the
      // server follows with a replay-flagged followup (see ws/handler.ts)
      // and chat-handlers resets to this stash + rebuilds from the replay.
      const snapshotMessages = snapshot.recentMessages ?? snapshot.messages
      if (snapshotMessages && snapshot.sessionId) {
        noteSnapshot(snapshot.sessionId, snapshotMessages)
      }
      if (!inFlight) {
        if (snapshotMessages && snapshotMessages.length > 0) {
          useChatStore.getState().setMessages(snapshotMessages)
        }
      } else {
        console.debug('[state-handlers] skipping snapshot replace — streaming in flight')
      }
      if (typeof snapshot.maxContextTokens === 'number' && snapshot.maxContextTokens > 0) {
        useChatStore.getState().setMaxContextTokens(snapshot.maxContextTokens)
      }
    }),
  )

  // The server reclaimed this connection's event listener (renderer frozen
  // >3min while the browser's network process kept answering pings — see
  // ws/handler.ts reclaimIfAbandoned). The tab can't notice on its own: the
  // server keeps answering `__pong__`, so the staleness clock stays fresh and
  // neither the zombie detection nor the visibility probe ever fires. Reading
  // this frame (from the kernel buffer, on resume) IS the recovery signal:
  // re-subscribe to reattach. Idempotent server-side, and the snapshot that
  // comes back restores whatever streamed while the listener was down. Same
  // sessionId/projectId source as the `_connected` resubscribe in
  // use-websocket.ts — the store, not the frame, is what the UI wants bound.
  unsubs.push(
    wsClient.on('listener:released', () => {
      const activeProject = useProjectStore.getState().activeProject
      if (!activeProject?.id) return
      const sessionId = useChatStore.getState().sessionId ?? ''
      wsClient.send({ type: 'subscribe', sessionId, projectId: activeProject.id })
    }),
  )

  // A root session was created server-side (channel / TUI / CLI / another web
  // client) — bump the shared session bus so every mounted session list
  // (chat-header dropdown, sessions sidebar, history count) re-fetches. The
  // admin's own delete already bumps locally; this covers the push direction.
  unsubs.push(
    wsClient.on('session:changed', () => bumpSessionBus()),
  )

  // A `session:changed` emitted while the socket was down is lost — a turn
  // that settles mid-drop would leave every list stale until the next
  // unrelated bump. Reconcile on reconnect, same pattern as the other
  // push-fed panels.
  unsubs.push(onWsReconnect(wsClient, () => bumpSessionBus()))

  // Goal-mode state transition (create/attach/round/pause/halt/done/clear —
  // every writeGoalState broadcasts). The event carries the new state, but we
  // re-fetch through the seed endpoint instead of applying it directly: the
  // broadcast is server-global while the banner is per-workspace, and the
  // fetch resolves against the active project. Binding changes also affect
  // the session lists' 🎯 badge → bump the bus.
  unsubs.push(
    wsClient.on('goal:changed', () => {
      const projectId = useProjectStore.getState().activeProject?.id
      if (projectId) void refreshGoal(projectId)
      bumpSessionBus()
    }),
  )

  return () => unsubs.forEach((fn) => fn())
}
