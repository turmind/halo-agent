/**
 * SSE `Response` builders for stubbed-`fetch` tests of the streaming
 * providers. Not a test file itself (vitest only collects `test/**\/*.test.ts`).
 */

/** One `data: <json>\n\n` frame per event, terminated by `data: [DONE]` unless `done: false`. */
export function sseResponse(events: unknown[], opts: { done?: boolean; status?: number } = {}): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (opts.done !== false ? 'data: [DONE]\n\n' : '')
  return new Response(body, { status: opts.status ?? 200, headers: { 'content-type': 'text/event-stream' } })
}

