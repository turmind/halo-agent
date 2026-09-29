import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Jimp } from 'jimp'
import type { AnthropicMessage, ContentBlock, ToolDef, ToolResultBlock } from '../src/agents/agent-loop.js'
import { trimHistoryImages, replaceImageBlocks } from '../src/agents/history-images.js'
import { classifyModelError } from '../src/agents/model-error.js'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'

/**
 * "Input is too long." on a 113K-token session (prod secretary-blender,
 * 2026-09-27): 31 view_image'd 896px PNGs replayed with every request made a
 * 34 MB body — over Bedrock's ~32 MB cap, which Bedrock reports with the same
 * words as a token overflow. Three gaps, one test block each:
 *  1. classifyModelError didn't know the message → fatal on attempt 1
 *  2. nothing bounded the history's image bytes (auto-compact counts tokens)
 *  3. view_image sent opaque PNGs as-is, unlike the admin upload path (JPEG)
 */

const MB = 1024 * 1024
const b64 = (bytes: number): string => 'A'.repeat(bytes)
const toolImageTurn = (id: string, data: string): AnthropicMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'view_image', input: { path: `${id}.png` } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Image loaded: ${id}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] },
]

function imageData(messages: AnthropicMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === 'image') out.push(b.source.data)
      if (b.type === 'tool_result' && Array.isArray(b.content)) for (const ib of b.content) if (ib.type === 'image') out.push(ib.source.data)
    }
  }
  return out
}

describe('classifyModelError — Bedrock body-size overflow', () => {
  it('bare "Input is too long." (ValidationException 400) → context_overflow, not fatal', () => {
    const err = Object.assign(new Error('Input is too long.'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } })
    expect(classifyModelError(err).kind).toBe('context_overflow')
  })
})

describe('trimHistoryImages', () => {
  it('under budget → untouched', () => {
    const messages = [...toolImageTurn('a', b64(MB)), ...toolImageTurn('b', b64(MB))]
    const before = JSON.stringify(messages)
    expect(trimHistoryImages(messages)).toBe(0)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('over 20 MB → drops the OLDEST until ≤10 MB, keeps the tool_use/tool_result pairing', () => {
    // 31 × ~1.1 MB base64 — the prod session's shape.
    const messages: AnthropicMessage[] = []
    for (let i = 0; i < 31; i++) messages.push(...toolImageTurn(`t${i}`, b64(1.1 * MB) + i))
    const original = imageData(messages)
    const replaced = trimHistoryImages(messages)

    const kept = imageData(messages)
    expect(replaced).toBe(31 - kept.length)
    expect(kept.reduce((a, d) => a + d.length, 0)).toBeLessThanOrEqual(10 * MB)
    expect(kept.length).toBeGreaterThan(0)
    // The newest survive, in order.
    expect(kept).toEqual(original.slice(replaced))
    expect(messages).toHaveLength(62)
    // Placeholders sit where the images were; text + tool_result blocks intact.
    const first = messages[1].content as ContentBlock[]
    expect(first[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't0' })
    const inner = (first[0] as { content: ToolResultBlock[] }).content
    expect(inner[0]).toEqual({ type: 'text', text: 'Image loaded: t0' })
    expect(inner[1]).toMatchObject({ type: 'text', text: expect.stringContaining('view_image it again') })
  })

  it('counts top-level upload images too, and caps the image count', () => {
    const messages: AnthropicMessage[] = []
    for (let i = 0; i < 101; i++) {
      messages.push({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'x' } }, { type: 'text', text: `q${i}` }] })
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
    }
    expect(trimHistoryImages(messages)).toBe(51)
    expect(imageData(messages)).toHaveLength(50)
    expect((messages[0].content as ContentBlock[])[0]).toMatchObject({ type: 'text' })
    expect((messages[200].content as ContentBlock[])[0]).toMatchObject({ type: 'image' })
  })

  it('replaceImageBlocks still drops every image (4xx degrade path)', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'x' } }] },
      ...toolImageTurn('a', 'y'),
    ]
    expect(replaceImageBlocks(messages, 'rejected by model provider')).toBe(2)
    expect(imageData(messages)).toEqual([])
  })
})

