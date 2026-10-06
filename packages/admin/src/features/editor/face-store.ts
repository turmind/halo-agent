'use client'

import { create } from 'zustand'
import { clearFaceAcks } from './face-bridge'

/** Per-workspace face toggle (the ✨ button). On = a pinned, unclosable face
 *  tab in the editor (editor-store `pinnedTab`, editor-panel) plus a
 *  `[Face open: …]` line on every user message (use-chat). Persisted per
 *  workspace in localStorage so a refresh restores it. */
const storageKey = (projectId: string) => `halo_face_on:${projectId}`

function readStored(projectId: string): boolean {
  return typeof window !== 'undefined' && localStorage.getItem(storageKey(projectId)) === '1'
}

interface FaceStore {
  /** Toggled during this page-load; workspaces absent here read localStorage. */
  on: Record<string, boolean>
  setFaceOn(projectId: string, on: boolean): void
}

export const useFaceStore = create<FaceStore>((set) => ({
  on: {},
  setFaceOn(projectId, on) {
    if (isFaceOn(projectId) === on) return
    if (on) localStorage.setItem(storageKey(projectId), '1')
    else localStorage.removeItem(storageKey(projectId))
    // Receipts belong to one open stretch of the face — never carry them over.
    clearFaceAcks()
    set((s) => ({ on: { ...s.on, [projectId]: on } }))
  },
}))

// Turning the toggle on should land on the face; a refresh-restore should not
// steal focus from the restored tab. One-shot flag the pinning effect consumes.
let focusPending = false
export function requestFaceFocus(): void { focusPending = true }
export function consumeFaceFocus(): boolean {
  const v = focusPending
  focusPending = false
  return v
}

export function isFaceOn(projectId: string | null | undefined): boolean {
  if (!projectId) return false
  return useFaceStore.getState().on[projectId] ?? readStored(projectId)
}

export function useFaceOn(projectId: string | null | undefined): boolean {
  return useFaceStore((s) => (projectId ? (s.on[projectId] ?? readStored(projectId)) : false))
}
