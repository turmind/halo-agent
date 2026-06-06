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
import type { FeishuAccount } from './types.js'

const CH = 'feishu'

function toFeishu(a: ChannelAccount): FeishuAccount {
  const c = a.config as Record<string, string>
  return {
    accountId: a.accountId,
    appId: c.appId ?? '',
    appSecret: c.appSecret ?? '',
    verificationToken: c.verificationToken ?? '',
    encryptKey: c.encryptKey ?? '',
    botOpenId: c.botOpenId ?? '',
    workspacePath: a.workspacePath,
    label: a.label,
    enabled: a.enabled,
    accessLevel: a.accessLevel,
    language: a.language,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

export function listAccounts(db: ChannelDb): FeishuAccount[] {
  return sharedList(db, CH).map(toFeishu)
}

export function listEnabledAccounts(db: ChannelDb): FeishuAccount[] {
  return sharedListEnabled(db, CH).map(toFeishu)
}

export function getAccount(db: ChannelDb, accountId: string): FeishuAccount | undefined {
  const a = sharedGet(db, accountId)
  return a && a.channelType === CH ? toFeishu(a) : undefined
}

/** Locate the account a webhook envelope belongs to. Feishu's v2
 *  envelope carries `header.app_id`; we match on that since one app =
 *  one bot in halo's account model. */
export function findAccountByAppId(db: ChannelDb, appId: string): FeishuAccount | undefined {
  for (const a of listEnabledAccounts(db)) {
    if (a.appId === appId) return a
  }
  return undefined
}

export function insertAccount(db: ChannelDb, data: {
  accountId: string
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey?: string
  botOpenId: string
  workspacePath: string
  label?: string
  accessLevel?: 'full' | 'workspace' | 'readonly'
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
      appId: data.appId,
      appSecret: data.appSecret,
      verificationToken: data.verificationToken,
      encryptKey: data.encryptKey ?? '',
      botOpenId: data.botOpenId,
    },
  })
}

export function updateAccount(db: ChannelDb, accountId: string, patch: Partial<{
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey: string
  botOpenId: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: string
  language: string
}>): void {
  const basePatch: Record<string, unknown> = {}
  if (patch.workspacePath !== undefined) basePatch.workspacePath = patch.workspacePath
  if (patch.label !== undefined) basePatch.label = patch.label
  if (patch.enabled !== undefined) basePatch.enabled = patch.enabled
  if (patch.accessLevel !== undefined) basePatch.accessLevel = patch.accessLevel
  if (patch.language !== undefined) basePatch.language = patch.language

  const configKeys = ['appId', 'appSecret', 'verificationToken', 'encryptKey', 'botOpenId'] as const
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
