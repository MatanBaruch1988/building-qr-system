// Accessibility of both apps, checked screen by screen with axe-core (the WCAG 2.1 A and AA rules).
//
// The code takes care of accessibility one piece at a time (roles, live regions, focus traps, accessible names for the
// icon buttons, contrast tests on the colour tokens), and nothing else renders the screens and checks them as a whole,
// so a missing label, a colour written outside the tokens or a broken ARIA attribute would go unnoticed. This spec opens
// the screens of the provider app (in Hebrew and in English) and of the committee app, in the light and in the dark
// theme, and fails with a list of what axe finds. Known problems that are a design decision are in a11y-baseline.js.
//
// To keep it fast, one page load covers several screens: a screen is scanned where it is reached, in the light theme and
// then in the dark one (the device's setting is emulated, which is what the app follows until a person chooses). Every
// scan is of the settled screen: expectNoA11yViolations switches the animations off first.
import { randomUUID } from 'node:crypto'
import ar from '../src/i18n/ar.js'
import { PROVIDER_TOKEN_PREFIX } from '../shared/contract.js'
import {
  test, expect, he, en, ru, POINTS, PEOPLE, FAR, ADMIN_EMAIL, adminSignIn, clearScans, allowConsoleErrors, expectNoA11yViolations,
} from './fixtures.js'

// No service worker: this spec answers some requests itself (page.route), and a page that a service worker controls
// would not give those requests to it.
test.use({ serviceWorkers: 'block' })

const COMPUTER = { width: 1280, height: 800 }
const scanLink = (code) => `/scan?code=${code}`
const UNKNOWN_CODE = 'BQR-doesnotexist000000000000' // the shape of a code of ours, that no point has

/**
 * Where axe must not look. Only what is not ours, each one with its reason:
 * - the box that Google's sign-in button is drawn into: the button is an iframe from accounts.google.com, so its markup
 *   and its colours are Google's. (The tests blank GOOGLE_CLIENT_ID, so the box is empty here and this is for the day it
 *   is not; the text around the box is ours and is scanned.)
 */
const GOOGLE_BUTTON = '.a-login__google > div:first-child'

/** Scans the screen as it is now in the light theme, and again in the dark one. Leaves the device light. */
async function scanBothThemes(page, screen, options = {}) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    await expectNoA11yViolations(page, { context: `${screen} [${scheme}]`, ...options })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

// ---- the provider app -----------------------------------------------------------------------------------------------

