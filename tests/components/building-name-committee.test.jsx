// @vitest-environment jsdom
// The building's name in the committee app. The Committee tab saves it together with the address ("פרטי הבניין"), and the committee
// app shows it as its brand (the side rail of a computer and the top bar of a phone), in the title of the window and on the sign-in
// screen. The real AdminApp, with the network (`api`) answered by the test like the server: the committee's own route
// (`/admin/building`), the public one (`/public/building`) and a PUT that keeps what it was given.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import AdminApp from '../../src/pages/AdminApp.jsx'
import { api } from '../../src/api/client.js'
import { BUILDING_NAME_MAX_LENGTH } from '../../shared/contract.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const ADMIN = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Sample Member', email: 'member@example.test' }
const ADDRESS = 'רחוב הדוגמה 1, עיר לדוגמה'
const NAME = 'בניין הדוגמה'
const APP = 'נוכחות בבניין' // what the committee app is called when the building has no name
const LONG = `${'בניין הדוגמה '.repeat(7)}`.slice(0, BUILDING_NAME_MAX_LENGTH).trim() // 80 characters at most, with spaces

window.scrollTo = vi.fn() // the shell scrolls to the top on a tab change; jsdom has no scrolling

/** What the server has and what it will answer. A test changes it before it renders the app. */
const server = { signedIn: true, stored: { address: ADDRESS, name: NAME }, publicName: NAME, puts: [], putFails: null, adminBuildingFails: false, publicFails: false }

beforeEach(() => {
  Object.assign(server, { signedIn: true, stored: { address: ADDRESS, name: NAME }, publicName: NAME, puts: [], putFails: null, adminBuildingFails: false, publicFails: false })
  window.history.replaceState(null, '', '/#committee')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
  document.title = ''
  vi.clearAllMocks()
})

const refusal = (field, code = 'invalid_field') => Object.assign(new Error(code), { status: 400, code, extra: { code, message: code, field } })

function answerLikeTheServer() {
  api.mockImplementation(async (path, options = {}) => {
    if (path === '/admin/config') return { google_client_id: '', dev_login: false }
    if (path === '/admin/me') {
      if (!server.signedIn) throw Object.assign(new Error('no session'), { status: 401, code: 'admin_required' })
      return { admin: ADMIN }
    }
    if (path === '/public/building') {
      if (server.publicFails) throw Object.assign(new Error('offline'), { status: 0, code: 'network' })
      return { building: { address: server.stored.address, name: server.publicName } }
    }
    if (path === '/admin/building' && options.method === 'PUT') {
      server.puts.push(options.body)
      if (server.putFails) throw server.putFails
      server.stored = { address: options.body.address, name: options.body.name ?? server.stored.name }
      return { building: { ...server.stored } }
    }
    if (path === '/admin/building') {
      if (server.adminBuildingFails) throw Object.assign(new Error('boom'), { status: 500, code: 'server_error' })
      return { building: { ...server.stored } }
    }
    if (path === '/admin/admins') return { admins: [] }
    if (path === '/admin/points') return { points: [] }
    if (path === '/admin/providers') return { providers: [] }
    if (path.startsWith('/admin/scans')) return { scans: [], next_cursor: null }
    if (path === '/admin/api-keys') return { api_keys: [] }
    throw new Error(`the test does not expect ${path}`)
  })
}

const start = () => render(<AdminApp />)
const card = async () => within(await screen.findByRole('region', { name: 'פרטי הבניין' }))
const nameField = (c) => c.getByLabelText('שם הבניין', { exact: true })
const addressField = (c) => c.getByLabelText('כתובת הבניין', { exact: true })
const type = (field, value) => fireEvent.change(field, { target: { value } })
const save = (c) => fireEvent.click(c.getByRole('button', { name: 'שמירה' }))
// The brand is in the side rail (the complementary region) and in the top bar of a phone (the banner): CSS shows one of them.
const brands = async () => [within(await screen.findByRole('complementary')), within(await screen.findByRole('banner'))]
const calls = (path, method) => api.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method)

