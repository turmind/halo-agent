'use client'

import { useState, useRef } from 'react'
import { EditorPanel } from '@/features/editor/editor-panel'
import { loadFileTree } from '@/features/explorer/use-file-tree'
import { FolderPicker } from '@/features/explorer/folder-picker'
import { api } from '@/shared/api-client'
import { cn, promptInput } from '@/shared/utils'
import { FolderTree, FolderOpen, RefreshCw, FilePlus, FolderPlus, Upload, FolderSearch } from 'lucide-react'
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
  const [loading, setLoading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

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
        <input type="text" value={pathInput} onChange={(e) => onPathInputChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onOpenFolder()} placeholder="Enter folder path, press Enter" className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 text-xs text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]" />
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
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{projectName}</span>
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
            <FolderOpen className="h-8 w-8 text-zinc-700" />
            <p className="text-xs text-[var(--muted-foreground)]">Enter a folder path to explore files</p>
          </div>
        )}
      </div>
    </div>
  )
}
