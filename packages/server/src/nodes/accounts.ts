/**
 * Linked-machine pairing tokens: `channel_accounts` rows with
 * `channel_type='node'`, `label` = machine name, `config` = `{ token }`.
 * Not a channel (no descriptor, never booted) — the rows only gate the
 * `halo node` handshake and name the machines of a workspace.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import type { ChannelDb } from '../db/channel-db.js'
import {
  listAccounts, getAccount, insertChannelAccount, deleteAccount, validateWorkspaceBody, type ChannelAccount,
} from '../channels/shared/accounts.js'

const CH = 'node'

/** Lowercase so the model spells it back without case ambiguity. */
export const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export interface NodeAccount {
  accountId: string
  name: string
  workspacePath: string
  token: string
  createdAt: number
}

function toNode(a: ChannelAccount): NodeAccount {
  return {
    accountId: a.accountId,
    name: a.label,
    workspacePath: a.workspacePath,
    token: String((a.config as Record<string, unknown>).token ?? ''),
    createdAt: a.createdAt,
  }
}

/** realpath, or the path as given when it no longer exists. */
export function realWorkspace(p: string): string {
  try { return fs.realpathSync(p) } catch { return p }
}

export function listNodeAccounts(db: ChannelDb): NodeAccount[] {
  return listAccounts(db, CH).map(toNode)
}

/** The machines bound to `workspace` (compared by realpath). */
export function listWorkspaceNodes(db: ChannelDb, workspace: string): NodeAccount[] {
  const ws = realWorkspace(workspace)
  return listNodeAccounts(db).filter((a) => realWorkspace(a.workspacePath) === ws)
}

export function getNodeAccount(db: ChannelDb, accountId: string): NodeAccount | undefined {
  const a = getAccount(db, accountId)
  return a && a.channelType === CH ? toNode(a) : undefined
}

export function getNodeAccountByToken(db: ChannelDb, token: string): NodeAccount | undefined {
  if (!token) return undefined
  return listNodeAccounts(db).find((a) => a.token === token)
}

export function deleteNodeAccount(db: ChannelDb, accountId: string): void {
  if (getNodeAccount(db, accountId)) deleteAccount(db, accountId)
}

/** Name must be unique within a workspace (realpath'd both sides). Check +
 *  insert run in one synchronous tick (better-sqlite3), so no race. */
export function insertNodeAccount(
  db: ChannelDb,
  data: { workspacePath?: unknown; name?: unknown },
): { accountId: string; token: string; name: string; workspacePath: string } | { error: string; status: 400 | 409 } {
  const name = typeof data.name === 'string' ? data.name : ''
  const workspacePath = typeof data.workspacePath === 'string' ? data.workspacePath : ''
  if (!workspacePath) return { error: 'workspacePath required', status: 400 }
  if (!NODE_NAME_RE.test(name)) return { error: 'name must be 1-32 chars of a-z 0-9 - (starting with a letter or digit)', status: 400 }
  const wsError = validateWorkspaceBody(workspacePath)
  if (wsError) return { error: wsError, status: 400 }
  if (listWorkspaceNodes(db, workspacePath).some((a) => a.name === name)) {
    return { error: `machine name "${name}" is already used in this workspace`, status: 409 }
  }
  const accountId = crypto.randomUUID().slice(0, 8)
  const token = crypto.randomBytes(24).toString('base64url')
  insertChannelAccount(db, CH, { accountId, workspacePath, label: name, accessLevel: 'full' }, { token })
  return { accountId, token, name, workspacePath }
}
