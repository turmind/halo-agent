'use client'

import { create } from 'zustand'

/**
 * Shared selection + filter state for the Evolution tab. Sidebar (run
 * list) writes them; main pane (run detail) reads `selectedId`. The
 * `refreshTick` is bumped by the sidebar's Refresh button so the detail
 * pane re-fetches alongside the list — without it the button only
 * updated the left pane and the right side stayed stale until the user
 * clicked away and back.
 */
export interface EvolutionSelectionStore {
  selectedId: string | null
  filter: string
  refreshTick: number
  setSelectedId: (id: string | null) => void
  setFilter: (f: string) => void
  bumpRefresh: () => void
}

export const useEvolutionStore = create<EvolutionSelectionStore>((set) => ({
  selectedId: null,
  filter: 'all',
  refreshTick: 0,
  setSelectedId: (selectedId) => set({ selectedId }),
  setFilter: (filter) => set({ filter }),
  bumpRefresh: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),
}))
