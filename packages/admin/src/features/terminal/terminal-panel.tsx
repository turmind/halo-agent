'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { wsClient } from '@/shared/ws-client'
import { getBrowserId } from '@/shared/browser-id'
import { useProjectStore } from '@/shared/stores/project-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { useTheme, type Theme } from '@/shared/theme'
import { Plus, X, Terminal as TerminalIcon } from 'lucide-react'
import { cn } from '@/shared/utils'
import '@xterm/xterm/css/xterm.css'

interface TermInstance {
  id: string
  name: string
  term: XTerm
  fit: FitAddon
  container: HTMLDivElement
  ready: boolean
  exited: boolean
}

let termCounter = 0

// One ANSI palette per app theme (xterm can't read CSS variables — it paints
// to canvas). Light/warm map normal colors to Tailwind 700-shades and bright
// to 600 so all 16 stay readable on a pale background (500-level yellows and
// greens wash out); `white` follows the VS Code Light convention of a
// mid-gray, since programs print "white" expecting it visible on the default
// background.
const XTERM_THEMES: Record<Theme, ITheme> = {
  dark: {
    background: '#0a0a0a',
    foreground: '#e4e4e7',
    cursor: '#e4e4e7',
    cursorAccent: '#0a0a0a',
    selectionBackground: '#27272a',
    black: '#18181b',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e4e4e7',
    brightBlack: '#52525b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa',
  },
  light: {
    background: '#ffffff',
    foreground: '#171717',
    cursor: '#171717',
    cursorAccent: '#ffffff',
    selectionBackground: '#bfdbfe',
    black: '#262626',
    red: '#b91c1c',
    green: '#15803d',
    yellow: '#a16207',
    blue: '#1d4ed8',
    magenta: '#7e22ce',
    cyan: '#0e7490',
    white: '#525252',
    brightBlack: '#737373',
    brightRed: '#dc2626',
    brightGreen: '#16a34a',
    brightYellow: '#ca8a04',
    brightBlue: '#2563eb',
    brightMagenta: '#9333ea',
    brightCyan: '#0891b2',
    brightWhite: '#a3a3a3',
  },
  midnight: {
    background: '#0b1220',
    foreground: '#dbe4f3',
    cursor: '#dbe4f3',
    cursorAccent: '#0b1220',
    selectionBackground: '#1e2a47',
    black: '#16213a',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#dbe4f3',
    brightBlack: '#64769b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f1f5fb',
  },
  warm: {
    background: '#f6f1e7',
    foreground: '#3d3427',
    cursor: '#3d3427',
    cursorAccent: '#f6f1e7',
    selectionBackground: '#e6dabf',
    black: '#292524',
    red: '#b91c1c',
    green: '#15803d',
    yellow: '#a16207',
    blue: '#1d4ed8',
    magenta: '#7e22ce',
    cyan: '#0e7490',
    white: '#57534e',
    brightBlack: '#78716c',
    brightRed: '#dc2626',
    brightGreen: '#16a34a',
    brightYellow: '#ca8a04',
    brightBlue: '#2563eb',
    brightMagenta: '#9333ea',
    brightCyan: '#0891b2',
    brightWhite: '#a8a29e',
  },
}

const XTERM_OPTIONS = {
  fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Monaco, monospace",
  fontSize: 13,
  lineHeight: 1.4,
  cursorBlink: true,
  scrollback: 10000,
}

interface TerminalPanelProps {
  headerless?: boolean
  cwd?: string
}

