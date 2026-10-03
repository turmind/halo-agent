/**
 * Coalesce agent events into chunked Telegram text messages. Splits
 * mid-stream at TELEGRAM_TEXT_LIMIT and sends every chunk through the shared
 * `ChunkedResponder`'s serialized chain, so a long reply arrives in order.
 */
import { ChunkedResponder, type ResponderDeps } from '../shared/responder.js'

/** Per-message ceiling in chars, under the Bot API's 4096. Shared with the
 *  cron dispatcher so a scheduled push obeys the same limit as a chat reply. */
export const TELEGRAM_TEXT_LIMIT = 4000  // mirrored in templates/prompts/all/RUNTIME.md

export class TelegramResponder extends ChunkedResponder {
  constructor(deps: ResponderDeps) {
    super(deps, { limit: TELEGRAM_TEXT_LIMIT, logTag: 'Telegram', splitMidStream: true })
  }
}
