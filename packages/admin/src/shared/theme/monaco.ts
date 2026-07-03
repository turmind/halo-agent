import type { Monaco } from '@monaco-editor/react'
import type { Theme } from './context'

/** Monaco theme id per app theme. dark/light map to Monaco's built-ins;
 *  midnight/warm get custom themes (defineMonacoThemes) so the editor
 *  surface matches the surrounding chrome instead of the stock
 *  #1e1e1e / #ffffff, which would read as a hole in the page. */
const MONACO_THEME_IDS: Record<Theme, string> = {
  dark: 'vs-dark',
  light: 'vs',
  midnight: 'halo-midnight',
  warm: 'halo-warm',
}

export function monacoThemeFor(theme: Theme): string {
  return MONACO_THEME_IDS[theme]
}

let defined = false

/**
 * Register the custom themes. Pass as `beforeMount` to every
 * Editor/DiffEditor so whichever mounts first defines them — the loader
 * hands out a single global monaco, so defining once is enough (the guard
 * just skips repeat work on later mounts). Token colors are inherited from
 * the vs/vs-dark base; only the surface colors are pinned to the palette
 * in globals.css.
 */
export function defineMonacoThemes(monaco: Monaco): void {
  if (defined) return
  defined = true
  monaco.editor.defineTheme('halo-midnight', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0b1220',
      'editor.foreground': '#dbe4f3',
      'editor.lineHighlightBackground': '#111a2e',
      'editorLineNumber.foreground': '#3d4f78',
    },
  })
  monaco.editor.defineTheme('halo-warm', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#f6f1e7',
      'editor.foreground': '#3d3427',
      'editor.lineHighlightBackground': '#efe7d8',
      'editorLineNumber.foreground': '#a89878',
    },
  })
}
