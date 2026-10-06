// The building's address and name: the committee types them in the Committee tab, the provider app shows both in its header (the
// name above the address) and the committee app shows the name as its brand. They start empty on a real deployment; here the
// scratch schema has an invented address and an invented name (scripts/dev-seed.mjs).
import { randomUUID } from 'node:crypto'
import ar from '../src/i18n/ar.js'
import { BUILDING_NAME_MAX_LENGTH } from '../shared/contract.js'
import { test, expect, he, en, ru, BUILDING_ADDRESS, BUILDING_NAME, ADMIN_EMAIL, adminSignIn, allowConsoleErrors } from './fixtures.js'

const COMPUTER = { width: 1280, height: 800 }
const SIZES = [['on a phone', null], ['on a computer', COMPUTER]]

test.beforeEach(async ({ page }) => {
  // The sign-in screen asks /api/admin/me before anyone is signed in: the browser notes that 401 as a console error.
  allowConsoleErrors(page, /status of 401/)
})

const loaded = async (page) => {
  await expect(page.getByRole('heading', { level: 1, name: 'חברי הוועד' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'טוען' })).toHaveCount(0)
}
const field = (page) => page.getByLabel('כתובת הבניין', { exact: true })
const nameField = (page) => page.getByLabel('שם הבניין', { exact: true })
const saveButton = (page) => page.getByRole('button', { name: 'שמירה', exact: true })
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

/** Types an address in the Committee tab and saves it. */
async function setAddress(page, address) {
  await page.goto('/admin#committee')
  await loaded(page)
  await field(page).fill(address)
  await saveButton(page).click()
  await expect(page.getByRole('status').filter({ hasText: address ? 'כתובת הבניין נשמרה' : 'כתובת הבניין הוסרה' })).toBeVisible()
}

/** Puts the address and the name of the scratch schema back, so that the specs that run after this one find them. */
const restore = (page) => page.request.put('/api/admin/building', { data: { address: BUILDING_ADDRESS, name: BUILDING_NAME } })

/** The two icons are at the end of the header (the left edge on a Hebrew screen), whether or not there is an address. */
async function iconsAtTheEnd(page, what) {
  const header = await page.getByRole('banner').boundingBox()
  const icons = await page.getByRole('banner').getByLabel(he['lang.label']).boundingBox()
  const before = icons.x - header.x // the gap to the left edge
  const after = header.x + header.width - (icons.x + icons.width) // the gap to the right edge
  expect(before, `${what}: the icons sit at the left, the end of a Hebrew screen`).toBeLessThan(after)
  expect(icons.x, `${what}: the icons are inside the screen`).toBeGreaterThanOrEqual(0)
}

for (const [where, size] of SIZES) {
  test(`the committee sets the address ${where}, the provider app shows it, and clearing it removes the line`, async ({ page }) => {
    const address = `רחוב הבדיקה ${randomUUID().slice(0, 6)} 3, Test Town`
    await adminSignIn(page)
    if (size) await page.setViewportSize(size)
    try {
      // the card is there, with the address that the scratch schema starts with, and nothing to save yet
      await page.goto('/admin#committee')
      await loaded(page)
      await expect(page.getByRole('heading', { level: 2, name: 'פרטי הבניין' })).toBeVisible()
      await expect(field(page)).toHaveValue(BUILDING_ADDRESS)
      await expect(saveButton(page)).toBeDisabled()
      await expect(page.getByText('אפשר להשאיר ריק')).toBeVisible()
      expect(await noHorizontalScroll(page), `the committee tab ${where}`).toBe(true)

      // the field and the button are inside the screen and big enough to tap, on this size
      const fieldBox = await field(page).boundingBox()
      const view = page.viewportSize()
      expect(fieldBox.x).toBeGreaterThanOrEqual(0)
      expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(view.width)
      expect(fieldBox.height).toBeGreaterThanOrEqual(44)

      // typing makes it savable; saving says so, and keeps the text
      await field(page).fill(address)
      await expect(saveButton(page)).toBeEnabled()
      await saveButton(page).click()
      await expect(page.getByRole('status').filter({ hasText: 'כתובת הבניין נשמרה' })).toBeVisible()
      await expect(field(page)).toHaveValue(address)
      await expect(saveButton(page)).toBeDisabled()

      // the provider app shows it in the header
      await page.goto('/')
      await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
      await expect(page.getByRole('banner').getByText(address)).toBeVisible()
      await iconsAtTheEnd(page, 'with an address')
      expect(await noHorizontalScroll(page), `the provider app ${where}`).toBe(true)

      // still there after a reload of the committee tab (it is stored, not just on the screen)
      await page.goto('/admin#committee')
      await loaded(page)
      await expect(field(page)).toHaveValue(address)

      // clearing it removes the line: no empty paragraph, and the icons stay where they were
      await setAddress(page, '')
      await expect(field(page)).toHaveValue('')
      await page.goto('/')
      await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
      await expect(page.getByText(address)).toHaveCount(0) // it was saved on the phone, so this waits for the answer
      // no empty paragraph: the only line left in the header is the name of the building (the scratch schema has one)
      await expect(page.getByRole('banner').getByRole('paragraph')).toHaveText([BUILDING_NAME])
      await iconsAtTheEnd(page, 'with no address')
      expect(await noHorizontalScroll(page), `the provider app ${where}, no address`).toBe(true)
    } finally {
      await restore(page)
    }
  })
}

