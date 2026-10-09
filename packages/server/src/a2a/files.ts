/**
 * A2A image parts (plans/a2a.md §5 "Image parts"). Images only — the vision
 * types — at ≤5 MB decoded each and ≤10 MB per message / per result:
 *   - inbound message: `raw` / `url` parts → saved under .halo/assets/a2a/,
 *     passed to the session as vision input, one `[图片已保存: …]` note each
 *   - our result: `MEDIA:<path>` lines → `{ raw, mediaType, filename }` parts
 *   - outbound: files a2a_send attaches; a remote result's raw images saved
 */
import fs from 'node:fs'
import path from 'node:path'
import { imageMimeFromExt } from '@turmind/halo-core'
import { VISION_IMAGE_MIME_TYPES, saveInboundMedia, sniffImageMime } from '../channels/shared/media-store.js'
import { extractMediaMessage, isMediaPathAllowed } from '../channels/shared/media.js'
import type { AccountAccessLevel } from '../channels/shared/accounts.js'
import { policyGetBuffer } from './http.js'
import { RPC, RpcError, type WireFile } from './wire.js'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES_TOTAL_BYTES = 10 * 1024 * 1024
const URL_FETCH_TIMEOUT_MS = 15_000

const SUPPORTED = VISION_IMAGE_MIME_TYPES.join(', ')
const UNSUPPORTED_PART = `unsupported part: only text parts and image parts (raw or url, mediaType ${SUPPORTED}) are supported`
const mb = (n: number) => `${n / (1024 * 1024)} MB`

/** `image/PNG; x=y` → `image/png`; '' for anything not a string. */
function normalizeMime(v: unknown): string {
  return typeof v === 'string' ? v.split(';', 1)[0].trim().toLowerCase() : ''
}
function isImageMime(m: string): boolean { return VISION_IMAGE_MIME_TYPES.includes(m) }
// Every image's bytes are sniffed (sniffImageMime): a mislabelled image is
// relabelled, bytes that are no vision image are refused — the model API
// rejects a whole request over one bad image block, on every replayed turn.

// ── inbound message ───────────────────────────────────────────────────

/** A validated inbound image; `url` ones get their `buffer` in `fetchImageUrls`. */
export interface InboundImage { mediaType: string; filename?: string; buffer?: Buffer; url?: string }

/**
 * Pass 1, synchronous (runs before the messageId dedupe): part shapes, types,
 * raw decode + limits. Throws -32005 for a non-image / `data` part, -32602
 * for a limit or an empty message.
 */
export function parseMessageParts(msg: Record<string, unknown>): { text: string; images: InboundImage[] } {
  const parts = Array.isArray(msg.parts) ? msg.parts as Array<Record<string, unknown>> : []
  if (parts.length === 0) throw new RpcError(RPC.INVALID_PARAMS, 'message.parts is empty')
  const texts: string[] = []
  const images: InboundImage[] = []
  let total = 0
  for (const p of parts) {
    if (typeof p.text === 'string') { texts.push(p.text); continue }
    const mediaType = normalizeMime(p.mediaType)
    const filename = typeof p.filename === 'string' && p.filename ? p.filename : undefined
    if (typeof p.raw === 'string') {
      if (!isImageMime(mediaType)) throw new RpcError(RPC.CONTENT_TYPE, `${UNSUPPORTED_PART}; got raw part with mediaType ${mediaType || '(none)'}`)
      const buffer = Buffer.from(p.raw, 'base64')
      if (buffer.length === 0) throw new RpcError(RPC.INVALID_PARAMS, 'raw image part is empty or not base64')
      if (buffer.length > MAX_IMAGE_BYTES) throw new RpcError(RPC.INVALID_PARAMS, `image ${filename ?? '(raw part)'} is larger than ${mb(MAX_IMAGE_BYTES)}`)
      const actual = sniffImageMime(buffer)
      if (!actual) throw new RpcError(RPC.CONTENT_TYPE, `${UNSUPPORTED_PART}; raw part bytes are not a ${SUPPORTED} image`)
      total += buffer.length
      if (total > MAX_IMAGES_TOTAL_BYTES) throw new RpcError(RPC.INVALID_PARAMS, `images exceed ${mb(MAX_IMAGES_TOTAL_BYTES)} in total for one message`)
      images.push({ mediaType: actual, filename, buffer })
    } else if (typeof p.url === 'string') {
      // No mediaType → the response Content-Type decides (checked after the fetch).
      if (mediaType && !isImageMime(mediaType)) throw new RpcError(RPC.CONTENT_TYPE, `${UNSUPPORTED_PART}; got url part with mediaType ${mediaType}`)
      images.push({ mediaType, filename, url: p.url })
    } else {
      throw new RpcError(RPC.CONTENT_TYPE, `${UNSUPPORTED_PART}; got ${'data' in p ? 'a data part' : 'an unknown part'}`)
    }
  }
  const text = texts.join('\n\n').trim()
  if (!text && images.length === 0) throw new RpcError(RPC.INVALID_PARAMS, 'message text is empty')
  return { text, images }
}

