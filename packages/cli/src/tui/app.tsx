import { useEffect, useMemo, useReducer, useState, useRef } from 'react'
import type { ReactElement } from 'react'
import { Box, useApp, useInput } from 'ink'
import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'
import type { Harness } from '../harness.js'
import { renderMarkdown } from '../render-md.js'
import { resolveRefs } from '../resolve-refs.js'
import type { ChatBlock } from './types.js'
import { Messages } from './components/messages.js'
import { Streaming } from './components/streaming.js'
import { loadHistory, appendHistory } from './history.js'
import { StatusBar } from './components/status-bar.js'
import { InputBox } from './components/input-box.js'
import { LogNavigator } from './components/log-navigator.js'
import { LogViewer, type LogLine } from './components/log-viewer.js'
import type { SlashItem } from './components/slash-suggest.js'
import type { SessionTreeNode } from '../harness.js'

const MAX_CONTEXT_TOKENS_FALLBACK = 200_000

interface AppProps {
  harness: Harness
  /** Initial verbose mode (`halo tui -v`); /verbose toggles it at runtime. */
  verbose: boolean
}

/** In-progress sub-agent stats so we can roll them up into a sub-done block. */
interface SubAgentStats {
  taskId: string
  agentName: string
  toolCount: number
  startedAt: number
  /** Currently running tool name (for live status display). */
  currentTool: string | null
}

interface State {
  blocks: ChatBlock[]
  liveText: string
  liveThinking: string | null
  spinnerLabel: string | null
  /** Whether a turn is currently running — disables input. */
  running: boolean
  /** Last observed model id (for status bar). */
  modelId: string | null
  /** Last observed context-token snapshot. */
  contextTokens: number | null
  /** taskId → agent display name, learned from agent_start events. */
  agentNameByTaskId: Map<string, string>
  /** Latest top-level agent name for status bar. */
  rootAgentName: string
  /** Active sub-agents keyed by taskId — tracks tool count + current tool for live display. */
  subAgents: Map<string, SubAgentStats>
  /** Verbose mode. Seeded from `halo tui -v`, toggled at runtime with
   *  /verbose. Committed <Static> blocks are immutable, so a toggle only
   *  affects blocks rendered after it. */
  verbose: boolean
  /** Buffered root-tool input awaiting its tool_result (for verbose mode). */
  pendingToolInput: string | null
  /** Buffered key-argument summary (path / command / …) for the same block. */
  pendingToolArg: string | null
  /** Buffered root-tool name awaiting its tool_result. The server's
   *  tool_result event carries no toolName (only tool_call does), so without
   *  this the block renders as "⚙ ?". Root runs tools sequentially, so a
   *  single slot (not a map) is enough. */
  pendingToolName: string | null
  /** Epoch ms when the current turn started — drives the elapsed-seconds
   *  counter next to the spinner. Null when idle. */
  turnStartedAt: number | null
}

type Action =
  | { type: 'event'; event: AgentSessionEvent }
  | { type: 'append-user'; text: string }
  | { type: 'append-system'; text: string }
  | { type: 'append-error'; text: string }
  | { type: 'turn-start' }
  | { type: 'workspace-switched'; text: string }
  | { type: 'load-history'; blocks: ChatBlock[] }
  | { type: 'toggle-verbose' }

let blockSeq = 0
function nextId(): string { return `b${++blockSeq}` }

