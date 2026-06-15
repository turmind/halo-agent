'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { useSkillStore } from '@/features/skills/skills-sidebar'
import type { Skill } from '@/shared/types'
import { Bot, Plus, Trash2, Crown, Globe, FolderOpen, ChevronRight, Play, Pencil, ArrowLeft, RefreshCw, Cog, ToggleLeft, ToggleRight } from 'lucide-react'
import { cn, promptInput, confirmAction } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { AgentForm } from './agent-form'
import { MarkdownPreview } from '@/features/editor/markdown-preview'
import { EditorPanel } from '@/features/editor/editor-panel'
import { EditorStoreProvider } from '@/shared/stores/editor-store'
import { useChatStore } from '@/features/chat/chat-store'
import { wsClient } from '@/shared/ws-client'
import { useAgentBus, bumpAgentBus } from '@/shared/agent-bus'

interface AgentMeta {
  id: string
  name: string
  description: string
  model: string
  path: string
  scope: 'global' | 'workspace'
  priority: number
  overridden?: boolean
  disabled?: boolean
  /** Hidden from `list_agents` tool (e.g. self-evolution agents). Shown in
   *  admin with a small "internal" badge so users know it's system-managed. */
  internal?: boolean
}

type EditorView = 'form' | 'edit'

/** Composite key for unique agent selection (handles same ID in different scopes) */
function agentKey(a: { id: string; scope: string }): string {
  return `${a.id}:${a.scope}`
}

const AGENT_SELECTED_KEY = 'halo_agents_selectedKey'
const AGENT_EXPANDED_KEY = 'halo_agents_expandedScopes'

