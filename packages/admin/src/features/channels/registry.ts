/**
 * Admin-side channel registry.
 *
 * Each entry pairs a channel id (the slug used by the URL store /
 * localStorage) with its sidebar entry (label, icon) and its settings
 * panel component. The sidebar maps over the list to render itself; the
 * main pane looks up by id to render the active channel's settings.
 *
 * Adding a new channel = create a `descriptor.ts` next to its settings
 * component + add one entry to the default list. No edits to
 * channels-main.tsx, channels-sidebar.tsx, or channel-store.ts.
 */
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface AdminChannelDescriptor {
  /** Slug. Persisted to localStorage; must be stable across releases. */
  id: string
  /** i18n key for the sidebar label, OR a literal label that doesn't
   *  need translation (brand names like "Telegram"). The sidebar
   *  resolves the key via `useT()` if it exists in the dict, falling
   *  back to the literal string. */
  label: string
  /** Sidebar icon. */
  Icon: LucideIcon
  /** Settings panel rendered in the main pane when this channel is
   *  active. Must be a no-prop component (descriptors are static). */
  Component: ComponentType
  /** Extra disabled flag — for hiding entries that shipped but aren't
   *  generally available yet. Defaults to enabled. */
  enabled?: boolean
}
