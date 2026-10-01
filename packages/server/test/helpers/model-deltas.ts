import type { ModelDelta } from '../../src/agents/agent-loop.js'

/**
 * The deltas the loop yields (and the UI shows): every streaming transport
 * also reports an `activity` delta per chunk received — idle-timer liveness
 * only, never yielded. Not a test file itself (vitest only collects
 * `test/**\/*.test.ts`).
 */
export const shownDeltas = (deltas: ModelDelta[]): ModelDelta[] => deltas.filter((d) => d.type !== 'activity')
