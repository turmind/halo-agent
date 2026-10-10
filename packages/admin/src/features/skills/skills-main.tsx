'use client'

import { useEffect, useState } from 'react'
import { useSkillStore } from './skills-sidebar'
import { EditorPanel } from '@/features/editor/editor-panel'
import { EditorStoreProvider } from '@/shared/stores/editor-store'
import { api } from '@/shared/api-client'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import type { Skill } from '@/shared/types'
import { Zap, Puzzle, FileText } from 'lucide-react'

export function SkillsMain() {
  const { skills, selectedKey } = useSkillStore()
  const selected = skills.find((s) => `${s.id}:${s.scope}` === selectedKey) ?? null

  if (!selected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center bg-[var(--background)]">
        <Zap className="h-10 w-10 text-[var(--muted-foreground)]" />
        <p className="text-sm text-[var(--muted-foreground)]">Select a skill to edit, or create a new one</p>
      </div>
    )
  }

  // Isolated EditorStore per selected skill — key forces a fresh provider instance
  // when switching skills, so tabs/fileTree from one skill don't bleed into another
  // (and never touch the main Explorer's store).
  return (
    <EditorStoreProvider key={`${selected.id}:${selected.scope}`}>
      {selected.scope === 'extension'
        ? <ExtensionSkillView skill={selected} />
        : <EditorPanel projectId={selected.path} mode="full" showMaximize={false} />}
    </EditorStoreProvider>
  )
}

/** Read-only view of a skill shipped by a canvas extension: file list +
 *  content, no editing (the folder belongs to the extension and is replaced
 *  on its reinstall). Not the EditorPanel — its tree offers create / rename /
 *  delete / upload, all of which would write into the extension. */
function ExtensionSkillView({ skill }: { skill: Skill }) {
  const t = useT()
  const [files, setFiles] = useState<string[]>([])
  const [active, setActive] = useState('SKILL.md')
  const [content, setContent] = useState<string | null>(null)

  useEffect(() => {
    api.files.search(skill.path, '', 1000)
      .then((res) => setFiles(res.matches.map((m) => m.path).sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)))))
      .catch(() => setFiles([]))
  }, [skill.path])

  useEffect(() => {
    setContent(null)
    api.files.read(active, skill.path)
      .then((res) => setContent(res.content))
      .catch((err) => setContent(err instanceof Error ? err.message : String(err)))
  }, [active, skill.path])

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <Puzzle className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
        <span className="text-sm font-medium text-[var(--foreground)] truncate">{skill.name}</span>
        <span className="shrink-0 rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
          {t('skill.fromExtension', { ext: skill.extId ?? '' })} · {t('skill.readOnly')}
        </span>
        <span className="ml-auto truncate font-mono text-[10px] text-[var(--muted-foreground)]" title={skill.path}>{skill.path}</span>
      </div>
      <p className="shrink-0 border-b border-[var(--border)] bg-[var(--secondary)]/30 px-3 py-1.5 text-[10px] text-[var(--muted-foreground)]">
        {t('skill.extensionHint', { id: skill.id })}
      </p>
      <div className="flex min-h-0 flex-1">
        <div className="w-48 shrink-0 overflow-y-auto border-r border-[var(--border)] py-1">
          {files.map((f) => (
            <button
              key={f}
              onClick={() => setActive(f)}
              title={f}
              className={cn(
                'flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] transition-colors',
                active === f ? 'bg-[var(--secondary)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/50 hover:text-[var(--foreground)]',
              )}
            >
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{f}</span>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          {/* Raw text, frontmatter included — what the editor shows for a
              global / workspace skill (a markdown render turns the frontmatter
              into a heading). */}
          {content !== null && (
            <pre className="h-full overflow-auto p-4 font-mono text-xs text-[var(--foreground)] whitespace-pre-wrap">{content}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
