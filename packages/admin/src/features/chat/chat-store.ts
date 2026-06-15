import { create } from 'zustand'
import type { ChatMessage, ToolCallInfo } from '@/shared/types'
import { generateId } from '@/shared/utils'
import { isMainConversationMessage } from '@/shared/types'

/**
 * When a streaming event arrives with a turnId that doesn't match the current
 * streaming assistant's last block, it means a new server turn has begun
 * (e.g. user sent a 2nd message during a narrow window where the server's
 * `complete` event hadn't reached the frontend yet). Finalize the stale
 * streaming assistant and append a fresh one so the new turn's content lands
 * after any user messages added in between — instead of back-appending into
 * the previous bubble and visually displacing the user's question.
 */
function ensureStreamingSlot(
  messages: ChatMessage[],
  agentName?: string,
  taskId?: string,
  turnId?: string,
): ChatMessage[] {
  if (!turnId) return messages

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Match by taskId scope so root and sub-agents are split independently:
    // root events (taskId=undefined) don't fall into sub-agent bubbles, and
    // sub-agent events split per-turn within their OWN bubble. Earlier this
    // function early-returned when `taskId` was truthy, which made every
    // sub-agent turn glomp into one giant bubble (no splits ever happened
    // for sub-agents).
    if (msg.taskId !== taskId) continue
    if (msg.role !== 'assistant' || !msg.streaming) continue
    if (agentName && msg.agentName && msg.agentName.toLowerCase() !== agentName.toLowerCase()) continue

    const blocks = msg.contentBlocks ?? []
    const lastBlockTurnId = blocks.length > 0 ? blocks[blocks.length - 1].turnId : undefined
    if (!lastBlockTurnId || lastBlockTurnId === turnId) return messages

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
    return next
  }
  // No streaming slot found — create one (e.g. message from another channel)
  return [...messages, {
    id: generateId(),
    role: 'assistant' as const,
    content: '',
    timestamp: Date.now(),
    streaming: true,
    agentName,
    taskId,
  }]
}

interface ChatStore {
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
  updateLastToolCallResult(result: string, agentName?: string, taskId?: string): void
  completeStreaming(): void
  completeAgentStreaming(agentName?: string, taskId?: string): void
  setSessionId(id: string): void
  setMessages(messages: ChatMessage[]): void
  setTokenUsage(context: number, output: number): void
  setMaxContextTokens(max: number): void
  setCompacting(v: boolean): void
  setSelectedAgentId(id: string): void
  setUsableAgentCount(n: number): void
  setCaptureSource(source: { id: string; name: string; thumb: string; kind: 'screen' | 'camera' } | null): void
  addPendingMessage(text: string): void
  removePendingMessage(index: number): void
  shiftPendingMessage(): string | undefined
  clear(): void
}

