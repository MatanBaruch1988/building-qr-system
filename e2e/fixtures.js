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
export const BUILDING_NAME = 'בניין הדוגמה' // the invented name that scripts/dev-seed.mjs sets
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

// ---- navigation: the page's requests are settled before its document is replaced -------------------------------------------
//
// THE RACE. WebKit (the iphone-webkit project) refuses a fetch that STARTS while it is replacing the page, and logs "Fetch API cannot
// load <url> due to access control checks". Playwright's WebKit driver reports every engine console error from the JavaScript source as
// a page error, so the console guard of the `page` fixture fails the test with `uncaught: //localhost:<port>/api/... due to access control checks.`
// Chromium logs nothing. The app is not at fault: its `api()` and its hooks catch the failed fetch, and it logs nothing itself. The
// message must never be allowed in the guard; the race is closed here instead. Measured on 08/10/2026:
//   - a fetch that is already in flight when the page is replaced (`page.goto` to another document, `page.reload`) is cancelled
//     quietly, with no error;
//   - a fetch that starts while the page is being replaced (from `pagehide`, from a timer during the swap, or from an effect that
//     runs late) is refused, and WebKit logs the message.
// A screen is drawn in one render and its requests start from effects a task later, sometimes through the service worker. So a test
// that navigates as soon as a heading shows can land in the gap, and under load the gap is wider. A wait for "the requests of this
// screen" depends on knowing which requests a screen makes, so it goes stale when a screen gains one; and a new test can forget it.
//
// THE WAIT. The `page` fixture wraps `page.goto` and `page.reload`. Before a call that replaces the document, it waits until the
// page has settled, and only then navigates. Nobody has to know which requests a screen makes, and a new test cannot repeat the mistake.
//   - Counting. An init script wraps `window.fetch` and counts the calls that have not finished (`window.__e2eFetches`). The count
//     is taken at the moment the app calls fetch, before the call has passed the service worker and reached the network, which is
//     exactly the gap above (Playwright's `request` events come after it). A call counts as finished when its answer has arrived in
//     full (the body too: the app acts on the body, not on the headers). The wrapper calls the real fetch through
//     `window.__e2eFetch`, looked up at call time, so a test can put something beneath the counter. It passes the arguments on and
//     returns the promise of the real call unchanged in value or in rejection. The init script is injected by the driver, not
//     written into the page, so the Content-Security-Policy of the preview does not apply to it (and it allows no inline script).
//     The apps make no XMLHttpRequest, `sendBeacon`, EventSource or WebSocket call, and every request goes through the one `fetch` in
//     src/api/client.js, so the count is complete. Images, scripts and styles are not fetches and were not seen to cause the message.
//   - Settled means: no counted call is pending, and none started across a flush of the page's pending work (one animation frame,
//     then one task: React runs the passive effects of a render in a task that was queued before the flush's own). It takes two such
//     quiet checks in a row, and the count is read again while calls are pending, because an answer can set state, render and start
//     the next call (the check-in's answer makes the home screen ask for today's visits again).
//   - There is a limit, 10 seconds. After it the test fails with the requests that were still pending, never a hang.
//   - Polling. The apps poll with a timer in two places (src/main.jsx: an hourly check for a new service worker, which is not a
//     fetch of the page; src/worker/hooks.js: the 30 second flush of the offline queue, which sends only if a visit waits). A poll
//     that fires while the page settles is counted like any other call. One that fires in the instant between the last check and the
//     navigation is the one case this cannot close; no test lands there.
//
// WHERE. The wait is in the navigation, not in `signIn` or `adminSignIn`, on purpose. "A tab that is opened by its address right
// after signing in" (e2e/admin.spec.js) needs `adminSignIn` to return the moment the shell appears and to wait for nothing before
// its next `page.goto`, which is a fragment change (below). And what matters is the request that starts during the swap, so the
// right moment to wait is right before the swap, whatever the test did before it.
//
// THE FRAGMENT. A `page.goto` whose address differs from the current page only by its fragment (`/admin` to `/admin#history`) is
// the same document: nothing is replaced, so nothing waits. A goto from `about:blank` (the first one of a test) has nothing to wait
// for either. Everything else waits, including a goto to an address with no fragment from one that has it, and a goto to the very
// address the page is on: WebKit loads a new document for it (measured), Chromium keeps the document, and waiting does no harm there.
//
// NO WAY AROUND IT, FOR NOW. A request that a test holds open on purpose (a `page.route` handler that does not answer yet) must be
// answered before the test navigates: the page cannot settle while it is pending, and the failure after 10 seconds names it. No test
// needs otherwise today (the answers that a11y.spec.js and admin.spec.js hold back are released before their next navigation), so
// there is no helper that navigates without the wait. The day a test must, add one here, next to `settleBeforeNavigating`, that keeps
// the unwrapped `goto` and `reload`, and give each use a comment that says why that navigation may not wait.

