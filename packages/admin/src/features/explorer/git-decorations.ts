'use client'

import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { isStagedChar, isWorkingChar } from '@/features/source-control/status-meta'

/**
 * Git status decorations for the Explorer file tree (VSCode-style file/folder
 * coloring + badges). One `/git/status` call yields the full change set; we
 * build a path→char map for files and bubble each change up to every ancestor
 * folder so collapsed/lazy-loaded directories still show a dot (the children
 * may not be loaded into the tree, so we can't derive folder state by walking
 * the tree — it must come from the flat status paths).
 *
 * Keyed by projectId so each mounted FileTree reads only its own workspace's
 * decorations (the scoped Skills tree has a different projectId and no driver,
 * so it stays undecorated — no bleed).
 */

/** Sentinel char for a folder whose subtree mixes more than one change kind. */
export const MIXED = '*'

interface ProjectDecorations {
  /** Workspace-relative path → the single status char to render for that file. */
  files: Map<string, string>
  /** Folder path → aggregated char (a real status char, or MIXED). */
  dirs: Map<string, string>
  /** Paths ignored by .gitignore (directories collapsed, e.g. `node_modules`),
   *  grayed out in the tree. A descendant of one of these is ignored too —
   *  resolve via isPathIgnored, not a direct `.has`. */
  ignored: Set<string>
}

interface GitDecorationsStore {
  byProject: Record<string, ProjectDecorations>
  setForProject: (projectId: string, decorations: ProjectDecorations) => void
  clearProject: (projectId: string) => void
}

const EMPTY: ProjectDecorations = { files: new Map(), dirs: new Map(), ignored: new Set() }

const useGitDecorationsStore = create<GitDecorationsStore>((set) => ({
  byProject: {},
  setForProject: (projectId, decorations) =>
    set((s) => ({ byProject: { ...s.byProject, [projectId]: decorations } })),
  clearProject: (projectId) =>
    set((s) => {
      if (!s.byProject[projectId]) return s
      const next = { ...s.byProject }
      delete next[projectId]
      return { byProject: next }
    }),
}))

/** Read this project's decorations (stable EMPTY when none loaded yet). */
export function useGitDecorations(projectId: string | null): ProjectDecorations {
  return useGitDecorationsStore((s) => (projectId ? s.byProject[projectId] : undefined) ?? EMPTY)
}

/**
 * The status char to render for a file: prefer the working-tree side (what the
 * user is actively editing), fall back to the staged side. Mirrors how the
 * Source Control panel splits the two sides.
 */
function fileChar(index: string, workingDir: string): string {
  if (isWorkingChar(workingDir)) return workingDir === '?' ? '?' : workingDir
  if (isStagedChar(index)) return index
  return ''
}

/** Build the file + bubbled-dir maps from the flat status file list. */
function buildDecorations(
  files: Array<{ path: string; index: string; workingDir: string }>,
  ignored: string[],
): ProjectDecorations {
  const fileMap = new Map<string, string>()
  const dirMap = new Map<string, string>()

  for (const f of files) {
    const char = fileChar(f.index, f.workingDir)
    if (!char) continue
    fileMap.set(f.path, char)

    // Bubble up to every ancestor folder. A folder shows the subtree's char
    // when uniform, else MIXED.
    const segments = f.path.split('/')
    for (let i = 0; i < segments.length - 1; i++) {
      const dirPath = segments.slice(0, i + 1).join('/')
      const existing = dirMap.get(dirPath)
      if (existing === undefined) dirMap.set(dirPath, char)
      else if (existing !== char && existing !== MIXED) dirMap.set(dirPath, MIXED)
    }
  }

  return { files: fileMap, dirs: dirMap, ignored: new Set(ignored) }
}

/**
 * Whether a tree node is gitignored. The ignored set collapses directories
 * (`node_modules`, `dist`), so a node matches when its path is in the set OR
 * sits under an ignored directory. A changed path takes precedence over ignored
 * (a force-added file can be both) — callers check the status char first.
 */
export function isPathIgnored(ignored: Set<string>, path: string): boolean {
  if (ignored.size === 0) return false
  if (ignored.has(path)) return true
  for (const ig of ignored) {
    if (path.startsWith(ig + '/')) return true
  }
  return false
}

/**
 * Mount once per workspace to keep the active project's decorations in sync.
 * Fetches on mount + project change, and on `file:changed` (debounced — the
 * watcher ignores .git so this won't loop on our own stage/commit). No polling.
 */
export function useGitDecorationsSync(projectId: string | null): void {
  useEffect(() => {
    if (!projectId) return
    const { setForProject, clearProject } = useGitDecorationsStore.getState()
    let cancelled = false

    async function refresh() {
      try {
        // Status + ignored in one shot per refresh (same debounce, no extra
        // polling). ignored is a separate cheap call (dirs collapsed).
        const [status, ign] = await Promise.all([
          api.git.status(projectId!),
          api.git.ignored(projectId!),
        ])
        // Non-repo folder (isRepo:false) → no decorations, keep the tree clean.
        if (status.isRepo === false) {
          if (!cancelled) clearProject(projectId!)
          return
        }
        if (!cancelled) setForProject(projectId!, buildDecorations(status.files, ign.ignored))
      } catch {
        // Non-git folder or transient error — drop decorations, keep the tree usable.
        if (!cancelled) clearProject(projectId!)
      }
    }

    void refresh()

    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = wsClient.on('file:changed', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 400)
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsub()
      clearProject(projectId)
    }
  }, [projectId])
}
