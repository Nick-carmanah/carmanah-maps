import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so the tests don't load the PWA/React plugins.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
