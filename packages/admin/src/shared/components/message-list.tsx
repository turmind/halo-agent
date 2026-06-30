'use client'

import { useState, useMemo, useRef, useEffect, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ToolCallInfo, ContentBlock } from '@/shared/types'
import { inferMessageType } from '@/shared/types'
import { TaskPlanCard } from '@/features/chat/task-plan-card'
import { MediaAttachments, parseMediaMarkers } from '@/shared/components/media-attachments'
import { cn } from '@/shared/utils'
import { Loader2, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react'

interface MessageListProps {
  messages: ChatMessage[]
  debugMode?: boolean
}

// ═══════════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════════

export function MessageList({ messages, debugMode }: MessageListProps) {
  return <ExchangeView messages={messages} debugMode={debugMode} />
}

// ═══════════════════════════════════════════════════════════════════════
// Exchange grouping (user question + responses)
// ═══════════════════════════════════════════════════════════════════════

interface Exchange {
  user: ChatMessage
  responses: ChatMessage[]
}

function buildExchanges(messages: ChatMessage[]): Exchange[] {
  const exchanges: Exchange[] = []
  let current: Exchange | null = null

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current) exchanges.push(current)
      current = { user: msg, responses: [] }
    } else if (current) {
      current.responses.push(msg)
    } else {
      exchanges.push({ user: msg, responses: [] })
    }
  }
  if (current) exchanges.push(current)
  return exchanges
}

function ExchangeView({ messages, debugMode }: { messages: ChatMessage[]; debugMode?: boolean }) {
  const exchanges = useMemo(() => buildExchanges(messages), [messages])

  return (
    <div className="flex flex-col">
      {exchanges.map((ex) => (
        <ExchangeRow key={ex.user.id} user={ex.user} responses={ex.responses} debugMode={debugMode} />
      ))}
    </div>
  )
}

/**
 * One user-turn + its responses, memoized. During streaming the store mutates
 * only the active assistant message (immutably — every other message keeps its
 * object reference), so all prior exchanges get identical props and skip
 * re-render. Without this the whole list re-ran ReactMarkdown on every token,
 * which made typing stutter as the conversation grew. `buildExchanges` rebuilds
 * the `responses` array each call, so the custom comparator does a shallow
 * element-wise compare instead of trusting the array identity.
 */
const ExchangeRow = memo(function ExchangeRow({
  user, responses, debugMode,
}: { user: ChatMessage; responses: ChatMessage[]; debugMode?: boolean }) {
  return (
    <div className="border-b border-[var(--border)]/50 last:border-b-0">
      {user.role === 'user' ? (
        parseSubAgentReport(user.content) ? (
          <SubAgentReport content={user.content} />
        ) : parseCompactSummary(user.content) ? (
          <CompactSummary content={user.content} />
        ) : (
          <UserExchangeHeader content={user.content} localImages={user.localImages} />
        )
      ) : (
        <div className="px-3 py-2">
          <MessageItem message={user} debugMode={debugMode} />
        </div>
      )}

      {responses.length > 0 && (
        <ExchangeResponses responses={responses} debugMode={debugMode} />
      )}
    </div>
  )
}, (prev, next) =>
  prev.user === next.user &&
  prev.debugMode === next.debugMode &&
  prev.responses.length === next.responses.length &&
  prev.responses.every((m, i) => m === next.responses[i]),
)

/**
 * Sub-agent report detection — messages forwarded from a child session by the
 * `tryReportToParent` path arrive as `user` messages whose content starts with
 * `(from: session <id>)`. They're data inputs to the parent, not things the
 * user typed — render them as a distinct callout instead of hijacking the
 * sticky user bubble.
 */
function parseSubAgentReport(content: string): { sessionId: string; body: string } | null {
  const m = content.match(/^\(from: session ([^)]+)\)\n([\s\S]*)$/)
  if (!m) return null
  return { sessionId: m[1], body: m[2] }
}

function SubAgentReport({ content }: { content: string }) {
  const parsed = parseSubAgentReport(content)!
  const shortId = parsed.sessionId.split('>').pop() ?? parsed.sessionId
  return (
    <div className="sticky top-0 z-10 px-3 py-2 border-b border-slate-900 border-l-2 border-l-emerald-500/70 bg-emerald-950/40 backdrop-blur-sm shadow-sm">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-medium text-emerald-400">
        <span>Report from sub-session</span>
        <span className="rounded bg-emerald-900/40 px-1 py-0.5 font-mono text-emerald-300/80">{shortId}</span>
      </div>
      <CollapsibleContent maxLines={4}>
        <div className="text-xs text-[var(--foreground)] whitespace-pre-wrap leading-relaxed">
          {parsed.body}
        </div>
      </CollapsibleContent>
    </div>
  )
}

