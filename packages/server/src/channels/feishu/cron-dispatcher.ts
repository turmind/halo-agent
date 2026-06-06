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
 */
import { getChannelDb } from '../../db/channel-db.js'
import { getAccount as getFeishuAccount, listAccounts as listFeishuAccounts } from './accounts.js'
import { sendMessage } from './api.js'
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
  try {
    await sendMessage({
      appId: acct.appId, appSecret: acct.appSecret,
      receiveIdType: 'chat_id', receiveId: chatId,
      msgType: 'text', content: { text },
    })
    return [{ channelType: 'feishu', accountId, chatId: explicitChatId, ok: true }]
  } catch (err) {
    return [{
      channelType: 'feishu', accountId, chatId: explicitChatId,
      ok: false, error: err instanceof Error ? err.message : String(err),
    }]
  }
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
