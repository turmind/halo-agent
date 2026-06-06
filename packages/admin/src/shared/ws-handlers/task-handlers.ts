import type { WsClient } from '../ws-client-types'
import { useChatStore } from '@/features/chat/chat-store'
import { useTaskStore } from '@/shared/stores/task-store'
import type { WsTaskPlanMsg, WsTaskStatusMsg, WsPlanCompleteMsg } from '@/shared/types'
import { generateId } from '@/shared/utils'

export function registerTaskHandlers(wsClient: WsClient): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    wsClient.on('task:plan', (data) => {
      const msg = data as unknown as WsTaskPlanMsg
      useChatStore.getState().addMessage({
        id: generateId(),
        role: 'assistant',
        content: `Task plan created: ${msg.plan.description}`,
        timestamp: Date.now(),
        plan: msg.plan,
      })
      useTaskStore.getState().setActivePlan(msg.plan)
    }),
  )

  unsubs.push(
    wsClient.on('task:status', (data) => {
      const msg = data as unknown as WsTaskStatusMsg
      useTaskStore.getState().updateTaskStatus(msg.taskId, msg.status)
    }),
  )

  unsubs.push(
    wsClient.on('plan:complete', (data) => {
      const msg = data as unknown as WsPlanCompleteMsg
      useChatStore.getState().addMessage({
        id: generateId(),
        role: 'system',
        content: `Plan completed: ${msg.summary}`,
        timestamp: Date.now(),
      })
      useChatStore.getState().completeStreaming()
    }),
  )

  return () => unsubs.forEach((fn) => fn())
}
