import React from 'react'
import { Box, Text } from 'ink'

export interface SlashItem {
  slashName: string
  description: string
  argHint?: string
}

interface Props {
  items: SlashItem[]
  selectedIdx: number
  /** Width hint — keep description from wrapping. */
  maxWidth?: number
}

/**
 * Compact dropdown rendered above the input box when the user is typing a
 * slash command. Selected row is highlighted; arrow keys + Tab/Enter to
 * complete are handled by InputBox.
 */
export function SlashSuggest({ items, selectedIdx, maxWidth = 80 }: Props): React.ReactElement | null {
  if (items.length === 0) return null
  // Cap rendered rows to keep the popup small.
  const MAX_ROWS = 8
  const visible = items.slice(0, MAX_ROWS)
  const truncated = items.length > MAX_ROWS

  // Column widths: pad slashName to the longest visible slash for alignment.
  const slashCol = Math.max(...visible.map((i) => i.slashName.length))
  const argCol = Math.max(0, ...visible.map((i) => (i.argHint ?? '').length))
  const descMax = Math.max(20, maxWidth - slashCol - argCol - 6)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {visible.map((item, i) => {
        const selected = i === selectedIdx
        const slashPad = item.slashName.padEnd(slashCol, ' ')
        const arg = item.argHint ? ` ${item.argHint.padEnd(argCol, ' ')}` : (argCol > 0 ? ' '.repeat(argCol + 1) : '')
        const desc = item.description.length > descMax
          ? item.description.slice(0, descMax - 1) + '…'
          : item.description
        return (
          <Box key={item.slashName}>
            <Text color={selected ? 'black' : 'cyan'} backgroundColor={selected ? 'cyan' : undefined} bold={selected}>
              {`${selected ? '▶ ' : '  '}${slashPad}`}
            </Text>
            <Text color="gray" dimColor>{arg}</Text>
            <Text color={selected ? 'white' : 'gray'} dimColor={!selected}>{`  ${desc}`}</Text>
          </Box>
        )
      })}
      {truncated ? (
        <Text color="gray" dimColor>{`  … +${items.length - MAX_ROWS} more (keep typing to filter)`}</Text>
      ) : null}
    </Box>
  )
}
