import type { EditorBuffer } from '@/shared/stores/editor-store'

/**
 * Live refresh of open tabs when their file changes on disk. editor-panel
 * calls these per `file:changed` event and on focus / tab switch / reconnect.
 */

/** `change` = in-place write (`fs.writeFile`, `echo >`). `add` = a rename
 *  over the path (`sed -i`, tmp file + `os.replace`). Both mean new bytes. */
export function isContentChange(action: string): boolean {
  return action === 'change' || action === 'add'
}

/**
 * What an on-disk change means for one open buffer:
 * - `host`: an extension preview. Its host reloads itself.
 * - `text`: a clean text tab. Stat it, then refetch if newer.
 * - `preview`: a built-in preview. Stat it, then bump the buffer mtime
 *   (FilePreview remounts on that).
 * - `none`: a dirty text tab (edits win), the pinned face (a reload resets
 *   it), or a bundle directory with no host mounted.
 */
export function tabRefresh(
  buf: Pick<EditorBuffer, 'preview' | 'modified'> | undefined,
  opts: { pinned: boolean; hasHost: boolean },
): 'none' | 'host' | 'text' | 'preview' {
  if (!buf || opts.pinned) return 'none'
  if (!buf.preview) return buf.modified ? 'none' : 'text'
  if (opts.hasHost) return 'host'
  return buf.preview.bundle ? 'none' : 'preview'
}

/** Cache-bust a file URL with the known mtime so an iframe / <img> reloads
 *  when it changes, instead of the browser serving the old copy. */
export function versionedUrl(url: string, mtime: number | undefined): string {
  return url && mtime != null ? `${url}&v=${mtime}` : url
}
