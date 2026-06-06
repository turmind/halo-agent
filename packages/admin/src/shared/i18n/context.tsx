'use client'

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { api } from '@/shared/api-client'

export type Lang = 'en' | 'zh'
/** BCP-47 region tag stored in `general.language` settings.yaml. The server
 *  also accepts and emits this shape; it's collapsed to `Lang` for UI
 *  rendering by `bcpToLang`. */
export type LangBcp = 'en-US' | 'zh-CN'

type Translations = Record<string, string>

function bcpToLang(bcp: string | null | undefined): Lang {
  if (typeof bcp === 'string' && bcp.toLowerCase().startsWith('zh')) return 'zh'
  return 'en'
}

function langToBcp(l: Lang): LangBcp {
  return l === 'zh' ? 'zh-CN' : 'en-US'
}

const I18nContext = createContext<{
  lang: Lang
  bcp: LangBcp
  t: (key: string, params?: Record<string, string | number>) => string
  setLang: (lang: Lang) => void
  /** Re-fetch `general.language` from server. Call this after any
   *  settings save that *might* have changed the language (the settings
   *  page calls it on every save — cheap enough). */
  refreshFromServer: () => Promise<void>
}>({
  lang: 'en',
  bcp: 'en-US',
  t: (key) => key,
  setLang: () => {},
  refreshFromServer: async () => {},
})

export function useI18n() {
  return useContext(I18nContext)
}

export function useT() {
  return useContext(I18nContext).t
}

/**
 * Initial-paint detection: fall back to localStorage cache + browser locale
 * because the server setting needs auth. Once the app is authenticated the
 * provider re-fetches `general.language` and overwrites the cache.
 */
function detectInitialLang(): Lang {
  if (typeof window === 'undefined') return 'en'
  const stored = localStorage.getItem('halo_lang')
  if (stored === 'zh' || stored === 'en') return stored
  return navigator.language.startsWith('zh') ? 'zh' : 'en'
}

export function I18nProvider({ en, zh, children }: { en: Translations; zh: Translations; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en')

  // Initial mount: localStorage / browser-locale cache so login page renders
  // in the right language before auth.
  useEffect(() => {
    setLangState(detectInitialLang())
  }, [])

  // Server pull: re-read `general.language` and update local state. Used
  // both on initial auth (effect below) and on demand (settings page calls
  // refreshFromServer() after any save).
  const refreshFromServer = useCallback(async () => {
    try {
      const schema = await api.settings.getSchema()
      const generalSection = schema.sections.find((s) => s.namespaceId === 'general')
      const langField = generalSection?.fields.find((f) => f.key === 'language')
      const value = langField?.value ?? langField?.default ?? null
      const next = bcpToLang(value)
      setLangState(next)
      if (typeof window !== 'undefined') {
        localStorage.setItem('halo_lang', next)
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

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    if (typeof window !== 'undefined') {
      localStorage.setItem('halo_lang', l)
    }
    // Persist to server. Best-effort: if we're not authenticated yet, this
    // 401s and we just hold the local change until next auth-refresh.
    void api.settings.patch('global', 'general.language', langToBcp(l)).catch(() => {})
  }, [])

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const dict = lang === 'zh' ? zh : en
    let text = dict[key] ?? en[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v))
      }
    }
    return text
  }, [lang, en, zh])

  return (
    <I18nContext.Provider value={{ lang, bcp: langToBcp(lang), t, setLang, refreshFromServer }}>
      {children}
    </I18nContext.Provider>
  )
}
