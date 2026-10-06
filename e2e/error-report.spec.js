// A session that the server ended is reported by the app that lost it (src/ui/errorReport.js, ADR 0007 decision 3): the screen the person
// was on, the code that the server answered, and nothing else. It is noted on the device when it happens and goes to the server with the
// next report, which is after the next sign-in, because both endpoints need a session. (A crash is covered in e2e/error-boundary.spec.js,
// where the screen is made to break the way that spec does it.)
//
// The server ends the session in the one way that a test can make without a hook in the app: the answer to the app's own call is
// replaced with the 401 that the server gives, the way e2e/error-boundary.spec.js replaces an answer to make a screen break. The page's
// console guard fails the test on any console error that is not allowed, so sending the report is also shown to leave the console clean;
// the one thing allowed is the browser's own line about the 401 that the test provokes.
//
// Both projects run it (the Pixel in Chromium and the iPhone in WebKit); nothing here goes offline.
import { test, expect, he, PEOPLE, adminSignIn, signIn, allowConsoleErrors, isErrorReport, expectErrorReport } from './fixtures.js'

// The service worker is not what is tested here, and a page that it controls can send a request round the test's route.
test.use({ serviceWorkers: 'block' })

const OUTBOX = 'qr.errors.v1'
const outboxOf = (page) => page.evaluate((key) => localStorage.getItem(key), OUTBOX)

test('a provider whose session the server ended is reported after the next sign-in, with the screen and the code', async ({ page }) => {
  allowConsoleErrors(page, /status of 401/) // the session check that the test makes answer 401
  // The route is there from the start and does nothing until the test says that the server ended the session: a route that is added while
  // requests are on their way would catch them too.
  let sessionEnded = false
  await page.route('**/api/session', (route) =>
    sessionEnded && route.request().method() === 'GET'
      ? route.fulfill({ status: 401, json: { error: { code: 'invalid_session', message: 'Session expired' } } })
      : route.continue())
  const homeLoaded = Promise.all([page.waitForResponse('**/api/my/scans'), page.waitForResponse('**/api/my/device-status')])
  await page.goto('/')
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: /^שלום,/ })).toBeVisible()
  await homeLoaded // nothing is on its way when the page is loaded again: WebKit reports a request that a reload cuts short as an uncaught error

  // The server ended the session: the app finds out when it asks at the next start.
  sessionEnded = true
  await page.reload()
  await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
  await expect(page.getByText(he['error.invalid_session'])).toBeVisible()
  // Nobody is signed in, so nothing can be sent: the note waits on the phone.
  expect(JSON.parse(await outboxOf(page))).toEqual([{ kind: 'signed_out', place: 'provider:home', code: 'invalid_session', build: 'dev', count: 1 }])

  // The next sign-in sends it.
  sessionEnded = false
  const report = page.waitForRequest(isErrorReport('/api/my/errors'))
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: /^שלום,/ })).toBeVisible()
  await expectErrorReport(await report, [{ kind: 'signed_out', place: 'provider:home', code: 'invalid_session' }])
  await expect.poll(() => outboxOf(page)).toBeNull()
})

test('a provider who signs out by choice is not reported', async ({ page }) => {
  await page.goto('/')
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: /^שלום,/ })).toBeVisible()
  await page.getByRole('button', { name: he['home.switchWorker'] }).click()
  await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
  expect(await outboxOf(page)).toBeNull()
})

test('a committee member whose session the server ended is reported after the next sign-in, with the tab and the code', async ({ page }) => {
  allowConsoleErrors(page, /status of 401/) // the sign-in screen asks /api/admin/me before anyone is signed in, and the providers call that the test makes answer 401
  // The route is there from the start and does nothing until the test says that the server ended the session (see the provider's test).
  let sessionEnded = false
  await page.route('**/api/admin/providers', (route) =>
    sessionEnded
      ? route.fulfill({ status: 401, json: { error: { code: 'admin_required', message: 'Admin session expired' } } })
      : route.continue())
  const shellLoaded = Promise.all([page.waitForResponse('**/api/admin/points'), page.waitForResponse('**/api/admin/providers')])
  await adminSignIn(page)
  await shellLoaded

  // The server ended the session: the next call of a screen is refused (here the one that the Providers tab makes), and the app answers
  // with the sign-in screen.
  sessionEnded = true
  await page.getByRole('button', { name: 'ספקים', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'ניהול נוכחות הבניין' })).toBeVisible()
  await expect(page.getByText('פג תוקף ההתחברות. היכנסו שוב.')).toBeVisible()
  // Several calls may find the session gone at once, and it is one sign-out.
  expect(JSON.parse(await outboxOf(page))).toEqual([{ kind: 'signed_out', place: 'committee:providers', code: 'admin_required', build: 'dev', count: 1 }])

  sessionEnded = false
  const report = page.waitForRequest(isErrorReport('/api/admin/client-errors'))
  await page.getByRole('button', { name: 'כניסת פיתוח' }).click()
  await expect(page.getByRole('heading', { name: 'נותני שירות', level: 1 })).toBeVisible()
  await expectErrorReport(await report, [{ kind: 'signed_out', place: 'committee:providers', code: 'admin_required' }])
  await expect.poll(() => outboxOf(page)).toBeNull()
})

test('a committee member who signs out by choice is not reported', async ({ page }) => {
  allowConsoleErrors(page, /status of 401/) // the sign-in screen asks /api/admin/me before anyone is signed in
  await adminSignIn(page)
  await page.getByRole('button', { name: 'יציאה' }).first().click()
  await expect(page.getByRole('heading', { name: 'ניהול נוכחות הבניין' })).toBeVisible()
  expect(await outboxOf(page)).toBeNull()
})
