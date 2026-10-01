// End-to-end tests: the built PWA, served by `vite preview`, talking to a real API over a throwaway database schema.
// Two projects drive the same specs: Chromium as a Pixel (Android) and WebKit as an iPhone (the WebKit engine is not
// Safari: see docs/manual-ios-checklist.md for what only a real iPhone can show).
import { defineConfig, devices } from '@playwright/test'

// Ports chosen away from the development servers (3000 and 3001) so both can run at the same time.
const APP_PORT = 3100
const API_PORT = 3101
// Where the sample point is: every project starts as a person standing at the point.
export const NEAR = { latitude: 32.3132, longitude: 34.9442, accuracy: 10 }

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
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  globalTeardown: './e2e/global-teardown.js',
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
      command: 'node scripts/dev-seed.mjs e2e --drop && node scripts/dev-seed.mjs e2e && node server/dev.mjs --schema=e2e',
      url: `http://localhost:${API_PORT}/api/public/providers`,
      // GOOGLE_CLIENT_ID is blanked on purpose: with the real one the committee sign-in screen would load Google's script
      // from the internet and log "origin not allowed" for localhost. The tests use the local-only dev sign-in instead.
      env: { API_PORT: String(API_PORT), GOOGLE_CLIENT_ID: '' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The production build, because the service worker only exists there. vite.config.js proxies /api to API_PORT.
      command: `npm run build && npx vite preview --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}`,
      env: { API_PORT: String(API_PORT) },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
