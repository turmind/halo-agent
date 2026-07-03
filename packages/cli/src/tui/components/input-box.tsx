import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import { SlashSuggest, type SlashItem } from './slash-suggest.js'
import { PathSuggest, type PathItem } from './path-suggest.js'
import { detectActiveRef, scanCandidates, applyPathPick } from '../path-suggest-engine.js'
import { TextInputView } from './text-input.js'
import {
  type EditState,
  graphemeLength,
  toGraphemes,
  insertAt,
  backspaceAt,
  deleteAt,
  deleteWordBefore,
  deleteToStart,
  deleteToEnd,
} from '../line-editor.js'

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
  // they type a space, they're entering args (the verb stage below takes
  // over for object commands).
  const firstSpace = rawValue.indexOf(' ')
  if (firstSpace !== -1) return []
  const prefix = rawValue.toLowerCase()
  const matches = items.filter((c) => c.slashName.toLowerCase().startsWith(prefix))
  // Typed value already IS the only match → nothing left to complete. Keeping
  // the popup open would make Enter "complete" instead of submit, forcing a
  // double-Enter on exact commands like /quit.
  if (matches.length === 1 && matches[0]!.slashName.toLowerCase() === prefix) return []
  return matches
}

/** Second stage: `/cmd <partial-verb>` → suggest the object command's verbs.
 *  Active only when the command word matches exactly and the cursor is in the
 *  first argument token. Rendered through the same SlashSuggest dropdown by
 *  mapping each verb to a pseudo SlashItem (`/cmd verb`). */
function filterVerbs(items: SlashItem[], rawValue: string): SlashItem[] {
  const m = rawValue.match(/^(\/\S+)\s+(\S*)$/)
  if (!m) return []
  const cmd = items.find((c) => c.slashName.toLowerCase() === m[1].toLowerCase())
  if (!cmd?.verbs?.length) return []
  const partial = m[2].toLowerCase()
  return cmd.verbs
    .filter((v) => v.name.startsWith(partial) && v.name !== partial)
    .map((v) => ({ slashName: `${cmd.slashName} ${v.name}`, description: v.desc ?? '' }))
}

/**
 * The TUI's own line editor (replaced ink-text-input). One useInput handler
 * owns everything — popup navigation, history, cursor movement, readline
 * chords, printable insertion — so unrecognized chords are swallowed instead
 * of leaking into the value as literal letters (the old "Ctrl+W types a w"
 * bug), and the caret is a first-class grapheme index we can insert at
 * (typing AND pasting land at the cursor, not appended at the end). The
 * cursorKey remount hack died with ink-text-input.
 */
