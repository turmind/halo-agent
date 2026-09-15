import fs from 'node:fs'
import path from 'node:path'
import { eq, and } from 'drizzle-orm'
import { channelAccounts, type ChannelDb } from '../../db/channel-db.js'
import { ensureWorkspaceHalo } from '../../init.js'

/**
 * Verify the account's workspace path still exists and ensure its `.halo/`
 * scaffolding is in place. Returns the path on success, `null` if the
 * workspace directory has been deleted/moved (channel handler should then
 * abort the message rather than racing into a broken `SessionManager`).
 *
 * Same shape across all channel handlers — kept here so each adapter doesn't
 * reinvent it.
 */
export function resolveAccountWorkspace(account: { workspacePath: string }): string | null {
  if (!fs.existsSync(account.workspacePath)) return null
  ensureWorkspaceHalo(account.workspacePath)
  return account.workspacePath
}

/** Account-level access. `observer` is read-only like `readonly` but
 *  globally-scoped: it can see every workspace (halo-city / metrics / show)
 *  without write or execute rights. Visibility-layer only — it never reaches
 *  the sandbox, which only knows full/workspace/readonly (observer is
 *  normalized to readonly the moment a session is built from it). */
export type AccountAccessLevel = 'full' | 'workspace' | 'readonly' | 'observer'

/** Every legal stored value — the set `toAccount` normalizes against and the
 *  set the web channel accepts (that's where halo-city / metrics tokens are
 *  minted). */
export const ACCOUNT_ACCESS_LEVELS: readonly string[] = ['full', 'workspace', 'readonly', 'observer']

/** Legal values on the four chat channels. `observer` is a dashboard role,
 *  not a chat identity: their admin forms offer three, and chat-side session
 *  routing treats observer as readonly anyway. */
export const CHAT_ACCESS_LEVELS: readonly string[] = ['full', 'workspace', 'readonly']

/**
 * REST-boundary check for an inbound `accessLevel` field. Returns an error
 * message when the field is present but outside `allowed`, else `null`
 * (absent = "leave it alone", which each caller's patch build already
 * handles).
 *
 * Without this only wechat's PATCH rejected junk; the other four channels
 * wrote any string straight into the row and relied on `toAccount` quietly
 * normalizing it back to `readonly` on every read (audit B-L1) — so the db
 * held a value no code path agreed with.
 */
export function accessLevelError(value: unknown, allowed: readonly string[]): string | null {
  if (value === undefined) return null
  if (typeof value === 'string' && allowed.includes(value)) return null
  return `accessLevel must be one of: ${allowed.join(', ')}`
}

/**
 * REST-boundary check for a `workspacePath` a channel is about to bind an
 * account to: absolute, exists, and (on success) `.halo/` scaffolded — the
 * side effect that always followed the check. Returns an error message for
 * the caller to render in its own response shape, or `null` when usable.
 *
 * Presence stays with the caller: POST words it alongside its other
 * required-field errors, PATCH treats absence as "leave the binding alone".
 * Before this, all ten call sites (POST + PATCH × 5 channels) carried their
 * own copy and drifted — four PATCHes never checked `isAbsolute`, so a
 * relative path got stored verbatim and later resolved against whatever CWD
 * the server happened to run in (audit B hotspot #2).
 */
export function validateWorkspaceBody(workspacePath: string): string | null {
  if (!path.isAbsolute(workspacePath)) return 'workspacePath must be absolute'
  if (!fs.existsSync(workspacePath)) return 'workspace path not found'
  ensureWorkspaceHalo(workspacePath)
  return null
}

