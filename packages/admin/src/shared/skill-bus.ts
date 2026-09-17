'use client'

import { createVersionBus } from './version-bus'

/**
 * Tiny bus for "skill list changed" signals.
 *
 * Any component holding a skill list (Skills sidebar, the `skills` store
 * used when picking skills for an agent in agent-management) subscribes to
 * `version` and re-fetches when it changes. Any place that mutates skills
 * (create, delete) — including automatic ones driven by WS file events —
 * calls `bump()` after the change is observed.
 */
const bus = createVersionBus()
export const useSkillBus = bus.useBus
export const bumpSkillBus = bus.bump
