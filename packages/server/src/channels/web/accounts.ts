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
import type { WebAccount } from './types.js'

const CH = 'web'

function toWeb(a: ChannelAccount): WebAccount {
  const c = a.config as Record<string, string>
  return {
    accountId: a.accountId,
    token: c.token ?? '',
    workspacePath: a.workspacePath,
    label: a.label,
    enabled: a.enabled,
    accessLevel: a.accessLevel,
    language: a.language,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

export function listAccounts(db: ChannelDb): WebAccount[] {
  return sharedList(db, CH).map(toWeb)
}

export function listEnabledAccounts(db: ChannelDb): WebAccount[] {
  return sharedListEnabled(db, CH).map(toWeb)
}

export function getAccount(db: ChannelDb, accountId: string): WebAccount | undefined {
  const a = sharedGet(db, accountId)
  return a && a.channelType === CH ? toWeb(a) : undefined
}

export function getAccountByToken(db: ChannelDb, token: string): WebAccount | undefined {
  const all = sharedList(db, CH)
  const a = all.find((acc) => (acc.config as Record<string, string>).token === token)
  return a ? toWeb(a) : undefined
}

export function insertAccount(db: ChannelDb, data: {
  accountId: string
  token: string
  workspacePath: string
  label?: string
  accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer'
  language?: string
}): void {
  insertChannelAccount(db, CH, data, { token: data.token })
}

export function updateAccount(db: ChannelDb, accountId: string, patch: Record<string, unknown>): void {
  updateChannelAccount(db, accountId, patch, ['token'])
}

export function deleteAccount(db: ChannelDb, accountId: string): void {
  sharedDelete(db, accountId)
}
