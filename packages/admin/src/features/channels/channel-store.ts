import { create } from 'zustand'
import { defaultAdminChannelDescriptors } from './descriptors'

const STORAGE_KEY = 'halo_channel_active'

const VALID_IDS = new Set(defaultAdminChannelDescriptors.map((d) => d.id))
const DEFAULT_ID = defaultAdminChannelDescriptors[0]?.id ?? ''

function loadActive(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v && VALID_IDS.has(v)) return v
  } catch { /* ignore */ }
  return DEFAULT_ID
}

interface ChannelStore {
  active: string
  setActive(id: string): void
}

export const useChannelStore = create<ChannelStore>((set) => ({
  active: loadActive(),
  setActive(active: string) {
    if (!VALID_IDS.has(active)) return
    try { localStorage.setItem(STORAGE_KEY, active) } catch { /* ignore */ }
    set({ active })
  },
}))
