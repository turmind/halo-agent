/**
 * Bridges SessionManager events → a single Slack message reply.
 *
 * Strategy: buffer the assistant's stream chunks, then on `complete`
 * post one `chat.postMessage` with the full text. No streaming UI,
 * no per-chunk updates, no blocks/cards — the user explicitly opted
 * out of streaming. Errors and system notices flush immediately so
 * the user sees what's happening even if the run never completes.
 *
 * Slack hard-caps a message body at ~40k chars; we split at the
 * paragraph boundary closest to 35k just under that, sending each
 * slice as its own message in the same thread.
 */
import type { AgentSessionEvent } from '../../agents/agent-events.js'
import { splitText } from '../shared/chunk.js'
import { formatForSlack } from '../shared/markdown.js'
import { extractMediaMessage } from '../shared/media.js'

const HARD_CHARS = 35_000

export interface SlackResponderDeps {
  sendText: (text: string) => Promise<void>
  sendMedia: (filePath: string) => Promise<void>
}

export class SlackResponder {
  private buffer = ''
  private deps: SlackResponderDeps
  private closed = false
  /** Tail of the per-responder send chain — see `enqueueChunk`. */
  private sendTail: Promise<void> = Promise.resolve()

  constructor(deps: SlackResponderDeps) {
    this.deps = deps
  }

  handle(event: AgentSessionEvent): void {
    if (this.closed) return
    // Sub-agent activity ('taskId' set) doesn't surface to the user —
    // only the root assistant's reply matters in chat channels.
    if (event.taskId) return

    switch (event.type) {
      case 'stream':
        // Only the wrap-up reply (`final`) reaches the chat. The filler the
        // model emits before a tool call stays in the web UI, not here.
        if (event.final && event.text) this.buffer += event.text
        break
      case 'system':
        if (event.text) {
          this.flushBuffer()
          this.enqueueChunk(`ℹ️ ${event.text}`)
        }
        break
      case 'error':
        if (event.error) {
          this.flushBuffer()
          this.enqueueChunk(`❌ ${event.error}`)
        }
        break
      case 'complete':
        this.flushBuffer()
        break
    }
  }

  /** Returns the drain promise so the bridge keeps the reply route alive
   *  until the last queued chunk has actually been sent. */
  close(): Promise<void> {
    if (this.closed) return this.sendTail
    this.flushBuffer()
    this.closed = true
    return this.sendTail
  }

  private flushBuffer(): void {
    if (!this.buffer) return
    const chunks = splitText(this.buffer, HARD_CHARS)
    this.buffer = ''
    for (const chunk of chunks) this.enqueueChunk(chunk)
  }

  /**
   * Serialize sends per responder. `flushBuffer` can produce several chunks
   * in one synchronous loop; dispatching them concurrently let their HTTP
   * calls race, so a long reply could land out of order (audit A-L3). Each
   * chunk now waits for the previous one's send to settle. The `catch` keeps
   * a rejected link from poisoning the chain — dispatchChunk already logs
   * per-send failures, so this only absorbs the unexpected.
   */
  private enqueueChunk(chunk: string): void {
    this.sendTail = this.sendTail
      .then(() => this.dispatchChunk(chunk))
      .catch(() => { /* already logged in dispatchChunk */ })
  }

  private async dispatchChunk(chunk: string): Promise<void> {
    const { text: stripped, mediaPaths } = extractMediaMessage(chunk)
    // Convert CommonMark → mrkdwn before send. Stream chunks, system
    // notices, and slash-command output all flow through here, so
    // bold/italic/links/headers come out right regardless of source.
    const text = formatForSlack(stripped)

    if (text) {
      try { await this.deps.sendText(text) }
      catch (err) { console.log(`[slack] sendText failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
    for (const p of mediaPaths) {
      try { await this.deps.sendMedia(p) }
      catch (err) { console.log(`[slack] sendMedia ${p} failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
}
