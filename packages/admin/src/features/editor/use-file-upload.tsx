'use client'

import { useState, useCallback, useRef } from 'react'
import { loadFileTree } from '@/features/explorer/use-file-tree'
import { api } from '@/shared/api-client'
import { useScopedEditorStore } from '@/shared/stores/editor-store'
import { X } from 'lucide-react'

/** Upload files into the workspace with a progress bar (percentage + cancel).
 *  Shared by the tree's OS-file drop (EditorPanel) and the Explorer header's
 *  Upload Files button; the caller renders `uploadBar` above its tree. */
export function useFileUpload(projectId: string | null) {
  const useEditorStore = useScopedEditorStore()
  const [uploadProgress, setUploadProgress] = useState<{ count: number; progress: number } | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)

  const upload = useCallback(
    async (files: File[], targetDir?: string) => {
      if (!projectId) return
      const controller = new AbortController()
      uploadAbortRef.current = controller
      setUploadProgress({ count: files.length, progress: 0 })
      try {
        await api.files.upload(files, projectId, targetDir || undefined, (loaded, total) => {
          if (total > 0) {
            setUploadProgress((prev) => prev ? { ...prev, progress: (loaded / total) * 100 } : null)
          }
        }, controller.signal)
        setUploadProgress((prev) => prev ? { ...prev, progress: 100 } : null)
        setTimeout(() => setUploadProgress(null), 400)
        loadFileTree(projectId, useEditorStore)
      } catch (err) {
        setUploadProgress(null)
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('[FileUpload] Upload failed:', err)
        window.alert(err instanceof Error ? err.message : 'Upload failed')
      } finally {
        uploadAbortRef.current = null
      }
    },
    [projectId, useEditorStore],
  )

  const uploadBar = uploadProgress && (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--card)] px-3 py-1.5">
      <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
        <span>Uploading {uploadProgress.count} file{uploadProgress.count > 1 ? 's' : ''}...</span>
        <span className="flex items-center gap-1.5">
          {Math.round(uploadProgress.progress)}%
          <button
            type="button"
            onClick={() => uploadAbortRef.current?.abort()}
            className="rounded p-0.5 hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
            title="Cancel upload"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--secondary)]">
        <div
          className="h-full rounded-full bg-[var(--primary)] transition-all duration-150"
          style={{ width: `${uploadProgress.progress}%` }}
        />
      </div>
    </div>
  )

  return { upload, uploadBar }
}
