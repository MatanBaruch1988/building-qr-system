// A screen that breaks while it renders is replaced by a message and a way back, not by a blank page (src/ui/ErrorBoundary.jsx).
//
// The break is real and it happens in the production build: the server answers with a shape that a screen cannot draw (a
// session check with no provider in it, a committee member whose name is an object), which the test sets up by routing that
// one answer. Nothing exists in the app for the sake of this test.
import { test, expect, he, en, PEOPLE, adminSignIn, signIn, allowConsoleErrors } from './fixtures.js'

// The service worker is not what is tested here, and a page that it controls can send a request round the test's route.
test.use({ serviceWorkers: 'block' })

const COMPUTER = { width: 1280, height: 800 }
// The greeting of the home screen. The sign-in screen's heading ("Hi {name}") has no comma: it must not match.
const HOME_HE = /^שלום,/
const HOME_EN = /^Hello,/
const SESSION_CHECK = '**/api/session'
const ADMIN_ME = '**/api/admin/me'

/** The lines that the app logs for a crash. The page's console guard fails the test on anything else. */
function watchCrashLines(page) {
  allowConsoleErrors(page, /^Screen crash \(/)
  const lines = []
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith('Screen crash (')) lines.push(message.text())
  })
  return lines
}

/** The session check of the provider app answers with no provider: the home screen cannot draw its greeting. */
const breakSessionCheck = (page) =>
  page.route(SESSION_CHECK, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { provider: null } }) : route.continue())

const fitsTheWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

async function expectTouchTargets(...buttons) {
  for (const button of buttons) expect((await button.boundingBox()).height, 'a touch target of at least 44px').toBeGreaterThanOrEqual(44)
}

test('a broken screen of the provider app shows a message and two ways back, and each one works', async ({ page }) => {
  const crashes = watchCrashLines(page)
  await page.goto('/')
  await signIn(page, PEOPLE.ploni)
  await expect(page.getByRole('heading', { name: HOME_HE })).toBeVisible()

  await breakSessionCheck(page)
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
  await page.unroute(SESSION_CHECK)
  await tryAgain.click()
  await expect(page.getByRole('heading', { name: HOME_HE })).toContainText(PEOPLE.ploni.name)
  await expect(heading).toHaveCount(0)

  // Reload the app: the same, by loading the page again.
  await breakSessionCheck(page)
  await page.reload()
  await expect(heading).toBeVisible()
  await page.unroute(SESSION_CHECK)
  await reload.click()
  await expect(page.getByRole('heading', { name: HOME_HE })).toContainText(PEOPLE.ploni.name)

  // One line per crash, with the error's name and nothing the person or the server said.
  expect(crashes).toEqual(['Screen crash (provider app): TypeError', 'Screen crash (provider app): TypeError'])
})

test('the broken screen speaks the language and wears the theme that the person chose on their phone', async ({ page }) => {
  const crashes = watchCrashLines(page)
  await page.goto('/')
  await page.getByLabel(he['lang.label']).selectOption('en') // John reads English: he picks it himself
  await page.getByLabel(en['theme.label']).selectOption('light')
  await signIn(page, PEOPLE.john, en)
  await expect(page.getByRole('heading', { name: HOME_EN })).toBeVisible()

  await breakSessionCheck(page)
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
  await tryAgain.click()
  await expect(page.getByRole('heading', { name: 'נקודות סריקה' })).toBeVisible()
  await expect(heading).toHaveCount(0)
  expect(crashes).toEqual(['Screen crash (committee app): Error'])
})
