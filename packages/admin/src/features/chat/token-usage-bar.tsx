'use client'

import { useMemo } from 'react'
import { useChatStore } from './chat-store'
import { cn } from '@/shared/utils'

const MAX_TOKENS = 200_000

export function TokenUsageBar() {
  const messages = useChatStore((s) => s.messages)

  const estimated = useMemo(() => {
    let total = 0
    for (const msg of messages) {
      // Rough estimate: ~4 chars per token
      total += Math.ceil(msg.content.length / 4)
    }
    return total
  }, [messages])

  if (estimated === 0) return null

  const pct = Math.min((estimated / MAX_TOKENS) * 100, 100)
  const kTokens = Math.round(estimated / 1000)
  const maxK = MAX_TOKENS / 1000

  const color =
    pct < 50
      ? 'bg-green-500'
      : pct < 70
        ? 'bg-yellow-500'
        : pct < 85
          ? 'bg-orange-500'
          : 'bg-red-500'

  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <div className="h-1.5 flex-1 rounded-full bg-[var(--secondary)]">
        <div
          className={cn('h-full rounded-full transition-all duration-300', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-[10px] text-[var(--muted-foreground)]">
        ~{kTokens}K / {maxK}K
      </span>
      {pct > 70 && (
        <span className="text-[10px] text-orange-500">
          /compact
        </span>
      )}
    </div>
  )
}