function initialState(verbose: boolean): State {
  return {
    blocks: [],
    liveText: '',
    liveThinking: null,
    spinnerLabel: null,
    running: false,
    modelId: null,
    contextTokens: null,
    agentNameByTaskId: new Map(),
    rootAgentName: 'agent',
    subAgents: new Map(),
    verbose,
    pendingToolInput: null,
    pendingToolArg: null,
    pendingToolName: null,
    turnStartedAt: null,
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + '…'
}

/** Keep the tail of a path-like string — the filename end is the telling part. */
function truncateTail(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return '…' + s.slice(-maxLen)
}

/**
 * One-glance summary of a tool call's key argument for the tool block header:
 * `⚙ file_read hello.txt 5ms` instead of `⚙ file_read 5ms`. Best-effort — an
 * unknown tool (or missing field) just renders no summary.
 */
function summarizeToolInput(toolName: string, input: unknown): string | null {
  if (input == null || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
  switch (toolName) {
    case 'file_read':
    case 'file_write':
    case 'file_edit':
    case 'view_image':
      return truncateTail(str(o.path) ?? '', 40) || null
    case 'file_list':
      return truncateTail(str(o.path) ?? '.', 40)
    case 'shell_exec': {
      const cmd = str(o.command)
      if (!cmd) return null
      return truncate(cmd.split('\n')[0]!, 40)
    }
    case 'grep':
    case 'glob':
      return truncate(str(o.pattern) ?? '', 40) || null
    case 'web_fetch':
      return truncateTail(str(o.url) ?? '', 40) || null
    case 'activate_skill':
      return str(o.skill_id)
    case 'start_session':
    case 'query_agent':
      return str(o.agent_id)
    default:
      return null
  }
}

function truncateLines(s: string, maxLines: number, maxLineLen: number): string {
  const lines = s.split('\n')
  const head = lines.slice(0, maxLines).map((l) => truncate(l, maxLineLen))
  if (lines.length > maxLines) head.push(`… (+${lines.length - maxLines} lines)`)
  return head.join('\n')
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
}

/**
 * Convert persisted SessionMessage[] into LogLine[] for the viewer. Each
 * message expands to one timestamp/header line plus zero or more body lines,
 * with ANSI colors per message kind.
 */
function messagesToLogLines(messages: unknown[]): LogLine[] {
  const lines: LogLine[] = []
  for (const raw of messages) {
    const m = raw as {
      role?: string
      content?: string
      agentName?: string
      toolName?: string
      toolInput?: unknown
      toolOutput?: unknown
      durationMs?: number
      timestamp?: number
      contentBlocks?: Array<{ type: string; text?: string }>
      usage?: {
        inputTokens?: number; outputTokens?: number; totalTokens?: number
        cacheReadInputTokens?: number; cacheWriteInputTokens?: number
        ttftMs?: number; e2eMs?: number; thinkingEffort?: string
      }
      modelId?: string
      type?: string
    }
    const ts = m.timestamp ? formatTs(m.timestamp) : '--:--:--'
    const tsStr = `${ANSI.gray}${ts}${ANSI.reset}`

    if (m.toolName) {
      const dur = m.durationMs != null ? ` ${ANSI.dim}${m.durationMs}ms${ANSI.reset}` : ''
      lines.push({ text: `${tsStr} ${ANSI.yellow}⚙ ${m.toolName}${ANSI.reset}${dur}` })
      if (m.toolInput !== undefined) {
        const args = safeJson(m.toolInput, 200)
        lines.push({ text: `         ${ANSI.gray}args: ${args}${ANSI.reset}` })
      }
      if (m.toolOutput !== undefined) {
        const out = typeof m.toolOutput === 'string' ? m.toolOutput : safeJson(m.toolOutput, 600)
        for (const line of out.split('\n').slice(0, 8)) {
          lines.push({ text: `         ${ANSI.gray}│ ${line}${ANSI.reset}` })
        }
      }
      continue
    }

    if (m.usage) {
      const u = m.usage
      const inT = u.inputTokens ?? 0
      const outT = u.outputTokens ?? 0
      const cr = u.cacheReadInputTokens ?? 0
      const cw = u.cacheWriteInputTokens ?? 0
      const ctx = inT + cr + cw + outT
      const parts: string[] = [
        `${ANSI.dim}in${ANSI.reset} ${fmtK(inT)}`,
        `${ANSI.dim}out${ANSI.reset} ${fmtK(outT)}`,
        `${ANSI.dim}ctx${ANSI.reset} ${fmtK(ctx)}`,
      ]
      if (cr > 0) parts.push(`${ANSI.green}read ${fmtK(cr)}${ANSI.reset}`)
      if (cw > 0) parts.push(`${ANSI.yellow}write ${fmtK(cw)}${ANSI.reset}`)
      if (u.ttftMs != null) parts.push(`${ANSI.dim}ttft${ANSI.reset} ${fmtMs(u.ttftMs)}`)
      if (u.e2eMs != null) parts.push(`${ANSI.dim}e2e${ANSI.reset} ${fmtMs(u.e2eMs)}`)
      if (u.thinkingEffort && u.thinkingEffort !== 'off') {
        parts.push(`${ANSI.magenta}think ${u.thinkingEffort}${ANSI.reset}`)
      }
      if (m.modelId) parts.push(`${ANSI.blue}${shortModel(m.modelId)}${ANSI.reset}`)
      lines.push({ text: `${tsStr} ${ANSI.dim}·${ANSI.reset} ${parts.join('  ')}` })
      continue
    }

    // Render thinking blocks (assistant message contentBlocks).
    if (m.contentBlocks && m.contentBlocks.length > 0) {
      const tag = m.agentName ? `${ANSI.dim}[${m.agentName}]${ANSI.reset} ` : ''
      let headerWritten = false
      for (const block of m.contentBlocks) {
        if (block.type === 'thinking' && block.text) {
          if (!headerWritten) {
            lines.push({ text: `${tsStr} ${tag}${ANSI.magenta}✻ thinking${ANSI.reset}` })
            headerWritten = true
          }
          for (const l of block.text.split('\n')) {
            lines.push({ text: `         ${ANSI.magenta}${ANSI.dim}${l}${ANSI.reset}` })
          }
        }
      }
      // Fall through — assistant-text is rendered below from `content`.
    }

    const content = (m.content ?? '').trim()
    if (!content) continue
    const role = m.role ?? 'system'
    const tag = m.agentName ? `${ANSI.dim}[${m.agentName}]${ANSI.reset} ` : ''
    if (role === 'user') {
      const lns = content.split('\n')
      lines.push({ text: `${tsStr} ${ANSI.magenta}>${ANSI.reset} ${lns[0]}` })
      for (const l of lns.slice(1)) lines.push({ text: `           ${l}` })
    } else if (role === 'assistant') {
      const lns = content.split('\n')
      lines.push({ text: `${tsStr} ${tag}${ANSI.cyan}┃${ANSI.reset} ${lns[0]}` })
      for (const l of lns.slice(1)) lines.push({ text: `           ${ANSI.cyan}┃${ANSI.reset} ${l}` })
    } else {
      lines.push({ text: `${tsStr} ${ANSI.gray}${content}${ANSI.reset}` })
    }
  }
  return lines
}

/**
 * Convert persisted SessionMessage[] into ChatBlock[] for the main view, so a
 * resumed session shows its prior conversation in the same bubble style as a
 * live turn (user / assistant / tool). This is purely for display on startup —
 * the agent already carries the real context. Mirrors the kinds the live
 * reducer produces; usage/thinking rows are dropped to keep the replay clean.
 */
function messagesToBlocks(messages: unknown[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const raw of messages) {
    const m = raw as {
      role?: string
      content?: string
      agentName?: string
      toolName?: string
      toolInput?: unknown
      durationMs?: number
    }
    if (m.toolName) {
      blocks.push({
        id: nextId(),
        kind: 'tool',
        text: '',
        toolName: m.toolName,
        toolArg: summarizeToolInput(m.toolName, m.toolInput) ?? undefined,
        durationMs: m.durationMs,
      })
      continue
    }
    const content = (m.content ?? '').trim()
    if (!content) continue
    const role = m.role ?? 'system'
    if (role === 'user') {
      blocks.push({ id: nextId(), kind: 'user', text: content })
    } else if (role === 'assistant') {
      blocks.push({ id: nextId(), kind: 'assistant', text: renderMarkdown(content).trimEnd() })
    } else {
      blocks.push({ id: nextId(), kind: 'system', text: content })
    }
  }
  return blocks
}

function fmtK(n: number): string { return `${(n / 1000).toFixed(1)}K` }
function fmtMs(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms` }
function shortModel(id: string): string {
  return id.replace(/^global\.anthropic\./, '').replace(/^anthropic\./, '').replace(/-\d{8}$/, '')
}

function formatTs(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function pad(n: number): string { return n.toString().padStart(2, '0') }
function safeJson(v: unknown, maxLen: number): string {
  try { return truncate(JSON.stringify(v), maxLen) } catch { return '[unserializable]' }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'append-user':
      return { ...state, blocks: [...state.blocks, { id: nextId(), kind: 'user', text: action.text }] }
    case 'append-system':
      return { ...state, blocks: [...state.blocks, { id: nextId(), kind: 'system', text: action.text }] }
    case 'append-error':
      return { ...state, blocks: [...state.blocks, { id: nextId(), kind: 'error', text: action.text }] }
    case 'load-history':
      // Prepend the replayed history before anything already in view. Only
      // fired once on mount when blocks are still empty, so a plain concat is
      // fine and keeps chronological order (history first, then new turns).
      return { ...state, blocks: [...action.blocks, ...state.blocks] }
    case 'turn-start':
      return { ...state, running: true, spinnerLabel: 'thinking', liveText: '', liveThinking: null, turnStartedAt: Date.now() }
    case 'workspace-switched': {
      // Soft reset: append a divider so the user sees the boundary, but keep
      // already-committed blocks in <Static> (it's append-only — clearing
      // would leave the rendered terminal scrollback orphaned anyway).
      // We do reset live state + per-turn snapshots so the new workspace
      // doesn't inherit stale model/context info in the status bar.
      return {
        ...state,
        blocks: [...state.blocks, { id: nextId(), kind: 'system', text: `── ${action.text} ──` }],
        liveText: '',
        liveThinking: null,
        spinnerLabel: null,
        running: false,
        modelId: null,
        contextTokens: null,
        agentNameByTaskId: new Map(),
        rootAgentName: 'agent',
        subAgents: new Map(),
        pendingToolInput: null,
        pendingToolArg: null,
        pendingToolName: null,
        turnStartedAt: null,
      }
    }
    case 'toggle-verbose':
      return { ...state, verbose: !state.verbose }
    case 'event': {
      const e = action.event
      const isSub = !!e.taskId
      switch (e.type) {
        case 'agent_start': {
          let next = state
          if (e.taskId && e.agentName) {
            const names = new Map(state.agentNameByTaskId)
            names.set(e.taskId, e.agentName)
            const subs = new Map(state.subAgents)
            subs.set(e.taskId, {
              taskId: e.taskId,
              agentName: e.agentName,
              toolCount: 0,
              startedAt: Date.now(),
              currentTool: null,
            })
            next = {
              ...next,
              agentNameByTaskId: names,
              subAgents: subs,
              blocks: [...next.blocks, {
                id: nextId(),
                kind: 'sub-start',
                text: e.text?.slice(0, 80) ?? '',
                subTaskId: e.taskId,
                subAgentName: e.agentName,
              }],
            }
          }
          if (!e.taskId && e.agentName) {
            next = { ...next, rootAgentName: e.agentName }
          }
          return next
        }
        case 'agent_done': {
          if (!e.taskId) return state
          const stats = state.subAgents.get(e.taskId)
          if (!stats) return state
          const subs = new Map(state.subAgents)
          subs.delete(e.taskId)
          return {
            ...state,
            subAgents: subs,
            blocks: [...state.blocks, {
              id: nextId(),
              kind: 'sub-done',
              text: '',
              subTaskId: e.taskId,
              subAgentName: stats.agentName,
              subToolCount: stats.toolCount,
              durationMs: Date.now() - stats.startedAt,
            }],
          }
        }
        case 'stream':
          // Sub-agent stream is hidden — the live status zone shows progress,
          // and the parent's tool_result delivers the final answer to root.
          if (isSub) return state
          if (!e.text) return state
          return { ...state, liveText: state.liveText + e.text, spinnerLabel: null }
        case 'thinking':
          // Thinking content is hidden by default — it's voluminous and rarely
          // useful in interactive sessions. The spinner already conveys "the
          // model is reasoning"; full thinking can be inspected in session logs.
          return state
        case 'tool_call': {
          if (isSub && e.taskId) {
            const stats = state.subAgents.get(e.taskId)
            if (!stats) return state
            const subs = new Map(state.subAgents)
            subs.set(e.taskId, { ...stats, currentTool: e.toolName ?? null, toolCount: stats.toolCount + 1 })
            return { ...state, subAgents: subs }
          }
          // Root tool_call. In verbose mode (or for shell_exec, which always
          // shows its result), capture args now so tool_result can attach them
          // to the same block (Static is append-only — we can't mutate the
          // block once committed).
          let pending: string | null = null
          const captureInput = state.verbose || e.toolName === 'shell_exec'
          if (captureInput && e.toolInput !== undefined) {
            try {
              pending = truncate(JSON.stringify(e.toolInput), 200)
            } catch {
              pending = '[unserializable]'
            }
          }
          const arg = e.toolName ? summarizeToolInput(e.toolName, e.toolInput) : null
          // Buffer the tool name too — belt-and-braces for a tool_result that
          // arrives without toolName (older server builds didn't attach it).
          return {
            ...state,
            spinnerLabel: arg ? `${e.toolName} ${arg}` : (e.toolName ?? 'tool'),
            pendingToolInput: pending,
            pendingToolArg: arg,
            pendingToolName: e.toolName ?? null,
          }
        }
        case 'tool_result': {
          if (isSub && e.taskId) {
            const stats = state.subAgents.get(e.taskId)
            if (!stats) return state
            const subs = new Map(state.subAgents)
            subs.set(e.taskId, { ...stats, currentTool: null })
            return { ...state, subAgents: subs }
          }
          // tool_result now carries toolName (server fix); the name buffered
          // at tool_call time stays as fallback for older event streams.
          const toolName = e.toolName ?? state.pendingToolName ?? '?'
          const block: ChatBlock = {
            id: nextId(),
            kind: 'tool',
            text: '',
            toolName,
            toolArg: state.pendingToolArg ?? undefined,
            durationMs: e.durationMs,
          }
          // shell_exec output is the one tool whose result the user almost
          // always wants to see — show it even without -v, with a more
          // generous line cap. Other tools stay verbose-gated.
          const isShell = toolName === 'shell_exec'
          if ((state.verbose || isShell) && state.pendingToolInput) block.toolInput = state.pendingToolInput
          if (e.toolResult && (state.verbose || isShell)) {
            block.toolResult = truncateLines(e.toolResult, isShell ? 20 : 5, 200)
          }
          return {
            ...state,
            blocks: [...state.blocks, block],
            spinnerLabel: 'thinking',
            pendingToolInput: null,
            pendingToolArg: null,
            pendingToolName: null,
          }
        }
        case 'usage': {
          if (isSub) return state
          const blocks = [...state.blocks]
          if (state.liveText) {
            blocks.push({
              id: nextId(),
              kind: 'assistant',
              text: renderMarkdown(state.liveText).trimEnd(),
            })
          }
          // Usage badge is verbose-only — but always update status-bar fields
          // (modelId, ctx%) so the user can see context fill regardless.
          if (state.verbose) {
            blocks.push({
              id: nextId(),
              kind: 'usage',
              text: '',
              usage: e,
              modelId: e.modelId,
            })
          }
          const totalInput = (e.inputTokens ?? 0) + (e.cacheReadInputTokens ?? 0) + (e.cacheWriteInputTokens ?? 0)
          const ctx = totalInput + (e.outputTokens ?? 0)
          return {
            ...state,
            blocks,
            liveText: '',
            liveThinking: null,
            modelId: e.modelId ?? state.modelId,
            contextTokens: ctx > 0 ? ctx : state.contextTokens,
          }
        }
        case 'system':
          // Server-emitted system notifications (compact done, etc.) — show
          // as a normal system block. isSub: don't surface sub-agent system
          // notices in root chat; they belong to the sub's own log.
          if (isSub || !e.text) return state
          return {
            ...state,
            blocks: [...state.blocks, { id: nextId(), kind: 'system', text: e.text }],
            spinnerLabel: null,
          }
        case 'compacted':
          // Companion event to the 'system' notice above. Updates the
          // status-bar token estimate; the user-facing text already arrived
          // via the 'system' event.
          if (isSub) return state
          return {
            ...state,
            contextTokens: e.totalTokens ?? state.contextTokens,
            spinnerLabel: null,
          }
        case 'error':
          if (isSub) return state
          return {
            ...state,
            blocks: [...state.blocks, { id: nextId(), kind: 'error', text: `[error] ${e.error ?? 'unknown'}` }],
            spinnerLabel: null,
          }
        case 'complete':
          if (isSub) return state
          if (state.liveText) {
            return {
              ...state,
              blocks: [...state.blocks, { id: nextId(), kind: 'assistant', text: renderMarkdown(state.liveText).trimEnd() }],
              liveText: '',
              liveThinking: null,
              spinnerLabel: null,
              running: false,
              turnStartedAt: null,
            }
          }
          return { ...state, running: false, spinnerLabel: null, liveThinking: null, turnStartedAt: null }
        default:
          return state
      }
    }
  }
}

export function App({ harness, verbose }: AppProps): ReactElement {
  const { exit } = useApp()
  const [state, dispatch] = useReducer(reducer, verbose, initialState)
  const [history, setHistory] = useState<string[]>(() => loadHistory())
  const [interruptArmed, setInterruptArmed] = useState(false)
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** When set, render the LogNavigator overlay instead of the input box. */
  const [navTree, setNavTree] = useState<SessionTreeNode | null>(null)
  /** When set, render the LogViewer (full-viewport log) instead of input/nav.
   *  `sessionId` is kept so the viewer can re-fetch that session's log live as
   *  the agent appends to it; `live` flags whether it's still running. */
  const [viewer, setViewer] = useState<{ sessionId: string; title: string; lines: LogLine[]; live: boolean } | null>(null)
  /** Last esc-press timestamp so repeated esc doesn't spam "interrupting…". */
  const lastInterruptRef = useRef(0)
  /** Slash command list — refreshed on mount + on /ws switch. */
  const [commands, setCommands] = useState<SlashItem[]>([])
  /** Real context window size for the current session's agent — fetched once
   *  per session (mount / /ws / /switch); hardcoded fallback until it lands. */
  const [maxContextTokens, setMaxContextTokens] = useState<number | null>(null)

  // Subscribe to harness events.
  useEffect(() => {
    const handler = (event: AgentSessionEvent) => dispatch({ type: 'event', event })
    harness.onEvent(handler)
    return () => { harness.offEvent(handler) }
  }, [harness])

  // On mount, replay the current session's persisted history so a resumed
  // `halo tui` shows the prior conversation (the agent already carries the
  // real context — this is display-only). Runs once; a fresh `--new` session
  // simply has no messages and renders nothing.
  useEffect(() => {
    let cancelled = false
    harness.getSessionMessages(harness.sessionId).then((msgs) => {
      if (cancelled || !msgs || msgs.length === 0) return
      const blocks = messagesToBlocks(msgs)
      if (blocks.length > 0) dispatch({ type: 'load-history', blocks })
    }).catch(() => { /* best-effort — empty screen is acceptable */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load slash commands on mount + whenever the workspace changes (skills
  // are workspace-scoped, so /ws switches require a refresh).
  useEffect(() => {
    let cancelled = false
    harness.listCommands().then((cmds) => {
      if (cancelled) return
      setCommands(cmds.map((c) => ({
        slashName: c.slashName,
        description: c.description,
        argHint: c.argHint,
        verbs: c.verbs,
      })))
    }).catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [harness, harness.workspace])

  // Fetch the real context window size for ctx% — per-agent config, not the
  // hardcoded 200K guess. Re-fetch when the session changes (/session new,
  // /session switch, /ws all rebind harness.sessionId and trigger a render).
  useEffect(() => {
    let cancelled = false
    harness.getMaxContextTokens().then((max) => {
      if (!cancelled && max != null && max > 0) setMaxContextTokens(max)
    }).catch(() => { /* keep fallback */ })
    return () => { cancelled = true }
  }, [harness, harness.sessionId])

  // Cleanup any pending interrupt timer on unmount.
  useEffect(() => () => {
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current)
  }, [])

  // Open the session-log navigator. Shared by `/log` and the Ctrl+O shortcut —
  // single source: the DB session tree (root + every sub-agent), so it's
  // resume-safe and shows stopped sub-agents. Defined before useInput so the
  // shortcut handler doesn't capture it before its declaration.
  const openLog = () => {
    const tree = harness.getSessionTree()
    if (!tree) {
      dispatch({ type: 'append-error', text: 'No session tree available.' })
      return
    }
    setNavTree(tree)
  }

  // Esc: interrupt running turn. Ctrl+C: graceful exit (twice = force).
  // Ctrl+O: open the session-log navigator — the keyboard shortcut for `/log`.
  // It lists the whole session tree (root + every sub-agent) from the DB, so
  // sub-agents survive a resume and stopped ones still show, unlike the old
  // in-memory picker. (Shift+Tab is unusable — Windows cmd eats it as backtab.)
  useInput((input, key) => {
    if (key.ctrl && input === 'o' && !navTree && !viewer) {
      openLog()
      return
    }
    if (key.escape && state.running) {
      const now = Date.now()
      // Interrupt (not stop): abort the in-flight turn at once — including a
      // command mid-run — then the server folds any queued messages into one
      // follow-up turn. Idempotent, but throttle the notice to ~2s.
      harness.interrupt()
      if (now - lastInterruptRef.current > 2000) {
        lastInterruptRef.current = now
        dispatch({ type: 'append-system', text: '⏸ interrupting…' })
      }
      return
    }
    if (key.ctrl && input === 'c') {
      if (interruptArmed) {
        exit()
        return
      }
      setInterruptArmed(true)
      if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current)
      interruptTimerRef.current = setTimeout(() => setInterruptArmed(false), 1500)
    }
  })

  const handleSubmit = async (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    setHistory((h) => (h[h.length - 1] === trimmed ? h : [...h, trimmed]))
    appendHistory(trimmed)

    // Slash commands
    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.split(/\s+/)
      if (cmd === '/quit' || cmd === '/exit') {
        exit()
        return
      }
      // TUI-local commands — handled inline, not routed to dispatchCommand.
      if (cmd === '/log') {
        dispatch({ type: 'append-user', text: trimmed })
        openLog()
        return
      }
      if (cmd === '/clear') {
        // Alias for /session new — server creates a new session and reports
        // it via result.switchTo, which harness.command picks up. (There is
        // no bare /new; session lifecycle is the /session object command.)
        return handleSubmit(['/session new', ...rest].join(' '))
      }
      if (cmd === '/verbose') {
        // Runtime toggle of the -v flag. <Static> blocks are immutable, so it
        // only affects blocks committed from now on; the status bar reflects
        // the current state ("v" badge).
        dispatch({ type: 'append-user', text: trimmed })
        const next = !state.verbose
        dispatch({ type: 'toggle-verbose' })
        dispatch({ type: 'append-system', text: `verbose ${next ? 'on' : 'off'} (affects new output; status bar shows "v" when on)` })
        return
      }
      if (cmd === '/help') {
        dispatch({ type: 'append-user', text: trimmed })
        const lines = commands.map((c) => {
          const arg = c.argHint ? ` ${c.argHint}` : ''
          return `  ${c.slashName}${arg}  ${c.description}`
        })
        dispatch({ type: 'append-system', text: `Available commands:\n${lines.join('\n')}` })
        return
      }
      if (cmd === '/retry') {
        const last = [...history].reverse().find((h) => !h.startsWith('/'))
        if (!last) {
          dispatch({ type: 'append-user', text: trimmed })
          dispatch({ type: 'append-error', text: 'No previous user message to retry.' })
          return
        }
        return handleSubmit(last)
      }
      const arg = rest.join(' ')
      dispatch({ type: 'append-user', text: trimmed })
      try {
        const result = await harness.command(cmd!, arg)
        if (result) {
          // /ws <path> success — harness has already rebound to the new
          // workspace. Reset all chat state so we don't bleed messages from
          // the previous workspace's session into the new one's view.
          if (result.workspace) {
            dispatch({ type: 'workspace-switched', text: result.text })
          } else {
            dispatch({ type: 'append-system', text: result.text })
          }
        } else {
          dispatch({ type: 'append-error', text: `Unknown command: ${cmd}` })
        }
      } catch (err) {
        dispatch({ type: 'append-error', text: `Command failed: ${err instanceof Error ? err.message : String(err)}` })
      }
      return
    }

    // User message
    const ref = resolveRefs(trimmed, harness.workspace)
    let displayText = trimmed
    if (ref.attachments.length > 0) {
      displayText += `\n  📎 ${ref.attachments.join(', ')}`
    }
    if (ref.images.length > 0 && !harness.supportsImage) {
      dispatch({ type: 'append-system', text: '⚠ current model does not support images, they will be ignored' })
    }
    for (const w of ref.warnings) {
      dispatch({ type: 'append-system', text: `⚠ ${w}` })
    }
    dispatch({ type: 'append-user', text: displayText })
    // Don't flip into "running" until the harness confirms the message was
    // actually picked up for a fresh turn. If it was queued (compacting or
    // turn already in flight), the eventual `complete` from the prior turn
    // is what should drive the running state — flipping `running=true` here
    // would leave the input stuck if no matching `complete` follows.
    const status = await harness.send(ref.text, ref.images.length > 0 ? ref.images : undefined)
    if (status === 'running') {
      dispatch({ type: 'turn-start' })
    } else {
      // queued — server soft-interrupts: the in-flight tool/stream finishes,
      // then queued messages fold into one merged follow-up turn (same as
      // admin's explorer chat). Leave running as-is; surface a hint.
      dispatch({ type: 'append-system', text: '(queued — current step will finish, then this message runs)' })
    }
  }

  const ctxPercent = useMemo(() => {
    if (state.contextTokens == null) return null
    const max = maxContextTokens ?? MAX_CONTEXT_TOKENS_FALLBACK
    return Math.round((state.contextTokens / max) * 100)
  }, [state.contextTokens, maxContextTokens])

  const placeholder = state.running ? 'send to interrupt current response…' : 'ask a question or describe a task'
  const hint = interruptArmed ? 'press Ctrl+C again to exit' : (state.running ? 'esc to interrupt' : '/help · /quit · /log (ctrl+o)')

  const handleNavPick = async (sessionId: string) => {
    setNavTree(null)
    const msgs = await harness.getSessionMessages(sessionId)
    if (!msgs || msgs.length === 0) {
      dispatch({ type: 'append-system', text: `── session ${sessionId.slice(-8)} has no log ──` })
      return
    }
    setViewer({
      sessionId,
      title: `Log: ${sessionId} · ${msgs.length} messages`,
      lines: messagesToLogLines(msgs),
      live: harness.isSessionRunning(sessionId),
    })
  }

  // While the viewer is open on a still-running session, re-fetch its log as
  // the agent appends to it. The whole session tree's events bubble to
  // harness.onEvent (sub-agent events carry taskId === their own sessionId),
  // so we just watch for "settled" events touching the viewed session and
  // re-pull its in-memory snapshot. Stream/thinking/tool_call deltas are
  // skipped — refreshing on every token would thrash; the log gains nothing
  // until a tool result / turn lands anyway. A short debounce coalesces bursts.
  const viewerSessionId = viewer?.sessionId ?? null
  useEffect(() => {
    if (!viewerSessionId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const refresh = () => {
      harness.getSessionMessages(viewerSessionId).then((msgs) => {
        if (cancelled || !msgs) return
        setViewer((v) => v && v.sessionId === viewerSessionId
          ? {
              ...v,
              title: `Log: ${viewerSessionId} · ${msgs.length} messages`,
              lines: messagesToLogLines(msgs),
              live: harness.isSessionRunning(viewerSessionId),
            }
          : v)
      }).catch(() => { /* best-effort */ })
    }

    const handler = (event: AgentSessionEvent) => {
      // taskId is the sub-agent's own id; undefined for the root. Match either
      // the viewed session being that sub, or the root's own (no-taskId) events.
      const eventSessionId = event.taskId ?? harness.sessionId
      if (eventSessionId !== viewerSessionId) return
      if (event.type !== 'tool_result' && event.type !== 'usage'
        && event.type !== 'agent_done' && event.type !== 'complete'
        && event.type !== 'system' && event.type !== 'error') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 150)
    }

    harness.onEvent(handler)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      harness.offEvent(handler)
    }
  }, [harness, viewerSessionId])

  return (
    <Box flexDirection="column">
      <Messages blocks={state.blocks} />
      <Streaming
        spinnerLabel={state.spinnerLabel}
        liveText={state.liveText}
        liveThinking={state.liveThinking}
        activeSubs={Array.from(state.subAgents.values()).map((s) => ({
          taskId: s.taskId, agentName: s.agentName, toolCount: s.toolCount, currentTool: s.currentTool,
        }))}
        turnStartedAt={state.turnStartedAt}
      />

      {viewer ? (
        <Box marginTop={1}>
          <LogViewer
            title={viewer.title}
            lines={viewer.lines}
            live={viewer.live}
            onClose={() => setViewer(null)}
          />
        </Box>
      ) : navTree ? (
        <Box marginTop={1}>
          <LogNavigator
            tree={navTree}
            onPick={handleNavPick}
            onCancel={() => setNavTree(null)}
          />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <StatusBar
            agentName={state.rootAgentName}
            modelId={state.modelId}
            contextPercent={ctxPercent}
            workspace={harness.workspace}
            sessionId={harness.sessionId}
            verbose={state.verbose}
          />
          <InputBox
            // Stay editable while a turn runs — harness.send() queues the
            // message (returns 'queued') and handleSubmit surfaces a hint.
            // The modal overlays (viewer / navTree) render in earlier
            // branches, so the input box is simply absent then.
            enabled={!navTree && !viewer}
            placeholder={placeholder}
            history={history}
            onSubmit={handleSubmit}
            hint={hint}
            commands={commands}
            workspace={harness.workspace}
          />
        </Box>
      )}
    </Box>
  )
}