test('a very long address wraps in the header of the provider app and pushes nothing off the screen', async ({ page }) => {
  const longest = `Example ${'רחוב הארוך '.repeat(20)}`.slice(0, 200).trim() // Latin first, then Hebrew: dir=auto reads it left to right
  await adminSignIn(page)
  try {
    expect((await page.request.put('/api/admin/building', { data: { address: longest } })).ok()).toBe(true)
    for (const size of [null, COMPUTER]) {
      if (size) await page.setViewportSize(size)
      await page.goto('/')
      await expect(page.getByRole('banner').getByText(longest)).toBeVisible()
      expect(await noHorizontalScroll(page), `a 200 character address at ${size ? 'computer' : 'phone'} width`).toBe(true)
      await iconsAtTheEnd(page, 'with a long address')
    }
  } finally {
    await restore(page)
  }
})

test('the committee is told about a character that cannot be saved, and nothing is saved', async ({ page }) => {
  await adminSignIn(page)
  await page.goto('/admin#committee')
  await loaded(page)
  await field(page).fill('רחוב\tהדוגמה')
  await saveButton(page).click()
  await expect(page.getByRole('alert').filter({ hasText: 'תווים שאי אפשר לשמור' })).toBeVisible()
  // typing again takes the message away
  await field(page).fill('רחוב הדוגמה 2')
  await expect(page.getByRole('alert').filter({ hasText: 'תווים שאי אפשר לשמור' })).toHaveCount(0)
  // and the server still has the one it had
  expect((await (await page.request.get('/api/admin/building')).json()).building.address).toBe(BUILDING_ADDRESS)
})

test('the address field stops at 200 characters, the most the server takes', async ({ page }) => {
  await adminSignIn(page)
  await page.goto('/admin#committee')
  await loaded(page)
  await expect(field(page)).toHaveAttribute('maxlength', '200')
})

test('the public route answers to anyone, and the committee routes only to a committee member', async ({ page, playwright }) => {
  await adminSignIn(page)
  const anonymous = await playwright.request.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const open = await anonymous.get('/api/public/building')
    expect(open.ok()).toBe(true)
    // the two public fields of the building and nothing else (its name joined the address in migration 012)
    expect(Object.keys((await open.json()).building)).toEqual(['address', 'name'])
    for (const response of [await anonymous.get('/api/admin/building'), await anonymous.put('/api/admin/building', { data: { address: 'x' } })]) {
      expect(response.status()).toBe(401)
    }
  } finally {
    await anonymous.dispose()
  }
})

// ---- the building's name ---------------------------------------------------------------------------------------------

