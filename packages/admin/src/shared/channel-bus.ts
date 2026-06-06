'use client'

import { create } from 'zustand'

/**
 * "Channel data changed / please reload" signal. The Channels sidebar fires
 * this when the user clicks refresh; whichever channel page is currently
 * mounted (weixin / telegram / web) re-fetches its account list. Same shape
 * as skill-bus / agent-bus.
 */
interface ChannelBus {
  version: number
  bump(): void
}

export const useChannelBus = create<ChannelBus>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))

export function bumpChannelBus() {
  useChannelBus.getState().bump()
}
