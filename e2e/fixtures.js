// Shared pieces for the end-to-end specs: a `page` that fails its test on unexpected console errors, the sample data
// of the scratch schema, and small helpers for signing in and for resetting what a test changed.
import { test as base, expect } from '@playwright/test'
import he from '../src/i18n/he.js'
import en from '../src/i18n/en.js'

export { expect, he, en }

/** What the browser logs for every request that fails because the test switched the network off on purpose. */
export const OFFLINE_NOISE = /net::ERR_INTERNET_DISCONNECTED/

/**
 * Playwright's WebKit cannot take a page that a service worker serves offline: with the network switched off (or
 * every request aborted) the very first navigation fails with "WebKit encountered an internal error" or "Blocked by Web
 * Inspector", before the worker is asked. So the offline tests run on the Chromium project only, and offline use on an
 * iPhone is on the manual checklist (docs/manual-ios-checklist.md).
 */
export const skipOfflineOnWebKit = (browserName) =>
  test.skip(browserName === 'webkit', 'Playwright WebKit cannot emulate offline for a service-worker page: see docs/manual-ios-checklist.md')

// Sample data created by scripts/dev-seed.mjs (dev-only values that exist only inside the scratch schema).
export const POINTS = {
  lobby: 'BQR-dev00000000000000000001', // GPS checked if available, open to everyone
  basement: 'BQR-dev00000000000000000002', // no GPS check
  gym: 'BQR-dev00000000000000000003', // GPS required, only for Lior
}
export const PEOPLE = {
  lior: { name: 'ליאור', password: 'dev-pass-1' }, // profile language: Hebrew
  john: { name: 'John', password: 'dev-pass-4' }, // profile language: English, so the screens turn English after sign-in
}
export const ADMIN_EMAIL = 'dev@example.test'
export const FAR = { latitude: 32.3632, longitude: 34.9442, accuracy: 10 } // about 5.5 km from the sample points

// ---- console guard ---------------------------------------------------------------------------------------------

const allowed = new WeakMap()

/**
 * Lets one test expect a kind of console error, for example the browser's own note about a 401 that the test provokes
 * on purpose. Everything else that reaches the console as an error fails the test.
 */
export function allowConsoleErrors(page, ...patterns) {
  allowed.get(page).push(...patterns)
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const problems = []
    allowed.set(page, [])
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      if (allowed.get(page).some((pattern) => pattern.test(message.text()))) return
      problems.push(`console.error: ${message.text()}`)
    })
    await use(page)
    expect(problems, 'unexpected console errors').toEqual([])
  },
})

// ---- helpers ---------------------------------------------------------------------------------------------------

/** Picks a person on the sign-in list and signs in. */
export async function signIn(page, person) {
  await page.getByRole('button', { name: new RegExp(person.name) }).click()
  await page.getByLabel(he['login.passwordLabel'], { exact: true }).fill(person.password)
  await page.getByRole('button', { name: he['login.submit'], exact: true }).click()
}

/** Signs the committee in through the local-only shortcut that the scratch-schema API offers. */
export async function adminSignIn(page) {
  await page.goto('/admin')
  await page.getByRole('button', { name: 'כניסת פיתוח' }).click()
  await expect(page.getByRole('heading', { name: 'נקודות סריקה' })).toBeVisible()
}

/** Deletes every scan, so that each test starts without the visits an earlier one made (the cooldown would hide them). */
export async function clearScans(request) {
  const login = await request.post('/api/admin/dev-login', { data: { email: ADMIN_EMAIL } })
  expect(login.ok(), 'dev admin sign-in').toBeTruthy()
  const list = await request.get('/api/admin/scans?limit=500&outcome=all&include_voided=true&include_demo=true')
  for (const scan of (await list.json()).scans) {
    const del = await request.delete(`/api/admin/scans/${scan.id}`, { data: {} })
    expect(del.ok(), `delete scan ${scan.id}`).toBeTruthy()
  }
}
