// Shared pieces for the end-to-end specs: a `page` that fails its test on unexpected console errors, the sample data
// of the scratch schema, and small helpers for signing in and for resetting what a test changed.
import { test as base, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import he from '../src/i18n/he.js'
import en from '../src/i18n/en.js'
import ru from '../src/i18n/ru.js'
import { SAMPLE_POINT, SAMPLE_FAR_POINT, SAMPLE_PROVIDER_NAMES } from '../scripts/sample-data.mjs'
import { A11Y_BASELINE } from './a11y-baseline.js'
import { flattenViolations, compareWithBaseline, formatReport } from './a11y-report.js'

export { expect, he, en, ru, SAMPLE_POINT }

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
  gym: 'BQR-dev00000000000000000003', // GPS required, only for Ploni
  switchedOff: 'BQR-dev00000000000000000004', // the old point, switched off: a scan of it is refused (point_inactive)
}
export const PEOPLE = {
  ploni: { name: SAMPLE_PROVIDER_NAMES.cleaner, password: 'dev-pass-1' },
  john: { name: 'John', password: 'dev-pass-4' }, // reads English: he picks it on his phone, nobody sets it for him
}
export const ADMIN_EMAIL = 'dev@example.test'
export const BUILDING_ADDRESS = 'רחוב הדוגמה 1, עיר לדוגמה' // the invented address that scripts/dev-seed.mjs sets
export const FAR = { latitude: SAMPLE_FAR_POINT.lat, longitude: SAMPLE_FAR_POINT.lng, accuracy: 10 } // about 5.5 km from the sample points

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

/** Picks a person on the sign-in list and signs in. `words` is the dictionary of the language the screen is in now. */
export async function signIn(page, person, words = he) {
  await page.getByRole('button', { name: new RegExp(person.name) }).click()
  await page.getByLabel(words['login.passwordLabel'], { exact: true }).fill(person.password)
  await page.getByRole('button', { name: words['login.submit'], exact: true }).click()
}

/** Signs the committee in through the local-only shortcut that the scratch-schema API offers. */
export async function adminSignIn(page) {
  await page.goto('/admin')
  await page.getByRole('button', { name: 'כניסת פיתוח' }).click()
  await expect(page.getByRole('heading', { name: 'נקודות סריקה' })).toBeVisible()
}

/**
 * The request that an app makes to report its errors (src/ui/errorReport.js): a POST to `path` (`/api/my/errors` for the provider app,
 * `/api/admin/client-errors` for the committee app). Pass it to `page.waitForRequest`, which must be called before the action that
 * makes the app send it.
 */
export const isErrorReport = (path) => (request) => request.method() === 'POST' && new URL(request.url()).pathname === path

/**
 * Checks a request that an app made to report its errors: the server answered 200, and the body is `{ events }` with exactly the events
 * in `expected` (`kind`, `place` and a `name` or a `code`; `count` is 1 unless it says), each with the build of an end-to-end run
 * ('dev') and with no other field. Nothing that says what happened is in the body: no message, no stack, no address, no token, no QR code.
 */
export async function expectErrorReport(request, expected) {
  const raw = request.postData() ?? ''
  const body = JSON.parse(raw)
  expect(Object.keys(body), 'the body is only a list of events').toEqual(['events'])
  expect(body.events).toHaveLength(expected.length)
  expected.forEach((want, i) => {
    const event = body.events[i]
    expect(Object.keys(event).sort(), `the fields of event ${i}`).toEqual([...Object.keys(want), 'build', 'count'].sort())
    expect(event).toEqual({ ...want, build: 'dev', count: 1, ...(want.count ? { count: want.count } : {}) })
  })
  expect(raw).not.toMatch(/message|stack|Cannot read|https?:|\.js|qrp_|BQR-/)
  const response = await request.response()
  expect(response?.status(), 'the server took the report').toBe(200)
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

// ---- accessibility ---------------------------------------------------------------------------------------------

/**
 * The rules that the scan runs: WCAG 2.1 level A and AA (the level that tests/contrast.test.js holds the colour tokens to),
 * and axe's `best-practice` rules. Those are not WCAG success criteria: they are the good practice that screen-reader
 * users feel, mostly the structure of the page (one banner and one main landmark, landmarks that can be told apart, a
 * heading level that follows the one before it, everything inside a landmark).
 */
export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

/**
 * Scans the page as it is now with axe-core (A11Y_TAGS: WCAG 2.1 A and AA, and best practice) and fails the test, with a list that says what
 * is wrong and where, when it finds a problem that e2e/a11y-baseline.js does not list. The test goes on after a failure
 * (a soft expectation), so one run lists every screen that has a problem.
 *
 * - `context` names the screen and is how the report and the baseline find it, so it is unique per scan ("provider he:
 *   sign-in list [dark]").
 * - `exclude` is a list of CSS selectors that axe must not look into: only content that is not ours (a third party's
 *   iframe), each one explained where it is written.
 *
 * The baseline is matched exactly: a baseline entry covers one rule on one element (the CSS target) of one screen. A new
 * problem of the same rule on another element still fails, and so does a baseline entry whose problem is gone, so the
 * list cannot go stale.
 *
 * What axe cannot decide ("incomplete" in its result) is not a failure. For colours that is the text of a `<select>`
 * (the arrow is a background image) and some text inside a dialog (axe cannot tell what the fixed overlay covers); the
 * colour tokens of those are held to AA by tests/contrast.test.js.
 */
export async function expectNoA11yViolations(page, { context, exclude = [] }) {
  // Scan the page in its settled state. A colour that is still on its way (a fade, or a transition that a change of theme
  // just started: WebKit keeps showing the text of the light theme on the dark page until a frame has been drawn) would be
  // measured as it is at that moment. So every animation and transition is switched off first, which puts every element
  // at its end state at once, the way Playwright does for a screenshot.
  await page.evaluate(() => {
    if (!document.getElementById('a11y-settled')) {
      const style = document.createElement('style')
      style.id = 'a11y-settled'
      style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'
      document.head.append(style)
    }
    void getComputedStyle(document.body).color // applies the style now
  })
  // Legacy mode runs axe in the page itself, without the extra page that axe-core/playwright opens to join the results of
  // frames: about twice as fast, and the only thing it gives up is a look into cross-origin iframes, which are excluded.
  const builder = new AxeBuilder({ page }).withTags(A11Y_TAGS).setLegacyMode()
  for (const selector of exclude) builder.exclude(selector)
  const { violations } = await builder.analyze()

  const report = compareWithBaseline(flattenViolations(violations), A11Y_BASELINE, context)
  expect.soft(report.fresh.length + report.gone.length, formatReport(context, report)).toBe(0)
}
