'use client'

import { create } from 'zustand'

/** A "something changed, re-fetch yourself" signal: consumers subscribe to
 *  `version`, mutators call `bump()`. Why a counter and not a shared store:
 *  each consumer applies its own filters / caches its own derived tree, so
 *  a fan-out signal is the simplest thing that lets them stay independent. */
export interface VersionBus {
  version: number
  bump(): void
}

export function createVersionBus() {
  const useBus = create<VersionBus>((set) => ({
    version: 0,
    bump: () => set((s) => ({ version: s.version + 1 })),
  }))
  /** Imperative bump — for non-React handlers / event listeners. */
  const bump = () => useBus.getState().bump()
  return { useBus, bump }
}
