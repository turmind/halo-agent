import { PassThrough } from 'node:stream'
import { describe, it, expect, vi } from 'vitest'
import { AcpAdapter, type HaloApi } from '../src/adapter.js'
import { JsonRpcConnection } from '../src/jsonrpc.js'
import type { ChatOpts, HistoryMessage, SessionHistory, SessionPage, SseEvent } from '../src/halo-client.js'

/**
 * Contract tests for the ACP v1 adapter against a fake halo server
 * (HaloApi). Each scripted stream is a list of SSE events, optionally
 * ending in a drop (throw), or held open until aborted.
 */

const SID = 'web_acct_s1'

type Script = { events: SseEvent[]; end?: 'complete' | 'drop' | 'hang'; throwOnOpen?: boolean }

function streamOf(script: Script, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  return (async function* () {
    if (script.throwOnOpen) throw new Error('fetch failed')
    for (const ev of script.events) {
      if (signal?.aborted) throw abortError()
      yield ev
      await tick()
    }
    if (script.end === 'drop') throw new Error('terminated')
    if (script.end === 'hang') {
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) return reject(abortError())
        signal?.addEventListener('abort', () => reject(abortError()))
      })
    }
  })()
}

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

const tick = () => new Promise((r) => setImmediate(r))

interface FakeOpts {
  chat?: Script
  subscribes?: Script[]
  history?: SessionHistory | null
  /** Delivered to the chat stream right after stop() is called. */
  onStop?: SseEvent[]
  list?: SessionPage
  /** Held until the returned release() is called (history fetch in flight). */
  historyGate?: Promise<void>
}

function fakeHalo(opts: FakeOpts) {
  const subscribes = [...(opts.subscribes ?? [])]
  const calls = {
    chat: 0, subscribe: 0, stop: 0, history: 0,
    listCursors: [] as Array<number | undefined>,
    chatArgs: [] as ChatOpts[],
    stopIds: [] as Array<string | undefined>,
    subscribeIds: [] as string[],
    historyCalls: [] as Array<{ sessionId: string; since?: number }>,
  }
  let stopWaiters: Array<() => void> = []
  let stopped = false
  const client: HaloApi = {
    chat: (args, signal) => {
      calls.chat++
      calls.chatArgs.push(args)
      const script = opts.chat ?? { events: [], end: 'complete' }
      if (!opts.onStop) return streamOf(script, signal)
      // Stream that hangs until stop(), then emits the stop's frames.
      return (async function* () {
        for (const ev of script.events) { yield ev; await tick() }
        if (!stopped) await new Promise<void>((r) => { stopWaiters.push(r) })
        for (const ev of opts.onStop!) { yield ev; await tick() }
      })()
    },
    subscribe: (_ws, sid, signal) => {
      calls.subscribe++
      calls.subscribeIds.push(sid)
      const next = subscribes.shift() ?? { events: [{ type: 'session', sessionId: SID }, { type: 'complete' }] }
      return streamOf(next, signal)
    },
    history: async (_ws, sessionId, signal, since) => {
      calls.history++
      calls.historyCalls.push({ sessionId, since })
      if (opts.historyGate) {
        await Promise.race([opts.historyGate, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(abortError())))])
      }
      return opts.history === undefined ? { sessionId: SID, messages: [], running: false } : opts.history
    },
    createSession: async () => SID,
    listSessions: async (_ws, cursor) => {
      calls.listCursors.push(cursor)
      return opts.list ?? { workspace: '/ws', sessions: [], nextCursor: null }
    },
    stop: async (_ws, sessionId) => {
      calls.stop++
      calls.stopIds.push(sessionId)
      stopped = true
      for (const w of stopWaiters) w()
      stopWaiters = []
      return true
    },
  }
  return { client, calls }
}

