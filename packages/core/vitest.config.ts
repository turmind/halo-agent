import { defineConfig } from 'vitest/config'

// Covers the pure workspace logic (path-traversal guard, file ops) and the
// GitManager wrapper against real throwaway git repos. See test/*.test.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
