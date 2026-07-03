'use client'

import { useCallback, useRef, useEffect } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import './monaco-loader'
import { useScopedEditorStore } from '@/shared/stores/editor-store'
import { useTheme, monacoThemeFor, defineMonacoThemes } from '@/shared/theme'

interface CodeEditorProps {
  path: string
  content: string
  language: string
  onChange?: (value: string) => void
  onSave?: () => void
  onClose?: () => void
}

export function CodeEditor({ path, content, language, onChange, onSave, onClose }: CodeEditorProps) {
  const useEditorStore = useScopedEditorStore()
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const { theme } = useTheme()

  // Clear selection tracking when editor unmounts or path changes
  useEffect(() => {
    return () => {
      useEditorStore.getState().setSelectedText(null, null)
    }
  }, [path])

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined && onChange) {
        onChange(value)
      }
    },
    [onChange],
  )

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor

      // Track selection changes
      editor.onDidChangeCursorSelection((e) => {
        const selection = editor.getSelection()
        if (!selection || selection.isEmpty()) {
          useEditorStore.getState().setSelectedText(null, null)
          return
        }
        const selectedText = editor.getModel()?.getValueInRange(selection) ?? null
        if (selectedText) {
          useEditorStore.getState().setSelectedText(selectedText, {
            startLine: selection.startLineNumber,
            endLine: selection.endLineNumber,
          })
        }
      })

      // Register Cmd+S / Ctrl+S
      editor.addAction({
        id: 'halo-save',
        label: 'Save File',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          onSave?.()
        },
      })

      // Register Alt+W → close tab (Cmd+W can't be overridden in browsers)
      editor.addAction({
        id: 'halo-close-tab',
        label: 'Close Tab',
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyW],
        run: () => {
          onClose?.()
        },
      })
    },
    [onSave, onClose],
  )

  return (
    <Editor
      key={path}
      height="100%"
      language={language}
      value={content}
      onChange={handleChange}
      beforeMount={defineMonacoThemes}
      onMount={handleMount}
      theme={monacoThemeFor(theme)}
      options={{
        fontSize: 13,
        lineHeight: 20,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        renderLineHighlight: 'line',
        cursorBlinking: 'smooth',
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        bracketPairColorization: { enabled: true },
        automaticLayout: true,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
        },
      }}
      loading={
        <div className="flex h-full items-center justify-center bg-[var(--background)]">
          <span className="text-sm text-[var(--muted-foreground)]">Loading editor...</span>
        </div>
      }
    />
  )
}
