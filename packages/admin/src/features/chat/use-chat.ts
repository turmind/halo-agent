'use client'

import { useCallback, useEffect } from 'react'
import { useChatStore } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { useT } from '@/shared/i18n'
import { wsClient } from '@/shared/ws-client'
import { generateId } from '@/shared/utils'
import type { SlashCommand } from './slash-commands'

/** Build a localStorage key scoped to a project path */
function sessionKey(projectId: string): string {
  return `halo_session_${projectId}`
}

/** Legacy key — for migration only */
const LEGACY_KEY = 'halo_session_id'

function getStoredSessionId(projectId: string): string | null {
  if (typeof window === 'undefined') return null
  // Try project-scoped key first
  const scoped = localStorage.getItem(sessionKey(projectId))
  if (scoped) return scoped
  // Fallback: migrate legacy key (one-time)
  const legacy = localStorage.getItem(LEGACY_KEY)
  if (legacy) {
    localStorage.setItem(sessionKey(projectId), legacy)
    localStorage.removeItem(LEGACY_KEY)
    return legacy
  }
  return null
}

function storeSessionId(projectId: string, id: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(sessionKey(projectId), id)
  }
}

function removeStoredSessionId(projectId: string): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(sessionKey(projectId))
  }
}

export function useChat() {
  const t = useT()
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sessionId = useChatStore((s) => s.sessionId)
  const pendingMessages = useChatStore((s) => s.pendingMessages)
  const activeProject = useProjectStore((s) => s.activeProject)

  // When project changes, load the project-scoped session.
  // Also listens for WS `_connected` so that initial load (where WS connects
  // before activeProject is resolved, or vice-versa) still subscribes.
  useEffect(() => {
    if (!activeProject) return

    const projectId = activeProject.id
    const stored = getStoredSessionId(projectId)
    const currentSessionId = useChatStore.getState().sessionId

    if (stored && stored !== currentSessionId) {
      useChatStore.getState().setSessionId(stored)
      useChatStore.getState().setMessages([])
    } else if (!stored && currentSessionId) {
      useChatStore.getState().clear()
    }

    const subscribeIfReady = () => {
      const sid = useChatStore.getState().sessionId
      if (sid && wsClient.connected) {
        wsClient.send({ type: 'subscribe', sessionId: sid, projectId })
      }
    }
    // Try immediately (covers case: WS already connected when project resolves)
    subscribeIfReady()
    // And again on future connects (covers case: WS reconnects or connects late)
    const off = wsClient.on('_connected', () => subscribeIfReady())
    return () => off()
  }, [activeProject?.id])

  /** Build editor context prefix from current selection and active file */
  const getEditorContext = useCallback((): string => {
    const { activeTab, selectedText, selectedRange, tabs, contextEnabled } = useEditorStore.getState()
    if (!contextEnabled) return ''

    const parts: string[] = []

    if (activeTab) {
      parts.push(`[Currently viewing: ${activeTab}]`)
    }

    if (selectedText && selectedText.trim() && activeTab) {
      const rangeStr = selectedRange ? `:${selectedRange.startLine}-${selectedRange.endLine}` : ''
      parts.push(`[Selected text in ${activeTab}${rangeStr}]\n\`\`\`\n${selectedText}\n\`\`\``)
    }

    return parts.length > 0 ? parts.join('\n') + '\n\n' : ''
  }, [])

  /** Actually dispatch a message to the server */
  const dispatchMessage = useCallback(
    (text: string, images?: Array<{ data: string; mimeType: string }>, mentionedFiles?: string[]) => {
      if (!activeProject) return

      const currentSessionId = sessionId ?? getStoredSessionId(activeProject.id) ?? generateId()
      if (!sessionId || sessionId !== currentSessionId) {
        useChatStore.getState().setSessionId(currentSessionId)
        storeSessionId(activeProject.id, currentSessionId)
      }

      // Build context-enriched message
      const editorContext = getEditorContext()
      const contextParts: string[] = []
      if (editorContext) contextParts.push(editorContext.trim())
      if (mentionedFiles?.length) {
        contextParts.push(`[Referenced files:\n${mentionedFiles.map((f) => `  - ${f}`).join('\n')}]`)
      }
      // Capture prompt injection: when the user has bound a screen/window or
      // the webcam (and we're in the desktop shell — the matching bridge is
      // present), tell the LLM it can request a live frame by emitting
      // <<<CAPTURE>>>. chat-handlers detects the marker on completion, grabs the
      // frame, and sends it back as a new (image) message — that reply takes the
      // raw wsClient.send path (chat-handlers), NOT this dispatch, so it never
      // gets this instruction re-injected (no capture loop). The camera variant
      // phrases it as "the user has turned the camera on" rather than "sharing a
      // window".
      const captureSource = useChatStore.getState().captureSource
      const w = typeof window !== 'undefined' ? (window as unknown as { haloCapture?: unknown; haloCamera?: unknown }) : undefined
      if (captureSource && w) {
        if (captureSource.kind === 'camera' && w.haloCamera) {
          contextParts.push(t('capture.cameraLlmPrompt'))
        } else if (captureSource.kind === 'screen' && w.haloCapture) {
          contextParts.push(t('capture.llmPrompt', { name: captureSource.name }))
        }
      }
      const contextPrefix = contextParts.length > 0 ? contextParts.join('\n') + '\n\n' : ''
      const fullMessage = contextPrefix + text.trim()

      const store = useChatStore.getState()

      // Add user message (show only the user's text, not the context prefix).
      // Pasted images are persisted server-side to .halo/web/inbound/ as
      // [图片已保存: /path] markers — the media-attachments renderer picks
      // them up on the next session snapshot (i.e. after page refresh). The
      // local echo below just shows a short placeholder.
      let displayContent = text.trim()
      if (mentionedFiles?.length) {
        const fileNames = mentionedFiles.map((f) => `@${f.split('/').pop()}`).join(' ')
        displayContent = `${fileNames} ${displayContent}`
      }
      if (images?.length) {
        const placeholder = t('chat.imageSent', { n: images.length })
        displayContent = displayContent ? `${placeholder}\n${displayContent}` : placeholder
      }
      // Links the optimistic bubble to ws-client's ack/resend protocol: the
      // server acks receipt by this id, and `_chat_send_failed` marks the
      // bubble red when the ack never comes (zombie-socket loss, see RCA in
      // .halo/tmp/idle-reconnect-msg-loss.md).
      const clientMsgId = generateId()
      store.addMessage({
        id: generateId(),
        role: 'user',
        content: displayContent,
        timestamp: Date.now(),
        clientMsgId,
        // Show the sent images inline on the bubble. The server-saved copy only
        // surfaces (as a [图片已保存] marker) on the next snapshot/refresh, so
        // without this the bubble is just the "image sent" placeholder text and
        // the user can't see what they actually sent.
        ...(images?.length ? { localImages: images.map((im) => `data:${im.mimeType};base64,${im.data}`) } : {}),
      })

      // Add empty assistant message for streaming — but only if the main session
      // doesn't already have one (interrupt scenario). Sub-agent streaming (with
      // taskId) doesn't block this.
      const hasMainStreaming = store.messages.some(
        (m) => m.streaming && m.role === 'assistant' && !m.taskId,
      )
      if (!hasMainStreaming) {
        store.addMessage({
          id: generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // Send via WebSocket with context-enriched message + images
      const agentId = useChatStore.getState().selectedAgentId
      wsClient.send({
        type: 'chat',
        sessionId: currentSessionId,
        projectId: activeProject.id,
        message: fullMessage,
        clientMsgId,
        ...(agentId !== 'default' ? { agentId } : {}),
        ...(images?.length ? { images } : {}),
      })
    },
    [sessionId, activeProject, getEditorContext],
  )

  const sendMessage = useCallback(
    (text: string, images?: Array<{ data: string; mimeType: string }>, mentionedFiles?: string[]) => {
      if (!text.trim() && !images?.length) return
      if (!activeProject) {
        console.warn('[useChat] No active project selected')
        return
      }

      // If currently streaming, send the message anyway — the server will
      // enqueue it and the agent will process it at the next safe
      // checkpoint (after current tool call or streaming output completes).
      dispatchMessage(text, images, mentionedFiles)
    },
    [activeProject, dispatchMessage, sessionId],
  )

  const stopGeneration = useCallback(() => {
    wsClient.send({ type: 'chat:stop', sessionId })
  }, [sessionId])

  // esc: interrupt the in-flight turn (aborts a command mid-run); the server
  // then folds any queued messages into one follow-up turn. Distinct from
  // stopGeneration, which ends the turn without re-running.
  const interruptGeneration = useCallback(() => {
    wsClient.send({ type: 'chat:interrupt', sessionId })
  }, [sessionId])

  const removePendingMessage = useCallback((index: number) => {
    useChatStore.getState().removePendingMessage(index)
  }, [])

  // Legacy: process any queued messages when streaming completes (fallback)
  useEffect(() => {
    if (isStreaming) return
    const next = useChatStore.getState().shiftPendingMessage()
    if (next) {
      const timer = setTimeout(() => dispatchMessage(next), 100)
      return () => clearTimeout(timer)
    }
  }, [isStreaming, dispatchMessage])

  /** Start a new session — resets agent but keeps old session in DB for history */
  const clearSession = useCallback(() => {
    if (!activeProject) return

    const currentSessionId = sessionId ?? getStoredSessionId(activeProject.id)

    // Tell server to reset session (session stays in DB)
    if (currentSessionId) {
      wsClient.send({ type: 'session:clear', sessionId: currentSessionId })
    }

    // Remove stored session for this project
    removeStoredSessionId(activeProject.id)

    // Clear chat store (messages + sessionId)
    useChatStore.getState().clear()
  }, [activeProject, sessionId])

  /** Delete a session from DB permanently */
  const deleteSession = useCallback((targetSessionId: string) => {
    if (!activeProject) return

    wsClient.send({ type: 'session:delete', sessionId: targetSessionId, projectId: activeProject.path })

    // If deleting the current session, also clear UI
    const currentSessionId = sessionId ?? getStoredSessionId(activeProject.id)
    if (targetSessionId === currentSessionId) {
      removeStoredSessionId(activeProject.id)
      useChatStore.getState().clear()
    }
  }, [activeProject, sessionId])

  const handleCommand = useCallback(
    (cmd: SlashCommand, args: string) => {
      // All slash commands route through the server via WS now. The server
      // owns the canonical implementation (execNew / execHelp / execList /
      // skill activation / etc.) so wechat / telegram / web / web-demo /
      // admin all see identical behaviour. Pure client-only shortcuts (eg
      // the old `/clear` that just wiped the local chat store) have been
      // removed from the registry entirely — server-side `/new` already
      // covers the "start fresh" intent and the WS reply pushes a
      // `session:switched` event which admin handles below to clear local
      // state.
      if (!activeProject) return
      // Bootstrap a session id the same way `dispatchMessage` does so a
      // slash command issued in a fresh chat box still has something for
      // the server's `bindOrCreateSession` to bind to.
      const currentSessionId = sessionId ?? getStoredSessionId(activeProject.id) ?? generateId()
      if (!sessionId || sessionId !== currentSessionId) {
        useChatStore.getState().setSessionId(currentSessionId)
        storeSessionId(activeProject.id, currentSessionId)
      }
      const cmdName = cmd.name.slice(1)
      const payload: Record<string, unknown> = {
        type: `command:${cmdName}`,
        sessionId: currentSessionId,
        projectId: activeProject.id,
      }
      if (args.trim()) payload.message = args.trim()
      wsClient.send(payload)
      useChatStore.getState().addMessage({
        id: generateId(),
        role: 'system',
        content: `Executing ${cmd.name}${args.trim() ? ` ${args.trim()}` : ''}...`,
        timestamp: Date.now(),
      })
    },
    [activeProject, sessionId],
  )

  return { messages, sendMessage, isStreaming, sessionId, clearSession, deleteSession, stopGeneration, interruptGeneration, pendingMessages, removePendingMessage, handleCommand }
}