function harness(opts: FakeOpts, deps: { retryDelaysMs?: number[]; cancelGraceMs?: number } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: Array<Record<string, any>> = []
  let buf = ''
  output.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf-8')
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) lines.push(JSON.parse(line))
      nl = buf.indexOf('\n')
    }
  })
  const conn = new JsonRpcConnection(input, output)
  const halo = fakeHalo(opts)
  new AcpAdapter(conn, { baseUrl: 'http://x', token: 't', workspace: '/ws' }, {
    client: halo.client,
    retryDelaysMs: deps.retryDelaysMs ?? [1, 1, 1, 1, 1],
    cancelGraceMs: deps.cancelGraceMs ?? 1000,
  })
  let nextId = 1
  const send = (method: string, params: unknown) => {
    const id = nextId++
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  const notify = (method: string, params: unknown) => {
    input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  const responseIndex = (id: number) => lines.findIndex((l) => l.id === id && !('method' in l))
  const waitFor = async (id: number, ms = 3000) => {
    const deadline = Date.now() + ms
    while (responseIndex(id) === -1) {
      if (Date.now() > deadline) throw new Error(`no response to ${id}; got ${JSON.stringify(lines)}`)
      await new Promise((r) => setTimeout(r, 2))
    }
    return lines[responseIndex(id)]
  }
  const updates = () => lines.filter((l) => l.method === 'session/update').map((l) => l.params.update)
  return { send, notify, waitFor, lines, updates, responseIndex, calls: halo.calls }
}

async function newSession(h: ReturnType<typeof harness>) {
  const res = await h.waitFor(h.send('session/new', { cwd: '/tmp', mcpServers: [] }))
  return res.result.sessionId as string
}

const prompt = (h: ReturnType<typeof harness>, text = 'hi') =>
  h.send('session/prompt', { sessionId: SID, prompt: [{ type: 'text', text }] })

const agentText = (h: ReturnType<typeof harness>) =>
  h.updates().filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('')

describe('initialize', () => {
  it('declares v1, loadSession, and agentInfo with the package version', async () => {
    const h = harness({})
    const res = await h.waitFor(h.send('initialize', { protocolVersion: 1, clientCapabilities: {} }))
    expect(res.result.protocolVersion).toBe(1)
    expect(res.result.agentCapabilities.loadSession).toBe(true)
    expect(res.result.agentCapabilities.sessionCapabilities).toEqual({ list: {} })
    expect(res.result.agentInfo).toEqual({ name: 'halo', title: 'Halo', version: '0.1.0' })
  })
})

describe('session/cancel', () => {
  it('as a notification: stops the session, drains the stop updates, resolves cancelled after them', async () => {
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: SID }, { type: 'tool_call', toolName: 'shell_exec', toolUseId: 'tu_1', toolInput: { command: 'sleep 60' } }] },
      onStop: [
        { type: 'tool_result', toolName: 'shell_exec', toolUseId: 'tu_1', result: '[interrupted by user]' },
        { type: 'complete' },
      ],
    })
    await newSession(h)
    const id = prompt(h)
    await vi.waitFor(() => expect(h.updates().some((u) => u.sessionUpdate === 'tool_call')).toBe(true))
    h.notify('session/cancel', { sessionId: SID })

    const res = await h.waitFor(id)
    expect(res.result).toEqual({ stopReason: 'cancelled' })
    expect(h.calls.stop).toBe(1)
    // The interrupted tool row arrived BEFORE the prompt response.
    const updateIdx = h.lines.findIndex((l) => l.method === 'session/update' && l.params.update.sessionUpdate === 'tool_call_update')
    expect(updateIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeLessThan(h.responseIndex(id))
    // A notification gets no response of its own.
    expect(h.lines.filter((l) => !('method' in l) && l.id == null)).toEqual([])
  })

  it('stream never completes after cancel → resolves cancelled once the grace period aborts it', async () => {
    const h = harness({ chat: { events: [{ type: 'session', sessionId: SID }], end: 'hang' } }, { cancelGraceMs: 20 })
    await newSession(h)
    const id = prompt(h)
    await tick(); await tick()
    h.notify('session/cancel', { sessionId: SID })
    const res = await h.waitFor(id)
    expect(res.result).toEqual({ stopReason: 'cancelled' })
    expect(h.calls.subscribe).toBe(0)
  })

  it('the legacy request form still works and answers null', async () => {
    const h = harness({ chat: { events: [{ type: 'session', sessionId: SID }], end: 'hang' } }, { cancelGraceMs: 10 })
    await newSession(h)
    const id = prompt(h)
    await tick(); await tick()
    const cancelId = h.send('session/cancel', { sessionId: SID })
    expect((await h.waitFor(cancelId)).result).toBeNull()
    expect((await h.waitFor(id)).result).toEqual({ stopReason: 'cancelled' })
  })

  it('stops the session actually running the turn (goal-routed id), not the ACP id', async () => {
    const h = harness({ chat: { events: [{ type: 'session', sessionId: 'goal_abc' }], end: 'hang' } }, { cancelGraceMs: 10 })
    await newSession(h)
    const id = prompt(h)
    await tick(); await tick()
    h.notify('session/cancel', { sessionId: SID })
    expect((await h.waitFor(id)).result).toEqual({ stopReason: 'cancelled' })
    expect(h.calls.stopIds).toEqual(['goal_abc'])
  })

  it('a prompt sent during the cancel grace is refused (-32600) until the first resolves; then it runs', async () => {
    const h = harness({ chat: { events: [{ type: 'session', sessionId: SID }], end: 'hang' } }, { cancelGraceMs: 30 })
    await newSession(h)
    const first = prompt(h)
    await tick(); await tick()
    h.notify('session/cancel', { sessionId: SID })
    // Still draining toward `complete` / the grace abort — the slot is held.
    expect((await h.waitFor(prompt(h, 'too soon'))).error.code).toBe(-32600)
    expect((await h.waitFor(first)).result).toEqual({ stopReason: 'cancelled' })
    // Slot freed: the next prompt is accepted (it hangs on the same script;
    // cancel it to finish).
    const third = prompt(h, 'now')
    await tick(); await tick()
    h.notify('session/cancel', { sessionId: SID })
    expect((await h.waitFor(third)).result).toEqual({ stopReason: 'cancelled' })
  })

  it('a cancel while settling against history resolves cancelled, quietly', async () => {
    let release!: () => void
    const historyGate = new Promise<void>((r) => { release = r })
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: SID }, { type: 'queued' }] },
      subscribes: [{ events: [{ type: 'stream', text: 'x' }, { type: 'complete' }] }],
      historyGate,
    }, { cancelGraceMs: 10 })
    await newSession(h)
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const id = prompt(h)
      await vi.waitFor(() => expect(h.calls.history).toBe(1))
      h.notify('session/cancel', { sessionId: SID })
      expect((await h.waitFor(id)).result).toEqual({ stopReason: 'cancelled' })
      expect(warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('history after reconnect failed'))).toEqual([])
    } finally {
      warn.mockRestore()
      release()
    }
  })

  it('cancel during a reconnect backoff resolves cancelled without waiting out the delay', async () => {
    const h = harness({ chat: { events: [{ type: 'session', sessionId: SID }, { type: 'stream', text: 'a' }], end: 'drop' } }, { retryDelaysMs: [60_000] })
    await newSession(h)
    const id = prompt(h)
    await vi.waitFor(() => expect(agentText(h)).toBe('a'))
    await tick()
    h.notify('session/cancel', { sessionId: SID })
    expect((await h.waitFor(id)).result).toEqual({ stopReason: 'cancelled' })
  })
})

