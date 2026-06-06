import type { ChannelDb } from '../../db/channel-db.js'
import {
  listAccounts as sharedList,
  listEnabledAccounts as sharedListEnabled,
  getAccount as sharedGet,
  insertAccount as sharedInsert,
  updateAccount as sharedUpdate,
  patchConfig as sharedPatchConfig,
  deleteAccount as sharedDelete,
  type ChannelAccount,
} from '../shared/accounts.js'

export type AccessLevel = 'full' | 'workspace' | 'readonly'

export interface WeixinAccount {
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

function toWeixin(a: ChannelAccount): WeixinAccount {
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

export function listAccounts(db: ChannelDb): WeixinAccount[] {
  return sharedList(db, CH).map(toWeixin)
}

export function listEnabledAccounts(db: ChannelDb): WeixinAccount[] {
  return sharedListEnabled(db, CH).map(toWeixin)
}

export function getAccount(db: ChannelDb, accountId: string): WeixinAccount | null {
  const a = sharedGet(db, accountId)
  return a && a.channelType === CH ? toWeixin(a) : null
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
  sharedInsert(db, {
    accountId: params.accountId,
    channelType: CH,
    workspacePath: params.workspacePath,
    label: params.label,
    accessLevel: params.accessLevel,
    language: params.language,
    config: {
      botToken: params.botToken,
      baseUrl: params.baseUrl,
      userId: params.userId,
      syncBuf: '',
    },
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
  const basePatch: Record<string, unknown> = {}
  if (patch.workspacePath !== undefined) basePatch.workspacePath = patch.workspacePath
  if (patch.label !== undefined) basePatch.label = patch.label
  if (patch.enabled !== undefined) basePatch.enabled = patch.enabled ? 1 : 0
  if (patch.accessLevel !== undefined) basePatch.accessLevel = patch.accessLevel
  if (patch.language !== undefined) basePatch.language = patch.language

  const configKeys = ['botToken', 'baseUrl', 'userId'] as const
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

export function saveSyncBuf(db: ChannelDb, accountId: string, syncBuf: string): void {
  sharedPatchConfig(db, accountId, { syncBuf })
}
