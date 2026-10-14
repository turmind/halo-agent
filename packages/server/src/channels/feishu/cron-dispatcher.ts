/**
 * Feishu cron dispatcher. Requires an explicit `chatId` —
 * `lastActiveChatId` fallback removed for the same reason as slack:
 * the most-recent inbound is rarely the cron creator. Cron from
 * inside a feishu chat auto-pins the current chat; admin-UI cron
 * without an explicit target runs silently.
 *
 * `chatId` shape:
 *   - `oc_xxxxxxxx`  — group chat id (push lands as a top-level message)
 *   - `oc_xxx:omfm…` — `<chatId>:<rootId>`, anchored at a thread (we
 *                      currently send flat to the chat regardless of
 *                      rootId — Feishu's open API doesn't have a
 *                      "post into existing thread" sendMessage path
 *                      analogous to Slack's thread_ts. The rootId is
 *                      kept in the storage shape for forward-compat.)
 *
 * `MEDIA:` attachments are NOT implemented here — this dispatcher doesn't
 * declare `supportsMedia`, so `dispatchToTargets` hands it the original
 * text with `MEDIA:` lines intact (the path stays visible instead of
 * silently vanishing). The realtime path's uploader (`sendFeishuMedia` in
 * `handler.ts`) is anchored to an inbound `messageId` for thread replies,
 * which a cron run doesn't have; wiring cron up means splitting the
 * send-to-chat half out of it, then adding `supportsMedia: true` + a
 * `CronMedia` 4th arg below.
 */
import { getChannelDb } from '../../db/channel-db.js'
import { getAccount as getFeishuAccount, listAccounts as listFeishuAccounts } from './accounts.js'
import { sendMessage } from './api.js'
import { FEISHU_TEXT_LIMIT } from './event-adapter.js'
import { splitText } from '../shared/chunk.js'
import { formatForFeishu } from '../shared/markdown.js'
import { registerCronDispatcher, type CronTargetOption, type DispatchResult } from '../../cron/dispatcher.js'

function parseChatId(raw: string): { chatId: string } {
  const idx = raw.indexOf(':')
  return { chatId: idx < 0 ? raw : raw.slice(0, idx) }
}

async function dispatch(accountId: string, text: string, explicitChatId?: string): Promise<DispatchResult[]> {
  const acct = getFeishuAccount(getChannelDb(), accountId)
  if (!acct) throw new Error(`feishu account ${accountId} not found`)
  if (acct.enabled !== 1) throw new Error(`feishu account ${accountId} disabled`)

  if (!explicitChatId) {
    throw new Error('feishu cron target requires an explicit chatId (e.g. "oc_abcd1234"). Create the cron from inside a feishu chat to auto-pin, or pass --targets feishu:<accountId>:<chatId>.')
  }
  const { chatId } = parseChatId(explicitChatId)
  // Same pipeline as a chat reply (FeishuResponder): cut the raw text at
  // FEISHU_TEXT_LIMIT, then strip CommonMark per chunk (the text msg type
  // shows `**` literally). Chunks go out sequentially; a failed chunk names
  // its index (chunks before it are delivered) and skips the rest.
  const chunks = splitText(text, FEISHU_TEXT_LIMIT)
  for (const [i, chunk] of chunks.entries()) {
    try {
      await sendMessage({
        appId: acct.appId, appSecret: acct.appSecret,
        receiveIdType: 'chat_id', receiveId: chatId,
        msgType: 'text', content: { text: formatForFeishu(chunk) },
      })
    } catch (err) {
      return [{
        channelType: 'feishu', accountId, chatId: explicitChatId,
        ok: false, error: `chunk ${i + 1}/${chunks.length}: ${err instanceof Error ? err.message : String(err)}`,
      }]
    }
  }
  return [{ channelType: 'feishu', accountId, chatId: explicitChatId, ok: true }]
}

function listTargets(): CronTargetOption[] {
  const cdb = getChannelDb()
  return listFeishuAccounts(cdb).map((a) => ({
    channelType: 'feishu',
    accountId: a.accountId,
    label: a.label || a.accountId,
    workspacePath: a.workspacePath,
    enabled: a.enabled === 1,
    hasActiveChat: true,
  }))
}

export function registerFeishuCronDispatcher(): void {
  registerCronDispatcher({ channelType: 'feishu', dispatch, listTargets })
}
