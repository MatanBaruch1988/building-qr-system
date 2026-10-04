import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Component tests are written in JSX without importing React in the test file. (Oxc transforms it: Vite 8 deprecates
  // the `esbuild` option.)
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // Logic and API tests run in plain node. A component test opts in to a DOM with a first-line docblock:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['tests/**/*.test.{js,jsx}'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Integration tests share one Postgres; each file uses its own throwaway schema.
    fileParallelism: false,
  },
})