/**
 * Compact-summary detection — auto/manual compact writes the LLM-generated
 * summary into the UI log as a `user`-role message starting with the marker
 * `[Conversation Summary — N messages compacted]`. Render it as a distinct
 * callout (purple, parallel to sub-agent report green) so the user can tell
 * "the agent now thinks the prior history is this" at a glance — instead of
 * it impersonating a real user turn in the sticky blue bubble.
 */
function parseCompactSummary(content: string): { olderCount: number; body: string } | null {
  const m = content.match(/^\[Conversation Summary — (\d+) messages compacted\]\n([\s\S]*)$/)
  if (!m) return null
  return { olderCount: parseInt(m[1], 10), body: m[2] }
}

function CompactSummary({ content }: { content: string }) {
  const parsed = parseCompactSummary(content)!
  const [open, setOpen] = useState(false)
  // Default collapsed: only the small purple header is visible. The summary
  // text is the same content the LLM now sees, but it's long (often 1-2 KB
  // of markdown) and noisy in the chat flow — keep it tucked away unless
  // the user explicitly opens it.
  return (
    <div className="sticky top-0 z-10 border-l-2 border-l-purple-500/70 bg-purple-950/40 backdrop-blur-sm shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-[10px] font-medium text-purple-400 hover:bg-purple-900/30 transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>Conversation summary sent to LLM</span>
        <span className="rounded bg-purple-900/40 px-1 py-0.5 font-mono text-purple-300/80">{parsed.olderCount} messages compacted</span>
      </button>
      {open && (
        <div className="px-3 pb-2 text-xs text-[var(--foreground)] whitespace-pre-wrap leading-relaxed max-h-[40vh] overflow-y-auto">
          {parsed.body}
        </div>
      )}
    </div>
  )
}

/** Render exchange responses — in debug mode, interleaves usage badges with assistant content */
function ExchangeResponses({ responses, debugMode }: { responses: ChatMessage[]; debugMode?: boolean }) {
  // Partition usages to their owning assistant message by turnId so each message
  // only sees its own metrics (otherwise every message re-renders them cumulatively).
  const usagesByMessage = useMemo(() => {
    const map = new Map<string, ChatMessage[]>()
    if (!debugMode) return map

    const allUsages = responses.filter((m) => inferMessageType(m) === 'usage' && m.usage)
    if (allUsages.length === 0) return map

    const turnToMsgId = new Map<string, string>()
    for (const msg of responses) {
      if (inferMessageType(msg) !== 'assistant' || !msg.contentBlocks) continue
      for (const b of msg.contentBlocks) {
        if (b.turnId) turnToMsgId.set(b.turnId, msg.id)
      }
    }

    const orphans: ChatMessage[] = []
    for (const u of allUsages) {
      const ownerId = u.turnId ? turnToMsgId.get(u.turnId) : undefined
      if (ownerId) {
        const list = map.get(ownerId) ?? []
        list.push(u)
        map.set(ownerId, list)
      } else {
        orphans.push(u)
      }
    }

    if (orphans.length > 0) {
      const lastAssistant = [...responses].reverse().find((m) => inferMessageType(m) === 'assistant')
      if (lastAssistant) {
        const list = map.get(lastAssistant.id) ?? []
        list.push(...orphans)
        map.set(lastAssistant.id, list)
      }
    }

    return map
  }, [debugMode, responses])

  return (
    <div className="px-3 py-2">
      {responses.map((msg) => (
        <MessageItem key={msg.id} message={msg} debugMode={debugMode} usages={usagesByMessage.get(msg.id)} />
      ))}
    </div>
  )
}

