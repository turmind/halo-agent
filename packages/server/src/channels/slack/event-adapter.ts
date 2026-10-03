/**
 * Bridges SessionManager events → a single Slack message reply.
 *
 * Strategy: buffer the assistant's stream chunks, then on `complete`
 * post one `chat.postMessage` with the full text. No streaming UI,
 * no per-chunk updates, no blocks/cards — the user explicitly opted
 * out of streaming. Errors and system notices flush immediately so
 * the user sees what's happening even if the run never completes.
 * The buffering / serialized send chain lives in `shared/responder.ts`.
 *
 * Slack hard-caps a message body at ~40k chars; we split at the
 * paragraph boundary closest to 35k just under that, sending each
 * slice as its own message in the same thread.
 */
import { formatForSlack } from '../shared/markdown.js'
import { ChunkedResponder, type ResponderDeps } from '../shared/responder.js'

const HARD_CHARS = 35_000

export class SlackResponder extends ChunkedResponder {
  constructor(deps: ResponderDeps) {
    // Convert CommonMark → mrkdwn before send. Stream chunks, system
    // notices, and slash-command output all flow through here, so
    // bold/italic/links/headers come out right regardless of source.
    super(deps, { limit: HARD_CHARS, logTag: 'Slack', format: formatForSlack })
  }
}
