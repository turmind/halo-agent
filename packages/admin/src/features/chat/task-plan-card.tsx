'use client'

import { useState, useCallback } from 'react'
import type { TaskPlan, TaskNode, TaskNodeStatus } from '@/shared/types'
import { wsClient } from '@/shared/ws-client'
import { cn } from '@/shared/utils'
import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  SkipForward,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react'

interface TaskPlanCardProps {
  plan: TaskPlan
}

const statusConfig: Record<
  TaskNodeStatus,
  { icon: typeof Circle; color: string; label: string }
> = {
  pending: { icon: Circle, color: 'text-[var(--muted-foreground)]', label: 'Pending' },
  running: { icon: Loader2, color: 'text-blue-400', label: 'Running' },
  completed: { icon: CheckCircle2, color: 'text-emerald-400', label: 'Done' },
  failed: { icon: XCircle, color: 'text-red-400', label: 'Failed' },
  skipped: { icon: SkipForward, color: 'text-[var(--muted-foreground)]', label: 'Skipped' },
}

export function TaskPlanCard({ plan }: TaskPlanCardProps) {
  const [expanded, setExpanded] = useState(true)
  const [showReject, setShowReject] = useState(false)
  const [feedback, setFeedback] = useState('')

  const isPendingApproval = plan.status === 'pending_approval'
  const completedCount = plan.tasks.filter((t) => t.status === 'completed').length
  const totalCount = plan.tasks.length

  const handleApprove = useCallback(() => {
    wsClient.send({ type: 'approve', planId: plan.id })
  }, [plan.id])

  const handleReject = useCallback(() => {
    if (!feedback.trim()) return
    wsClient.send({ type: 'reject', planId: plan.id, feedback: feedback.trim() })
    setShowReject(false)
    setFeedback('')
  }, [plan.id, feedback])

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-[var(--secondary)]"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-[var(--muted-foreground)]" />
          ) : (
            <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)]" />
          )}
          <span className="text-sm font-medium text-[var(--foreground)]">
            Task Plan
          </span>
          <span className="text-xs text-[var(--muted-foreground)]">
            ({completedCount}/{totalCount})
          </span>
        </div>
        <PlanStatusBadge status={plan.status} />
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)]">
          {/* Description */}
          <div className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
            {plan.description}
          </div>

          {/* Task list */}
          <div className="px-3 pb-2">
            {plan.tasks.map((task) => (
              <TaskRow key={task.id} task={task} allTasks={plan.tasks} />
            ))}
          </div>

          {/* Approval buttons */}
          {isPendingApproval && (
            <div className="border-t border-[var(--border)] px-3 py-2.5">
              {!showReject ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleApprove}
                    className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
                  >
                    <ThumbsUp className="h-3.5 w-3.5" />
                    Approve
                  </button>
                  <button
                    onClick={() => setShowReject(true)}
                    className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-3 py-1.5 text-xs font-medium text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--accent)]"
                  >
                    <ThumbsDown className="h-3.5 w-3.5" />
                    Reject
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Explain what should be changed..."
                    rows={2}
                    className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2.5 py-1.5 text-xs text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleReject}
                      disabled={!feedback.trim()}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                        feedback.trim()
                          ? 'bg-[var(--destructive)] text-white hover:bg-red-500'
                          : 'bg-[var(--secondary)] text-[var(--muted-foreground)] cursor-not-allowed',
                      )}
                    >
                      Send Feedback
                    </button>
                    <button
                      onClick={() => {
                        setShowReject(false)
                        setFeedback('')
                      }}
                      className="rounded-md px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TaskRow({ task, allTasks }: { task: TaskNode; allTasks: TaskNode[] }) {
  const config = statusConfig[task.status]
  const Icon = config.icon
  const deps = task.dependencies
    .map((depId) => allTasks.find((t) => t.id === depId)?.name)
    .filter(Boolean)

  return (
    <div className="flex items-start gap-2 py-1.5">
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          config.color,
          task.status === 'running' && 'animate-spin',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--foreground)]">
            {task.name}
          </span>
          {task.agentId && (
            <span className="rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
              {task.agentId}
            </span>
          )}
        </div>
        {task.description && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
            {task.description}
          </p>
        )}
        {deps.length > 0 && (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]">
            <ArrowRight className="h-3 w-3" />
            <span>after: {deps.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function PlanStatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    pending_approval: 'bg-amber-900/50 text-amber-300 border-amber-700',
    approved: 'bg-blue-900/50 text-blue-300 border-blue-700',
    running: 'bg-blue-900/50 text-blue-300 border-blue-700',
    completed: 'bg-emerald-900/50 text-emerald-300 border-emerald-700',
    failed: 'bg-red-900/50 text-red-300 border-red-700',
    rejected: 'bg-[var(--secondary)] text-[var(--muted-foreground)] border-[var(--border)]',
  }

  const labels: Record<string, string> = {
    pending_approval: 'Needs Approval',
    approved: 'Approved',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    rejected: 'Rejected',
  }

  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium',
        variants[status] ?? 'bg-[var(--secondary)] text-[var(--muted-foreground)] border-[var(--border)]',
      )}
    >
      {labels[status] ?? status}
    </span>
  )
}
