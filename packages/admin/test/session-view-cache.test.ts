import { describe, it, expect, beforeEach } from 'vitest'
import {
  SESSION_VIEW_CACHE_LIMIT, clearSessionViewCache, findLiveTab, getCachedView, noteSessionFileChanged,
  noteSessionViewReconnect, putCachedView, removeCachedView, saveCachedScroll, setCachedViewStale,
  setDisplayedSession, setSessionViewVisible,
} from '../src/features/agents/session-view-cache'
import { createChatStore } from '../src/features/chat/chat-store'
import type { ChatTab } from '../src/features/chat/chat-tabs'
import type { ChatMessage } from '../src/shared/types'

const msgs = (...ids: string[]): ChatMessage[] => ids.map((id) => ({ id, role: 'user', content: id, timestamp: 1 }))
const file = (base: string) => `.halo/sessions/default/${base}.json`

beforeEach(() => {
  clearSessionViewCache()
  setDisplayedSession(null)
  setSessionViewVisible(false)
})

describe('session view cache — LRU', () => {
  it('evicts the least recently viewed past the limit, never the session on screen', () => {
    putCachedView('s0', msgs('a'), 0)
    setDisplayedSession('s0')
    for (let i = 1; i <= SESSION_VIEW_CACHE_LIMIT; i++) putCachedView(`s${i}`, msgs('a'), 0)
    // s0 is the oldest entry but on screen → s1 goes instead.
    expect(getCachedView('s0')).toBeDefined()
    expect(getCachedView('s1')).toBeUndefined()
    expect(getCachedView(`s${SESSION_VIEW_CACHE_LIMIT}`)).toBeDefined()
  })

  it('a view refreshes recency', () => {
    for (let i = 0; i < SESSION_VIEW_CACHE_LIMIT; i++) putCachedView(`s${i}`, msgs('a'), 0)
    setDisplayedSession('s0') // s0 → most recent; s1 now the oldest
    setDisplayedSession('s5')
    putCachedView('extra', msgs('a'), 0)
    expect(getCachedView('s0')).toBeDefined()
    expect(getCachedView('s1')).toBeUndefined()
  })

  it('a refreshed copy keeps reading position and stale mark', () => {
    putCachedView('s', msgs('a'), 0)
    saveCachedScroll('s', 340, false)
    setCachedViewStale('s', true)
    putCachedView('s', msgs('a', 'b'), 2)
    expect(getCachedView('s')).toEqual({ messages: msgs('a', 'b'), archiveCount: 2, scrollOffset: 340, atBottom: false, stale: true })
  })

  it('remove takes the sub-sessions along', () => {
    putCachedView('root', msgs('a'), 0)
    putCachedView('root>child', msgs('a'), 0)
    putCachedView('rooted', msgs('a'), 0)
    removeCachedView('root')
    expect(getCachedView('root')).toBeUndefined()
    expect(getCachedView('root>child')).toBeUndefined()
    expect(getCachedView('rooted')).toBeDefined()
  })
})

describe('session view cache — stale rules', () => {
  beforeEach(() => {
    putCachedView('shown', msgs('a'), 0)
    putCachedView('other', msgs('a'), 0)
    setDisplayedSession('shown')
  })

  it('a write to the session on screen refetches it now while the tab is visible', () => {
    setSessionViewVisible(true)
    expect(noteSessionFileChanged(file('shown'), 'change')).toBe('shown')
    expect(getCachedView('shown')?.stale).toBe(true)
  })

  it('atomic rename-over reports add — same as change', () => {
    setSessionViewVisible(true)
    expect(noteSessionFileChanged(file('shown'), 'add')).toBe('shown')
  })

  it('hidden: only marks, nothing to refetch now', () => {
    expect(noteSessionFileChanged(file('shown'), 'change')).toBeNull()
    expect(getCachedView('shown')?.stale).toBe(true)
  })

  it('a session not on screen is marked, not refetched', () => {
    setSessionViewVisible(true)
    expect(noteSessionFileChanged(file('other'), 'change')).toBeNull()
    expect(getCachedView('other')?.stale).toBe(true)
    expect(getCachedView('shown')?.stale).toBe(false)
  })

  it('ignores unlink and files outside the session logs', () => {
    setSessionViewVisible(true)
    expect(noteSessionFileChanged(file('shown'), 'unlink')).toBeNull()
    expect(noteSessionFileChanged('src/shown.json', 'change')).toBeNull()
    expect(noteSessionFileChanged('.halo/sessions/default/shown.jsonl', 'change')).toBeNull()
    expect(getCachedView('shown')?.stale).toBe(false)
  })

  it('a sub-session matches on the last id segment (the file name)', () => {
    putCachedView('root>sid_child', msgs('a'), 0)
    setDisplayedSession('root>sid_child')
    setSessionViewVisible(true)
    expect(noteSessionFileChanged(file('sid_child'), 'change')).toBe('root>sid_child')
    expect(getCachedView('root>sid_child')?.stale).toBe(true)
  })

  it('reconnect marks every entry; returns the one on screen only while visible', () => {
    expect(noteSessionViewReconnect()).toBeNull()
    expect(getCachedView('shown')?.stale).toBe(true)
    expect(getCachedView('other')?.stale).toBe(true)
    setCachedViewStale('shown', false)
    setSessionViewVisible(true)
    expect(noteSessionViewReconnect()).toBe('shown')
    expect(getCachedView('shown')?.stale).toBe(true)
  })
})

describe('findLiveTab', () => {
  it('only a loaded tab with its snapshot in counts as live', () => {
    const store = createChatStore()
    const tabs: ChatTab[] = [
      { tabId: 't1', sessionId: 'header-only' },
      { tabId: 't2', sessionId: 'loading', store, loading: true },
      { tabId: 't3', sessionId: 'live', store },
    ]
    expect(findLiveTab(tabs, 'header-only')).toBeUndefined()
    expect(findLiveTab(tabs, 'loading')).toBeUndefined()
    expect(findLiveTab(tabs, 'live')?.tabId).toBe('t3')
    expect(findLiveTab(tabs, null)).toBeUndefined()
  })
})