/** Pass 2 (after the dedupe lookup, so a retried send never refetches): GET
 *  each `url` part through the URL policy, then the per-message total. A
 *  failure is -32602 (-32005 for a non-image Content-Type). */
export async function fetchImageUrls(images: InboundImage[]): Promise<InboundImage[]> {
  let total = images.reduce((n, i) => n + (i.buffer?.length ?? 0), 0)
  const out: InboundImage[] = []
  for (const img of images) {
    if (img.buffer || !img.url) { out.push(img); continue }
    const url = img.url
    let res
    try {
      res = await policyGetBuffer(url, { timeoutMs: URL_FETCH_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES })
    } catch (err) {
      throw new RpcError(RPC.INVALID_PARAMS, `image url fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`)
    }
    if (res.status < 200 || res.status >= 300) throw new RpcError(RPC.INVALID_PARAMS, `image url fetch failed (${url}): HTTP ${res.status}`)
    const mediaType = img.mediaType || normalizeMime(res.headers['content-type'])
    if (!isImageMime(mediaType)) throw new RpcError(RPC.CONTENT_TYPE, `${UNSUPPORTED_PART}; ${url} is ${mediaType || '(no content type)'}`)
    if (res.body.length === 0) throw new RpcError(RPC.INVALID_PARAMS, `image url fetch failed (${url}): empty body`)
    const actual = sniffImageMime(res.body)
    if (!actual) throw new RpcError(RPC.CONTENT_TYPE, `${UNSUPPORTED_PART}; ${url} did not return a ${SUPPORTED} image`)
    total += res.body.length
    if (total > MAX_IMAGES_TOTAL_BYTES) throw new RpcError(RPC.INVALID_PARAMS, `images exceed ${mb(MAX_IMAGES_TOTAL_BYTES)} in total for one message`)
    out.push({ ...img, mediaType: actual, buffer: res.body })
  }
  return out
}

/** Save one image under `<ws>/.halo/assets/a2a/inbound/<accountId>/<date>/`.
 *  The sender's filename is kept only when its extension matches the type. */
export function saveImage(workspace: string, accountId: string, img: { buffer: Buffer; mediaType: string; filename?: string }): Promise<string> {
  const keepName = img.filename && imageMimeFromExt(path.extname(img.filename)) === img.mediaType
  return saveInboundMedia({
    workspacePath: workspace, accountId, channel: 'a2a', buffer: img.buffer, kind: 'image', mimeType: img.mediaType,
    originalFilename: keepName ? img.filename : undefined,
  })
}

// ── local files → file parts ──────────────────────────────────────────

/** Read one local image as a file part, or say why it can't be one.
 *  `budget` = bytes left of the per-message / per-result total. */
export function readImageFile(filePath: string, budget: number): { file: WireFile; size: number } | { reason: string } {
  const mediaType = imageMimeFromExt(path.extname(filePath)) ?? ''
  if (!isImageMime(mediaType)) return { reason: `not a supported image (${SUPPORTED})` }
  let st: fs.Stats
  try { st = fs.statSync(filePath) } catch { return { reason: 'file not found' } }
  if (!st.isFile()) return { reason: 'not a file' }
  if (st.size > MAX_IMAGE_BYTES) return { reason: `larger than ${mb(MAX_IMAGE_BYTES)}` }
  if (st.size > budget) return { reason: `would exceed the ${mb(MAX_IMAGES_TOTAL_BYTES)} total` }
  const buf = fs.readFileSync(filePath)
  const actual = sniffImageMime(buf)
  if (!actual) return { reason: `content is not a ${SUPPORTED} image` }
  return { file: { filename: path.basename(filePath), mediaType: actual, raw: buf.toString('base64') }, size: buf.length }
}

