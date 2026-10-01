// The committee screens on a phone and on a computer: the same icons, nothing spilling off the screen, and deleting.
import { randomUUID } from 'node:crypto'
import { test, expect, he, PEOPLE, POINTS, FAR, adminSignIn, clearScans, allowConsoleErrors } from './fixtures.js'

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
  // Lior signs in on a phone (a connected device) and makes one visit that is accepted and one that is refused as too far
  const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
  try {
    const providers = (await (await phone.get('/api/public/providers')).json()).providers
    const lior = providers.find((p) => p.contact_name === PEOPLE.lior.name)
    const session = await (await phone.post('/api/session', { data: { provider_id: lior.id, password: PEOPLE.lior.password } })).json()
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
    const withPhones = await page.getByRole('button', { name: 'ניתוק מכשירים' }).count()
    expect(withPhones, 'some providers have a phone signed in').toBeGreaterThan(0)
    expect(withPhones, 'and some do not').toBeLessThan(editEdges.length)

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
  const OTHER_FORMATS = /\d{1,2}\s*ב?(ינו|פבר|מרץ|אפר|מאי|יוני|יולי|אוג|ספט|אוק|נוב|דצמ)|יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|\d{4}-\d{2}-\d{2}|\b[AP]M\b/i

  test('every date and time is DD/MM/YYYY and HH:MM, and the date fields read the same on an English device', async ({ page, playwright }) => {
    await adminSignIn(page)
    const tag = randomUUID().slice(0, 6)
    const key = (await (await page.request.post('/api/admin/api-keys', { data: { name: `מפתח ${tag}` } })).json()).api_key
    // Lior makes a visit, so there is a "last visit" for him and a row in the history
    const phone = await playwright.request.newContext({ baseURL: page.url().split('/admin')[0] })
    try {
      const providers = (await (await phone.get('/api/public/providers')).json()).providers
      const lior = providers.find((p) => p.contact_name === PEOPLE.lior.name)
      const session = await (await phone.post('/api/session', { data: { provider_id: lior.id, password: PEOPLE.lior.password } })).json()
      const visit = await phone.post('/api/scan', { headers: { authorization: `Bearer ${session.token}` }, data: { id: randomUUID(), code: POINTS.basement, gps: null } })
      expect((await visit.json()).scan.outcome).toBe('accepted')

      const noOtherFormat = async (what) => {
        const text = await page.getByRole('main').innerText()
        expect(text, `${what}: another way of writing a date`).not.toMatch(OTHER_FORMATS)
      }

      // providers: the last visit
      await page.goto('/admin#providers')
      await loaded(page, 'נותני שירות')
      const liorCard = page.getByRole('article').filter({ hasText: PEOPLE.lior.name })
      await expect(liorCard.locator('dd').nth(0)).toHaveText(DAY_TIME) // "last visit"
      await noOtherFormat('providers')

      // committee: the last sign-in of the member who is signed in now
      await page.goto('/admin#committee')
      await loaded(page, 'חברי הוועד')
      await expect(page.getByRole('article').first().locator('dd').first()).toHaveText(DAY_TIME)
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

      // typing a date: the slashes come by themselves, and half a date does not change the list
      await from.fill('')
      await from.pressSequentially('01012026')
      await expect(from).toHaveValue('01/01/2026')
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

  test('the committee file has DD/MM/YYYY dates and no UTC column', async ({ page }) => {
    await adminSignIn(page)
    const csv = await (await page.request.get('/api/admin/scans?format=csv&outcome=all&include_voided=true')).text()
    const lines = csv.replace('\ufeff', '').trim().split('\r\n')
    expect(lines[0].split(',').slice(0, 3)).toEqual(['id', 'checked_in_local', 'local_date'])
    for (const line of lines.slice(1)) expect(line).toMatch(/,\d{2}\/\d{2}\/\d{4} \d{2}:\d{2},\d{2}\/\d{2}\/\d{4},/)
  })
})
