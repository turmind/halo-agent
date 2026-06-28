'use client'

import { create } from 'zustand'

/**
 * Shared selection state for the Source Control tab. The sidebar writes the
 * clicked change; the main pane reads it to fetch + render the diff. `staged`
 * picks which blob the diff's "modified" side shows (index vs working tree);
 * `from` carries the pre-rename path so the diff's "original" side resolves.
 * `commit` (Graph view) switches the diff to that historical commit's own
 * change (parent vs commit) instead of the working-tree/staged comparison.
 */
export interface GitSelection {
  path: string
  staged: boolean
  from?: string
  commit?: string
}

interface GitSelectionStore {
  selected: GitSelection | null
  select: (sel: GitSelection) => void
  clear: () => void
}

export const useGitStore = create<GitSelectionStore>((set) => ({
  selected: null,
  select: (selected) => set({ selected }),
  clear: () => set({ selected: null }),
}))
