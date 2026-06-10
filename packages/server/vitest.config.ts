import { defineConfig } from 'vitest/config'

// Tests cover the externally-fixed contracts that fail silently if they
// regress: on-disk session format, the Anthropic message-array invariants,
// and the agent-event → WS-message mapping. See test/*.test.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Cap worker concurrency. Each worker loads the full server module graph
    // (better-sqlite3 native + aws-sdk + drizzle); on a 4-core box vitest's
    // default of one-worker-per-core lets the combined peak spike high enough
    // to OOM a 16GB host when a build runs alongside. Half the cores keeps
    // tests parallel-fast while bounding the memory ceiling.
    maxWorkers: 2,
  },
})
