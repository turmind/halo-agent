'use client'

import { useCallback, useEffect } from 'react'
import type { WsClientMessage } from '@turmind/halo-core/protocol'
import { useChatStore } from '@/features/chat/chat-store'
import { bindActiveTabSession, dropSessionTab, newTab, restoreTabs } from '@/features/chat/chat-tabs'
import { removeCachedView } from '@/features/agents/session-view-cache'
import { getScreenBridge, getCameraBridge } from '@/features/chat/web-capture'
import { useProjectStore } from '@/shared/stores/project-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { faceContextLine, faceUserMessage, takeFaceAcks } from '@/features/editor/face-bridge'
import { isFaceOn } from '@/features/editor/face-store'
import { useT } from '@/shared/i18n'
import { wsClient } from '@/shared/ws-client'
import { generateId } from '@/shared/utils'
import type { SlashCommand } from './slash-commands'

export function useChat() {
  const t = useT()
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sessionId = useChatStore((s) => s.sessionId)
  const pendingMessages = useChatStore((s) => s.pendingMessages)
  const activeProject = useProjectStore((s) => s.activeProject)

  // When project changes, restore its tab headers and load the active tab —
  // chat-tabs subscribes it if the WS is already up. Reconnects (and late
  // initial connects) are owned exclusively by use-websocket's `_connected`
  // handler — a second subscriber here double-subscribed on every reconnect:
  // the first consumed the detached-session entry (reattach + replay), the
  // second re-ran the normal path (second snapshot + listener re-registration).
  useEffect(() => {
    if (activeProject) restoreTabs(activeProject.id)
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

      // A draft tab mints its session id on the first send.
      const currentSessionId = sessionId ?? generateId()
      if (!sessionId) bindActiveTabSession(currentSessionId)

      // Build context-enriched message
      const editorContext = getEditorContext()
      const contextParts: string[] = []
      if (editorContext) contextParts.push(editorContext.trim())
      if (mentionedFiles?.length) {
        contextParts.push(`[Referenced files:\n${mentionedFiles.map((f) => `  - ${f}`).join('\n')}]`)
      }
      // Capture prompt injection: when the user has bound a screen/window or
      // the webcam (and its bridge — desktop shell or browser, web-capture —
      // is available), tell the LLM it can request a live frame by emitting
      // <<<CAPTURE>>>. chat-handlers detects the marker on completion, grabs the
      // frame, and sends it back as a new (image) message — that reply takes the
      // raw wsClient.send path (chat-handlers), NOT this dispatch, so it never
      // gets this instruction re-injected (no capture loop). The camera variant
      // phrases it as "the user has turned the camera on" rather than "sharing a
      // window"; a browser share as "sharing {name} from the browser". Both
      // bound → one combined prompt offering <<<CAPTURE:screen>>> /
      // <<<CAPTURE:camera>>> / bare <<<CAPTURE>>> (both).
      const { screenSource, cameraSource } = useChatStore.getState()
      const screen = getScreenBridge()
      const screenOn = !!screenSource && !!screen
      const cameraOn = !!cameraSource && !!getCameraBridge()
      if (screenOn && cameraOn) {
        contextParts.push(t('capture.bothLlmPrompt', { name: screenSource.name }))
      } else if (cameraOn) {
        contextParts.push(t('capture.cameraLlmPrompt'))
      } else if (screenOn) {
        contextParts.push(t(screen.web ? 'capture.webLlmPrompt' : 'capture.llmPrompt', { name: screenSource.name }))
      }
      // Face toggle on → tell the agent its face is open, plus whatever the face
      // reported since the last message (face-bridge receipts, then cleared).
      // Independent of contextEnabled. Like the capture prompt it rides only this
      // dispatch — the snapshot reply (chat-handlers raw send) never carries it.
      faceUserMessage()
      if (isFaceOn(activeProject.id)) contextParts.push(faceContextLine(takeFaceAcks()))
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
      const { selectedAgentId: agentId, accessLevel } = useChatStore.getState()
      wsClient.send({
        type: 'chat',
        sessionId: currentSessionId,
        projectId: activeProject.id,
        message: fullMessage,
        clientMsgId,
        accessLevel,
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

  /** Delete a session from DB permanently */
  const deleteSession = useCallback((targetSessionId: string) => {
    if (!activeProject) return

    wsClient.send({ type: 'session:delete', sessionId: targetSessionId, projectId: activeProject.path })

    // Its tab (if open) goes with it — no unsubscribe: the delete already
    // released the listener server-side. So does the Sessions-tab copy.
    dropSessionTab(targetSessionId)
    removeCachedView(targetSessionId)
  }, [activeProject])

  const handleCommand = useCallback(
    (cmd: SlashCommand, args: string) => {
      // Slash commands route through the server via WS. The server owns the
      // canonical implementation (execNew / execHelp / execList / skill
      // activation / etc.) so wechat / telegram / web / web-demo / admin all
      // see identical behaviour; a command that moves to another session
      // replies `session:switched`, which opens that session in its own tab
      // (chat-handlers).
      if (!activeProject) return
      // "Start fresh" stays client-side: a new tab is all it takes, and a
      // draft tab sending `/session new` would first create an empty session
      // for itself server-side. `/session new <args>` still goes to the server.
      if (cmd.name === '/clear' || (cmd.name === '/session' && args.trim() === 'new')) {
        newTab()
        return
      }
      // Bootstrap a session id the same way `dispatchMessage` does so a
      // slash command issued in a draft tab still has something for the
      // server's `bindOrCreateSession` to bind to.
      const currentSessionId = sessionId ?? generateId()
      if (!sessionId) bindActiveTabSession(currentSessionId)
      const cmdName = cmd.name.slice(1)
      const agentId = useChatStore.getState().selectedAgentId
      const payload: WsClientMessage = {
        type: `command:${cmdName}`,
        sessionId: currentSessionId,
        projectId: activeProject.id,
        // Same fallback risk as dispatchMessage: without this, a fresh
        // session's first message being a slash command (e.g. switch agent
        // then `/goal create`) hits bindOrCreateSession's `client.agentId`
        // fallback, which is never updated off its connect-time 'default' —
        // the session gets created on the wrong agent.
        ...(agentId !== 'default' ? { agentId } : {}),
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

  return { messages, sendMessage, isStreaming, sessionId, deleteSession, stopGeneration, interruptGeneration, pendingMessages, removePendingMessage, handleCommand }
}
