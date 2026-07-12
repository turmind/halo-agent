'use client'

import { X } from 'lucide-react'
import { useGoalStore, type GoalStatus } from './goal-store'
import { useT } from '@/shared/i18n'
import { cn } from '@/shared/utils'

const STATUS_STYLE: Record<GoalStatus, string> = {
  intake: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  running: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  paused: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  halted: 'border-red-500/30 bg-red-500/10 text-red-400',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
}

/**
 * Workspace-level goal-mode strip above the composer (goals are serialized
 * per workspace, so one banner represents "the" goal). Live via the
 * `goal:changed` WS push → refreshGoal; seeded on mount / project switch so
 * it survives a page refresh. The label click jumps to the goal session G,
 * the "Worker →" button jumps to the worker session W; terminal states
 * (done / halted) are dismissible — active ones are not, the lock they
 * explain is still in force.
 */
export function GoalBanner({ currentSessionId, onJump }: {
  currentSessionId: string | null
  onJump: (sessionId: string) => void
}) {
  const goal = useGoalStore((s) => s.goal)
  const dismissedGoalId = useGoalStore((s) => s.dismissedGoalId)
  const dismiss = useGoalStore((s) => s.dismiss)
  const t = useT()

  if (!goal) return null
  const terminal = goal.status === 'done' || goal.status === 'halted'
  if (terminal && dismissedGoalId === goal.goalSessionId) return null

  const label = t(`goal.banner.${goal.status}`, { round: goal.round, max: goal.maxRounds })
  const onGoal = currentSessionId === goal.goalSessionId
  const onWorker = currentSessionId === goal.workerSessionId

  return (
    <div className={cn(
      'flex items-center gap-2 border-t px-3 py-1.5 text-[11px]',
      STATUS_STYLE[goal.status],
    )}>
      <button
        onClick={() => !onGoal && onJump(goal.goalSessionId)}
        title={onGoal ? undefined : t('goal.banner.jump')}
        className={cn('min-w-0 flex-1 truncate text-left', !onGoal && 'hover:underline cursor-pointer')}
      >
        {label}
      </button>
      <button
        onClick={() => !onWorker && onJump(goal.workerSessionId)}
        title={onWorker ? undefined : t('goal.banner.jump_worker')}
        className={cn('shrink-0', !onWorker && 'hover:underline cursor-pointer')}
      >
        {t('goal.banner.worker')}
      </button>
      {terminal && (
        <button
          onClick={() => dismiss(goal.goalSessionId)}
          title={t('goal.banner.dismiss')}
          className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
