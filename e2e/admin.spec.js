// The committee screens on a phone and on a computer: the same icons, nothing spilling off the screen, and deleting.
import { randomUUID } from 'node:crypto'
import { test, expect, he, PEOPLE, POINTS, FAR, SAMPLE_POINT, adminSignIn, clearScans, allowConsoleErrors } from './fixtures.js'
import { SCAN_ERROR_POINT_INACTIVE } from '../shared/contract.js'
import { formatDateTime } from '../shared/datetime.js'

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
  await expect(actions).toHaveCount(4)
  await expect(actions.nth(0)).toHaveAccessibleName('QR והדפסה')
  await expect(actions.nth(1)).toHaveAccessibleName('עריכה')
  await expect(actions.nth(2)).toHaveAccessibleName('השבתת הנקודה')
  await expect(actions.nth(3)).toHaveAccessibleName('מחיקת הנקודה')
  await expect(actions).toHaveText(['', '', '', '']) // icons only
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

// The tab is kept in the address. A link to a tab that is opened in the moment after signing in (the shell has just appeared)
// used to be lost: the app read the address once and attached its listener a little later, so it stayed on the first tab.
// Nothing here waits for the title or for anything else of the shell, the way a person who pastes a link does not. A fresh
// sign-in for every tab, because the moment is only there after one. (tests/components/admin-tab.test.jsx makes the moment
// happen on purpose; this checks it in a real browser.)
test('a tab that is opened by its address right after signing in opens', async ({ page }) => {
  for (const [tab, title] of TABS) {
    await page.context().clearCookies() // signed out again: the next sign-in is a first one
    await adminSignIn(page) // returns as soon as the first screen is there
    await page.goto(`/admin#${tab}`)
    await expect(page.getByRole('heading', { level: 1, name: title }), tab).toBeVisible()
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
  const created = await page.request.post('/api/admin/points', { data: { name, lat: SAMPLE_POINT.lat, lng: SAMPLE_POINT.lng, gps_mode: 'none' } })
  const point = (await created.json()).point
  const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
  const providers = (await (await phone.get('/api/public/providers')).json()).providers
  const ploni = providers.find((p) => p.contact_name === PEOPLE.ploni.name)
  const session = await (await phone.post('/api/session', { data: { provider_id: ploni.id, password: PEOPLE.ploni.password } })).json()
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

// ---- the same actions in the same places on every screen -----------------------------------------------------------

const REMOVE = {
  points: 'מחיקת הנקודה',
  providers: 'מחיקת נותן השירות',
  committee: 'מחיקה מהוועד',
  agent: 'מחיקת המפתח',
  history: 'מחיקת הנוכחות לצמיתות',
}
const loaded = async (page, title) => {
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'טוען' })).toHaveCount(0)
}
const near = (values, within, what) => {
  expect(Math.max(...values) - Math.min(...values), `${what}: ${values.map((v) => v.toFixed(1)).join(', ')}`).toBeLessThanOrEqual(within)
}

