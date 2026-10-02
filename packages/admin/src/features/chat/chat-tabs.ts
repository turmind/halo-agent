'use client'

import { create } from 'zustand'
import {
  createChatStore,
  disposeChatStore,
  forEachChatStore,
  getActiveChatStore,
  setActiveChatStore,
  type ChatStoreApi,
} from './chat-store'
import { noteArchiveAnchor } from './archive-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { wsClient } from '@/shared/ws-client'
import { generateId } from '@/shared/utils'

/**
 * Explorer chat tabs — the session list on the right IS the tab list: every
 * session is "open", clicking a row shows it (openTab). There is no close;
 * deleting the session (dropSessionTab) is the only way a tab goes away.
 *
 * Every tab that has been shown owns a chat store (chat-store.ts
 * createChatStore); `useChatStore` proxies to the active tab's. The one WS
 * connection subscribes every loaded tab's session, so a background tab keeps
 * streaming into its own store — frames are routed by `sessionId` (see
 * storeForFrame) — until a reconnect: only the tab on screen resubscribes,
 * the background ones are released to headers (releaseBackgroundTabs) and
 * load again on their next click.
 *
 * Lazy load: a tab is created on first click and loaded (store + subscribe)
 * on first show, so a refresh restores and subscribes only the session that
 * was on screen. A draft tab (`sessionId: null`) gets its id on the first
 * send or command (bindActiveTabSession).
 */

export interface ChatTab {
  tabId: string
  /** null = draft: no session until the first send or command. */
  sessionId: string | null
  /** Created on first show; undefined = header only (not loaded yet, or
   *  released by a reconnect — see releaseBackgroundTabs). */
  store?: ChatStoreApi
  /** Frames landed while this tab was in the background. */
  unread?: boolean
  /** Subscribe sent, snapshot not back yet → loading view. */
  loading?: boolean
  /** Bumped per subscribe attempt — Retry re-arms the slow-network hint. */
  attempt?: number
  /** Highest archive segment count a snapshot reported. The archive store
   *  holds one session's walk, so it is re-anchored from this on show. */
  archiveCount?: number
}

interface ChatTabsState {
  /** Workspace the tabs belong to (see restoreTabs); null before the first. */
  projectId: string | null
  tabs: ChatTab[]
  activeTabId: string
}

function draftTab(store: ChatStoreApi): ChatTab {
  return { tabId: generateId(), sessionId: null, store }
}

// The first tab adopts the store chat-store starts with, so code that ran
// before any workspace was restored keeps its state.
const initialTab = draftTab(getActiveChatStore())

export const useChatTabs = create<ChatTabsState>(() => ({
  projectId: null,
  tabs: [initialTab],
  activeTabId: initialTab.tabId,
}))

// ── Persistence ──────────────────────────────────────────────────────────
// Per workspace: only the session on screen — the list itself comes from the
// server. A draft saves null: there is nothing to reload for it.

const tabsKey = (projectId: string) => `halo_chat_tabs_${projectId}`
/** Pre-tabs keys (one current session per workspace, and the older global
 *  one) — read once to seed the active session, then removed. */
const legacySessionKey = (projectId: string) => `halo_session_${projectId}`
const LEGACY_GLOBAL_KEY = 'halo_session_id'

/** `{ active }`; entries written by the horizontal tab strip also carry a
 *  `sessions` array, which is ignored. */
function readPersistedActive(projectId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(tabsKey(projectId))
    if (raw) {
      const parsed = JSON.parse(raw) as { active?: unknown }
      return typeof parsed.active === 'string' && parsed.active.length > 0 ? parsed.active : null
    }
    for (const key of [legacySessionKey(projectId), LEGACY_GLOBAL_KEY]) {
      const legacy = localStorage.getItem(key)
      if (!legacy) continue
      localStorage.removeItem(key)
      return legacy
    }
  } catch {
    // Unreadable entry — start from a draft.
  }
  return null
}

function persistTabs(): void {
  const { projectId, tabs, activeTabId } = useChatTabs.getState()
  if (!projectId || typeof window === 'undefined') return
  const active = tabs.find((t) => t.tabId === activeTabId)?.sessionId ?? null
  try {
    localStorage.setItem(tabsKey(projectId), JSON.stringify({ active }))
  } catch {
    // Storage full / unavailable — the session just won't survive a refresh.
  }
}

// ── Per-tab reading position ─────────────────────────────────────────────
// Only the active tab renders, so its view unmounts on every switch. The view
// saves its position here as it changes and reads it back on the next mount.

export interface TabViewState {
  scrollTop: number
  userScrolledUp: boolean
  /** User turns sliced off above the render window (chat-panel). */
  hiddenTurns: number
}

const tabViews = new Map<string, TabViewState>()

export function getTabView(tabId: string): TabViewState | undefined {
  return tabViews.get(tabId)
}

export function saveTabView(tabId: string, patch: Partial<TabViewState>): void {
  // A fresh object per save: a view holding the one it restored from keeps it.
  tabViews.set(tabId, { scrollTop: 0, userScrolledUp: false, hiddenTurns: 0, ...tabViews.get(tabId), ...patch })
}

