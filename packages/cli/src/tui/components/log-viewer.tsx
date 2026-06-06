import React, { useState, useMemo, useEffect, useRef } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'

export interface LogLine {
  /** Pre-formatted, ANSI-colored single line. */
  text: string
}

interface Props {
  /** Header line — usually "session <id> · <agentName>". */
  title: string
  /** Lines to display. Wrapping is the caller's responsibility — long lines are truncated.
   *  May grow (or shrink, on compact) over time while the viewed session runs —
   *  the viewport follows the bottom unless the user has scrolled up. */
  lines: LogLine[]
  /** Whether the viewed session is still running — surfaces a `● live` hint
   *  in the footer so the user knows the log auto-refreshes. */
  live?: boolean
  /** Called on q / Esc. */
  onClose: () => void
}

/**
 * vi-like full-viewport log viewer. Replaces the input box while open.
 *
 * Keys:
 *   j / ↓        scroll down 1 line
 *   k / ↑        scroll up 1 line
 *   d / Ctrl+f   page down (half-screen)
 *   u / Ctrl+b   page up
 *   g            jump to top
 *   G            jump to bottom
 *   q / Esc      close
 */
export function LogViewer({ title, lines, live, onClose }: Props): React.ReactElement {
  const { stdout } = useStdout()
  // Reserve rows: 1 header + 1 footer + 1 spacer = 3. Leave some breathing room
  // for the chat area above (approx 6 rows total taken by the rest of the App).
  const viewportRows = Math.max(8, (stdout?.rows ?? 30) - 14)
  const cols = Math.max(40, (stdout?.columns ?? 100) - 4)

  // Open at the bottom (most recent), mirroring the admin chat the user asked
  // this to match: a live log is opened to watch the tail, and starting at the
  // bottom is also what arms the follow-the-bottom behavior below (top===maxTop
  // → wasAtBottom). `g` jumps to the top to read from the start.
  const [top, setTop] = useState(() => Math.max(0, lines.length - viewportRows))

  const maxTop = Math.max(0, lines.length - viewportRows)

  // maxTop as of the previous render — i.e. before the log grew/shrank. The
  // effect compares the *current* top against this old bound to decide whether
  // the user was sitting at the bottom before the change (can't compare to the
  // new maxTop: top hasn't moved yet, so it'd read as "not at bottom" the
  // instant the log grows). TUI analogue of admin's `wasAtBottom` ref.
  const prevMaxTopRef = useRef(maxTop)

  // Follow the bottom as the log grows while a session streams in — but only
  // if the user was already at the bottom. If they scrolled up to read, leave
  // `top` put (just clamp it when the log *shrinks*, e.g. after a compact).
  useEffect(() => {
    const wasAtBottom = top >= prevMaxTopRef.current
    if (wasAtBottom) {
      if (top !== maxTop) setTop(maxTop)
    } else if (top > maxTop) {
      setTop(maxTop)
    }
    prevMaxTopRef.current = maxTop
    // top is read intentionally without subscribing — we only re-evaluate when
    // the line count / viewport changes, using whatever top is current then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length, maxTop])

  const halfPage = Math.max(1, Math.floor(viewportRows / 2))

  useInput((input, key) => {
    if (key.escape || input === 'q') { onClose(); return }
    if (input === 'j' || key.downArrow) { setTop((t) => Math.min(maxTop, t + 1)); return }
    if (input === 'k' || key.upArrow) { setTop((t) => Math.max(0, t - 1)); return }
    if (input === 'd' || (key.ctrl && input === 'f') || key.pageDown) {
      setTop((t) => Math.min(maxTop, t + halfPage)); return
    }
    if (input === 'u' || (key.ctrl && input === 'b') || key.pageUp) {
      setTop((t) => Math.max(0, t - halfPage)); return
    }
    if (input === 'g') { setTop(0); return }
    if (input === 'G') { setTop(maxTop); return }
  })

  const visible = useMemo(() => lines.slice(top, top + viewportRows), [lines, top, viewportRows])
  const bottom = Math.min(lines.length, top + viewportRows)
  const pct = lines.length === 0 ? 100 : Math.round((bottom / lines.length) * 100)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan">
      <Box paddingX={1}>
        <Text color="cyan" bold>{title}</Text>
        {live && <Text color="green"> ● live</Text>}
      </Box>
      <Box flexDirection="column" paddingX={1} height={viewportRows}>
        {visible.length === 0 ? (
          <Text color="gray" dimColor>(empty)</Text>
        ) : (
          visible.map((line, i) => (
            <Text key={top + i}>{truncateForCols(line.text, cols)}</Text>
          ))
        )}
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Text color="gray" dimColor>
          {`${top + 1}-${bottom} / ${lines.length}  (${pct}%)`}
        </Text>
        <Text color="gray" dimColor>j/k  d/u  g/G  q to close</Text>
      </Box>
    </Box>
  )
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

/** Hard-cut a single line to fit terminal width, counting only visible chars
 *  (ANSI escape sequences don't take screen space). Preserves all escapes
 *  encountered before the cutoff so colors render correctly, then resets. */
function truncateForCols(s: string, cols: number): string {
  let visible = 0
  let i = 0
  while (i < s.length && visible < cols) {
    ANSI_RE.lastIndex = i
    const match = ANSI_RE.exec(s)
    if (match && match.index === i) {
      i = ANSI_RE.lastIndex
      continue
    }
    visible++
    i++
  }
  if (i >= s.length) return s
  // Cut and re-terminate any open color.
  return s.slice(0, i - 1) + '…\x1b[0m'
}