test('every screen has its actions in the same order and places, with the red trash can last', async ({ page, playwright }) => {
  await adminSignIn(page)
  const tag = randomUUID().slice(0, 6)
  // sample data, so that every kind of tile exists in its different states
  const member = (await (await page.request.post('/api/admin/admins', { data: { email: `parity-${tag}@example.test`, name: `חבר ${tag}` } })).json()).admin
  expect(member?.id, 'the sample committee member was created').toBeTruthy()
  const live = (await (await page.request.post('/api/admin/api-keys', { data: { name: `פעיל ${tag}` } })).json()).api_key
  const dead = (await (await page.request.post('/api/admin/api-keys', { data: { name: `בוטל ${tag}` } })).json()).api_key
  // a write needs a JSON body, even an empty one
  expect((await page.request.post(`/api/admin/api-keys/${dead.id}/revoke`, { data: {} })).ok()).toBe(true)
  // Ploni signs in on a phone (a connected device) and makes one visit that is accepted and one that is refused as too far
  const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
  try {
    const providers = (await (await phone.get('/api/public/providers')).json()).providers
    const ploni = providers.find((p) => p.contact_name === PEOPLE.ploni.name)
    const session = await (await phone.post('/api/session', { data: { provider_id: ploni.id, password: PEOPLE.ploni.password } })).json()
    const scan = (code, gps) => phone.post('/api/scan', { headers: { authorization: `Bearer ${session.token}` }, data: { id: randomUUID(), code, gps } })
    expect((await (await scan(POINTS.basement, null)).json()).scan.outcome).toBe('accepted')
    expect((await (await scan(POINTS.gym, { lat: FAR.latitude, lng: FAR.longitude, accuracy: FAR.accuracy })).json()).scan.outcome).toBe('rejected_far')

    const trashEdge = {} // where the trash can sits, measured from the end of its tile, per screen
    const steps = [] // the distance between the trash can and the icon next to it, on every tile
    for (const size of [null, COMPUTER]) {
      if (size) await page.setViewportSize(size)
      const where = size ? 'computer' : 'phone'
      for (const [tab, title] of TABS) {
        await page.goto(`/admin#${tab}`) // a tab loads its list when it is opened
        await loaded(page, title)
        if (tab === 'history') {
          // the refused visit is listed too: its row keeps the place of the cancel icon, and the trash can does not move
          await page.getByLabel('סוג').selectOption('all')
          await expect(page.getByText('נדחתה: רחוק מהנקודה')).toBeVisible()
        }
        const remove = page.getByRole('button', { name: REMOVE[tab] })
        const tiles = (tab === 'history' ? page.getByRole('listitem') : page.getByRole('article')).filter({ has: remove })
        const count = await tiles.count()
        // your own committee card has none (you cannot delete yourself), so that screen has just the other member's
        expect(count, `${tab}: tiles that have a trash can`).toBeGreaterThan(tab === 'committee' ? 0 : 1)

        const edges = []
        for (let i = 0; i < count; i++) {
          const tile = tiles.nth(i)
          const buttons = tile.getByRole('button')
          await expect(buttons.last(), `${tab} #${i}: the trash can is the last action`).toHaveAccessibleName(REMOVE[tab])
          const tileBox = await tile.boundingBox()
          const boxes = await Promise.all((await buttons.all()).map((b) => b.boundingBox()))
          const trash = boxes[boxes.length - 1]
          // the text of the page runs right to left, so the end of the tile is its left edge
          expect(trash.x, `${tab} #${i}: the trash can is the icon at the end`).toBeLessThanOrEqual(Math.min(...boxes.map((b) => b.x)) + 0.5)
          edges.push(trash.x - tileBox.x)
          if (boxes.length > 1) steps.push(boxes[boxes.length - 2].x - trash.x)
        }
        near(edges, 1, `${tab} at ${where} width: the trash can is in the same place on every tile`)
        trashEdge[`${tab}/${where}`] = edges[0]
      }
    }
    near(steps, 1, 'the icon next to the trash can is always the same distance from it')
    // the same place from one screen to the next (a card and a history row differ by their own padding, no more)
    for (const where of ['phone', 'computer']) {
      near(['points', 'providers', 'committee', 'agent'].map((tab) => trashEdge[`${tab}/${where}`]), 1, `${where}: the trash can is where it is on every card screen`)
    }

    // providers: the edit icon does not move whether or not a phone is signed in, and committee cards are all the same height
    await page.goto('/admin#providers')
    await loaded(page, 'נותני שירות')
    const edits = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'עריכה' }) })
    const editEdges = []
    for (let i = 0; i < await edits.count(); i++) {
      const tile = edits.nth(i)
      editEdges.push((await tile.getByRole('button', { name: 'עריכה' }).boundingBox()).x - (await tile.boundingBox()).x)
    }
    expect(editEdges.length).toBeGreaterThan(2)
    near(editEdges, 1, 'providers: the edit icon is in the same place on every tile')
    // the icon for signed-in phones is there for some providers and not for others, and nothing else moved because of it
    const phonesButton = page.getByRole('button', { name: 'מכשירים', exact: true })
    const withPhones = await phonesButton.count()
    expect(withPhones, 'some providers have a phone signed in').toBeGreaterThan(0)
    expect(withPhones, 'and some do not').toBeLessThan(editEdges.length)
    // "מכשירים" is a screen action, so on every tile that has it, it is the first icon: before the new password, edit, switch off
    // and delete, in the markup and on the screen (the text runs right to left, so the first icon is the rightmost)
    const phoneTiles = page.getByRole('article').filter({ has: phonesButton })
    for (let i = 0; i < await phoneTiles.count(); i++) {
      const buttons = phoneTiles.nth(i).getByRole('button')
      const names = await Promise.all((await buttons.all()).map((b) => b.getAttribute('aria-label')))
      expect(names, `providers #${i}: the actions in order`).toEqual(['מכשירים', 'סיסמה חדשה', 'עריכה', names[3], 'מחיקת נותן השירות'])
      expect(['השבתה', 'הפעלה']).toContain(names[3])
      const xs = (await Promise.all((await buttons.all()).map((b) => b.boundingBox()))).map((box) => box.x)
      expect(xs, `providers #${i}: each icon is to the left of the one before it`).toEqual([...xs].sort((a, b) => b - a))
    }

    await page.goto('/admin#committee')
    await loaded(page, 'חברי הוועד')
    const heights = await Promise.all((await page.getByRole('article').all()).map(async (a) => (await a.boundingBox()).height))
    expect(heights.length, 'your own card and the other member').toBeGreaterThan(1)
    near(heights, 1, 'committee: every card is the same height, also the one with no icons')
  } finally {
    await phone.dispose()
    await page.request.delete(`/api/admin/admins/${member.id}`)
    for (const key of [live, dead]) await page.request.delete(`/api/admin/api-keys/${key.id}`)
  }
})

