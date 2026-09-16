import { describe, it, expect } from 'vitest'
import { AgentLoop, type ModelCallResult, type ToolDef, type ContentBlock } from '../src/agents/agent-loop.js'
import { config } from '../src/config.js'

/**
 * Regression coverage for the LLM-facing tool-result cap in AgentLoop.run.
 *
 * `config.limits.toolResultMax` (default 8000) trims every tool result before
 * it enters `messages`. That is right for data-shaped output (shell_exec,
 * web_fetch, file_read) but wrong for `activate_skill`, whose result IS the
 * instructions: the built-in acp / cron / self skills are 8–12K, so a capped
 * activation handed the model half a manual plus a "re-run with narrower
 * scope" hint that means nothing for a skill body.
 *
 * Drives a scripted AgentLoop subclass: turn 1 calls both tools with 20K
 * payloads, turn 2 ends. Asserts the activate_skill tool_result lands intact
 * while the shell_exec one is cut to cap + marker.
 */

const BIG = 'x'.repeat(20_000)

class ScriptedLoop extends AgentLoop {
  private turn = 0
  protected async callModel(): Promise<ModelCallResult> {
    this.turn++
    if (this.turn === 1) {
      const toolCalls = [
        { id: 'tu_skill', name: 'activate_skill', input: { skill_id: 'big' } },
        { id: 'tu_shell', name: 'shell_exec', input: { command: 'cat big' } },
      ]
      return {
        assistantBlocks: toolCalls.map((tc) => ({ type: 'tool_use' as const, ...tc })),
        stopReason: 'tool_use',
        text: '',
        thinking: '',
        toolCalls,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }
    }
    return {
      assistantBlocks: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      text: 'done',
      thinking: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }
  }
}

const tools: ToolDef[] = [
  { name: 'activate_skill', description: '', inputSchema: {}, callback: () => BIG },
  { name: 'shell_exec', description: '', inputSchema: {}, callback: () => BIG },
]

function toolResultFor(loop: AgentLoop, id: string): string {
  for (const m of loop.messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    const hit = m.content.find(
      (b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result' && b.tool_use_id === id,
    )
    if (hit) return typeof hit.content === 'string' ? hit.content : JSON.stringify(hit.content)
  }
  throw new Error(`no tool_result for ${id}`)
}

describe('AgentLoop tool-result cap — activate_skill exemption', () => {
  it('leaves the activate_skill result intact but caps shell_exec', async () => {
    const cap = config.limits.toolResultMax
    expect(BIG.length).toBeGreaterThan(cap)

    const loop = new ScriptedLoop(tools)
    const events = []
    for await (const ev of loop.run('go')) events.push(ev)

    const skillResult = toolResultFor(loop, 'tu_skill')
    expect(skillResult).toBe(BIG)
    expect(skillResult).not.toContain('[Content truncated')

    const shellResult = toolResultFor(loop, 'tu_shell')
    expect(shellResult.startsWith(BIG.slice(0, cap))).toBe(true)
    expect(shellResult).toContain(`[Content truncated: ${BIG.length} chars total, showing first ${cap}.`)
    expect(shellResult.length).toBeLessThan(BIG.length)

    // The yielded event mirrors what entered messages (LLM-capped copy).
    const skillEv = events.find((e) => e.type === 'tool_result' && e.toolUseId === 'tu_skill')
    expect(skillEv?.toolResult).toBe(BIG)
    const shellEv = events.find((e) => e.type === 'tool_result' && e.toolUseId === 'tu_shell')
    expect(shellEv?.toolResult).toContain('[Content truncated')
  })
})
