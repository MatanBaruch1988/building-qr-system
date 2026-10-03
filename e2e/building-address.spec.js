// The building's address: the committee types it in the Committee tab, and the provider app shows it in its header.
// It starts empty on a real deployment; here the scratch schema has an invented one (scripts/dev-seed.mjs).
import { randomUUID } from 'node:crypto'
import { test, expect, he, BUILDING_ADDRESS, adminSignIn, allowConsoleErrors } from './fixtures.js'

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

/** Puts the address of the scratch schema back, so that the specs that run after this one find it. */
const restore = (page) => page.request.put('/api/admin/building', { data: { address: BUILDING_ADDRESS } })

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
      await expect(page.getByRole('banner').getByRole('paragraph')).toHaveCount(0)
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
    expect(Object.keys((await open.json()).building)).toEqual(['address'])
    for (const response of [await anonymous.get('/api/admin/building'), await anonymous.put('/api/admin/building', { data: { address: 'x' } })]) {
      expect(response.status()).toBe(401)
    }
  } finally {
    await anonymous.dispose()
  }
})
