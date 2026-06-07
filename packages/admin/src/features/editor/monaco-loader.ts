import { loader } from '@monaco-editor/react'

/**
 * Point Monaco at the locally-served copy instead of the default jsdelivr CDN.
 *
 * @monaco-editor/react fetches Monaco (AMD build) from a CDN by default. The
 * packaged desktop/Windows app runs fully offline against its in-app server
 * (http://127.0.0.1:PORT), so the CDN fetch fails and the find widget renders
 * with broken codicon glyphs — the "garbled search box". scripts/copy-monaco.mjs
 * stages `min/vs` into the static export at out/monaco/vs; the server hosts out/
 * wholesale, so `/monaco/vs` resolves on both the dev (:3000) and packaged
 * (:PORT) origins. The codicon font is inlined as a data: URI in
 * editor.main.css, so this single path config makes the whole editor offline.
 *
 * Imported for its side effect by every component that mounts a Monaco editor
 * (code-editor, diff-viewer, md-editor-panel). loader.config is an idempotent
 * global; calling it from multiple importers before the first mount is fine.
 */
loader.config({ paths: { vs: '/monaco/vs' } })
