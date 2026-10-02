import { describe, it, expect, beforeEach } from 'vitest'
import { registerStateHandlers } from '../src/shared/ws-handlers/state-handlers'
import { useChatStore } from '../src/features/chat/chat-store'
import { useChatTabs, restoreTabs, openTab, getLoadedStore } from '../src/features/chat/chat-tabs'
import { useProjectStore } from '../src/shared/stores/project-store'
import type { WsClient } from '../src/shared/ws-client-types'

/**
 * Contract: when the server reclaims this connection's event listener
 * (`listener:released`, sent to a tab whose renderer froze >3min), the admin
 * re-subscribes — that frame is the ONLY recovery signal such a tab ever gets:
 * the server keeps answering `__pong__`, so the staleness clock stays fresh
 * and neither the zombie detection nor the visibility probe fires.
 *
 * Only the session on screen is re-subscribed; a background tab's store is
 * released instead (same rule as a reconnect) and loads on its next click.
 *
 * The fake below stands in for wsClient (state-handlers receives the client
 * as a parameter; `WsClient` is a structural type) so the test drives the real
 * registered handler, not a copy of its logic.
 */

type Handler = (data: Record<string, unknown>) => void

function makeFakeWsClient(): { client: WsClient; emit: (type: string, data?: Record<string, unknown>) => void; sent: object[] } {
  const handlers = new Map<string, Handler[]>()
  const sent: object[] = []
  const client = {
    on(type: string, handler: Handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
      return () => {
        const cur = handlers.get(type) ?? []
        handlers.set(type, cur.filter((h) => h !== handler))
      }
    },
    send(message: object) {
      sent.push(message)
    },
  } as unknown as WsClient
  return {
    client,
    emit: (type, data = {}) => (handlers.get(type) ?? []).forEach((h) => h(data)),
    sent,
  }
}

const PROJECT = '/ws/reclaim'

beforeEach(() => {
  localStorage.clear()
  useProjectStore.setState({ activeProject: null, folderPath: '', projects: [] })
  useChatStore.setState({ sessionId: null })
})

describe('listener:released → resubscribe', () => {
  it('re-sends subscribe with the store-bound session and project', () => {
    const { client, emit, sent } = makeFakeWsClient()
    const unregister = registerStateHandlers(client)

    useProjectStore.getState().openFolder(PROJECT)
    useChatStore.getState().setSessionId('sess_frozen')

    emit('listener:released', { sessionId: 'sess_frozen' })

    expect(sent).toContainEqual({ type: 'subscribe', sessionId: 'sess_frozen', projectId: PROJECT })
    unregister()
  })

  it('releases a background tab instead of re-subscribing it', () => {
    const { client, emit, sent } = makeFakeWsClient()
    const unregister = registerStateHandlers(client)

    useProjectStore.getState().openFolder(PROJECT)
    restoreTabs(`${PROJECT}-bg`)
    openTab('sess_bg')
    openTab('sess_front')
    expect(getLoadedStore('sess_bg')).not.toBeNull()

    emit('listener:released', { sessionId: 'sess_bg' })

    expect(sent).toHaveLength(0)
    expect(getLoadedStore('sess_bg')).toBeNull()
    const tab = useChatTabs.getState().tabs.find((t) => t.sessionId === 'sess_bg')
    expect(tab?.store).toBeUndefined()
    expect(getLoadedStore('sess_front')).not.toBeNull()
    unregister()
  })

  it('ignores a released session no loaded tab holds (the reclaim keeps the project binding)', () => {
    const { client, emit, sent } = makeFakeWsClient()
    const unregister = registerStateHandlers(client)

    useProjectStore.getState().openFolder(PROJECT)

    emit('listener:released', { sessionId: 'sess_gone' })

    expect(sent).toHaveLength(0)
    unregister()
  })

  it('does nothing without an active project (nothing to resubscribe to)', () => {
    const { client, emit, sent } = makeFakeWsClient()
    const unregister = registerStateHandlers(client)

    emit('listener:released', { sessionId: 'sess_frozen' })

    expect(sent).toHaveLength(0)
    unregister()
  })
})