export function InputBox({ enabled, placeholder, history, onSubmit, hint, commands = [], workspace }: Props): React.ReactElement {
  const [edit, setEdit] = useState<EditState>({ value: '', cursor: 0 })
  const { value, cursor } = edit
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)
  const [suggestIdx, setSuggestIdx] = useState(0)
  const [pathIdx, setPathIdx] = useState(0)
  /** Esc closes the suggest/path popup without touching the typed text. The
   *  popups are otherwise derived from `value`, so "closed" needs its own
   *  flag; any edit re-arms them (standard IDE dismiss semantics). Pure
   *  cursor movement is not an edit and keeps a dismissed popup closed. */
  const [popupDismissed, setPopupDismissed] = useState(false)
  const draftRef = useRef('')

  /** All content edits funnel through here: re-arms a popup dismissed with
   *  Esc. Cursor-only moves call setEdit directly and skip the re-arm. */
  const applyEdit = (updater: (e: EditState) => EditState) => {
    setEdit(updater)
    setPopupDismissed(false)
  }
  const setValueJumpEnd = (v: string) => applyEdit(() => ({ value: v, cursor: graphemeLength(v) }))

  // Multi-line paste support. usePaste enables bracketed paste mode, so a
  // paste arrives as ONE string instead of per-char key events (which made
  // every \n submit the line and shredded the paste). Multi-line/huge pastes
  // are held in this map and shown as a compact `[#n pasted N lines]`
  // placeholder — the input box stays one line tall — then expanded back to
  // the real content at submit time. Pastes insert at the caret.
  const pendingPastes = useRef<Map<number, string>>(new Map())
  const pasteSeq = useRef(0)
  usePaste((text) => {
    const normalized = text.replace(/\r\n?/g, '\n')
    let insertion: string
    if (normalized.includes('\n') || normalized.length > 800) {
      const id = ++pasteSeq.current
      pendingPastes.current.set(id, normalized)
      const n = normalized.split('\n').length
      insertion = `[#${id} pasted ${n} ${n === 1 ? 'line' : 'lines'}] `
    } else {
      insertion = normalized
    }
    // Functional update — the paste handler may fire between renders, so
    // don't close over a possibly-stale edit state.
    applyEdit((e) => insertAt(e, insertion))
  }, { isActive: enabled })
  const expandPastes = (v: string): string =>
    v.replace(/\[#(\d+) pasted \d+ lines?\]/g, (m, id) => pendingPastes.current.get(Number(id)) ?? m)

  const cmdMatches = useMemo(() => filterCommands(commands, value), [commands, value])
  const verbMatches = useMemo(() => filterVerbs(commands, value), [commands, value])
  const filtered = cmdMatches.length > 0 ? cmdMatches : verbMatches
  const suggestOpen = filtered.length > 0 && !popupDismissed

  // @file/@image path completion. Detection runs on the text BEFORE the
  // caret, so the popup follows where you're actually typing (a finished ref
  // later in the line doesn't reopen it) and a pick rewrites the right span.
  const beforeCursor = useMemo(() => toGraphemes(value).slice(0, cursor).join(''), [value, cursor])
  const afterCursor = value.slice(beforeCursor.length)
  const activeRef = useMemo(() => detectActiveRef(beforeCursor), [beforeCursor])
  const pathScan = useMemo(() => {
    if (!activeRef) return { items: [], cwdLabel: '' }
    return scanCandidates(activeRef.partial, workspace, activeRef.kind)
  }, [activeRef, workspace])
  const pathOpen = !!activeRef && pathScan.items.length > 0 && !popupDismissed

  // Clamp suggest cursor when the filtered list shrinks.
  useEffect(() => {
    if (suggestIdx >= filtered.length) setSuggestIdx(0)
  }, [filtered.length, suggestIdx])
  useEffect(() => {
    if (pathIdx >= pathScan.items.length) setPathIdx(0)
  }, [pathScan.items.length, pathIdx])

  /** Replace the in-flight @ref before the caret with the picked path; the
   *  text after the caret stays put. */
  const applyPick = (pick: PathItem) => {
    if (!activeRef) return
    const newPrefix = applyPathPick(beforeCursor, activeRef, pick)
    applyEdit(() => ({ value: newPrefix + afterCursor, cursor: graphemeLength(newPrefix) }))
    setPathIdx(0)
  }

  /** Submit `v` (popup semantics NOT applied — see handleEnter for those). */
  const submitValue = (v: string) => {
    if (!v.trim()) return
    setValueJumpEnd('')
    setHistoryIdx(null)
    setSuggestIdx(0)
    setPathIdx(0)
    draftRef.current = ''
    const expanded = expandPastes(v)
    pendingPastes.current.clear()
    onSubmit(expanded)
  }

  const handleEnter = () => {
    // If a popup is showing, Enter completes the selection rather than
    // submitting — consistent with how most CLIs handle suggest menus.
    if (suggestOpen) {
      const pick = filtered[suggestIdx]
      if (pick) {
        setValueJumpEnd(pick.slashName + ' ')
        setSuggestIdx(0)
      }
      return
    }
    if (pathOpen) {
      const pick = pathScan.items[pathIdx]
      if (pick) applyPick(pick)
      return
    }
    submitValue(value)
  }

  useInput((input, key) => {
    // Burst chunk: multi-char input with an embedded newline means text and
    // Enter arrived faster than one stdin read — type-ahead during a busy
    // moment, or automation (`tmux send-keys "msg" Enter` lands as "msg\r").
    // A lone Enter parses as key.return and never takes this path. Insert
    // the part before the first newline, submit once (literal text — no
    // popup completion; automation wants what it typed), and keep the tail
    // in the editor. Later newlines collapse to spaces: submitting a chunk
    // at every newline is exactly how unbracketed pastes used to shred.
    if (input.length > 1 && /[\r\n]/.test(input) && !key.ctrl && !key.meta) {
      const nl = input.search(/[\r\n]/)
      const head = input.slice(0, nl)
      let tail = input.slice(nl + 1)
      if (input[nl] === '\r' && tail.startsWith('\n')) tail = tail.slice(1) // CRLF
      tail = tail.replace(/[\r\n]+/g, ' ')
      const merged = insertAt({ value, cursor }, head)
      if (merged.value.trim()) {
        submitValue(merged.value)
        if (tail.trim()) applyEdit(() => ({ value: tail, cursor: graphemeLength(tail) }))
      } else if (tail.trim()) {
        applyEdit(() => insertAt(merged, tail))
      }
      return
    }

    // Enter next — its meaning depends on popup state. A lone linefeed
    // (Ctrl+J; \r is key.return) is Enter by terminal convention.
    if (key.return || input === '\n') {
      handleEnter()
      return
    }

    // Popup navigation. Slash popup wins when both could be open (you can't
    // be typing a slash command and a path ref at the same time anyway, but
    // be explicit). Other keys fall through to normal editing so typing and
    // backspace keep refining the filter while the popup is open.
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
          setValueJumpEnd(pick.slashName + ' ')
          setSuggestIdx(0)
        }
        return
      }
      if (key.escape) {
        // Close the popup only — keep the typed text (Esc used to clear the
        // whole input, nuking a long draft just to dismiss the menu).
        setPopupDismissed(true)
        setSuggestIdx(0)
        return
      }
    } else if (pathOpen) {
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
        if (pick) applyPick(pick)
        return
      }
      // Esc closes the popup only — the typed partial stays (it may be a
      // complete path the user typed by hand; deleting it was hostile).
      if (key.escape) {
        setPopupDismissed(true)
        setPathIdx(0)
        return
      }
    } else {
      // No popup: ↑↓ walks history.
      if (key.upArrow) {
        if (history.length === 0) return
        if (historyIdx === null) {
          draftRef.current = value
          const idx = history.length - 1
          setHistoryIdx(idx)
          setValueJumpEnd(history[idx]!)
        } else if (historyIdx > 0) {
          const idx = historyIdx - 1
          setHistoryIdx(idx)
          setValueJumpEnd(history[idx]!)
        }
        return
      }
      if (key.downArrow) {
        if (historyIdx === null) return
        if (historyIdx < history.length - 1) {
          const idx = historyIdx + 1
          setHistoryIdx(idx)
          setValueJumpEnd(history[idx]!)
        } else {
          setHistoryIdx(null)
          setValueJumpEnd(draftRef.current)
        }
        return
      }
    }

    // Cursor movement — not an edit, so it doesn't re-arm a dismissed popup.
    if (key.leftArrow) {
      setEdit((e) => ({ ...e, cursor: Math.max(0, e.cursor - 1) }))
      return
    }
    if (key.rightArrow) {
      setEdit((e) => ({ ...e, cursor: Math.min(graphemeLength(e.value), e.cursor + 1) }))
      return
    }
    if (key.home || (key.ctrl && input === 'a')) {
      setEdit((e) => ({ ...e, cursor: 0 }))
      return
    }
    if (key.end || (key.ctrl && input === 'e')) {
      setEdit((e) => ({ ...e, cursor: graphemeLength(e.value) }))
      return
    }

    // Deletion. Alt+Backspace is word-rubout like readline.
    if (key.backspace) {
      applyEdit(key.meta ? deleteWordBefore : backspaceAt)
      return
    }
    if (key.delete) {
      applyEdit(deleteAt)
      return
    }
    if (key.ctrl && input === 'w') {
      applyEdit(deleteWordBefore)
      return
    }
    if (key.ctrl && input === 'u') {
      applyEdit(deleteToStart)
      return
    }
    if (key.ctrl && input === 'k') {
      applyEdit(deleteToEnd)
      return
    }

    // Swallow every other chord / non-printable. Unrecognized Ctrl/Meta
    // combos used to leak into ink-text-input as literal letters ("Ctrl+W
    // typed a w"); now they're safe no-ops. Ctrl+C/Ctrl+O/Esc-interrupt are
    // handled by the app-level useInput, which runs regardless.
    if (key.ctrl || key.meta || key.escape || key.tab) return
    if (input.length === 0) return

    // Printable insert at the caret. Input may be >1 char (IME-composed CJK,
    // unbracketed-paste fragments); strip stray CR/LF so a fragment can't
    // fake a newline in the single-line editor.
    const clean = input.replace(/[\r\n]+/g, ' ')
    applyEdit((e) => insertAt(e, clean))
  }, { isActive: enabled })

  // Reset history-cursor when the user starts editing again from scratch.
  useEffect(() => {
    if (historyIdx !== null && value === '') setHistoryIdx(null)
  }, [value, historyIdx])

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
            <TextInputView value={value} cursor={cursor} placeholder={placeholder} />
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