const APP = 'נוכחות בבניין' // what the committee app is called when the building has no name
// The brand is in the side rail on a computer and in the top bar on a phone: CSS shows one of the two, and a hidden one has no role.
const brandBar = (page, size) => (size ? page.getByRole('complementary') : page.getByRole('banner'))
const toolsOf = (bar) => ({
  link: bar.getByRole('link', { name: 'אפליקציית נותני השירות' }),
  signOut: bar.getByRole('button', { name: 'יציאה' }),
})
const signedOutLogin = async (page) => {
  await page.context().clearCookies() // the session is only a cookie
  await page.goto('/admin')
  await expect(page.getByRole('heading', { level: 1, name: 'ניהול נוכחות הבניין' })).toBeVisible()
}
/**
 * The card of the sign-in screen (the parent of its title) is inside the screen, and so is the building's name in it. The scroll width
 * of the whole page is not asked here: in WebKit the sign-in screen is a few pixels wider than the phone with or without a name, because
 * the hidden <select> of its light/dark picker (src/ui/ThemeSwitch.jsx) is wider than the 44 px box that holds it. That is not about
 * the name, and it is in the notes of the pull request.
 */
async function loginFits(page, what, name) {
  const title = page.getByRole('heading', { level: 1, name: 'ניהול נוכחות הבניין' })
  const card = await title.locator('xpath=..').boundingBox()
  const view = page.viewportSize()
  expect(card.x, `${what}: the card is inside the screen`).toBeGreaterThanOrEqual(0)
  expect(card.x + card.width, `${what}: the card is inside the screen`).toBeLessThanOrEqual(view.width)
  if (!name) return
  const box = await page.getByText(name).boundingBox()
  expect(box.x, `${what}: the name is inside the card`).toBeGreaterThanOrEqual(card.x)
  expect(box.x + box.width, `${what}: the name is inside the card`).toBeLessThanOrEqual(card.x + card.width)
}
const signBackIn = async (page) => {
  await page.getByRole('button', { name: 'כניסת פיתוח' }).click()
  await expect(page.getByRole('heading', { name: 'נקודות סריקה' })).toBeVisible()
}
/** Signs the committee in again by the request (a test that signed out ends here), and puts the scratch schema's texts back. */
async function signInAndRestore(page) {
  expect((await page.request.post('/api/admin/dev-login', { data: { email: ADMIN_EMAIL } })).ok(), 'dev admin sign-in').toBe(true)
  expect((await restore(page)).ok()).toBe(true)
}