describe('the card in the Committee tab', () => {
  it('has a name field before the address field, both filled with what the server has, and each typed in any language', async () => {
    answerLikeTheServer()
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    expect(addressField(c).value).toBe(ADDRESS)
    const fields = c.getAllByRole('textbox')
    expect(fields).toEqual([nameField(c), addressField(c)]) // the name first
    expect(nameField(c).getAttribute('dir')).toBe('auto')
    expect(addressField(c).getAttribute('dir')).toBe('auto')
    expect(nameField(c).getAttribute('maxlength')).toBe(String(BUILDING_NAME_MAX_LENGTH))
    expect(c.getByRole('heading', { level: 2, name: 'פרטי הבניין' })).toBeTruthy() // the title of the card did not change
    expect(c.getByText(/השם מופיע בראש שתי האפליקציות/)).toBeTruthy() // a short hint
    expect(nameField(c).getAttribute('aria-describedby')).toBeTruthy() // the hint is tied to the field
  })

  it('has nothing to save until something changes, and a change of spaces alone is not one', async () => {
    answerLikeTheServer()
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    expect(c.getByRole('button', { name: 'שמירה' }).disabled).toBe(true)
    type(nameField(c), `  ${NAME}  `)
    expect(c.getByRole('button', { name: 'שמירה' }).disabled).toBe(true)
    type(nameField(c), 'בניין אחר')
    expect(c.getByRole('button', { name: 'שמירה' }).disabled).toBe(false)
  })

  it('saves the name and the address together, with one button, and says so', async () => {
    answerLikeTheServer()
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    type(nameField(c), '  מגדל הבדיקה  ')
    type(addressField(c), 'רחוב הבדיקה 2, עיר אחרת')
    save(c)
    expect(await screen.findByText('פרטי הבניין נשמרו')).toBeTruthy()
    expect(server.puts).toEqual([{ address: 'רחוב הבדיקה 2, עיר אחרת', name: 'מגדל הבדיקה' }]) // one request, both fields, trimmed
    expect(nameField(c).value).toBe('מגדל הבדיקה')
    expect(addressField(c).value).toBe('רחוב הבדיקה 2, עיר אחרת')
    expect(c.getByRole('button', { name: 'שמירה' }).disabled).toBe(true)
  })

  it('sends the name that is saved along with an address that changed alone, and says it is the address', async () => {
    answerLikeTheServer()
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    type(addressField(c), 'רחוב הבדיקה 3')
    save(c)
    expect(await screen.findByText('כתובת הבניין נשמרה')).toBeTruthy()
    expect(server.puts).toEqual([{ address: 'רחוב הבדיקה 3', name: NAME }])
  })

  it('saves a name alone, and clearing it says the name is removed (the address is kept)', async () => {
    answerLikeTheServer()
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    type(nameField(c), 'מגדל הבדיקה')
    save(c)
    expect(await screen.findByText('שם הבניין נשמר')).toBeTruthy()
    expect(server.puts.at(-1)).toEqual({ address: ADDRESS, name: 'מגדל הבדיקה' })

    type(nameField(c), '')
    save(c)
    expect(await screen.findByText('שם הבניין הוסר')).toBeTruthy()
    expect(server.puts.at(-1)).toEqual({ address: ADDRESS, name: '' })
    expect(nameField(c).value).toBe('')
  })

  it('still says the address is removed when only the address was cleared', async () => {
    answerLikeTheServer()
    start()
    const c = await card()
    await waitFor(() => expect(addressField(c).value).toBe(ADDRESS))
    type(addressField(c), '')
    save(c)
    expect(await screen.findByText('כתובת הבניין הוסרה')).toBeTruthy()
    expect(server.puts).toEqual([{ address: '', name: NAME }])
  })

  it('shows a refusal of the name by the server under the name field, with no toast, and keeps what was typed', async () => {
    answerLikeTheServer()
    server.putFails = refusal('name')
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    type(nameField(c), 'שם שהשרת לא מקבל')
    save(c)
    const alert = await c.findByRole('alert')
    expect(alert.textContent).toContain('השם לא נשמר')
    expect(nameField(c).getAttribute('aria-invalid')).toBe('true')
    expect(nameField(c).getAttribute('aria-describedby')).toContain(alert.id)
    expect(addressField(c).getAttribute('aria-invalid')).toBeNull() // the address is not blamed
    expect(nameField(c).value).toBe('שם שהשרת לא מקבל')
    expect(screen.queryByText('אחד הערכים לא תקין.')).toBeNull() // the usual toast is not added on top
    expect(screen.queryByText('פרטי הבניין נשמרו')).toBeNull()
    expect(screen.queryByText('שם הבניין נשמר')).toBeNull()
    // typing takes the message away, and the button can try again
    type(nameField(c), 'שם אחר')
    expect(c.queryByRole('alert')).toBeNull()
    expect(c.getByRole('button', { name: 'שמירה' }).disabled).toBe(false)
  })

  it('shows a refusal of the address by the server under the address field', async () => {
    answerLikeTheServer()
    server.putFails = refusal('address')
    start()
    const c = await card()
    await waitFor(() => expect(addressField(c).value).toBe(ADDRESS))
    type(addressField(c), 'כתובת אחרת')
    save(c)
    const alert = await c.findByRole('alert')
    expect(alert.textContent).toContain('הכתובת לא נשמרה')
    expect(addressField(c).getAttribute('aria-invalid')).toBe('true')
    expect(nameField(c).getAttribute('aria-invalid')).toBeNull()
  })

  it('tells any other failure with the usual toast, and no field is blamed', async () => {
    answerLikeTheServer()
    for (const failure of [Object.assign(new Error('boom'), { status: 500, code: 'server_error' }), refusal('something_else'), refusal('name', 'missing_field')]) {
      server.putFails = failure
      const view = start()
      const c = await card()
      await waitFor(() => expect(nameField(c).value).toBe(NAME))
      type(nameField(c), 'שם אחר')
      save(c)
      expect((await screen.findAllByRole('alert')).some((a) => a.textContent.includes('משהו השתבש') || a.textContent.includes('אחד הערכים לא תקין') || a.textContent.includes('חסר שדה חובה')), String(failure.code)).toBe(true)
      expect(nameField(c).getAttribute('aria-invalid'), String(failure.code)).toBeNull()
      view.unmount()
    }
  })

  it('does not send a name with a line break, a tab or another control character, and says so under the name field', async () => {
    answerLikeTheServer()
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    type(nameField(c), 'בניין\tהדוגמה')
    save(c)
    expect((await c.findByRole('alert')).textContent).toContain('השם מכיל תווים שאי אפשר לשמור')
    expect(server.puts).toEqual([])
    type(nameField(c), 'בניין הדוגמה 2')
    expect(c.queryByRole('alert')).toBeNull()
  })

  it('reads a server that sends no name (from before names existed) as an empty name field', async () => {
    answerLikeTheServer()
    api.mockImplementation(((original) => async (path, options) => (path === '/admin/building' && !options?.method ? { building: { address: ADDRESS } } : original(path, options)))(api.getMockImplementation()))
    start()
    const c = await card()
    await waitFor(() => expect(addressField(c).value).toBe(ADDRESS))
    expect(nameField(c).value).toBe('')
  })
})

