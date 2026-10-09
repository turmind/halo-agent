'use client'

import { cn } from '@/shared/utils'

/** Title + one-line description to the right of an activity-bar icon. Always
 *  rendered; the rail's 48px clips it to nothing, and it fades in as the hover
 *  drawer widens. */
export function ActivityBarLabel({ expanded, title, desc }: { expanded: boolean; title: string; desc: string }) {
  return (
    <span className={cn(
      'min-w-0 flex-1 whitespace-nowrap pr-3 text-left transition-opacity duration-150 ease-out motion-reduce:transition-none',
      expanded ? 'opacity-100' : 'opacity-0',
    )}>
      <span className="block truncate text-sm leading-5 text-[var(--foreground)]">{title}</span>
      <span className="block truncate text-[11px] leading-4 text-[var(--muted-foreground)]">{desc}</span>
    </span>
  )
}
