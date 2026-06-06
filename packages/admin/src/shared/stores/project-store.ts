import { create } from 'zustand'
import type { Project } from '@/shared/types'

interface ProjectStore {
  projects: Project[]
  activeProject: Project | null
  folderPath: string

  setProjects(projects: Project[]): void
  setActiveProject(project: Project | null): void
  setFolderPath(path: string): void
  /**
   * Open a folder as the active workspace.
   * @param path         absolute path (also used as `activeProject.id` for API calls)
   * @param workspaceId  stable short id from /api/fs/workspace/resolve. Used for
   *                     localStorage / cache keys so renames don't orphan state.
   */
  openFolder(path: string, workspaceId?: string): void
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  activeProject: null,
  folderPath: '',

  setProjects(projects: Project[]) {
    set({ projects })
  },

  setActiveProject(project: Project | null) {
    set({ activeProject: project })
  },

  setFolderPath(path: string) {
    set({ folderPath: path })
  },

  openFolder(path: string, workspaceId?: string) {
    const trimmed = path.trim()
    if (!trimmed) return

    const name = trimmed.split('/').filter(Boolean).pop() ?? trimmed
    const project: Project = {
      id: trimmed,
      name,
      path: trimmed,
      workspaceId,
      createdAt: Date.now(),
    }

    const projects = get().projects
    const existing = projects.find((p) => p.path === trimmed)
    if (!existing) {
      set({ projects: [...projects, project] })
    }

    set({ activeProject: project, folderPath: trimmed })
  },
}))
