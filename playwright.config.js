// End-to-end tests: the built PWA, served by `vite preview`, talking to a real API over a throwaway database schema.
// Two projects drive the same specs: Chromium as a Pixel (Android) and WebKit as an iPhone (the WebKit engine is not
// Safari: see docs/manual-ios-checklist.md for what only a real iPhone can show).
import { defineConfig, devices } from '@playwright/test'
import { SAMPLE_POINT } from './scripts/sample-data.mjs'
import { e2eSettings } from './scripts/e2e-config.mjs'

// Two runs can share a machine (several worktrees, or both projects at once) when each has its own app port, API port and
// scratch schema. They come from three environment variables, and the defaults are what every run used before, so CI and
// `npm run test:e2e` are unchanged:
//   E2E_APP_PORT  the preview of the production build (default 3100)
//   E2E_API_PORT  the API, which the preview forwards /api to (default 3101)
//   E2E_SCHEMA    the scratch schema that the seed creates and the run drops (default e2e; a lower-case letter, then
//                 lower-case letters, digits or _, 31 characters at most; never public, dev_ui or neon_auth)
// A second run needs a different value for ALL THREE, for example
//   E2E_APP_PORT=3200 E2E_API_PORT=3201 E2E_SCHEMA=e2e_b npx playwright test --project=iphone-webkit
// A port that is taken fails the run at once, but a schema that two runs share does not: each would drop the other's data.
// A run with another schema also keeps its build, traces and report under node_modules/.cache/bqr-e2e/<schema>, so that
// two runs do not empty each other's `dist`. An invalid value stops the run here, before anything starts.
const { appPort: APP_PORT, apiPort: API_PORT, schema: SCHEMA, paths } = e2eSettings()
// What the child processes (the API, the preview, the seed) get, on top of the environment they inherit.
const RUN_ENV = { E2E_APP_PORT: String(APP_PORT), E2E_API_PORT: String(API_PORT), E2E_SCHEMA: SCHEMA }
// Only the run of another schema has its own build folder: the default run builds into `dist` as it always did.
const OWN_BUILD = paths.buildDir !== 'dist'
const BUILD = OWN_BUILD ? `npm run build -- --outDir ${paths.buildDir}` : 'npm run build'
const PREVIEW = `npx vite preview --port ${APP_PORT} --strictPort${OWN_BUILD ? ` --outDir ${paths.buildDir}` : ''}`
// Where the sample point is: every project starts as a person standing at the point.
export const NEAR = { latitude: SAMPLE_POINT.lat, longitude: SAMPLE_POINT.lng, accuracy: 10 }

export default defineConfig({
  testDir: './e2e',
  // One worker and no parallel files: the specs share one database schema and reset its scans themselves.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // A focused test (an `only`) left in the code would silently skip the rest of the suite: refuse it on CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // On GitHub Actions the failures become annotations on the pull request, and the HTML report is uploaded when a run fails.
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: paths.reportDir }]]
    : [['list'], ['html', { open: 'never', outputFolder: paths.reportDir }]],
  globalTeardown: './e2e/global-teardown.js',
  outputDir: paths.outputDir,
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    timezoneId: 'Asia/Jerusalem',
    permissions: ['geolocation'],
    geolocation: NEAR,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'android-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 14'] } },
  ],
  webServer: [
    {
      // A fresh scratch schema with the sample data (see scripts/dev-seed.mjs), then the API on top of it.
      // The schema name is safe to put in a command: e2eSettings accepts only [a-z][a-z0-9_]{0,30}.
      command: `node scripts/dev-seed.mjs ${SCHEMA} --drop && node scripts/dev-seed.mjs ${SCHEMA} && node server/dev.mjs --schema=${SCHEMA}`,
      url: `http://localhost:${API_PORT}/api/public/providers`,
      // GOOGLE_CLIENT_ID is blanked on purpose: with the real one the committee sign-in screen would load Google's script
      // from the internet and log "origin not allowed" for localhost. The tests use the local-only dev sign-in instead.
      env: { ...RUN_ENV, API_PORT: String(API_PORT), GOOGLE_CLIENT_ID: '' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The production build, because the service worker only exists there. vite.config.js proxies /api to API_PORT.
      command: `${BUILD} && ${PREVIEW}`,
      url: `http://localhost:${APP_PORT}`,
      env: { ...RUN_ENV, API_PORT: String(API_PORT) },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
