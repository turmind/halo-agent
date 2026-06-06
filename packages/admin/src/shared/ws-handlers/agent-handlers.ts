import type { WsClient } from '../ws-client-types'
import { useChatStore } from '@/features/chat/chat-store'
import { useTaskStore } from '@/shared/stores/task-store'
import { generateId } from '@/shared/utils'

export function registerAgentHandlers(wsClient: WsClient): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    wsClient.on('agent:start', (data) => {
      const msg = data as { agentName: string; task?: string; taskId?: string }
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
    wsClient.on('agent:done', (data) => {
      const msg = data as { agentName: string; taskId?: string }
      useChatStore.getState().completeAgentStreaming(msg.agentName, msg.taskId)
    }),
  )

  unsubs.push(
    wsClient.on('agent:context', (data) => {
      const msg = data as { agentName?: string; systemPrompt?: string; taskId?: string }
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
    wsClient.on('agent:tool_call', (data) => {
      const msg = data as { tool: string; input: unknown; agentName?: string; taskId?: string; turnId?: string }
      const agentName = msg.agentName ?? 'default'
      const inputStr = typeof msg.input === 'string' ? msg.input :
        JSON.stringify(msg.input ?? {}).slice(0, 1000)
      useChatStore.getState().addToolCallToLastAssistant(
        { name: msg.tool, input: inputStr.slice(0, 500) },
        agentName,
        msg.taskId,
        msg.turnId,
      )
    }),
  )

  unsubs.push(
    wsClient.on('agent:tool_result', (data) => {
      const msg = data as { result: unknown; agentName?: string; taskId?: string; durationMs?: number }
      const agentName = msg.agentName ?? 'default'
      let preview = ''
      if (typeof msg.result === 'string') {
        try {
          const parsed = JSON.parse(msg.result)
          if (parsed.toolResult?.content) {
            preview = parsed.toolResult.content.map((c: { text?: string }) => c.text ?? '').filter(Boolean).join('\n').slice(0, 500)
          } else {
            preview = (msg.result as string).slice(0, 500)
          }
        } catch {
          preview = (msg.result as string).slice(0, 500)
        }
      } else {
        preview = JSON.stringify(msg.result).slice(0, 500)
      }
      useChatStore.getState().updateLastToolCallResult(preview, agentName, msg.taskId)
    }),
  )

  unsubs.push(
    wsClient.on('agent:configs', (data) => {
      const msg = data as { agents: Array<{ name: string; role: string; model: string; status: string; tools: string[] }> }
      useTaskStore.getState().setAgentConfigs(msg.agents as never)
    }),
  )

  return () => unsubs.forEach((fn) => fn())
}