// ── Internals ────────────────────────────────────────────────────────────

function findTab(pred: (t: ChatTab) => boolean): ChatTab | undefined {
  return useChatTabs.getState().tabs.find(pred)
}

function patchTab(tabId: string, patch: Partial<ChatTab>): void {
  useChatTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, ...patch } : t)) }))
}

function isPristineDraft(tab: ChatTab): boolean {
  return tab.sessionId === null && (!tab.store || tab.store.getState().messages.length === 0)
}

/** A new tab's store, seeded the way the single store used to survive a
 *  clear(): the picked agent and the last-known context limit carry over
 *  (a session's own snapshot overrides both once it lands). */
function spawnStore(sessionId: string | null, agentId?: string): ChatStoreApi {
  const prev = getActiveChatStore().getState()
  const store = createChatStore()
  const s = store.getState()
  s.setSelectedAgentId(agentId ?? prev.selectedAgentId)
  s.setMaxContextTokens(prev.maxContextTokens)
  if (sessionId) s.setSessionId(sessionId)
  return store
}

function sendSubscribe(sessionId: string): void {
  const projectId = useProjectStore.getState().activeProject?.id
  // Offline: use-websocket's `_connected` subscribes the tab on screen. A
  // queued subscribe would be flushed BEFORE that and double-subscribe.
  if (!projectId || !wsClient.connected) return
  wsClient.send({ type: 'subscribe', sessionId, projectId })
}

/** Put a tab on screen: load it on first show (store, loading flag), clear
 *  its unread dot, re-anchor the archive walk. Returns the session to
 *  subscribe when the tab was just loaded, else null — the caller sends it. */
function showTab(tabId: string): string | null {
  const tab = findTab((t) => t.tabId === tabId)
  if (!tab) return null
  const patch: Partial<ChatTab> = {}
  let toSubscribe: string | null = null
  let store = tab.store
  if (!store) {
    store = spawnStore(tab.sessionId)
    patch.store = store
    if (tab.sessionId) {
      toSubscribe = tab.sessionId
      patch.loading = true
      patch.attempt = (tab.attempt ?? 0) + 1
    }
  }
  if (tab.unread) patch.unread = false
  setActiveChatStore(store)
  useChatTabs.setState((s) => ({
    activeTabId: tabId,
    tabs: Object.keys(patch).length > 0 ? s.tabs.map((t) => (t.tabId === tabId ? { ...t, ...patch } : t)) : s.tabs,
  }))
  if (tab.sessionId) noteArchiveAnchor(tab.sessionId, tab.archiveCount ?? 0)
  persistTabs()
  return toSubscribe
}

function removeTab(tabId: string): void {
  const s = useChatTabs.getState()
  const idx = s.tabs.findIndex((t) => t.tabId === tabId)
  if (idx === -1) return
  const tab = s.tabs[idx]
  let rest = s.tabs.filter((t) => t.tabId !== tabId)
  if (rest.length === 0) rest = [draftTab(spawnStore(null))]
  useChatTabs.setState({ tabs: rest })
  if (s.activeTabId === tabId) {
    const toSubscribe = showTab(rest[Math.min(idx, rest.length - 1)].tabId)
    if (toSubscribe) sendSubscribe(toSubscribe)
  } else {
    persistTabs()
  }
  if (tab.store) disposeChatStore(tab.store)
  tabViews.delete(tabId)
}

// ── Actions ──────────────────────────────────────────────────────────────

/** Show the session a workspace last had on screen (or a fresh draft) — the
 *  only tab loaded. No-op when the tabs already belong to that workspace. */
export function restoreTabs(projectId: string): void {
  const prev = useChatTabs.getState()
  if (prev.projectId === projectId) return
  const active = readPersistedActive(projectId)
  // A draft was on screen (or nothing was saved) — show a fresh one.
  const activeTab: ChatTab = active ? { tabId: generateId(), sessionId: active } : draftTab(spawnStore(null))
  useChatTabs.setState({ projectId, tabs: [activeTab], activeTabId: activeTab.tabId })
  // A draft still subscribes (`''`): the server starts the workspace's file
  // watcher off the projectId. The sole subscriber of a workspace switch.
  sendSubscribe(showTab(activeTab.tabId) ?? '')
  for (const t of prev.tabs) if (t.store) disposeChatStore(t.store)
  tabViews.clear()
}

/** Session list row click: open the session in its own tab, or focus the
 *  tab already showing it. */
export function openTab(sessionId: string): void {
  const toSubscribe = focusSessionTab(sessionId)
  if (toSubscribe) sendSubscribe(toSubscribe)
}

/** openTab without the send: returns the session to subscribe when its tab
 *  had to be loaded (the `session:switched` handler sends via its client).
 *  An untouched draft on screen is replaced instead of left behind. */
