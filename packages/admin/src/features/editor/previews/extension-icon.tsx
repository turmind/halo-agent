'use client'

import { useEffect, useState } from 'react'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/shared/utils'
import { extensionEntryUrl, getExtensionToken } from './extension-token'

/**
 * An extension's manifest icon (`activity.icon` / `chatbar.icon`) as a CSS
 * mask over `currentColor`, so it follows the button's active / hover colour
 * and every theme like the lucide icons do — and the SVG never enters the DOM.
 * `fallback` until the asset token is in, and when the manifest names no icon.
 */
export function ExtensionMaskIcon({ info, icon, fallback: Fallback, className }: {
  info: ExtensionInfo
  icon: string | undefined
  fallback: LucideIcon
  className: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!icon) return
    let cancelled = false
    getExtensionToken()
      .then((token) => { if (!cancelled) setUrl(extensionEntryUrl(info.id, info.version, token, icon)) })
      .catch(() => { /* no token — keep the fallback icon */ })
    return () => { cancelled = true; setUrl(null) }
  }, [info.id, info.version, icon])
  if (!icon || !url) return <Fallback className={className} />
  const mask = `url(${JSON.stringify(url)}) center / contain no-repeat`
  return <span aria-hidden className={cn('block bg-current', className)} style={{ mask, WebkitMask: mask }} />
}
