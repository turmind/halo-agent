'use client'

import { useCallback, useRef, useEffect } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import './monaco-loader'
import { useScopedEditorStore } from '@/shared/stores/editor-store'
import { useTheme, monacoThemeFor, defineMonacoThemes } from '@/shared/theme'
import { useT } from '@/shared/i18n'

interface CodeEditorProps {
  path: string
  content: string
  language: string
  onChange?: (value: string) => void
  onSave?: () => void
  onClose?: () => void
  readOnly?: boolean
  /** Scroll here and place the cursor (chat path link `a.ts:12`), then `onRevealed`. */
  reveal?: { line: number; column?: number } | null
  onRevealed?: () => void
}

export function CodeEditor({ path, content, language, onChange, onSave, onClose, readOnly, reveal, onRevealed }: CodeEditorProps) {
  const t = useT()
  const useEditorStore = useScopedEditorStore()
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const { theme } = useTheme()

  // Runs after Monaco's own path effect (a child), so the model is already the
  // new file's. layout() first: the editor may have just been un-hidden.
  const revealRef = useRef(reveal)
  const onRevealedRef = useRef(onRevealed)
  const applyReveal = useCallback(() => {
    const editor = editorRef.current
    const r = revealRef.current
    if (!editor || !r) return
    editor.layout()
    editor.revealLineInCenter(r.line)
    editor.setPosition({ lineNumber: r.line, column: r.column ?? 1 })
    editor.focus()
    onRevealedRef.current?.()
  }, [])
  useEffect(() => {
    revealRef.current = reveal
    onRevealedRef.current = onRevealed
    applyReveal()
  }, [reveal, onRevealed, path, applyReveal])

  // The editor instance persists across tab switches (models swap via the
  // `path` prop), but Monaco actions register once at mount — route them
  // through refs so Cmd+S / Alt+W always hit the *current* tab's handlers
  // instead of the closures captured on first mount.
  const onSaveRef = useRef(onSave)
  const onCloseRef = useRef(onClose)
  const contentRef = useRef(content)
  useEffect(() => {
    onSaveRef.current = onSave
    onCloseRef.current = onClose
    contentRef.current = content
  }, [onSave, onClose, content])

  // Clear selection tracking when editor unmounts or path changes
  useEffect(() => {
    return () => {
      useEditorStore.getState().setSelectedText(null, null)
    }
  }, [path])

  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null)
  const handleChange = useCallback(
    (value: string | undefined) => {
      // Leaving a read-only tab, @monaco-editor/react loads the next file with
      // setValue (it fires onChange) while the previous tab's handler is still
      // subscribed — a change on another file's model isn't this tab's edit.
      const model = editorRef.current?.getModel()
      if (model && monacoRef.current && model.uri.toString() !== monacoRef.current.Uri.parse(path).toString()) return
      if (value !== undefined && onChange) {
        onChange(value)
      }
    },
    [onChange, path],
  )

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor
      monacoRef.current = monaco

      // With `keepCurrentModel`, a remounting editor can pick up a model kept
      // from a previous mount whose content went stale while no editor was
      // showing it (e.g. the agent rewrote the file and the ws `file:changed`
      // refresh updated the buffer). @monaco-editor/react only syncs `value`
      // on prop *changes*, never at mount — reconcile here. setValue (not
      // executeEdits): the content came from disk, resetting undo is correct.
      const model = editor.getModel()
      if (model && model.getValue() !== contentRef.current) {
        model.setValue(contentRef.current)
      }

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
          onSaveRef.current?.()
        },
      })

      // Register Alt+W → close tab (Cmd+W can't be overridden in browsers)
      editor.addAction({
        id: 'halo-close-tab',
        label: 'Close Tab',
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyW],
        run: () => {
          onCloseRef.current?.()
        },
      })

      applyReveal()
    },
    [applyReveal],
  )

  return (
    <Editor
      // Multi-model mode: `path` (not `key`) drives file switches, so tab
      // changes swap Monaco models on ONE live editor instead of remounting
      // the whole editor (a remount blanks the pane with the "Loading
      // editor..." fallback for a few frames — visible jank on every
      // markdown-preview → code switch). Model swap also preserves per-file
      // undo history and cursor/scroll position (saveViewState default).
      path={path}
      // Models are shared by path across instances (split panes duplicate
      // the active tab by default) — never dispose on unmount or the other
      // pane's editor would be left holding a disposed model.
      keepCurrentModel
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
        readOnly: !!readOnly,
        readOnlyMessage: { value: t('pathLink.readOnly') },
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
