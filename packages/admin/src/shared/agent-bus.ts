'use client'

import { create } from 'zustand'

/**
 * Tiny bus for "agent list changed" signals.
 *
 * Same shape as session-bus / skill-bus. The Agent management view subscribes
 * to `version` and re-fetches when it changes. Any place that mutates agents
 * (create, delete, external file events) calls `bump()`.
 */
interface AgentBus {
  version: number
  bump(): void
}

export const useAgentBus = create<AgentBus>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))

export function bumpAgentBus() {
  useAgentBus.getState().bump()
}
