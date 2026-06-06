import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  agentName: string
  modelId: string | null
  contextPercent: number | null
  workspace: string
  sessionId: string
  verbose: boolean
}

function shortModel(modelId: string): string {
  return modelId
    .replace(/^global\.anthropic\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-\d{8}$/, '')
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? ''
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

export function StatusBar({ agentName, modelId, contextPercent, workspace, sessionId, verbose }: Props): React.ReactElement {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text color="green">{agentName}</Text>
        {modelId ? (
          <>
            <Text color="gray" dimColor>·</Text>
            <Text color="cyan">{shortModel(modelId)}</Text>
          </>
        ) : null}
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
