import React from 'react'
import { Text } from 'ink'
import { toGraphemes } from '../line-editor.js'

interface Props {
  value: string
  /** Caret as a grapheme index (see line-editor.ts). */
  cursor: number
  placeholder: string
}

/**
 * Pure renderer for the vendored line editor — all key handling lives in
 * InputBox. The caret is drawn as an inverse-video span over the grapheme at
 * the cursor (or a trailing space at end-of-line). Because the inversion is
 * applied to the glyph itself, wide characters (CJK, emoji) get a wide caret
 * with no visual-column math. Nested <Text> spans keep the whole line one
 * paragraph, so long values wrap exactly like the previous single-Text render.
 */
export function TextInputView({ value, cursor, placeholder }: Props): React.ReactElement {
  if (value.length === 0) {
    // Caret over the placeholder's first character mirrors ink-text-input.
    if (placeholder.length > 0) {
      return (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text color="gray" dimColor>{placeholder.slice(1)}</Text>
        </Text>
      )
    }
    return <Text inverse> </Text>
  }

  const g = toGraphemes(value)
  const at = Math.max(0, Math.min(cursor, g.length))
  const before = g.slice(0, at).join('')
  const under = at < g.length ? g[at]! : ' '
  const after = at < g.length ? g.slice(at + 1).join('') : ''

  return (
    <Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </Text>
  )
}
