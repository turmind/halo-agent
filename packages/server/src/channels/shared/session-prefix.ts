/**
 * Shared session-prefix builder for channels.
 *
 * Halo scopes session ids by channel + user so that `findActiveSessionId`
 * can find a user's session without walking the entire workspace's
 * agent_sessions table. Each channel uses a stable 2-3 letter prefix:
 *
 *   tg_<userId>_<rand>     — Telegram (per chat user)
 *   wx_<openId>_<rand>     — WeChat (per WeChat user; openId is normalized)
 *   web_<accountId>_<rand> — Web channel (per browser/account)
 *   slack_<channel:thread>_<rand> — Slack (per channel+thread, since each
 *                                  thread is its own conversation)
 *   feishu_<chat:thread>_<rand>   — Feishu (same model as Slack)
 *   cli_<rand>             — CLI (single-user, no prefix-id segment)
 *
 * Centralizing the format means a future "platform-wide session id
 * audit" tool only has one place to enumerate.
 */

export type ChannelKind = 'tg' | 'wx' | 'web' | 'slack' | 'feishu'

/** Build the prefix that every session id created for `(channel, user)`
 *  begins with. Append `${Date.now().toString(36)}` (or any random
 *  segment) to get a fresh session id. */
export function sessionPrefix(channel: ChannelKind, userId: string): string {
  return `${channel}_${userId}_`
}
