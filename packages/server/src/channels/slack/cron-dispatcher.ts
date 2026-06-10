/**
 * Slack side of cron dispatch. Posts the cron run's final assistant
 * text to either:
 *   - the explicit `chatId` if the cron was created from inside a
 *     thread (format: `<channelId>:<threadTs>`), or
 *   - the cached `lastActiveChatId` on the account row (the last
 *     inbound thread that addressed the bot).
 *
 * Slack has no "fan out to a whitelist" for cron — channels are
 * arbitrary and adding the bot to one doesn't grant a delivery
 * intent. Cron jobs need either an inbound history or an explicit
 * destination, mirroring the wechat single-recipient model.
 */
import { getChannelDb } from '../../db/channel-db.js'
import { getAccount as getSlackAccount, listAccounts as listSlackAccounts } from './accounts.js'
import { postMessage } from './api.js'
import { registerCronDispatcher, type CronTargetOption, type DispatchResult } from '../../cron/dispatcher.js'

/** Parse a stored chatId of the form `<channelId>:<threadTs>` back into
 *  the two pieces. The threadTs is optional — DM channels (`D…`) and
 *  channel-level pushes (`C…`) carry no thread component. */
function parseChatId(raw: string): { channel: string; threadTs?: string } {
  const idx = raw.indexOf(':')
  if (idx < 0) return { channel: raw }
  return { channel: raw.slice(0, idx), threadTs: raw.slice(idx + 1) || undefined }
}

/**
 * Slack cron dispatcher. Requires an explicit `chatId` — there is no
 * "fall back to whoever last messaged the bot" behaviour, because in a
 * Slack workspace the most-recent inbound is almost always someone
 * unrelated to whoever set up the cron, and pushing the result there
 * leaks confusing context into a stranger's thread.
 *
 * The `chatId` shape is one of:
 *   - `D0123456`              — DM channel id (push lands in that DM, flat)
 *   - `C0123456`              — public channel id (push lands top-level)
 *   - `C0123456:1700000000.0` — `<channel>:<thread_ts>`, push lands in the thread
 *
 * Cron jobs created from inside Slack via the `cron` skill
 * inject the current chat as `chatId`, so the natural workflow ("set
 * me a daily reminder") just works. Admin-UI cron jobs that don't
 * specify a target run silently — the result shows in the cron log,
 * nothing pushed.
 */
async function dispatch(accountId: string, text: string, explicitChatId?: string): Promise<DispatchResult[]> {
  const acct = getSlackAccount(getChannelDb(), accountId)
  if (!acct) throw new Error(`slack account ${accountId} not found`)
  if (acct.enabled !== 1) throw new Error(`slack account ${accountId} disabled`)

  if (!explicitChatId) {
    throw new Error('slack cron target requires an explicit chatId (e.g. "D01234567" for a DM, or "C0123:1700.0" for a thread). Create the cron from inside a Slack chat to auto-pin, or pass --targets slack:<accountId>:<chatId>.')
  }
  const { channel, threadTs } = parseChatId(explicitChatId)
  try {
    await postMessage({ botToken: acct.botToken, channel, threadTs, text })
    return [{ channelType: 'slack', accountId, chatId: explicitChatId, ok: true }]
  } catch (err) {
    return [{
      channelType: 'slack', accountId, chatId: explicitChatId,
      ok: false, error: err instanceof Error ? err.message : String(err),
    }]
  }
}

/** Slack accounts are always "ready" for the picker — readiness depends
 *  on the chatId the user picks, not on prior inbound history. */
function listTargets(): CronTargetOption[] {
  const cdb = getChannelDb()
  return listSlackAccounts(cdb).map((a) => ({
    channelType: 'slack',
    accountId: a.accountId,
    label: a.label || a.accountId,
    workspacePath: a.workspacePath,
    enabled: a.enabled === 1,
    hasActiveChat: true,
  }))
}

export function registerSlackCronDispatcher(): void {
  registerCronDispatcher({ channelType: 'slack', dispatch, listTargets })
}
