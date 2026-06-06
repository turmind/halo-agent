import React from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'

interface ActiveSub {
  taskId: string
  agentName: string
  toolCount: number
  currentTool: string | null
}

interface Props {
  spinnerLabel: string | null
  liveText: string
  liveThinking: string | null
  activeSubs: ActiveSub[]
}

/**
 * The "in-flight turn" zone — re-renders on every token. Sits between the
 * static history and the input box.
 */
export function Streaming({ spinnerLabel, liveText, liveThinking, activeSubs }: Props): React.ReactElement | null {
  const hasContent = spinnerLabel || liveText || liveThinking || activeSubs.length > 0
  if (!hasContent) return null

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      {liveThinking ? (
        <Box marginBottom={liveText ? 1 : 0}>
          <Text color="gray" dimColor>{liveThinking}</Text>
        </Box>
      ) : null}

      {liveText ? (
        <Box flexDirection="row">
          <Box marginRight={1}><Text color="cyan">┃</Text></Box>
          <Box flexGrow={1}><Text>{liveText}</Text></Box>
        </Box>
      ) : null}

      {activeSubs.map((sub) => (
        <Box key={sub.taskId}>
          <Text color="blue"><Spinner type="dots" /></Text>
          <Text color="blue">{` ${sub.agentName}`}</Text>
          <Text color="gray" dimColor>
            {sub.currentTool ? ` · ${sub.currentTool}` : ''}
            {` · ${sub.toolCount} tool${sub.toolCount === 1 ? '' : 's'}`}
          </Text>
        </Box>
      ))}

      {spinnerLabel && activeSubs.length === 0 ? (
        <Box>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text color="gray" dimColor>{` ${spinnerLabel}`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