// ---- the phones of a provider --------------------------------------------------------------------------------------------

test("a provider's phones: the card says what waits on them, and a dialog lists each phone, on a phone and on a computer", async ({ page, playwright }) => {
  await adminSignIn(page)
  const LABEL = 'Fake Browser Label' // what the app sends as the label of a phone: the committee never sees it
  const HOUR = 3600 * 1000
  const oldest = new Date(Date.now() - 30 * HOUR).toISOString() // a visit that has waited 30 hours on one phone
  const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
  const providers = (await (await phone.get('/api/public/providers')).json()).providers
  const john = providers.find((p) => p.contact_name === PEOPLE.john.name)
  try {
    // An earlier test may have signed John in on a phone: start from none, so that the two below are all he has.
    expect((await page.request.post(`/api/admin/providers/${john.id}/revoke-devices`, { data: {} })).ok()).toBeTruthy()
    // John signs in on two phones. The first reports what waits in its queue and uploads it; the second is an old version of the app: it reports nothing.
    const signInPhone = async () =>
      (await (await phone.post('/api/session', { data: { provider_id: john.id, password: PEOPLE.john.password, device_label: LABEL } })).json()).token
    const reporting = { authorization: `Bearer ${await signInPhone()}` }
    await signInPhone()
    const report = await phone.post('/api/my/device-status', {
      headers: reporting, data: { build: 'abcdef1', waiting: 3, oldest_waiting_at: oldest, not_accepted_total: 2, overflowed_total: 1 },
    })
    expect(report.ok(), 'the phone reports').toBeTruthy()
    const upload = await phone.post('/api/scans/sync', {
      headers: reporting, data: { scans: [{ id: randomUUID(), code: POINTS.lobby, client_time: new Date(Date.now() - HOUR).toISOString() }] },
    })
    expect(upload.ok(), 'the phone uploads its queue').toBeTruthy()

    // the card: how many wait and since when (DD/MM/YYYY HH:MM), and the warning for a visit that has waited more than 24 hours
    await page.goto('/admin#providers')
    await loaded(page, 'נותני שירות')
    const tile = page.getByRole('article').filter({ hasText: PEOPLE.john.name })
    await expect(tile.locator('dt:has-text("ממתינות בטלפון") + dd')).toHaveText(`3, מאז ${formatDateTime(oldest)}`)
    await expect(tile.locator('dt:has-text("ממתינות בטלפון") + dd')).toHaveText(/^3, מאז \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
    await expect(tile.getByText('ממתינות מעל 24 שעות')).toBeVisible()
    await expect(tile.locator('dt:has-text("מכשירים מחוברים") + dd')).toHaveText('2')
    expect(await noHorizontalScroll(page), 'the card at phone width').toBe(true)

    // the dialog: both phones, the one that reported with everything it said, the other as "not reporting"; never the label
    await tile.getByRole('button', { name: 'מכשירים', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `מכשירים: ${PEOPLE.john.name}` })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(2)
    const DATE_TIME = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/
    const fact = (row, label) => row.locator(`dt:has-text("${label}") + dd`)
    const reported = dialog.getByRole('listitem').filter({ hasText: 'abcdef1' })
    await expect(reported).toHaveCount(1)
    await expect(fact(reported, 'ממתינות בטלפון')).toHaveText(`3, מאז ${formatDateTime(oldest)}`)
    await expect(fact(reported, 'לא נקלטו')).toContainText('2')
    await expect(fact(reported, 'נזרקו כי התור התמלא')).toContainText('1')
    await expect(fact(reported, 'דיווח אחרון')).toHaveText(DATE_TIME)
    await expect(fact(reported, 'העלאה אחרונה מהתור')).toHaveText(DATE_TIME)
    await expect(fact(reported, 'קשר אחרון עם השרת')).toContainText('מדויק עד כ-5 דקות')
    await expect(fact(reported, 'התחברות')).toHaveText(DATE_TIME)
    const silent = dialog.getByRole('listitem').filter({ hasText: 'לא מדווח' })
    await expect(silent).toHaveCount(1)
    await expect(fact(silent, 'ממתינות בטלפון')).toHaveText('-')
    await expect(fact(silent, 'גרסה')).toHaveText('לא ידועה')
    await expect(dialog.locator('li')).toHaveCount(2)
    await expect(page.locator('body')).not.toContainText(LABEL)

    // it fits on a phone and on a computer, and the way to sign everyone out stays on the screen at the bottom
    const fits = async (where) => {
      const view = page.viewportSize()
      const box = await dialog.boundingBox()
      expect(box.x, `${where}: the dialog starts inside the screen`).toBeGreaterThanOrEqual(-0.5)
      expect(box.x + box.width, `${where}: the dialog ends inside the screen`).toBeLessThanOrEqual(view.width + 0.5)
      expect(await noHorizontalScroll(page), `${where}: no sideways scroll`).toBe(true)
      const sticking = await dialog.evaluate((el) => {
        const edge = el.getBoundingClientRect()
        return [...el.querySelectorAll('*')].filter((c) => {
          const r = c.getBoundingClientRect()
          return r.width > 0 && (r.right > edge.right + 1 || r.left < edge.left - 1)
        }).length
      })
      expect(sticking, `${where}: nothing sticks out of the dialog`).toBe(0)
      await expect(dialog.getByRole('button', { name: 'ניתוק כל המכשירים' }), `${where}: the sign-out of all phones is in view`).toBeInViewport()
    }
    await fits('phone')
    await page.setViewportSize(COMPUTER)
    await fits('computer')
    expect((await dialog.boundingBox()).width, 'on a computer the dialog is a window, not the width of the screen').toBeLessThan(COMPUTER.width / 2)

    // signing everyone out from the dialog: the question first (saying no keeps everything), then it is done and the card shows it
    await dialog.getByRole('button', { name: 'ניתוק כל המכשירים' }).click()
    const question = page.getByRole('dialog', { name: 'לנתק את כל המכשירים?' })
    await expect(question).toBeVisible()
    await question.getByRole('button', { name: 'ביטול' }).click()
    await expect(question).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'ניתוק כל המכשירים' }).click()
    await question.getByRole('button', { name: 'ניתוק', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'המכשירים נותקו' })).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await expect(tile.getByRole('button', { name: 'מכשירים', exact: true })).toHaveCount(0)
    await expect(tile.getByText('ממתינות בטלפון')).toHaveCount(0)
    await expect(tile.getByText('ממתינות מעל 24 שעות')).toHaveCount(0)
    // and the phone really is signed out: the server refuses its next report
    expect((await phone.post('/api/my/device-status', { headers: reporting, data: {} })).status()).toBe(401)
  } finally {
    await page.request.post(`/api/admin/providers/${john.id}/revoke-devices`, { data: {} }) // in case the test stopped before that
    await phone.dispose()
  }
})