export function TerminalPanel({ headerless, cwd: customCwd }: TerminalPanelProps = {}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const instancesRef = useRef<Map<string, TermInstance>>(new Map())
  const [tabs, setTabs] = useState<{ id: string; name: string }[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeProject = useProjectStore((s) => s.activeProject)
  const { theme } = useTheme()

  // Theme plumbing: a ref so the terminal-creating closures (createTerminal,
  // reattach handler) read the current palette without taking `theme` as a
  // dep — their identity/lifecycles predate theming and shouldn't churn on a
  // theme switch. Existing instances re-paint via xterm's options setter.
  const themeRef = useRef(theme)
  useEffect(() => {
    themeRef.current = theme
    for (const inst of instancesRef.current.values()) {
      inst.term.options.theme = XTERM_THEMES[theme]
    }
  }, [theme])

  // Create a new terminal instance.
  // `explicitCwd` (when provided) overrides every fallback below — used by
  // the Explorer's "Open in Integrated Terminal" action to spawn a fresh
  // tab in the right-clicked dir even when the panel already has tabs.
  const createTerminal = useCallback((explicitCwd?: string) => {
    const host = hostRef.current
    if (!host) return

    termCounter++
    const id = `term_${Date.now().toString(36)}_${termCounter}`
    const name = tabs.length === 0 ? 'bash' : `bash (${termCounter})`

    const container = document.createElement('div')
    container.className = 'absolute inset-0'
    container.style.display = 'none'
    host.appendChild(container)

    const term = new XTerm({ ...XTERM_OPTIONS, theme: XTERM_THEMES[themeRef.current] })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    // Input → server
    term.onData((data) => {
      wsClient.send({ type: 'terminal:input', data, terminalId: id })
    })

    const inst: TermInstance = { id, name, term, fit, container, ready: false, exited: false }
    instancesRef.current.set(id, inst)

    // Resize observer
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      fit.fit()
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        wsClient.send({ type: 'terminal:resize', cols: term.cols, rows: term.rows, terminalId: id })
      }, 150)
    })
    ro.observe(container)

    // Start on server — prefer explicit cwd (right-click "Open in Terminal"),
    // then panel-level customCwd (e.g. skill dir), then project path, then
    // URL folder param, then home dir.
    const folderParam = new URLSearchParams(window.location.search).get('folder')
    const cwd = explicitCwd ?? customCwd ?? activeProject?.path ?? folderParam ?? '~'
    wsClient.send({
      type: 'terminal:start',
      terminalId: id,
      cwd,
      cols: term.cols,
      rows: term.rows,
      browserId: getBrowserId(),
      workspacePath: activeProject?.path ?? '',
    })

    setTabs((prev) => [...prev, { id, name }])
    setActiveId(id)

    return id
  }, [activeProject, tabs.length, customCwd])

  // Close a terminal
  const closeTerminal = useCallback((id: string) => {
    const inst = instancesRef.current.get(id)
    if (!inst) return

    wsClient.send({ type: 'terminal:close', terminalId: id })
    inst.term.dispose()
    inst.container.remove()
    instancesRef.current.delete(id)

    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      setActiveId((currentActive) => {
        if (currentActive === id) {
          // Switch to adjacent tab
          const idx = prev.findIndex((t) => t.id === id)
          return next[Math.min(idx, next.length - 1)]?.id ?? null
        }
        return currentActive
      })
      return next
    })
  }, [])

  // Switch active terminal
  const switchTo = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  // Show/hide containers based on active ID
  useEffect(() => {
    for (const [id, inst] of instancesRef.current) {
      const visible = id === activeId
      inst.container.style.display = visible ? 'block' : 'none'
      if (visible) {
        inst.fit.fit()
        inst.term.focus()
      }
    }
  }, [activeId])

  // Listen for server messages
  useEffect(() => {
    const unsubs: Array<() => void> = []

    unsubs.push(wsClient.on('terminal:output', (msg) => {
      const { terminalId, data } = msg as { terminalId?: string; data: string }
      // Route to correct instance
      if (terminalId) {
        instancesRef.current.get(terminalId)?.term.write(data)
      } else {
        // Legacy: write to first terminal
        const first = instancesRef.current.values().next().value as TermInstance | undefined
        first?.term.write(data)
      }
    }))

    unsubs.push(wsClient.on('terminal:ready', (msg) => {
      const { terminalId } = msg as { terminalId?: string }
      if (terminalId) {
        const inst = instancesRef.current.get(terminalId)
        if (inst) inst.ready = true
      }
    }))

    unsubs.push(wsClient.on('terminal:exit', (msg) => {
      const { terminalId } = msg as { terminalId?: string }
      if (terminalId) {
        const inst = instancesRef.current.get(terminalId)
        if (inst) {
          inst.exited = true
          inst.term.writeln('\r\n\x1b[90m[Process exited]\x1b[0m')
        }
      }
    }))

    return () => unsubs.forEach((u) => u())
  }, [])

  // Reattach handling — runs on first mount AND on every WS reconnect.
  // Two scenarios funnel through the same `terminal:reattached` listener:
  //   - First mount (page load, no local xterm yet): server's detached pool
  //     becomes the source of truth, we build local xterm instances for each id.
  //   - Reconnect (local xterm still alive): we just resync size; the existing
  //     instance picks up new output via the live channel.
  // If the server reports zero ids AND we have nothing locally, fall through to
  // createTerminal. If we already have local instances and server has nothing,
  // do nothing — those tabs are already showing `[Process exited]` from grace
  // expiry, and silently replacing them would lose the user's scrollback.
  const mountedRef = useRef(false)
  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true

    const unsubReattached = wsClient.on('terminal:reattached', (msg) => {
      const ids = (msg as { terminalIds: string[] }).terminalIds
      const host = hostRef.current
      let firstNewIndex = 0
      for (const id of ids) {
        if (instancesRef.current.has(id)) {
          // Already alive locally — resync size in case the window resized
          // while disconnected.
          const existing = instancesRef.current.get(id)!
          wsClient.send({ type: 'terminal:resize', cols: existing.term.cols, rows: existing.term.rows, terminalId: id })
          continue
        }
        if (!host) continue

        termCounter++
        const name = firstNewIndex === 0 && instancesRef.current.size === 0 ? 'bash' : `bash (${termCounter})`
        firstNewIndex++

        const container = document.createElement('div')
        container.className = 'absolute inset-0'
        container.style.display = 'none'
        host.appendChild(container)

        const term = new XTerm({ ...XTERM_OPTIONS, theme: XTERM_THEMES[themeRef.current] })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(container)
        fit.fit()

        // Resync bracketed paste mode (DECSET 2004). Bash readline enabled it
        // when the PTY's current prompt was drawn — but that sequence went to
        // the previous xterm instance, destroyed with the old page. A fresh
        // instance starts with the flag off, so a multi-line paste would be
        // fed to the shell unbracketed and execute line by line. Writing the
        // sequence here only flips xterm's internal flag (no visible output,
        // nothing sent to the PTY); bash keeps it in sync from the next
        // prompt onward.
        term.write('\x1b[?2004h')

        term.onData((data) => {
          wsClient.send({ type: 'terminal:input', data, terminalId: id })
        })

        let resizeTimer: ReturnType<typeof setTimeout> | null = null
        const ro = new ResizeObserver(() => {
          fit.fit()
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => {
            wsClient.send({ type: 'terminal:resize', cols: term.cols, rows: term.rows, terminalId: id })
          }, 150)
        })
        ro.observe(container)

        const inst: TermInstance = { id, name, term, fit, container, ready: true, exited: false }
        instancesRef.current.set(id, inst)
        setTabs((prev) => [...prev, { id, name }])
        setActiveId((prev) => prev ?? id)
        wsClient.send({ type: 'terminal:resize', cols: term.cols, rows: term.rows, terminalId: id })
      }

      if (ids.length === 0 && instancesRef.current.size === 0) {
        createTerminal()
      }
    })

    // Send reattach on initial connect AND every subsequent reconnect.
    // Scope reattach to (this browser × current workspace) so other
    // browsers / other workspaces' PTYs aren't pulled into this tab.
    const sendReattach = () => {
      wsClient.send({
        type: 'terminal:reattach' as never,
        browserId: getBrowserId(),
        workspacePath: activeProject?.path ?? '',
      } as never)
    }
    sendReattach()
    const unsubConnected = wsClient.on('_connected', sendReattach)

    // Fallback for first-mount only: if no reattached response within 2s and
    // we still have nothing, create a fresh terminal so the tab isn't blank.
    const fallback = setTimeout(() => {
      if (instancesRef.current.size === 0) createTerminal()
    }, 2000)

    return () => {
      clearTimeout(fallback)
      unsubReattached()
      unsubConnected()
    }
  }, [createTerminal])

  // Watch for "open in integrated terminal" requests from the Explorer.
  // Subscribe to the store and consume the pending cwd in a one-shot:
  // every transition from null → string spawns a new terminal at that cwd.
  useEffect(() => {
    let lastCwd: string | null = useEditorStore.getState().pendingTerminalCwd
    return useEditorStore.subscribe((state) => {
      const cur = state.pendingTerminalCwd
      if (cur && cur !== lastCwd) {
        lastCwd = cur
        const cwd = state.consumeTerminalSpawn()
        if (cwd) createTerminal(cwd)
      } else {
        lastCwd = cur
      }
    })
  }, [createTerminal])

  return (
    // Wrapper matches each xterm palette's `background`, which is pinned to
    // the theme's --background — no seam around the canvas.
    <div className="flex h-full min-h-0 bg-[var(--background)]">
      {/* Terminal host — main area */}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden" />

      {/* Right sidebar — terminal list */}
      <div className="flex w-[160px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--card)]">
        <div className="flex-1 overflow-y-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => switchTo(tab.id)}
              className={cn(
                'group flex items-center gap-1.5 px-2 py-1.5 text-[11px] cursor-pointer select-none',
                tab.id === activeId
                  ? 'bg-[var(--secondary)] text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]/50',
              )}
            >
              <TerminalIcon className="h-3 w-3 shrink-0" />
              <span className="flex-1 truncate">{tab.name}</span>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); closeTerminal(tab.id) }}
                  className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[var(--accent)]"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => createTerminal()}
          className="flex items-center gap-1.5 border-t border-[var(--border)] px-2 py-1.5 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]/50"
          title="New Terminal"
        >
          <Plus className="h-3 w-3" />
          <span>New Terminal</span>
        </button>
      </div>
    </div>
  )
}
