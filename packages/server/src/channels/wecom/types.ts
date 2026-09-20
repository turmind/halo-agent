/**
 * WeCom (企业微信) 智能机器人 channel — account type.
 *
 * Auth model:
 *   - `botId` + `secret` are the long-lived credentials issued in the
 *     WeCom admin console for a 智能机器人. Both go into the
 *     `aibot_subscribe` frame the SDK sends right after the wss
 *     connection opens; there is no short-lived token to refresh.
 *
 * Inbound / outbound envelopes are NOT declared here — the official
 * `@wecom/aibot-node-sdk` ships them (`WsFrame`, `BaseMessage`, …) and
 * the handler imports those directly.
 */
export interface WecomAccount {
  accountId: string
  botId: string
  secret: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: 'full' | 'workspace' | 'readonly' | 'observer'
  language: string
  createdAt: number
  updatedAt: number
}
