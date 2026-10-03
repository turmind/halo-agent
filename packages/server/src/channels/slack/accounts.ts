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
import type { SlackAccount } from './types.js'

const CH = 'slack'

function toSlack(a: ChannelAccount): SlackAccount {
  const c = a.config as Record<string, string>
  return {
    accountId: a.accountId,
    botToken: c.botToken ?? '',
    appToken: c.appToken ?? '',
    botUserId: c.botUserId ?? '',
    teamId: c.teamId ?? '',
    workspacePath: a.workspacePath,
    label: a.label,
    enabled: a.enabled,
    accessLevel: a.accessLevel,
    language: a.language,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

export function listAccounts(db: ChannelDb): SlackAccount[] {
  return sharedList(db, CH).map(toSlack)
}

export function listEnabledAccounts(db: ChannelDb): SlackAccount[] {
  return sharedListEnabled(db, CH).map(toSlack)
}

export function getAccount(db: ChannelDb, accountId: string): SlackAccount | undefined {
  const a = sharedGet(db, accountId)
  return a && a.channelType === CH ? toSlack(a) : undefined
}

/** Find the account that received an inbound webhook by matching the
 *  envelope's `team_id`. Slack delivers events to whichever app/bot has
 *  been installed in the team; the bot's `accountId` is keyed by team. */
export function findAccountByTeam(db: ChannelDb, teamId: string): SlackAccount | undefined {
  for (const a of listEnabledAccounts(db)) {
    if (a.teamId === teamId) return a
  }
  return undefined
}

export function insertAccount(db: ChannelDb, data: {
  accountId: string
  botToken: string
  appToken: string
  botUserId: string
  teamId: string
  workspacePath: string
  label?: string
  accessLevel?: 'full' | 'workspace' | 'readonly' | 'observer'
  language?: string
}): void {
  insertChannelAccount(db, CH, data, {
    botToken: data.botToken,
    appToken: data.appToken,
    botUserId: data.botUserId,
    teamId: data.teamId,
  })
}

export function updateAccount(db: ChannelDb, accountId: string, patch: Partial<{
  botToken: string
  appToken: string
  botUserId: string
  teamId: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: string
  language: string
}>): void {
  updateChannelAccount(db, accountId, patch, ['botToken', 'appToken', 'botUserId', 'teamId'])
}

export function deleteAccount(db: ChannelDb, accountId: string): void {
  sharedDelete(db, accountId)
}
