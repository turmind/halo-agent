import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { SlashSuggest, type SlashItem } from './slash-suggest.js'
import { PathSuggest } from './path-suggest.js'
import { detectActiveRef, scanCandidates, applyPathPick } from '../path-suggest-engine.js'

interface Props {
  /** When false, the input is disabled (e.g. during a running turn). */
  enabled: boolean
  placeholder: string
  /** Up/down history navigation values, newest last. */
  history: string[]
  onSubmit: (value: string) => void
  /**
   * Hint text rendered to the right of the input — e.g. "/copy to clipboard"
   * or "esc to interrupt".
   */
  hint?: string
  /** Full list of slash commands for the auto-suggest popup. */
  commands?: SlashItem[]
  /** Workspace root, used for `@file` path completion. */
  workspace: string
}

/** Filter the command list by the typed slash prefix (case-insensitive). */
function filterCommands(items: SlashItem[], rawValue: string): SlashItem[] {
  if (!rawValue.startsWith('/')) return []
  // Only suggest while the user is still typing the *command word* — once
  // they type a space, they're entering args, not browsing commands.
  const firstSpace = rawValue.indexOf(' ')
  if (firstSpace !== -1) return []
  const prefix = rawValue.toLowerCase()
  return items.filter((c) => c.slashName.toLowerCase().startsWith(prefix))
}

export function InputBox({ enabled, placeholder, history, onSubmit, hint, commands = [], workspace }: Props): React.ReactElement {
  const [value, setValue] = useState('')
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)
  const [suggestIdx, setSuggestIdx] = useState(0)
  const [pathIdx, setPathIdx] = useState(0)
  const draftRef = useRef('')
  // Bumping this key force-remounts ink-text-input so its internal cursor
  // re-initializes to value.length. ink-text-input doesn't reposition its
  // cursor when the controlled `value` grows (only when it shrinks), so
  // tab-completion / history navigation would otherwise leave the caret
  // stranded in the middle of the new value.
  const [cursorKey, setCursorKey] = useState(0)
  const setValueAndJumpEnd = (v: string) => {
    setValue(v)
    setCursorKey((k) => k + 1)
  }

  const filtered = useMemo(() => filterCommands(commands, value), [commands, value])
  const suggestOpen = filtered.length > 0

  // @file/@image path completion. Recompute scan whenever the active partial
  // changes; cached by partial+kind for the lifetime of one keystroke.
  const activeRef = useMemo(() => detectActiveRef(value), [value])
  const pathScan = useMemo(() => {
    if (!activeRef) return { items: [], cwdLabel: '' }
    return scanCandidates(activeRef.partial, workspace, activeRef.kind)
  }, [activeRef, workspace])
  const pathOpen = !!activeRef && pathScan.items.length > 0

  // Clamp suggest cursor when the filtered list shrinks.
  useEffect(() => {
    if (suggestIdx >= filtered.length) setSuggestIdx(0)
  }, [filtered.length, suggestIdx])
  useEffect(() => {
    if (pathIdx >= pathScan.items.length) setPathIdx(0)
  }, [pathScan.items.length, pathIdx])

  useInput((_input, key) => {
    // Slash popup wins when both could be open (you can't be typing a slash
    // command and a path ref at the same time anyway, but be explicit).
    if (suggestOpen) {
      if (key.upArrow) {
        setSuggestIdx((i) => (i - 1 + filtered.length) % filtered.length)
        return
      }
      if (key.downArrow) {
        setSuggestIdx((i) => (i + 1) % filtered.length)
        return
      }
      if (key.tab) {
        const pick = filtered[suggestIdx]
        if (pick) {
          setValueAndJumpEnd(pick.slashName + ' ')
          setSuggestIdx(0)
        }
        return
      }
      if (key.escape) {
        setValue('')
        setSuggestIdx(0)
        return
      }
      return
    }

    // Path popup: ↑↓ moves, Tab completes (descends into dirs / closes on file).
    if (pathOpen && activeRef) {
      if (key.upArrow) {
        setPathIdx((i) => (i - 1 + pathScan.items.length) % pathScan.items.length)
        return
      }
      if (key.downArrow) {
        setPathIdx((i) => (i + 1) % pathScan.items.length)
        return
      }
      if (key.tab) {
        const pick = pathScan.items[pathIdx]
        if (pick) {
          setValueAndJumpEnd(applyPathPick(value, activeRef, pick))
          setPathIdx(0)
        }
        return
      }
      // Esc closes the popup by terminating the active partial — drop chars
      // back to the `@file ` prefix so we stop matching it.
      if (key.escape) {
        setValueAndJumpEnd(value.slice(0, activeRef.pathStart))
        setPathIdx(0)
        return
      }
      return
    }

    // No popup: ↑↓ walks history.
    if (key.upArrow) {
      if (history.length === 0) return
      if (historyIdx === null) {
        draftRef.current = value
        const idx = history.length - 1
        setHistoryIdx(idx)
        setValueAndJumpEnd(history[idx]!)
      } else if (historyIdx > 0) {
        const idx = historyIdx - 1
        setHistoryIdx(idx)
        setValueAndJumpEnd(history[idx]!)
      }
    } else if (key.downArrow) {
      if (historyIdx === null) return
      if (historyIdx < history.length - 1) {
        const idx = historyIdx + 1
        setHistoryIdx(idx)
        setValueAndJumpEnd(history[idx]!)
      } else {
        setHistoryIdx(null)
        setValueAndJumpEnd(draftRef.current)
      }
    }
  }, { isActive: enabled })

  // Reset history-cursor when the user starts editing again from scratch.
  useEffect(() => {
    if (historyIdx !== null && value === '') setHistoryIdx(null)
  }, [value, historyIdx])

  const handleSubmit = (v: string) => {
    // If a popup is showing, Enter completes the selection rather than
    // submitting — consistent with how most CLIs handle suggest menus.
    if (suggestOpen) {
      const pick = filtered[suggestIdx]
      if (pick) {
        setValueAndJumpEnd(pick.slashName + ' ')
        setSuggestIdx(0)
      }
      return
    }
    if (pathOpen && activeRef) {
      const pick = pathScan.items[pathIdx]
      if (pick) {
        setValueAndJumpEnd(applyPathPick(v, activeRef, pick))
        setPathIdx(0)
      }
      return
    }
    if (!v.trim()) return
    setValueAndJumpEnd('')
    setHistoryIdx(null)
    setSuggestIdx(0)
    setPathIdx(0)
    draftRef.current = ''
    onSubmit(v)
  }

  return (
    <Box flexDirection="column">
      {suggestOpen ? <SlashSuggest items={filtered} selectedIdx={suggestIdx} /> : null}
      {!suggestOpen && pathOpen ? (
        <PathSuggest items={pathScan.items} selectedIdx={pathIdx} cwdLabel={pathScan.cwdLabel} />
      ) : null}
      <Box flexDirection="column" borderStyle="round" borderColor={enabled ? 'cyan' : 'gray'} paddingX={1}>
        <Box>
          <Text color={enabled ? 'cyan' : 'gray'}>{'> '}</Text>
          {enabled ? (
            <TextInput
              key={cursorKey}
              value={value}
              placeholder={placeholder}
              onChange={setValue}
              onSubmit={handleSubmit}
              showCursor
            />
          ) : (
            <Text color="gray" dimColor>{placeholder}</Text>
          )}
        </Box>
        {hint ? (
          <Box justifyContent="flex-end">
            <Text color="gray" dimColor>{hint}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}
