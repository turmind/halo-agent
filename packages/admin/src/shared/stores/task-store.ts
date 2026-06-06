import { create } from 'zustand'
import type { TaskPlan, TaskNodeStatus, AgentInfo, AgentState, AgentConfig } from '@/shared/types'

interface TaskStore {
  activePlan: TaskPlan | null
  agents: AgentInfo[]
  agentConfigs: AgentConfig[]

  setActivePlan(plan: TaskPlan | null): void
  updateTaskStatus(taskId: string, status: TaskNodeStatus): void
  setAgents(agents: AgentInfo[]): void
  updateAgentState(agentId: string, state: AgentState): void
  setAgentConfigs(configs: AgentConfig[]): void
  clearPlan(): void
}

export const useTaskStore = create<TaskStore>((set) => ({
  activePlan: null,
  agents: [],
  agentConfigs: [],

  setActivePlan(plan: TaskPlan | null) {
    set({ activePlan: plan })
  },

  updateTaskStatus(taskId: string, status: TaskNodeStatus) {
    set((state) => {
      if (!state.activePlan) return state
      const tasks = state.activePlan.tasks.map((t) =>
        t.id === taskId ? { ...t, status } : t,
      )
      return {
        activePlan: { ...state.activePlan, tasks },
      }
    })
  },

  setAgents(agents: AgentInfo[]) {
    set({ agents })
  },

  updateAgentState(agentId: string, state: AgentState) {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.agentId === agentId ? { ...a, state } : a,
      ),
    }))
  },

  setAgentConfigs(configs: AgentConfig[]) {
    set({ agentConfigs: configs })
  },

  clearPlan() {
    set({ activePlan: null })
  },
}))
