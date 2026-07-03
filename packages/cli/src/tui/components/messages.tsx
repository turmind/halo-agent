import React from 'react'
import { Box, Static, Text } from 'ink'
import type { ChatBlock } from '../types.js'
import { formatUsageLine } from '../../format-usage.js'
import { Banner } from './banner.js'

interface Props {
  blocks: ChatBlock[]
}

/** Synthetic id used so the banner participates in <Static> as block 0. */
const BANNER_ID = '__banner__'

/**
 * Renders the committed chat history. Wrapped in <Static> so already-printed
 * blocks never re-render (they scroll naturally with the terminal). The banner
 * is the first item — it gets committed once on first render and then scrolls
 * up as the conversation grows.
 */
export function Messages({ blocks }: Props): React.ReactElement {
  const items: Array<{ id: string; block: ChatBlock | null }> =
    [{ id: BANNER_ID, block: null }, ...blocks.map((b) => ({ id: b.id, block: b }))]
  return (
    <Static items={items}>
      {(item) => item.block === null
        ? <Banner key={item.id} />
        : <Block key={item.id} block={item.block} />}
    </Static>
  )
}

function Block({ block }: { block: ChatBlock }): React.ReactElement {
  switch (block.kind) {
    case 'user':
      return (
        <Box flexDirection="row" marginTop={1} marginLeft={2}>
          <Text color="magentaBright" bold>{'> '}</Text>
          <Text>{block.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box flexDirection="row" marginTop={1} marginLeft={2}>
          <Box marginRight={1}>
            <Text color="cyan">┃</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text>{block.text}</Text>
          </Box>
        </Box>
      )
    case 'thinking':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="gray" dimColor>{block.text}</Text>
        </Box>
      )
    case 'tool':
      return (
        <Box flexDirection="column" marginLeft={2}>
          <Text color="yellow">
            ⚙ {block.toolName}
            {block.toolArg ? <Text color="gray" dimColor>{` ${block.toolArg}`}</Text> : null}
            {block.durationMs != null ? ` ${block.durationMs}ms` : ''}
          </Text>
          {block.toolInput ? (
            <Box marginLeft={2}>
              <Text color="gray" dimColor>{`args: ${block.toolInput}`}</Text>
            </Box>
          ) : null}
          {block.toolResult ? (
            <Box marginLeft={2} flexDirection="column">
              {block.toolResult.split('\n').map((line, i) => (
                <Text key={i} color="gray" dimColor>{`│ ${line}`}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    case 'usage':
      return (
        <Box marginLeft={2}>
          <Text dimColor>· {block.usage ? formatUsageLine(block.usage) : ''}</Text>
        </Box>
      )
    case 'system':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="cyan">{block.text}</Text>
        </Box>
      )
    case 'error':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="red">{block.text}</Text>
        </Box>
      )
    case 'sub-start':
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color="blue">{`╭─ ▶ ${block.subAgentName ?? 'sub'}`}</Text>
          {block.text ? <Text color="gray" dimColor>{` · ${block.text}`}</Text> : null}
        </Box>
      )
    case 'sub-done':
      return (
        <Box marginLeft={2}>
          <Text color="blue">{`╰─ ✓ ${block.subAgentName ?? 'sub'}`}</Text>
          <Text color="gray" dimColor>
            {` · ${block.subToolCount ?? 0} tool${(block.subToolCount ?? 0) === 1 ? '' : 's'}`}
            {block.durationMs != null ? ` · ${(block.durationMs / 1000).toFixed(1)}s` : ''}
          </Text>
        </Box>
      )
  }
}
