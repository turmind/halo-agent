'use client'

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { api } from '@/shared/api-client'

const THEMES = ['dark', 'light', 'midnight', 'warm'] as const
export type Theme = (typeof THEMES)[number]

function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v)
}

/** Stamp the theme onto <html> so globals.css's [data-theme="…"] variable
 *  sets take effect. Mirrors the pre-paint inline script in layout.tsx —
 *  dark is the :root default, so the attribute is dropped rather than set. */
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  if (theme === 'dark') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

const ThemeContext = createContext<{
  theme: Theme
  setTheme: (theme: Theme) => void
  /** Re-fetch `general.theme` from server. Call this after any settings
   *  save that *might* have changed the theme (the settings page calls it
   *  on every save — cheap enough). */
  refreshFromServer: () => Promise<void>
}>({
  theme: 'dark',
  setTheme: () => {},
  refreshFromServer: async () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

/**
 * Initial-paint detection: fall back to the localStorage cache because the
 * server setting needs auth. The layout.tsx inline script already stamped
 * data-theme from the same key before first paint; this just brings React
 * state in line. Once authenticated the provider re-fetches `general.theme`
 * and overwrites the cache.
 */
function detectInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const stored = localStorage.getItem('halo_theme')
  return isTheme(stored) ? stored : 'dark'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark')

  // Initial mount: localStorage cache so the login page renders in the right
  // theme before auth. applyTheme is normally a no-op here (the layout.tsx
  // script already stamped the attribute pre-paint) but keeps the invariant
  // "DOM attribute == provider state" true on every state-change path.
  useEffect(() => {
    const initial = detectInitialTheme()
    setThemeState(initial)
    applyTheme(initial)
  }, [])

  // Server pull: re-read `general.theme` and update local state. Used both
  // on initial auth (effect below) and on demand (settings page calls
  // refreshFromServer() after any save).
  const refreshFromServer = useCallback(async () => {
    try {
      const schema = await api.settings.getSchema()
      const generalSection = schema.sections.find((s) => s.namespaceId === 'general')
      const themeField = generalSection?.fields.find((f) => f.key === 'theme')
      const value = themeField?.value ?? themeField?.default ?? null
      const next = isTheme(value) ? value : 'dark'
      setThemeState(next)
      applyTheme(next)
      if (typeof window !== 'undefined') {
        localStorage.setItem('halo_theme', next)
      }
    } catch {
      // Probably unauthenticated — leave the localStorage-driven value in
      // place; the next refreshFromServer call (settings save, page reload)
      // will pick up the canonical value.
    }
  }, [])

  // After auth (or whenever we can talk to the server), pull the canonical
  // value once. Server stays the source of truth; localStorage is just a
  // pre-auth cache.
  useEffect(() => {
    void refreshFromServer()
  }, [refreshFromServer])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    applyTheme(t)
    if (typeof window !== 'undefined') {
      localStorage.setItem('halo_theme', t)
    }
    // Persist to server. Best-effort: if we're not authenticated yet, this
    // 401s and we just hold the local change until next auth-refresh.
    void api.settings.patch('global', 'general.theme', t).catch(() => {})
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, refreshFromServer }}>
      {children}
    </ThemeContext.Provider>
  )
}
