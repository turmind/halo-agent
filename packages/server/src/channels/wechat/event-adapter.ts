/**
 * Coalesce streaming agent events into chunked WeChat text messages.
 *
 * WeChat sendMessage is block-oriented, not streaming. So we buffer the LLM
 * stream and flush when either:
 *   - Accumulated text reaches MIN_CHARS
 *   - Idle for IDLE_MS (no new chunk arrived)
 *   - `complete` event is received
 *
 * Tool calls are not echoed to WeChat (detail lives in the web UI). Errors are
 * always flushed immediately.
 */
import type { AgentSessionEvent } from '../../agents/agent-events.js'

/**
 * WeChat sendMessage rejects payloads beyond ~4000 chars. When the buffer
 * approaches this ceiling we must split — prefer paragraph boundary, fall
 * back to a hard cut.
 */
const HARD_CHARS = 3500

/**
 * Agent-emitted `MEDIA:<absolute_path>` lines are extracted from the stream
 * before text is flushed to WeChat. Each match triggers the media sender.
 * The marker MUST be on its own line; trailing text on the same line is
 * preserved by only matching up to EOL.
 */
const MEDIA_MARKER_RE = /^MEDIA:\s*(\S.*?)\s*$/gm

export interface WeixinResponderDeps {
  sendText: (text: string) => Promise<void>
  sendMedia: (filePath: string) => Promise<void>
}

export class WeixinResponder {
  private buffer = ''
  private deps: WeixinResponderDeps
  private closed = false

  constructor(deps: WeixinResponderDeps) {
    this.deps = deps
  }

  handle(event: AgentSessionEvent): void {
    if (this.closed) return

    // Drop all sub-agent events — only the root agent's output goes to WeChat.
    // (Sub-agent activity is visible in the web UI's session tree.)
    if (event.taskId) return

    switch (event.type) {
      case 'stream':
        if (event.text) this.append(event.text)
        break
      case 'error':
        if (event.error) {
          this.flushAll()
          void this.dispatchChunk(`[错误] ${event.error}`)
        }
        break
      case 'system':
        if (event.text) {
          this.flushAll()
          void this.dispatchChunk(`[系统] ${event.text}`)
        }
        break
      case 'complete':
        this.flushAll()
        break
      // tool_call / tool_result / thinking intentionally dropped.
    }
  }

  close(): void {
    if (this.closed) return
    this.flushAll()
    this.closed = true
  }

  private append(text: string): void {
    this.buffer += text
    // Only split when we hit WeChat's hard length ceiling. Otherwise keep
    // buffering — 'complete' will flush the whole response as one message.
    while (this.buffer.length >= HARD_CHARS) {
      const cut = this.findSplitPoint(this.buffer, HARD_CHARS)
      const chunk = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut).trimStart()
      void this.dispatchChunk(chunk)
    }
  }

  private flushAll(): void {
    if (!this.buffer) return
    // Even on flush, respect the 3500 hard limit in case of a single huge response.
    while (this.buffer.length > HARD_CHARS) {
      const cut = this.findSplitPoint(this.buffer, HARD_CHARS)
      const chunk = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut).trimStart()
      void this.dispatchChunk(chunk)
    }
    if (this.buffer) {
      const text = this.buffer
      this.buffer = ''
      void this.dispatchChunk(text)
    }
  }

  /**
   * Pick an index ≤ `limit` to split `text` at. Prefer the last paragraph
   * break (`\n\n`) within the limit; fall back to a hard cut at `limit`.
   */
  private findSplitPoint(text: string, limit: number): number {
    const window = text.slice(0, limit)
    const lastPara = window.lastIndexOf('\n\n')
    if (lastPara > limit / 2) return lastPara + 2
    return limit
  }

  /**
   * Extract MEDIA: lines, dispatching them as media sends. Remaining text
   * goes out as a WeChat message (if non-empty after trim).
   */
  private async dispatchChunk(chunk: string): Promise<void> {
    const mediaPaths: string[] = []
    const text = chunk.replace(MEDIA_MARKER_RE, (_m, p: string) => {
      if (p) mediaPaths.push(p.trim())
      return ''
    }).replace(/\n{3,}/g, '\n\n').trim()

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { console.log(`[weixin] sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { console.log(`[weixin] sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}