/** Single compact usage badge line */
function UsageLine({ message }: { message: ChatMessage }) {
  const u = message.usage
  if (!u) return null
  const shortModel = message.modelId?.replace(/^global\.anthropic\./, '') ?? ''
  const totalInput = u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0)
  const contextTokens = totalInput + u.outputTokens
  const cachePercent = totalInput > 0 ? Math.round((u.cacheReadInputTokens / totalInput) * 100) : 0
  const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`

  const ts = new Date(message.timestamp)
  const tsLabel = `${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}:${ts.getSeconds().toString().padStart(2, '0')}`
  return (
    <div className="flex flex-wrap items-center gap-1 py-0.5 text-[10px] font-mono text-[var(--muted-foreground)]">
      <span
        className="inline-flex items-center gap-0.5 rounded bg-[var(--secondary)] px-1 py-px opacity-70"
        title={ts.toLocaleString()}
      >{tsLabel}</span>
      <span className="inline-flex items-center gap-0.5 rounded bg-[var(--secondary)] px-1 py-px"><span className="opacity-60">in</span>{(u.inputTokens / 1000).toFixed(1)}K</span>
      <span className="inline-flex items-center gap-0.5 rounded bg-[var(--secondary)] px-1 py-px"><span className="opacity-60">out</span>{(u.outputTokens / 1000).toFixed(1)}K</span>
      <span className="inline-flex items-center gap-0.5 rounded bg-[var(--secondary)] px-1 py-px"><span className="opacity-60">ctx</span>{(contextTokens / 1000).toFixed(1)}K</span>
      {(u.cacheReadInputTokens ?? 0) > 0 && <span className="inline-flex items-center gap-0.5 rounded bg-emerald-900/30 px-1 py-px text-emerald-400"><span className="opacity-60">read</span>{((u.cacheReadInputTokens ?? 0) / 1000).toFixed(1)}K</span>}
      {(u.cacheWriteInputTokens ?? 0) > 0 && <span className="inline-flex items-center gap-0.5 rounded bg-amber-900/30 px-1 py-px text-amber-400"><span className="opacity-60">write</span>{((u.cacheWriteInputTokens ?? 0) / 1000).toFixed(1)}K</span>}
      {cachePercent > 0 && <span className="inline-flex items-center gap-0.5 rounded bg-emerald-900/30 px-1 py-px text-emerald-400"><span className="opacity-60">cache</span>{cachePercent}%</span>}
      {u.ttftMs != null && <span className="inline-flex items-center gap-0.5 rounded bg-[var(--secondary)] px-1 py-px"><span className="opacity-60">ttft</span>{fmtMs(u.ttftMs)}</span>}
      {u.e2eMs != null && <span className="inline-flex items-center gap-0.5 rounded bg-[var(--secondary)] px-1 py-px"><span className="opacity-60">e2e</span>{fmtMs(u.e2eMs)}</span>}
      {u.thinkingEffort && u.thinkingEffort !== 'off' && <span className="inline-flex items-center gap-0.5 rounded bg-purple-900/30 px-1 py-px text-purple-400"><span className="opacity-60">think</span>{u.thinkingEffort}</span>}
      {u.thinkingEffort === 'off' && <span className="inline-flex items-center gap-0.5 rounded bg-[var(--secondary)] px-1 py-px opacity-50">think off</span>}
      {shortModel && <span className="inline-flex items-center gap-0.5 rounded bg-blue-900/30 px-1 py-px text-blue-400">{shortModel}</span>}
    </div>
  )
}

/** Render a single message — debug mode adds usage/context/agent badges inline */
function MessageItem({ message, debugMode, usages }: { message: ChatMessage; debugMode?: boolean; usages?: ChatMessage[] }) {
  const t = inferMessageType(message)
  const isAssistant = t === 'assistant'

  // Build usage lookup by turnId (debug mode only). Must run before any early
  // return — hooks can't be called conditionally (rules-of-hooks).
  const usageByTurn = useMemo(() => {
    if (!debugMode || !isAssistant || !usages?.length) return null
    const map = new Map<string, ChatMessage>()
    for (const u of usages) { if (u.turnId) map.set(u.turnId, u) }
    return map.size > 0 ? map : null
  }, [debugMode, isAssistant, usages])

  // tool_call / tool_result: always hidden (already shown inline in assistant messages)
  if (t === 'tool_call' || t === 'tool_result') return null

  // usage: interleaved into assistant messages via turnId matching
  if (t === 'usage') return null
  // context: shown via dedicated Prompt button, not inline
  if (t === 'context') return null

  // agent_start / agent_done: only in debug mode
  if (t === 'agent_start' || t === 'agent_done') {
    if (!debugMode) return null
    return (
      <div className="my-0.5 px-1">
        <span className={cn('inline-block rounded px-1.5 py-0.5 text-[9px]', t === 'agent_start' ? 'bg-blue-900/40 text-blue-400' : 'bg-emerald-900/40 text-emerald-400')}>
          {message.agentName ?? 'Agent'}: {message.content || (t === 'agent_start' ? 'started' : 'done')}
        </span>
      </div>
    )
  }

  // Assistant + notification: render the same in both modes
  const hasBlocks = isAssistant && message.contentBlocks && message.contentBlocks.length > 0

  if (message.streaming && !message.content && !message.toolCalls?.length) {
    return (
      <div className="flex items-center gap-1.5 py-1">
        <Loader2 className="h-3 w-3 animate-spin text-[var(--primary)]" />
        <span className="text-xs text-[var(--muted-foreground)]">Thinking...</span>
      </div>
    )
  }

  const elements: React.ReactNode[] = []

  if (hasBlocks) {
    const blocks = message.contentBlocks!
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (block.type === 'thinking' && block.text.trim() && debugMode) {
        elements.push(<ThinkingBlock key={`b${i}`} text={block.text} />)
      } else if (block.type === 'text' && block.text.trim()) {
        elements.push(<TextBlock key={`b${i}`} text={block.text} />)
      } else if (block.type === 'tool_call') {
        const idx = blocks.slice(0, i + 1).filter((b) => b.type === 'tool_call').length - 1
        const isLast = idx === (message.toolCalls?.length ?? 0) - 1
        elements.push(<InlineToolCall key={`b${i}`} call={block.toolCall} isStreaming={message.streaming} isLast={isLast} />)
      }
      // Insert usage badge at end of each turn (when next block has different turnId, or this is last block)
      if (usageByTurn && block.turnId) {
        const nextTurnId = blocks[i + 1]?.turnId
        if (!nextTurnId || nextTurnId !== block.turnId) {
          const u = usageByTurn.get(block.turnId)
          if (u) elements.push(<UsageLine key={`u${block.turnId}`} message={u} />)
        }
      }
    }
    // Fallback: usages scoped to this message but whose turnId didn't match any block
    if (usageByTurn) {
      const rendered = new Set(blocks.map((b) => b.turnId).filter(Boolean))
      for (const [turnId, u] of usageByTurn) {
        if (!rendered.has(turnId)) elements.push(<UsageLine key={`u${turnId}`} message={u} />)
      }
    }
  } else {
    // Legacy: no contentBlocks
    if (isAssistant && message.toolCalls && message.toolCalls.length > 0) {
      message.toolCalls.forEach((tc, i) => {
        elements.push(<InlineToolCall key={`tc${i}`} call={tc} isStreaming={message.streaming} isLast={i === message.toolCalls!.length - 1} />)
      })
    }
    // Legacy: render usages scoped to this message (already partitioned by ExchangeResponses)
    if (usageByTurn) {
      for (const [turnId, u] of usageByTurn) elements.push(<UsageLine key={`u${turnId}`} message={u} />)
    }
    if (message.content) {
      // Live "Compacting context (XXK tokens)…" notice — show a spinner
      // alongside the text so the user knows the LLM call is still in
      // flight. The "Auto-compacted N older messages" success message that
      // follows is a separate notification, so this spinner just naturally
      // disappears when compaction completes.
      const isCompactingNotice = !isAssistant && /^Compacting context /.test(message.content)
      elements.push(
        isAssistant
          ? <TextBlock key="txt" text={message.content} />
          : isCompactingNotice
            ? <span key="txt" className="inline-flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                <span className="whitespace-pre-wrap">{message.content}</span>
              </span>
            : <span key="txt" className="text-xs text-[var(--muted-foreground)] whitespace-pre-wrap">{message.content}</span>
      )
    }
  }

  if (message.plan) elements.push(<div key="plan" className="mt-2"><TaskPlanCard plan={message.plan} /></div>)

  return <div className="py-1">{elements}</div>
}

// ═══════════════════════════════════════════════════════════════════════
// Shared components
// ═══════════════════════════════════════════════════════════════════════

const PROSE_CLS = 'prose prose-sm prose-invert max-w-none prose-p:my-1.5 prose-headings:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:my-2 prose-code:text-amber-300 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-[var(--secondary)] prose-pre:border prose-pre:border-[var(--border)] prose-a:text-[var(--primary)] prose-code:bg-[var(--secondary)] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-th:border prose-th:border-[var(--border)] prose-th:px-2 prose-th:py-1 prose-th:bg-[var(--secondary)] prose-td:border prose-td:border-[var(--border)] prose-td:px-2 prose-td:py-1'

function ThinkingBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="my-1 rounded border border-purple-900/50 bg-purple-950/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-purple-400 hover:bg-purple-900/20 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">Thinking</span>
        <span className="text-[10px] text-purple-400/60">{text.length.toLocaleString()} chars</span>
      </button>
      {expanded && (
        <pre className="px-2 pb-2 text-[11px] text-[var(--foreground)] whitespace-pre-wrap break-words leading-relaxed max-h-[50vh] overflow-y-auto">{text}</pre>
      )}
    </div>
  )
}

/** User exchange header — the sticky text bubble with media chips in a non-sticky row below.
 *  The chips are rendered outside the sticky block so that the next exchange's sticky header
 *  doesn't cover them when scrolled.
 */
function UserExchangeHeader({ content, localImages }: { content: string; localImages?: string[] }) {
  const { text, media } = useMemo(() => parseMediaMarkers(content), [content])
  const [zoom, setZoom] = useState<string | null>(null)
  return (
    <>
      <div className="sticky top-0 z-10 bg-slate-800 border-b border-slate-900 border-l-2 border-l-blue-500 px-4 py-2.5 shadow-sm">
        <CollapsibleContent maxLines={2}>
          <div className="text-xs text-slate-100 leading-relaxed whitespace-pre-wrap">
            {text || (media.length > 0 || localImages?.length ? '(attachment)' : '')}
          </div>
        </CollapsibleContent>
      </div>
      {/* Client-only inline previews (e.g. desktop screen captures) — render
          straight from the data URL, click to zoom. */}
      {localImages && localImages.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-[var(--border)]/30">
          {localImages.map((src, i) => (
            <img
              key={i}
              src={src}
              alt="screenshot"
              onClick={() => setZoom(src)}
              className="max-h-40 max-w-[240px] cursor-pointer rounded border border-[var(--border)] object-contain hover:ring-1 hover:ring-[var(--primary)]/40"
            />
          ))}
        </div>
      )}
      {media.length > 0 && (
        <div className="px-4 py-2 border-b border-[var(--border)]/30">
          <MediaAttachments media={media} />
        </div>
      )}
      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setZoom(null)}>
          <img src={zoom} alt="screenshot" className="max-h-[90vh] max-w-[92vw] object-contain" />
        </div>
      )}
    </>
  )
}

function TextBlock({ text }: { text: string }) {
  const { text: parsed, media } = useMemo(() => parseMediaMarkers(text), [text])
  // Hide the LLM's control markers, never meant for the user to read:
  //  • <<<CAPTURE>>>      — request a screenshot (handled in chat-handlers)
  //  • <<<SHOW: …js… >>>  — drive the visual face (forwarded to the preview)
  // Stripped at render so they stay hidden during streaming too, not just after
  // completion. SHOW uses the same non-greedy dot-all pattern as the handler so
  // the two never disagree on where a marker ends.
  const stripped = useMemo(
    () => parsed.replace(/<<<CAPTURE>>>/g, '').replace(/<<<SHOW:[\s\S]*?>>>/g, '').trim(),
    [parsed],
  )
  return (
    <div className={PROSE_CLS}>
      {stripped && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            pre({ children }) { return <pre className="overflow-x-auto">{children}</pre> },
            code({ className, children, ...props }) {
              const isBlock = className?.startsWith('language-') || String(children).includes('\n')
              if (isBlock) return <ChatCodeBlock className={className}>{children}</ChatCodeBlock>
              return <code className={className} {...props}>{children}</code>
            },
          }}
        >
          {stripped}
        </ReactMarkdown>
      )}
      <MediaAttachments media={media} />
    </div>
  )
}

// ─── Tool call formatting helpers ───

function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch { return null }
}

function formatToolInput(name: string, input: string): { summary: string; detail?: string } {
  const obj = tryParseJson(input)
  if (obj) {
    switch (name) {
      case 'shell_exec': return { summary: String(obj.command ?? obj.cmd ?? '') || input }
      case 'file_read': return { summary: String(obj.path ?? obj.file ?? obj.filePath ?? '') || input }
      case 'file_write': { const p = String(obj.path ?? obj.file ?? obj.filePath ?? ''); const c = String(obj.content ?? ''); return { summary: p, detail: c ? `${c.length} chars` : undefined } }
      case 'file_edit': return { summary: String(obj.path ?? obj.file ?? obj.filePath ?? '') }
      case 'file_list': return { summary: String(obj.path ?? obj.directory ?? obj.dir ?? '.') }
      case 'grep': { const p = String(obj.pattern ?? obj.query ?? ''); const path = obj.path ? ` in ${obj.path}` : ''; const inc = obj.include ? ` (${obj.include})` : ''; return { summary: `"${p}"${path}${inc}` } }
      case 'glob': { const p = String(obj.pattern ?? obj.glob ?? ''); const path = obj.path ? ` in ${obj.path}` : ''; return { summary: `${p}${path}` } }
      case 'web_fetch': return { summary: String(obj.url ?? '') }
      case 'delegate_task': { const a = String(obj.agent_id ?? ''); const t = String(obj.task ?? obj.input ?? ''); const preview = t.length > 100 ? t.slice(0, 100) + '...' : t; return { summary: a ? `→ ${a}: ${preview}` : preview } }
    }
  }
  // Full input — the collapsed row CSS-truncates it to one line, and the
  // expanded IN box wants the whole thing (e.g. a multi-line shell_exec
  // command persisted as a raw string by the snapshot path).
  return { summary: input }
}

function formatToolOutput(_name: string, output: string): string {
  const obj = tryParseJson(output)
  if (obj) {
    const toolResult = obj.toolResult as Record<string, unknown> | undefined
    if (toolResult?.content) {
      const content = toolResult.content as Array<{ text?: string }>
      if (Array.isArray(content) && content.length > 0 && content[0].text) return content[0].text
    }
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.result === 'string') return obj.result
    if (typeof obj.output === 'string') return obj.output
  }
  return output
}

// Sentinel markers emitted by tools (see server agent-loop.ts). Tools opt
// in by prepending the marker as the first line of their output; the UI
// uses it as a structural status flag instead of grepping the body (which
// historically painted file_read red whenever the source file mentioned
// exception classes in a docstring).
const TOOL_ERROR_MARKER = '__TOOL_ERROR__'
const TOOL_WARN_MARKER = '__TOOL_WARN__'

/** Strip a leading marker line from the displayed output — the marker is
 *  metadata for the UI, never something the user wants to read. */
function stripToolMarker(out: string): string {
  if (out.startsWith(TOOL_ERROR_MARKER + '\n')) return out.slice(TOOL_ERROR_MARKER.length + 1)
  if (out.startsWith(TOOL_WARN_MARKER + '\n')) return out.slice(TOOL_WARN_MARKER.length + 1)
  return out
}

function getToolStatus(call: ToolCallInfo, isStreaming?: boolean, isLast?: boolean): 'running' | 'success' | 'warn' | 'error' {
  if (!call.output && call.output !== '') {
    if (isStreaming && isLast) return 'running'
    return 'running'
  }
  const out = call.output ?? ''
  if (out.startsWith(TOOL_ERROR_MARKER)) return 'error'
  if (out.startsWith(TOOL_WARN_MARKER)) return 'warn'
  return 'success'
}

const STATUS_COLORS = { running: 'bg-amber-400 animate-pulse', success: 'bg-emerald-400', warn: 'bg-yellow-400', error: 'bg-red-400' }

// ─── Debug components ───

function DebugToolCall({ toolName, toolInput, toolOutput, durationMs }: { toolName: string; toolInput: unknown; toolOutput?: unknown; durationMs?: number }) {
  const [expanded, setExpanded] = useState(false)
  const inputStr = useMemo(() => {
    if (!toolInput) return ''
    if (typeof toolInput === 'string') return toolInput
    return JSON.stringify(toolInput, null, 2)
  }, [toolInput])

  const rawOutput = useMemo(() => {
    if (toolOutput === undefined) return null
    return typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
  }, [toolOutput])
  const formattedOutput = useMemo(() => {
    if (rawOutput === null) return null
    return formatToolOutput(toolName, stripToolMarker(rawOutput))
  }, [toolName, rawOutput])

  const hasOutput = formattedOutput !== null
  const isError = rawOutput !== null && rawOutput.startsWith(TOOL_ERROR_MARKER)
  const isWarn = rawOutput !== null && rawOutput.startsWith(TOOL_WARN_MARKER)
  const statusColor = !hasOutput ? 'bg-blue-400' : isError ? 'bg-red-400' : isWarn ? 'bg-yellow-400' : 'bg-emerald-400'
  const outputColor = isError ? 'text-red-400' : isWarn ? 'text-yellow-300' : 'text-[var(--foreground)]'
  const durationLabel = durationMs != null ? (durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`) : null
  const { summary } = useMemo(() => formatToolInput(toolName, typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput ?? {})), [toolName, toolInput])

  return (
    <div className="my-0.5 text-[12px] font-mono">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--secondary)]/60 transition-colors text-left">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', statusColor)} />
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />}
        <span className="shrink-0 font-semibold text-[var(--foreground)]">{toolName}</span>
        <span className="truncate text-[var(--muted-foreground)]">{summary}</span>
        {durationLabel && <span className="shrink-0 text-[var(--muted-foreground)] opacity-60">{durationLabel}</span>}
      </button>
      {expanded && (
        <div className="ml-[22px] mt-0.5 mb-1 rounded border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          <div className={cn(hasOutput && 'border-b border-[var(--border)]', 'px-2.5 py-1.5')}>
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] opacity-60 mb-0.5">IN</div>
            <pre className="text-[11px] text-[var(--foreground)] whitespace-pre-wrap break-all leading-relaxed max-h-[400px] overflow-y-auto">{inputStr}</pre>
          </div>
          {hasOutput && (
            <div className="px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] opacity-60 mb-0.5">OUT</div>
              <pre className={cn('text-[11px] whitespace-pre-wrap break-all leading-relaxed max-h-[200px] overflow-y-auto', outputColor)}>{formattedOutput}</pre>
            </div>
          )}
        </div>
      )}
      {!expanded && hasOutput && formattedOutput && (
        <div className="ml-[22px] text-[11px] text-[var(--muted-foreground)] truncate">
          {formattedOutput.length > 120 ? formattedOutput.slice(0, 120) + '...' : formattedOutput}
        </div>
      )}
    </div>
  )
}

