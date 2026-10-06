// The screenshots of the README (npm run screenshots, see docs/screenshots/README.md): the same machinery as the end-to-end run
// (the production build served by `vite preview`, the local API over a scratch schema with the fake sample data), with its own
// ports and its own schema, and a spec that takes pictures instead of checking behaviour.
//
// It is NOT under e2e/ on purpose: `npm run test:e2e` and CI read playwright.config.js, whose testDir is ./e2e, so they never
// run this. tests/screenshots.test.js holds that.
//
// It reads playwright.config.js instead of copying it: the web servers (a fresh scratch schema with the seed, the API, the
// build and the preview), the time zone, the location and the teardown that drops the schema. What it changes is below.
import { defineConfig, devices } from '@playwright/test'
import {
  SCREENSHOTS_APP_PORT,
  SCREENSHOTS_API_PORT,
  SCREENSHOTS_SCHEMA,
  assertLocalScratch,
} from './scripts/screenshots/settings.mjs'

// playwright.config.js takes its ports and its schema from these three variables when it is read, so they are set first (and
// that is why it is imported below and not at the top: an import is read before any line of this file runs). They are set
// here and not read from the shell: a value that is left over from an E2E run must not send the screenshots to its schema.
process.env.E2E_APP_PORT = String(SCREENSHOTS_APP_PORT)
process.env.E2E_API_PORT = String(SCREENSHOTS_API_PORT)
process.env.E2E_SCHEMA = SCREENSHOTS_SCHEMA
const { default: e2e } = await import('./playwright.config.js')

// The guard, before anything starts: only the local address and a scratch schema. The spec checks again with the address that
// the browser really uses.
assertLocalScratch({ baseURL: e2e.use?.baseURL, schema: SCREENSHOTS_SCHEMA })

export default defineConfig({
  ...e2e,
  testDir: './scripts/screenshots',
  testMatch: '*.spec.mjs',
  // One spec, one worker, in order: the History tab shows the visits that the provider app made earlier in the run.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...e2e.use,
    // The look of every picture, so that a run on another machine gives the same one: the light theme, Hebrew, no motion.
    colorScheme: 'light',
    locale: 'he-IL',
    reducedMotion: 'reduce',
    trace: 'off',
  },
  // One project: each test sets the size of its own screen (a phone or a computer). The E2E projects (a Pixel and an iPhone)
  // would run every picture twice.
  projects: [{ name: 'screenshots', use: { ...devices['Desktop Chrome'] } }],
})
