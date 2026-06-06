'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const pdfPlugin: PreviewPlugin = {
  id: 'pdf',
  extensions: ['pdf'],
  Component: lazy(() => import('./pdf-view').then((m) => ({ default: m.PdfPreview }))),
}
