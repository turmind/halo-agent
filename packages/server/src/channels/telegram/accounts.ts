import type { ChannelDb } from '../../db/channel-db.js'
import {
  listAccounts as sharedList,
  listEnabledAccounts as sharedListEnabled,
  getAccount as sharedGet,
  insertAccount as sharedInsert,
  updateAccount as sharedUpdate,
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
  accessLevel?: 'full' | 'workspace' | 'readonly'
  allowedUsers?: string
  language?: string
}): void {
  sharedInsert(db, {
    accountId: data.accountId,
    channelType: CH,
    workspacePath: data.workspacePath,
    label: data.label,
    accessLevel: data.accessLevel,
    language: data.language,
    config: {
      botToken: data.botToken,
      botUsername: data.botUsername,
      allowedUsers: data.allowedUsers ?? '',
    },
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
  const basePatch: Record<string, unknown> = {}
  if (patch.workspacePath !== undefined) basePatch.workspacePath = patch.workspacePath
  if (patch.label !== undefined) basePatch.label = patch.label
  if (patch.enabled !== undefined) basePatch.enabled = patch.enabled
  if (patch.accessLevel !== undefined) basePatch.accessLevel = patch.accessLevel
  if (patch.language !== undefined) basePatch.language = patch.language

  const configKeys = ['botToken', 'botUsername', 'allowedUsers'] as const
  const hasConfigChange = configKeys.some((k) => patch[k] !== undefined)
  if (hasConfigChange) {
    const existing = sharedGet(db, accountId)
    if (!existing) return
    const cfg = { ...existing.config }
    for (const k of configKeys) {
      if (patch[k] !== undefined) cfg[k] = patch[k]
    }
    basePatch.config = cfg
  }

  sharedUpdate(db, accountId, basePatch as Parameters<typeof sharedUpdate>[2])
}

export function deleteAccount(db: ChannelDb, accountId: string): void {
  sharedDelete(db, accountId)
}
