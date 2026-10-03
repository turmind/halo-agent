/**
 * Coalesce agent events into chunked WeChat text messages.
 *
 * WeChat sendMessage is block-oriented, not streaming. Only the root agent's
 * wrap-up text (`stream` events flagged `final`) is buffered; the filler the
 * model emits before tool calls, and all tool activity, stays in the web UI.
 * The buffer is flushed on `complete`, and ahead of an `error` / `system`
 * notice so the notice lands after the text it follows. Anything over
 * WECHAT_TEXT_LIMIT is cut with the shared `splitText` (mid-stream, and
 * again on flush), and every chunk goes through one serialized send chain so
 * a long reply arrives in order — the shared `ChunkedResponder` owns all of
 * that; this file adds `onSendError`.
 */
import { ChunkedResponder, type ResponderDeps } from '../shared/responder.js'

/**
 * Per-message ceiling in JS string chars (UTF-16 units), not bytes. The
 * gateway rejects a sendmessage body over 16 KB with `ret=-2 "prepare failed"`;
 * a char is at most 3 UTF-8 bytes (CJK — a 4-byte emoji is two chars), so
 * 3500 chars is ≤ ~10.5 KB and fits alongside the JSON envelope. Splits
 * prefer a paragraph boundary, else hard-cut. Shared with the cron
 * dispatcher so a scheduled push obeys the same limit as a chat reply.
 */
export const WECHAT_TEXT_LIMIT = 3500  // mirrored in templates/prompts/all/RUNTIME.md

export interface WechatResponderDeps extends ResponderDeps {
  /** Called once per failed send with a one-line reason, so the failure can
   *  be recorded where the user looks (the session log) instead of only in
   *  the server log. Must not send to WeChat itself. */
  onSendError?: (message: string) => void
}

export class WechatResponder extends ChunkedResponder {
  private onSendError?: (message: string) => void

  constructor(deps: WechatResponderDeps) {
    super(deps, { limit: WECHAT_TEXT_LIMIT, logTag: 'WeChat', splitMidStream: true })
    this.onSendError = deps.onSendError
  }

  protected onSendFailed(message: string): void {
    super.onSendFailed(message)
    this.onSendError?.(message)
  }
}
