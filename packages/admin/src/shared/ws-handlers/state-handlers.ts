import type { WsClient } from '../ws-client-types'
import { useChatStore, isStaleStreamingPlaceholder } from '@/features/chat/chat-store'
import { refreshGoal } from '@/features/chat/goal-store'
import { useTaskStore } from '@/shared/stores/task-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { bumpSessionBus } from '@/shared/session-bus'
import type { WsSnapshotMsg, ChatMessage } from '@/shared/types'

export function registerStateHandlers(wsClient: WsClient): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    wsClient.on('state:snapshot', (data) => {
      const msg = data as unknown as WsSnapshotMsg & { snapshot: { recentMessages?: ChatMessage[]; agentId?: string } }
      const { snapshot } = msg

      if (snapshot.sessionId) {
        useChatStore.getState().setSessionId(snapshot.sessionId)
      }
      if (snapshot.agentId) {
        useChatStore.getState().setSelectedAgentId(snapshot.agentId)
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
      if (!inFlight) {
        if (snapshot.recentMessages && snapshot.recentMessages.length > 0) {
          useChatStore.getState().setMessages(snapshot.recentMessages)
        } else if (snapshot.messages && snapshot.messages.length > 0) {
          useChatStore.getState().setMessages(snapshot.messages)
        }
      } else {
        console.debug('[state-handlers] skipping snapshot replace — streaming in flight')
      }
      if (snapshot.activePlan) {
        useTaskStore.getState().setActivePlan(snapshot.activePlan)
      }
      if (snapshot.agents) {
        useTaskStore.getState().setAgentConfigs(snapshot.agents as never)
      }
      const snap = snapshot as unknown as Record<string, unknown>
      if (typeof snap.maxContextTokens === 'number' && snap.maxContextTokens > 0) {
        useChatStore.getState().setMaxContextTokens(snap.maxContextTokens as number)
      }
    }),
  )

  // A root session was created server-side (channel / TUI / CLI / another web
  // client) — bump the shared session bus so every mounted session list
  // (chat-header dropdown, sessions sidebar, history count) re-fetches. The
  // admin's own delete already bumps locally; this covers the push direction.
  unsubs.push(
    wsClient.on('session:changed', () => bumpSessionBus()),
  )

  // Goal-mode state transition (create/attach/round/pause/halt/done/clear —
  // every writeGoalState broadcasts). The event carries the new state, but we
  // re-fetch through the seed endpoint instead of applying it directly: the
  // broadcast is server-global while the banner is per-workspace, and the
  // fetch resolves against the active project. Binding changes also affect
  // the session lists' 🎯 badge → bump the bus.
  unsubs.push(
    wsClient.on('goal:changed', () => {
      const projectId = useProjectStore.getState().activeProject?.path
      if (projectId) void refreshGoal(projectId)
      bumpSessionBus()
    }),
  )

  return () => unsubs.forEach((fn) => fn())
}
