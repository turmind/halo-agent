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
      botToken: data.botToken,
      appToken: data.appToken,
      botUserId: data.botUserId,
      teamId: data.teamId,
    },
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
  const basePatch: Record<string, unknown> = {}
  if (patch.workspacePath !== undefined) basePatch.workspacePath = patch.workspacePath
  if (patch.label !== undefined) basePatch.label = patch.label
  if (patch.enabled !== undefined) basePatch.enabled = patch.enabled
  if (patch.accessLevel !== undefined) basePatch.accessLevel = patch.accessLevel
  if (patch.language !== undefined) basePatch.language = patch.language

  const configKeys = ['botToken', 'appToken', 'botUserId', 'teamId'] as const
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