test.describe('provider app', () => {
  test('in Hebrew: the sign-in list, the password form, every kind of check-in result, and the home screen', async ({ page, context, request }) => {
    await clearScans(request) // a visit that is still on record would answer "already recorded" instead of recording
    allowConsoleErrors(page, /status of 401/, /status of 404/) // the wrong password and the unknown code that this test provokes
    const people = page.getByRole('list').getByRole('button')
    const password = page.getByLabel(he['login.passwordLabel'], { exact: true })

    await page.goto(scanLink(UNKNOWN_CODE)) // no banner: nobody knows the point, and the list is the same as at "/"
    await expect(people).toHaveCount(5) // the five sample providers
    await scanBothThemes(page, 'provider he: sign-in list')

    await page.goto(scanLink(POINTS.lobby))
    await expect(page.getByText(/נקודת סריקה/)).toContainText('לובי')
    await scanBothThemes(page, 'provider he: sign-in list with the scan point')

    await page.getByRole('button', { name: new RegExp(PEOPLE.ploni.name) }).click()
    await expect(password).toBeVisible()
    await scanBothThemes(page, 'provider he: password form')

    await password.fill('not-the-password')
    await page.getByRole('button', { name: he['login.submit'], exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(he['login.wrong'])
    await scanBothThemes(page, 'provider he: password form with an error')

    await password.fill(PEOPLE.ploni.password)
    await page.getByRole('button', { name: he['login.submit'], exact: true }).click()
    await expect(page.getByRole('heading', { name: he['checkin.success.title'] })).toBeVisible()
    await scanBothThemes(page, 'provider he: check-in recorded')

    await page.getByRole('button', { name: he['checkin.done'] }).click()
    await expect(page.getByRole('heading', { name: /שלום/ })).toContainText(PEOPLE.ploni.name)
    await expect(page.getByRole('list').getByText('לובי')).toBeVisible()
    await scanBothThemes(page, 'provider he: home with a visit')

    await page.goto(scanLink(POINTS.lobby)) // still signed in on this phone
    await expect(page.getByRole('heading', { name: he['checkin.duplicate.title'] })).toBeVisible()
    await scanBothThemes(page, 'provider he: check-in already recorded')

    await context.setGeolocation(FAR)
    await page.goto(scanLink(POINTS.gym)) // the gym requires the location
    await expect(page.getByRole('heading', { name: he['checkin.far.title'] })).toBeVisible()
    await scanBothThemes(page, 'provider he: refused, too far')

    // a phone that refuses to say where it is (the browser answers "denied" at once)
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_done, fail) => fail({ code: 1 })
    })
    await page.goto(scanLink(POINTS.gym))
    await expect(page.getByRole('heading', { name: he['checkin.needLocation.title'] })).toBeVisible()
    await scanBothThemes(page, 'provider he: refused, needs the location')

    await page.goto(scanLink(UNKNOWN_CODE))
    await expect(page.getByText(he['error.unknown_code'])).toBeVisible()
    await scanBothThemes(page, 'provider he: refused, unknown code')
  })

  test('in English (left to right): the same journey, and a point that is not the person\'s', async ({ page, request }) => {
    await clearScans(request)
    allowConsoleErrors(page, /status of 401/, /status of 403/) // the wrong password and the point that is not John's
    const password = page.getByLabel(en['login.passwordLabel'], { exact: true })

    await page.goto(scanLink(POINTS.lobby))
    await page.getByLabel(he['lang.label']).selectOption('en') // John picks it himself on his phone
    await expect(page.getByRole('heading', { name: en['login.title'] })).toBeVisible()
    await expect(page.getByText(/Scan point/)).toContainText('לובי')
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    await scanBothThemes(page, 'provider en: sign-in list with the scan point')

    await page.getByRole('button', { name: new RegExp(PEOPLE.john.name) }).click()
    await expect(password).toBeVisible()
    await scanBothThemes(page, 'provider en: password form')

    await password.fill('not-the-password')
    await page.getByRole('button', { name: en['login.submit'], exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(en['login.wrong'])
    await scanBothThemes(page, 'provider en: password form with an error')

    await password.fill(PEOPLE.john.password)
    await page.getByRole('button', { name: en['login.submit'], exact: true }).click()
    await expect(page.getByRole('heading', { name: en['checkin.success.title'] })).toBeVisible()
    await scanBothThemes(page, 'provider en: check-in recorded')

    await page.getByRole('button', { name: en['checkin.done'] }).click()
    await expect(page.getByRole('heading', { name: /Hello/ })).toContainText(PEOPLE.john.name)
    await expect(page.getByRole('list').getByText('לובי')).toBeVisible()
    await scanBothThemes(page, 'provider en: home with a visit')

    await page.goto(scanLink(POINTS.gym)) // the gym is Ploni's only
    await expect(page.getByText(en['error.not_assigned'])).toBeVisible()
    await scanBothThemes(page, 'provider en: refused, not assigned')
  })

  test('the language picker and the theme picker', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('list').getByRole('button')).toHaveCount(5)
    // A native <select>: the list of choices is the phone's own and is not in the page, so what the page can show is the
    // picker focused, and the screen after a choice. (The labels of both pickers follow the language.)
    await page.getByLabel(he['lang.label']).focus()
    await scanBothThemes(page, 'provider he: language picker focused')
    await page.getByLabel(he['theme.label']).focus()
    await scanBothThemes(page, 'provider he: theme picker focused')

    await page.getByLabel(he['lang.label']).selectOption('ar')
    await expect(page.getByRole('heading', { name: 'اختر اسمك' })).toBeVisible()
    await scanBothThemes(page, 'provider ar: sign-in list')
    await page.getByLabel(ar['lang.label']).selectOption('ru')
    await expect(page.getByRole('heading', { name: ru['login.title'] })).toBeVisible()
    await scanBothThemes(page, 'provider ru: sign-in list')

    // a theme that the person chose is kept whatever the device says: the picker, not the device, sets it here
    const choose = async (choice) => {
      await page.getByLabel(ru['theme.label']).selectOption(choice)
      await expect(page.locator('html')).toHaveAttribute('data-theme', choice)
    }
    await choose('dark')
    await expectNoA11yViolations(page, { context: 'provider ru: theme chosen in the picker [dark]' })
    await choose('light')
    await expectNoA11yViolations(page, { context: 'provider ru: theme chosen in the picker [light]' })
  })

  test('the states that a slow, failing or empty server brings, and a phone with visits saved on it', async ({ page }) => {
    allowConsoleErrors(page, /status of 500/, /status of 503/, /status of 401/) // the answers that this test makes up
    const provider = { id: '00000000-0000-4000-8000-000000000001', contact_name: PEOPLE.ploni.name, company: 'ניקיון' }
    const saved = () => ({
      id: randomUUID(), code: POINTS.lobby, client_time: new Date().toISOString(), gps: null,
      provider_id: provider.id, saved_at: new Date().toISOString(), point_name: 'לובי',
    })
    const answerEveryone = (results) => async (route) => {
      const { scans } = route.request().postDataJSON()
      await route.fulfill({ json: { results: scans.map(({ id }) => ({ id, ok: true, scan: { outcome: results } })) } })
    }

    // the sign-in list while it loads, when it cannot load, and with nobody on it
    let held
    let providersAnswer = (route) => { held = route }
    await page.route('**/api/public/providers', (route) => providersAnswer(route))
    await page.goto('/')
    await expect(page.getByRole('status', { name: he['common.loading'] })).toBeVisible()
    await scanBothThemes(page, 'provider he: sign-in list while it loads')
    await held.fulfill({ status: 500, json: { error: { code: 'server_error' } } })
    await expect(page.getByRole('alert')).toContainText(he['login.loadError'])
    await scanBothThemes(page, 'provider he: sign-in list that could not load')
    providersAnswer = (route) => route.fulfill({ json: { providers: [] } })
    await page.getByRole('button', { name: he['common.retry'] }).click()
    await expect(page.getByText(he['login.noProviders'])).toBeVisible()
    await scanBothThemes(page, 'provider he: sign-in list with nobody on it')

    // A phone that is signed in and has a visit saved on it, and a server that is down: a check-in is saved on the phone
    // too. (The sign-in and the answers are made up here, so that no password and no real visit is needed.)
    providersAnswer = (route) => route.continue()
    let syncAnswer = (route) => route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } })
    let sessionAnswer = (route) => route.fulfill({ json: { provider } })
    await page.route('**/api/scans/sync', (route) => syncAnswer(route))
    await page.route('**/api/scan', (route) => route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }))
    await page.route('**/api/my/scans', (route) => route.fulfill({ json: { scans: [] } }))
    await page.route('**/api/session', (route) => (route.request().method() === 'GET' ? sessionAnswer(route) : route.continue()))
    // The token has the shape of a device token (the app keeps only a session whose token could be ours), but no server
    // issued it.
    await page.evaluate(([session, visit]) => {
      localStorage.setItem('qr.session', JSON.stringify(session))
      localStorage.setItem('qr.queue.v1', JSON.stringify([visit]))
    }, [{ token: `${PROVIDER_TOKEN_PREFIX}a-token-that-no-server-knows`, provider }, saved()])
    await page.goto(scanLink(POINTS.lobby))
    await expect(page.getByRole('heading', { name: he['checkin.queued.title'] })).toBeVisible()
    await scanBothThemes(page, 'provider he: check-in saved on the phone')

    await page.getByRole('button', { name: he['checkin.done'] }).click()
    await expect(page.getByRole('button', { name: he['home.syncNow'] })).toBeVisible() // two visits are waiting
    await scanBothThemes(page, 'provider he: home with visits waiting to be sent')

    // the network is back and the server counts the visits
    syncAnswer = answerEveryone('accepted')
    await page.getByRole('button', { name: he['home.syncNow'] }).click()
    await expect(page.getByText(he['sync.done'])).toBeVisible()
    await scanBothThemes(page, 'provider he: home, the saved visits were sent')

    // a visit that the server does not count (the person had left the point): a warning that stays until it is dismissed
    syncAnswer = answerEveryone('rejected_far')
    await page.evaluate(([visit]) => {
      localStorage.setItem('qr.queue.v1', JSON.stringify([visit]))
      window.dispatchEvent(new Event('online')) // what the browser says when the network returns: the app sends at once
    }, [saved()])
    await expect(page.getByText(/נוכחויות שלא נקלטו/)).toBeVisible()
    await scanBothThemes(page, 'provider he: home, a saved visit was not counted')

    // a stored sign-in that the server no longer knows: back to the list, with a notice
    sessionAnswer = (route) => route.fulfill({ status: 401, json: { error: { code: 'invalid_session' } } })
    await page.goto('/')
    await expect(page.getByText(he['error.invalid_session'])).toBeVisible()
    await scanBothThemes(page, 'provider he: sign-in list with the notice that the sign-in expired')
  })
})