export const useChatStore = create<ChatStore>((set, get) => ({
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
  usableAgentCount: -1,
  captureSource: null,

  addMessage(msg) {
    const message: ChatMessage = {
      id: msg.id ?? generateId(),
      type: msg.type,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp ?? Date.now(),
      plan: msg.plan,
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
    }
    set((state) => {
      const mainBefore = state.messages.filter(isMainConversationMessage).length
      console.log(`[ChatStore:addMessage] role=${message.role} type=${message.type ?? '-'} streaming=${!!message.streaming} taskId=${message.taskId ?? '-'} main=${mainBefore}+${isMainConversationMessage(message) ? 1 : 0}`)
      return {
        messages: [...state.messages, message],
        isStreaming: (msg.streaming && !msg.taskId) ? true : state.isStreaming,
      }
    })
  },

  appendThinking(text: string, agentName?: string, taskId?: string, turnId?: string) {
    set((state) => {
      const messages = [...ensureStreamingSlot(state.messages, agentName, taskId, turnId)]
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant' && msg.streaming) {
          if (msg.taskId !== taskId) continue
          const blocks = [...(msg.contentBlocks ?? [])]
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock && lastBlock.type === 'thinking' && (!turnId || lastBlock.turnId === turnId)) {
            blocks[blocks.length - 1] = { type: 'thinking', text: lastBlock.text + text, turnId: turnId ?? lastBlock.turnId }
          } else {
            blocks.push({ type: 'thinking', text, turnId })
          }
          messages[i] = { ...msg, contentBlocks: blocks }
          break
        }
      }
      return { messages }
    })
  },

  updateLastAssistant(text: string, agentName?: string, taskId?: string, turnId?: string) {
    set((state) => {
      const messages = [...ensureStreamingSlot(state.messages, agentName, taskId, turnId)]
      let found = false
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant' && msg.streaming) {
          if (msg.taskId !== taskId) continue

          // Update contentBlocks: append to last text block (same turnId), or create new one
          const blocks = [...(msg.contentBlocks ?? [])]
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock && lastBlock.type === 'text' && (!turnId || lastBlock.turnId === turnId)) {
            blocks[blocks.length - 1] = { type: 'text', text: lastBlock.text + text, turnId: turnId ?? lastBlock.turnId }
          } else {
            blocks.push({ type: 'text', text, turnId })
          }

          messages[i] = {
            ...msg,
            content: msg.content + text,
            contentBlocks: blocks,
          }
          found = true
          break
        }
      }
      return found && !taskId ? { messages, isStreaming: true } : { messages }
    })
  },

  addToolCallToLastAssistant(toolCall: ToolCallInfo, agentName?: string, taskId?: string, turnId?: string) {
    set((state) => {
      const messages = [...ensureStreamingSlot(state.messages, agentName, taskId, turnId)]
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant' && msg.streaming) {
          if (msg.taskId !== taskId) continue

          const blocks = [...(msg.contentBlocks ?? [])]
          blocks.push({ type: 'tool_call', toolCall, turnId })

          messages[i] = {
            ...msg,
            toolCalls: [...(msg.toolCalls ?? []), toolCall],
            contentBlocks: blocks,
          }
          break
        }
      }
      return { messages }
    })
  },

  updateLastToolCallResult(result: string, agentName?: string, taskId?: string) {
    set((state) => {
      const messages = [...state.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant' && msg.streaming && msg.toolCalls?.length) {
          if (msg.taskId !== taskId) continue

          // Update in toolCalls array
          const toolCalls = [...msg.toolCalls]
          const last = toolCalls[toolCalls.length - 1]
          toolCalls[toolCalls.length - 1] = { ...last, output: result }

          // Also update in contentBlocks. Preserve `turnId` on the block —
          // dropping it caused ensureStreamingSlot to see a stale "lastBlock
          // turnId=undef" later and reuse this assistant message for blocks
          // belonging to subsequent turns, collapsing 12 separate turns into
          // one giant message bubble in the live UI.
          const blocks = [...(msg.contentBlocks ?? [])]
          for (let j = blocks.length - 1; j >= 0; j--) {
            const block = blocks[j]
            if (block.type === 'tool_call' && !block.toolCall.output) {
              blocks[j] = { type: 'tool_call', toolCall: { ...block.toolCall, output: result }, turnId: block.turnId }
              break
            }
          }

          messages[i] = { ...msg, toolCalls, contentBlocks: blocks }
          break
        }
      }
      return { messages }
    })
  },

  completeStreaming() {
    set((state) => {
      const messages = state.messages.map((msg) =>
        msg.streaming ? { ...msg, streaming: false } : msg,
      )
      return { messages, isStreaming: false }
    })
  },

  completeAgentStreaming(agentName?: string, taskId?: string) {
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
      return { messages, isStreaming: stillStreaming }
    })
  },

  setSessionId(id: string) {
    set({ sessionId: id })
  },

  setMessages(messages: ChatMessage[]) {
    const prev = get().messages
    console.log(`[ChatStore:setMessages] ${prev.length} -> ${messages.length}`, new Error().stack?.split('\n').slice(1, 4).join(' <- '))
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
    set({ usableAgentCount: n })
  },

  setCaptureSource(source) {
    set({ captureSource: source })
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

  clear() {
    console.log(`[ChatStore:clear] dropping ${get().messages.length} messages`, new Error().stack?.split('\n').slice(1, 4).join(' <- '))
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
    set({ messages: [], isStreaming: false, pendingMessages: [], sessionId: null, contextTokens: 0, outputTokens: 0 })
  },
}))
