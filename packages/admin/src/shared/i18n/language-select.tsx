'use client'

import { useT } from './context'
import type { Lang } from './context'

export function LanguageSelect({ value, onChange }: { value: Lang; onChange: (lang: Lang) => void }) {
  const t = useT()
  return (
    <div>
      <label className="text-[10px] text-[var(--muted-foreground)]">{t('common.language')}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Lang)}
        className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs"
      >
        <option value="en">English</option>
        <option value="zh">中文</option>
      </select>
    </div>
  )
}