export interface ChannelAccount {
  accountId: string
  channelType: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: AccountAccessLevel
  language: string
  config: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

function toAccount(row: typeof channelAccounts.$inferSelect): ChannelAccount {
  let config: Record<string, unknown> = {}
  try { config = JSON.parse(row.config) } catch { /* ignore */ }
  return {
    accountId: row.accountId,
    channelType: row.channelType,
    workspacePath: row.workspacePath,
    label: row.label,
    enabled: row.enabled,
    accessLevel: (['full', 'workspace', 'readonly', 'observer'].includes(row.accessLevel) ? row.accessLevel : 'readonly') as AccountAccessLevel,
    language: row.language,
    config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listAccounts(db: ChannelDb, channelType: string): ChannelAccount[] {
  return db.select().from(channelAccounts)
    .where(eq(channelAccounts.channelType, channelType))
    .all().map(toAccount)
}

export function listEnabledAccounts(db: ChannelDb, channelType: string): ChannelAccount[] {
  return db.select().from(channelAccounts)
    .where(and(eq(channelAccounts.channelType, channelType), eq(channelAccounts.enabled, 1)))
    .all().map(toAccount)
}

export function getAccount(db: ChannelDb, accountId: string): ChannelAccount | undefined {
  const row = db.select().from(channelAccounts)
    .where(eq(channelAccounts.accountId, accountId))
    .get()
  return row ? toAccount(row) : undefined
}

export function insertAccount(db: ChannelDb, data: {
  accountId: string
  channelType: string
  workspacePath: string
  label?: string
  enabled?: number
  accessLevel?: AccountAccessLevel
  language?: string
  config?: Record<string, unknown>
}): void {
  const now = Date.now()
  db.insert(channelAccounts).values({
    accountId: data.accountId,
    channelType: data.channelType,
    workspacePath: data.workspacePath,
    label: data.label ?? '',
    enabled: data.enabled ?? 1,
    accessLevel: data.accessLevel ?? 'readonly',
    language: data.language ?? 'en',
    config: JSON.stringify(data.config ?? {}),
    createdAt: now,
    updatedAt: now,
  }).run()
}

export function updateAccount(db: ChannelDb, accountId: string, patch: Partial<{
  workspacePath: string
  label: string
  enabled: number
  accessLevel: string
  language: string
  config: Record<string, unknown>
}>): void {
  const update: Record<string, unknown> = { updatedAt: Date.now() }
  if (patch.workspacePath !== undefined) update.workspacePath = patch.workspacePath
  if (patch.label !== undefined) update.label = patch.label
  if (patch.enabled !== undefined) update.enabled = patch.enabled
  if (patch.accessLevel !== undefined) update.accessLevel = patch.accessLevel
  if (patch.language !== undefined) update.language = patch.language
  if (patch.config !== undefined) update.config = JSON.stringify(patch.config)
  db.update(channelAccounts).set(update)
    .where(eq(channelAccounts.accountId, accountId))
    .run()
}

/**
 * Cache the last chat id (telegram) / openId (wechat) the account has
 * exchanged messages with. Cron jobs targeting this account use this as
 * the delivery destination — no manual chat-id config required.
 *
 * Hot path: every inbound message triggers this. We keep a per-process
 * in-memory map of `accountId → lastSeenChatId` so unchanged values
 * never touch the db. Only on first sight, or when the chat id actually
 * changes (user logs in from a different Telegram account, etc.), do we
 * read-modify-write the row. Restart-safe: the map is rebuilt as
 * messages flow back in; in the meantime the db's existing
 * `lastActiveChatId` keeps working for cron lookups.
 */
const _lastActiveChatCache = new Map<string, string>()

export function rememberLastActiveChat(db: ChannelDb, accountId: string, chatId: string): void {
  if (_lastActiveChatCache.get(accountId) === chatId) return
  // First sight (or value change) for this process: write through to db
  // and remember. Read-modify-write here covers the cold-start case
  // where the db already has the same value (we still skip the write).
  const existing = getAccount(db, accountId)
  if (!existing) return
  if (existing.config.lastActiveChatId !== chatId) {
    patchConfig(db, accountId, { lastActiveChatId: chatId })
  }
  _lastActiveChatCache.set(accountId, chatId)
}

/**
 * Persist the wechat ilink `context_token` per `(accountId, userId)` into
 * `config.contextTokens`. ilink requires every outbound sendmessage to echo
 * the recipient's most recent inbound token verbatim; the chat reply path
 * carries it in-memory (bridge route), but cron dispatch runs long after the
 * inbound and had nothing to send → intermittent `ret=-2 prepare failed`.
 * Same hot-path shape as `rememberLastActiveChat`: in-process dedupe, db
 * write only when the value changes.
 */
const _wechatContextTokenCache = new Map<string, string>()

export function rememberWechatContextToken(db: ChannelDb, accountId: string, userId: string, token: string): void {
  const key = `${accountId}:${userId}`
  if (_wechatContextTokenCache.get(key) === token) return
  const existing = getAccount(db, accountId)
  if (!existing) return
  const tokens = (existing.config.contextTokens ?? {}) as Record<string, string>
  if (tokens[userId] !== token) {
    patchConfig(db, accountId, { contextTokens: { ...tokens, [userId]: token } })
  }
  _wechatContextTokenCache.set(key, token)
}

export function patchConfig(db: ChannelDb, accountId: string, configPatch: Record<string, unknown>): void {
  const existing = getAccount(db, accountId)
  if (!existing) return
  const merged = { ...existing.config, ...configPatch }
  updateAccount(db, accountId, { config: merged })
}

export function deleteAccount(db: ChannelDb, accountId: string): void {
  db.delete(channelAccounts).where(eq(channelAccounts.accountId, accountId)).run()
}
