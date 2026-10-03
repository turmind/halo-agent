/**
 * Bridges SessionManager events → a single Feishu message reply.
 *
 * Same strategy as the Slack adapter (shared `ChunkedResponder`): buffer
 * the assistant stream, flush on `complete` as one message; flush early
 * on `system` / `error` so the user always sees something before the run
 * ends. No streaming UI — see Slack adapter rationale.
 *
 * Feishu's text limit is much smaller than Slack (~5000 chars per
 * message in practice), so we cap each chunk lower. Splits prefer
 * paragraph boundaries; otherwise hard-cut at the limit.
 */
import { formatForFeishu } from '../shared/markdown.js'
import { ChunkedResponder, type ResponderDeps } from '../shared/responder.js'

const HARD_CHARS = 4500  // mirrored in templates/prompts/all/RUNTIME.md

export class FeishuResponder extends ChunkedResponder {
  constructor(deps: ResponderDeps) {
    // Feishu's text msg type renders markup literally; strip the
    // common-mark markers so users don't see stray `**` / `[link]`.
    super(deps, { limit: HARD_CHARS, logTag: 'Feishu', format: formatForFeishu })
  }
}