describe('session/load', () => {
  const messages: HistoryMessage[] = [
    { type: 'context', role: 'system', content: '[System Prompt: Default]' },
    { type: 'user', role: 'user', content: 'run ls' },
    { type: 'tool_call', role: 'system', content: 'Default → shell_exec: ls', toolName: 'shell_exec', toolInput: { command: 'ls' } },
    { type: 'usage', role: 'system', content: '[Usage] in=1 out=2 cache=0' },
    { type: 'tool_result', role: 'system', content: 'Result: a.txt', toolOutput: 'a.txt' },
    {
      id: 'm1', type: 'assistant', role: 'assistant', content: 'One file.',
      contentBlocks: [
        { type: 'thinking', text: 'let me look' },
        { type: 'tool_call', toolCall: { name: 'shell_exec', input: 'ls', output: 'a.txt', toolUseId: 'tu_9' } },
        { type: 'text', text: 'One file.' },
      ],
    },
    { type: 'notification', role: 'system', content: 'compacted' },
    { type: 'user', role: 'user', content: 'deleted turn', deleted: true },
    { type: 'user', role: 'user', content: 'thanks' },
    { id: 'm2', type: 'assistant', role: 'assistant', content: 'Legacy reply', toolCalls: [{ name: 'file_read', input: '/x/y.md', output: 'body' }] },
  ]

  it('replays user / thought / tool_call / agent text in order, all before the {} response', async () => {
    const h = harness({ history: { sessionId: SID, messages, running: false } })
    const id = h.send('session/load', { sessionId: SID, cwd: '/tmp', mcpServers: [] })
    const res = await h.waitFor(id)
    expect(res.result).toEqual({})

    const before = h.lines.slice(0, h.responseIndex(id)).filter((l) => l.method === 'session/update')
    expect(before.every((l) => l.params.sessionId === SID)).toBe(true)
    expect(before.map((l) => l.params.update)).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run ls' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'let me look' } },
      {
        sessionUpdate: 'tool_call', toolCallId: 'tu_9', title: 'shell_exec: ls', kind: 'execute', status: 'completed',
        rawInput: 'ls', rawOutput: 'a.txt', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'One file.' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'thanks' } },
      {
        sessionUpdate: 'tool_call', toolCallId: 'replay-m2-0', title: 'file_read: /x/y.md', kind: 'read', status: 'completed',
        rawInput: '/x/y.md', rawOutput: 'body', content: [{ type: 'content', content: { type: 'text', text: 'body' } }],
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Legacy reply' } },
    ])
    expect(h.lines.slice(h.responseIndex(id) + 1)).toEqual([])
  })

  it('unknown session → invalid params, no updates', async () => {
    const h = harness({ history: null })
    const res = await h.waitFor(h.send('session/load', { sessionId: 'nope', cwd: '/tmp', mcpServers: [] }))
    expect(res.error.code).toBe(-32602)
    expect(h.updates()).toEqual([])
  })

  it('a loaded session accepts prompts', async () => {
    const h = harness({ history: { sessionId: SID, messages: [], running: false }, chat: { events: [{ type: 'stream', text: 'ok' }, { type: 'complete' }] } })
    await h.waitFor(h.send('session/load', { sessionId: SID, cwd: '/tmp', mcpServers: [] }))
    expect((await h.waitFor(prompt(h))).result).toEqual({ stopReason: 'end_turn' })
    expect(agentText(h)).toBe('ok')
  })
})

