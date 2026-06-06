'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const docxPlugin: PreviewPlugin = {
  id: 'docx',
  extensions: ['docx', 'doc'],
  Component: lazy(() => import('./docx-view').then((m) => ({ default: m.DocxPreview }))),
}
