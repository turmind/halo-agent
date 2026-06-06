'use client'

import { create } from 'zustand'

/**
 * Shared selection state for the Cron tab. Sidebar (job list) writes
 * `selectedId` and `formMode`; main pane (detail / form) reads them.
 *
 * `formMode` is null when showing the detail of `selectedId`, and set to
 * `'create'` or `'edit'` when the form replaces the detail. Edit form
 * inherits the selected job, so the form doesn't need its own job ref.
 */
export interface CronSelectionStore {
  selectedId: string | null
  formMode: 'create' | 'edit' | null
  setSelectedId: (id: string | null) => void
  openCreate: () => void
  openEdit: () => void
  closeForm: () => void
}

export const useCronStore = create<CronSelectionStore>((set) => ({
  selectedId: null,
  formMode: null,
  setSelectedId: (selectedId) => set({ selectedId, formMode: null }),
  openCreate: () => set({ formMode: 'create' }),
  openEdit: () => set({ formMode: 'edit' }),
  closeForm: () => set({ formMode: null }),
}))