describe('runAgentTurn wiring', () => {
  let ws: string
  let sm: SessionManager
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'halo-img-budget-'))
    sm = new SessionManager(ws)
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it('beforeCallModel trims an over-budget history before the model call', async () => {
    const seen: number[] = []
    const agent = {
      messages: [] as AnthropicMessage[],
      async *run(_input: unknown, opts?: { beforeCallModel?: () => Promise<void> }) {
        for (let i = 0; i < 25; i++) this.messages.push(...toolImageTurn(`t${i}`, b64(MB)))
        await opts?.beforeCallModel?.()
        seen.push(imageData(this.messages).length)
        this.messages.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
        yield { type: 'text', text: 'ok', final: true }
      },
    }
    sm.getDb().insert(agentSessions).values({
      id: 'w1', parentId: null, agentId: 'default', agentName: 'Default', description: '', workingDir: null,
      accessLevel: null, createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('w1', {
      id: 'w1', parentId: null, agentId: 'default', agentName: 'Default', agent,
      description: '', output: '', finalOutput: '', turnError: null, promise: null, abortController: null,
      messageQueue: [], contextConfig: { maxTokens: 100000, compressAt: 0.8 }, currentModelId: 'test-model',
      toolCallLog: [], warnedToolHashes: new Set<string>(), turnStartTime: 0, interruptRequested: false,
      isCompacting: false, compactAbortController: null, compactedThisTurn: false, systemPrompt: '',
      thinkingEffort: 'off', workingDir: null, accessLevel: null, supportsImage: true, lastContextTokens: 0,
      meta: { toolNames: [], skillNames: [], mdFiles: [] },
    })

    await sm.runSession('w1', 'go')

    expect(seen).toEqual([10])
  })
})

describe('view_image — opaque PNG goes JPEG like the upload path', () => {
  let ws: string
  let viewImage: ToolDef
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'halo-view-image-'))
    viewImage = createWorkspaceTools(ws, 'full').find((t) => t.name === 'view_image')!
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  /** 896×896 noise PNG — photographic-ish, compresses badly as PNG (>256 KB). */
  async function noisePng(file: string, alpha: boolean): Promise<number> {
    const img = new Jimp({ width: 896, height: 896, color: 0xffffffff })
    const d = img.bitmap.data
    let seed = 7
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      d[i] = (i & 3) === 3 ? (alpha ? 128 : 255) : seed >> 16 & 0xff
    }
    const buf = await img.getBuffer('image/png')
    writeFileSync(join(ws, file), buf)
    return buf.length
  }

  const imageBlock = (out: unknown) => (out as ToolResultBlock[]).find((b) => b.type === 'image') as Extract<ToolResultBlock, { type: 'image' }>

  it('opaque PNG over 256 KB → image/jpeg, smaller than the original', async () => {
    const pngBytes = await noisePng('render.png', false)
    expect(pngBytes).toBeGreaterThan(256 * 1024)
    const block = imageBlock(await viewImage.callback({ path: 'render.png' }))
    expect(block.source.media_type).toBe('image/jpeg')
    expect(Buffer.from(block.source.data, 'base64').length).toBeLessThan(pngBytes)
  }, 30_000)

  it('transparent PNG stays PNG (JPEG would flatten alpha)', async () => {
    await noisePng('sprite.png', true)
    expect(imageBlock(await viewImage.callback({ path: 'sprite.png' })).source.media_type).toBe('image/png')
  }, 30_000)

  it('small PNG passes through untouched', async () => {
    const img = new Jimp({ width: 64, height: 64, color: 0x336699ff })
    const buf = await img.getBuffer('image/png')
    writeFileSync(join(ws, 'icon.png'), buf)
    const block = imageBlock(await viewImage.callback({ path: 'icon.png' }))
    expect(block.source.media_type).toBe('image/png')
    expect(block.source.data).toBe(buf.toString('base64'))
  })
})