describe('the brand of the committee app', () => {
  it('is the name of the building in the side rail and in the top bar, and the end of the title of the window', async () => {
    answerLikeTheServer()
    start()
    for (const place of await brands()) expect(await place.findByText(NAME)).toBeTruthy()
    for (const place of await brands()) expect(place.queryByText(APP)).toBeNull()
    await waitFor(() => expect(document.title).toBe(`ועד · ${NAME}`))
  })

  it('is the name of the app when the building has no name, in both places and in the title', async () => {
    answerLikeTheServer()
    server.stored.name = ''
    server.publicName = ''
    start()
    await waitFor(() => expect(calls('/admin/building', 'GET').length).toBeGreaterThan(0))
    for (const place of await brands()) expect(await place.findByText(APP)).toBeTruthy()
    await waitFor(() => expect(document.title).toBe(`ועד · ${APP}`))
  })

  it('shows the whole of a name of 80 characters (a long one is shortened by the stylesheet, not by the script), laid out by its own script', async () => {
    answerLikeTheServer()
    server.stored.name = LONG
    server.publicName = LONG
    start()
    expect(LONG.length).toBeLessThanOrEqual(BUILDING_NAME_MAX_LENGTH)
    for (const place of await brands()) {
      const text = await place.findByText(LONG)
      expect(text.getAttribute('dir')).toBe('auto')
    }
    await waitFor(() => expect(document.title).toBe(`ועד · ${LONG}`))
  })

  it('asks the committee\'s own route once somebody is signed in, and the title follows the tab', async () => {
    answerLikeTheServer()
    start()
    await waitFor(() => expect(document.title).toBe(`ועד · ${NAME}`))
    expect(calls('/admin/building', 'GET').length).toBeGreaterThan(0)
    window.location.hash = '#points'
    await waitFor(() => expect(document.title).toBe(`נקודות · ${NAME}`))
  })

  it('follows a save in the Committee tab at once, with no reload: a new name, then a cleared one', async () => {
    answerLikeTheServer()
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    const asked = calls('/admin/building', 'GET').length

    type(nameField(c), 'מגדל הבדיקה')
    save(c)
    expect(await screen.findByText('שם הבניין נשמר')).toBeTruthy()
    for (const place of await brands()) expect(await place.findByText('מגדל הבדיקה')).toBeTruthy()
    expect(document.title).toBe('ועד · מגדל הבדיקה')

    type(nameField(c), '')
    save(c)
    expect(await screen.findByText('שם הבניין הוסר')).toBeTruthy()
    for (const place of await brands()) expect(await place.findByText(APP)).toBeTruthy()
    expect(document.title).toBe(`ועד · ${APP}`)
    expect(calls('/admin/building', 'GET').length).toBe(asked) // what the server answered to the save was used: nothing was asked again
  })

  it('does not scroll or move the focus when the name arrives: only a change of tab does', async () => {
    answerLikeTheServer()
    start()
    await waitFor(() => expect(document.title).toBe(`ועד · ${NAME}`))
    const scrolled = window.scrollTo.mock.calls.length
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    type(nameField(c), 'מגדל הבדיקה')
    save(c)
    await screen.findByText('שם הבניין נשמר')
    expect(window.scrollTo.mock.calls.length).toBe(scrolled)
  })

  it('shows what the public route says until the committee\'s own route answers, so a reload does not flash the plain brand', async () => {
    answerLikeTheServer()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const answer = api.getMockImplementation()
    api.mockImplementation(async (path, options) => (path === '/admin/building' && !options?.method ? (await gate, answer(path, options)) : answer(path, options)))
    start()
    for (const place of await brands()) expect(await place.findByText(NAME)).toBeTruthy() // from the public route, the committee's is still waiting
    release()
    await waitFor(() => expect(calls('/admin/building', 'GET').length).toBeGreaterThan(0))
  })

  it('takes the committee\'s own answer over an older public one that arrives after it', async () => {
    answerLikeTheServer()
    server.stored.name = 'שם עדכני'
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const answer = api.getMockImplementation()
    api.mockImplementation(async (path, options) => (path === '/public/building' ? (await gate, { building: { address: ADDRESS, name: 'שם ישן מה-CDN' } }) : answer(path, options)))
    start()
    for (const place of await brands()) expect(await place.findByText('שם עדכני')).toBeTruthy()
    release() // the public answer comes last, and says an older name
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const place of await brands()) {
      expect(place.queryByText('שם ישן מה-CDN')).toBeNull()
      expect(place.getByText('שם עדכני')).toBeTruthy()
    }
    expect(document.title).toBe('ועד · שם עדכני')
  })

  it('keeps a saved name when a read of the committee\'s route that started before the save answers after it', async () => {
    answerLikeTheServer()
    const answer = api.getMockImplementation()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let reads = 0
    api.mockImplementation(async (path, options) => {
      // The Committee tab's own read answers at once; the shell's (the second read) is slow, and says what the server had
      // when it was asked, the name from before the save.
      if (path === '/admin/building' && !options?.method && ++reads === 2) {
        const asked = { ...server.stored }
        await gate
        return { building: asked }
      }
      return answer(path, options)
    })
    start()
    const c = await card()
    await waitFor(() => expect(nameField(c).value).toBe(NAME))
    type(nameField(c), 'מגדל הבדיקה')
    save(c)
    expect(await screen.findByText('שם הבניין נשמר')).toBeTruthy()
    release() // the slow read comes back now, with the old name
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reads).toBe(2)
    for (const place of await brands()) {
      expect(place.queryByText(NAME)).toBeNull()
      expect(place.getByText('מגדל הבדיקה')).toBeTruthy()
    }
    expect(document.title).toBe('ועד · מגדל הבדיקה')
  })

  it('stays as it is when a route fails: the public name if only the committee\'s route fails, the plain brand if both do', async () => {
    answerLikeTheServer()
    server.adminBuildingFails = true
    const first = start()
    for (const place of await brands()) expect(await place.findByText(NAME)).toBeTruthy()
    first.unmount()

    server.publicFails = true
    start()
    await waitFor(() => expect(calls('/admin/building', 'GET').length).toBeGreaterThan(1))
    for (const place of await brands()) expect(await place.findByText(APP)).toBeTruthy()
    await waitFor(() => expect(document.title).toBe(`ועד · ${APP}`))
  })

  it('asks the public route even when somebody is already signed in, and nothing breaks when it answers without a name', async () => {
    answerLikeTheServer()
    server.publicName = undefined // an answer from a server of before names
    server.stored.name = ''
    start()
    await waitFor(() => expect(calls('/public/building', 'GET')).toHaveLength(1))
    for (const place of await brands()) expect(await place.findByText(APP)).toBeTruthy()
  })
})