describe('prompt content blocks', () => {
  const run = async (prompt: unknown[]) => {
    const h = harness({ chat: { events: [{ type: 'complete' }] } })
    await newSession(h)
    const res = await h.waitFor(h.send('session/prompt', { sessionId: SID, prompt }))
    return { res, chat: h.calls.chatArgs[0] }
  }

  it('inlines a text resource as a uri header + fenced block, in prompt order', async () => {
    const { res, chat } = await run([
      { type: 'text', text: 'Explain ' },
      { type: 'text', text: 'this:' },
      { type: 'resource', resource: { uri: 'file:///home/me/a.py', mimeType: 'text/x-python', text: 'print(1)' } },
      { type: 'text', text: 'Thanks' },
    ])
    expect(res.result).toEqual({ stopReason: 'end_turn' })
    expect(chat.message).toBe('Explain this:\n\n[resource: file:///home/me/a.py]\n```\nprint(1)\n```\n\nThanks')
  })

  it('a fence longer than any backtick run in the content', async () => {
    const { chat } = await run([{ type: 'resource', resource: { uri: 'file:///r.md', text: 'x\n```js\ny\n```' } }])
    expect(chat.message).toBe('[resource: file:///r.md]\n````\nx\n```js\ny\n```\n````')
  })

  it('a blob resource → one placeholder line', async () => {
    const { chat } = await run([
      { type: 'text', text: 'look' },
      { type: 'resource', resource: { uri: 'file:///img.bin', mimeType: 'application/octet-stream', blob: 'AAEC' } },
    ])
    expect(chat.message).toBe('look\n\n[binary resource omitted: file:///img.bin]')
  })

  it('a resource_link → one reference line with name + uri (baseline: no capability needed)', async () => {
    const { res, chat } = await run([{ type: 'resource_link', uri: 'file:///home/me/doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf' }])
    expect(res.result).toEqual({ stopReason: 'end_turn' })
    expect(chat.message).toBe('[resource link: doc.pdf file:///home/me/doc.pdf]')
  })

  it('images go to images[]; an unsupported block is dropped with a stderr warning', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { chat } = await run([
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'iVBO', mimeType: 'image/png' },
        { type: 'audio', data: 'UklG', mimeType: 'audio/wav' },
      ])
      expect(chat.message).toBe('hi')
      expect(chat.images).toEqual([{ data: 'iVBO', mimeType: 'image/png' }])
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain('[acp-adapter] dropping audio content block (not supported)\n')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('tool calls', () => {
  it('uses toolUseId as toolCallId, with kind + title; pairs results by id even interleaved', async () => {
    const h = harness({
      chat: {
        events: [
          { type: 'tool_call', toolName: 'grep', toolUseId: 'tu_a', toolInput: { pattern: 'foo', path: 'src' } },
          { type: 'tool_call', toolName: 'web_fetch', toolUseId: 'tu_b', toolInput: { url: 'https://example.com/' + 'x'.repeat(200) } },
          { type: 'tool_result', toolName: 'grep', toolUseId: 'tu_a', result: 'hit' },
          { type: 'tool_result', toolName: 'web_fetch', toolUseId: 'tu_b', result: 'page' },
          { type: 'complete' },
        ],
      },
    })
    await newSession(h)
    await h.waitFor(prompt(h))
    const [callA, callB, resA, resB] = h.updates()
    expect(callA).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'tu_a', kind: 'search', title: 'grep: foo', status: 'in_progress', rawInput: { pattern: 'foo', path: 'src' } })
    expect(callA.locations).toBeUndefined()
    expect(callB).toMatchObject({ toolCallId: 'tu_b', kind: 'fetch' })
    expect(callB.title).toBe('web_fetch: ' + ('https://example.com/' + 'x'.repeat(200)).slice(0, 80))
    expect(resA).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'tu_a', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hit' } }] })
    expect(resB).toMatchObject({ toolCallId: 'tu_b' })
  })

  it('maps tool names to kinds', async () => {
    const names = ['file_read', 'file_write', 'file_edit', 'shell_exec', 'glob', 'file_list', 'activate_skill']
    const h = harness({
      chat: { events: [...names.map((n, i) => ({ type: 'tool_call', toolName: n, toolUseId: `t${i}`, toolInput: { path: 'p' } })), { type: 'complete' }] },
    })
    await newSession(h)
    await h.waitFor(prompt(h))
    expect(h.updates().map((u) => u.kind)).toEqual(['read', 'edit', 'edit', 'execute', 'search', 'search', 'other'])
  })

  it('without toolUseId (old server) falls back to most-recent pairing', async () => {
    const h = harness({
      chat: {
        events: [
          { type: 'tool_call', toolName: 'shell_exec', toolInput: { command: 'ls' } },
          { type: 'tool_result', result: 'a.txt' },
          { type: 'tool_result', result: 'stray' },
          { type: 'complete' },
        ],
      },
    })
    await newSession(h)
    await h.waitFor(prompt(h))
    const [call, res, orphanCall, orphanRes] = h.updates()
    expect(call.sessionUpdate).toBe('tool_call')
    expect(res).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId })
    // The stray result gets its own self-contained call, not the first one's id.
    expect(orphanCall).toMatchObject({ sessionUpdate: 'tool_call' })
    expect(orphanCall.toolCallId).not.toBe(call.toolCallId)
    expect(orphanRes.toolCallId).toBe(orphanCall.toolCallId)
  })

  it('an empty toolUseId counts as missing', async () => {
    const h = harness({
      chat: { events: [{ type: 'tool_call', toolName: 'glob', toolUseId: '', toolInput: {} }, { type: 'tool_result', toolUseId: '', result: 'r' }, { type: 'complete' }] },
    })
    await newSession(h)
    await h.waitFor(prompt(h))
    const [call, res] = h.updates()
    expect(call.toolCallId).not.toBe('')
    expect(res.toolCallId).toBe(call.toolCallId)
    expect(h.updates()).toHaveLength(2)
  })

  it('two id-less calls of the same tool in one chunk get distinct fallback ids', async () => {
    const h = harness({
      chat: { events: [{ type: 'tool_call', toolName: 'glob', toolInput: {} }, { type: 'tool_call', toolName: 'glob', toolInput: {} }, { type: 'complete' }] },
    })
    await newSession(h)
    await h.waitFor(prompt(h))
    const [a, b] = h.updates()
    expect(a.toolCallId).not.toBe(b.toolCallId)
  })
})

