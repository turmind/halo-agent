'use client'

import { useSkillStore } from './skills-sidebar'
import { EditorPanel } from '@/features/editor/editor-panel'
import { EditorStoreProvider } from '@/shared/stores/editor-store'
import { Zap } from 'lucide-react'

export function SkillsMain() {
  const { skills, selectedKey } = useSkillStore()
  const selected = skills.find((s) => `${s.id}:${s.scope}` === selectedKey) ?? null

  if (!selected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center bg-[var(--background)]">
        <Zap className="h-10 w-10 text-zinc-700" />
        <p className="text-sm text-[var(--muted-foreground)]">Select a skill to edit, or create a new one</p>
      </div>
    )
  }

  // Isolated EditorStore per selected skill — key forces a fresh provider instance
  // when switching skills, so tabs/fileTree from one skill don't bleed into another
  // (and never touch the main Explorer's store).
  return (
    <EditorStoreProvider key={`${selected.id}:${selected.scope}`}>
      <EditorPanel projectId={selected.path} mode="full" showMaximize={false} />
    </EditorStoreProvider>
  )
}
