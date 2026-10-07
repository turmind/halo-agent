/** Client OS split for terminal clipboard keys (the PTY is always the Linux
 *  server — what matters is the keyboard in front of the user). Windows and
 *  Linux clients share the non-mac path. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

type KeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

/**
 * Which clipboard action (if any) a terminal keydown means. Non-mac only —
 * mac keeps Cmd+C / Cmd+V, which never collide with the shell:
 *   - Ctrl+C with a selection → copy (no selection → null: stays ^C / SIGINT)
 *   - Ctrl+Shift+C → copy (always swallowed, even with nothing selected)
 *   - Ctrl+V / Ctrl+Shift+V → paste (Windows Terminal convention; literal ^V is given up)
 */
export function terminalClipboardKey(e: KeyLike, { isMac, hasSelection }: { isMac: boolean; hasSelection: boolean }): 'copy' | 'paste' | null {
  if (isMac || e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return null
  const key = e.key.toLowerCase()
  if (key === 'c') return e.shiftKey || hasSelection ? 'copy' : null
  if (key === 'v') return 'paste'
  return null
}
