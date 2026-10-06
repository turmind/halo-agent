/**
 * Preview plugin system — shared types.
 *
 * Adding a new file type: write a plugin file under `plugins/`, register it in
 * `plugins/index.ts`. No changes needed to the core framework or editor-panel.
 *
 * A plugin declares:
 *   - which extensions it handles
 *   - a React component that renders the preview
 *   - optional flags (heavy: parses on main thread, only active one mounts)
 *   - optional toolbar slot (rendered inside the standard PreviewShell)
 */

import type React from 'react'
import type { ExtensionInfo } from '@turmind/halo-core/protocol'

/** One way to open a file — what `registry.resolve(ext)` returns, best first. */
export type Resolved =
  | { kind: 'extension'; info: ExtensionInfo }
  | { kind: 'builtin'; plugin: PreviewPlugin }
  | { kind: 'text' }

export interface PreviewProps {
  /** Full filename including extension */
  name: string
  /** Relative path inside the workspace (or absolute for /tmp files) */
  path: string
  /** Workspace absolute path — needed by plugins that call server-side parse
   *  endpoints (sqlite / parquet) instead of fetching the raw bytes */
  projectId?: string
  /** URL for inline viewing — supports HTTP Range */
  viewUrl: string
  /** URL for forced download */
  downloadUrl: string
  /** When set, the plugin should pass this through to `<PreviewShell onOpenAsText>` */
  onOpenAsText?: () => void
  /** File too large for the editor (server caps reads at 10MB). FilePreview
   *  short-circuits to a placeholder instead of dispatching to a plugin. */
  tooLarge?: boolean
  /** On-disk size in bytes (from stat) — shown by the too-large placeholder. */
  size?: number
  /** `path` is a bundle DIRECTORY: only bundle extensions are candidates. */
  bundle?: boolean
}

export interface PreviewPlugin {
  /** Stable id, e.g. 'pdf', 'xlsx', 'media' */
  id: string
  /** Extensions (lowercase, no dot) this plugin handles */
  extensions: readonly string[]
  /**
   * The component that renders the full preview. It should wrap its content in
   * `<PreviewShell>` (from `ui/preview-shell`) to get the standard header with
   * filename, Download, Open-as-Text, and slot its own toolbar buttons via
   * `extraToolbar`. Loading + error states are also driven by the shell.
   */
  Component: React.ComponentType<PreviewProps>
  /**
   * Heavy = parse/render runs on the main thread and is expensive (e.g. pptx canvas).
   * When true, the editor only mounts the *active* instance (no MRU caching).
   */
  heavy?: boolean
}
