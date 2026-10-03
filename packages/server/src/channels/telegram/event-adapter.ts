/**
 * Coalesce agent events into chunked Telegram text messages. Splits
 * mid-stream at HARD_CHARS and sends every chunk through the shared
 * `ChunkedResponder`'s serialized chain, so a long reply arrives in order.
 */
import { ChunkedResponder, type ResponderDeps } from '../shared/responder.js'

const HARD_CHARS = 4000  // mirrored in templates/prompts/all/RUNTIME.md

export class TelegramResponder extends ChunkedResponder {
  constructor(deps: ResponderDeps) {
    super(deps, { limit: HARD_CHARS, logTag: 'Telegram', splitMidStream: true })
  }
}
