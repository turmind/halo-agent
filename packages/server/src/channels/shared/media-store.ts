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
import { extFromImageMime } from '@turmind/halo-core'

/** Image MIME types vision APIs accept as inline base64 blocks. Anything else
 *  must not reach the model as an image block — the API rejects the whole
 *  request. Single source for the web channel's inbound filter and
 *  session-manager's buildInput (admin WS images arrive there unfiltered).
 *
 *  Deliberately NOT derived from core's image table: this is the *vision API's*
 *  format list, not halo's. bmp is a first-class halo image (channels send it,
 *  `@image` inlines it) yet Anthropic rejects it, and a format added to core
 *  later must not silently start being sent to the model. */
export const VISION_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

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

/** Non-image types channels deliver. The image half of this lookup lives in
 *  core (`extFromImageMime`) — see `extForMime`. */
const EXT_BY_AV_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'audio/silk': '.silk',
  'audio/wav': '.wav',
  'audio/amr': '.amr',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
}

function extForMime(mime: string): string | undefined {
  return extFromImageMime(mime) ?? EXT_BY_AV_MIME[mime]
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
  return name.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file'
}

export interface SaveMediaParams {
  workspacePath: string
  /** Channel slug — wechat uses accountId, web uses 'web'. Determines subpath. */
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
    const ext = params.mimeType ? (extForMime(params.mimeType) ?? inferExtFromBytes(params.buffer))
                                : inferExtFromBytes(params.buffer)
    filename = `${params.kind}_${ts}_${suffix}${ext}`
  }

  const fullPath = path.join(dir, filename)
  await fs.writeFile(fullPath, params.buffer)
  return fullPath
}
