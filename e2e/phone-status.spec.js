// The phone tells the committee how it is doing (ADR 0007, decision 4, "Phone health"): what waits in its offline queue, since when,
// and which build it runs. The provider app sends that to POST /api/my/device-status and the committee's API lists it per phone
// (GET /api/admin/providers/:id/devices). There is nothing on the provider's screen for it, so this reads it the way the committee
// screen of a later release will: from the API, as the committee.
//
// Both projects run it (the Pixel in Chromium and the iPhone in WebKit). The server's answers are made up with page.route and the
// network is never switched off, so the one thing that Playwright's WebKit cannot do (take a service-worker page offline, see
// skipOfflineOnWebKit in fixtures.js) does not come up.
import { test, expect, he, POINTS, PEOPLE, ADMIN_EMAIL, signIn, clearScans, allowConsoleErrors } from './fixtures.js'
import { SCAN_ERROR_POINT_INACTIVE } from '../shared/contract.js'

test.beforeEach(async ({ request }) => {
  await clearScans(request)
})

/** The phones of one provider, as the committee's API lists them. */
async function phonesOf(request, contactName) {
  const providers = await (await request.get('/api/admin/providers')).json()
  const provider = providers.providers.find((p) => p.contact_name === contactName)
  expect(provider, `the sample provider ${contactName}`).toBeTruthy()
  const answer = await request.get(`/api/admin/providers/${provider.id}/devices`)
  expect(answer.ok()).toBeTruthy()
  return (await answer.json()).devices
}

/** What the browser does when the app comes back to the foreground. */
const comeBackToTheApp = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

test('a visit that waits on the phone shows on the committee\'s list of phones, and clears when it is sent', async ({ page, request }) => {
  test.setTimeout(120_000) // a report that comes too soon after the last one is held back for 10 seconds, twice in this test
  // the browser notes the 503 answers that this test makes up (the check-in and the upload both fail)
  allowConsoleErrors(page, /status of 503/)
  const down = (route) => route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } })
  await page.route('**/api/scan', down)
  await page.route('**/api/scans/sync', down)

  const login = await request.post('/api/admin/dev-login', { data: { email: ADMIN_EMAIL } })
  expect(login.ok(), 'dev admin sign-in').toBeTruthy()

  // a check-in with the server down is kept on the phone
  await page.goto(`/scan?code=${POINTS.basement}`)
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: he['checkin.queued.title'] })).toBeVisible()
  const savedAt = await page.evaluate(() => JSON.parse(localStorage.getItem('qr.queue.v1'))[0].saved_at)

  // the app comes back to the foreground: the upload fails again, and the phone says what is waiting
  await comeBackToTheApp(page)
  const waiting = () => phonesOf(request, PEOPLE.ploni.name).then((phones) => phones.find((phone) => phone.waiting_count === 1))
  await expect.poll(waiting, { timeout: 45_000, intervals: [500, 1000, 2000] }).toBeTruthy()

  const phone = await waiting()
  expect(phone).toMatchObject({
    waiting_count: 1,
    oldest_waiting_at: savedAt, // the time the phone saved the visit, to the millisecond
    app_build: 'dev', // an end-to-end build has no commit
    not_accepted_total: 0,
    overflow_total: 0,
    last_sync_at: null, // the server never saw an upload from this phone: nothing is wrong with the clock, the upload did not reach it
    outdated: false,
  })
  expect(phone.status_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

  // the server is back: the upload goes through, and the next report says that nothing waits any more
  await page.unroute('**/api/scan')
  await page.unroute('**/api/scans/sync')
  await comeBackToTheApp(page)
  await expect.poll(async () => (await phonesOf(request, PEOPLE.ploni.name)).find((p) => p.id === phone.id), { timeout: 45_000, intervals: [500, 1000, 2000] })
    .toMatchObject({ waiting_count: 0, oldest_waiting_at: null })
  const cleared = (await phonesOf(request, PEOPLE.ploni.name)).find((p) => p.id === phone.id)
  expect(cleared.last_sync_at).toMatch(/^\d{4}-\d{2}-\d{2}T/) // the server stamped the end of the upload
})

test('a visit that the server refuses for good is dropped by the phone and counted, and the total reaches the committee\'s list', async ({ page, request }) => {
  test.setTimeout(120_000)
  allowConsoleErrors(page, /status of 503/) // the check-in is made to fail, so that the visit is kept on the phone
  await page.route('**/api/scan', (route) => route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }))
  // the upload is answered the way the server answers a visit for a point that was switched off since: refused for good
  await page.route('**/api/scans/sync', async (route) => {
    const { scans } = route.request().postDataJSON()
    await route.fulfill({
      json: { results: scans.map(({ id }) => ({ id, ok: false, error: { code: SCAN_ERROR_POINT_INACTIVE, message: 'Point is switched off' } })) },
    })
  })
  const login = await request.post('/api/admin/dev-login', { data: { email: ADMIN_EMAIL } })
  expect(login.ok(), 'dev admin sign-in').toBeTruthy()

  await page.goto(`/scan?code=${POINTS.basement}`)
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: he['checkin.queued.title'] })).toBeVisible()

  await comeBackToTheApp(page) // the upload runs, the visit is refused for good and dropped
  const counted = () => phonesOf(request, PEOPLE.ploni.name).then((phones) => phones.find((phone) => phone.not_accepted_total === 1))
  await expect.poll(counted, { timeout: 45_000, intervals: [500, 1000, 2000] }).toBeTruthy()
  expect(await counted()).toMatchObject({ waiting_count: 0, oldest_waiting_at: null, not_accepted_total: 1, overflow_total: 0 })
  expect(await page.evaluate(() => localStorage.getItem('qr.queue.v1'))).toBe('[]') // dropped from the phone, for good
})
