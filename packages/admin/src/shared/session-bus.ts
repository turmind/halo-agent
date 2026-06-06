'use client'

import { create } from 'zustand'

/**
 * Tiny bus for "session list changed" signals.
 *
 * Any component that holds a session list (chat-panel history count,
 * sessions sidebar tree, session-list dropdown…) subscribes to `version`
 * and re-fetches when it changes. Any place that mutates sessions
 * (delete, archive, new session) calls `bump()` after the server-side
 * change is confirmed.
 *
 * Why not a central store of sessions: different views apply different
 * filters (includeArchived, parent filtering, per-project…) and cache the
 * derived tree. A version counter is the simplest way to fan-out a
 * "refresh yourself" signal without forcing those consumers to converge.
 */
interface SessionBus {
  version: number
  bump(): void
}

export const useSessionBus = create<SessionBus>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))

/** Imperative bump — useful in non-React handlers / event listeners. */
export function bumpSessionBus() {
  useSessionBus.getState().bump()
}
