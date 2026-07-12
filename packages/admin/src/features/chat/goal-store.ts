'use client'

import { create } from 'zustand'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'

/** `cleared` never reaches the store — the seed endpoint returns null for it
 *  and the WS poke re-fetches through the same endpoint. */
export type GoalStatus = 'intake' | 'running' | 'paused' | 'halted' | 'done'

export interface GoalInfo {
  goalSessionId: string
  workerSessionId: string
  status: GoalStatus
  round: number
  maxRounds: number
}

/** localStorage key for the dismissed goal id, scoped per project (same
 *  pattern as use-chat's `halo_session_${projectId}`). */
function dismissKey(projectId: string): string {
  return `halo_goal_dismissed_${projectId}`
}

interface GoalStore {
  goal: GoalInfo | null
  /** Terminal-state (done/halted) banner dismissed for this goal id.
   *  Persisted per project in localStorage — the seed endpoint keeps
   *  returning terminal goals until the next goal replaces them, so a
   *  refresh would otherwise resurrect the banner. Single value by design:
   *  a new goal has a different id and is never suppressed by a stale
   *  dismissal. */
  dismissedGoalId: string | null
  setGoal(goal: GoalInfo | null): void
  dismiss(goalId: string): void
}

export const useGoalStore = create<GoalStore>((set) => ({
  goal: null,
  dismissedGoalId: null,
  setGoal: (goal) => set({ goal }),
  dismiss: (goalId) => {
    set({ dismissedGoalId: goalId })
    const projectId = useProjectStore.getState().activeProject?.path
    if (projectId && typeof window !== 'undefined') {
      localStorage.setItem(dismissKey(projectId), goalId)
    }
  },
}))

/** Seed / refresh the goal state from the server. Called on mount + project
 *  switch (so the banner survives a page refresh) and poked by the
 *  `goal:changed` WS push — the push is global (no workspace marker), so
 *  re-fetching under the active project naturally filters cross-workspace
 *  events: a goal event from another workspace resolves to this workspace's
 *  own (unchanged) state. */
export async function refreshGoal(projectId: string): Promise<void> {
  // Re-seed the per-project dismiss state alongside the goal itself so a
  // page refresh / project switch restores both consistently.
  const dismissed = typeof window !== 'undefined'
    ? localStorage.getItem(dismissKey(projectId))
    : null
  useGoalStore.setState({ dismissedGoalId: dismissed })
  try {
    const res = await api.sessionLogs.goal(projectId)
    useGoalStore.getState().setGoal((res.goal as GoalInfo | null) ?? null)
  } catch {
    // Unauthenticated / server unreachable — leave current state; the next
    // poke or project switch retries.
  }
}
