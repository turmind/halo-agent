'use client'

import { useI18n, type Lang } from './context'

const LANGUAGES: { value: Lang; label: string }[] = [
  { value: 'en', label: 'EN' },
  { value: 'zh', label: '中' },
]

export function LangSwitcher({ className }: { className?: string }) {
  const { lang, setLang } = useI18n()

  return (
    <select
      value={lang}
      onChange={(e) => setLang(e.target.value as Lang)}
      className={`px-1 py-0.5 text-xs rounded border border-[var(--border)] bg-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--foreground)] transition-colors cursor-pointer ${className ?? ''}`}
    >
      {LANGUAGES.map((l) => (
        <option key={l.value} value={l.value}>{l.label}</option>
      ))}
    </select>
  )
}
