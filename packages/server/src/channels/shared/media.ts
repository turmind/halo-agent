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
