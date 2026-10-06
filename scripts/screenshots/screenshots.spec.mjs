// Takes the pictures for the README (npm run screenshots, see docs/screenshots/README.md). It is not a test of the app: it
// drives the two apps the way the E2E specs do and saves what is on the screen, so the people who read the README see the app.
//
// What it shows is the fake sample data of the scratch schema (scripts/dev-seed.mjs, plus a week of visits from
// scripts/screenshots/seed-history.mjs) and nothing else; assertLocalScratch refuses to run on anything but a local address and
// a scratch schema. The dates in the pictures are relative to the day of the run: the visits are one to five days old, and the
// check-in of the provider app is made at the moment of the run.
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { devices } from '@playwright/test'
import { test, expect, he, POINTS, PEOPLE, signIn, adminSignIn, allowConsoleErrors, OFFLINE_NOISE } from '../../e2e/fixtures.js'
import { MAX_IMAGE_BYTES, SCREENSHOTS_DIR, SCREENSHOTS_SCHEMA, assertLocalScratch } from './settings.mjs'

// The heading of a day in the History tab: the date (DD/MM/YYYY) and how many visits (the screen draws the count first, in Hebrew).
const DAY_HEADING = /^\d{2}\/\d{2}\/\d{4} · \d+$/
const OUT = fileURLToPath(new URL(`../../${SCREENSHOTS_DIR}/`, import.meta.url))

// The screens. A phone is 390 px wide (the width of an iPhone 14, and what the layouts are checked at), drawn at twice the
// density; a computer is 1280 px wide at the ordinary density. Both are Chromium, the light theme unless a test says dark.
// (the device's own browser type is left out: a describe group may not change the browser, and this is Chromium anyway)
const pixel = { ...devices['Pixel 7'] }
delete pixel.defaultBrowserType
const PHONE = {
  ...pixel,
  viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 },
  deviceScaleFactor: 2,
}
const COMPUTER = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }

/** Saves what is on the screen as `name` in docs/screenshots and refuses an image that is bigger than the limit. */
async function shot(page, name, options = {}) {
  await page.evaluate(() => globalThis.document.fonts.ready) // (the function runs in the page, where globalThis is the window)
  const path = `${OUT}${name}`
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', ...options })
  const bytes = statSync(path).size
  expect(bytes, `${name} is ${Math.round(bytes / 1024)} KB: the most is ${MAX_IMAGE_BYTES / 1024} KB (use a smaller clip, or a lighter format)`).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
  console.log(`  ${name}  ${(bytes / 1024).toFixed(0)} KB`)
}

/** Scrolls the page until the top of `locator` is `margin` pixels below the top of the screen (the page, not an inner box, is what scrolls). */
async function scrollTo(locator, margin = 24) {
  await locator.evaluate((el, gap) => globalThis.scrollTo(0, el.getBoundingClientRect().top + globalThis.scrollY - gap), margin)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  const { schema } = assertLocalScratch({ baseURL: test.info().project.use.baseURL, schema: SCREENSHOTS_SCHEMA })
  mkdirSync(OUT, { recursive: true })
  // The sample seed (a scratch schema, the providers, the points, a few refused visits) has no visits of its own. This adds a week.
  execFileSync(process.execPath, ['scripts/screenshots/seed-history.mjs', schema], { stdio: 'inherit' })
})

test.beforeEach(({ baseURL }) => {
  // Again, with the address that this test really uses.
  assertLocalScratch({ baseURL, schema: SCREENSHOTS_SCHEMA })
})

test.describe('the provider app, on a phone', () => {
  test.use(PHONE)

  test('the sign-in list, the check-in and the visit that waits for a network', async ({ page, context }) => {
    allowConsoleErrors(page, OFFLINE_NOISE) // every request that fails while the network is off is logged by the browser

    await page.goto(`/scan?code=${POINTS.lobby}`)
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
    await expect(page.getByText(/נקודת סריקה/)).toContainText('לובי')
    await shot(page, 'provider-phone-sign-in.png')

    await signIn(page, PEOPLE.ploni)
    await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()
    await shot(page, 'provider-phone-check-in.png')

    // A second point, so that the phone knows it, then the network goes away and the same person scans it again.
    await page.getByRole('button', { name: he['checkin.done'] }).click()
    await page.goto(`/scan?code=${POINTS.basement}`)
    await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()
    await page.getByRole('button', { name: he['checkin.done'] }).click()
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload() // controlled by the service worker from here on, so that the app opens without a network

    await context.setOffline(true)
    await page.goto(`/scan?code=${POINTS.basement}`)
    await expect(page.getByRole('heading', { name: he['checkin.queued.title'] })).toBeVisible()
    await shot(page, 'provider-phone-saved-offline.png')
    await context.setOffline(false)
  })
})

test.describe('the committee app, on a phone', () => {
  test.use(PHONE)

  test.beforeEach(({ page }) => {
    allowConsoleErrors(page, /status of 401/) // the sign-in screen asks who is signed in before anybody is
  })

  test('points and history', async ({ page }) => {
    await adminSignIn(page)
    await expect(page.getByRole('article').filter({ hasText: 'לובי' })).toBeVisible()
    await shot(page, 'committee-phone-points.png')

    await page.goto('/admin#history')
    await expect(page.getByRole('heading', { level: 1, name: 'היסטוריית נוכחות' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'טוען' })).toHaveCount(0)
    // The filters take most of a phone's screen: scroll to the visits, which are what this picture is for (the top bar stays: 78 px, and a little air).
    await scrollTo(page.getByRole('heading', { level: 2, name: DAY_HEADING }).first(), 88)
    await shot(page, 'committee-phone-history.png')
  })
})

test.describe('the committee app, on a computer', () => {
  test.use(COMPUTER)

  test.beforeEach(({ page }) => {
    allowConsoleErrors(page, /status of 401/)
  })

  test('points, history and the help', async ({ page }) => {
    await adminSignIn(page)
    await expect(page.getByRole('article').filter({ hasText: 'לובי' })).toBeVisible()
    await shot(page, 'committee-computer-points.png')

    await page.goto('/admin#history')
    await expect(page.getByRole('heading', { level: 1, name: 'היסטוריית נוכחות' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'טוען' })).toHaveCount(0)
    await shot(page, 'committee-computer-history.png')

    await page.goto('/admin#committee')
    await expect(page.getByRole('heading', { level: 1, name: 'חברי הוועד' })).toBeVisible()
    await page.getByRole('button', { name: 'איך עובדים עם המערכת' }).click()
    const help = page.getByRole('region', { name: 'איך עובדים עם המערכת' })
    await expect(help.getByRole('heading', { level: 3, name: 'נקודות ושלטי QR' })).toBeVisible()
    await scrollTo(help, 24)
    await shot(page, 'committee-computer-help.png')
  })

  test('the dark theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await adminSignIn(page)
    await expect(page.getByRole('article').filter({ hasText: 'לובי' })).toBeVisible()
    await shot(page, 'committee-computer-points-dark.png')
  })
})