for (const [where, size] of SIZES) {
  test(`the committee names the building ${where}: both apps show the name, and clearing it brings the plain titles back`, async ({ page }) => {
    const name = `מגדל הבדיקה ${randomUUID().slice(0, 6)}`
    await adminSignIn(page)
    if (size) await page.setViewportSize(size)
    try {
      // the card: the name field is the first of the two, it has the invented name of the scratch schema, and nothing waits to be saved
      await page.goto('/admin#committee')
      await loaded(page)
      await expect(nameField(page)).toHaveValue(BUILDING_NAME)
      await expect(saveButton(page)).toBeDisabled()
      const nameBox = await nameField(page).boundingBox()
      const addressBox = await field(page).boundingBox()
      expect(nameBox.y + nameBox.height, 'the name field is above the address field').toBeLessThanOrEqual(addressBox.y)
      const view = page.viewportSize()
      expect(nameBox.x).toBeGreaterThanOrEqual(0)
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(view.width)
      expect(nameBox.height).toBeGreaterThanOrEqual(44)
      await expect(nameField(page)).toHaveAttribute('maxlength', String(BUILDING_NAME_MAX_LENGTH))
      // the brand and the title of the window already say the name that is saved
      await expect(brandBar(page, size)).toContainText(BUILDING_NAME)
      await expect(page).toHaveTitle(`ועד · ${BUILDING_NAME}`)
      expect(await noHorizontalScroll(page), `the committee tab ${where}`).toBe(true)

      // a new name is saved by the same button, and the brand and the title follow it with no reload
      await page.evaluate(() => { window.sameDocument = true })
      await nameField(page).fill(name)
      await expect(saveButton(page)).toBeEnabled()
      await saveButton(page).click()
      await expect(page.getByRole('status').filter({ hasText: 'שם הבניין נשמר' })).toBeVisible()
      await expect(brandBar(page, size)).toContainText(name)
      await expect(brandBar(page, size)).not.toContainText(BUILDING_NAME)
      await expect(page).toHaveTitle(`ועד · ${name}`)
      await expect(saveButton(page)).toBeDisabled()
      await expect(field(page)).toHaveValue(BUILDING_ADDRESS) // the address was sent with it and is as it was
      // every tab has it in its title, the page first
      await page.evaluate(() => { window.location.hash = '#points' })
      await expect(page).toHaveTitle(`נקודות · ${name}`)
      expect(await page.evaluate(() => window.sameDocument), 'the page was not reloaded').toBe(true)
      await page.evaluate(() => { window.location.hash = '#committee' })
      await loaded(page)

      // the change is in the audit log, as a change of the name, under the new phrase for an update of the building's details
      await page.getByRole('button', { name: 'יומן פעולות', exact: true }).click()
      const entry = page.getByRole('region', { name: 'יומן פעולות' }).getByRole('listitem').filter({ hasText: 'עדכון פרטי הבניין' }).first()
      await expect(entry).toContainText(`שם: ${BUILDING_NAME} ← ${name}`)

      // the provider app: the name is a line of its own above the address, and it starts the title of the window
      await page.goto('/')
      await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
      const header = page.getByRole('banner')
      await expect(header.getByText(name)).toBeVisible()
      await expect(page).toHaveTitle(`${name} · ${he['app.name']}`)
      const above = await header.getByText(name).boundingBox()
      const below = await header.getByText(BUILDING_ADDRESS).boundingBox()
      expect(above.y + above.height, 'the name is above the address').toBeLessThanOrEqual(below.y + 1)
      await iconsAtTheEnd(page, 'with a name and an address')
      expect(await noHorizontalScroll(page), `the provider app ${where}, with a name`).toBe(true)

      // clearing the name: the plain brand and titles come back, with no reload, and the provider app keeps only the address
      await page.goto('/admin#committee')
      await loaded(page)
      await expect(brandBar(page, size)).toContainText(name)
      await nameField(page).fill('')
      await saveButton(page).click()
      await expect(page.getByRole('status').filter({ hasText: 'שם הבניין הוסר' })).toBeVisible()
      await expect(brandBar(page, size)).toContainText(APP)
      await expect(brandBar(page, size)).not.toContainText(name)
      await expect(page).toHaveTitle(`ועד · ${APP}`)
      await expect(nameField(page)).toHaveValue('')
      await page.goto('/')
      await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
      await expect(page.getByText(name)).toHaveCount(0) // it was saved on the phone, so this waits for the answer
      await expect(page).toHaveTitle(he['app.name'])
      await expect(page.getByRole('banner').getByRole('paragraph')).toHaveText([BUILDING_ADDRESS]) // the address is the title of the header again
      await iconsAtTheEnd(page, 'with no name')
      expect(await noHorizontalScroll(page), `the provider app ${where}, no name`).toBe(true)
    } finally {
      await restore(page)
    }
  })

  test(`the sign-in screen of the committee names the building ${where}, and has no line for it when there is no name`, async ({ page }) => {
    await adminSignIn(page)
    if (size) await page.setViewportSize(size)
    try {
      // the invented name of the scratch schema: a line right under the title, before the line that says who may sign in
      await signedOutLogin(page)
      const title = page.getByRole('heading', { level: 1, name: 'ניהול נוכחות הבניין' })
      const who = page.getByText('כניסה לוועד הבית בלבד')
      await expect(page.getByText(BUILDING_NAME)).toBeVisible()
      const [t, n, w] = [await title.boundingBox(), await page.getByText(BUILDING_NAME).boundingBox(), await who.boundingBox()]
      expect(t.y + t.height, 'the name is under the title').toBeLessThanOrEqual(n.y + 1)
      expect(n.y + n.height, 'and above the line that follows').toBeLessThanOrEqual(w.y + 1)
      await loginFits(page, `the sign-in screen ${where}, with a name`, BUILDING_NAME)

      // no name: the screen is as it was, the line that says who may sign in follows the title
      await signBackIn(page)
      expect((await page.request.put('/api/admin/building', { data: { address: BUILDING_ADDRESS, name: '' } })).ok()).toBe(true)
      await signedOutLogin(page)
      await expect(title.locator('xpath=following-sibling::*[1]')).toContainText('כניסה לוועד הבית בלבד')
      await loginFits(page, `the sign-in screen ${where}, no name`)
      await signBackIn(page)
    } finally {
      await signInAndRestore(page)
    }
  })
}

