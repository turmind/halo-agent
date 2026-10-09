'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, CornerLeftUp, File, Folder, FolderGit2, Home, X } from 'lucide-react'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'
import { cn, formatFileSize } from '@/shared/utils'

/** `path` is absolute, forward slashes (POSIX `/…`, Windows `C:/…`). */
export interface PickedFile {
  path: string
  name: string
  size: number
}

interface Entry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

interface Props {
  /** Absolute workspace root (forward slashes) — the 「工作区」 shortcut. */
  workspace: string
  /** Lower-case suffixes with the dot; empty = any file. Directories always show. */
  accept: string[]
  /** Absolute dir to open at; falls back to the workspace if it can't be listed. */
  start: string
  /** Exactly once: the picked file, or null (cancelled). */
  onDone: (file: PickedFile | null) => void
}

const matches = (name: string, accept: string[]) => {
  if (accept.length === 0) return true
  const lower = name.toLowerCase()
  return accept.some((a) => lower.endsWith(a))
}
/** The server answers with native separators; the picker speaks forward slashes. */
const slash = (p: string) => p.replace(/\\/g, '/')
/** Root of an absolute path: `/` or `C:/`. */
const rootOf = (p: string) => /^[A-Za-z]:\//.exec(p)?.[0] ?? '/'

/**
 * Browse-the-machine file picker (extension `pick`, capability fs-read). A
 * body portal above every overlay (immersive viewer z-70, its toast z-80):
 * fullscreen sits on <html>, so this stays visible there. Esc closes only the
 * picker — the capture listener swallows it before workspace-layout's
 * maximize Esc sees it.
 */
export function FilePicker({ workspace, accept, start, onDone }: Props) {
  const t = useT()
  const [dir, setDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [typed, setTyped] = useState('')
  const [home, setHome] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef(false)
  const finish = useCallback((file: PickedFile | null) => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(file)
  }, [onDone])

  const open = useCallback((target: string, fallback: boolean) => {
    setEntries(null)
    setError(null)
    api.fs.browseFiles(target).then((res) => {
      const at = slash(res.path)
      setDir(at)
      setTyped(at)
      setEntries(res.entries.map((e) => ({ ...e, path: slash(e.path) })).filter((e) => e.type === 'directory' || matches(e.name, accept)))
      setSelected(0)
    }, (err: unknown) => {
      if (fallback && target !== workspace) { open(workspace, false); return }
      setDir(target)
      setTyped(target)
      setEntries([])
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [accept, workspace])

  useEffect(() => { open(start, true) }, [open, start])
  useEffect(() => { api.fs.home().then((r) => setHome(slash(r.home)), () => {}) }, [])
  // Take focus from the viewer iframe: keys typed there never reach this window.
  useEffect(() => { panelRef.current?.focus() }, [])

  const root = dir ? rootOf(dir) : '/'
  const parent = dir && dir !== root ? (dir.lastIndexOf('/') <= root.length - 1 ? root : dir.slice(0, dir.lastIndexOf('/'))) : null
  // Row 0 is "up" whenever there is a parent; keyboard index spans both.
  const rows: Array<Entry | 'up'> = [...(parent !== null ? ['up' as const] : []), ...(entries ?? [])]

  const activate = (row: Entry | 'up') => {
    if (row === 'up') { if (parent !== null) open(parent, false); return }
    if (row.type === 'directory') { open(row.path, false); return }
    finish({ path: row.path, name: row.name, size: row.size ?? 0 })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The path box keeps its own editing keys; Esc / Enter still act here.
      const inBox = (e.target as HTMLElement | null)?.tagName === 'INPUT'
      if (!['Escape', 'Enter', 'ArrowDown', 'ArrowUp', 'Backspace'].includes(e.key)) return
      if (inBox && e.key === 'Backspace') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') finish(null)
      else if (inBox && e.key === 'Enter') { if (typed.trim()) open(slash(typed.trim()), false) }
      else if (e.key === 'ArrowDown') setSelected((i) => Math.min(i + 1, rows.length - 1))
      else if (e.key === 'ArrowUp') setSelected((i) => Math.max(i - 1, 0))
      else if (e.key === 'Backspace') { if (parent !== null) open(parent, false) }
      else if (rows[selected]) activate(rows[selected])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useEffect(() => {
    (listRef.current?.children[selected] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const crumbs = dir ? dir.slice(root.length).split('/').filter(Boolean) : []
  const crumbPath = (i: number) => root + crumbs.slice(0, i + 1).join('/')
  const shortcut = 'flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--secondary)]'

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('picker.title')}
      data-file-picker
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-3"
      onPointerDown={(e) => { if (e.target === e.currentTarget) finish(null) }}
    >
      <div ref={panelRef} tabIndex={-1} className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] shadow-xl outline-none">
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <span className="text-sm font-medium">{t('picker.title')}</span>
          {accept.length > 0 && <span className="truncate text-[10px] text-[var(--muted-foreground)]">{accept.join(' ')}</span>}
          <button type="button" onClick={() => finish(null)} aria-label={t('picker.cancel')} className="ml-auto rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <button type="button" onClick={() => open(workspace, false)} className={shortcut}>
            <FolderGit2 className="h-3.5 w-3.5" />{t('picker.workspace')}
          </button>
          {home && (
            <button type="button" onClick={() => open(home, false)} className={shortcut}>
              <Home className="h-3.5 w-3.5" />{t('picker.home')}
            </button>
          )}
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label={t('picker.pathBox')}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--primary)]"
          />
        </div>
        <nav className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] px-3 py-1.5 text-xs">
          <button type="button" onClick={() => open(root, false)} className="rounded px-1 py-0.5 font-mono hover:bg-[var(--secondary)]">{root}</button>
          {crumbs.map((seg, i) => (
            <span key={i} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="h-3 w-3 text-[var(--muted-foreground)]" />}
              <button type="button" onClick={() => open(crumbPath(i), false)} className="rounded px-1 py-0.5 hover:bg-[var(--secondary)]">{seg}</button>
            </span>
          ))}
        </nav>
        <div ref={listRef} className="min-h-[8rem] flex-1 overflow-y-auto py-1">
          {rows.map((row, i) => (
            <button
              key={row === 'up' ? '..' : row.path}
              type="button"
              onClick={() => activate(row)}
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') setSelected(i) }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm sm:py-1.5 sm:text-xs',
                i === selected ? 'bg-[var(--accent)] text-[var(--accent-foreground)]' : 'hover:bg-[var(--secondary)]',
              )}
            >
              {row === 'up' ? (
                <>
                  <CornerLeftUp className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                  <span>..</span>
                </>
              ) : (
                <>
                  {row.type === 'directory'
                    ? <Folder className="h-4 w-4 shrink-0 text-[var(--primary)]" />
                    : <File className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />}
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  {row.type === 'file' && row.size !== undefined && (
                    <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">{formatFileSize(row.size)}</span>
                  )}
                </>
              )}
            </button>
          ))}
          {entries === null && <p className="px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">{t('picker.loading')}</p>}
          {entries !== null && error && <p className="px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">{error}</p>}
          {entries !== null && !error && !entries.some((e) => e.type === 'file') && (
            <p className="px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">
              {accept.length > 0 ? t('picker.emptyAccept', { accept: accept.join(' ') }) : t('picker.empty')}
            </p>
          )}
        </div>
        <div className="flex justify-end border-t border-[var(--border)] px-3 py-2">
          <button type="button" onClick={() => finish(null)} className="rounded-md border border-[var(--border)] bg-[var(--secondary)] px-4 py-1.5 text-xs hover:opacity-90">
            {t('picker.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
