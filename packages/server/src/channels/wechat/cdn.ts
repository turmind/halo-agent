/**
 * WeChat CDN download helpers — AES-128-ECB decryption of media payloads.
 */
import { createDecipheriv, createCipheriv, randomBytes, createHash } from 'node:crypto'

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Ciphertext size after AES-128-ECB with PKCS7 padding. */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)           → images (from media.aes_key)
 *   - base64(hex string of 16 bytes) → files / voice / video
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`[${label}] aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`)
}

function buildFallbackUrl(encryptedQueryParam: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)')
    throw new Error(`[${label}] CDN download ${res.status}: ${body.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Download and AES-128-ECB decrypt media from CDN.
 * Prefers server-provided `fullUrl`; falls back to client-built URL.
 */
export async function downloadAndDecrypt(params: {
  fullUrl?: string
  encryptedQueryParam?: string
  aesKeyBase64: string
  label: string
}): Promise<Buffer> {
  const url = params.fullUrl || (params.encryptedQueryParam ? buildFallbackUrl(params.encryptedQueryParam) : '')
  if (!url) throw new Error(`[${params.label}] neither fullUrl nor encryptedQueryParam provided`)
  const key = parseAesKey(params.aesKeyBase64, params.label)
  const encrypted = await fetchCdnBytes(url, params.label)
  return decryptAesEcb(encrypted, key)
}

export async function downloadPlain(params: {
  fullUrl?: string
  encryptedQueryParam?: string
  label: string
}): Promise<Buffer> {
  const url = params.fullUrl || (params.encryptedQueryParam ? buildFallbackUrl(params.encryptedQueryParam) : '')
  if (!url) throw new Error(`[${params.label}] neither fullUrl nor encryptedQueryParam provided`)
  return fetchCdnBytes(url, params.label)
}

// ── Upload ───────────────────────────────────────────────────────────

const UPLOAD_MAX_RETRIES = 3

export interface UploadedFileInfo {
  filekey: string
  downloadEncryptedQueryParam: string
  /** AES key as hex string (32 chars). */
  aeskeyHex: string
  fileSize: number
  fileSizeCiphertext: number
}

/**
 * Generate a fresh AES key and file identifier for a new upload. Callers
 * pass these into `getUploadUrl` and then `uploadCiphertext`.
 */
export function prepareUpload(plaintext: Buffer): {
  filekey: string
  aeskey: Buffer
  aeskeyHex: string
  rawsize: number
  rawfilemd5: string
  filesize: number
} {
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)
  return {
    filekey,
    aeskey,
    aeskeyHex: aeskey.toString('hex'),
    rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: aesEcbPaddedSize(plaintext.length),
  }
}

function buildFallbackUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

/**
 * POST encrypted bytes to CDN. Returns the download x-encrypted-param header
 * to be stored on the outbound WeixinMessage so the receiver can download.
 */
export async function uploadCiphertext(params: {
  plaintext: Buffer
  aeskey: Buffer
  filekey: string
  uploadFullUrl?: string
  uploadParam?: string
  label: string
}): Promise<{ downloadEncryptedQueryParam: string }> {
  const ciphertext = encryptAesEcb(params.plaintext, params.aeskey)
  const url = params.uploadFullUrl?.trim()
    || (params.uploadParam ? buildFallbackUploadUrl(params.uploadParam, params.filekey) : '')
  if (!url) throw new Error(`[${params.label}] missing upload URL`)

  let lastErr: unknown
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        const err = res.headers.get('x-error-message') ?? await res.text().catch(() => '')
        throw new Error(`CDN upload client error ${res.status}: ${err}`)
      }
      if (res.status !== 200) {
        const err = res.headers.get('x-error-message') ?? `status ${res.status}`
        throw new Error(`CDN upload server error: ${err}`)
      }
      const downloadEncryptedQueryParam = res.headers.get('x-encrypted-param') ?? ''
      if (!downloadEncryptedQueryParam) throw new Error('CDN response missing x-encrypted-param')
      return { downloadEncryptedQueryParam }
    } catch (err) {
      lastErr = err
      if (err instanceof Error && err.message.includes('client error')) throw err
      if (attempt === UPLOAD_MAX_RETRIES) break
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`[${params.label}] CDN upload failed`)
}
