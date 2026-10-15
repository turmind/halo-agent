import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'

/**
 * A model provider credential whose `<<ENV>>` placeholder names an unset
 * variable stays literal (config.ts expandEnv). It used to go out as the key
 * and come back as a bare 401 that never names the variable. Now the turn
 * fails before any request with an error naming provider, field and variable,
 * once (account-level, no retry), while the session itself still builds.
 */

const KEY_VAR = 'HALO_TEST_MISSING_MINIMAX_KEY'
const AK_VAR = 'HALO_TEST_MISSING_AWS_AK'
const SK_VAR = 'HALO_TEST_MISSING_AWS_SK'

let ws: string

function setup(agentYaml: string[], settingsYaml: string): SessionManager {
  ws = mkdtempSync(join(tmpdir(), 'halo-missing-env-'))
  mkdirSync(join(ws, '.halo', 'agents', 'probe'), { recursive: true })
  writeFileSync(join(ws, '.halo', 'agents', 'probe', 'agent.yaml'), ['name: Probe', ...agentYaml, 'tools: [file_read]'].join('\n'))
  writeFileSync(join(ws, '.halo', 'settings.yaml'), settingsYaml)
  const sm = new SessionManager(ws)
  sm.getDb().insert(agentSessions).values({
    id: 's1', parentId: null, agentId: 'probe', agentName: 'Probe',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
  return sm
}

/** Send one message and collect the turn's events up to `complete`. */
async function runTurn(sm: SessionManager): Promise<AgentSessionEvent[]> {
  const events: AgentSessionEvent[] = []
  const done = new Promise<void>((resolve) => {
    sm.registerEventListener('s1', (e) => {
      events.push(e)
      if (e.type === 'complete') resolve()
    })
  })
  await sm.sendUserMessage('s1', 'hi')
  await done
  return events
}

const MINIMAX = ['model:', '  provider: minimax', '  id: MiniMax-M3', '  endpoint: https://api.minimaxi.com/anthropic']
const BEDROCK = ['model:', '  provider: aws-bedrock-claude-invoke', '  id: global.anthropic.claude-sonnet-4-6', '  endpoint: https://bedrock-runtime.us-east-1.amazonaws.com']

const sse = (ev: { type: string }) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
const OK_REPLY = [
  { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
].map(sse).join('')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env[KEY_VAR]
  delete process.env[AK_VAR]
  delete process.env[SK_VAR]
  rmSync(ws, { recursive: true, force: true })
})

describe('api_key with an unset <<ENV>> placeholder', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(OK_REPLY, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('fails the turn once with a clear error and sends no request; the session still opens', async () => {
    const sm = setup(MINIMAX, `minimax:\n  secrets:\n    api_key: <<${KEY_VAR}>>\n`)
    expect(await sm.getSessionContext('s1')).not.toBeNull()

    const events = await runTurn(sm)
    expect(fetchMock).not.toHaveBeenCalled()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain(`minimax api_key uses <<${KEY_VAR}>>, but ${KEY_VAR} is not set in the Halo server's environment`)
    expect(errors[0].error).toContain('halo server restart')
    expect(events.filter((e) => e.type === 'system' && /retrying/i.test(e.text ?? ''))).toHaveLength(0)
  })

  it('calls the model with the expanded key when the variable is set', async () => {
    process.env[KEY_VAR] = 'sk-test-value'
    const sm = setup(MINIMAX, `minimax:\n  secrets:\n    api_key: <<${KEY_VAR}>>\n`)
    const events = await runTurn(sm)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers['x-api-key']).toBe('sk-test-value')
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
  })
})

describe('AWS credentials with an unset <<ENV>> placeholder', () => {
  const settings = `aws-bedrock-claude-invoke:\n  secrets:\n    access_key_id: <<${AK_VAR}>>\n    secret_access_key: <<${SK_VAR}>>\n`

  it('fails the turn before any Bedrock request, naming both variables', async () => {
    const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send')
    const sm = setup(BEDROCK, settings)
    const events = await runTurn(sm)
    expect(send).not.toHaveBeenCalled()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain(`aws-bedrock-claude-invoke access_key_id uses <<${AK_VAR}>>, secret_access_key uses <<${SK_VAR}>>, but ${AK_VAR}, ${SK_VAR} are not set`)
  })

  it('reaches Bedrock when both variables are set', async () => {
    process.env[AK_VAR] = 'AKIATEST'
    process.env[SK_VAR] = 'secret-test'
    const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockRejectedValue(Object.assign(new Error('stub: stop here'), { name: 'ValidationException' }))
    const sm = setup(BEDROCK, settings)
    const events = await runTurn(sm)
    expect(send).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.type === 'error').map((e) => e.error)).toEqual(['stub: stop here'])
  })
})
