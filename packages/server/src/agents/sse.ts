/**
 * readSseJson — Server-Sent Events → JSON payloads, one per frame.
 *
 * Shared by every fetch-based streaming provider: the Anthropic-Messages
 * family (`fetchAnthropicStream` in anthropic-stream.ts) and the OpenAI-family
 * `chat/completions` streams. Only the `data:` payload is used — every
 * provider we speak to repeats the event name inside the JSON (`type` /
 * `object`), so `event:` / `id:` / `retry:` and `:comment` lines are ignored.
 *
 * Rules: frames are separated by a blank line (`\r\n` normalized to `\n`);
 * the `data:` lines of a frame are joined with `\n` after stripping the
 * prefix and one optional space (MiniMax sends `data: {…}`, Qwen `data:{…}`);
 * a payload that is exactly `[DONE]` (the OpenAI terminator) is skipped; a
 * trailing frame without the final blank line is still parsed. Malformed
 * JSON throws — a gateway emitting garbage is a real error, and silently
 * dropping e.g. a `message_delta` would lose the stop_reason.
 */
export async function* readSseJson<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader()
  // `stream: true` below — multibyte text (Chinese replies) splits across TCP chunks.
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const payload = frameData(buffer.slice(0, sep))
        buffer = buffer.slice(sep + 2)
        if (payload !== undefined) yield JSON.parse(payload) as T
      }
    }
    const payload = frameData((buffer + decoder.decode()).replace(/\r\n/g, '\n'))
    if (payload !== undefined) yield JSON.parse(payload) as T
  } finally {
    reader.releaseLock()
  }
}

/** The joined `data:` payload of one frame; undefined when there is none (comment / event-only / blank) or it is `[DONE]`. */
function frameData(frame: string): string | undefined {
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    data.push(line.slice(line[5] === ' ' ? 6 : 5))
  }
  if (data.length === 0) return undefined
  const payload = data.join('\n')
  return payload === '[DONE]' ? undefined : payload
}
