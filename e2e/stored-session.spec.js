// The session that the provider app keeps on the phone, when it is not one that the screens can draw from.
//
// The home screen reads the provider's details on every start. A stored session without them used to break it every time:
// the message that replaces a broken screen appeared, "Try again" and "Reload the app" read the same stored value again, and
// the only way out was to clear the site's data. Now such a session is removed when it is read (the sign-in list appears), and
// a session check that answers without details does not replace the ones that the screens use.
//
// Both are set up the way they happen on a phone: a value in the phone's storage, and one answer of the server routed by the
// test. The unit and component tests (tests/components/session.test.js, tests/components/stored-session.test.jsx) cover every shape.
import { test, expect, he, PEOPLE, signIn, allowConsoleErrors, pageSettled } from './fixtures.js'
import { PROVIDER_TOKEN_PREFIX } from '../shared/contract.js'

// The service worker is not what is tested here, and a page that it controls can send a request round the test's route.
test.use({ serviceWorkers: 'block' })

const STORAGE_KEY = 'qr.session'
const HOME = /^שלום,/ // the greeting of the home screen: the sign-in screen's heading has no comma
const SESSION_CHECK = '**/api/session'
const TOKEN = `${PROVIDER_TOKEN_PREFIX}${'a'.repeat(43)}` // shaped like a minted token; the server has never heard of it

const storedSession = (page) => page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)

for (const [what, session] of [
  ['no provider details', { token: TOKEN }],
  ['provider details that are null', { token: TOKEN, provider: null }],
]) {
  test(`a stored session with ${what} shows the sign-in list, not the broken-screen message, and is gone for the next start`, async ({ page }) => {
    await page.goto('/')
    await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [STORAGE_KEY, JSON.stringify(session)])

    for (const start of ['the first start', 'the next start']) {
      await page.reload()
      await expect(page.getByRole('heading', { name: he['login.title'] }), start).toBeVisible()
      await pageSettled(page) // the answers of this start have arrived and been drawn, so a screen that they break would show by now
      await expect(page.getByRole('heading', { name: he['crash.title'] }), start).toHaveCount(0)
      expect(await storedSession(page), start).toBeNull()
    }

    // Signing in again works, and now the session is one that the app can read back.
    await signIn(page, PEOPLE.ploni)
    await expect(page.getByRole('heading', { name: HOME })).toContainText(PEOPLE.ploni.name)
    await page.reload()
    await expect(page.getByRole('heading', { name: HOME })).toContainText(PEOPLE.ploni.name)
    expect(JSON.parse(await storedSession(page))).toMatchObject({ provider: { company: expect.any(String) } })
  })
}

test('a session check that answers without provider details keeps the person signed in, on the details they already have', async ({ page }) => {
  await page.goto('/')
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: HOME })).toContainText(PEOPLE.ploni.name)
  const before = await storedSession(page)

  let answers = 0
  await page.route(SESSION_CHECK, (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    answers += 1
    return route.fulfill({ json: { provider: null } })
  })
  const checked = page.waitForResponse((response) => response.url().endsWith('/api/session') && response.request().method() === 'GET')
  await page.reload()
  await checked
  // Let the app act on the answer: two frames, which is when a render that failed on it would have shown.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  expect(answers).toBe(1)
  await expect(page.getByRole('heading', { name: he['crash.title'] })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: HOME })).toContainText(PEOPLE.ploni.name)
  expect(await storedSession(page)).toBe(before) // still signed in, nothing rewritten
})

test('a session that the server has revoked still signs the person out to the sign-in list', async ({ page }) => {
  allowConsoleErrors(page, /status of 401/) // the browser notes the 401 that this test provokes
  await page.goto('/')
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: HOME })).toContainText(PEOPLE.ploni.name)

  await page.route(SESSION_CHECK, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 401, json: { error: { code: 'invalid_session', message: 'Session expired' } } })
      : route.continue())
  await page.reload()
  await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
  await expect(page.getByText(he['error.invalid_session'])).toBeVisible()
  expect(await storedSession(page)).toBeNull()
})
