import React from 'react'
import { Box, Text } from 'ink'

export interface PathItem {
  /** Display name (basename) — what's shown in the list. */
  name: string
  /** Full path inserted into the input on completion (relative or absolute). */
  insertPath: string
  /** True if this entry is a directory — picking it descends rather than closing. */
  isDir: boolean
  /** True if this looks like an image (jpg/png/gif/webp/bmp). */
  isImage: boolean
}

interface Props {
  items: PathItem[]
  selectedIdx: number
  /** The directory being listed, shown as a header. */
  cwdLabel: string
}

/**
 * File/dir suggest popup, shown above the input box when the user is typing
 * an `@file <path>` or `@image <path>` reference. Tab/Enter completes the
 * highlighted entry; ↑↓ moves selection.
 */
export function PathSuggest({ items, selectedIdx, cwdLabel }: Props): React.ReactElement | null {
  if (items.length === 0) return null
  const MAX_ROWS = 8
  const visible = items.slice(0, MAX_ROWS)
  const truncated = items.length > MAX_ROWS

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box>
        <Text color="gray" dimColor>{`${cwdLabel}/`}</Text>
      </Box>
      {visible.map((item, i) => {
        const selected = i === selectedIdx
        const icon = item.isDir ? '📁' : (item.isImage ? '🖼️ ' : '📄')
        return (
          <Box key={item.name}>
            <Text
              color={selected ? 'black' : 'cyan'}
              backgroundColor={selected ? 'cyan' : undefined}
              bold={selected}
            >
              {`${selected ? '▶ ' : '  '}${icon} ${item.name}${item.isDir ? '/' : ''}`}
            </Text>
          </Box>
        )
      })}
      {truncated ? (
        <Text color="gray" dimColor>{`  … +${items.length - MAX_ROWS} more (keep typing to filter)`}</Text>
      ) : null}
    </Box>
  )
}