// ---- the committee app -----------------------------------------------------------------------------------------------

/** The map's pictures come from the internet (OpenStreetMap and cdnjs): answer them here, as map-qr.spec.js does. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
async function stubMapImages(page) {
  const answer = (route) => route.fulfill({ contentType: 'image/png', body: PIXEL })
  await page.route('https://*.tile.openstreetmap.org/**', answer)
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/**', answer)
}

const NEW_PROVIDER = 'בדיקת נגישות' // the company that the provider form of the dialogs is filled with
const NEW_KEY = 'מפתח נגישות' // the start of the name that the agent key of the dialogs is given

const loaded = async (page, title) => {
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'טוען' })).toHaveCount(0)
}
/**
 * Waits until the committee app is ready to change tabs. The heading is on the screen a moment before the shell listens for
 * a change of the address (an effect runs after the first paint), and a tab that is opened by address in that moment
 * stays on the first one. The title is set by the effect that follows the listener, so it says the listener is there.
 */
const signedIn = async (page) => {
  await expect(page.getByRole('heading', { name: 'נקודות סריקה', level: 1 })).toBeVisible()
  await expect(page).toHaveTitle(/ · נוכחות בבניין$/)
}
const openTab = async (page, tab, title) => {
  await page.goto(`/admin#${tab}`)
  await loaded(page, title)
}

