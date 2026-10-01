import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Integration tests share one Postgres; each file uses its own throwaway schema.
    fileParallelism: false,
  },
})
