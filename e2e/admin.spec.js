// The committee screens on a phone and on a computer: the same icons, nothing spilling off the screen, and deleting.
import { randomUUID } from 'node:crypto'
import { test, expect, he, PEOPLE, adminSignIn, clearScans, allowConsoleErrors } from './fixtures.js'

const COMPUTER = { width: 1280, height: 800 }
// Each tab and the heading of its page (every view renders its own h1 above its content)
const TABS = [
  ['points', 'נקודות סריקה'],
  ['providers', 'נותני שירות'],
  ['history', 'היסטוריית נוכחות'],
  ['agent', 'גישה לאייג\'נט'],
  ['committee', 'חברי הוועד'],
]

test.beforeEach(async ({ page, request }) => {
  // The sign-in screen asks /api/admin/me before anyone is signed in: the browser notes that 401 as a console error.
  allowConsoleErrors(page, /status of 401/)
  await clearScans(request)
})

const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test('the point tiles offer their actions as icons that have names, and no text buttons', async ({ page }) => {
  await adminSignIn(page)
  const tile = page.getByRole('article').filter({ hasText: 'לובי' })
  const actions = tile.getByRole('button')
  await expect(actions).toHaveCount(3)
  await expect(actions.nth(0)).toHaveAccessibleName('QR והדפסה')
  await expect(actions.nth(1)).toHaveAccessibleName('עריכה')
  await expect(actions.nth(2)).toHaveAccessibleName('מחיקת הנקודה')
  await expect(actions).toHaveText(['', '', '']) // icons only
  // adding a point is the round primary button at the end of the title row
  await expect(page.getByRole('button', { name: 'נקודה חדשה' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'הדפסת כל השלטים' })).toBeVisible()
})

test('the provider-app, light/dark and sign-out icons are the same on a phone and on a computer', async ({ page }) => {
  await adminSignIn(page)
  const tools = async () => {
    await expect(page.getByRole('link', { name: 'אפליקציית נותני השירות' })).toBeVisible()
    // both layouts are in the page, one of them hidden: a role query sees only the one that is shown
    await expect(page.getByRole('combobox', { name: he['theme.label'] })).toBeVisible()
    await expect(page.getByRole('button', { name: 'יציאה' })).toBeVisible()
  }
  await tools() // the phone's width, as the project sets it
  await page.setViewportSize(COMPUTER)
  await tools()
  // on a computer there are no text rows left for them in the side rail
  await expect(page.getByRole('complementary').getByRole('button', { name: 'יציאה' })).toHaveText('')
})

test('every committee screen fits the width, on a phone and on a computer', async ({ page }) => {
  await adminSignIn(page)
  for (const size of [null, COMPUTER]) {
    if (size) await page.setViewportSize(size)
    for (const [tab, title] of TABS) {
      await page.goto(`/admin#${tab}`)
      // measure the tab itself once its list has arrived, not the previous tab or a loading screen
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
      await expect(page.getByRole('status').filter({ hasText: 'טוען' })).toHaveCount(0)
      expect(await noHorizontalScroll(page), `${tab} at ${size ? 'computer' : 'phone'} width`).toBe(true)
    }
  }
})

test('the history date fields do not overlap and stay inside the filter bar, on a phone and on a computer', async ({ page }) => {
  await adminSignIn(page)
  for (const size of [null, COMPUTER]) {
    if (size) await page.setViewportSize(size)
    await page.goto('/admin#history')
    await expect(page.getByRole('heading', { level: 1, name: 'היסטוריית נוכחות' })).toBeVisible()
    const from = await page.getByLabel('מתאריך').boundingBox()
    const to = await page.getByLabel('עד תאריך').boundingBox()
    const filters = await page.getByLabel('מתאריך').locator('xpath=ancestor::*[contains(@class,"a-filters")]').boundingBox()
    const where = size ? 'computer' : 'phone'
    const overlap = !(from.x + from.width <= to.x + 0.5 || to.x + to.width <= from.x + 0.5
      || from.y + from.height <= to.y + 0.5 || to.y + to.height <= from.y + 0.5)
    expect(overlap, `the two date fields overlap at ${where} width`).toBe(false)
    for (const box of [from, to]) {
      expect(box.x, `${where} left edge`).toBeGreaterThanOrEqual(filters.x - 0.5)
      expect(box.x + box.width, `${where} right edge`).toBeLessThanOrEqual(filters.x + filters.width + 0.5)
    }
  }
})

test('deleting a point keeps its scans, and a scan row can be deleted on its own', async ({ page, playwright }) => {
  await adminSignIn(page)
  const name = `בדיקת מחיקה ${randomUUID().slice(0, 6)}`

  // a throwaway point with one scan, made through the API
  const created = await page.request.post('/api/admin/points', { data: { name, lat: 32.3132, lng: 34.9442, gps_mode: 'none' } })
  const point = (await created.json()).point
  const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
  const providers = (await (await phone.get('/api/public/providers')).json()).providers
  const lior = providers.find((p) => p.contact_name === PEOPLE.lior.name)
  const session = await (await phone.post('/api/session', { data: { provider_id: lior.id, password: PEOPLE.lior.password } })).json()
  const scan = await phone.post('/api/scan', {
    headers: { authorization: `Bearer ${session.token}` },
    data: { id: randomUUID(), code: point.qr_token, gps: null },
  })
  expect((await scan.json()).scan.outcome).toBe('accepted')
  await phone.dispose()

  // delete the point from its tile: the confirmation says its scan stays in the history
  await page.reload() // the list was loaded before the point existed
  await page.goto('/admin#points')
  const tile = page.getByRole('article').filter({ hasText: name })
  await tile.getByRole('button', { name: 'מחיקת הנקודה' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('נשארת בהיסטוריה')
  await dialog.getByRole('button', { name: 'מחיקת הנקודה' }).click()
  await expect(tile).toHaveCount(0)

  // the scan is still in the history, under the deleted point's name; delete that row too
  await page.goto('/admin#history')
  const row = page.getByRole('listitem').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: 'מחיקת הנוכחות לצמיתות' }).click()
  await expect(page.getByRole('dialog')).toContainText('אי אפשר לשחזר')
  await page.getByRole('dialog').getByRole('button', { name: 'מחיקה', exact: true }).click()
  await expect(row).toHaveCount(0)
})
