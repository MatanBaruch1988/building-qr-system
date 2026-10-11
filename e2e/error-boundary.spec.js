// A screen that breaks while it renders is replaced by a message and a way back, not by a blank page (src/ui/ErrorBoundary.jsx).
//
// The break is real and it happens in the production build: the server answers with a shape that a screen cannot draw (a
// list of visits that is not a list, a committee member whose name is an object), which the test sets up by routing that
// one answer. Nothing exists in the app for the sake of this test.
//
// (The provider app used to break on a session check that answered with no provider in it. It no longer does: it ignores such an
// answer and a stored session without provider details is removed when it is read, see e2e/provider.spec.js. A screen of the
// provider app that still breaks on a shape it cannot draw is the list of today's visits, so the tests route that one. If
// the app is made to tolerate that answer too, this test needs the next real way to break a screen, not a hook in the app.)
import { test, expect, he, en, PEOPLE, adminSignIn, signIn, allowConsoleErrors, isErrorReport, expectErrorReport } from './fixtures.js'

// The service worker is not what is tested here, and a page that it controls can send a request round the test's route.
test.use({ serviceWorkers: 'block' })

const COMPUTER = { width: 1280, height: 800 }
// The greeting of the home screen. The sign-in screen's heading ("Hi {name}") has no comma: it must not match.
const HOME_HE = /^שלום,/
const HOME_EN = /^Hello,/
const VISITS_LIST = '**/api/my/scans'
const ADMIN_ME = '**/api/admin/me'
// A crash is also noted on the device and reported once somebody is signed in (src/ui/errorReport.js): the same crashes, seen from the server's side.
const MY_ERRORS = '/api/my/errors'
const ADMIN_ERRORS = '/api/admin/client-errors'
const OUTBOX = 'qr.errors.v1'
const outboxOf = (page) => page.evaluate((key) => localStorage.getItem(key), OUTBOX)

/** The lines that the app logs for a crash. The page's console guard fails the test on anything else. */
function watchCrashLines(page) {
  allowConsoleErrors(page, /^Screen crash \(/)
  const lines = []
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith('Screen crash (')) lines.push(message.text())
  })
  return lines
}

/**
 * The list of the person's visits answers with something that is not a list: the home screen cannot draw its rows. The home screen asks
 * for that list itself, a moment after it is drawn. A test calls this only after the answer to that first request (this is not about
 * the reload, which the `page` fixture makes safe): a route that is added earlier catches the screen's own request, and the screen
 * breaks before the test reloads it.
 */
const breakVisitsList = (page) =>
  page.route(VISITS_LIST, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { scans: null } }) : route.continue())

const fitsTheWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

async function expectTouchTargets(...buttons) {
  for (const button of buttons) expect((await button.boundingBox()).height, 'a touch target of at least 44px').toBeGreaterThanOrEqual(44)
}

test('a broken screen of the provider app shows a message and two ways back, and each one works', async ({ page }) => {
  const crashes = watchCrashLines(page)
  await page.goto('/')
  const visitsListed = page.waitForResponse(VISITS_LIST)
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: HOME_HE })).toBeVisible()
  await visitsListed

  await breakVisitsList(page)
  await page.reload()
  const heading = page.getByRole('heading', { name: he['crash.title'] })
  const tryAgain = page.getByRole('button', { name: he['crash.retry'], exact: true })
  const reload = page.getByRole('button', { name: he['crash.reload'], exact: true })
  await expect(heading).toBeVisible()
  await expect(page.getByRole('alert')).toContainText(he['crash.title'])
  await expect(heading).toBeFocused()
  await expect(page.getByRole('heading', { name: HOME_HE })).toHaveCount(0) // the broken screen is gone, not half drawn
  await expectTouchTargets(tryAgain, reload)
  expect(await fitsTheWidth(page)).toBe(true)
  expect(await heading.evaluate((el) => el.closest('[dir]').getAttribute('dir'))).toBe('rtl')

  // Try again: once the cause is gone the app is back, with the person still signed in.
  await page.unroute(VISITS_LIST)
  const firstReport = page.waitForRequest(isErrorReport(MY_ERRORS))
  await tryAgain.click()
  await expect(page.getByRole('heading', { name: HOME_HE })).toContainText(PEOPLE.ploni.name)
  await expect(heading).toHaveCount(0)
  // The crash that was noted on the phone goes to the server now that the app runs again: the screen, the error's name, the build and a
  // count, and not a word of the message. The server took it, so the phone has nothing left to send.
  await expectErrorReport(await firstReport, [{ kind: 'crash', place: 'provider:home', name: 'TypeError' }])
  await expect.poll(() => outboxOf(page)).toBeNull()

  // Reload the app: the same, by loading the page again.
  await breakVisitsList(page)
  await page.reload()
  await expect(heading).toBeVisible()
  await page.unroute(VISITS_LIST)
  const secondReport = page.waitForRequest(isErrorReport(MY_ERRORS))
  await reload.click()
  await expect(page.getByRole('heading', { name: HOME_HE })).toContainText(PEOPLE.ploni.name)
  await expectErrorReport(await secondReport, [{ kind: 'crash', place: 'provider:home', name: 'TypeError' }]) // a count of 1: the first one was sent and removed
  await expect.poll(() => outboxOf(page)).toBeNull()

  // One line per crash, with the error's name and nothing the person or the server said. (Sending the reports logged nothing: the page's
  // console guard fails this test on any other console error.)
  expect(crashes).toEqual(['Screen crash (provider app): TypeError', 'Screen crash (provider app): TypeError'])
})

