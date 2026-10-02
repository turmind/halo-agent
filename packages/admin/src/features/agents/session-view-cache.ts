'use client'

import type { ChatMessage } from '@/shared/types'
import type { ChatTab } from '@/features/chat/chat-tabs'

/**
 * Sessions-tab detail view cache. The tab stays mounted once opened (CSS-
 * hidden while another activity tab is up — workspace-layout), and every
 * session viewed there keeps its transcript, archive anchor and reading
 * position here, so switching back is instant: a current copy shows with no
 * request, a stale one shows at once and is refetched in the background
 * (session-chat-panel).
 *
 * Staleness is push-driven: a `file:changed` on a cached session's log marks
 * it stale (and, for the one on screen, tells the caller to refetch now); a
 * reconnect — deltas lost while the socket was down — marks every entry.
 *
 * LRU by last view, capped at SESSION_VIEW_CACHE_LIMIT; the session on screen
 * is never evicted.
 */

export interface SessionViewEntry {
  messages: ChatMessage[]
  /** Archive segment count of the log `messages` came from. */
  archiveCount: number
  /** Viewport top relative to the active log's top. Archive segments pulled
   *  above it are dropped on revisit (the walk re-anchors), so a raw
   *  scrollTop would land off by their height. */
  scrollOffset: number
  /** Was pinned to the bottom — restored as "follow the tail". */
  atBottom: boolean
  /** The log changed since `messages` was fetched. */
  stale: boolean
}

export const SESSION_VIEW_CACHE_LIMIT = 20

/** Map order = recency of view, oldest first. */
const entries = new Map<string, SessionViewEntry>()
/** The detail panel's selection, and whether the Sessions tab is on screen. */
let displayedSid: string | null = null
let visible = false

export function getCachedView(sessionId: string): SessionViewEntry | undefined {
  return entries.get(sessionId)
}

/** Store a fetched copy. An existing entry keeps its place, reading position
 *  and stale flag — a write that landed while the GET was in flight marked
 *  it, and that mark must survive (see setCachedViewStale). */
export function putCachedView(sessionId: string, messages: ChatMessage[], archiveCount: number): void {
  const entry = entries.get(sessionId)
  if (entry) {
    entry.messages = messages
    entry.archiveCount = archiveCount
    return
  }
  entries.set(sessionId, { messages, archiveCount, scrollOffset: 0, atBottom: true, stale: false })
  if (entries.size <= SESSION_VIEW_CACHE_LIMIT) return
  for (const sid of entries.keys()) {
    if (sid === displayedSid) continue
    entries.delete(sid)
    return
  }
}

/** A refetch claims the flag (false) before its GET and re-marks it if the GET
 *  fails; anything else that knows a copy is behind marks it (true). */
export function setCachedViewStale(sessionId: string, stale: boolean): void {
  const entry = entries.get(sessionId)
  if (entry) entry.stale = stale
}

/** Reading position of a cached session (no-op when it isn't cached). */
export function saveCachedScroll(sessionId: string, scrollOffset: number, atBottom: boolean): void {
  const entry = entries.get(sessionId)
  if (!entry) return
  entry.scrollOffset = scrollOffset
  entry.atBottom = atBottom
}

/** A deleted session — with its sub-sessions (`<id>>…`), which the server
 *  delete cascades to. */
export function removeCachedView(sessionId: string): void {
  for (const sid of entries.keys()) {
    if (sid === sessionId || sid.startsWith(`${sessionId}>`)) entries.delete(sid)
  }
}

/** Workspace switch — the entries belong to the previous one. */
export function clearSessionViewCache(): void {
  entries.clear()
}

/** The detail panel's selection: counts as a view, and is never evicted. */
export function setDisplayedSession(sessionId: string | null): void {
  displayedSid = sessionId
  const entry = sessionId ? entries.get(sessionId) : undefined
  if (!sessionId || !entry) return
  entries.delete(sessionId)
  entries.set(sessionId, entry)
}

export function setSessionViewVisible(on: boolean): void {
  visible = on
}

/** Session files are named by the last segment of the id (full id
 *  "root>sid_abc" → file "sid_abc.json"). */
function fileBase(sessionId: string): string {
  return sessionId.slice(sessionId.lastIndexOf('>') + 1)
}

/** A `file:changed` frame: every cached session whose log it is goes stale.
 *  Returns the session to refetch now — the one on screen, while the tab is
 *  — else null (hidden: showing the tab again refetches the stale copy). */
export function noteSessionFileChanged(path: string, action: string): string | null {
  // Session files are written atomically (tmp + rename-over-existing), which
  // the native watcher reports as `create` → action 'add', not 'change'.
  if (action !== 'change' && action !== 'add') return null
  if (!path.startsWith('.halo/sessions/') || !path.endsWith('.json')) return null
  const base = path.slice(path.lastIndexOf('/') + 1, -'.json'.length)
  for (const [sid, entry] of entries) {
    if (fileBase(sid) === base) entry.stale = true
  }
  return visible && displayedSid !== null && fileBase(displayedSid) === base ? displayedSid : null
}

/** WS reconnect: deltas emitted while the socket was down are lost, so every
 *  cached session is stale. Returns the one on screen to refetch now — null
 *  while the tab is hidden. */
export function noteSessionViewReconnect(): string | null {
  for (const entry of entries.values()) entry.stale = true
  return visible ? displayedSid : null
}

/** The loaded Explorer chat tab streaming `sessionId` — the viewer shows its
 *  live store instead of a fetched copy. A tab still waiting for its
 *  subscribe snapshot doesn't count: its store is empty until then. */
export function findLiveTab(tabs: ChatTab[], sessionId: string | null): ChatTab | undefined {
  if (!sessionId) return undefined
  return tabs.find((t) => t.store !== undefined && !t.loading && t.sessionId === sessionId)
}
