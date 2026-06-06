'use client'

import { create } from 'zustand'

/**
 * Tiny bus for "skill list changed" signals.
 *
 * Same shape as session-bus. Any component holding a skill list (Skills sidebar,
 * the `skills` store used when picking skills for an agent in agent-management)
 * subscribes to `version` and re-fetches when it changes. Any place that mutates
 * skills (create, delete) — including automatic ones driven by WS file events —
 * calls `bump()` after the change is observed.
 */
interface SkillBus {
  version: number
  bump(): void
}

export const useSkillBus = create<SkillBus>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))

export function bumpSkillBus() {
  useSkillBus.getState().bump()
}
