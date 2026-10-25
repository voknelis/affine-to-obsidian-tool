import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
