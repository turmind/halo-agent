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

  const chunks: string[] = []
  const toolCalls: Array<{ name: string; durationMs?: number }> = []
  let errorText = ''
  let usage: AgentSessionEvent | null = null
  let lastToolName = ''

  let hadOutput = false
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
          if (event.taskId) {
            if (opts.verbose) process.stderr.write(`${tag}\x1b[2m${event.text}\x1b[0m\n`)
          } else {
            if (opts.format === 'text') process.stdout.write(renderMarkdown(event.text) + '\n')
            chunks.push(event.text)
            hadOutput = true
          }
        }
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
          if (hadOutput) { process.stdout.write('\n'); hadOutput = false }
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

  if (opts.format === 'text') {
    if (chunks.length > 0 && !chunks[chunks.length - 1].endsWith('\n')) {
      process.stdout.write('\n')
    }
  } else {
    const result = {
      text: chunks.join(''),
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