describe('dropped stream → reconnect', () => {
  const hist = (reply: string): SessionHistory => ({
    sessionId: SID,
    running: false,
    messages: [
      { type: 'user', role: 'user', content: 'hi' },
      { type: 'assistant', role: 'assistant', content: reply },
      { type: 'user', role: 'user', content: '(from: session x) report', },
    ],
  })

  it('re-attaches via subscribe, then sends only the missing suffix', async () => {
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: SID }, { type: 'stream', text: 'Hello ' }], end: 'drop' },
      subscribes: [{ events: [{ type: 'session', sessionId: SID }, { type: 'complete' }] }],
      history: hist('Hello world'),
    })
    await newSession(h)
    const res = await h.waitFor(prompt(h))
    expect(res.result).toEqual({ stopReason: 'end_turn' })
    expect(h.calls.subscribe).toBe(1)
    expect(agentText(h)).toBe('Hello world')
  })

  it('a MEDIA: marker line in the reply is stripped like the stream does — no spurious full resend', async () => {
    // Logged reply "Here it is\nMEDIA:/x.png\nMore text"; the server streams
    // it line-flushed with the marker line (and its newline) removed.
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: SID }, { type: 'stream', text: 'Here it is\n' }], end: 'drop' },
      subscribes: [{ events: [{ type: 'stream', text: 'More' }, { type: 'complete' }] }],
      history: hist('Here it is\nMEDIA:/x.png\nMore text'),
    })
    await newSession(h)
    await h.waitFor(prompt(h))
    expect(agentText(h)).toBe('Here it is\nMore text')
  })

  it('streamed text not a prefix of the logged reply → whole reply behind a marker', async () => {
    const h = harness({
      chat: { events: [{ type: 'stream', text: 'Hel' }], end: 'drop' },
      subscribes: [{ events: [{ type: 'stream', text: 'ld' }, { type: 'complete' }] }],
      history: hist('Hello world'),
    })
    await newSession(h)
    await h.waitFor(prompt(h))
    expect(agentText(h)).toBe('Helld[reconnected — full reply]\nHello world')
  })

  it('a re-attached stream that completes with everything sent adds nothing', async () => {
    const h = harness({
      chat: { events: [{ type: 'stream', text: 'Hello ' }], end: 'drop' },
      subscribes: [{ events: [{ type: 'stream', text: 'world' }, { type: 'complete' }] }],
      history: hist('Hello world'),
    })
    await newSession(h)
    await h.waitFor(prompt(h))
    expect(agentText(h)).toBe('Hello world')
  })

  it('failed re-attach attempts back off and retry', async () => {
    const h = harness({
      chat: { events: [{ type: 'stream', text: 'Hello ' }], end: 'drop' },
      subscribes: [{ events: [], throwOnOpen: true }, { events: [], throwOnOpen: true }, { events: [{ type: 'complete' }] }],
      history: hist('Hello world'),
    })
    await newSession(h)
    expect((await h.waitFor(prompt(h))).result).toEqual({ stopReason: 'end_turn' })
    expect(h.calls.subscribe).toBe(3)
    expect(agentText(h)).toBe('Hello world')
  })

  it('5 failed attempts → connection lost chunk, end_turn', async () => {
    const fail = { events: [], throwOnOpen: true }
    const h = harness({
      chat: { events: [{ type: 'stream', text: 'Hel' }], end: 'drop' },
      subscribes: [fail, fail, fail, fail, fail, { events: [{ type: 'complete' }] }],
    })
    await newSession(h)
    expect((await h.waitFor(prompt(h))).result).toEqual({ stopReason: 'end_turn' })
    expect(h.calls.subscribe).toBe(5)
    expect(agentText(h)).toBe('Hel[adapter error] connection lost')
  })

  it('a chat that fails to open is an adapter error, not a reconnect', async () => {
    const h = harness({ chat: { events: [], throwOnOpen: true } })
    await newSession(h)
    expect((await h.waitFor(prompt(h))).result).toEqual({ stopReason: 'end_turn' })
    expect(h.calls.subscribe).toBe(0)
    expect(agentText(h)).toBe('[adapter error] fetch failed')
  })
})