/** Why a session at `level` may not hand this path to the server (a result
 *  `MEDIA:` line, an a2a_send file), or null. The symlink target is checked
 *  too: the server reads with its own rights, outside the session's sandbox. */
export function refusedPath(p: string, workspace: string, level: AccountAccessLevel): string | null {
  if (!path.isAbsolute(p)) return 'path is not absolute'
  if (level === 'full') return null
  if (!isMediaPathAllowed(p, workspace, level)) return 'outside the workspace and the temp dir'
  let real: string
  try { real = fs.realpathSync(p) } catch { return 'file not found' }
  let realWs = workspace
  try { realWs = fs.realpathSync(workspace) } catch { /* compare against the raw path */ }
  return isMediaPathAllowed(real, realWs, level) ? null : 'links outside the workspace and the temp dir'
}

/**
 * Our task result: each `MEDIA:<path>` line becomes a file part, read once,
 * here, at the terminal transition (serialization never touches the disk).
 * The marker lines are stripped; a refused path leaves a
 * `[file not attached: <name> — <reason>]` line instead. Synchronous on
 * purpose: completeTask and relay's reply_to clear after it stay in one tick.
 */
export function attachResultFiles(text: string, workspace: string, level: AccountAccessLevel): { text: string; files: WireFile[] } {
  const { text: stripped, mediaPaths } = extractMediaMessage(text)
  if (mediaPaths.length === 0) return { text, files: [] }
  const files: WireFile[] = []
  const notes: string[] = []
  let budget = MAX_IMAGES_TOTAL_BYTES
  for (const p of mediaPaths) {
    const why = refusedPath(p, workspace, level)
    const r = why ? { reason: why } : readImageFile(p, budget)
    if ('reason' in r) { notes.push(`[file not attached: ${path.basename(p)} — ${r.reason}]`); continue }
    files.push(r.file)
    budget -= r.size
  }
  if (notes.length) console.debug(`[A2A] result files refused: ${notes.join(' ')}`)
  return { text: [stripped, notes.join('\n')].filter(Boolean).join('\n\n'), files }
}

// ── a remote's result ─────────────────────────────────────────────────

/** A remote result artifact's parts → its text plus one note per file part:
 *  raw images are saved (`[图片已保存: <path>]`), url parts listed, never
 *  downloaded. The caller session gets text only — the agent can view_image. */
export async function readResultParts(parts: Array<Record<string, unknown>>, workspace: string, remoteName: string): Promise<{ text: string; notes: string[] }> {
  const texts: string[] = []
  const notes: string[] = []
  let budget = MAX_IMAGES_TOTAL_BYTES
  for (const p of parts) {
    if (typeof p.text === 'string') { texts.push(p.text); continue }
    const mediaType = normalizeMime(p.mediaType)
    const name = typeof p.filename === 'string' && p.filename ? p.filename : 'unnamed'
    if (typeof p.url === 'string') { notes.push(isImageMime(mediaType) || !mediaType ? `[图片: ${p.url}]` : `[文件: ${p.url}]`); continue }
    if (typeof p.raw !== 'string') continue
    const buffer = Buffer.from(p.raw, 'base64')
    const actual = sniffImageMime(buffer)
    const why = !isImageMime(mediaType) ? `${mediaType || 'no mediaType'} is not a supported image`
      : !actual ? `content is not a ${SUPPORTED} image`
      : buffer.length > MAX_IMAGE_BYTES ? `larger than ${mb(MAX_IMAGE_BYTES)}`
      : buffer.length > budget ? `would exceed the ${mb(MAX_IMAGES_TOTAL_BYTES)} total` : null
    if (why || !actual) { notes.push(`[file not saved: ${name} — ${why}]`); continue }
    try {
      notes.push(`[图片已保存: ${await saveImage(workspace, remoteName, { buffer, mediaType: actual, filename: name })}]`)
      budget -= buffer.length
    } catch (err) {
      notes.push(`[file not saved: ${name} — ${err instanceof Error ? err.message : String(err)}]`)
    }
  }
  return { text: texts.join(''), notes }
}
