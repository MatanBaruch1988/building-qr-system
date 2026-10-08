// The service provider's journey on a phone: open a scan link, sign in, check in, and every way it can be refused.
import { test, expect, he, en, POINTS, PEOPLE, FAR, OFFLINE_NOISE, skipOfflineOnWebKit, signIn, clearScans, allowConsoleErrors } from './fixtures.js'

const scanLink = (code) => `/scan?code=${code}`
const isCheckIn = (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/scan'
const isVisitsList = (request) => request.method() === 'GET' && new URL(request.url()).pathname === '/api/my/scans'

test.beforeEach(async ({ request }) => {
  await clearScans(request)
})

test('a scan link opens the sign-in list, in Hebrew, naming the point', async ({ page }) => {
  await page.goto(scanLink(POINTS.lobby))
  await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
  await expect(page.getByText(/נקודת סריקה/)).toContainText('לובי')
  await expect(page.getByRole('list').getByRole('button')).toHaveCount(5) // the five sample providers
  await expect(page.locator('html')).toHaveAttribute('lang', 'he')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.getByText(he['login.privacy'])).toBeVisible()
})

test('a wrong password is refused with a clear message and a clear field', async ({ page }) => {
  allowConsoleErrors(page, /status of 401/) // the browser notes the 401 this test provokes
  await page.goto(scanLink(POINTS.lobby))
  await signIn(page, { name: PEOPLE.ploni.name, password: 'not-the-password' })
  await expect(page.getByRole('alert')).toContainText(he['login.wrong'])
  await expect(page.getByLabel(he['login.passwordLabel'], { exact: true })).toHaveValue('')
})

test('signing in checks in at the point, names who signed in, and lists the visit on the home screen', async ({ page }) => {
  await page.goto(scanLink(POINTS.lobby))
  await signIn(page, PEOPLE.ploni)

  await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()
  await expect(page.getByText(/משתמש:/)).toContainText(`${PEOPLE.ploni.name} · ניקיון`)

  await page.getByRole('button', { name: he['checkin.done'] }).click()
  await expect(page.getByRole('heading', { name: /שלום/ })).toContainText(PEOPLE.ploni.name)
  await expect(page.getByRole('list').getByText('לובי')).toBeVisible()
  await expect(page.getByRole('list').getByText(/^\d{2}:\d{2}$/)).toBeVisible() // the time of the visit: HH:MM
})

test('scanning the same point again says it was already recorded', async ({ page }) => {
  await page.goto(scanLink(POINTS.lobby))
  const checkedIn = page.waitForResponse(isCheckIn)
  await signIn(page, PEOPLE.ploni)
  await checkedIn
  // The answer of the check-in also makes the app ask for today's visits again, from an effect that can run after the success
  // screen is drawn. A request that starts while WebKit is replacing the page is refused, and WebKit logs it as "Fetch API
  // cannot load ... due to access control checks", so the next scan waits until that request has been made and answered.
  // The list that sign-in asked for went out before the check-in's answer, so the next request for it is the one to wait for.
  const listedAgain = page.waitForRequest(isVisitsList)
  await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()
  await (await (await listedAgain).response())?.finished()

  await page.goto(scanLink(POINTS.lobby)) // still signed in on this phone
  await expect(page.getByRole('heading', { name: he['checkin.duplicate.title'] })).toBeVisible()
})

test('a point that is not assigned to the person is refused with its own message, in the person\'s language', async ({ page }) => {
  allowConsoleErrors(page, /status of 403/) // the browser notes the 403 this test provokes
  await page.goto(scanLink(POINTS.gym)) // the gym is Ploni's only
  // John reads English: he picks it himself on his phone (the committee does not set a language for anyone)
  await page.getByLabel(he['lang.label']).selectOption('en')
  await signIn(page, PEOPLE.john, en)
  await expect(page.getByText(en['error.not_assigned'])).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('button', { name: en['checkin.retry'] })).toHaveCount(0) // trying again cannot help
})

test('a point that requires the location refuses a phone that is far away', async ({ page, context }) => {
  await context.setGeolocation(FAR)
  await page.goto(scanLink(POINTS.gym))
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: he['checkin.far.title'] })).toBeVisible()
  await expect(page.getByRole('button', { name: he['checkin.retry'] })).toBeVisible()
})

test('a code that is not ours is refused', async ({ page }) => {
  allowConsoleErrors(page, /status of 404/) // the browser notes the 404 this test provokes
  await page.goto(scanLink('BQR-doesnotexist000000000000'))
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByText(he['error.unknown_code'])).toBeVisible()
})

test('a check-in made with no network is kept on the phone and sent when the network returns', async ({ page, context, browserName }) => {
  skipOfflineOnWebKit(browserName)
  allowConsoleErrors(page, OFFLINE_NOISE) // every request that fails while the network is off is logged by the browser
  // first an ordinary check-in, so the person stays signed in and the point is known to the phone
  await page.goto(scanLink(POINTS.basement))
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()
  await page.getByRole('button', { name: he['checkin.done'] }).click()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload() // controlled by the service worker from here on, so the app can open offline

  await context.setOffline(true)
  await page.goto(scanLink(POINTS.basement))
  await expect(page.getByRole('heading', { name: he['checkin.queued.title'] })).toBeVisible()

  await context.setOffline(false)
  await page.getByRole('button', { name: he['checkin.done'] }).click()
  // sent by itself when the network returns (the "online" event, or the 30 second timer), with no "send now" click
  await expect(page.getByText(he['sync.done'])).toBeVisible({ timeout: 40_000 })
})