const SETTLE_LIMIT_MS = 10_000
const QUIET_CHECKS = 2

/**
 * The init script of the `page` fixture. It runs in the page before any script of the page (so before the app can call fetch), and
 * is serialised by Playwright: it must not use anything from this file.
 */
function countFetches() {
  const w = /** @type {any} */ (window)
  if (w.__e2eFetches) return
  /** @type {Map<number, string>} */
  const pending = new Map()
  /** @type {Array<() => void>} */
  let waiting = []
  const tracker = {
    started: 0,
    pending,
    /** Resolves when no counted call is pending any more. */
    whenDrained: () => (pending.size === 0 ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve))),
  }
  const finish = (/** @type {number} */ id) => {
    pending.delete(id)
    if (pending.size > 0) return
    const resolvers = waiting
    waiting = []
    for (const resolve of resolvers) resolve()
  }
  const describe = (/** @type {any} */ input, /** @type {any} */ init) => {
    try {
      const request = typeof input === 'string' || input instanceof URL ? null : input
      const method = (init && init.method) || (request && request.method) || 'GET'
      return `${String(method).toUpperCase()} ${new URL(request ? request.url : String(input), location.href).pathname}`
    } catch {
      return 'fetch'
    }
  }
  /** The whole body of a copy of the answer, or null when there is no copy to read. */
  const readCopy = (/** @type {Response} */ response) => {
    try {
      return response.clone().arrayBuffer()
    } catch {
      return null
    }
  }
  w.__e2eFetch = w.fetch
  w.__e2eFetches = tracker
  w.fetch = function fetch(/** @type {any[]} */ ...args) {
    tracker.started += 1
    const id = tracker.started
    pending.set(id, describe(args[0], args[1]))
    let call
    try {
      call = w.__e2eFetch(...args)
    } catch (error) {
      finish(id)
      throw error
    }
    return call.then(
      (/** @type {Response} */ response) => {
        // The headers are here; the body may not be. The app reads the body before it acts, so the call is finished when a copy of the
        // body has been read to its end (the app's own copy is untouched).
        const read = readCopy(response)
        if (read) read.then(() => finish(id), () => finish(id))
        else finish(id)
        return response
      },
      (/** @type {unknown} */ error) => {
        finish(id)
        throw error
      },
    )
  }
}

/**
 * Runs in the page: one step of settling. With calls pending it waits (at most `sliceMs`) until they have finished and says the page
 * is not quiet. With none pending it lets the page's pending work run, one animation frame and then one task, and says the page is
 * quiet if still nothing is pending and no call was made meanwhile. Returns null in a document without the counter.
 * @param {number} sliceMs
 */
