import type { ChannelDb } from '../../db/channel-db.js'
import {
  listAccounts as sharedList,
  listEnabledAccounts as sharedListEnabled,
  getAccount as sharedGet,
  insertChannelAccount,
  updateChannelAccount,
  patchConfig as sharedPatchConfig,
  deleteAccount as sharedDelete,
  type ChannelAccount,
} from '../shared/accounts.js'

export type AccessLevel = 'full' | 'workspace' | 'readonly' | 'observer'

export interface WechatAccount {
  accountId: string
  botToken: string
  baseUrl: string
  userId: string
  workspacePath: string
  label: string
  enabled: boolean
  accessLevel: AccessLevel
  language: string
  syncBuf: string
  createdAt: number
  updatedAt: number
}

const CH = 'wechat'

function toWechat(a: ChannelAccount): WechatAccount {
  const c = a.config as Record<string, string>
  return {
    accountId: a.accountId,
    botToken: c.botToken ?? '',
    baseUrl: c.baseUrl ?? '',
    userId: c.userId ?? '',
    workspacePath: a.workspacePath,
    label: a.label,
    enabled: a.enabled === 1,
    accessLevel: a.accessLevel,
    language: a.language,
    syncBuf: c.syncBuf ?? '',
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

export function normalizeAccountId(raw: string): string {
  return raw.replace(/[@.]/g, '-')
}

export function listAccounts(db: ChannelDb): WechatAccount[] {
  return sharedList(db, CH).map(toWechat)
}

export function listEnabledAccounts(db: ChannelDb): WechatAccount[] {
  return sharedListEnabled(db, CH).map(toWechat)
}

export function getAccount(db: ChannelDb, accountId: string): WechatAccount | null {
  const a = sharedGet(db, accountId)
  return a && a.channelType === CH ? toWechat(a) : null
}

export function insertAccount(db: ChannelDb, params: {
  accountId: string
  botToken: string
  baseUrl: string
  userId: string
  workspacePath: string
  label: string
  accessLevel?: AccessLevel
  language?: string
}): void {
  insertChannelAccount(db, CH, params, {
    botToken: params.botToken,
    baseUrl: params.baseUrl,
    userId: params.userId,
    syncBuf: '',
  })
}

export function updateAccount(db: ChannelDb, accountId: string, patch: Partial<{
  botToken: string
  baseUrl: string
  userId: string
  workspacePath: string
  label: string
  enabled: boolean
  accessLevel: AccessLevel
  language: string
}>): void {
  // WechatAccount exposes `enabled` as a boolean; the row stores 0/1.
  const enabled = patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0
  updateChannelAccount(db, accountId, { ...patch, enabled }, ['botToken', 'baseUrl', 'userId'])
}

export function deleteAccount(db: ChannelDb, accountId: string): void {
  sharedDelete(db, accountId)
}

export function saveSyncBuf(db: ChannelDb, accountId: string, syncBuf: string): void {
  sharedPatchConfig(db, accountId, { syncBuf })
}