test('the broken screen speaks the language and wears the theme that the person chose on their phone', async ({ page }) => {
  const crashes = watchCrashLines(page)
  await page.goto('/')
  await page.getByLabel(he['lang.label']).selectOption('en') // John reads English: he picks it himself
  await page.getByLabel(en['theme.label']).selectOption('light')
  const visitsListed = page.waitForResponse(VISITS_LIST)
  await signIn(page, PEOPLE.john, en)
  await expect(page.getByRole('heading', { name: HOME_EN })).toBeVisible()
  await visitsListed

  await breakVisitsList(page)
  await page.reload()
  const heading = page.getByRole('heading', { name: en['crash.title'] })
  await expect(heading).toBeVisible()
  await expect(page.getByRole('button', { name: en['crash.retry'], exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: en['crash.reload'], exact: true })).toBeVisible()
  const root = await heading.evaluate((el) => {
    const box = el.closest('[lang]')
    return { lang: box.getAttribute('lang'), dir: box.getAttribute('dir'), background: getComputedStyle(box).backgroundColor }
  })
  expect(root).toEqual({ lang: 'en', dir: 'ltr', background: 'rgb(244, 245, 247)' }) // the light page background, --w-bg

  await page.setViewportSize(COMPUTER)
  await expect(heading).toBeVisible()
  expect(await fitsTheWidth(page)).toBe(true)
  expect(crashes).toEqual(['Screen crash (provider app): TypeError'])
})

test('a broken screen of the committee app is Hebrew, on a phone and on a computer, and Try again brings the app back', async ({ page }) => {
  allowConsoleErrors(page, /status of 401/) // the sign-in screen asks /api/admin/me before anyone is signed in
  const crashes = watchCrashLines(page)
  await adminSignIn(page)

  // The committee member's name arrives as an object: the shell cannot draw it.
  await page.route(ADMIN_ME, (route) => route.fulfill({ json: { admin: { name: { first: 'x' }, email: 'a@example.test' } } }))
  await page.goto('/admin')
  const heading = page.getByRole('heading', { name: he['crash.title'] })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()
  expect(await heading.evaluate((el) => ({ lang: el.closest('[lang]').getAttribute('lang'), dir: el.closest('[dir]').getAttribute('dir') }))).toEqual({ lang: 'he', dir: 'rtl' })
  const tryAgain = page.getByRole('button', { name: he['crash.retry'], exact: true })
  await expectTouchTargets(tryAgain, page.getByRole('button', { name: he['crash.reload'], exact: true }))
  expect(await fitsTheWidth(page)).toBe(true)

  await page.setViewportSize(COMPUTER)
  await expect(heading).toBeVisible()
  expect(await fitsTheWidth(page)).toBe(true)

  await page.unroute(ADMIN_ME)
  const report = page.waitForRequest(isErrorReport(ADMIN_ERRORS))
  await tryAgain.click()
  await expect(page.getByRole('heading', { name: 'נקודות סריקה' })).toBeVisible()
  await expect(heading).toHaveCount(0)
  // The committee app sends the crash with its cookie, through its own API client: the tab that was open, the name of the error, no message.
  await expectErrorReport(await report, [{ kind: 'crash', place: 'committee:points', name: 'Error' }])
  await expect.poll(() => outboxOf(page)).toBeNull()
  expect(crashes).toEqual(['Screen crash (committee app): Error'])
})
