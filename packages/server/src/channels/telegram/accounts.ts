import type { ChannelDb } from '../../db/channel-db.js'
import {
  listAccounts as sharedList,
  listEnabledAccounts as sharedListEnabled,
  getAccount as sharedGet,
  insertChannelAccount,
  updateChannelAccount,
  deleteAccount as sharedDelete,
  type ChannelAccount,
} from '../shared/accounts.js'
import type { TelegramAccount } from './types.js'

const CH = 'telegram'

function toTelegram(a: ChannelAccount): TelegramAccount {
  const c = a.config as Record<string, string>
  return {
    accountId: a.accountId,
    botToken: c.botToken ?? '',
    botUsername: c.botUsername ?? '',
    workspacePath: a.workspacePath,
    label: a.label,
    enabled: a.enabled,
    accessLevel: a.accessLevel,
    allowedUsers: c.allowedUsers ?? '',
    language: a.language,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

export function listAccounts(db: ChannelDb): TelegramAccount[] {
  return sharedList(db, CH).map(toTelegram)
}

export function listEnabledAccounts(db: ChannelDb): TelegramAccount[] {
  return sharedListEnabled(db, CH).map(toTelegram)
}

export function getAccount(db: ChannelDb, accountId: string): TelegramAccount | undefined {
  const a = sharedGet(db, accountId)
  return a && a.channelType === CH ? toTelegram(a) : undefined
}

export function insertAccount(db: ChannelDb, data: {
  accountId: string
  botToken: string
  botUsername: string
  workspacePath: string
  label?: string
  accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer'
  allowedUsers?: string
  language?: string
}): void {
  insertChannelAccount(db, CH, data, {
    botToken: data.botToken,
    botUsername: data.botUsername,
    allowedUsers: data.allowedUsers ?? '',
  })
}

export function updateAccount(db: ChannelDb, accountId: string, patch: Partial<{
  botToken: string
  botUsername: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: string
  allowedUsers: string
  language: string
}>): void {
  updateChannelAccount(db, accountId, patch, ['botToken', 'botUsername', 'allowedUsers'])
}

export function deleteAccount(db: ChannelDb, accountId: string): void {
  sharedDelete(db, accountId)
}
