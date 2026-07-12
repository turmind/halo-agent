import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGoalStore, refreshGoal, type GoalInfo } from '../src/features/chat/goal-store'
import { useProjectStore } from '../src/shared/stores/project-store'
import { api } from '../src/shared/api-client'

/**
 * Contract: dismissing a terminal goal banner survives a page refresh —
 * `dismiss` persists the goal id to a project-scoped localStorage key, and
 * `refreshGoal` (the mount / project-switch seed path) restores it. A new
 * goal (different id) is never suppressed by a stale dismissal.
 */

const PROJECT = '/ws/alpha'
const OTHER_PROJECT = '/ws/beta'

function goalInfo(id: string, status: GoalInfo['status'] = 'done'): GoalInfo {
  return { goalSessionId: id, workerSessionId: `${id}_w`, status, round: 3, maxRounds: 10 }
}

beforeEach(() => {
  localStorage.clear()
  useGoalStore.setState({ goal: null, dismissedGoalId: null })
  useProjectStore.getState().openFolder(PROJECT)
})

describe('goal banner dismiss persistence', () => {
  it('dismiss writes the project-scoped localStorage key', () => {
    useGoalStore.getState().dismiss('goal_1')
    expect(useGoalStore.getState().dismissedGoalId).toBe('goal_1')
    expect(localStorage.getItem(`halo_goal_dismissed_${PROJECT}`)).toBe('goal_1')
  })

  it('refreshGoal restores the dismissal after a simulated refresh', async () => {
    useGoalStore.getState().dismiss('goal_1')
    // Simulated refresh: in-memory store resets, localStorage survives.
    useGoalStore.setState({ goal: null, dismissedGoalId: null })

    vi.spyOn(api.sessionLogs, 'goal').mockResolvedValue({ goal: goalInfo('goal_1') })
    await refreshGoal(PROJECT)

    const s = useGoalStore.getState()
    expect(s.goal?.goalSessionId).toBe('goal_1')
    expect(s.dismissedGoalId).toBe('goal_1') // banner stays hidden
  })

  it('a new goal round is not suppressed by a stale dismissal', async () => {
    useGoalStore.getState().dismiss('goal_1')
    useGoalStore.setState({ goal: null, dismissedGoalId: null })

    vi.spyOn(api.sessionLogs, 'goal').mockResolvedValue({ goal: goalInfo('goal_2', 'running') })
    await refreshGoal(PROJECT)

    const s = useGoalStore.getState()
    expect(s.goal?.goalSessionId).toBe('goal_2')
    // Restored dismissal points at the old goal — banner shows (ids differ).
    expect(s.dismissedGoalId).not.toBe(s.goal?.goalSessionId)
  })

  it('dismissals are scoped per project — switching projects does not leak', async () => {
    useGoalStore.getState().dismiss('goal_1')

    vi.spyOn(api.sessionLogs, 'goal').mockResolvedValue({ goal: null })
    await refreshGoal(OTHER_PROJECT)

    expect(useGoalStore.getState().dismissedGoalId).toBeNull()
    // Original project's dismissal is still on disk.
    expect(localStorage.getItem(`halo_goal_dismissed_${PROJECT}`)).toBe('goal_1')
  })
})
