import React, { useState, useMemo, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SessionTreeNode } from '../../harness.js'

interface FlatRow {
  node: SessionTreeNode
  depth: number
  isLast: boolean
  prefix: string
}

interface Props {
  tree: SessionTreeNode
  /** Called with a session id when the user picks one with Enter. */
  onPick: (sessionId: string) => void
  /** Called when the user presses Esc — caller closes the navigator. */
  onCancel: () => void
}

/** Flatten the tree into a printable list with tree-art prefixes. */
function flatten(node: SessionTreeNode, depth = 0, parentPrefix = '', isLastSibling = true): FlatRow[] {
  const own: FlatRow = {
    node,
    depth,
    isLast: isLastSibling,
    prefix: depth === 0 ? '' : parentPrefix + (isLastSibling ? '└─ ' : '├─ '),
  }
  const childPrefix = depth === 0 ? '' : parentPrefix + (isLastSibling ? '   ' : '│  ')
  const out: FlatRow[] = [own]
  node.children.forEach((c, i) => {
    out.push(...flatten(c, depth + 1, childPrefix, i === node.children.length - 1))
  })
  return out
}

function statusGlyph(status: 'running' | 'idle' | 'stopped'): { glyph: string; color: string } {
  switch (status) {
    case 'running': return { glyph: '●', color: 'green' }
    case 'idle':    return { glyph: '○', color: 'gray' }
    case 'stopped': return { glyph: '✕', color: 'red' }
  }
}

export function LogNavigator({ tree, onPick, onCancel }: Props): React.ReactElement {
  const rows = useMemo(() => flatten(tree), [tree])
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    if (idx >= rows.length) setIdx(Math.max(0, rows.length - 1))
  }, [rows.length, idx])

  useInput((input, key) => {
    if (key.escape) { onCancel(); return }
    if (key.upArrow) { setIdx((i) => Math.max(0, i - 1)); return }
    if (key.downArrow) { setIdx((i) => Math.min(rows.length - 1, i + 1)); return }
    if (key.return) {
      const row = rows[idx]
      if (row) onPick(row.node.id)
      return
    }
    if (input === 'q') { onCancel(); return }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>Session log — ↑↓ to move, Enter to view, Esc/q to cancel</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, i) => {
          const sg = statusGlyph(row.node.status)
          const selected = i === idx
          const id8 = row.node.id.slice(-8)
          const desc = row.node.description ? `  ${row.node.description.slice(0, 40)}` : ''
          return (
            <Box key={row.node.id}>
              <Text color={selected ? 'black' : 'gray'} backgroundColor={selected ? 'cyan' : undefined}>
                {selected ? '▶ ' : '  '}
              </Text>
              <Text color="gray" dimColor>{row.prefix}</Text>
              <Text color={sg.color}>{sg.glyph} </Text>
              <Text color={selected ? 'cyan' : 'white'} bold={selected}>{row.node.agentName}</Text>
              {row.node.archived && <Text color="yellow" dimColor> ▢ archived</Text>}
              <Text color="gray" dimColor>{`  ${id8}${desc}`}</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
