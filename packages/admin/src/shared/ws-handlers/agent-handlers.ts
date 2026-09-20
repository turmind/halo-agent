import type { WsClient } from '../ws-client-types'
import { useChatStore } from '@/features/chat/chat-store'
import { generateId } from '@/shared/utils'

export function registerAgentHandlers(wsClient: WsClient): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    wsClient.on('agent:start', (msg) => {
      useChatStore.getState().addMessage({
        id: generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
        agentName: msg.agentName,
        taskId: msg.taskId,
      })
    }),
  )

  unsubs.push(
    wsClient.on('agent:done', (msg) => {
      useChatStore.getState().completeAgentStreaming(msg.agentName, msg.taskId)
    }),
  )

  unsubs.push(
    wsClient.on('agent:context', (msg) => {
      useChatStore.getState().addMessage({
        id: generateId(),
        role: 'system',
        content: `[System Prompt: ${msg.agentName ?? 'Agent'}]`,
        timestamp: Date.now(),
        agentName: msg.agentName,
        taskId: msg.taskId,
        systemPrompt: msg.systemPrompt,
      })
    }),
  )

  unsubs.push(
    wsClient.on('agent:tool_call', (msg) => {
      const agentName = msg.agentName ?? 'default'
      // Store the full input — truncation is the render layer's job
      // (InlineToolCall previews collapsed and shows everything on expand).
      const inputStr = typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input ?? {})
      useChatStore.getState().addToolCallToLastAssistant(
        { name: msg.tool ?? '', input: inputStr, toolUseId: msg.toolUseId },
        agentName,
        msg.taskId,
        msg.turnId,
      )
    }),
  )

  unsubs.push(
    wsClient.on('agent:tool_result', (msg) => {
      const agentName = msg.agentName ?? 'default'
      // Store the full result — truncation is the render layer's job
      // (InlineToolCall previews at 120 chars; expand shows everything).
      const fullResult = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result ?? '')
      useChatStore.getState().updateLastToolCallResult(fullResult, agentName, msg.taskId, msg.toolUseId)
    }),
  )

  return () => unsubs.forEach((fn) => fn())
}
