'use client'

import { createVersionBus } from './version-bus'

/**
 * Tiny bus for "session list changed" signals.
 *
 * Any component that holds a session list (chat-panel history count,
 * sessions sidebar tree, session-list dropdown…) subscribes to `version`
 * and re-fetches when it changes. Any place that mutates sessions
 * (delete, archive, new session) calls `bump()` after the server-side
 * change is confirmed.
 */
const bus = createVersionBus()
export const useSessionBus = bus.useBus
export const bumpSessionBus = bus.bump
