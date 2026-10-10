// The service provider's journey on a phone: open a scan link, sign in, check in, and every way it can be refused.
import { test, expect, he, en, POINTS, PEOPLE, FAR, OFFLINE_NOISE, skipOfflineOnWebKit, signIn, clearScans, allowConsoleErrors } from './fixtures.js'

const scanLink = (code) => `/scan?code=${code}`

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
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()

  // The check-in's answer makes the app ask for today's visits again, a moment after the success screen is drawn: the next goto
  // waits for that request before it replaces the page (the `page` fixture, e2e/fixtures.js).
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

// ---- no fresh position ------------------------------------------------------------------------------------------------

/**
 * A phone that cannot get a position now: the browser answers "position unavailable" (code 2) to a single request and to a watch,
 * as in a basement. A point that requires the location watches the position for a few seconds before it gives up.
 */
const NO_POSITION_NOW = () => {
  navigator.geolocation.getCurrentPosition = (_done, fail) => fail({ code: 2 })
  navigator.geolocation.watchPosition = (_done, fail) => {
    fail({ code: 2 })
    return 1
  }
}
/** The server cannot be reached (it answers as if it were down), so a check-in is saved on the phone. */
const saveOnThePhone = (page) => page.route('**/api/scan', (route) => route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }))
const savedVisits = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('qr.queue.v1') ?? '[]'))

test.describe('with no position now', () => {
  // The server's answer is made up with page.route, which does not see a request that a service worker handles (WebKit does not
  // pass it on once the worker controls the page), so these tests run without the worker, as the other specs that stub the API do.
  test.use({ serviceWorkers: 'block' })

  test('with no fresh position, a check-in is saved with the position of the last one, and the screen does not warn', async ({ page }) => {
    allowConsoleErrors(page, /status of 503/) // the answer this test makes up
    await page.goto(scanLink(POINTS.gym)) // the gym requires the location
    await signIn(page, PEOPLE.ploni)
    await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()
    await page.getByRole('button', { name: he['checkin.done'] }).click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('qr.lastfix.v1'))).not.toBeNull() // the reading of that check-in

    await page.addInitScript(NO_POSITION_NOW)
    await saveOnThePhone(page)
    await page.goto(scanLink(POINTS.gym))
    await expect(page.getByRole('heading', { name: he['checkin.queued.title'] })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(he['checkin.queued.noLocation'])).toHaveCount(0)
    const [visit] = await savedVisits(page)
    expect(visit.gps, 'the visit carries where the phone was a moment ago').toMatchObject({ accuracy: expect.any(Number) })
    expect(visit.gps.age_s).toBeGreaterThanOrEqual(1)
    expect(visit.gps.age_s).toBeLessThan(120)
  })

  test('with no position at all, a check-in is saved and the screen warns that the server may refuse it', async ({ page }) => {
    allowConsoleErrors(page, /status of 503/)
    await page.addInitScript(NO_POSITION_NOW)
    await saveOnThePhone(page)
    await page.goto(scanLink(POINTS.gym))
    await signIn(page, PEOPLE.ploni)
    await expect(page.getByRole('heading', { name: he['checkin.queued.title'] })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(he['checkin.queued.body'])).toBeVisible()
    await expect(page.getByText(he['checkin.queued.noLocation'])).toBeVisible()
    const [visit] = await savedVisits(page)
    expect(visit.gps).toBeNull()
  })

  test('signing out deletes the position that the phone kept', async ({ page }) => {
    await page.goto(scanLink(POINTS.gym))
    await signIn(page, PEOPLE.ploni)
    await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()
    await page.getByRole('button', { name: he['checkin.done'] }).click()
    expect(await page.evaluate(() => localStorage.getItem('qr.lastfix.v1'))).not.toBeNull()

    await page.getByRole('button', { name: he['home.switchWorker'] }).click()
    await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('qr.lastfix.v1'))).toBeNull()
  })
})
