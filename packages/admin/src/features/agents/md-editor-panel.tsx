'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import { api } from '@/shared/api-client'
import { Save, BookOpen, Loader2 } from 'lucide-react'
import { cn } from '@/shared/utils'
import { useTheme, monacoThemeFor, defineMonacoThemes } from '@/shared/theme'
import '@/features/editor/monaco-loader'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

interface MdTab {
  key: string
  label: string
  icon: React.ElementType
  fileType: string
  description: string
  readOnly?: boolean
}

const MD_TABS: MdTab[] = [
  { key: 'agent', label: 'AGENT.md', icon: BookOpen, fileType: 'AGENT.md', description: 'Agent personality, behavior, and role definition' },
  // INSTRUCTIONS.md belongs to the project/workspace (not an agent attribute), so it's
  // not edited from the Agent management view. Manage it via the project tree instead.
]

interface MdFileState {
  content: string
  exists: boolean
  path: string | null
  dirty: boolean
  saving: boolean
  original: string
  readOnly: boolean
}

export function MdEditorPanel({
  agentId,
  scope,
  projectId,
}: {
  agentId: string
  scope: 'global' | 'workspace'
  projectId?: string
}) {
  const [activeTab, setActiveTab] = useState('agent')
  const [files, setFiles] = useState<Record<string, MdFileState>>({})
  const [loading, setLoading] = useState(true)
  const contentRef = useRef<Record<string, string>>({})
  const { theme } = useTheme()

  // Load all MD files
  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.agentConfigs.getMdAll(agentId, { scope, projectId })
      const newFiles: Record<string, MdFileState> = {}
      for (const tab of MD_TABS) {
        const f = res.files[tab.fileType]
        const isReadOnly = tab.readOnly || f?.readOnly || false
        newFiles[tab.key] = {
          content: f?.content ?? '',
          exists: f?.exists ?? false,
          path: f?.path ?? null,
          dirty: false,
          saving: false,
          original: f?.content ?? '',
          readOnly: isReadOnly,
        }
        contentRef.current[tab.key] = f?.content ?? ''
      }
      setFiles(newFiles)
    } catch (err) {
      console.error('[MdEditor] Load failed:', err)
    } finally {
      setLoading(false)
    }
  }, [agentId, scope, projectId])

  useEffect(() => { loadAll() }, [loadAll])

  const updateContent = useCallback((tabKey: string, content: string) => {
    contentRef.current[tabKey] = content
    setFiles((prev) => {
      const f = prev[tabKey]
      if (!f || f.readOnly) return prev
      return { ...prev, [tabKey]: { ...f, content, dirty: content !== f.original } }
    })
  }, [])

  const handleSave = useCallback(async (tabKey: string) => {
    const tab = MD_TABS.find((t) => t.key === tabKey)
    const file = files[tabKey]
    if (!tab || !file || file.readOnly) return

    setFiles((prev) => ({ ...prev, [tabKey]: { ...prev[tabKey], saving: true } }))
    try {
      const content = contentRef.current[tabKey] ?? file.content
      await api.agentConfigs.saveMdFile(agentId, tab.fileType, content, { scope, projectId })
      setFiles((prev) => ({
        ...prev,
        [tabKey]: { ...prev[tabKey], saving: false, dirty: false, exists: true, original: content },
      }))
    } catch (err) {
      console.error('[MdEditor] Save failed:', err)
      setFiles((prev) => ({ ...prev, [tabKey]: { ...prev[tabKey], saving: false } }))
    }
  }, [agentId, scope, projectId, files])

  // Ctrl+S
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        const f = files[activeTab]
        if (f?.dirty && !f.readOnly) handleSave(activeTab)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTab, files, handleSave])

  const activeFile = files[activeTab]
  const activeTabMeta = MD_TABS.find((t) => t.key === activeTab)!

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex items-center border-b border-[var(--border)] bg-[var(--card)] overflow-x-auto">
        {MD_TABS.map((tab) => {
          const Icon = tab.icon
          const file = files[tab.key]
          const isActive = activeTab === tab.key
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              title={tab.description}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium border-b-2 transition-colors whitespace-nowrap',
                isActive
                  ? 'border-[var(--primary)] text-[var(--foreground)]'
                  : 'border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]/50',
              )}
            >
              <Icon className="h-3 w-3" />
              {tab.label}
              {file?.dirty && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-500" />}
              {!file?.exists && !file?.dirty && !file?.readOnly && <span className="ml-1 text-[9px] opacity-50">(new)</span>}
            </button>
          )
        })}
        <div className="flex-1" />
        {activeFile?.dirty && !activeFile?.readOnly && (
          <button
            onClick={() => handleSave(activeTab)}
            disabled={activeFile?.saving}
            className="flex items-center gap-1 mr-2 rounded bg-[var(--primary)] px-2.5 py-1 text-[10px] font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-30"
          >
            <Save className="h-3 w-3" />
            {activeFile?.saving ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>

      {/* Description bar */}
      <div className="px-3 py-1.5 bg-[var(--secondary)]/30 border-b border-[var(--border)]">
        <p className="text-[10px] text-[var(--muted-foreground)]">
          {activeTabMeta.description}
          {activeFile?.readOnly && (
            <span className="ml-2 rounded bg-[var(--muted)]/50 px-1.5 py-0.5 text-[9px] font-medium">read-only</span>
          )}
          {activeFile?.path && (
            <span className="ml-2 font-mono opacity-60">{activeFile.path}</span>
          )}
        </p>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <MonacoEditor
          key={`${agentId}-${activeTab}-${scope}`}
          height="100%"
          language="markdown"
          beforeMount={defineMonacoThemes}
          theme={monacoThemeFor(theme)}
          value={activeFile?.content ?? ''}
          onChange={(value) => updateContent(activeTab, value ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            padding: { top: 8 },
            tabSize: 2,
            readOnly: activeFile?.readOnly ?? false,
          }}
        />
      </div>
    </div>
  )
}