/**
 * Fills the sample schema the way a committee that has used the app for a while would have it: visits that were accepted,
 * refused and cancelled, a provider that is switched off, an agent key that was cancelled, a member whose access was
 * removed. It talks to the API directly, and everything is made at once to save time. Returns what the specs need to
 * find, and `clean`, which removes it all again (the specs that run after this one expect the sample data).
 */
async function fillCommittee(playwright, baseURL) {
  const admin = await playwright.request.newContext({ baseURL })
  const phone = await playwright.request.newContext({ baseURL })
  const login = await admin.post('/api/admin/dev-login', { data: { email: ADMIN_EMAIL } })
  expect(login.ok(), 'dev admin sign-in').toBeTruthy()
  const tag = randomUUID().slice(0, 6)
  const send = async (client, url, data = {}, token) => {
    const response = await client.post(url, { data, headers: token ? { authorization: `Bearer ${token}` } : {} })
    expect(response.ok(), `POST ${url}`).toBeTruthy()
    return response.json()
  }
  const post = (url, data) => send(admin, url, data)
  const change = async (url, data) => expect((await admin.patch(url, { data })).ok(), `PATCH ${url}`).toBeTruthy()

  // Ploni and the demo account each sign in on a phone (Ploni's card then shows a connected device) and make visits:
  // one accepted, one refused as too far, one without a position (recorded with a flag) that is then cancelled, and
  // the demo account's.
  const visits = async () => {
    const providers = (await (await phone.get('/api/public/providers')).json()).providers
    const signIn = async (name, password) => {
      const found = providers.find((p) => p.contact_name === name)
      const { token } = await send(phone, '/api/session', { provider_id: found.id, password })
      return (code, gps) => send(phone, '/api/scan', { id: randomUUID(), code, gps }, token)
    }
    const [ploni, demo] = await Promise.all([signIn(PEOPLE.ploni.name, PEOPLE.ploni.password), signIn('לקוח דמה', 'dev-pass-5')])
    const [, , cancelled] = await Promise.all([
      ploni(POINTS.basement, null),
      ploni(POINTS.gym, { lat: FAR.latitude, lng: FAR.longitude, accuracy: FAR.accuracy }),
      ploni(POINTS.lobby, null),
      demo(POINTS.lobby, null),
    ])
    await post(`/api/admin/scans/${cancelled.scan.id}/void`, { reason: 'נסרק בטעות' })
  }

  const [live, dead, member, removed, off] = await Promise.all([
    post('/api/admin/api-keys', { name: `פעיל ${tag}` }).then((r) => r.api_key),
    post('/api/admin/api-keys', { name: `בוטל ${tag}` }).then(async (r) => (await post(`/api/admin/api-keys/${r.api_key.id}/revoke`), r.api_key)),
    post('/api/admin/admins', { email: `a11y-${tag}@example.test`, name: `חבר ${tag}` }).then((r) => r.admin),
    post('/api/admin/admins', { email: `a11y-off-${tag}@example.test`, name: `הוסר ${tag}` }).then(async (r) => (await change(`/api/admin/admins/${r.admin.id}`, { is_active: false }), r.admin)),
    post('/api/admin/providers', { company: `חברה ${tag}`, contact_name: `מושבת ${tag}`, password: `pw-${tag}-1234` }).then(async (r) => (await change(`/api/admin/providers/${r.provider.id}`, { is_active: false }), r.provider)),
    visits(),
  ])

  const clean = async () => {
    await clearScans(admin)
    const providers = (await (await admin.get('/api/admin/providers')).json()).providers
    const ploniId = providers.find((p) => p.contact_name === PEOPLE.ploni.name).id
    // the provider and the key that the dialogs made are found by what they were given
    const keys = (await (await admin.get('/api/admin/api-keys')).json()).api_keys
    await Promise.all([
      admin.post(`/api/admin/providers/${ploniId}/revoke-devices`, { data: {} }),
      ...[live, dead, ...keys.filter((k) => k.name.startsWith(NEW_KEY))].map((key) => admin.delete(`/api/admin/api-keys/${key.id}`, { data: {} })),
      ...[member, removed].map(({ id }) => admin.delete(`/api/admin/admins/${id}`, { data: {} })),
      ...providers.filter((p) => p.id === off.id || p.company === NEW_PROVIDER).map(({ id }) => admin.delete(`/api/admin/providers/${id}`, { data: {} })),
    ])
    await Promise.all([admin.dispose(), phone.dispose()])
  }
  return { member, clean }
}

