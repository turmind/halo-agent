'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { wsClient } from '@/shared/ws-client'
import { useProjectStore } from '@/shared/stores/project-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { useTheme, type Theme } from '@/shared/theme'
import { Terminal as TerminalIcon } from 'lucide-react'
import { useT } from '@/shared/i18n'
import { ResizableSidebar } from '@/shared/components/resizable-sidebar'
import { VerticalTabAdd, VerticalTabRow, VerticalTabSquare } from '@/shared/components/vertical-tab-list'
import { IS_MAC, terminalClipboardKey } from './terminal-clipboard'
import { TerminalContextMenu } from './terminal-context-menu'
import { TypeAheadAddon } from './type-ahead/type-ahead-addon'
import '@xterm/xterm/css/xterm.css'

interface TermInstance {
  id: string
  name: string
  term: XTerm
  fit: FitAddon
  /** Local echo: every PTY output write goes through `beforeServerInput`. */
  typeAhead: TypeAheadAddon
  container: HTMLDivElement
  /** Held so closeTerminal / unmount cleanup can disconnect it — otherwise
   *  the observer keeps the detached container (and xterm buffers) alive. */
  ro: ResizeObserver
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
  lineHeight: 1,
  cursorBlink: true,
  scrollback: 10000,
}

interface MenuState { x: number; y: number; term: XTerm }

/** Mount a hidden xterm for PTY `id` into `host`: input → `terminal:input`,
 *  container resize → fit + debounced `terminal:resize`, clipboard keys,
 *  right-click → `onMenu`. Shared by fresh tabs (createTerminal) and
 *  server-reattached ones. */
function mountXterm(host: HTMLDivElement, id: string, theme: Theme, onMenu: (menu: MenuState) => void): Pick<TermInstance, 'term' | 'fit' | 'typeAhead' | 'container' | 'ro'> {
  const container = document.createElement('div')
  container.className = 'absolute inset-0'
  container.style.display = 'none'
  host.appendChild(container)

  const term = new XTerm({ ...XTERM_OPTIONS, theme: XTERM_THEMES[theme] })

  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(container)
  fit.fit()

  // Predictive local echo: registers its own onData to draw keystrokes before
  // the PTY echoes them; disposed with the terminal.
  const typeAhead = new TypeAheadAddon()
  term.loadAddon(typeAhead)

  // Input → server
  term.onData((data) => {
    wsClient.send({ type: 'terminal:input', data, terminalId: id })
  })

  // Non-mac clipboard keys (see terminalClipboardKey). Returning false makes
  // xterm skip the key. Paste then runs as the browser's native paste event
  // into xterm's own handler (bracketed). Copy calls execCommand('copy'),
  // which fires the native copy event in the same way: Chromium binds no copy
  // to Ctrl+Shift+C, and the selection can only be cleared after the copy has
  // read it. Neither path uses the async Clipboard API, so plain-http origins
  // work too.
  term.attachCustomKeyEventHandler((e) => {
    const action = terminalClipboardKey(e, { isMac: IS_MAC, hasSelection: term.hasSelection() })
    if (action === 'copy') {
      e.preventDefault()
      if (term.hasSelection()) {
        document.execCommand('copy')
        term.clearSelection()
      }
    }
    return action === null
  })

  // Bubble phase: xterm's own contextmenu listener (inner element) has
  // already run — on mac it selects the word under the cursor first.
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    onMenu({ x: e.clientX, y: e.clientY, term })
  })

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

  return { term, fit, typeAhead, container, ro }
}

interface TerminalPanelProps {
  headerless?: boolean
  /** Name of the terminal on screen (null = none yet) — the bottom bar's title. */
  onActiveNameChange?: (name: string | null) => void
}

