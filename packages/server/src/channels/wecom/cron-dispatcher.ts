/**
 * WeCom cron dispatcher. Requires an explicit `chatId` — same rule as
 * slack / feishu: the most-recent inbound is rarely the cron creator.
 * Cron from inside a WeCom chat auto-pins the current chat; admin-UI cron
 * without an explicit target runs silently.
 *
 * `chatId` shape (exactly what `pickConversation` cached as `chatKey`):
 *   - `<userid>` — single chat (push lands in the user's bot DM)
 *   - `<chatid>` — group chat
 * `sendMessage` omits `chat_type`; the server's compat mode resolves
 * single vs group from the id itself.
 *
 * Why no HTTP path: 智能机器人 has no REST send API — proactive push
 * (`aibot_send_msg`) is a frame on the SAME long-connect that receives
 * callbacks, so we borrow the handler's live `WSClient` via `liveClients`.
 * No socket (account stopped / kicked / auth exhausted) → the run fails
 * loudly instead of queueing. WeCom also only accepts a push to a user
 * who has messaged the bot at least once.
 *
 * `MEDIA:` attachments are NOT implemented — no `supportsMedia`, so
 * `dispatchToTargets` hands over the text with `MEDIA:` lines intact.
 */
import { getChannelDb } from '../../db/channel-db.js'
import { getAccount as getWecomAccount, listAccounts as listWecomAccounts } from './accounts.js'
import { liveClients } from './handler.js'
import { registerCronDispatcher, type CronTargetOption, type DispatchResult } from '../../cron/dispatcher.js'

async function dispatch(accountId: string, text: string, explicitChatId?: string): Promise<DispatchResult[]> {
  const acct = getWecomAccount(getChannelDb(), accountId)
  if (!acct) throw new Error(`wecom account ${accountId} not found`)
  if (acct.enabled !== 1) throw new Error(`wecom account ${accountId} disabled`)

  if (!explicitChatId) {
    throw new Error('wecom cron target requires an explicit chatId (userid for single chat, chatid for group). Create the cron from inside a WeCom chat to auto-pin, or pass --targets wecom:<accountId>:<chatId>.')
  }
  const client = liveClients.get(accountId)
  if (!client) {
    return [{ channelType: 'wecom', accountId, chatId: explicitChatId, ok: false, error: 'wecom long-connect not active' }]
  }
  try {
    await client.sendMessage(explicitChatId, { msgtype: 'markdown', markdown: { content: text } })
    return [{ channelType: 'wecom', accountId, chatId: explicitChatId, ok: true }]
  } catch (err) {
    return [{
      channelType: 'wecom', accountId, chatId: explicitChatId,
      ok: false, error: err instanceof Error ? err.message : String(err),
    }]
  }
}

function listTargets(): CronTargetOption[] {
  const cdb = getChannelDb()
  return listWecomAccounts(cdb).map((a) => ({
    channelType: 'wecom',
    accountId: a.accountId,
    label: a.label || a.accountId,
    workspacePath: a.workspacePath,
    enabled: a.enabled === 1,
    hasActiveChat: true,
  }))
}

export function registerWecomCronDispatcher(): void {
  registerCronDispatcher({ channelType: 'wecom', dispatch, listTargets })
}