// ---- the visits that the server did not count ------------------------------------------------------------------------

test('History lists the visits that were not counted, with no action on them, on a phone and on a computer', async ({ page, playwright }) => {
  await adminSignIn(page)
  // One visit that is refused online, through the real route, so that the list has a row that came the way a person's visit
  // does. The seed (scripts/dev-seed.mjs) has the others: from a phone's queue, a person who is not assigned, a code of no point.
  const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
  try {
    const providers = (await (await phone.get('/api/public/providers')).json()).providers
    const ploni = providers.find((p) => p.contact_name === PEOPLE.ploni.name)
    const session = await (await phone.post('/api/session', { data: { provider_id: ploni.id, password: PEOPLE.ploni.password } })).json()
    const refused = await phone.post('/api/scan', { headers: { authorization: `Bearer ${session.token}` }, data: { id: randomUUID(), code: POINTS.switchedOff, gps: null } })
    expect((await refused.json()).error.code).toBe(SCAN_ERROR_POINT_INACTIVE)
  } finally {
    await phone.dispose()
  }

  // a row of the list, by what it says (the reasons and the two sources are the words of the screen)
  const rows = page.getByRole('listitem').filter({ hasText: /מהתור בטלפון|בזמן אמת/ })
  const withReason = (reason) => rows.filter({ hasText: reason })
  const stamp = /נסרק בטלפון: \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/

  for (const size of [null, COMPUTER]) {
    if (size) await page.setViewportSize(size)
    const where = size ? 'computer' : 'phone'
    // from another tab, so that History opens with its own filters again (the same address would keep the ones of the last round)
    await page.goto('/admin#points')
    await loaded(page, 'נקודות סריקה')
    await page.goto('/admin#history')
    await loaded(page, 'היסטוריית נוכחות')
    await page.getByLabel('סוג').selectOption({ label: 'לא נקלטו' })

    // the visit from the queue: when the phone scanned it, next to the time of the server
    const queued = withReason('נקודה כבויה').filter({ hasText: 'מהתור בטלפון' }).first()
    await expect(queued).toBeVisible()
    await expect(queued).toContainText('נקודה ישנה')
    await expect(queued).toContainText(PEOPLE.ploni.name)
    await expect(queued).toContainText(stamp)
    // the visit that came online, a moment ago
    const online = withReason('נקודה כבויה').filter({ hasText: 'בזמן אמת' }).first()
    await expect(online).toBeVisible()
    await expect(online).toContainText(PEOPLE.ploni.name)
    // the other reasons of the seed: a person who is not assigned, and a code that names no point
    await expect(withReason('לא משויך לנקודה').first()).toContainText('גימבורי')
    await expect(withReason('נתונים לא תקינים').first()).toContainText('קוד לא מוכר') // no point: its name is "unknown code"
    await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /^\d{2}\/\d{2}\/\d{4} · \d+$/ }).first()).toBeVisible()

    // read only: no action on any row, no file, and none of the filters that are about scans
    for (const row of await rows.all()) await expect(row.getByRole('button'), `${where}: an action on a row`).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'ייצוא ל-Excel' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'ייצוא ל-Excel' })).toHaveCount(0)
    await expect(page.getByLabel('כולל מבוטלות')).toHaveCount(0)
    await expect(page.getByLabel('כולל חשבון דמו')).toHaveCount(0)
    expect(await noHorizontalScroll(page), `the list of visits not counted at ${where} width`).toBe(true)

    // the point filter applies: only the point that was switched off is left
    await page.getByLabel('נקודה').selectOption({ label: 'נקודה ישנה' })
    await expect(withReason('לא משויך לנקודה')).toHaveCount(0)
    await expect(withReason('נקודה כבויה').first()).toBeVisible()
    await page.getByLabel('נקודה').selectOption({ label: 'כל הנקודות' })
    await expect(withReason('לא משויך לנקודה').first()).toBeVisible()

    // a stretch of time with none of them: the empty state, and the filter can go back to the scans (and their file)
    const from = page.getByLabel('מתאריך')
    const until = page.getByLabel('עד תאריך')
    await from.fill('')
    await from.pressSequentially('01012020')
    await until.fill('')
    await until.pressSequentially('02012020')
    await expect(page.getByRole('heading', { level: 2, name: 'אין ביקורים שלא נקלטו בטווח הזה' })).toBeVisible()
    await page.getByLabel('סוג').selectOption({ label: 'נוכחויות שנרשמו' })
    await expect(page.getByRole('link', { name: 'ייצוא ל-Excel' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'אין נוכחויות בטווח הזה' })).toBeVisible()
  }
})