function loadExpandedScopes(): Set<string> {
  // Internal collapsed by default — system agents are rarely edited.
  if (typeof window === 'undefined') return new Set(['global', 'workspace'])
  try {
    const raw = localStorage.getItem(AGENT_EXPANDED_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {}
  return new Set(['global', 'workspace'])
}

export function AgentManagementMain() {
  const t = useT()
  const activeProject = useProjectStore((s) => s.activeProject)
  const projectId = activeProject?.path ?? undefined
  const [agents, setAgents] = useState<AgentMeta[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    typeof window !== 'undefined' ? localStorage.getItem(AGENT_SELECTED_KEY) : null,
  )
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(loadExpandedScopes)
  const { skills: existingSkills, setSkills } = useSkillStore()
  const [modelsRegistry, setModelsRegistry] = useState<Awaited<ReturnType<typeof api.agentConfigs.models>> | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (selectedKey) localStorage.setItem(AGENT_SELECTED_KEY, selectedKey)
    else localStorage.removeItem(AGENT_SELECTED_KEY)
  }, [selectedKey])

  useEffect(() => {
    localStorage.setItem(AGENT_EXPANDED_KEY, JSON.stringify([...expandedScopes]))
  }, [expandedScopes])

  useEffect(() => {
    api.agentConfigs.models().then(setModelsRegistry).catch(() => {})
  }, [])

  const loadAgents = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await api.agentConfigs.list(projectId)
      setAgents(res.agents)
      if (!selectedKey && res.agents.length > 0) {
        setSelectedKey(agentKey(res.agents[0]))
      }
    } catch (err) {
      console.error('[AgentManagement] Load failed:', err)
    } finally {
      setRefreshing(false)
    }
  }, [projectId, selectedKey])

  const busVersion = useAgentBus((s) => s.version)
  useEffect(() => { loadAgents() }, [loadAgents, busVersion])

  // Watch file:changed for external agent creations/deletions (e.g. agent chat
  // creating an agent.yaml). Any add/unlink inside .halo/agents/* bumps the bus.
  // Global agents (~/.halo/global/agents/) aren't watched by the workspace
  // watcher; focus refresh below picks them up.
  useEffect(() => {
    if (!projectId) return
    const unsub = wsClient.on('file:changed', (data) => {
      const msg = data as { path: string; action: string }
      if (msg.action !== 'add' && msg.action !== 'unlink' && msg.action !== 'addDir' && msg.action !== 'unlinkDir') return
      if (!msg.path.startsWith('.halo/agents/')) return
      bumpAgentBus()
    })
    return unsub
  }, [projectId])

  useEffect(() => {
    const onFocus = () => bumpAgentBus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    if (existingSkills.length > 0) return
    api.skills.list(activeProject?.path).then((res) => {
      setSkills(res.skills as Skill[])
    }).catch(() => {})
  }, [activeProject?.path, existingSkills.length, setSkills])

  const selected = agents.find((a) => agentKey(a) === selectedKey) ?? null

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
    const name = await promptInput('Agent name:')
    if (!name?.trim()) return
    const description = (await promptInput('Agent description (optional):')) ?? ''
    const generatedId = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
    const otherScope = scope === 'workspace' ? 'global' : 'workspace'
    const conflict = agents.find((a) => a.id === generatedId && a.scope === otherScope)
    if (conflict) {
      const msg = scope === 'workspace'
        ? `Global agent "${conflict.name}" has the same ID.\nWorkspace version will override it at runtime.\n\nContinue?`
        : `Workspace agent "${conflict.name}" has the same ID.\nIt will override this global agent in that project.\n\nContinue?`
      if (!(await confirmAction(msg))) return
    }
    try {
      const res = await api.agentConfigs.create({ name: name.trim(), description: description.trim(), scope, projectId: scope === 'workspace' ? projectId : undefined })
      const newAgent = res.agent as unknown as AgentMeta
      setAgents((prev) => {
        const updated = scope === 'workspace'
          ? prev.map((a) => a.id === newAgent.id && a.scope === 'global' ? { ...a, overridden: true } : a)
          : prev
        return [...updated, newAgent]
      })
      setExpandedScopes((prev) => new Set(prev).add(scope))
      setSelectedKey(agentKey(newAgent))
      bumpAgentBus()
    } catch (err) {
      console.error('[AgentManagement] Create failed:', err)
    }
  }

  async function handleDelete(agent: AgentMeta) {
    if (!(await confirmAction(`Delete agent "${agent.name}"?`))) return
    try {
      await api.agentConfigs.remove(agent.id, { scope: agent.scope, projectId })
      setAgents((prev) => {
        const remaining = prev.filter((a) => agentKey(a) !== agentKey(agent))
        // If deleting a workspace agent, un-override the global counterpart
        if (agent.scope === 'workspace') {
          return remaining.map((a) => a.id === agent.id && a.scope === 'global' ? { ...a, overridden: false } : a)
        }
        return remaining
      })
      if (selectedKey === agentKey(agent)) setSelectedKey(null)
      bumpAgentBus()
    } catch (err) {
      console.error('[AgentManagement] Delete failed:', err)
    }
  }

  // Disable hides an agent from the orchestrator's roster + list_agents (so it
  // can't be delegated to) without deleting its files. Toggle writes to the
  // workspace DB; trust the returned `disabled` rather than optimistic-flipping.
  async function handleToggle(agent: AgentMeta) {
    try {
      const { disabled } = await api.agentConfigs.toggle(agent.id, { scope: agent.scope, projectId })
      setAgents((prev) => prev.map((a) => agentKey(a) === agentKey(agent) ? { ...a, disabled } : a))
      bumpAgentBus()
    } catch (err) {
      console.error('[AgentManagement] Toggle failed:', err)
    }
  }

  // Internal agents (e.g. self-evolution) get their own section so they stay
  // out of users' way until explicitly opened. They're always global-scoped
  // but treating them as a separate "scope" in the UI keeps the regular
  // global / workspace lists clean.
  const internalAgents = agents.filter((a) => a.internal)
  const globalAgents = agents.filter((a) => a.scope === 'global' && !a.internal)
  const workspaceAgents = agents.filter((a) => a.scope === 'workspace' && !a.internal)

  type SectionScope = 'global' | 'workspace' | 'internal'

  const renderSection = (
    scope: SectionScope,
    icon: React.ElementType,
    label: string,
    items: AgentMeta[],
    opts: { allowCreate: boolean } = { allowCreate: true },
  ) => {
    const Icon = icon
    const expanded = expandedScopes.has(scope)
    return (
      <div key={scope}>
        {/* Section header */}
        <div className="flex items-center h-8 px-2 hover:bg-[var(--secondary)]/50 transition-colors">
          <button onClick={() => toggleScope(scope)} className="flex items-center gap-1.5 flex-1 min-w-0">
            <ChevronRight className={cn('h-3 w-3 shrink-0 text-[var(--muted-foreground)] transition-transform', expanded && 'rotate-90')} />
            <Icon className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
            <span className="text-[11px] font-medium text-[var(--foreground)] truncate">{label}</span>
            <span className="text-[10px] text-[var(--muted-foreground)] ml-auto">{items.length}</span>
          </button>
          {opts.allowCreate && scope !== 'internal' && (
            <button
              onClick={(e) => { e.stopPropagation(); handleCreate(scope as 'global' | 'workspace') }}
              title={`New ${scope} agent`}
              className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>
        {/* Agent items */}
        {expanded && items.map((agent) => {
          const key = agentKey(agent)
          return (
            <div
              key={key}
              className={cn(
                'group flex w-full items-center gap-2 pl-7 pr-2 py-1.5 cursor-pointer transition-colors',
                selectedKey === key ? 'bg-[var(--secondary)]' : 'hover:bg-[var(--secondary)]/50',
                (agent.overridden || agent.disabled) && 'opacity-40',
              )}
              onClick={() => setSelectedKey(key)}
            >
              <Bot className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-[var(--foreground)] truncate">{agent.name}</p>
                {(agent.overridden || agent.disabled || agent.description) && (
                  <p className="text-[10px] text-[var(--muted-foreground)] truncate">
                    {agent.overridden ? 'overridden' : agent.disabled ? 'disabled' : agent.description}
                  </p>
                )}
              </div>
              {/* Disable toggle — hides the agent from the roster / list_agents
                  without deleting it. Not offered for internal agents (already
                  hidden from delegation by their `internal` flag), nor when no
                  workspace is open (disabled state lives in the workspace DB,
                  so there's nowhere to persist it). */}
              {scope !== 'internal' && projectId && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggle(agent) }}
                  title={agent.disabled ? 'Enable (show in roster)' : 'Disable (hide from roster)'}
                  className={cn(
                    'shrink-0 rounded p-0.5 text-[var(--muted-foreground)] transition-opacity hover:text-[var(--foreground)]',
                    agent.disabled ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                >
                  {agent.disabled ? <ToggleLeft className="h-4.5 w-4.5" /> : <ToggleRight className="h-4.5 w-4.5 text-blue-500" />}
                </button>
              )}
              {agent.scope === 'global' ? (
                <span title="Global agent (cannot delete)"><Crown className="h-3 w-3 shrink-0 text-amber-500" /></span>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(agent) }}
                  className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <PanelGroup direction="horizontal" autoSaveId="halo-agent-mgmt" className="h-full">
      <Panel defaultSize={22} minSize={12} maxSize={40}>
        <div className="h-full flex flex-col bg-[var(--background)]">
          <div className="flex h-10 items-center border-b border-[var(--border)] px-3">
            <span className="text-sm font-medium text-[var(--foreground)]">{t('agent.agents')}</span>
            <div className="flex-1" />
            <button
              onClick={() => loadAgents()}
              disabled={refreshing}
              className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
              title="Refresh agents"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {renderSection('global', Globe, t('common.global'), globalAgents)}
            {projectId && renderSection('workspace', FolderOpen, t('common.workspace'), workspaceAgents)}
            {internalAgents.length > 0 && renderSection('internal', Cog, 'Internal', internalAgents, { allowCreate: false })}
          </div>
        </div>
      </Panel>
      <PanelResizeHandle className="w-px bg-[var(--border)] hover:w-1 hover:bg-[var(--primary)] transition-colors" />
      <Panel defaultSize={78} minSize={40}>
        {selected ? (
          <AgentEditorWithChat
            key={agentKey(selected)}
            agent={selected}
            modelsRegistry={modelsRegistry}
            onSaved={(updated) => {
              setAgents((prev) => prev.map((a) => agentKey(a) === agentKey(updated) ? updated : a))
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Bot className="h-10 w-10 text-zinc-700" />
            <p className="text-sm text-[var(--muted-foreground)]">{t('agent.selectToEdit')}</p>
          </div>
        )}
      </Panel>
    </PanelGroup>
  )
}

/** Models registry type */
type ModelsRegistry = Awaited<ReturnType<typeof api.agentConfigs.models>> | null

/** Navigate to explorer chat with a fresh session using the specified agent */
function testAgent(agentId: string, projectId?: string) {
  // Detach any active session before clearing (mirrors clearSession in use-chat.ts)
  const currentSessionId = useChatStore.getState().sessionId
  if (currentSessionId) {
    wsClient.send({ type: 'session:clear', sessionId: currentSessionId })
  }
  if (projectId && typeof window !== 'undefined') {
    localStorage.removeItem(`halo_session_${projectId}`)
  }
  useChatStore.getState().clear()
  useChatStore.getState().setSelectedAgentId(agentId)
  window.dispatchEvent(new CustomEvent('halo:navigate', { detail: { tab: 'explorer' } }))
}

/** Form + YAML + MD editor */
function AgentEditorWithChat({ agent, modelsRegistry, onSaved }: { agent: AgentMeta; modelsRegistry: ModelsRegistry; onSaved: (a: AgentMeta) => void }) {
  const t = useT()
  const { skills: availableSkills } = useSkillStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const [parsedData, setParsedData] = useState<Record<string, unknown>>({})
  // Persist the view per-agent so switching activity tabs or reloading the page
  // returns users to the mini workspace if they were in the middle of editing.
  const viewStorageKey = `halo_agent_view:${agentKey(agent)}`
  const [view, setViewRaw] = useState<EditorView>(() => {
    if (typeof window === 'undefined') return 'form'
    return (localStorage.getItem(viewStorageKey) as EditorView) ?? 'form'
  })
  const setView = useCallback((v: EditorView) => {
    if (typeof window !== 'undefined') localStorage.setItem(viewStorageKey, v)
    setViewRaw(v)
  }, [viewStorageKey])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [availableTools, setAvailableTools] = useState<Array<{ name: string; description: string }>>([])
  const [agentMd, setAgentMd] = useState<string>('')

  useEffect(() => {
    api.agentConfigs.tools().then((res) => setAvailableTools(res.tools)).catch(() => {})
  }, [])

  // Refs used across the load/save effects; declared up-front so they're defined
  // when loadFromDisk below captures them. Keep onSavedRef current after commit
  // (read only in async save flow, never during render).
  const onSavedRef = useRef(onSaved)
  useEffect(() => { onSavedRef.current = onSaved })
  const lastSavedYamlRef = useRef<string | null>(null)

  // Load yaml (form) + md (preview) every time we (re)enter form view or switch agent —
  // this catches changes made in the mini-workspace.
  const loadFromDisk = useCallback(async () => {
    setLoading(true)
    const projectId = agent.scope === 'workspace' ? activeProject?.path : undefined
    try {
      const res = await api.agentConfigs.getYaml(agent.id, { scope: agent.scope, projectId })
      const { parse, stringify } = await import('yaml')
      let parsed: unknown = {}
      try { parsed = parse(res.yaml) } catch {}
      const safeParsed = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
      setParsedData(safeParsed)
      // Establish a baseline so auto-save won't re-write the just-loaded content.
      // Must match the stringify format used by the save effect exactly.
      lastSavedYamlRef.current = stringify(safeParsed, { lineWidth: 120 })
    } catch (err) {
      console.error('[AgentEditor] Load YAML failed:', err)
      setParsedData({})
      lastSavedYamlRef.current = null
    }
    try {
      const mdRes = await api.agentConfigs.getMdAll(agent.id, { scope: agent.scope, projectId })
      setAgentMd(mdRes.files['AGENT.md']?.content ?? '')
    } catch {
      setAgentMd('')
    }
    setLoading(false)
  }, [agent.id, agent.scope, activeProject?.path])

  useEffect(() => { loadFromDisk() }, [loadFromDisk])

  // Re-load when returning from mini-workspace (user may have edited yaml / md directly)
  const prevView = useRef(view)
  useEffect(() => {
    if (prevView.current === 'edit' && view === 'form') {
      loadFromDisk()
    }
    prevView.current = view
  }, [view, loadFromDisk])

  // Auto-save: stringify parsedData → PUT /agent-configs, debounced.
  // Guards against re-saving the same content (onSaved from parent updates agents
  // state → component re-renders → effect re-runs — without this guard it would loop).
  useEffect(() => {
    if (loading) return
    const timer = setTimeout(async () => {
      try {
        const { stringify } = await import('yaml')
        const yamlToSave = stringify(parsedData, { lineWidth: 120 })
        // Same content as last save (or as just-loaded-from-disk) → skip
        if (lastSavedYamlRef.current === yamlToSave) return
        setSaving(true)
        const saveProjectId = agent.scope === 'workspace' ? activeProject?.path : undefined
        const res = await api.agentConfigs.saveYaml(agent.id, yamlToSave, { scope: agent.scope, projectId: saveProjectId })
        lastSavedYamlRef.current = yamlToSave
        onSavedRef.current(res.agent as unknown as AgentMeta)
      } catch (err) {
        console.error('[AgentEditor] Auto-save failed:', err)
      } finally {
        setSaving(false)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [parsedData, agent.id, agent.scope, activeProject?.path, loading])

  // Reset baseline when agent changes or after disk reload — treat the just-loaded
  // yaml as "already saved" so the next effect doesn't re-save it.
  useEffect(() => { lastSavedYamlRef.current = null }, [agent.id, agent.scope])

  function updateData(key: string, value: unknown) {
    setParsedData((prev) => ({ ...prev, [key]: value }))
  }

  function updateNested(parentKey: string, childKey: string, value: unknown) {
    setParsedData((prev) => {
      const parent = (prev[parentKey] as Record<string, unknown>) ?? {}
      return { ...prev, [parentKey]: { ...parent, [childKey]: value } }
    })
  }

  function toggleArrayItem(key: string, item: string) {
    setParsedData((prev) => {
      const arr = Array.isArray(prev[key]) ? [...(prev[key] as string[])] : []
      const idx = arr.indexOf(item)
      if (idx >= 0) arr.splice(idx, 1)
      else arr.push(item)
      return { ...prev, [key]: arr }
    })
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-10 items-center justify-between border-b border-[var(--border)] bg-[var(--card)] px-3">
        <div className="flex items-center gap-2">
          {view === 'edit' && (
            <button
              onClick={() => setView('form')}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
              title="Back to form"
            >
              <ArrowLeft className="h-3 w-3" />
              {t('agent.back')}
            </button>
          )}
          <span className="text-xs font-medium text-[var(--foreground)]">{agent.name}</span>
          <span className="rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[9px] text-[var(--muted-foreground)]">{agent.scope}</span>
          {view === 'form' && saving && <span className="text-[9px] text-[var(--muted-foreground)]">{t('agent.saving')}</span>}
        </div>
        <div className="flex items-center gap-2">
          {/* Internal agents (self-evolution etc.) can't be driven directly —
              they're delegated to by other agents, not chatted with. */}
          {!agent.internal && (
            <button
              onClick={() => testAgent(agent.id, activeProject?.id)}
              className="flex items-center gap-1.5 rounded bg-[var(--secondary)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--secondary)]/80"
            >
              <Play className="h-3 w-3" />
              {t('agent.test')}
            </button>
          )}
          {view === 'form' && (
            <button
              onClick={() => setView('edit')}
              className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-3 py-1 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90"
              title={t('agent.editHint')}
            >
              <Pencil className="h-3 w-3" />
              {t('agent.edit')}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === 'edit' ? (
          <EditorStoreProvider key={`${agent.id}:${agent.scope}`}>
            <EditorPanel projectId={agent.path} mode="full" showMaximize={false} />
          </EditorStoreProvider>
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">{t('agent.loading')}</div>
        ) : (
          <div className="h-full overflow-y-auto">
            <AgentForm
              data={parsedData}
              availableSkills={availableSkills}
              availableTools={availableTools}
              modelsRegistry={modelsRegistry}
              onUpdate={updateData}
              onUpdateNested={updateNested}
              onToggleArrayItem={toggleArrayItem}
            />
            {agentMd.trim() && (
              <div className="mx-auto max-w-prose px-6 py-8 border-t border-[var(--border)]">
                <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  <span className="rounded bg-[var(--secondary)] px-1.5 py-0.5">AGENT.md</span>
                  <span>{t('agent.mdPreviewHint')}</span>
                </div>
                <MarkdownPreview content={agentMd} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
