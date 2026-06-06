/**
 * Feishu (Lark) channel — payload + account types.
 *
 * Auth model:
 *   - `appId` + `appSecret` are the long-lived credentials issued in
 *     the Feishu open platform. Used to mint the short-lived
 *     `tenant_access_token` that every API call needs.
 *   - `verificationToken` (legacy) is a shared secret used to verify
 *     webhook posts. Newer apps may use only signature verification —
 *     we support both: if encrypt_key is present we decrypt, then we
 *     check the verification token if present.
 *   - `encryptKey` (optional) — when enabled in the app settings,
 *     Feishu encrypts the webhook body with AES-256-CBC and we have to
 *     decrypt before reading.
 *   - `botOpenId` is the bot's own open id, used to detect mentions.
 *
 * tenant_access_token is NOT stored — we cache it in memory and
 * refresh on demand (it expires in ~2 hours and refresh is one HTTP
 * call). See `api.ts:getTenantAccessToken`.
 */
export interface FeishuAccount {
  accountId: string
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey: string  // empty string when encryption is disabled
  botOpenId: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: 'full' | 'workspace' | 'readonly'
  language: string
  createdAt: number
  updatedAt: number
}

/** Feishu's webhook envelope (event v2 format). */
export interface FeishuEventEnvelope {
  schema?: '2.0'
  // Legacy v1 fields (challenge format only):
  type?: string
  challenge?: string
  token?: string
  // v2 fields:
  header?: {
    event_id: string
    event_type: string
    create_time: string
    token: string
    app_id: string
    tenant_key?: string
  }
  event?: FeishuMessageEvent | { event_type?: string }
}

export interface FeishuMessageEvent {
  sender: {
    sender_id: { open_id?: string; user_id?: string; union_id?: string }
    sender_type: 'user' | 'bot' | 'app' | string
    tenant_key?: string
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    create_time: string
    chat_id: string
    chat_type: 'p2p' | 'group' | string
    message_type: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | string
    content: string  // JSON string — shape depends on message_type
    mentions?: Array<{
      key: string
      id: { open_id?: string; user_id?: string; union_id?: string }
      name: string
      tenant_key?: string
    }>
  }
}

/** Parsed text content. Feishu wraps text payloads as
 *  `{"text":"hi"}` (JSON-encoded inside `content`). */
export interface FeishuTextContent { text: string }