describe('the sign-in screen of the committee app', () => {
  const heading = () => screen.findByRole('heading', { level: 1, name: 'ניהול נוכחות הבניין' })

  it('shows the name of the building under the title when the public route has one', async () => {
    answerLikeTheServer()
    server.signedIn = false
    start()
    const title = await heading()
    expect(await screen.findByText(NAME)).toBeTruthy()
    expect(title.nextElementSibling.textContent).toBe(NAME) // right under the title, before the line that says who may sign in
    expect(title.nextElementSibling.getAttribute('dir')).toBe('auto')
    expect(title.nextElementSibling.nextElementSibling.textContent).toContain('כניסה לוועד הבית בלבד')
  })

  it('shows the whole of a name of 80 characters, and no name line at all when there is none', async () => {
    answerLikeTheServer()
    server.signedIn = false
    server.publicName = LONG
    const first = start()
    expect(await screen.findByText(LONG)).toBeTruthy()
    first.unmount()

    server.publicName = ''
    start()
    const title = await heading()
    await waitFor(() => expect(calls('/public/building', 'GET')).toHaveLength(2)) // the second answer has come
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(title.nextElementSibling.textContent).toContain('כניסה לוועד הבית בלבד') // nothing between the title and the line under it
  })

  it('looks the same as before when the public route fails: no name line, the sign-in still works', async () => {
    answerLikeTheServer()
    server.signedIn = false
    server.publicFails = true
    start()
    const title = await heading()
    await waitFor(() => expect(calls('/public/building', 'GET')).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(title.nextElementSibling.textContent).toContain('כניסה לוועד הבית בלבד')
  })

  it('does not ask the committee\'s own route before anybody is signed in', async () => {
    answerLikeTheServer()
    server.signedIn = false
    start()
    await heading()
    await screen.findByText(NAME)
    expect(calls('/admin/building', 'GET')).toHaveLength(0)
  })

  it('writes the name of the building in the title of the window, before the name of the app', async () => {
    answerLikeTheServer()
    server.signedIn = false
    start()
    await heading()
    await waitFor(() => expect(document.title).toBe(`${NAME} · ${APP}`))
  })

  it('writes only the name of the app in the title of the window when the building has no name', async () => {
    answerLikeTheServer()
    server.signedIn = false
    server.publicName = ''
    start()
    await heading()
    await waitFor(() => expect(calls('/public/building', 'GET')).toHaveLength(1))
    await waitFor(() => expect(document.title).toBe(APP))
  })
})
