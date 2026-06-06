'use client'

import type { ReactNode } from 'react'
import { I18nProvider } from './context'
import { en } from './en'
import { zh } from './zh'

export function AppI18nProvider({ children }: { children: ReactNode }) {
  return (
    <I18nProvider en={en} zh={zh}>
      {children}
    </I18nProvider>
  )
}
