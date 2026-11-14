/**
 * "Open Settings at section X" from anywhere in the admin (the extension
 * hosts' backend-pending notice → Settings → Extensions). Settings may or may
 * not be mounted: the section event reaches a mounted SettingsMain, which
 * takes the request; otherwise it stays pending and SettingsMain's first
 * render takes it. Then `halo:navigate` switches the activity tab.
 */
export const SETTINGS_SECTION_EVENT = 'halo:settings-section'

let pending: string | null = null

export function openSettingsSection(ns: string): void {
  pending = ns
  window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_EVENT))
  window.dispatchEvent(new CustomEvent('halo:navigate', { detail: { tab: 'settings' } }))
}

/** The requested section, once (null when none is pending). */
export function takeSettingsSection(): string | null {
  const ns = pending
  pending = null
  return ns
}
