/**
 * Bridges SessionManager events → WeCom stream-message replies.
 *
 * Same strategy as the feishu adapter (shared `ChunkedResponder`): buffer
 * the assistant stream, flush on `complete` as one message; flush early
 * on `system` / `error` so the user always sees something before the run
 * ends. No streaming UI — see Slack adapter rationale. Every chunk goes
 * out as its own *finished* stream message (one bubble each).
 *
 * WeCom caps stream `content` at 20480 bytes. 5000 chars × 4 bytes
 * (UTF-8 worst case) stays under that, so we split on chars and never
 * have to measure bytes.
 */
import { ChunkedResponder, type ResponderDeps } from '../shared/responder.js'

const HARD_CHARS = 5000

export class WecomResponder extends ChunkedResponder {
  constructor(deps: ResponderDeps) {
    // No markdown formatter: WeCom stream content renders CommonMark
    // natively (headings / bold / lists / quotes / links / code / tables).
    super(deps, { limit: HARD_CHARS, logTag: 'WeCom' })
  }
}
