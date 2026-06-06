import type { WsClient } from '../ws-client-types'
import { useChatStore } from '@/features/chat/chat-store'
import { useTaskStore } from '@/shared/stores/task-store'
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
      const inFlight = useChatStore.getState().messages.some((m) => m.streaming)
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

  return () => unsubs.forEach((fn) => fn())
}