async function flushPage(sliceMs) {
  const tracker = /** @type {any} */ (window).__e2eFetches
  if (!tracker) return null
  const startedBefore = tracker.started
  const pendingBefore = tracker.pending.size
  if (pendingBefore > 0) {
    await Promise.race([tracker.whenDrained(), new Promise((resolve) => setTimeout(resolve, sliceMs))])
  } else {
    await new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0))
      setTimeout(resolve, 100) // a page that is hidden draws no frames: the task alone is then the flush
    })
  }
  return {
    quiet: pendingBefore === 0 && tracker.pending.size === 0 && tracker.started === startedBefore,
    pending: [...tracker.pending.values()],
  }
}

/**
 * Waits until the page has settled (see above), or throws, after SETTLE_LIMIT_MS, with the calls that were still pending.
 * @param {import('@playwright/test').Page} page
 * @param {string} before  what the test is about to do, for the message
 */
async function settle(page, before) {
  const deadline = Date.now() + SETTLE_LIMIT_MS
  let quiet = 0
  let pending = /** @type {string[]} */ ([])
  while (quiet < QUIET_CHECKS) {
    const left = deadline - Date.now()
    if (left <= 0) {
      throw new Error(
        `The page did not settle within ${SETTLE_LIMIT_MS / 1000} s before ${before}. Still pending: ${pending.join(', ') || 'a call started after the last check'}. ` +
          'A request that the test holds open on purpose must be answered before the test navigates (see e2e/fixtures.js).',
      )
    }
    let step
    try {
      step = await page.evaluate(flushPage, Math.min(left, 1_000))
    } catch (error) {
      // The page navigated by itself while we looked: its new document has a fresh count, so start over.
      if (/context was destroyed|navigation|Navigation/.test(String(/** @type {Error} */ (error)?.message))) {
        quiet = 0
        continue
      }
      throw error
    }
    if (step === null) return // a document without the counter (an error page): nothing can be counted
    pending = step.pending
    quiet = step.quiet ? quiet + 1 : 0
  }
}

/**
 * True when navigating to `target` replaces the document that `current` is. Not when `current` is not a web page (about:blank, the
 * first goto of a test), and not when the two addresses differ only by their fragment (the same document, the fragment changes).
 * @param {string} current  page.url()
 * @param {string} target  what the test passed to goto
 * @param {string | undefined} base  the baseURL of the test, which Playwright resolves a relative address against
 */
function replacesTheDocument(current, target, base) {
  let from
  let to
  try {
    from = new URL(current)
    if (from.protocol !== 'http:' && from.protocol !== 'https:') return false
    to = new URL(target, base ?? current)
  } catch {
    return false // not an address: goto will say so
  }
  const withoutFragment = (/** @type {URL} */ url) => url.href.split('#')[0]
  const fragmentOnly = to.href.includes('#') && withoutFragment(to) === withoutFragment(from) && to.href !== from.href
  return !fragmentOnly
}

/**
 * Makes `page.goto` and `page.reload` of this page settle the page first (see above). Same arguments, same results.
 * @param {import('@playwright/test').Page} page
 * @param {string | undefined} baseURL
 */
function settleBeforeNavigating(page, baseURL) {
  const goto = page.goto.bind(page)
  const reload = page.reload.bind(page)
  page.goto = async (url, options) => {
    if (replacesTheDocument(page.url(), url, baseURL)) await settle(page, `goto ${url}`)
    return goto(url, options)
  }
  page.reload = async (options) => {
    await settle(page, 'reload')
    return reload(options)
  }
}

export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const problems = []
    allowed.set(page, [])
    await page.addInitScript(countFetches)
    settleBeforeNavigating(page, baseURL)
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
  //
  // The rule goes in through the CSSOM (a constructed stylesheet that the document adopts), not as a style element: the
  // page's Content-Security-Policy has no 'unsafe-inline' in style-src, and a style element that a script adds is an inline
  // style, which the policy refuses. A stylesheet built in script is not subject to style-src, so this works under it. It
  // is added once per document, and stays until the page is navigated away (as the style element did).
  await page.evaluate(() => {
    if (!window.__a11ySettled) {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync('*, *::before, *::after { animation: none !important; transition: none !important; }')
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      window.__a11ySettled = sheet
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
