/**
 * Account-CRUD pieces shared by the channel admin routes (web / telegram /
 * slack / feishu / wecom; wechat uses only `accountBodyError`). Credentials,
 * required-field checks, id derivation and restart policy stay in each
 * channel's route file.
 */
import fs from 'node:fs'
import { accessLevelError, validateWorkspaceBody, type AccountAccessLevel } from '../channels/shared/accounts.js'

/** Row fields every `PATCH /<channel>/accounts/:id` accepts. */
export type AccountPatchBody = Partial<{
  label: string
  workspacePath: string
  enabled: boolean
  accessLevel: AccountAccessLevel
  language: string
}>

/** Fields every `GET /<channel>/accounts` entry carries. No credentials —
 *  each route adds its own public fields next to these. */
export function accountListFields(a: {
  accountId: string
  workspacePath: string
  label: string
  enabled: number
  accessLevel: AccountAccessLevel
  language: string
  createdAt: number
  updatedAt: number
}) {
  return {
    accountId: a.accountId,
    workspacePath: a.workspacePath,
    workspaceMissing: !fs.existsSync(a.workspacePath),
    label: a.label,
    enabled: a.enabled,
    accessLevel: a.accessLevel,
    language: a.language,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

/** REST-boundary checks shared by POST and PATCH, in this order: an
 *  `accessLevel` outside `allowed`, then a present `workspacePath` that fails
 *  `validateWorkspaceBody` (which scaffolds `.halo/` on success). Presence of
 *  required fields stays with the caller. */
export function accountBodyError(body: { accessLevel?: unknown; workspacePath?: string }, allowed: readonly string[]): string | null {
  const levelError = accessLevelError(body.accessLevel, allowed)
  if (levelError) return levelError
  if (body.workspacePath !== undefined) return validateWorkspaceBody(body.workspacePath)
  return null
}

/** Row-field part of a PATCH (`enabled` boolean → 0/1). Run
 *  `accountBodyError` first; channel-specific fields are added by the caller. */
export function accountPatchFromBody(body: AccountPatchBody): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (body.label !== undefined) patch.label = body.label
  if (body.accessLevel !== undefined) patch.accessLevel = body.accessLevel
  if (body.language !== undefined) patch.language = body.language
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0
  if (body.workspacePath !== undefined) patch.workspacePath = body.workspacePath
  return patch
}
