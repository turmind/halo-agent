import React, { useEffect, useState } from 'react'
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
  /** Epoch ms when the turn started — renders an elapsed counter next to the
   *  spinner so long tool runs don't look frozen. Null hides the counter. */
  turnStartedAt: number | null
}

/** Elapsed seconds since `since`, re-rendering once per second. The 1s
 *  interval is inherent to displaying a wall clock (there is no event to
 *  subscribe to) and only runs while a turn is active. Ticks start at 0 for
 *  each new `since` and advance inside the interval callback — render stays
 *  pure (no Date.now() during render). */
function useElapsedSeconds(since: number | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (since == null) return
    const t = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)))
    }, 1000)
    return () => {
      clearInterval(t)
      setElapsed(0)
    }
  }, [since])
  return elapsed
}

function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`
}

/**
 * The "in-flight turn" zone — re-renders on every token. Sits between the
 * static history and the input box.
 */
export function Streaming({ spinnerLabel, liveText, liveThinking, activeSubs, turnStartedAt }: Props): React.ReactElement | null {
  const elapsed = useElapsedSeconds((spinnerLabel || activeSubs.length > 0) ? turnStartedAt : null)
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
          {turnStartedAt != null && elapsed >= 3 ? (
            <Text color="gray" dimColor>{` · ${fmtElapsed(elapsed)}`}</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}