describe('busy session (queued)', () => {
  it('follows the running session via subscribe to the terminal complete', async () => {
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: SID }, { type: 'queued' }] },
      subscribes: [{ events: [{ type: 'session', sessionId: SID }, { type: 'stream', text: 'earlier turn tail. ' }, { type: 'stream', text: 'answer' }, { type: 'complete' }] }],
      history: {
        sessionId: SID, running: false,
        messages: [
          { type: 'user', role: 'user', content: 'old' },
          { type: 'assistant', role: 'assistant', content: 'earlier turn tail. ' },
          { type: 'user', role: 'user', content: 'hi' },
          { type: 'assistant', role: 'assistant', content: 'answer' },
        ],
      },
    })
    await newSession(h)
    const res = await h.waitFor(prompt(h))
    expect(res.result).toEqual({ stopReason: 'end_turn' })
    expect(h.calls.subscribe).toBe(1)
    expect(agentText(h)).toBe('earlier turn tail. answer')
    expect(agentText(h)).not.toContain('[queued')
  })

  it('drain finished before subscribe attached (bare complete) → reply backfilled from history', async () => {
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: SID }, { type: 'queued' }] },
      subscribes: [{ events: [{ type: 'session', sessionId: SID }, { type: 'complete' }] }],
      history: { sessionId: SID, running: false, messages: [{ type: 'user', role: 'user', content: 'hi' }, { type: 'assistant', role: 'assistant', content: 'late answer' }] },
    })
    await newSession(h)
    expect((await h.waitFor(prompt(h))).result).toEqual({ stopReason: 'end_turn' })
    expect(agentText(h)).toBe('late answer')
  })

  it('a queued prompt whose drain streams on subscribe gets that reply', async () => {
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: SID }, { type: 'queued' }] },
      subscribes: [{ events: [{ type: 'stream', text: 'second' }, { type: 'complete' }] }],
    })
    await newSession(h)
    const res = await h.waitFor(prompt(h, 'again'))
    expect(res.result).toEqual({ stopReason: 'end_turn' })
    expect(agentText(h)).toBe('second')
  })

  it('settles with history since the turn start (minus skew), not the whole log', async () => {
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: SID }, { type: 'queued' }] },
      subscribes: [{ events: [{ type: 'complete' }] }],
    })
    await newSession(h)
    const before = Date.now()
    await h.waitFor(prompt(h, 'q'))
    const [call] = h.calls.historyCalls
    expect(call.sessionId).toBe(SID)
    expect(call.since).toBeLessThanOrEqual(before)
    expect(call.since).toBeGreaterThan(before - 10 * 60_000)
  })

  it('a goal-routed id: re-attach + settle follow the goal session (server lets the token address it)', async () => {
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: 'goal_abc' }, { type: 'queued' }] },
      subscribes: [{ events: [{ type: 'complete' }] }],
    })
    await newSession(h)
    await h.waitFor(prompt(h, 'q'))
    expect(h.calls.subscribeIds).toEqual(['goal_abc'])
    expect(h.calls.historyCalls.map((c) => c.sessionId)).toEqual(['goal_abc'])
  })

  it('a routed id inside the same web_<acct>_ prefix is followed', async () => {
    const h = harness({
      chat: { events: [{ type: 'session', sessionId: 'web_acct_other' }, { type: 'queued' }] },
      subscribes: [{ events: [{ type: 'complete' }] }],
    })
    await newSession(h)
    await h.waitFor(prompt(h, 'q'))
    expect(h.calls.subscribeIds).toEqual(['web_acct_other'])
  })
})

