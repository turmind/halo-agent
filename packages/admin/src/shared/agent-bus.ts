'use client'

import { createVersionBus } from './version-bus'

/**
 * Tiny bus for "agent list changed" signals.
 *
 * The Agent management view subscribes to `version` and re-fetches when it
 * changes. Any place that mutates agents (create, delete, external file
 * events) calls `bump()`.
 */
const bus = createVersionBus()
export const useAgentBus = bus.useBus
export const bumpAgentBus = bus.bump
