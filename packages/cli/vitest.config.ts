import { defineConfig } from 'vitest/config'

// Covers the TUI's pure edit/suggest logic, history persistence, @-ref
// resolution, and (via child processes) the setup-prompt EOF contract.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // setup-prompts tests spawn `node --import tsx` children (~2s each).
    testTimeout: 30_000,
  },
})
