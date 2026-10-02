import type { WsClient } from '../ws-client-types'
import { getActiveChatStore, isStaleStreamingPlaceholder } from '@/features/chat/chat-store'
import { getLoadedStore, noteTabSnapshot, releaseSessionTab, storeForFrame } from '@/features/chat/chat-tabs'
import { noteArchiveAnchor } from '@/features/chat/archive-store'
import { refreshGoal } from '@/features/chat/goal-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { bumpSessionBus } from '@/shared/session-bus'
import { onWsReconnect } from '@/shared/ws-reconnect'
import { api } from '@/shared/api-client'
import { setExtensions } from '@/features/editor/previews/registry'

export function registerStateHandlers(wsClient: WsClient): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    wsClient.on('state:snapshot', ({ snapshot }) => {
      // A session's snapshot goes to the tab holding that session (dropped if
      // none does — the tab was released meanwhile); a session-less one (the
      // connect seed, a pre-session subscribe) to the tab on screen. Loading
      // a tab isn't news, so no unread dot.
      const store = storeForFrame(snapshot.sessionId, false)
      if (!store) return
      const chat = store.getState()

      if (snapshot.sessionId) {
        // Anchor the scroll-up history walk. Only subscribe/reattach snapshots
        // carry `archiveCount`; the per-turn ones omit it, which is read as
        // "no archive" — safe because noteArchiveAnchor only ever re-anchors on
        // a HIGHER count, and 0 never beats a bound anchor. The archive store
        // follows the tab on screen; a background tab's count is kept for
        // when it is shown (chat-tabs showTab).
        const archiveCount = snapshot.archiveCount ?? 0
        noteTabSnapshot(store, archiveCount)
        if (store === getActiveChatStore()) noteArchiveAnchor(snapshot.sessionId, archiveCount)
      }
      if (snapshot.agentId) {
        chat.setSelectedAgentId(snapshot.agentId)
      }
      // Only snapshots tied to an existing session carry the field; absent
      // (e.g. the pre-session connect snapshot) leaves the selector alone.
      if (snapshot.accessLevel !== undefined) {
        chat.setAccessLevel(snapshot.accessLevel ?? 'full')
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
      const inFlight = store.getState().messages.some(
        (m) => m.streaming && !isStaleStreamingPlaceholder(m),
      )
      // Stash the snapshot even when the replace below is skipped (and even
      // when empty — the settled log of a running session's first turn IS
      // empty): if this subscribe reattached a still-running session, the
      // server follows with a replay-flagged followup (see ws/handler.ts)
      // and chat-handlers resets to this stash + rebuilds from the replay.
      const snapshotMessages = snapshot.recentMessages ?? snapshot.messages
      if (snapshotMessages && snapshot.sessionId) {
        chat.noteSnapshot(snapshot.sessionId, snapshotMessages)
      }
      if (!inFlight) {
        if (snapshotMessages && snapshotMessages.length > 0) {
          chat.setMessages(snapshotMessages)
        }
      } else {
        console.debug('[state-handlers] skipping snapshot replace — streaming in flight')
      }
      if (typeof snapshot.maxContextTokens === 'number' && snapshot.maxContextTokens > 0) {
        chat.setMaxContextTokens(snapshot.maxContextTokens)
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
  // comes back restores whatever streamed while the listener was down. The
  // server sends one frame per released session; only the session on screen
  // is re-subscribed (a tab not loaded has nothing to reattach, and the file
  // watcher is per-connection — the reclaim leaves it).
  unsubs.push(
    wsClient.on('listener:released', ({ sessionId }) => {
      const activeProject = useProjectStore.getState().activeProject
      if (!activeProject?.id || !sessionId) return
      const store = getLoadedStore(sessionId)
      if (!store) return
      // A background tab isn't reattached (same rule as a reconnect): drop
      // its store; its next show loads it again.
      if (store !== getActiveChatStore()) {
        releaseSessionTab(sessionId)
        return
      }
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

  // Canvas extension installed / removed / edited on disk — the server's dir
  // watcher pushes the full snapshot; the preview registry re-resolves every
  // open tab from it. A frame lost while the socket was down is reconciled
  // by re-fetching on reconnect (initial pull lives in workspace-layout).
  unsubs.push(
    wsClient.on('extension:changed', ({ extensions, errors }) => setExtensions({ extensions, errors })),
  )
  unsubs.push(onWsReconnect(wsClient, () => { api.extensions.list().then(setExtensions).catch(() => {}) }))

  return () => unsubs.forEach((fn) => fn())
}