describe('JSON-RPC hygiene', () => {
  it('a second prompt while one is in flight is refused; the first still completes', async () => {
    const h = harness({ chat: { events: [{ type: 'session', sessionId: SID }], end: 'hang' } }, { cancelGraceMs: 5 })
    await newSession(h)
    const first = prompt(h)
    await tick()
    const second = await h.waitFor(prompt(h))
    expect(second.error.code).toBe(-32600)
    h.notify('session/cancel', { sessionId: SID })
    expect((await h.waitFor(first)).result).toEqual({ stopReason: 'cancelled' })
  })

  it('an unknown method → -32601; an unknown notification (incl. $/cancel_request) is ignored', async () => {
    const h = harness({})
    h.notify('$/cancel_request', { requestId: 99 })
    h.notify('session/whatever', {})
    const res = await h.waitFor(h.send('session/teleport', {}))
    expect(res.error.code).toBe(-32601)
    // Still alive and answering after the unknown traffic.
    expect((await h.waitFor(h.send('initialize', { protocolVersion: 1 }))).result.protocolVersion).toBe(1)
    expect(h.lines.filter((l) => !('id' in l))).toEqual([])
  })
})

describe('session/list', () => {
  const page: SessionPage = {
    workspace: '/ws',
    sessions: [
      { sessionId: 'web_acct_b', title: 'Second', updatedAt: Date.UTC(2026, 9, 7, 12) },
      { sessionId: 'web_acct_a', title: null, updatedAt: Date.UTC(2026, 9, 7, 11) },
    ],
    nextCursor: 1700,
  }

  it('maps the page to SessionInfo (cwd = workspace, ISO updatedAt, no null title) with an opaque cursor', async () => {
    const h = harness({ list: page })
    const res = await h.waitFor(h.send('session/list', {}))
    expect(res.result).toEqual({
      sessions: [
        { sessionId: 'web_acct_b', cwd: '/ws', title: 'Second', updatedAt: '2026-10-07T12:00:00.000Z' },
        { sessionId: 'web_acct_a', cwd: '/ws', updatedAt: '2026-10-07T11:00:00.000Z' },
      ],
      nextCursor: '1700',
    })
  })

  it('passes the cursor back to the server; the last page carries no nextCursor', async () => {
    const h = harness({ list: { ...page, nextCursor: null } })
    const res = await h.waitFor(h.send('session/list', { cursor: '1700' }))
    expect(h.calls.listCursors).toEqual([1700])
    expect(res.result).not.toHaveProperty('nextCursor')
  })

  it('cwd matching the workspace lists; any other cwd → empty array', async () => {
    const h = harness({ list: page })
    expect((await h.waitFor(h.send('session/list', { cwd: '/ws/' }))).result.sessions).toHaveLength(2)
    expect((await h.waitFor(h.send('session/list', { cwd: '/elsewhere' }))).result).toEqual({ sessions: [] })
  })

  it.each(['abc', '0x10', '1e3', '-1'])('cursor %s (not ours) → invalid params, no server call', async (cursor) => {
    const h = harness({ list: page })
    const res = await h.waitFor(h.send('session/list', { cursor }))
    expect(res.error.code).toBe(-32602)
    expect(h.calls.listCursors).toEqual([])
  })

  it('an empty cursor is the first page', async () => {
    const h = harness({ list: page })
    await h.waitFor(h.send('session/list', { cursor: '' }))
    expect(h.calls.listCursors).toEqual([undefined])
  })
})