export function focusSessionTab(sessionId: string): string | null {
  const s = useChatTabs.getState()
  const existing = s.tabs.find((t) => t.sessionId === sessionId)
  if (existing) return showTab(existing.tabId)
  const tab: ChatTab = { tabId: generateId(), sessionId }
  const active = s.tabs.find((t) => t.tabId === s.activeTabId)
  const replaced = active && isPristineDraft(active) ? active : null
  useChatTabs.setState({ tabs: replaced ? s.tabs.map((t) => (t === replaced ? tab : t)) : [...s.tabs, tab] })
  const toSubscribe = showTab(tab.tabId)
  if (replaced) {
    if (replaced.store) disposeChatStore(replaced.store)
    tabViews.delete(replaced.tabId)
  }
  return toSubscribe
}

/** "+ New Session", `/session new`, `/clear`: a fresh draft tab. An untouched
 *  draft is reused rather than piling up empty tabs. */
export function newTab(agentId?: string): void {
  const s = useChatTabs.getState()
  const draft = s.tabs.find(isPristineDraft)
  if (draft) {
    showTab(draft.tabId)
    if (agentId) draft.store?.getState().setSelectedAgentId(agentId)
    return
  }
  const tab = draftTab(spawnStore(null, agentId))
  useChatTabs.setState({ tabs: [...s.tabs, tab] })
  showTab(tab.tabId)
}

/** A session was deleted: drop its tab — no unsubscribe, the delete already
 *  took the session (and its listener) away. Dropping the last tab leaves a
 *  fresh draft. */
export function dropSessionTab(sessionId: string): void {
  const tab = findTab((t) => t.sessionId === sessionId)
  if (tab) removeTab(tab.tabId)
}

/** Retry button of a tab stuck loading. */
export function retryTabLoad(tabId: string): void {
  const tab = findTab((t) => t.tabId === tabId)
  if (!tab?.sessionId) return
  patchTab(tabId, { loading: true, attempt: (tab.attempt ?? 0) + 1 })
  sendSubscribe(tab.sessionId)
}

/** A draft's first send / command minted its session id: bind it to the tab
 *  on screen (store + header) and persist. */
export function bindActiveTabSession(sessionId: string): void {
  const store = getActiveChatStore()
  if (store.getState().sessionId !== sessionId) store.getState().setSessionId(sessionId)
  const tab = findTab((t) => t.store === store)
  if (!tab || tab.sessionId === sessionId) return
  patchTab(tab.tabId, { sessionId })
  persistTabs()
}

// ── WS routing ───────────────────────────────────────────────────────────

/** The store of a loaded tab on `sessionId`. Matches on store state, so it
 *  also finds a store chat-tabs hasn't adopted (tests drive the bare one). */
export function getLoadedStore(sessionId: string): ChatStoreApi | null {
  const hits: ChatStoreApi[] = []
  forEachChatStore((s) => {
    if (s.getState().sessionId === sessionId) hits.push(s)
  })
  return hits[0] ?? null
}

/** Store a WS frame belongs to: the loaded tab on its session — null when
 *  no tab holds it (released, never loaded) so the frame is dropped — or, for
 *  a frame without one (connection-level replies), the tab on screen.
 *  `unread` lights the dot of a background tab the frame lands in. */
export function storeForFrame(sessionId: string | null | undefined, unread = true): ChatStoreApi | null {
  const store = sessionId ? getLoadedStore(sessionId) : getActiveChatStore()
  if (store && unread && store !== getActiveChatStore()) {
    const tab = findTab((t) => t.store === store)
    if (tab && !tab.unread) patchTab(tab.tabId, { unread: true })
  }
  return store
}

/** A snapshot landed in a tab's store: loading is over; keep the archive
 *  count for when the tab is shown. */
export function noteTabSnapshot(store: ChatStoreApi, archiveCount: number): void {
  const tab = findTab((t) => t.store === store)
  if (!tab) return
  const count = Math.max(tab.archiveCount ?? 0, archiveCount)
  if (!tab.loading && count === (tab.archiveCount ?? 0)) return
  patchTab(tab.tabId, { loading: false, archiveCount: count })
}

/** Unload a background tab: drop its store (and the unread dot that lived
 *  on it) and keep the header — the next show re-creates the store and
 *  subscribes. Until then its list dot reads idle (session-list). */
function releaseTab(tab: ChatTab): void {
  if (!tab.store) return
  disposeChatStore(tab.store)
  patchTab(tab.tabId, { store: undefined, loading: false, unread: false })
}

/** (Re)connect: only the tab on screen resubscribes — every other loaded tab
 *  is released, so a session that is not in front isn't reattached. Returns
 *  the session to subscribe; `''` for a draft (the project subscribe the
 *  file watcher needs). */
export function releaseBackgroundTabs(): string {
  const { tabs, activeTabId } = useChatTabs.getState()
  for (const tab of tabs) if (tab.tabId !== activeTabId) releaseTab(tab)
  return getActiveChatStore().getState().sessionId ?? ''
}

/** `listener:released` for a background tab: the server already dropped its
 *  listener, so release the store instead of resubscribing. The tab on
 *  screen is left alone (the caller resubscribes that one). */
export function releaseSessionTab(sessionId: string): void {
  const { tabs, activeTabId } = useChatTabs.getState()
  const tab = tabs.find((t) => t.sessionId === sessionId)
  if (tab && tab.tabId !== activeTabId) releaseTab(tab)
}