test.describe('committee app', () => {
  test.beforeEach(async ({ page, request }) => {
    // The sign-in screen asks /api/admin/me before anyone is signed in: the browser notes that 401 as a console error.
    allowConsoleErrors(page, /status of 401/)
    await clearScans(request)
  })

  test('the sign-in screen, and the history when there are no visits', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'ניהול נוכחות הבניין' })).toBeVisible()
    await scanBothThemes(page, 'committee: sign-in', { exclude: [GOOGLE_BUTTON] })

    await page.getByRole('button', { name: 'כניסת פיתוח' }).click()
    await signedIn(page)
    await openTab(page, 'history', 'היסטוריית נוכחות')
    await expect(page.getByText('אין נוכחויות בטווח הזה')).toBeVisible()
    await scanBothThemes(page, 'committee phone: history, empty')
  })
})

test.describe('committee app with the sample data filled in', () => {
  let committee
  test.beforeAll(async ({ playwright }, testInfo) => {
    committee = await fillCommittee(playwright, testInfo.project.use.baseURL)
  })
  test.afterAll(async () => {
    await committee?.clean()
  })

  const dialogs = (page) => ({
    dialog: (name) => page.getByRole('dialog', { name }),
    closeWithEscape: async (name) => {
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name })).toHaveCount(0)
    },
  })

  test('the five tabs, on a phone and on a computer', async ({ page }) => {
    allowConsoleErrors(page, /status of 401/) // the first load of /admin, before the sign-in
    await adminSignIn(page)
    await signedIn(page)
    // (every screen is named by a plain string, so that tests/a11y-report.test.js can read the names from this file)
    await openTab(page, 'points', 'נקודות סריקה')
    await scanBothThemes(page, 'committee phone: points')
    await openTab(page, 'providers', 'נותני שירות')
    await scanBothThemes(page, 'committee phone: providers')
    await openTab(page, 'history', 'היסטוריית נוכחות')
    await scanBothThemes(page, 'committee phone: history')
    await openTab(page, 'agent', "גישה לאייג'נט")
    await scanBothThemes(page, 'committee phone: agent')
    await openTab(page, 'committee', 'חברי הוועד')
    await scanBothThemes(page, 'committee phone: committee')
    // the history with every kind of row: refused, cancelled, flagged, and the demo account's
    await openTab(page, 'history', 'היסטוריית נוכחות')
    await page.getByLabel('סוג').selectOption('all')
    await page.getByLabel('כולל מבוטלות').check()
    await page.getByLabel('כולל חשבון דמו').check()
    await expect(page.getByText('נדחתה: רחוק מהנקודה')).toBeVisible()
    await expect(page.getByText(/מבוטלת: נסרק בטעות/)).toBeVisible()
    await scanBothThemes(page, 'committee phone: history, every kind of row')
    // a date field that holds a date that does not exist (31 February): flagged with aria-invalid, in red
    const until = page.getByLabel('עד תאריך')
    await until.fill('')
    await until.pressSequentially('31022026')
    await expect(until).toHaveAttribute('aria-invalid', 'true')
    await scanBothThemes(page, 'committee phone: history, a date that does not exist')

    // The side rail replaces the top bar and the tab bar. The five screens are the same markup at any width, so two of
    // them are enough to see the rail and the wider layout.
    await page.setViewportSize(COMPUTER)
    await openTab(page, 'points', 'נקודות סריקה')
    await scanBothThemes(page, 'committee computer: points')
    await openTab(page, 'history', 'היסטוריית נוכחות')
    await scanBothThemes(page, 'committee computer: history')
  })

  test('the dialogs of the points and the providers', async ({ page }) => {
    allowConsoleErrors(page, /status of 401/) // the first load of /admin, before the sign-in
    await stubMapImages(page)
    await page.addInitScript(() => {
      window.__prints = 0
      window.print = () => { window.__prints += 1 }
    })
    await adminSignIn(page)
    await signedIn(page)
    const { dialog, closeWithEscape } = dialogs(page)

    // the form with the map, with an error, the QR dialog, and the questions
    const lobby = page.getByRole('article').filter({ hasText: 'לובי' })
    await lobby.getByRole('button', { name: 'עריכה' }).click()
    const form = dialog('עריכת נקודה: לובי')
    await expect(form.locator('img.leaflet-tile-loaded').first()).toBeAttached() // the map has drawn
    await scanBothThemes(page, 'committee phone: point form with the map')
    await form.getByLabel('שם הנקודה').fill('')
    await form.getByRole('button', { name: 'שמירה' }).click()
    await expect(form.getByText('צריך שם לנקודה.')).toBeVisible()
    await scanBothThemes(page, 'committee phone: point form with an error')
    await closeWithEscape('עריכת נקודה: לובי')

    await lobby.getByRole('button', { name: 'QR והדפסה' }).click()
    const qr = dialog('QR: לובי')
    await expect.poll(() => qr.getByRole('img', { name: 'קוד QR של הנקודה לובי' }).evaluate((img) => img.naturalWidth)).toBeGreaterThan(0)
    await scanBothThemes(page, 'committee phone: QR dialog')
    await qr.getByRole('button', { name: 'החלפת קוד ה-QR' }).click()
    await expect(dialog('להחליף את קוד ה-QR?')).toBeVisible() // a question on top of the QR dialog
    await scanBothThemes(page, 'committee phone: confirm on top of another dialog')
    await closeWithEscape('להחליף את קוד ה-QR?')

    // The sign is on the page only for the printer (hidden on a screen), so the page is scanned the way the printer sees it.
    // The browser's own print dialog is outside the page: count the call instead.
    await qr.getByRole('button', { name: 'הדפסת שלט' }).click()
    await expect.poll(() => page.evaluate(() => window.__prints)).toBe(1) // the sheet is built and shown
    await page.emulateMedia({ media: 'print' })
    // PrintSheet marks the whole sheet aria-hidden="true", which is right on a screen (a screen reader must not read a
    // second copy of the sign), but it also takes the sign out of what axe looks at: with the print styles only the sheet
    // is left, so axe would scan an empty page and pass whatever the sign looks like. So for this scan only, the attribute
    // is taken off, and the sign must then really be in the accessibility tree before axe is asked.
    await page.evaluate(() => document.querySelector('.a-print-only').removeAttribute('aria-hidden'))
    await expect(page.getByRole('heading', { name: 'לובי' })).toBeVisible()
    await expectNoA11yViolations(page, { context: 'committee: the printed sign [print]' })
    await page.emulateMedia({ media: null })
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint'))) // what the browser says when printing is over: the sheet goes

    await lobby.getByRole('button', { name: 'מחיקת הנקודה' }).click()
    await expect(dialog('למחוק את "לובי"?')).toBeVisible()
    await scanBothThemes(page, 'committee phone: confirm, delete a point')
    await closeWithEscape('למחוק את "לובי"?')

    // providers: the form with an error, the password that is shown once (with the message on the screen), a new password
    await openTab(page, 'providers', 'נותני שירות')
    await page.getByRole('button', { name: 'נותן שירות חדש' }).click()
    const provider = dialog('נותן שירות חדש')
    await expect(provider).toBeVisible()
    await scanBothThemes(page, 'committee phone: provider form')
    await provider.getByRole('button', { name: 'שמירה' }).click()
    await expect(provider.getByText('צריך שם חברה או שם.')).toBeVisible()
    await scanBothThemes(page, 'committee phone: provider form with an error')
    await provider.getByLabel('חברה').fill(NEW_PROVIDER)
    await provider.getByRole('button', { name: 'שמירה' }).click()
    await expect(dialog('הסיסמה נשמרה')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'נותן השירות נוסף' })).toBeVisible()
    await scanBothThemes(page, 'committee phone: password shown once, with a message on the screen')
    await closeWithEscape('הסיסמה נשמרה')

    await page.getByRole('article').filter({ hasText: PEOPLE.ploni.name }).getByRole('button', { name: 'סיסמה חדשה' }).click()
    await expect(dialog(`סיסמה חדשה: ${PEOPLE.ploni.name}`)).toBeVisible()
    await scanBothThemes(page, 'committee phone: new password dialog')
    await closeWithEscape(`סיסמה חדשה: ${PEOPLE.ploni.name}`)
  })

  test('the dialogs of the history, the agent keys and the committee', async ({ page }) => {
    allowConsoleErrors(page, /status of 401/) // the first load of /admin, before the sign-in
    await adminSignIn(page)
    await signedIn(page)
    const { dialog, closeWithEscape } = dialogs(page)

    // history: cancelling a visit, deleting one
    await openTab(page, 'history', 'היסטוריית נוכחות')
    const row = page.getByRole('listitem').filter({ hasText: 'מינוס 1' }).first()
    await row.getByRole('button', { name: 'ביטול הנוכחות' }).click()
    await expect(dialog('ביטול נוכחות')).toBeVisible()
    await scanBothThemes(page, 'committee phone: cancel a visit')
    await closeWithEscape('ביטול נוכחות')
    await row.getByRole('button', { name: 'מחיקת הנוכחות לצמיתות' }).click()
    await expect(dialog('למחוק את הנוכחות לצמיתות?')).toBeVisible()
    await scanBothThemes(page, 'committee phone: confirm, delete a visit')
    await closeWithEscape('למחוק את הנוכחות לצמיתות?')

    // agent keys: the form with an error, and the key that is shown once
    await openTab(page, 'agent', 'גישה לאייג\'נט')
    await page.getByRole('button', { name: 'מפתח חדש' }).click()
    const form = dialog('מפתח גישה חדש')
    await expect(form).toBeVisible()
    await scanBothThemes(page, 'committee phone: new agent key')
    await form.getByRole('button', { name: 'יצירה' }).click()
    await expect(form.getByText(/תנו למפתח שם/)).toBeVisible()
    await scanBothThemes(page, 'committee phone: new agent key with an error')
    await form.getByLabel('שם המפתח').fill(`${NEW_KEY} ${randomUUID().slice(0, 6)}`)
    await form.getByRole('button', { name: 'יצירה' }).click()
    await expect(dialog('המפתח נוצר')).toBeVisible()
    await scanBothThemes(page, 'committee phone: agent key shown once')
    await closeWithEscape('המפתח נוצר')

    // committee: adding a member, and taking an access away
    await openTab(page, 'committee', 'חברי הוועד')
    await page.getByRole('button', { name: 'חבר ועד חדש' }).click()
    const add = dialog('חבר ועד חדש')
    await expect(add).toBeVisible()
    await scanBothThemes(page, 'committee phone: new member')
    await add.getByLabel('כתובת Gmail').fill('not-an-address')
    await add.getByRole('button', { name: 'הוספה' }).click()
    await expect(add.getByText('כתובת מייל לא תקינה.')).toBeVisible()
    await scanBothThemes(page, 'committee phone: new member with an error')
    await closeWithEscape('חבר ועד חדש')
    await page.getByRole('article').filter({ hasText: committee.member.name }).getByRole('button', { name: 'הסרת גישה' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await scanBothThemes(page, 'committee phone: confirm, remove an access')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
