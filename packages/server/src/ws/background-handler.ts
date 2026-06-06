/**
 * Background event handler — buffers WS notifications after session:clear.
 *
 * State mutation is handled by SessionManager.reduceIntoUIState (via applyEvent).
 * This module only buffers structural WS events for potential replay if the
 * user navigates back to the cleared session.
 */
import type { OrchestratorEvent } from '../agents/agent-events.js'
import type { UIState } from '../sessions/ui-log-builder.js'
import { createSaveSnapshot } from '../sessions/ui-log-builder.js'
import { bufferDetachedNotification } from './event-processor.js'
import type { SessionManager } from '../agents/session-manager.js'

export interface BackgroundHandler {
  handler: (event: OrchestratorEvent, state: UIState, turnId: string) => void
  save: () => void
  pendingEvents: Array<Record<string, unknown>>
}

export function createBackgroundHandler(
  sessionId: string,
  projectPath: string | null,
  sm: SessionManager,
): BackgroundHandler {
  const pendingEvents: Array<Record<string, unknown>> = []

  function save(): void {
    // Cached only — if the state isn't in memory there's nothing new to
    // flush, since disk is already up to date with the last reduce().
    const state = sm.getCachedUIState(sessionId)
    if (!state || state.messageLog.length === 0) return
    const snapshot = createSaveSnapshot(state)
    if (snapshot.length === 0) return
    // Goes through SessionManager so the tombstone check fires uniformly
    // (see SessionManager.persistSessionFile).
    sm.persistSessionFile({
      sessionId, projectPath, messages: snapshot,
      contextTokens: state.contextTokens, outputTokens: state.outputTokens,
    })
  }

  const handler = (_event: OrchestratorEvent, _state: UIState, _turnId: string) => {
    bufferDetachedNotification(_event, pendingEvents)
  }

  return { handler, save, pendingEvents }
}
