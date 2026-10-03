/**
 * Telegram cron dispatcher. Requires an explicit `chatId` —
 * "fan out to whoever happens to be in allowedUsers" or "fall back
 * to the latest inbound" felt clever but in practice always pushed
 * the cron output to a stranger's chat. The cron creator's intent is
 * "reach me, the person who set this up", so we only deliver when
 * the caller passes the numeric chat id explicitly.
 *
 * Cron jobs created from inside a telegram chat via the
 * `cron` skill auto-pin the current chat id; admin-UI
 * cron jobs that don't specify a target run silently — the result
 * shows in the cron log, nothing pushed.
 *
 * `MEDIA:` attachments are NOT implemented here — this dispatcher doesn't
 * declare `supportsMedia`, so `dispatchToTargets` hands it the original
 * text with `MEDIA:` lines intact (the path stays visible instead of
 * silently vanishing). The realtime path's file send is an inline
 * `sendPhoto/sendVideo/sendVoice/sendDocument` switch inside `handler.ts`'s
 * responder, not a reusable function; wiring cron up means extracting that
 * switch — do it there, not by copying it — then adding `supportsMedia:
 * true` + a `CronMedia` 4th arg below.
 */
import { Bot } from 'grammy'
import { getChannelDb } from '../../db/channel-db.js'
import { getAccount as getTelegramAccount, listAccounts as listTelegramAccounts } from './accounts.js'
import { TELEGRAM_TEXT_LIMIT } from './event-adapter.js'
import { splitText } from '../shared/chunk.js'
import { registerCronDispatcher, type CronTargetOption, type DispatchResult } from '../../cron/dispatcher.js'

async function dispatch(accountId: string, text: string, explicitChatId?: string): Promise<DispatchResult[]> {
  const acct = getTelegramAccount(getChannelDb(), accountId)
  if (!acct) throw new Error(`telegram account ${accountId} not found`)
  if (acct.enabled !== 1) throw new Error(`telegram account ${accountId} disabled`)

  if (!explicitChatId) {
    throw new Error('telegram cron target requires an explicit chatId (numeric — Telegram private-chat ids equal user ids, group ids are negative). Create the cron from inside a chat to auto-pin, or pass --targets telegram:<accountId>:<chatId>.')
  }
  const chatIdNum = Number(explicitChatId)
  if (!Number.isFinite(chatIdNum)) {
    return [{
      channelType: 'telegram', accountId, chatId: explicitChatId,
      ok: false, error: `invalid chatId (must be numeric — @usernames don't work for sendMessage)`,
    }]
  }
  // Chunked like a chat reply — one sendMessage over the Bot API's 4096 cap
  // failed the whole report. Chunks go out sequentially so a long report
  // arrives in order; a failed chunk names its index so the run row shows how
  // much already landed (chunks before it are delivered, not rolled back).
  const api = new Bot(acct.botToken).api
  const chunks = splitText(text, TELEGRAM_TEXT_LIMIT)
  for (const [i, chunk] of chunks.entries()) {
    try {
      await api.sendMessage(chatIdNum, chunk, { parse_mode: undefined })
    } catch (err) {
      return [{
        channelType: 'telegram', accountId, chatId: explicitChatId,
        ok: false, error: `chunk ${i + 1}/${chunks.length}: ${err instanceof Error ? err.message : String(err)}`,
      }]
    }
  }
  return [{ channelType: 'telegram', accountId, chatId: explicitChatId, ok: true }]
}

function listTargets(): CronTargetOption[] {
  const cdb = getChannelDb()
  return listTelegramAccounts(cdb).map((a) => ({
    channelType: 'telegram',
    accountId: a.accountId,
    label: a.label || a.accountId,
    workspacePath: a.workspacePath,
    enabled: a.enabled === 1,
    hasActiveChat: true,
  }))
}

export function registerTelegramCronDispatcher(): void {
  registerCronDispatcher({ channelType: 'telegram', dispatch, listTargets })
}
