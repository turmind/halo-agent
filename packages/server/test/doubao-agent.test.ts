import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DoubaoAgentConfig } from '../src/agents/doubao-agent.js'
import { sseResponse } from './helpers/sse-response.js'

/**
 * Doubao vision (2026-10-10 live probe): Seed 2.1 Pro takes user images as
 * Chat Completions `image_url` content parts. The 2.0 models stay
 * image:false in the registry, so session-manager drops their images before
 * they reach the agent.
 *
 * The registry resolves from os.homedir() → temp HOME seeded with the bundled
 * doubao.yaml, set before the dynamic imports.
 */

const PNG = 'iVBORw0KGgo='
let tmpHome: string
let realHome: string | undefined
let DoubaoAgent: typeof import('../src/agents/doubao-agent.js')['DoubaoAgent']
let config: typeof import('../src/config.js')

beforeAll(async () => {
  realHome = process.env.HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-doubao-'))
  process.env.HOME = tmpHome
  const modelsDir = path.join(tmpHome, '.halo', 'global', 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.copyFileSync(path.resolve(import.meta.dirname, '..', 'templates', 'models', 'doubao.yaml'), path.join(modelsDir, 'doubao.yaml'))
  config = await import('../src/config.js')
  DoubaoAgent = (await import('../src/agents/doubao-agent.js')).DoubaoAgent
})

afterAll(() => {
  process.env.HOME = realHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('DoubaoAgent images', () => {
  it('sends a user image as an image_url content part', async () => {
    let body: { messages: Array<{ role: string; content: unknown }> } = { messages: [] }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as typeof body
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'red' }, finish_reason: 'stop' }] }])
    }))
    const cfg: DoubaoAgentConfig = { modelId: 'doubao-seed-2-1-pro-260628', endpoint: 'https://example.test/v3', apiKey: 'k', systemPrompt: 'sys', tools: [], maxTokens: 1000 }
    const agent = new DoubaoAgent(cfg)
    agent.messages = [{ role: 'user', content: [
      { type: 'text', text: 'colour?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ] }]
    await (agent as unknown as { callModel(s: AbortSignal | undefined): Promise<unknown> }).callModel(undefined)
    expect(body.messages[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'colour?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ] })
  })

  it('registry: only Seed 2.1 Pro is vision-capable', () => {
    expect(config.modelSupportsImage('doubao-seed-2-1-pro-260628')).toBe(true)
    for (const id of ['doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428', 'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-code-preview-260215']) {
      expect(config.modelSupportsImage(id), id).toBe(false)
    }
  })
})