export function TerminalPanel({ headerless, onActiveNameChange }: TerminalPanelProps = {}) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const instancesRef = useRef<Map<string, TermInstance>>(new Map())
  const [tabs, setTabs] = useState<{ id: string; name: string }[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeName = tabs.find((tab) => tab.id === activeId)?.name ?? null
  useEffect(() => { onActiveNameChange?.(activeName) }, [activeName, onActiveNameChange])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
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

    const { term, fit, typeAhead, container, ro } = mountXterm(host, id, themeRef.current, setMenu)

    const inst: TermInstance = { id, name, term, fit, typeAhead, container, ro, ready: false, exited: false }
    instancesRef.current.set(id, inst)

    // Start on server — prefer explicit cwd (right-click "Open in Terminal"),
    // then project path, then URL folder param, then home dir.
    const folderParam = new URLSearchParams(window.location.search).get('folder')
    const cwd = explicitCwd ?? activeProject?.path ?? folderParam ?? '~'
    wsClient.send({
      type: 'terminal:start',
      terminalId: id,
      cwd,
      cols: term.cols,
      rows: term.rows,
      workspacePath: activeProject?.path ?? '',
      name,
    })

    setTabs((prev) => [...prev, { id, name }])
    setActiveId(id)

    return id
  }, [activeProject, tabs.length])

  // Bind a local tab to a PTY the server already runs (reattach on load /
  // reconnect, or `terminal:opened` from another page of this workspace).
  // Its screen arrives in the `terminal:snapshot` that follows.
  const adoptTerminal = useCallback((id: string, name: string): TermInstance | undefined => {
    const existing = instancesRef.current.get(id)
    if (existing) return existing
    const host = hostRef.current
    if (!host) return

    termCounter++
    const { term, fit, typeAhead, container, ro } = mountXterm(host, id, themeRef.current, setMenu)
    const inst: TermInstance = { id, name, term, fit, typeAhead, container, ro, ready: true, exited: false }
    instancesRef.current.set(id, inst)
    setTabs((prev) => [...prev, { id, name }])
    setActiveId((prev) => prev ?? id)
    return inst
  }, [])

  // Close a terminal
  const closeTerminal = useCallback((id: string) => {
    const inst = instancesRef.current.get(id)
    if (!inst) return

    wsClient.send({ type: 'terminal:close', terminalId: id })
    inst.ro.disconnect()
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

  // Unmount cleanup (bottom-panel remounts us with a fresh key on every WS
  // disconnect): dispose local xterm instances + observers so detached
  // containers and 10k-line scrollback buffers don't pile up across remounts.
  // Deliberately NO `terminal:close` — the server keeps the PTYs in its
  // detached pool and the freshly mounted panel reattaches to them.
  useEffect(() => {
    const instances = instancesRef.current
    return () => {
      for (const inst of instances.values()) {
        inst.ro.disconnect()
        inst.term.dispose()
        inst.container.remove()
      }
      instances.clear()
    }
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
      // Route to correct instance (legacy frames without an id: the first).
      // Through the predictor: confirmed predictions are kept, mismatches —
      // e.g. input typed on another page of this PTY — rolled back.
      const inst = terminalId
        ? instancesRef.current.get(terminalId)
        : instancesRef.current.values().next().value as TermInstance | undefined
      inst?.term.write(inst.typeAhead.beforeServerInput(data))
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
          // Through the predictor too, so pending predictions are rolled back
          // before the line instead of by a later timer above it.
          inst.term.write(inst.typeAhead.beforeServerInput('\r\n\x1b[90m[Process exited]\x1b[0m\r\n'))
        }
      }
    }))

    // Another page of this workspace started a PTY: show it here too.
    unsubs.push(wsClient.on('terminal:opened', (msg) => {
      adoptTerminal(msg.terminalId, msg.name)
    }))

    // The server's screen of a PTY we just attached to (scrollback, alt
    // buffer, modes — bracketed paste included), followed by its live output.
    // Replayed at the size it was serialized at, then fit to our container;
    // the fitted size is then reported (the server applies it only if no
    // other page is driving the PTY).
    unsubs.push(wsClient.on('terminal:snapshot', (msg) => {
      const inst = adoptTerminal(msg.terminalId, 'bash')
      if (!inst) return
      // The snapshot replaces the screen: predictions made against the old one
      // are dropped, not rolled back.
      inst.typeAhead.reset()
      inst.term.reset()
      inst.term.resize(msg.cols, msg.rows)
      inst.term.write(msg.data, () => {
        inst.fit.fit()
        wsClient.send({ type: 'terminal:resize', cols: inst.term.cols, rows: inst.term.rows, terminalId: msg.terminalId })
      })
    }))

    return () => unsubs.forEach((u) => u())
  }, [adoptTerminal])

  // Reattach handling — runs on first mount AND on every WS reconnect.
  // `terminal:reattached` lists every PTY of this workspace (from any browser
  // or device); each gets a local tab and its screen arrives in the
  // `terminal:snapshot` that follows. Ids already shown here (the reattach
  // sent at mount and the one sent on `_connected` both answer) are skipped.
  // If the server has none AND we have nothing locally, open a fresh one.
  // That answer is the only trigger — no timer: the reply rides the same
  // socket behind a page load's `subscribe` snapshot, which for a large
  // session takes seconds on a slow link, and a 2 s fallback started a PTY
  // beside the ones the late reply then listed (one more bash per refresh).
  // A reattach sent while offline is queued and re-sent on `_connected`, so a
  // reply follows every connection.
  // Wait for the workspace: split view mounts this panel on page load, before
  // workspace-layout's async resolve sets activeProject — a reattach then would
  // ask for workspace '' and miss every PTY.
  const mountedRef = useRef(false)
  useEffect(() => {
    if (mountedRef.current || !activeProject) return
    mountedRef.current = true

    const unsubReattached = wsClient.on('terminal:reattached', (msg) => {
      for (const { id, name } of msg.terminals) adoptTerminal(id, name)
      if (msg.terminals.length === 0 && instancesRef.current.size === 0) {
        createTerminal()
      }
    })

    // Send reattach on initial connect AND every subsequent reconnect. It
    // also subscribes this connection to the workspace, so PTYs other pages
    // start later arrive as `terminal:opened`.
    const sendReattach = () => {
      wsClient.send({
        type: 'terminal:reattach',
        workspacePath: activeProject?.path ?? '',
      })
    }
    sendReattach()
    const unsubConnected = wsClient.on('_connected', sendReattach)

    return () => {
      unsubReattached()
      unsubConnected()
    }
  }, [activeProject, createTerminal, adoptTerminal])

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
      {menu && <TerminalContextMenu x={menu.x} y={menu.y} term={menu.term} onClose={closeMenu} />}

      {/* Right sidebar — terminal list (collapsible, drag to resize) */}
      <ResizableSidebar
        openKey="halo_terminal_sidebar_open"
        widthKey="halo_terminal_sidebar_width"
        defaultWidth={160}
        title={t('terminal.list.title')}
        collapsedContent={
          <>
            <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto py-1">
              {tabs.map((tab) => (
                <VerticalTabSquare
                  key={tab.id}
                  icon={<TerminalIcon className="h-3.5 w-3.5" />}
                  tooltip={tab.name}
                  active={tab.id === activeId}
                  onActivate={() => switchTo(tab.id)}
                />
              ))}
            </div>
            <VerticalTabAdd collapsed onClick={() => createTerminal()} label={t('terminal.list.new')} />
          </>
        }
      >
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto py-1">
          {tabs.map((tab) => (
            <VerticalTabRow
              key={tab.id}
              icon={<TerminalIcon className="h-3 w-3" />}
              label={tab.name}
              tooltip={tab.name}
              active={tab.id === activeId}
              onActivate={() => switchTo(tab.id)}
              onClose={tabs.length > 1 ? () => closeTerminal(tab.id) : undefined}
              closeLabel={t('terminal.list.close')}
            />
          ))}
        </div>
        <VerticalTabAdd onClick={() => createTerminal()} label={t('terminal.list.new')} />
      </ResizableSidebar>
    </div>
  )
}