// The longest name that the server takes, as one word with nowhere to wrap (the worst case for an overflow) and as words.
const WORDS = 'בניין הדוגמה '.repeat(7).slice(0, BUILDING_NAME_MAX_LENGTH).trim()
const WORD = 'א'.repeat(BUILDING_NAME_MAX_LENGTH)
const PHONE_360 = { width: 360, height: 740 }
for (const [what, longName] of [['one word of 80 letters', WORD], ['80 characters of words', WORDS]]) {
  for (const [where, size] of [['a 360 px phone', PHONE_360], ['a computer', COMPUTER]]) {
    test(`a name of ${what} breaks nothing on ${where}: the committee app, its sign-in screen and the provider app`, async ({ page }) => {
      const phone = size === PHONE_360
      await adminSignIn(page)
      await page.setViewportSize(size)
      try {
        expect(longName.length).toBeLessThanOrEqual(BUILDING_NAME_MAX_LENGTH)
        expect((await page.request.put('/api/admin/building', { data: { address: BUILDING_ADDRESS, name: longName } })).ok()).toBe(true)

        // the committee app: the brand is cut to two lines in the top bar and three in the side rail, and nothing is pushed off the screen
        await page.goto('/admin#committee')
        await loaded(page)
        const bar = brandBar(page, !phone)
        await expect(bar).toContainText(longName) // the whole name is in the page (a screen reader reads it); the stylesheet cuts what is drawn
        const brand = await bar.getByText(longName).boundingBox()
        const barBox = await bar.boundingBox()
        const { link, signOut } = toolsOf(bar)
        const out = await signOut.boundingBox()
        expect(brand.height, 'the brand is cut to its lines').toBeLessThanOrEqual((phone ? 2 : 3) * 24)
        expect(brand.x, 'the brand is inside the screen').toBeGreaterThanOrEqual(0)
        expect(brand.x + brand.width, 'the brand is inside the screen').toBeLessThanOrEqual(size.width)
        if (phone) {
          const first = await link.boundingBox()
          expect(barBox.height, 'the top bar stays a bar').toBeLessThanOrEqual(110)
          expect(out.x, 'the icons are inside the screen').toBeGreaterThanOrEqual(0)
          expect(first.x + first.width, 'the icons are inside the screen').toBeLessThanOrEqual(size.width)
          expect(brand.x, 'the brand does not run into the icons (on a Hebrew screen it is on the right of them)').toBeGreaterThanOrEqual(first.x + first.width - 1)
          // the tab bar still has its five tabs on the 360 px screen (#103)
          const tabs = page.getByRole('navigation', { name: 'ניווט ראשי (טלפון)' }).getByRole('button')
          await expect(tabs).toHaveCount(5)
          for (const tab of await tabs.all()) {
            const box = await tab.boundingBox()
            expect(box.x).toBeGreaterThanOrEqual(0)
            expect(box.x + box.width).toBeLessThanOrEqual(size.width)
          }
        } else {
          expect(out.y + out.height, 'the sign-out icon of the side rail is on the screen').toBeLessThanOrEqual(size.height)
          expect(barBox.height, 'the rail is as tall as the screen and no taller').toBeLessThanOrEqual(size.height)
        }
        expect(await noHorizontalScroll(page), `the committee tab with a long name on ${where}`).toBe(true)
        const nameBox = await nameField(page).boundingBox()
        expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(size.width)
        await expect(nameField(page)).toHaveValue(longName)

        // the provider app: the name wraps in the header and the two icons stay at its end
        await page.goto('/')
        await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
        await expect(page.getByRole('banner').getByText(longName)).toBeVisible()
        await expect(page).toHaveTitle(`${longName} · ${he['app.name']}`)
        expect(await noHorizontalScroll(page), `the provider app with a long name on ${where}`).toBe(true)
        await iconsAtTheEnd(page, 'with a long name')

        // the sign-in screen of the committee: the name wraps inside the card
        await signedOutLogin(page)
        await expect(page.getByText(longName)).toBeVisible()
        await loginFits(page, `the sign-in screen with a long name on ${where}`, longName)
      } finally {
        await signInAndRestore(page)
      }
    })
  }
}

