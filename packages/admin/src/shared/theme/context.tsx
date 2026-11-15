'use client'

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { api } from '@/shared/api-client'

const THEMES = ['dark', 'light', 'midnight', 'warm'] as const
export type Theme = (typeof THEMES)[number]

/** Shape / spacing / type layer, orthogonal to the color theme. */
const UI_STYLES = ['classic', 'soft', 'modern'] as const
type UiStyle = (typeof UI_STYLES)[number]

function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v)
}

function isUiStyle(v: unknown): v is UiStyle {
  return typeof v === 'string' && (UI_STYLES as readonly string[]).includes(v)
}

/** Stamp the theme onto <html> so globals.css's [data-theme="…"] variable
 *  sets take effect. Mirrors the pre-paint inline script in layout.tsx —
 *  dark is the :root default, so the attribute is dropped rather than set. */
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  if (theme === 'dark') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

/** Same scheme for <html data-ui-style>: classic is the unstyled default, so
 *  the attribute is dropped and the classic DOM stays byte-identical. */
function applyUiStyle(style: UiStyle) {
  if (typeof document === 'undefined') return
  if (style === 'classic') delete document.documentElement.dataset.uiStyle
  else document.documentElement.dataset.uiStyle = style
}

const ThemeContext = createContext<{
  theme: Theme
  setTheme: (theme: Theme) => void
  /** Re-fetch `general.theme` + `general.ui_style` from server. Call this
   *  after any settings save that *might* have changed them (the settings
   *  page calls it on every save — cheap enough). */
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
 * data-theme / data-ui-style from the same keys before first paint; this just
 * brings React state in line. Once authenticated the provider re-fetches
 * `general.theme` / `general.ui_style` and overwrites the cache.
 */
function detectInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const stored = localStorage.getItem('halo_theme')
  return isTheme(stored) ? stored : 'dark'
}

function detectInitialUiStyle(): UiStyle {
  if (typeof window === 'undefined') return 'classic'
  const stored = localStorage.getItem('halo_ui_style')
  return isUiStyle(stored) ? stored : 'classic'
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
    applyUiStyle(detectInitialUiStyle())
  }, [])

  // Server pull: re-read `general.theme` / `general.ui_style` and update local
  // state. Used both on initial auth (effect below) and on demand (settings
  // page calls refreshFromServer() after any save).
  const refreshFromServer = useCallback(async () => {
    try {
      const schema = await api.settings.getSchema()
      const generalSection = schema.sections.find((s) => s.namespaceId === 'general')
      const valueOf = (key: string) => {
        const field = generalSection?.fields.find((f) => f.key === key)
        return field?.value ?? field?.default ?? null
      }
      const value = valueOf('theme')
      const next = isTheme(value) ? value : 'dark'
      setThemeState(next)
      applyTheme(next)
      const styleValue = valueOf('ui_style')
      const nextStyle = isUiStyle(styleValue) ? styleValue : 'classic'
      applyUiStyle(nextStyle)
      if (typeof window !== 'undefined') {
        localStorage.setItem('halo_theme', next)
        localStorage.setItem('halo_ui_style', nextStyle)
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
