import { PassThrough } from 'node:stream'
import { describe, it, expect, vi } from 'vitest'
import { JsonRpcConnection, ERROR_PARSE, ERROR_METHOD_NOT_FOUND, ERROR_INVALID_PARAMS, ERROR_INTERNAL } from '../src/jsonrpc.js'

function harness() {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: unknown[] = []
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line))
    }
  })
  const conn = new JsonRpcConnection(input, output)
  return { input, output, lines, conn }
}

async function flush() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

describe('JsonRpcConnection framing', () => {
  it('dispatches a request split across two writes mid-JSON exactly once', async () => {
    const { input, lines, conn } = harness()
    const handler = vi.fn().mockReturnValue('pong')
    conn.onRequest('ping', handler)

    input.write('{"jsonrpc":"2.0","id":1,"me')
    input.write('thod":"ping","params":{}}\n')
    await flush()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([{ jsonrpc: '2.0', id: 1, result: 'pong' }])
  })

  it('dispatches two complete messages in one write, in order', async () => {
    const { input, lines, conn } = harness()
    const seen: string[] = []
    conn.onRequest('a', () => {
      seen.push('a')
      return 1
    })
    conn.onRequest('b', () => {
      seen.push('b')
      return 2
    })

    input.write('{"jsonrpc":"2.0","id":1,"method":"a","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"b","params":{}}\n')
    await flush()

    expect(seen).toEqual(['a', 'b'])
    expect(lines).toEqual([
      { jsonrpc: '2.0', id: 1, result: 1 },
      { jsonrpc: '2.0', id: 2, result: 2 },
    ])
  })

  it('tolerates \\r\\n line endings and blank lines between messages', async () => {
    const { input, lines, conn } = harness()
    conn.onRequest('ping', () => 'pong')

    input.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\r\n\r\n{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}\r\n')
    await flush()

    expect(lines).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'pong' },
      { jsonrpc: '2.0', id: 2, result: 'pong' },
    ])
  })

  it('responds with a parse error for an unparseable line, then keeps working', async () => {
    const { input, lines, conn } = harness()
    conn.onRequest('ping', () => 'pong')

    input.write('not json at all\n{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n')
    await flush()

    expect(lines[0]).toEqual({ jsonrpc: '2.0', id: null, error: { code: ERROR_PARSE, message: 'parse error' } })
    expect(lines[1]).toEqual({ jsonrpc: '2.0', id: 1, result: 'pong' })
  })

  it('responds with method not found for an unknown method, carrying the id', async () => {
    const { input, lines, conn } = harness()
    void conn

    input.write('{"jsonrpc":"2.0","id":7,"method":"nope","params":{}}\n')
    await flush()

    expect(lines).toHaveLength(1)
    const [msg] = lines as Array<{ id: number; error: { code: number } }>
    expect(msg.id).toBe(7)
    expect(msg.error.code).toBe(ERROR_METHOD_NOT_FOUND)
  })

  it('maps a handler throw carrying a code to that error code', async () => {
    const { input, lines, conn } = harness()
    conn.onRequest('bad', () => {
      throw Object.assign(new Error('bad'), { code: ERROR_INVALID_PARAMS })
    })

    input.write('{"jsonrpc":"2.0","id":1,"method":"bad","params":{}}\n')
    await flush()

    const [msg] = lines as Array<{ error: { code: number } }>
    expect(msg.error.code).toBe(ERROR_INVALID_PARAMS)
  })

  it('maps a plain Error throw to the internal error code', async () => {
    const { input, lines, conn } = harness()
    conn.onRequest('bad', () => {
      throw new Error('x')
    })

    input.write('{"jsonrpc":"2.0","id":1,"method":"bad","params":{}}\n')
    await flush()

    const [msg] = lines as Array<{ error: { code: number } }>
    expect(msg.error.code).toBe(ERROR_INTERNAL)
  })

  it('calls the notification handler for a message with no id, and writes nothing', async () => {
    const { input, output, lines, conn } = harness()
    const handler = vi.fn()
    conn.onNotification('note', handler)
    const written = vi.fn()
    output.on('data', written)

    input.write('{"jsonrpc":"2.0","method":"note","params":{"x":1}}\n')
    await flush()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ x: 1 })
    expect(lines).toHaveLength(0)
  })

  it('outbound request writes a framed request and resolves on a matching success response', async () => {
    const { input, lines, conn } = harness()

    const pending = conn.request('foo', { a: 1 })
    await flush()

    expect(lines).toEqual([{ jsonrpc: '2.0', id: 1, method: 'foo', params: { a: 1 } }])

    input.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n')
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('outbound request rejects on a matching error response', async () => {
    const { input, conn } = harness()

    const pending = conn.request('foo')
    await flush()

    input.write('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"nope"}}\n')
    await expect(pending).rejects.toThrow('nope')
  })

  it('rejects a pending outbound request with "connection closed" on input end', async () => {
    const { input, conn } = harness()

    const pending = conn.request('foo')
    await flush()
    input.end()

    await expect(pending).rejects.toThrow('connection closed')
  })
})
