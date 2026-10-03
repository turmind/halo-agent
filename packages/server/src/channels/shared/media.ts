/**
 * Shared media-type detection across channels.
 *
 * Each channel has its own taxonomy of "kind" (Telegram has photo /
 * video / voice / document; WeChat has image / video / file), but the
 * underlying file-extension classification is the same. This module
 * owns the classification; each channel maps the result into its own
 * naming.
 */
import path from 'node:path'
import os from 'node:os'
import { IMAGE_EXTS } from '@turmind/halo-core'
import type { AccountAccessLevel } from './accounts.js'
import { t, getLang } from './i18n.js'

/** OS temp dir, resolved (e.g. /tmp on unix, C:\Users\…\Temp on Windows).
 *  Channels treat files here as a valid media source alongside the
 *  workspace, and agents are told to drop generated artifacts here. */
export function tempDir(): string {
  return path.resolve(os.tmpdir())
}

/** True if `filePath` lives inside the OS temp dir. Pre-resolve callers'
 *  paths so this compares normalized absolute paths on every platform —
 *  the old hardcoded `startsWith('/tmp/')` was always false on Windows. */
export function isInTempDir(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  const tmp = tempDir()
  return resolved === tmp || resolved.startsWith(tmp + path.sep)
}

/**
 * Agent-emitted `MEDIA:<absolute_path>` lines are extracted from outbound
 * text before it is sent, and each path dispatched through the channel's
 * own file-send path. The marker MUST be on its own line; trailing text on
 * the same line is preserved by only matching up to EOL.
 */
const MEDIA_MARKER_RE = /^MEDIA:\s*(\S.*?)\s*$/gm

/** Strip `MEDIA:` lines out of `text`, returning the remaining text
 *  verbatim — whitespace preserved, because streaming callers concatenate
 *  successive chunks — plus the extracted paths in marker order. */
export function extractMediaPaths(text: string): { text: string; mediaPaths: string[] } {
  const mediaPaths: string[] = []
  const stripped = text.replace(MEDIA_MARKER_RE, (_m, p: string) => {
    if (p) mediaPaths.push(p)
    return ''
  })
  return { text: stripped, mediaPaths }
}

/** `extractMediaPaths` for block-oriented senders (one send per message):
 *  the blank holes left by removed marker lines are collapsed and the
 *  result trimmed, so a marker-only chunk comes back as ''. */
export function extractMediaMessage(text: string): { text: string; mediaPaths: string[] } {
  const { text: stripped, mediaPaths } = extractMediaPaths(text)
  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), mediaPaths }
}

/** Sandbox for outbound `MEDIA:` paths. A `full` account may send any
 *  readable path — its shell / file tools are already unrestricted, so the
 *  whitelist would only force a copy to /tmp. Every other access level (and
 *  callers without one, e.g. cron) is limited to files under `workspacePath`
 *  or in the OS temp dir (agent-generated artifacts like screenshots).
 *  Segment-boundary match, not a raw prefix — a sibling dir like
 *  `<workspace>-other` must not pass as "inside the workspace". */
export function isMediaPathAllowed(filePath: string, workspacePath: string, accessLevel?: AccountAccessLevel): boolean {
  if (accessLevel === 'full') return true
  const resolved = path.resolve(filePath)
  const ws = path.resolve(workspacePath)
  return resolved === ws || resolved.startsWith(ws + path.sep) || isInTempDir(resolved)
}

/** Throw when `filePath` fails `isMediaPathAllowed` for this account. Thrown
 *  (not returned) so the caller's send-failure path reports the block to the
 *  user like any other failed upload. */
export function assertMediaPathAllowed(filePath: string, account: { workspacePath: string; accessLevel: AccountAccessLevel }): void {
  if (!isMediaPathAllowed(filePath, account.workspacePath, account.accessLevel)) {
    throw new Error(`media path not allowed: ${filePath} (must be under the workspace or the temp dir; account access level ${account.accessLevel})`)
  }
}

/**
 * Outbound `MEDIA:` send for a chat reply: sandbox check, then `send()`; a
 * block or a failed upload is logged and reported to the chat as
 * `handler.upload_failed` through `reply` (whose own failure is ignored), so
 * the user doesn't sit wondering why no attachment showed up.
 */
export async function sendMediaOrReport(opts: {
  filePath: string
  account: { workspacePath: string; accessLevel: AccountAccessLevel; language?: string | null }
  logTag: string
  send: () => Promise<void>
  reply: (text: string) => Promise<unknown>
}): Promise<void> {
  const { filePath, account } = opts
  try {
    assertMediaPathAllowed(filePath, account)
    await opts.send()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.log(`[${opts.logTag}] sendMedia ${filePath} failed: ${error}`)
    await opts.reply(t('handler.upload_failed', getLang(account), { name: path.basename(filePath), error }))
      .catch(() => { /* ignore */ })
  }
}

export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi'])
export const VOICE_EXTS = new Set(['.ogg', '.oga', '.opus'])

/** Coarse media class used as the input to channel-specific routing. */
export type MediaClass = 'image' | 'video' | 'voice' | 'other'

export function classifyMedia(filePath: string): MediaClass {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (VOICE_EXTS.has(ext)) return 'voice'
  return 'other'
}
