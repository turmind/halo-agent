import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'
import type { Harness } from './harness.js'
import { renderMarkdown } from './render-md.js'
import { resolveRefs } from './resolve-refs.js'
import { formatUsageLine } from './format-usage.js'

export interface CliOptions {
  format: 'text' | 'json'
  verbose: boolean
}

function shortId(taskId: string): string {
  const parts = taskId.split('>')
  return parts.length > 1 ? parts.map((p) => p.slice(-6)).join('>') : taskId.slice(-8)
}

function makeTag(taskId: string | undefined, agentNames: Map<string, string>, agentName?: string): string {
  if (!taskId) return ''
  const name = agentNames.get(taskId) ?? agentName ?? 'sub'
  return `\x1b[36m[${name} ${shortId(taskId)}]\x1b[0m `
}

export async function runCli(harness: Harness, message: string, opts: CliOptions): Promise<number> {
  const ref = resolveRefs(message, harness.workspace)
  if (ref.attachments.length > 0 && opts.verbose) {
    process.stderr.write(`\x1b[2m  attached: ${ref.attachments.join(', ')}\x1b[0m\n`)
  }
  if (ref.images.length > 0 && !harness.supportsImage) {
    process.stderr.write(`\x1b[33m  warning: current model does not support images, they will be ignored\x1b[0m\n`)
  }
  for (const w of ref.warnings) {
    process.stderr.write(`\x1b[33m  warning: ${w}\x1b[0m\n`)
  }
  const resolvedMessage = ref.text
  const resolvedImages = ref.images.length > 0 ? ref.images : undefined

  // Per-root-turn text, reset when a drained turn starts (`queued_message`).
  // stdout carries only the LAST turn's reply: `turnFinal` is the wrap-up
  // (stream events flagged `final`), `turnAll` every root stream chunk —
  // the fallback when the turn ended without a closing message.
  let turnFinal = ''
  let turnAll = ''
  const toolCalls: Array<{ name: string; durationMs?: number }> = []
  let errorText = ''
  let usage: AgentSessionEvent | null = null
  let lastToolName = ''

  let hadMeta = false
  const agentNames = new Map<string, string>()
  let spinnerTimer: ReturnType<typeof setInterval> | null = null
  let spinnerSeconds = 0
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let spinnerIdx = 0
  let spinnerLabel = ''

  function startSpinner(label: string): void {
    if (!opts.verbose) return
    stopSpinner()
    spinnerLabel = label
    spinnerSeconds = 0
    spinnerIdx = 0
    spinnerTimer = setInterval(() => {
      spinnerSeconds++
      spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length
      process.stderr.write(`\r\x1b[2m${spinnerFrames[spinnerIdx]} ${spinnerLabel} ${spinnerSeconds}s\x1b[0m`)
    }, 1000)
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer)
      spinnerTimer = null
      process.stderr.write('\r\x1b[K')
    }
  }

  startSpinner('Thinking...')

  for await (const event of harness.run(resolvedMessage, resolvedImages)) {
    const tag = makeTag(event.taskId, agentNames, event.agentName)
    switch (event.type) {
      case 'agent_start':
        if (event.taskId && event.agentName) agentNames.set(event.taskId, event.agentName)
        if (opts.verbose) {
          stopSpinner()
          process.stderr.write(`\x1b[36m[agent: ${event.agentName} ${event.taskId ? shortId(event.taskId) : ''}]\x1b[0m\n`)
          hadMeta = true
        }
        break
      case 'agent_done':
        if (opts.verbose) {
          stopSpinner()
          process.stderr.write(`\x1b[36m[done: ${event.agentName} ${event.taskId ? shortId(event.taskId) : ''}]\x1b[0m\n`)
          hadMeta = true
        }
        break
      case 'stream':
        if (event.text) {
          stopSpinner()
          if (opts.verbose && hadMeta) { process.stderr.write('\n'); hadMeta = false }
          // Nothing is written to stdout live — it gets the final answer once
          // the run ends (see `answer` below). Verbose echoes every stream to
          // stderr as progress: sub-agents tagged, root text tag-less.
          if (opts.verbose) process.stderr.write(`${tag}\x1b[2m${event.text}\x1b[0m\n`)
          if (!event.taskId) {
            turnAll += event.text
            if (event.final) turnFinal += event.text
          }
        }
        break
      case 'queued_message':
        // drainQueue starts a new root turn (folded user messages / sub-agent
        // reports). Only the last turn's reply goes to stdout, so drop the
        // previous turn's text. Root-only by construction; `complete` with
        // `batchBoundary` is NOT a reset point (no complete separates the
        // opening turn from the first drained one).
        if (!event.taskId) { turnFinal = ''; turnAll = '' }
        break
      case 'thinking':
        if (opts.verbose && event.text) {
          stopSpinner()
          if (hadMeta) { process.stderr.write('\n'); hadMeta = false }
          process.stderr.write(`\x1b[2m${tag}${event.text}\x1b[0m\n`)
        }
        break
      case 'tool_call':
        lastToolName = event.toolName ?? ''
        if (opts.verbose) {
          stopSpinner()
          process.stderr.write(`${tag}\x1b[33m[tool: ${lastToolName}]\x1b[0m\n`)
          hadMeta = true
          startSpinner(`Running ${lastToolName}...`)
        }
        break
      case 'tool_result': {
        const name = event.toolName ?? lastToolName
        if (opts.verbose) {
          stopSpinner()
          process.stderr.write(`${tag}\x1b[32m[done: ${name} ${event.durationMs ?? 0}ms]\x1b[0m\n`)
          hadMeta = true
          startSpinner('Thinking...')
        }
        toolCalls.push({ name, durationMs: event.durationMs })
        break
      }
      case 'usage':
        usage = event
        if (opts.verbose) {
          stopSpinner()
          process.stderr.write(`\n${tag}${formatUsageLine(event)}\n`)
          hadMeta = true
        }
        break
      case 'error':
        stopSpinner()
        errorText = event.error ?? 'Unknown error'
        process.stderr.write(`${tag}\x1b[31m[error] ${errorText}\x1b[0m\n`)
        hadMeta = true
        break
      case 'complete':
        stopSpinner()
        break
    }
  }
  stopSpinner()

  // Mirror tryReportToParent's `finalOutput || output`: the wrap-up reply,
  // falling back to the whole turn when it ended without one (e.g. stopped
  // right after a tool call) so a consumer still gets something.
  const answer = turnFinal || turnAll
  if (opts.format === 'text') {
    if (answer) {
      // Styled markdown only for a human at a terminal. Piped stdout (cron
      // dispatch, scripts) gets the raw markdown — marked-terminal's 80-col
      // reflow and box-drawing tables inflate bytes and read badly in chat.
      const out = process.stdout.isTTY ? renderMarkdown(answer) : answer
      process.stdout.write(out.endsWith('\n') ? out : out + '\n')
    }
  } else {
    const result = {
      text: answer,
      sessionId: harness.sessionId,
      toolCalls,
      usage: usage ? {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        modelId: usage.modelId,
      } : null,
      error: errorText || null,
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  }

  return errorText ? 1 : 0
}
