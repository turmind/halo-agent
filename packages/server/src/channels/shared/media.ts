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

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
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