test('the name field stops at 80 characters, the most the server takes, and the server answers the field it refuses', async ({ page }) => {
  await adminSignIn(page)
  await page.goto('/admin#committee')
  await loaded(page)
  await expect(nameField(page)).toHaveAttribute('maxlength', '80')
  // a name that is too long is refused by the server, naming the field (the form never sends one, an old or odd client could)
  const refused = await page.request.put('/api/admin/building', { data: { address: BUILDING_ADDRESS, name: 'א'.repeat(81) } })
  expect(refused.status()).toBe(400)
  expect((await refused.json()).error).toMatchObject({ code: 'invalid_field', field: 'name' })
  expect((await (await page.request.get('/api/admin/building')).json()).building.name).toBe(BUILDING_NAME)
})

test('the committee is told about a name with a character that cannot be saved, under the name field, and nothing is saved', async ({ page }) => {
  await adminSignIn(page)
  await page.goto('/admin#committee')
  await loaded(page)
  await nameField(page).fill('בניין\tהדוגמה')
  await saveButton(page).click()
  await expect(page.getByRole('alert').filter({ hasText: 'השם מכיל תווים שאי אפשר לשמור' })).toBeVisible()
  await expect(nameField(page)).toHaveAttribute('aria-invalid', 'true')
  await expect(field(page)).not.toHaveAttribute('aria-invalid', 'true')
  await nameField(page).fill('בניין הדוגמה 2')
  await expect(page.getByRole('alert').filter({ hasText: 'השם מכיל תווים שאי אפשר לשמור' })).toHaveCount(0)
  expect((await (await page.request.get('/api/admin/building')).json()).building.name).toBe(BUILDING_NAME)
})

test('the title of the provider app is the name of the building and then the name of the app, in the language of the person', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: he['login.title'] })).toBeVisible()
  await expect(page).toHaveTitle(`${BUILDING_NAME} · ${he['app.name']}`)
  let words = he
  for (const [code, next] of [['en', en], ['ru', ru], ['ar', ar]]) {
    await page.getByRole('banner').getByLabel(words['lang.label']).selectOption(code)
    await expect(page).toHaveTitle(`${BUILDING_NAME} · ${next['app.name']}`) // the name is data and stays, the app's name is translated
    await expect(page.getByRole('banner').getByText(BUILDING_NAME)).toBeVisible()
    words = next
  }
})

test('a phone that saved only the address (an older version of the app) shows it, then the name when it arrives, and keeps both', async ({ page }) => {
  // what the phone had before the name existed: { address } under the same key
  await page.addInitScript((address) => {
    if (!window.localStorage.getItem('qr.building.v1')) window.localStorage.setItem('qr.building.v1', JSON.stringify({ address }))
  }, BUILDING_ADDRESS)
  await page.route('**/api/public/building', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300)) // the old value is on the screen for a moment before the answer
    await route.continue()
  })
  await page.goto('/')
  await expect(page.getByRole('banner').getByText(BUILDING_ADDRESS)).toBeVisible()
  await expect(page.getByRole('banner').getByText(BUILDING_NAME)).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(window.localStorage.getItem('qr.building.v1')))).toEqual({ address: BUILDING_ADDRESS, name: BUILDING_NAME })
})
