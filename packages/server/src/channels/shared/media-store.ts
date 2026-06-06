/**
 * Persist inbound media files into the bound workspace.
 *
 * WeChat: <workspace>/.halo/assets/weixin/inbound/<accountId>/<yyyy-mm-dd>/
 * Web:    <workspace>/.halo/assets/web/inbound/<yyyy-mm-dd>/
 *
 * Agents can reference the saved path via their file tools, and the chat UI
 * uses the same [kind已保存: /path] marker to render thumbnails.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Sniff an image MIME type from its magic bytes. Falls back to JPEG when no
 * signature matches — most channels deliver JPEG by default and downstream
 * tools tolerate the wrong tag better than no tag.
 */
export function inferImageMime(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.length >= 12 && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/silk': '.silk',
  'audio/wav': '.wav',
  'audio/amr': '.amr',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
}

function inferExtFromBytes(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  if (buf.length >= 12 && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'RIFF') return '.wav'
  // SILK_V3 magic: "#!SILK_V3"
  if (buf.length >= 9 && buf.subarray(0, 9).toString('ascii') === '#!SILK_V3') return '.silk'
  // Skip past the optional leading byte that WeChat sometimes prepends
  if (buf.length >= 10 && buf[0] === 0x02 && buf.subarray(1, 10).toString('ascii') === '#!SILK_V3') return '.silk'
  return '.bin'
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file'
}

export interface SaveMediaParams {
  workspacePath: string
  /** Channel slug — weixin uses accountId, web uses 'web'. Determines subpath. */
  accountId: string
  /** Top-level channel directory under `.halo/`. Defaults to 'weixin' for backward compat. */
  channel?: string
  buffer: Buffer
  kind: 'image' | 'voice' | 'video' | 'file'
  mimeType?: string
  originalFilename?: string
}

/** Returns the absolute path of the saved file. */
export async function saveInboundMedia(params: SaveMediaParams): Promise<string> {
  const date = new Date()
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const channel = params.channel ?? 'weixin'
  const dir = path.join(
    params.workspacePath, '.halo', 'assets', channel, 'inbound',
    params.accountId, `${yyyy}-${mm}-${dd}`,
  )
  await fs.mkdir(dir, { recursive: true })

  const ts = `${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}${date.getSeconds().toString().padStart(2, '0')}`
  const suffix = randomBytes(3).toString('hex')

  let filename: string
  if (params.originalFilename) {
    filename = `${ts}_${suffix}_${sanitizeFilename(params.originalFilename)}`
  } else {
    const ext = params.mimeType ? (EXT_BY_MIME[params.mimeType] ?? inferExtFromBytes(params.buffer))
                                : inferExtFromBytes(params.buffer)
    filename = `${params.kind}_${ts}_${suffix}${ext}`
  }

  const fullPath = path.join(dir, filename)
  await fs.writeFile(fullPath, params.buffer)
  return fullPath
}
