'use client'

import { useState, useCallback, useEffect } from 'react'
import { api } from '@/shared/api-client'
import { useSessionBus, bumpSessionBus } from '@/shared/session-bus'
import type { SessionMeta } from '@/shared/components/session-list-dropdown'

/** First page size; subsequent pages use the same. Matches the Sessions
 *  sidebar's TOP_LEVEL_PAGE_SIZE so both session lists page at the same rate. */
const PAGE_SIZE = 30

/** Hook: manages session list via unified session logs API.
 *
 *  Used by the chat header's dropdown — paginates the most recent root
 *  sessions (`rootOnly`, so sub-agent children never surface here). Scrolling
 *  the dropdown to the bottom calls `loadMore`, which appends the next page
 *  via the server's keyset cursor. Reloads from the first page when the shared
 *  session-bus bumps (delete/create elsewhere). Mutations via `remove` bump
 *  the bus so other consumers refresh too. */
export function useSessionList(projectId?: string) {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const busVersion = useSessionBus((s) => s.version)

  const refresh = useCallback(async () => {
    try {
      const res = await api.sessionLogs.list(projectId, { rootOnly: true, limit: PAGE_SIZE })
      setSessions(res.sessions as unknown as SessionMeta[])
      setNextCursor(res.nextCursor)
    } catch {
      setSessions([])
      setNextCursor(null)
    }
  }, [projectId])

  useEffect(() => { refresh() }, [refresh, busVersion])

  const loadMore = useCallback(async () => {
    if (nextCursor === null || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await api.sessionLogs.list(projectId, { rootOnly: true, limit: PAGE_SIZE, cursor: nextCursor })
      const fresh = res.sessions as unknown as SessionMeta[]
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id))
        return [...prev, ...fresh.filter((s) => !seen.has(s.id))]
      })
      setNextCursor(res.nextCursor)
    } catch (err) {
      console.error('[SessionList] loadMore failed:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [projectId, nextCursor, loadingMore])

  const remove = useCallback(async (sessionId: string) => {
    try {
      await api.sessionLogs.delete(sessionId, projectId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      bumpSessionBus()
    } catch (err) {
      console.error('[SessionList] Delete failed:', err)
    }
  }, [projectId])

  return { sessions, refresh, remove, loadMore, hasMore: nextCursor !== null, loadingMore }
}