test('a provider, a committee member and an agent key can each be deleted from their tile, after a confirmation', async ({ page, playwright }) => {
  await adminSignIn(page)
  const tag = randomUUID().slice(0, 6)
  const post = async (url, data) => (await page.request.post(url, { data })).json()
  const password = `pw-${tag}-1234`
  const provider = (await post('/api/admin/providers', { company: `חברה ${tag}`, contact_name: `עובד ${tag}`, password })).provider
  await post('/api/admin/admins', { email: `gone-${tag}@example.test`, name: `חבר ${tag}` })
  await post('/api/admin/api-keys', { name: `מפתח ${tag}` })

  // the provider has one visit on record
  const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
  const session = await (await phone.post('/api/session', { data: { provider_id: provider.id, password } })).json()
  const visit = await phone.post('/api/scan', { headers: { authorization: `Bearer ${session.token}` }, data: { id: randomUUID(), code: POINTS.basement, gps: null } })
  expect((await visit.json()).scan.outcome).toBe('accepted')
  await phone.dispose()

  const deleteFrom = async (tab, title, tile, button, confirmLabel, mentions) => {
    await page.goto(`/admin#${tab}`)
    await loaded(page, title)
    await tile.getByRole('button', { name: button }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(mentions)
    await dialog.getByRole('button', { name: confirmLabel }).click()
    await expect(tile).toHaveCount(0)
  }

  await deleteFrom('providers', 'נותני שירות', page.getByRole('article').filter({ hasText: `עובד ${tag}` }),
    'מחיקת נותן השירות', 'מחיקת נותן השירות', 'בהיסטוריה, תחת השם הזה')
  await deleteFrom('committee', 'חברי הוועד', page.getByRole('article').filter({ hasText: `חבר ${tag}` }),
    'מחיקה מהוועד', 'מחיקה מהוועד', 'אפשר להוסיף את אותה כתובת שוב')
  await deleteFrom('agent', 'גישה לאייג\'נט', page.getByRole('article').filter({ hasText: `מפתח ${tag}` }),
    'מחיקת המפתח', 'מחיקת המפתח', 'נמחק מהרשימה לצמיתות')

  // the provider's visit is still in the history, under their name
  await page.goto('/admin#history')
  await loaded(page, 'היסטוריית נוכחות')
  await expect(page.getByRole('listitem').filter({ hasText: `עובד ${tag}` })).toHaveCount(1)
  // and the deleted provider is gone from the sign-in list of the provider app
  const list = (await (await page.request.get('/api/public/providers')).json()).providers
  expect(list.find((p) => p.id === provider.id)).toBeUndefined()
})

test('the provider form and card have no language: each person chooses theirs on their own phone', async ({ page }) => {
  await adminSignIn(page)
  await page.goto('/admin#providers')
  await loaded(page, 'נותני שירות')
  // no language label on any card
  for (const label of ['עברית', 'English', 'Русский', 'العربية']) {
    await expect(page.getByRole('article').getByText(label, { exact: true }), `a card shows the language ${label}`).toHaveCount(0)
  }
  // and none to pick in the form, for a new provider or for an existing one
  await page.getByRole('button', { name: 'נותן שירות חדש' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('סוג שירות')).toBeVisible()
  await expect(dialog.getByText('שפת הממשק')).toHaveCount(0)
  await expect(dialog.getByRole('option', { name: 'Русский' })).toHaveCount(0)
})

// ---- dates and times: DD/MM/YYYY and HH:MM everywhere ---------------------------------------------------------------

test.describe('dates on the committee screens', () => {
  // An English device: the browser's own date field would show month first here. Ours reads DD/MM/YYYY anyway.
  test.use({ locale: 'en-US' })

  const DAY = /^\d{2}\/\d{2}\/\d{4}$/
  const DAY_TIME = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/
  // what must never be on a screen: a day with a month name ("1 באוק׳", not a word that happens to contain one), a weekday,
  // an ISO date, a 12-hour clock
  const OTHER_FORMATS = /\d{1,2}\s*ב?(ינו|פבר|מרץ|אפר|מאי|יוני|יולי|אוג|ספט|אוק|נוב|דצמ)|יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|\d{4}-\d{2}-\d{2}|\b[AP]M\b|\d{2}:\d{2}:\d{2}|\b24:\d{2}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,? \d|\d (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i

  test('every date and time is DD/MM/YYYY and HH:MM, and the date fields read the same on an English device', async ({ page, playwright }) => {
    await adminSignIn(page)
    const tag = randomUUID().slice(0, 6)
    const key = (await (await page.request.post('/api/admin/api-keys', { data: { name: `מפתח ${tag}` } })).json()).api_key
    // Ploni makes a visit, so there is a "last visit" for him and a row in the history
    const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
    try {
      const providers = (await (await phone.get('/api/public/providers')).json()).providers
      const ploni = providers.find((p) => p.contact_name === PEOPLE.ploni.name)
      const session = await (await phone.post('/api/session', { data: { provider_id: ploni.id, password: PEOPLE.ploni.password } })).json()
      const visit = await phone.post('/api/scan', { headers: { authorization: `Bearer ${session.token}` }, data: { id: randomUUID(), code: POINTS.basement, gps: null } })
      expect((await visit.json()).scan.outcome).toBe('accepted')

      const noOtherFormat = async (what) => {
        const text = await page.getByRole('main').innerText()
        expect(text, `${what}: another way of writing a date`).not.toMatch(OTHER_FORMATS)
      }

      // providers: the last visit
      await page.goto('/admin#providers')
      await loaded(page, 'נותני שירות')
      const ploniCard = page.getByRole('article').filter({ hasText: PEOPLE.ploni.name })
      await expect(ploniCard.locator('dd').nth(0)).toHaveText(DAY_TIME) // "last visit"
      await noOtherFormat('providers')

      // committee: the last sign-in of the member who is signed in now
      await page.goto('/admin#committee')
      await loaded(page, 'חברי הוועד')
      await expect(page.getByRole('article').filter({ hasText: '(אתם)' }).locator('dd').first()).toHaveText(DAY_TIME) // the member who is signed in
      await noOtherFormat('committee')

      // agent keys: created
      await page.goto('/admin#agent')
      await loaded(page, "גישה לאייג'נט")
      const keyCard = page.getByRole('article').filter({ hasText: `מפתח ${tag}` })
      await expect(keyCard.locator('dd').nth(1)).toHaveText(DAY_TIME) // "created"
      await noOtherFormat('agent keys')

      // history: the two date fields, the heading of the day, the time of the visit, and the confirmation
      await page.goto('/admin#history')
      await loaded(page, 'היסטוריית נוכחות')
      const from = page.getByLabel('מתאריך')
      const to = page.getByLabel('עד תאריך')
      await expect(from).toHaveValue(DAY)
      await expect(to).toHaveValue(DAY)
      await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /\d{2}\/\d{2}\/\d{4}/ }).first()).toHaveText(/^\d{2}\/\d{2}\/\d{4} · \d+$/)
      const row = page.getByRole('listitem').filter({ hasText: 'מינוס 1' }).first()
      await expect(row).toContainText(/\b\d{2}:\d{2}\b/)
      await row.getByRole('button', { name: 'מחיקת הנוכחות לצמיתות' }).click()
      await expect(page.getByRole('dialog')).toContainText(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)
      await page.getByRole('dialog').getByRole('button', { name: 'סגירה' }).click() // close without deleting
      await noOtherFormat('history')

      // a date that is half typed: the list does not follow it and the export waits (it would use the last good range, and
      // the file would not match what the field says). Both are back when the date is finished.
      const original = await from.inputValue()
      const listed = await page.getByRole('listitem').count()
      await from.press('End')
      for (let i = 0; i < 6; i++) await from.press('Backspace')
      await expect(from).toHaveValue(/^\d{2}$/)
      await expect(page.getByRole('button', { name: 'ייצוא ל-Excel' })).toBeDisabled()
      await expect(page.getByRole('link', { name: 'ייצוא ל-Excel' })).toHaveCount(0)
      await page.waitForTimeout(600) // longer than the pause before a query: the list must not have followed half a date
      expect(await page.getByRole('listitem').count()).toBe(listed)
      await from.pressSequentially(original.replace(/\D/g, '').slice(2))
      await expect(from).toHaveValue(original)
      await expect(page.getByRole('link', { name: 'ייצוא ל-Excel' })).toBeVisible()

      // typing a whole date: the slashes come by themselves
      await from.fill('')
      await from.pressSequentially('01012026')
      await expect(from).toHaveValue('01/01/2026')
      // deleting a slash deletes the digit before it, and the cursor stays by it
      await from.fill('')
      await from.pressSequentially('01102026')
      await from.press('Home')
      for (let i = 0; i < 3; i++) await from.press('ArrowRight')
      await from.press('Backspace')
      await expect(from).toHaveValue('01/02/026')
      expect(await from.evaluate((el) => el.selectionStart)).toBe(1)
      await from.fill('')
      await from.pressSequentially('01012026')
      await to.fill('')
      await to.pressSequentially('3102')
      await expect(to).toHaveValue('31/02')
      await to.pressSequentially('2026')
      await expect(to).toHaveValue('31/02/2026')
      await expect(to).toHaveAttribute('aria-invalid', 'true') // there is no 31 February
      await to.fill('')
      await to.pressSequentially('15112026')
      await expect(to).toHaveValue('15/11/2026')
      await expect(to).not.toHaveAttribute('aria-invalid', 'true')
    } finally {
      await phone.dispose()
      await page.request.delete(`/api/admin/api-keys/${key.id}`)
    }
  })

  test('the committee file has DD/MM/YYYY dates, with the exact moment in UTC beside the building time', async ({ page, playwright }) => {
    await adminSignIn(page)
    // a visit to export: every test starts with an empty history
    const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
    try {
      const providers = (await (await phone.get('/api/public/providers')).json()).providers
      const ploni = providers.find((p) => p.contact_name === PEOPLE.ploni.name)
      const session = await (await phone.post('/api/session', { data: { provider_id: ploni.id, password: PEOPLE.ploni.password } })).json()
      const visit = await phone.post('/api/scan', { headers: { authorization: `Bearer ${session.token}` }, data: { id: randomUUID(), code: POINTS.basement, gps: null } })
      expect((await visit.json()).scan.outcome).toBe('accepted')
    } finally {
      await phone.dispose()
    }
    const csv = await (await page.request.get('/api/admin/scans?format=csv&outcome=all&include_voided=true')).text()
    const lines = csv.replace('\ufeff', '').trim().split('\r\n')
    expect(lines.length, 'a header and at least the visit').toBeGreaterThan(1)
    expect(lines[0].split(',').slice(0, 4)).toEqual(['id', 'checked_in_utc', 'checked_in_local', 'local_date'])
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/,\d{2}\/\d{2}\/\d{4} \d{2}:\d{2},\d{2}\/\d{2}\/\d{4} \d{2}:\d{2},\d{2}\/\d{2}\/\d{4},/)
    }
  })
})

