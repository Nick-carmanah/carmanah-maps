import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so the tests don't load the PWA/React plugins.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Some tests push megabytes through mocks (native store writes, pack
    // cuts). On the PR check's 2-core runner, with every test file running in
    // parallel, the 5 s default timed out once; they take ~1 s locally.
    testTimeout: 20_000,
  },
})
