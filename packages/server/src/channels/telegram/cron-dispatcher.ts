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
 */
import { Bot } from 'grammy'
import { getChannelDb } from '../../db/channel-db.js'
import { getAccount as getTelegramAccount, listAccounts as listTelegramAccounts } from './accounts.js'
import { registerCronDispatcher, type CronTargetOption, type DispatchResult } from '../../cron/dispatcher.js'

async function dispatch(accountId: string, text: string, explicitChatId?: string): Promise<DispatchResult[]> {
  const acct = getTelegramAccount(getChannelDb(), accountId)
  if (!acct) throw new Error(`telegram account ${accountId} not found`)
  if (acct.enabled !== 1) throw new Error(`telegram account ${accountId} disabled`)

  if (!explicitChatId) {
    throw new Error('telegram cron target requires an explicit chatId (numeric — Telegram private-chat ids equal user ids). Create the cron from inside a chat to auto-pin, or pass --targets telegram:<accountId>:<chatId>.')
  }
  const chatIdNum = Number(explicitChatId)
  if (!Number.isFinite(chatIdNum)) {
    return [{
      channelType: 'telegram', accountId, chatId: explicitChatId,
      ok: false, error: `invalid chatId (must be numeric — @usernames don't work for sendMessage)`,
    }]
  }
  try {
    await new Bot(acct.botToken).api.sendMessage(chatIdNum, text, { parse_mode: undefined })
    return [{ channelType: 'telegram', accountId, chatId: explicitChatId, ok: true }]
  } catch (err) {
    return [{
      channelType: 'telegram', accountId, chatId: explicitChatId,
      ok: false, error: err instanceof Error ? err.message : String(err),
    }]
  }
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