function DebugToolResult({ toolOutput, durationMs }: { toolOutput: unknown; durationMs?: number }) {
  const [expanded, setExpanded] = useState(false)
  const rawStr = useMemo(() => {
    if (!toolOutput) return ''
    if (typeof toolOutput === 'string') return toolOutput
    return JSON.stringify(toolOutput, null, 2)
  }, [toolOutput])
  const isError = rawStr.startsWith(TOOL_ERROR_MARKER)
  const isWarn = rawStr.startsWith(TOOL_WARN_MARKER)
  const outputStr = useMemo(() => {
    const stripped = stripToolMarker(rawStr) || '(empty)'
    if (typeof toolOutput === 'string') {
      try { return JSON.stringify(JSON.parse(stripped), null, 2) } catch { return stripped }
    }
    return stripped
  }, [rawStr, toolOutput])

  const dotColor = isError ? 'bg-red-400' : isWarn ? 'bg-yellow-400' : 'bg-emerald-400'
  const textColor = isError ? 'text-red-400' : isWarn ? 'text-yellow-300' : 'text-[var(--foreground)]'
  const durationLabel = durationMs != null ? (durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`) : null

  return (
    <div className="my-0.5 text-[12px] font-mono">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--secondary)]/60 transition-colors text-left">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dotColor)} />
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />}
        <span className="shrink-0 font-semibold text-[var(--muted-foreground)]">Result</span>
        {durationLabel && <span className="shrink-0 text-[var(--muted-foreground)] opacity-60">{durationLabel}</span>}
        {!expanded && <span className="truncate text-[var(--muted-foreground)]">{outputStr.slice(0, 120)}</span>}
      </button>
      {expanded && (
        <div className="ml-[22px] mt-0.5 mb-1 rounded border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          <div className="px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] opacity-60 mb-0.5">OUTPUT</div>
            <pre className={cn('text-[11px] whitespace-pre-wrap break-all leading-relaxed max-h-[400px] overflow-y-auto', textColor)}>{outputStr}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Inline tool call (used in normal mode assistant messages) ───

function InlineToolCall({ call, isStreaming, isLast }: { call: ToolCallInfo; isStreaming?: boolean; isLast?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const status = getToolStatus(call, isStreaming, isLast)
  const hasOutput = call.output !== undefined && call.output !== ''
  const { summary } = useMemo(() => formatToolInput(call.name, call.input), [call.name, call.input])
  // Strip the structural marker before formatting/displaying — the marker
  // belongs to the UI status flag, not the message body.
  const formattedOutput = useMemo(() => hasOutput ? formatToolOutput(call.name, stripToolMarker(call.output!)) : '', [call.name, call.output, hasOutput])
  const outputPreview = formattedOutput.length > 120 ? formattedOutput.slice(0, 120) + '...' : formattedOutput
  const outputColor = status === 'error' ? 'text-red-400' : status === 'warn' ? 'text-yellow-300' : 'text-[var(--foreground)]'

  return (
    <div className="my-0.5 text-[12px] font-mono">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--secondary)]/60 transition-colors text-left group">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_COLORS[status])} />
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />}
        <span className="shrink-0 font-semibold text-[var(--foreground)]">{call.name}</span>
        <span className="truncate text-[var(--muted-foreground)]">{summary}</span>
      </button>
      {expanded && (
        <div className="ml-[22px] mt-0.5 mb-1 rounded border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          <div className="border-b border-[var(--border)] px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] opacity-60 mb-0.5">IN</div>
            <pre className="text-[11px] text-[var(--foreground)] whitespace-pre-wrap break-all leading-relaxed">{summary}</pre>
          </div>
          {hasOutput && (
            <div className="px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)] opacity-60 mb-0.5">OUT</div>
              <pre className={cn('text-[11px] whitespace-pre-wrap break-all leading-relaxed max-h-[200px] overflow-y-auto', outputColor)}>{formattedOutput}</pre>
            </div>
          )}
          {status === 'running' && (
            <div className="px-2.5 py-1.5 flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
              <span className="text-[11px] text-[var(--muted-foreground)]">Running...</span>
            </div>
          )}
        </div>
      )}
      {!expanded && hasOutput && outputPreview && (
        <div className="ml-[22px] text-[11px] text-[var(--muted-foreground)] truncate">{outputPreview}</div>
      )}
    </div>
  )
}

// ─── Utility components ───

function CollapsibleContent({ children, maxLines = 2, className }: { children: React.ReactNode; maxLines?: number; className?: string }) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [clamped, setClamped] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Measure with a ResizeObserver, not a one-shot setTimeout. The content
  // lives inside a `display:none`-toggled panel (the chat tab in
  // bottom-panel.tsx hides via `'hidden'` rather than unmounting), and
  // sub-agent reports arrive asynchronously — usually while the user is on
  // another tab, so the panel is hidden at mount. A `display:none` element
  // reports `scrollHeight === 0`, so a one-shot measure read 0, decided "not
  // overflowing", and — because ExchangeRow is memoized and the report
  // content never changes again — never re-measured: the Show more button
  // never appeared and long reports rendered fully expanded. A
  // ResizeObserver re-fires when the panel becomes visible (0 → real
  // height), so the measure self-corrects.
  //
  // The callback runs after layout (never mid-render), and the idempotent
  // `prev === next ? prev` guard plus the hysteresis gap (threshold
  // `maxLines*20 + 4` vs the `maxLines*20` clamp height) keep it from
  // oscillating — the feedback loop that previously caused React error #185.
  // After the clamp lands, the element's box height stops changing, so the
  // observer goes quiet instead of re-triggering on every streamed chunk.
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const threshold = maxLines * 20 + 4
    const ro = new ResizeObserver(() => {
      const next = el.scrollHeight > threshold
      setClamped((prev) => prev === next ? prev : next)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [maxLines])

  return (
    <div className={cn('relative', className)}>
      {clamped && (
        <button onClick={() => setExpanded(!expanded)} className="absolute top-0 right-0 text-[11px] text-[var(--primary)] hover:underline z-10">
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <div ref={contentRef} style={!expanded && clamped ? { maxHeight: `${maxLines * 20}px`, overflow: 'hidden' } : undefined}>
        {children}
      </div>
    </div>
  )
}

function ChatCodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false)
  const code = String(children).replace(/\n$/, '')
  const lang = className?.replace('language-', '') || ''

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  return (
    <div className="relative group">
      {lang && <span className="absolute top-1 left-2 text-[9px] text-[var(--muted-foreground)] opacity-60">{lang}</span>}
      <button onClick={handleCopy} className="absolute top-1 right-1 rounded p-1 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 hover:bg-[var(--accent)] transition-opacity">
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      </button>
      <code className={className}>{children}</code>
    </div>
  )
}
