'use client'

import { DiffEditor } from '@monaco-editor/react'
import './monaco-loader'
import { getLanguageFromPath } from '@/shared/utils'

interface DiffViewerProps {
  original: string
  modified: string
  path: string
}

export function DiffViewer({ original, modified, path }: DiffViewerProps) {
  const language = getLanguageFromPath(path)

  return (
    <DiffEditor
      height="100%"
      language={language}
      original={original}
      modified={modified}
      theme="vs-dark"
      options={{
        fontSize: 13,
        lineHeight: 20,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        readOnly: true,
        renderSideBySide: true,
        padding: { top: 12, bottom: 12 },
        automaticLayout: true,
        overviewRulerLanes: 0,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
        },
      }}
      loading={
        <div className="flex h-full items-center justify-center bg-[var(--background)]">
          <span className="text-sm text-[var(--muted-foreground)]">Loading diff...</span>
        </div>
      }
    />
  )
}
