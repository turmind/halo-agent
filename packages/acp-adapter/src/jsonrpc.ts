/**
 * Newline-delimited JSON-RPC 2.0 over a Node Readable + Writable pair
 * (stdio for ACP). Just enough of the spec to act as a JSON-RPC peer:
 * dispatch requests, send responses, fire one-way notifications, await
 * outbound request results.
 *
 * ACP frames messages with a single `\n` separator (no Content-Length
 * header like LSP). Each line is a complete JSON object.
 */
import { type Readable, type Writable } from 'node:stream'

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number | string
  result: unknown
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: number | string | null
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError

/** Standard JSON-RPC error codes. */
export const ERROR_PARSE = -32700
export const ERROR_INVALID_REQUEST = -32600
export const ERROR_METHOD_NOT_FOUND = -32601
export const ERROR_INVALID_PARAMS = -32602
export const ERROR_INTERNAL = -32603

export type RequestHandler = (params: unknown, ctx: { id: number | string }) => unknown | Promise<unknown>
export type NotificationHandler = (params: unknown) => void | Promise<void>

export class JsonRpcConnection {
  private nextId = 1
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private requestHandlers = new Map<string, RequestHandler>()
  private notificationHandlers = new Map<string, NotificationHandler>()
  private buffer = ''

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly logger: (msg: string) => void = () => {},
  ) {
    input.setEncoding('utf-8')
    input.on('data', (chunk: string) => this.onData(chunk))
    input.on('end', () => this.onEnd())
  }

  /** Register a handler for an inbound JSON-RPC request (returns a value
   *  that becomes the response `result`). Throw to surface an error to
   *  the peer; non-Error throws are wrapped. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  /** Register a handler for an inbound notification (no response). */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  /** Send a request to the peer and await its response. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return (await promise) as T
  }

  /** Fire a one-way notification. */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(msg: object): void {
    this.output.write(JSON.stringify(msg) + '\n')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    // ACP framing: one JSON object per line. Split conservatively in case
    // a chunk straddles boundaries.
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line) this.dispatch(line)
      nl = this.buffer.indexOf('\n')
    }
  }

  private onEnd(): void {
    // Reject all in-flight outbound requests when the peer disconnects —
    // otherwise `await connection.request(...)` would hang forever.
    for (const [, p] of this.pending) {
      p.reject(new Error('connection closed'))
    }
    this.pending.clear()
  }

  private dispatch(line: string): void {
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch (err) {
      this.logger(`parse error: ${err instanceof Error ? err.message : String(err)} on line: ${line.slice(0, 200)}`)
      // Per JSON-RPC: respond with parse error if there was an id, else stay silent.
      this.write({ jsonrpc: '2.0', id: null, error: { code: ERROR_PARSE, message: 'parse error' } })
      return
    }

    if ('method' in msg && 'id' in msg) {
      this.handleRequest(msg as JsonRpcRequest)
      return
    }
    if ('method' in msg) {
      this.handleNotification(msg as JsonRpcNotification)
      return
    }
    if ('id' in msg) {
      this.handleResponse(msg as JsonRpcSuccess | JsonRpcError)
      return
    }
    this.logger(`unrecognized message: ${line.slice(0, 200)}`)
  }

  private handleRequest(msg: JsonRpcRequest): void {
    const handler = this.requestHandlers.get(msg.method)
    if (!handler) {
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: ERROR_METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } })
      return
    }
    void Promise.resolve()
      .then(() => handler(msg.params, { id: msg.id }))
      .then((result) => {
        this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
      })
      .catch((err: unknown) => {
        const e = err as { code?: number; message?: string; data?: unknown }
        const code = typeof e?.code === 'number' ? e.code : ERROR_INTERNAL
        const message = typeof e?.message === 'string' ? e.message : 'internal error'
        const data = e?.data
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code, message, ...(data !== undefined ? { data } : {}) } })
      })
  }

  private handleNotification(msg: JsonRpcNotification): void {
    const handler = this.notificationHandlers.get(msg.method)
    if (!handler) {
      // Unknown notifications are silently dropped per JSON-RPC.
      return
    }
    void Promise.resolve()
      .then(() => handler(msg.params))
      .catch((err: unknown) => {
        const m = err instanceof Error ? err.message : String(err)
        this.logger(`notification handler "${msg.method}" threw: ${m}`)
      })
  }

  private handleResponse(msg: JsonRpcSuccess | JsonRpcError): void {
    if (msg.id == null) return
    const slot = this.pending.get(msg.id)
    if (!slot) return
    this.pending.delete(msg.id)
    if ('error' in msg) {
      const err = new Error(msg.error.message) as Error & { code?: number; data?: unknown }
      err.code = msg.error.code
      err.data = msg.error.data
      slot.reject(err)
    } else {
      slot.resolve(msg.result)
    }
  }
}
