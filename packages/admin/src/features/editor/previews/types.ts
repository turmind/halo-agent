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

export interface PreviewProps {
  /** Full filename including extension */
  name: string
  /** Relative path inside the workspace (or absolute for /tmp files) */
  path: string
  /** URL for inline viewing — supports HTTP Range */
  viewUrl: string
  /** URL for forced download */
  downloadUrl: string
  /** When set, the plugin should pass this through to `<PreviewShell onOpenAsText>` */
  onOpenAsText?: () => void
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
