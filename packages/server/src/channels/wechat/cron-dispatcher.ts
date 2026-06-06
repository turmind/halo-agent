/**
 * WeChat side of cron dispatch. Sends the final assistant text from a
 * cron run to the QR-bind owner (or to the explicit `chatId` if the cron
 * was created from inside a chat). WeChat is single-recipient for cron —
 * unlike telegram, there's no whitelist to fan out to.
 */
import { getChannelDb } from '../../db/channel-db.js'
import { getAccount as getSharedAccount } from '../shared/accounts.js'
import { getAccount as getWechatAccount, listAccounts as listWechatAccounts } from './accounts.js'
import { sendToUser as sendWechatMessage } from './handler.js'
import { registerCronDispatcher, type CronTargetOption, type DispatchResult } from '../../cron/dispatcher.js'

function readLastActiveChatId(accountId: string): string | null {
  const acct = getSharedAccount(getChannelDb(), accountId)
  if (!acct) return null
  const v = acct.config?.lastActiveChatId
  return typeof v === 'string' && v.length > 0 ? v : null
}

async function dispatch(accountId: string, text: string, explicitChatId?: string): Promise<DispatchResult[]> {
  const acct = getWechatAccount(getChannelDb(), accountId)
  if (!acct) throw new Error(`wechat account ${accountId} not found`)
  if (!acct.enabled) throw new Error(`wechat account ${accountId} disabled`)
  // Pick a target openId in priority order:
  //   1. Explicit `chatId` (cron created from inside a chat — keep
  //      replying there).
  //   2. The account's own `userId` — this is the ilink_user_id of the
  //      person who scanned the QR to bind this bot. The "report to me on
  //      a schedule" intent.
  //   3. Cached `lastActiveChatId` — useful when the bot is shared and
  //      you want to reply to whoever was talking last.
  const chatId = explicitChatId || acct.userId || readLastActiveChatId(accountId)
  if (!chatId) {
    throw new Error('no wechat target — bind the account first (the QR-login owner becomes the default cron recipient)')
  }
  await sendWechatMessage({ account: acct, toUserId: chatId, text })
  return [{ channelType: 'wechat', accountId, chatId, ok: true }]
}

function listTargets(): CronTargetOption[] {
  const cdb = getChannelDb()
  const out: CronTargetOption[] = []
  for (const a of listWechatAccounts(cdb)) {
    const raw = getSharedAccount(cdb, a.accountId)
    // The account's own userId (set during QR login = bot owner) is a
    // valid cron target with no inbound message required. Cached chat id
    // covers shared-bot use cases.
    const hasOwner = !!a.userId && a.userId.length > 0
    const hasCached = !!raw && typeof raw.config?.lastActiveChatId === 'string' && raw.config.lastActiveChatId.length > 0
    out.push({
      channelType: 'wechat',
      accountId: a.accountId,
      label: a.label || a.accountId,
      workspacePath: a.workspacePath,
      enabled: a.enabled,
      hasActiveChat: hasOwner || hasCached,
    })
  }
  return out
}

export function registerWechatCronDispatcher(): void {
  registerCronDispatcher({ channelType: 'wechat', dispatch, listTargets })
}
