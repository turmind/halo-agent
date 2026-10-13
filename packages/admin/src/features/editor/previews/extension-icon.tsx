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
 * `fallback` when the manifest names no icon (or the token request fails);
 * while the token is in flight a blank box of the same size holds the slot,
 * so the generic icon never flashes before the extension's own.
 */
export function ExtensionMaskIcon({ info, icon, fallback: Fallback, className }: {
  info: ExtensionInfo
  icon: string | undefined
  fallback: LucideIcon
  className: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!icon) return
    let cancelled = false
    getExtensionToken()
      .then((token) => { if (!cancelled) setUrl(extensionEntryUrl(info.id, info.version, token, icon)) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; setUrl(null); setFailed(false) }
  }, [info.id, info.version, icon])
  if (!icon || failed) return <Fallback className={className} />
  if (!url) return <span aria-hidden className={cn('block', className)} />
  const mask = `url(${JSON.stringify(url)}) center / contain no-repeat`
  return <span aria-hidden className={cn('block bg-current', className)} style={{ mask, WebkitMask: mask }} />
}
