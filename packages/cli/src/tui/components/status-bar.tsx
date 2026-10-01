import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  agentId: string
  contextPercent: number | null
  workspace: string
  sessionId: string
  verbose: boolean
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? ''
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

export function StatusBar({ agentId, contextPercent, workspace, sessionId, verbose }: Props): React.ReactElement {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text color="green">{agentId}</Text>
        {contextPercent != null ? (
          <>
            <Text color="gray" dimColor>·</Text>
            <Text color={contextPercent > 80 ? 'red' : contextPercent > 50 ? 'yellow' : 'green'}>
              {`◯ ${contextPercent}%`}
            </Text>
          </>
        ) : null}
        {verbose ? (
          <>
            <Text color="gray" dimColor>·</Text>
            <Text color="magenta">v</Text>
          </>
        ) : null}
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text color="magenta" dimColor>{shortPath(workspace)}</Text>
        <Text color="gray" dimColor>·</Text>
        <Text color="gray" dimColor>{sessionId.slice(-8)}</Text>
      </Box>
    </Box>
  )
}
