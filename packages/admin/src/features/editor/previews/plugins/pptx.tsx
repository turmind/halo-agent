'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const pptxPlugin: PreviewPlugin = {
  id: 'pptx',
  extensions: ['pptx', 'ppt'],
  Component: lazy(() => import('./pptx-view').then((m) => ({ default: m.PptxPreview }))),
  heavy: true, // active-only mount, no MRU caching
}
