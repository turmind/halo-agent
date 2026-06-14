'use client'

import { useCallback } from 'react'
import { useProjectStore } from '@/shared/stores/project-store'
import { useSessionList } from '@/shared/use-session-list'
import { SessionListDropdown, SessionHistoryLink } from '@/shared/components/session-list-dropdown'
import type { SessionMeta } from '@/shared/components/session-list-dropdown'

export type { SessionMeta }

/**
 * Hook: manages explorer session list for the main chat.
 */
export function useExplorerSessions() {
  const activeProject = useProjectStore((s) => s.activeProject)
  return useSessionList(activeProject?.path)
}

interface SessionListProps {
  currentSessionId: string | null
  onSelect: (sessionId: string) => void
  onNew: () => void
  onDelete?: (sessionId: string) => void
}

/**
 * Session list for the explorer chat panel header.
 * Uses the shared dropdown UI for consistency.
 */
export function SessionList({ currentSessionId, onSelect, onNew, onDelete }: SessionListProps) {
  const { sessions, remove } = useExplorerSessions()

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (onDelete) {
      onDelete(id)
    }
    await remove(id)
  }, [onDelete, remove])

  return (
    <SessionListDropdown
      sessions={sessions}
      currentSessionId={currentSessionId}
      onSelect={onSelect}
      onDelete={handleDelete}
      onNew={onNew}
    />
  )
}

export { SessionHistoryLink }
