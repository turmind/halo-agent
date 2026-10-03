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
import type { WecomAccount } from './types.js'

const CH = 'wecom'

function toWecom(a: ChannelAccount): WecomAccount {
  const c = a.config as Record<string, string>
  return {
    accountId: a.accountId,
    botId: c.botId ?? '',
    secret: c.secret ?? '',
    workspacePath: a.workspacePath,
    label: a.label,
    enabled: a.enabled,
    accessLevel: a.accessLevel,
    language: a.language,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

/** WeCom userids / chatids may contain `@` and `.`; session ids must pass
 *  `isSafeIdSegment` (`/^[\w.:>\u4e00-\u9fff-]+$/`) and the `_`-delimited
 *  prefix format, so fold anything outside `[\w-]` to `-`. Same idea as
 *  `wechat/accounts.ts` `normalizeAccountId`. */
export function normalizeWecomId(raw: string): string {
  return raw.replace(/[^\w-]/g, '-')
}

export function listAccounts(db: ChannelDb): WecomAccount[] {
  return sharedList(db, CH).map(toWecom)
}

export function listEnabledAccounts(db: ChannelDb): WecomAccount[] {
  return sharedListEnabled(db, CH).map(toWecom)
}

export function getAccount(db: ChannelDb, accountId: string): WecomAccount | undefined {
  const a = sharedGet(db, accountId)
  return a && a.channelType === CH ? toWecom(a) : undefined
}

export function insertAccount(db: ChannelDb, data: {
  accountId: string
  botId: string
  secret: string
  workspacePath: string
  label?: string
  accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer'
  language?: string
}): void {
  insertChannelAccount(db, CH, data, {
    botId: data.botId,
    secret: data.secret,
  })
}

export function updateAccount(db: ChannelDb, accountId: string, patch: Partial<{
  botId: string
  secret: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: string
  language: string
}>): void {
  updateChannelAccount(db, accountId, patch, ['botId', 'secret'])
}

export function deleteAccount(db: ChannelDb, accountId: string): void {
  sharedDelete(db, accountId)
}
