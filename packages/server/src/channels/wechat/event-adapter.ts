/**
 * Coalesce agent events into chunked WeChat text messages.
 *
 * WeChat sendMessage is block-oriented, not streaming. Only the root agent's
 * wrap-up text (`stream` events flagged `final`) is buffered; the filler the
 * model emits before tool calls, and all tool activity, stays in the web UI.
 * The buffer is flushed on `complete`, and ahead of an `error` / `system`
 * notice so the notice lands after the text it follows. Anything over
 * WECHAT_TEXT_LIMIT is cut with the shared `splitText` (mid-stream in
 * `append`, and again on flush), and every chunk goes through one serialized
 * send chain (`sendTail`) so a long reply arrives in order.
 */
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { splitText } from '../shared/chunk.js'
import { extractMediaMessage } from '../shared/media.js'

/**
 * Per-message ceiling in JS string chars (UTF-16 units), not bytes. The
 * gateway rejects a sendmessage body over 16 KB with `ret=-2 "prepare failed"`;
 * a char is at most 3 UTF-8 bytes (CJK — a 4-byte emoji is two chars), so
 * 3500 chars is ≤ ~10.5 KB and fits alongside the JSON envelope. Splits
 * prefer a paragraph boundary, else hard-cut. Shared with the cron
 * dispatcher so a scheduled push obeys the same limit as a chat reply.
 */
export const WECHAT_TEXT_LIMIT = 3500  // mirrored in templates/prompts/all/RUNTIME.md

export interface WechatResponderDeps {
  sendText: (text: string) => Promise<void>
  sendMedia: (filePath: string) => Promise<void>
}

export class WechatResponder {
  private buffer = ''
  private deps: WechatResponderDeps
  private closed = false
  /** Tail of the per-responder send chain — see `enqueueChunk`. */
  private sendTail: Promise<void> = Promise.resolve()

  constructor(deps: WechatResponderDeps) {
    this.deps = deps
  }

  handle(event: AgentSessionEvent): void {
    if (this.closed) return

    // Drop all sub-agent events — only the root agent's output goes to WeChat.
    // (Sub-agent activity is visible in the web UI's session tree.)
    if (event.taskId) return

    switch (event.type) {
      case 'stream':
        // Only the wrap-up reply (`final`) reaches the chat. The filler the
        // model emits before a tool call stays in the web UI, not here.
        if (event.final && event.text) this.append(event.text)
        break
      case 'error':
        if (event.error) {
          this.flushAll()
          this.enqueueChunk(`❌ ${event.error}`)
        }
        break
      case 'system':
        if (event.text) {
          this.flushAll()
          this.enqueueChunk(`ℹ️ ${event.text}`)
        }
        break
      case 'complete':
        this.flushAll()
        break
      // tool_call / tool_result / thinking intentionally dropped.
    }
  }

  /** Returns the drain promise so the bridge keeps the reply route alive
   *  until the last queued chunk has actually been sent. */
  close(): Promise<void> {
    if (this.closed) return this.sendTail
    this.flushAll()
    this.closed = true
    return this.sendTail
  }

  private append(text: string): void {
    this.buffer += text
    // Only split when we hit WeChat's hard length ceiling. Otherwise keep
    // buffering — 'complete' will flush the whole response as one message.
    if (this.buffer.length <= WECHAT_TEXT_LIMIT) return
    const chunks = splitText(this.buffer, WECHAT_TEXT_LIMIT)
    // The last piece is the under-limit remainder — keep buffering it.
    this.buffer = chunks.pop() ?? ''
    for (const chunk of chunks) this.enqueueChunk(chunk)
  }

  private flushAll(): void {
    if (!this.buffer) return
    // Even on flush, respect the hard limit in case of a single huge response.
    const chunks = splitText(this.buffer, WECHAT_TEXT_LIMIT)
    this.buffer = ''
    for (const chunk of chunks) this.enqueueChunk(chunk)
  }

  /**
   * Serialize sends per responder — same rationale as the Slack adapter
   * (audit A-L3): a flush emits several chunks in one synchronous loop, and
   * firing their HTTP sends concurrently gave arrival order no guarantee.
   * Each chunk waits for the previous send to settle; the `catch` keeps a
   * rejected link from poisoning the chain (dispatchChunk already logs
   * per-send failures).
   */
  private enqueueChunk(chunk: string): void {
    this.sendTail = this.sendTail
      .then(() => this.dispatchChunk(chunk))
      .catch(() => { /* already logged in dispatchChunk */ })
  }

  /**
   * Extract MEDIA: lines, dispatching them as media sends. Remaining text
   * goes out as a WeChat message (if non-empty after trim).
   */
  private async dispatchChunk(chunk: string): Promise<void> {
    const { text, mediaPaths } = extractMediaMessage(chunk)

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { console.warn(`[WeChat] sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { console.warn(`[WeChat] sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}