// ---- the audit log -------------------------------------------------------------------------------------------------
// A section at the foot of the Committee tab, opened by the button "יומן פעולות" (it is not a tab of its own: six tabs do not fit
// the phone's bar at 360 px without wrapping a label). Read only, so there are no row actions to measure: the order of the
// actions of every tile is still measured by the test above, for the five screens that have tiles.

test('the audit log opens from the Committee tab, lists what was done and by whom, filters, and has no actions, on a phone and on a computer', async ({ page }) => {
  await adminSignIn(page)
  const tag = randomUUID().slice(0, 6)
  const name = `נקודת יומן ${tag}`
  const me = (await (await page.request.get('/api/admin/me')).json()).admin
  // A throwaway point that is created, switched off and on again: three entries of the committee's own, with the point's name.
  const created = await page.request.post('/api/admin/points', { data: { name, lat: SAMPLE_POINT.lat, lng: SAMPLE_POINT.lng, gps_mode: 'none' } })
  const point = (await created.json()).point
  try {
    expect((await page.request.patch(`/api/admin/points/${point.id}`, { data: { is_active: false } })).ok()).toBe(true)
    expect((await page.request.patch(`/api/admin/points/${point.id}`, { data: { is_active: true } })).ok()).toBe(true)

    for (const size of [null, COMPUTER]) {
      if (size) await page.setViewportSize(size)
      const where = size ? 'computer' : 'phone'
      // from another tab, so that the Committee tab opens with its section closed again
      await page.goto('/admin#points')
      await loaded(page, 'נקודות סריקה')
      await page.goto('/admin#committee')
      await loaded(page, 'חברי הוועד')

      // closed at first: a button, no log
      const opener = page.getByRole('button', { name: 'יומן פעולות', exact: true })
      await expect(opener).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByLabel('סוג פעולה')).toHaveCount(0)
      await opener.click()
      await expect(opener).toHaveAttribute('aria-expanded', 'true')

      const log = page.getByRole('region', { name: 'יומן פעולות' })
      const rowsOfPoint = log.getByRole('listitem').filter({ hasText: name })
      await expect(rowsOfPoint).toHaveCount(3) // created, switched off, switched on
      // what the actions were, in words: the switch off and the switch on say from what to what
      await expect(rowsOfPoint.filter({ hasText: 'יצירת נקודה' })).toHaveCount(1)
      await expect(rowsOfPoint.filter({ hasText: 'עדכון נקודה' }).filter({ hasText: 'פעיל: כן ← לא' })).toHaveCount(1)
      await expect(rowsOfPoint.filter({ hasText: 'עדכון נקודה' }).filter({ hasText: 'פעיל: לא ← כן' })).toHaveCount(1)
      // by whom: the signed-in member, and the time of the building
      for (const row of await rowsOfPoint.all()) {
        await expect(row).toContainText(`על ידי ${me.name}`)
        await expect(row).toContainText(/\d{2}:\d{2}/)
      }
      await expect(log.getByRole('heading', { level: 3 }).filter({ hasText: /^\d{2}\/\d{2}\/\d{4} · \d+$/ }).first()).toBeVisible()

      // read only: no action on any row, and no file
      for (const row of await log.getByRole('listitem').all()) {
        await expect(row.getByRole('button'), `${where}: an action on a row`).toHaveCount(0)
        await expect(row.getByRole('link'), `${where}: a link on a row`).toHaveCount(0)
      }
      await expect(log.getByRole('link', { name: /ייצוא/ })).toHaveCount(0)
      await expect(log.getByRole('button', { name: /ייצוא/ })).toHaveCount(0)

      // the group: the entries of another group leave, and come back with their own
      await log.getByLabel('סוג פעולה').selectOption({ label: 'נותני שירות' })
      await expect(rowsOfPoint).toHaveCount(0)
      await log.getByLabel('סוג פעולה').selectOption({ label: 'נקודות' })
      await expect(rowsOfPoint).toHaveCount(3)
      // the member: the entries of the signed-in member are these
      await log.getByLabel('חבר ועד').selectOption({ label: me.name })
      await expect(rowsOfPoint).toHaveCount(3)
      await log.getByLabel('חבר ועד').selectOption({ label: 'כל החברים' })

      // a stretch of time in which nothing was done: its own empty state
      const from = log.getByLabel('מתאריך')
      const until = log.getByLabel('עד תאריך')
      await from.fill('')
      await from.pressSequentially('01012020')
      await until.fill('')
      await until.pressSequentially('02012020')
      await expect(page.getByRole('heading', { level: 2, name: 'אין פעולות בטווח הזה' })).toBeVisible()
      expect(await noHorizontalScroll(page), `the audit log at ${where} width`).toBe(true)

      // closed again with the same button
      await opener.click()
      await expect(opener).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByLabel('סוג פעולה')).toHaveCount(0)
    }
  } finally {
    await page.request.delete(`/api/admin/points/${point.id}`, { data: {} })
  }
})
