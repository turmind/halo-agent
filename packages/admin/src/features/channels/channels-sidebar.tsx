'use client'

import { MessageCircle, RefreshCw } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { bumpChannelBus } from '@/shared/channel-bus'
import { useChannelStore } from './channel-store'
import { defaultAdminChannelDescriptors } from './descriptors'

export function ChannelsSidebar() {
  const t = useT()
  const active = useChannelStore((s) => s.active)
  const setActive = useChannelStore((s) => s.setActive)

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 items-center gap-2 border-b border-[var(--border)] px-3">
        <MessageCircle className="h-4 w-4 text-[var(--muted-foreground)]" />
        <span className="text-sm font-medium text-[var(--foreground)]">Channels</span>
        <div className="flex-1" />
        <button
          onClick={() => bumpChannelBus()}
          title="Refresh"
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {defaultAdminChannelDescriptors.map((c) => {
          if (c.enabled === false) return null
          const Icon = c.Icon
          // Translate when the descriptor's label is an i18n key; if t()
          // returns the key unchanged (no entry in the dict), fall back to
          // the literal — that's how brand names like "Telegram" get to
          // render without needing a translation entry.
          const translated = t(c.label)
          const label = translated === c.label ? c.label : translated
          return (
            <button
              key={c.id}
              onClick={() => setActive(c.id)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-xs transition-colors',
                active === c.id
                  ? 'bg-[var(--secondary)] text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/50 hover:text-[var(--foreground)]',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
