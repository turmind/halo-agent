'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']
export const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv']
export const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'wma']

export const mediaPlugin: PreviewPlugin = {
  id: 'media',
  extensions: [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS],
  Component: lazy(() => import('./media-view').then((m) => ({ default: m.MediaPreview }))),
}
