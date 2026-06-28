/**
 * Maps a single git status char (StatusResult file.index / working_dir) to a
 * VSCode-style badge letter + color. Colors are VSCode's official dark-theme
 * values (the admin is dark). These are visual constants only — not ported code.
 */
export interface StatusMeta {
  letter: string
  color: string
  label: string
}

const META: Record<string, StatusMeta> = {
  M: { letter: 'M', color: '#1B81A8', label: 'Modified' },
  A: { letter: 'A', color: '#487E02', label: 'Added' },
  D: { letter: 'D', color: '#F48771', label: 'Deleted' },
  R: { letter: 'R', color: '#2090D3', label: 'Renamed' },
  C: { letter: 'C', color: '#2090D3', label: 'Copied' },
  // git reports unmerged paths with 'U' — surface as a red Conflict badge.
  U: { letter: 'C', color: '#E4676B', label: 'Conflict' },
  // untracked ('?') shares the green Added family, badge letter 'U'.
  '?': { letter: 'U', color: '#487E02', label: 'Untracked' },
}

const FALLBACK: StatusMeta = { letter: '?', color: '#487E02', label: 'Untracked' }

/** Neutral gray for a directory whose subtree mixes more than one change kind
 *  (VSCode's gitDecoration ignored/mixed tone). Used only for folder dots. */
export const MIXED_STATUS_COLOR = '#8C8C8C'

export function statusMeta(char: string): StatusMeta {
  return META[char] ?? FALLBACK
}

/** A staged side counts when its char is set and isn't untracked. */
export function isStagedChar(char: string): boolean {
  return char !== '' && char !== ' ' && char !== '?'
}

/** A working-tree side counts when its char is set (untracked '?' included). */
export function isWorkingChar(char: string): boolean {
  return char !== '' && char !== ' '
}
