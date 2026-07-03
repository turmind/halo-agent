/**
 * Pure single-line edit operations for the TUI's vendored text input.
 *
 * All ops work on grapheme clusters (Intl.Segmenter), not UTF-16 code units,
 * so the cursor can never land inside a CJK character, emoji, or ZWJ
 * sequence. `cursor` is an index into the grapheme array: 0 = before the
 * first grapheme, graphemes(value).length = after the last.
 */

export interface EditState {
  value: string
  /** Grapheme index of the caret (0..graphemes(value).length). */
  cursor: number
}

const segmenter = new Intl.Segmenter() // default granularity: grapheme

export function toGraphemes(s: string): string[] {
  if (s === '') return []
  return [...segmenter.segment(s)].map((seg) => seg.segment)
}

export function graphemeLength(s: string): number {
  return toGraphemes(s).length
}

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(n, max))
}

/** Insert `text` at the cursor; cursor moves past the inserted text. */
export function insertAt(e: EditState, text: string): EditState {
  const g = toGraphemes(e.value)
  const at = clamp(e.cursor, g.length)
  return {
    value: g.slice(0, at).join('') + text + g.slice(at).join(''),
    cursor: at + graphemeLength(text),
  }
}

/** Delete the grapheme before the cursor (Backspace). */
export function backspaceAt(e: EditState): EditState {
  const g = toGraphemes(e.value)
  const at = clamp(e.cursor, g.length)
  if (at === 0) return e
  return { value: [...g.slice(0, at - 1), ...g.slice(at)].join(''), cursor: at - 1 }
}

/** Delete the grapheme under the cursor (Del / forward delete). */
export function deleteAt(e: EditState): EditState {
  const g = toGraphemes(e.value)
  const at = clamp(e.cursor, g.length)
  if (at >= g.length) return e
  return { value: [...g.slice(0, at), ...g.slice(at + 1)].join(''), cursor: at }
}

/** Ctrl+W — unix-word-rubout: delete back over whitespace, then one word. */
export function deleteWordBefore(e: EditState): EditState {
  const g = toGraphemes(e.value)
  const at = clamp(e.cursor, g.length)
  let i = at
  while (i > 0 && g[i - 1]!.trim() === '') i--
  while (i > 0 && g[i - 1]!.trim() !== '') i--
  if (i === at) return e
  return { value: [...g.slice(0, i), ...g.slice(at)].join(''), cursor: i }
}

/** Ctrl+U — delete from start of line to the cursor. */
export function deleteToStart(e: EditState): EditState {
  const g = toGraphemes(e.value)
  const at = clamp(e.cursor, g.length)
  if (at === 0) return e
  return { value: g.slice(at).join(''), cursor: 0 }
}

/** Ctrl+K — delete from the cursor to end of line. */
export function deleteToEnd(e: EditState): EditState {
  const g = toGraphemes(e.value)
  const at = clamp(e.cursor, g.length)
  if (at >= g.length) return e
  return { value: g.slice(0, at).join(''), cursor: at }
}
