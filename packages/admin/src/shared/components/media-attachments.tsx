'use client'

/**
 * Inline media previews for chat messages.
 *
 * Scans message text for known media path markers, renders thumbnails, and
 * pops a modal preview on click. Supported categories:
 *
 *   - Inbound WeChat media (written by weixin/handler.ts processItems):
 *       [图片已保存: /abs/path]
 *       [视频已保存: /abs/path]
 *       [语音消息 0:03已保存: /abs/path, 服务端转写: ...]
 *       [文件 "xxx.pdf" 已保存: /abs/path]
 *   - Outbound agent markers (from the wechat-send skill):
 *       MEDIA:/abs/path    (line-start form, as emitted by the skill)
 *
 * Files are fetched via /api/files/download?inline=1 (which enforces
 * path-in-workspace). Anything outside the workspace falls back to showing the
 * original marker text — no thumbnail.
 */

import { useState } from 'react'
import { useProjectStore } from '@/shared/stores/project-store'
import { X, FileText, Music, Video, Image as ImageIcon } from 'lucide-react'

export interface MediaRef {
  path: string
  label?: string   // e.g. original filename, voice transcript
  kind: 'image' | 'video' | 'audio' | 'file'
}

/** Stripped text + media refs extracted from a message body. */
export interface ParsedMedia {
  text: string
  media: MediaRef[]
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const VIDEO_EXTS = /\.(mp4|webm|mov|m4v|ogv)$/i
const AUDIO_EXTS = /\.(mp3|wav|flac|aac|m4a|ogg|opus|amr|silk)$/i

function classifyPath(p: string): MediaRef['kind'] {
  if (IMAGE_EXTS.test(p)) return 'image'
  if (VIDEO_EXTS.test(p)) return 'video'
  if (AUDIO_EXTS.test(p)) return 'audio'
  return 'file'
}

/**
 * Extract media markers from a message body. Returns the cleaned text (marker
 * lines removed) plus the list of refs. Order of detection:
 *   1. `[图片/视频/语音/文件 ...已保存: /path...]` — whole bracketed block replaced
 *   2. `MEDIA:/path` lines — whole line removed
 */
export function parseMediaMarkers(raw: string): ParsedMedia {
  const media: MediaRef[] = []

  // 1. Inbound WeChat markers
  const inbound = /\[(图片|视频|语音消息(?:\s*[^\s]+)?|文件(?:\s*"[^"]*")?)\s*已保存:\s*([^,\]]+)(?:,\s*服务端转写:\s*([^\]]+))?\]/g
  let text = raw.replace(inbound, (_match, tag: string, pathRaw: string, transcript?: string) => {
    const path = pathRaw.trim()
    let kind: MediaRef['kind']
    if (tag.startsWith('图片')) kind = 'image'
    else if (tag.startsWith('视频')) kind = 'video'
    else if (tag.startsWith('语音')) kind = 'audio'
    else if (tag.startsWith('文件')) kind = 'file'
    else kind = classifyPath(path)
    // Pull original filename out of 文件 "xxx" tag if present
    const labelMatch = tag.match(/"([^"]+)"/)
    const label = labelMatch ? labelMatch[1] : (transcript ? transcript.trim() : undefined)
    media.push({ path, kind, label })
    return '' // remove marker from text
  })

  // 2. Agent MEDIA: lines — match whole line so we can remove cleanly
  const outbound = /^[ \t]*MEDIA:\s*(\S.*?)\s*$/gm
  text = text.replace(outbound, (_match, pathRaw: string) => {
    const path = pathRaw.trim()
    media.push({ path, kind: classifyPath(path) })
    return ''
  })

  // Tidy up: collapse 3+ consecutive newlines, trim
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return { text, media }
}

export function MediaAttachments({ media }: { media: MediaRef[] }) {
  const [open, setOpen] = useState<MediaRef | null>(null)

  if (media.length === 0) return null

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {media.map((m, i) => (
          <MediaThumbnail key={`${m.path}-${i}`} media={m} onOpen={() => setOpen(m)} />
        ))}
      </div>
      {open && <MediaModal media={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function buildMediaUrl(path: string, projectPath: string | null): string | null {
  if (!projectPath) return null
  // Download endpoint allows paths inside the workspace, plus /tmp for agent
  // working files (e.g. Playwright screenshots). Anything else is silently skipped.
  const inWorkspace = path.startsWith(projectPath + '/') || path === projectPath
  const inTmp = path.startsWith('/tmp/')
  if (!inWorkspace && !inTmp) return null
  const params = new URLSearchParams()
  params.set('path', path)
  params.set('projectId', projectPath)
  params.set('inline', '1')
  return `/api/files/download?${params.toString()}`
}

function MediaThumbnail({ media, onOpen }: { media: MediaRef; onOpen: () => void }) {
  const projectPath = useProjectStore((s) => s.activeProject?.path ?? null)
  const url = buildMediaUrl(media.path, projectPath)
  const fileName = media.path.split('/').pop() ?? media.path

  // Outside workspace — no preview endpoint, just a static chip
  if (!url) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--secondary)]/30 px-2 py-1 font-mono text-[10px] text-[var(--muted-foreground)]">
        <KindIcon kind={media.kind} />
        {fileName}
      </span>
    )
  }

  const chipCls = 'inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--secondary)]/30 px-2 py-1 text-[11px] text-[var(--foreground)] cursor-pointer hover:ring-1 hover:ring-[var(--primary)]/40 transition-all no-underline'

  return (
    <button onClick={onOpen} className={chipCls} title={fileName}>
      <KindIcon kind={media.kind} />
      <span className="truncate max-w-[240px] font-mono">{media.label || fileName}</span>
    </button>
  )
}

function KindIcon({ kind }: { kind: MediaRef['kind'] }) {
  const cls = 'h-3 w-3'
  if (kind === 'image') return <ImageIcon className={cls} />
  if (kind === 'video') return <Video className={cls} />
  if (kind === 'audio') return <Music className={cls} />
  return <FileText className={cls} />
}

function MediaModal({ media, onClose }: { media: MediaRef; onClose: () => void }) {
  const projectPath = useProjectStore((s) => s.activeProject?.path ?? null)
  const url = buildMediaUrl(media.path, projectPath)
  if (!url) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 rounded p-2 text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      <div className="flex max-h-full max-w-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {media.kind === 'image' && (
          <img src={url} alt={media.path} className="max-h-[85vh] max-w-[90vw] object-contain" />
        )}
        {media.kind === 'video' && (
          <video src={url} controls autoPlay className="max-h-[85vh] max-w-[90vw]" />
        )}
        {media.kind === 'audio' && (
          <audio src={url} controls autoPlay className="w-[min(80vw,480px)]" />
        )}
        {media.kind === 'file' && (
          <a
            href={url.replace('&inline=1', '')}
            download={media.path.split('/').pop() ?? 'file'}
            className="rounded bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20 no-underline"
          >
            Download {media.path.split('/').pop()}
          </a>
        )}
        <div className="max-w-[90vw] truncate font-mono text-[11px] text-white/60">
          {media.path}
        </div>
      </div>
    </div>
  )
}
