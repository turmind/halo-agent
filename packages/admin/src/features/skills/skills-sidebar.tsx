'use client'

import { useState, useEffect } from 'react'
import { create } from 'zustand'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { useSkillBus, bumpSkillBus } from '@/shared/skill-bus'
import { wsClient } from '@/shared/ws-client'
import { cn, promptInput, confirmAction } from '@/shared/utils'
import type { Skill } from '@/shared/types'
import { Zap, Plus, Trash2, Globe, FolderOpen, ChevronRight, ToggleLeft, ToggleRight, RefreshCw } from 'lucide-react'
import { useT } from '@/shared/i18n'

/** Composite key for unique skill selection (handles same id in different scopes) */
function skillKey(s: { id: string; scope: string }): string {
  return `${s.id}:${s.scope}`
}

interface SkillStore {
  skills: Skill[]
  selectedKey: string | null
  setSkills: (skills: Skill[]) => void
  setSelectedKey: (key: string | null) => void
  addSkill: (skill: Skill) => void
  removeSkill: (key: string) => void
}

const SKILL_SELECTED_KEY = 'halo_skills_selectedKey'
const SKILL_EXPANDED_KEY = 'halo_skills_expandedScopes'

function loadExpandedScopes(): Set<string> {
  if (typeof window === 'undefined') return new Set(['global', 'workspace'])
  try {
    const raw = localStorage.getItem(SKILL_EXPANDED_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {}
  return new Set(['global', 'workspace'])
}

export const useSkillStore = create<SkillStore>((set) => ({
  skills: [],
  selectedKey: typeof window !== 'undefined' ? localStorage.getItem(SKILL_SELECTED_KEY) : null,
  setSkills: (skills) => set({ skills }),
  setSelectedKey: (selectedKey) => {
    if (typeof window !== 'undefined') {
      if (selectedKey) localStorage.setItem(SKILL_SELECTED_KEY, selectedKey)
      else localStorage.removeItem(SKILL_SELECTED_KEY)
    }
    set({ selectedKey })
  },
  addSkill: (skill) => set((s) => ({ skills: [...s.skills, skill] })),
  removeSkill: (key) =>
    set((s) => {
      const remaining = s.skills.filter((sk) => skillKey(sk) !== key)
      // If deleting a workspace skill, un-override its global counterpart
      const [id, scope] = key.split(':')
      const adjusted = scope === 'workspace'
        ? remaining.map((sk) => sk.id === id && sk.scope === 'global' ? { ...sk, overridden: false } : sk)
        : remaining
      const nextSelected = s.selectedKey === key ? null : s.selectedKey
      if (typeof window !== 'undefined' && s.selectedKey === key) localStorage.removeItem(SKILL_SELECTED_KEY)
      return { skills: adjusted, selectedKey: nextSelected }
    }),
}))

export function SkillsSidebar() {
  const t = useT()
  const { skills, selectedKey, setSkills, setSelectedKey, addSkill, removeSkill } = useSkillStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const projectId = activeProject?.path
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(loadExpandedScopes)
  const [refreshing, setRefreshing] = useState(false)
  const busVersion = useSkillBus((s) => s.version)

  useEffect(() => {
    localStorage.setItem(SKILL_EXPANDED_KEY, JSON.stringify([...expandedScopes]))
  }, [expandedScopes])

  // Fetch on mount, on project change, and whenever the skill bus bumps
  // (some other component mutated the list, or the WS file watcher saw a change).
  useEffect(() => {
    setRefreshing(true)
    api.skills
      .list(projectId)
      .then((res) => setSkills(res.skills as Skill[]))
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }, [projectId, busVersion, setSkills])

  // Watch the file system for external skill creations/deletions (e.g. agent
  // chat creating a SKILL.md). Any add/unlink inside .halo/skills/* bumps the
  // bus; the effect above re-fetches the list.
  //
  // Note: the server's file watcher only monitors the current workspace, so
  // this catches workspace-scope changes. Global skills (~/.halo/global/skills/)
  // are picked up opportunistically by the window-focus refresh below.
  useEffect(() => {
    if (!projectId) return
    const unsub = wsClient.on('file:changed', (data) => {
      const msg = data as { path: string; action: string }
      if (msg.action !== 'add' && msg.action !== 'unlink' && msg.action !== 'addDir' && msg.action !== 'unlinkDir') return
      if (!msg.path.startsWith('.halo/skills/')) return
      bumpSkillBus()
    })
    return unsub
  }, [projectId])

  // Refresh when the window regains focus — covers global skill changes that
  // the workspace-scoped file watcher can't see.
  useEffect(() => {
    const onFocus = () => bumpSkillBus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  function toggleScope(scope: string) {
    setExpandedScopes((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })
  }

  async function handleCreate(scope: 'global' | 'workspace') {
    if (scope === 'workspace' && !projectId) return
    const name = await promptInput(`New ${scope} skill name:`)
    if (!name?.trim()) return
    const generatedId = name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '')
    const otherScope = scope === 'workspace' ? 'global' : 'workspace'
    const conflict = skills.find((s) => s.id === generatedId && s.scope === otherScope)
    if (conflict) {
      const msg = scope === 'workspace'
        ? `Global skill "${conflict.name}" has the same ID.\nWorkspace version will override it at runtime.\n\nContinue?`
        : `Workspace skill "${conflict.name}" has the same ID.\nIt will override this global skill in that project.\n\nContinue?`
      if (!(await confirmAction(msg))) return
    }
    try {
      const res = await api.skills.create({
        name: name.trim(),
        scope,
        projectId: scope === 'workspace' ? projectId : undefined,
      })
      const skill = res.skill as Skill
      // If we just added a workspace skill that shadows a global one, mark the global as overridden
      if (scope === 'workspace' && conflict) {
        setSkills(skills.map((s) => s.id === skill.id && s.scope === 'global' ? { ...s, overridden: true } : s).concat(skill))
      } else {
        addSkill(skill)
      }
      setExpandedScopes((prev) => new Set(prev).add(scope))
      setSelectedKey(skillKey(skill))
      bumpSkillBus()
    } catch (err) {
      console.error('[SkillsSidebar] Create failed:', err)
    }
  }

  async function handleDelete(e: React.MouseEvent, skill: Skill) {
    e.stopPropagation()
    if (!(await confirmAction(`Delete skill "${skill.name}"?`))) return
    try {
      await api.skills.remove(
        skill.id,
        skill.scope === 'workspace' ? { scope: 'workspace', projectId } : undefined,
      )
      removeSkill(skillKey(skill))
      bumpSkillBus()
    } catch (err) {
      console.error('[SkillsSidebar] Delete failed:', err)
    }
  }

  async function handleToggle(e: React.MouseEvent, skill: Skill) {
    e.stopPropagation()
    try {
      const res = await api.skills.toggle(
        skill.id,
        { scope: skill.scope, projectId },
      )
      setSkills(skills.map((s) =>
        skillKey(s) === skillKey(skill) ? { ...s, disabled: res.disabled } : s,
      ))
      bumpSkillBus()
    } catch (err) {
      console.error('[SkillsSidebar] Toggle failed:', err)
    }
  }

  const globalSkills = skills.filter((s) => s.scope === 'global')
  const workspaceSkills = skills.filter((s) => s.scope === 'workspace')

  const renderSection = (scope: 'global' | 'workspace', icon: React.ElementType, label: string, items: Skill[]) => {
    const Icon = icon
    const expanded = expandedScopes.has(scope)
    return (
      <div key={scope}>
        <div className="flex items-center h-8 px-2 hover:bg-[var(--secondary)]/50 transition-colors">
          <button onClick={() => toggleScope(scope)} className="flex items-center gap-1.5 flex-1 min-w-0">
            <ChevronRight className={cn('h-3 w-3 shrink-0 text-[var(--muted-foreground)] transition-transform', expanded && 'rotate-90')} />
            <Icon className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
            <span className="text-[11px] font-medium text-[var(--foreground)] truncate">{label}</span>
            <span className="text-[10px] text-[var(--muted-foreground)] ml-auto">{items.length}</span>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleCreate(scope) }}
            title={`New ${scope} skill`}
            className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        {expanded && items.map((skill) => {
          const key = skillKey(skill)
          return (
            <div
              key={key}
              onClick={() => setSelectedKey(key)}
              className={cn(
                'group flex w-full items-center gap-2 pl-7 pr-2 py-1.5 cursor-pointer transition-colors',
                selectedKey === key ? 'bg-[var(--secondary)]' : 'hover:bg-[var(--secondary)]/50',
                (skill.overridden || skill.disabled) && 'opacity-40',
              )}
            >
              <Zap className="h-3 w-3 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-[var(--foreground)] truncate">{skill.name}</p>
                {(skill.disabled || skill.overridden || skill.description) && (
                  <p className="text-[10px] text-[var(--muted-foreground)] truncate">
                    {skill.disabled ? 'disabled' : skill.overridden ? 'overridden' : skill.description}
                  </p>
                )}
              </div>
              <button
                onClick={(e) => handleToggle(e, skill)}
                className={cn(
                  'shrink-0 rounded p-0.5 text-[var(--muted-foreground)] transition-opacity hover:text-[var(--foreground)]',
                  skill.disabled ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
                title={skill.disabled ? 'Enable skill' : 'Disable skill'}
              >
                {skill.disabled ? <ToggleLeft className="h-4.5 w-4.5" /> : <ToggleRight className="h-4.5 w-4.5 text-blue-500" />}
              </button>
              <button
                onClick={(e) => handleDelete(e, skill)}
                className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400"
                title="Delete skill"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3">
        <Zap className="h-4 w-4 text-[var(--muted-foreground)]" />
        <span className="ml-2 text-sm font-medium text-[var(--foreground)]">{t('skill.skills')}</span>
        <div className="flex-1" />
        <button
          onClick={() => bumpSkillBus()}
          disabled={refreshing}
          title="Refresh skills"
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {renderSection('global', Globe, t('common.global'), globalSkills)}
        {projectId && renderSection('workspace', FolderOpen, t('common.workspace'), workspaceSkills)}
        {skills.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <Zap className="h-8 w-8 text-[var(--muted-foreground)]" />
            <p className="text-xs text-[var(--muted-foreground)]">{t('skill.noSkills')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
