'use client'

import { cn } from '@/shared/utils'

/** Run-status pill shared by the Evolution sidebar list and detail pane. */
export function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'bg-[var(--accent)] text-[var(--foreground)]'
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', cls)}>
      {status.replace('_', ' ')}
    </span>
  )
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-[var(--accent)] text-[var(--foreground)]',
  running: 'bg-blue-700 text-blue-100',
  awaiting_review: 'bg-amber-600 text-amber-50',
  approved: 'bg-emerald-700 text-emerald-50',
  applied: 'bg-emerald-800 text-emerald-100',
  // skipped = evo decided no patch worth proposing. Terminal but
  // benign — neutral grey so it doesn't compete with awaiting_review.
  skipped: 'bg-[var(--accent)] text-[var(--foreground)]',
  rejected: 'bg-red-700 text-red-50',
  failed: 'bg-red-800 text-red-100',
  timeout: 'bg-orange-700 text-orange-100',
}
