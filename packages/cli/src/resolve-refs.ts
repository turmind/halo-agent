import fs from 'node:fs'
import path from 'node:path'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const MAX_FILE_BYTES = 100 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export interface ResolvedInput {
  text: string
  images: Array<{ data: string; mimeType: string }>
  attachments: string[]
  warnings: string[]
}

function mimeFromExt(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.bmp': return 'image/bmp'
    default: return 'application/octet-stream'
  }
}

// Matches @file or @image followed by a quoted or unquoted path
const REF_PATTERN = /@(file|image)\s+(?:"([^"]+)"|(\S+))/g

export function resolveRefs(input: string, workspace: string): ResolvedInput {
  const images: ResolvedInput['images'] = []
  const attachments: string[] = []
  const warnings: string[] = []
  const parts: string[] = []

  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = REF_PATTERN.exec(input)) !== null) {
    parts.push(input.slice(lastIdx, match.index))
    const kind = match[1] as 'file' | 'image'
    const rawPath = match[2] ?? match[3]
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspace, rawPath)
    const ext = path.extname(resolved).toLowerCase()

    if (!fs.existsSync(resolved)) {
      parts.push(`[not found: ${rawPath}]`)
      lastIdx = match.index + match[0].length
      continue
    }

    const stat = fs.statSync(resolved)
    if (!stat.isFile()) {
      parts.push(`[not a file: ${rawPath}]`)
      lastIdx = match.index + match[0].length
      continue
    }

    const isImage = kind === 'image' || IMAGE_EXTS.has(ext)
    if (isImage) {
      if (stat.size > MAX_IMAGE_BYTES) {
        warnings.push(`${rawPath}: image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_IMAGE_BYTES / 1024 / 1024}MB), skipped`)
        lastIdx = match.index + match[0].length
        continue
      }
      const data = fs.readFileSync(resolved).toString('base64')
      images.push({ data, mimeType: mimeFromExt(ext) })
    } else {
      const relPath = path.relative(workspace, resolved)
      if (stat.size > MAX_FILE_BYTES) {
        const content = fs.readFileSync(resolved, 'utf-8').slice(0, MAX_FILE_BYTES)
        parts.push(`\n<file path="${relPath}">\n${content}\n[truncated: file is ${(stat.size / 1024).toFixed(0)}KB, showing first ${MAX_FILE_BYTES / 1024}KB]\n</file>\n`)
        warnings.push(`${rawPath}: truncated (${(stat.size / 1024).toFixed(0)}KB, max ${MAX_FILE_BYTES / 1024}KB)`)
      } else {
        const content = fs.readFileSync(resolved, 'utf-8')
        parts.push(`\n<file path="${relPath}">\n${content}\n</file>\n`)
      }
    }
    attachments.push(rawPath)

    lastIdx = match.index + match[0].length
  }

  REF_PATTERN.lastIndex = 0
  parts.push(input.slice(lastIdx))
  return { text: parts.join('').trim(), images, attachments, warnings }
}
