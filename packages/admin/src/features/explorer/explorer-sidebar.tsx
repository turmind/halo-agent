'use client'

import { useState, useRef, useEffect } from 'react'
import { EditorPanel } from '@/features/editor/editor-panel'
import { loadFileTree } from '@/features/explorer/use-file-tree'
import { FolderPicker } from '@/features/explorer/folder-picker'
import { useRecentWorkspaces } from '@/features/explorer/use-recent-workspaces'
import { useChatStore } from '@/features/chat/chat-store'
import { api } from '@/shared/api-client'
import { cn, promptInput } from '@/shared/utils'
import { FolderTree, FolderOpen, RefreshCw, FilePlus, FolderPlus, Upload, FolderSearch, History, X } from 'lucide-react'
import { useT } from '@/shared/i18n'

interface ExplorerSidebarProps {
  projectId: string | null
  pathInput: string
  onPathInputChange: (v: string) => void
  onOpenFolder: () => void
  onOpenPath: (path: string) => void
  activeProject: { name: string; path: string } | null
}

export function ExplorerSidebar({ projectId, pathInput, onPathInputChange, onOpenFolder, onOpenPath, activeProject }: ExplorerSidebarProps) {
  const t = useT()
  // Agent status light next to the workspace name: amber pulse while streaming
  // (busy), static emerald when idle. Sole state source is chat-store's
  // isStreaming (driven by message-streaming events).
  const isBusy = useChatStore((s) => s.isStreaming)
  const [loading, setLoading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  // Recent-workspaces dropdown: focus shows the full MRU list (A), typing filters
  // it (B). `typed` distinguishes the two — on focus the input still holds the
  // current workspace path, which we don't want to filter by until the user edits.
  const { recent, remove } = useRecentWorkspaces()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [typed, setTyped] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dropdownOpen) return
    function onDown(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [dropdownOpen])

  const query = typed ? pathInput.trim().toLowerCase() : ''
  const recentMatches = recent.filter((p) => p !== activeProject?.path && (!query || p.toLowerCase().includes(query)))
  const folderName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p

  function handleRefresh() {
    if (!projectId) return
    setLoading(true)
    loadFileTree(projectId)
    setTimeout(() => setLoading(false), 500)
  }

  async function handleNewFile() {
    if (!projectId) return
    const name = await promptInput('New file name (relative path, e.g. src/hello.ts):')
    if (!name?.trim()) return
    try {
      await api.files.create(name.trim(), projectId)
      loadFileTree(projectId)
    } catch (err) {
      console.error('[Explorer] Failed to create file:', err)
      window.alert(err instanceof Error ? err.message : 'Failed to create file')
    }
  }

  async function handleNewFolder() {
    if (!projectId) return
    const name = await promptInput('New folder name (relative path, e.g. src/utils):')
    if (!name?.trim()) return
    try {
      await api.files.mkdir(name.trim(), projectId)
      loadFileTree(projectId)
    } catch (err) {
      console.error('[Explorer] Failed to create folder:', err)
      window.alert(err instanceof Error ? err.message : 'Failed to create folder')
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!projectId || !e.target.files?.length) return
    const files = Array.from(e.target.files)
    try {
      await api.files.upload(files, projectId)
      loadFileTree(projectId)
    } catch (err) {
      console.error('[Explorer] Upload failed:', err)
      window.alert(err instanceof Error ? err.message : 'Upload failed')
    }
    e.target.value = ''
  }

  const projectName = activeProject?.path.split('/').filter(Boolean).pop()?.toUpperCase() ?? 'EXPLORER'

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
        <FolderTree className="h-4 w-4 text-[var(--muted-foreground)]" />
        <span className="ml-2 text-sm font-medium text-[var(--foreground)]">{t('nav.explorer')}</span>
        <div className="flex-1" />
        {projectId && (
          <button
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh"
            className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 border-b border-[var(--border)] p-3">
        <div ref={dropdownRef} className="relative min-w-0 flex-1">
          <input
            type="text"
            value={pathInput}
            onChange={(e) => { onPathInputChange(e.target.value); setTyped(true); setDropdownOpen(true) }}
            onFocus={() => { setTyped(false); setDropdownOpen(true) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { setDropdownOpen(false); onOpenFolder() }
              else if (e.key === 'Escape') setDropdownOpen(false)
            }}
            placeholder="Enter folder path, press Enter"
            className="w-full rounded border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 text-xs text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]"
          />
          {dropdownOpen && recentMatches.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
              {recentMatches.map((p) => (
                <div
                  key={p}
                  onClick={() => { setDropdownOpen(false); onOpenPath(p) }}
                  className="group flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-[var(--secondary)]"
                >
                  <History className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-[var(--foreground)]">{folderName(p)}</div>
                    <div className="truncate text-[10px] text-[var(--muted-foreground)]">{p}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); remove(p) }}
                    title="Remove from recent"
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 hover:bg-[var(--border)] hover:text-[var(--foreground)] group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowPicker(true)}
          title="Browse for folder"
          className="shrink-0 rounded border border-[var(--border)] p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <FolderSearch className="h-3.5 w-3.5" />
        </button>
      </div>
      {showPicker && (
        <FolderPicker
          initialPath={activeProject?.path}
          onSelect={(p) => {
            setShowPicker(false)
            onOpenPath(p)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
      {projectId && (
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              title={isBusy ? t('status.busy') : t('status.idle')}
              className={cn(
                'inline-block h-2 w-2 shrink-0 rounded-full',
                isBusy ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500',
              )}
            />
            <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{projectName}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button onClick={handleNewFile} title="New File" className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
              <FilePlus className="h-3.5 w-3.5" />
            </button>
            <button onClick={handleNewFolder} title="New Folder" className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => uploadRef.current?.click()} title="Upload Files" className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
              <Upload className="h-3.5 w-3.5" />
            </button>
            <input ref={uploadRef} type="file" multiple className="hidden" onChange={handleUpload} />
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {projectId ? (
          <EditorPanel projectId={projectId} mode="tree-only" />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <FolderOpen className="h-8 w-8 text-[var(--muted-foreground)]" />
            <p className="text-xs text-[var(--muted-foreground)]">Enter a folder path to explore files</p>
          </div>
        )}
      </div>
    </div>
  )
}
