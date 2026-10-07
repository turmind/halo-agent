/**
 * Pure halo → ACP `session/update` builders, shared by the live prompt
 * stream and the `session/load` replay so a tool call looks the same
 * either way.
 */
import type { HistoryMessage, HistoryToolCall } from './halo-client.js'

export type ToolKind = 'read' | 'edit' | 'search' | 'execute' | 'fetch' | 'other'

const TOOL_KINDS: Record<string, ToolKind> = {
  file_read: 'read',
  file_write: 'edit',
  file_edit: 'edit',
  shell_exec: 'execute',
  grep: 'search',
  glob: 'search',
  file_list: 'search',
  web_fetch: 'fetch',
}

export function toolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? 'other'
}

/** Most telling argument first: grep has both `pattern` and `path`. */
const TITLE_ARGS = ['command', 'pattern', 'url', 'path'] as const
const TITLE_ARG_MAX = 80

/** "shell_exec: ls -la" — tool name plus the first 80 chars of its key
 *  argument, whitespace collapsed (titles are one-line labels). */
export function toolTitle(toolName: string, input: unknown): string {
  const arg = titleArg(input)?.replace(/\s+/g, ' ').trim()
  return arg ? `${toolName}: ${arg.slice(0, TITLE_ARG_MAX)}` : toolName
}

function titleArg(input: unknown): string | undefined {
  // The UI log stores the formatted input (formatToolInput): the bare
  // path / command, or JSON for any other tool.
  if (typeof input === 'string') {
    if (!input.startsWith('{')) return input
    try { return titleArg(JSON.parse(input) as unknown) } catch { return input }
  }
  const value = input
  if (!value || typeof value !== 'object') return undefined
  for (const key of TITLE_ARGS) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

export function textChunk(kind: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk', text: string) {
  return { sessionUpdate: kind, content: { type: 'text', text } }
}

export function toolResultContent(text: string) {
  return [{ type: 'content', content: { type: 'text', text } }]
}

/** Same cap the web SSE `tool_result` frame applies, so a replayed tool
 *  shows what the live stream showed and a long session's replay stays
 *  bounded (the UI log keeps full outputs). */
const REPLAY_OUTPUT_MAX = 500

function replayToolCall(tc: HistoryToolCall, fallbackId: string) {
  const output = tc.output?.slice(0, REPLAY_OUTPUT_MAX)
  return {
    sessionUpdate: 'tool_call',
    toolCallId: tc.toolUseId || `replay-${fallbackId}`,
    title: toolTitle(tc.name, tc.input),
    kind: toolKind(tc.name),
    status: 'completed',
    rawInput: tc.input,
    ...(output !== undefined ? { rawOutput: output, content: toolResultContent(output) } : {}),
  }
}

/**
 * The whole conversation as `session/update`s, in log order (ACP
 * session-setup "Loading Sessions": the agent MUST replay the entire
 * conversation).
 *
 *   user                → user_message_chunk
 *   assistant blocks    → agent_thought_chunk / tool_call / agent_message_chunk,
 *                         interleaved as they happened
 *   everything else     → skipped: usage / context / notification /
 *                         agent_start|done, and the standalone tool_call /
 *                         tool_result rows (the assistant message's blocks
 *                         carry the same call WITH its output + toolUseId)
 *
 * Soft-deleted turns are skipped too — they're out of the agent's context.
 */
export function replayUpdates(messages: HistoryMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  messages.forEach((m, i) => {
    if (m.deleted || m.taskId) return
    if (m.role === 'user') {
      if (m.content) out.push(textChunk('user_message_chunk', m.content))
      return
    }
    if (m.role !== 'assistant') return
    const msgKey = m.id ?? String(i)
    if (m.contentBlocks && m.contentBlocks.length > 0) {
      m.contentBlocks.forEach((b, j) => {
        if (b.type === 'tool_call') out.push(replayToolCall(b.toolCall, `${msgKey}-${j}`))
        else if (b.text) out.push(textChunk(b.type === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk', b.text))
      })
      return
    }
    // Legacy layout (no contentBlocks): tools first, then the text — the
    // admin's rendering order for these files (design/storage.md).
    m.toolCalls?.forEach((tc, j) => out.push(replayToolCall(tc, `${msgKey}-${j}`)))
    if (m.content) out.push(textChunk('agent_message_chunk', m.content))
  })
  return out
}

/** Same marker the server strips from SSE `stream` text (channels/shared/
 *  media.ts MEDIA_MARKER_RE) — the UI log keeps it, so strip it here too or
 *  a reply with a media marker never compares equal to what was streamed. */
const MEDIA_MARKER_RE = /^MEDIA:\s*(\S.*?)\s*$/gm

/** Strip marker lines the way the stream does: the server applies the regex
 *  to chunks flushed at a line end, where its `\s*$` also eats the marker's
 *  newline. On the joined log text that newline survives (`$` stops before
 *  the next line), leaving a blank line the stream never had — so apply it
 *  one line (with its `\n`) at a time. */
function stripMediaLines(text: string): string {
  return text.split(/(?<=\n)/).map((line) => line.replace(MEDIA_MARKER_RE, '')).join('')
}

/**
 * The assistant text of the turn `prompt` started, as the web SSE would
 * have streamed it: every assistant message after the latest user entry
 * that is our prompt (the server appends a `[语音已保存: …]` tail when
 * non-image media was attached, hence the prefix form). Matching our own
 * prompt — not just "the last user message" — keeps a sub-agent report
 * that landed mid-turn (also a user-role entry) from cutting the reply
 * short. '' when the prompt never reached the log.
 */
export function replyAfterPrompt(messages: HistoryMessage[], prompt: string): string {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && (m.content === prompt || m.content.startsWith(prompt + '\n\n'))) { start = i; break }
  }
  if (start === -1) return ''
  return stripMediaLines(messages
    .slice(start + 1)
    .filter((m) => m.role === 'assistant' && !m.deleted && !m.taskId)
    .map((m) => m.content)
    .join(''))
}
