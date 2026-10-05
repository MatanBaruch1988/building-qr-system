// @vitest-environment jsdom
// The committee's Providers tab, in what it says about each provider's phones (ADR 0007, decision 4, "Phone health"): the real
// ProvidersView, with the network (`api`) answered by the test. The card shows how many visits wait on the phones and since when,
// a warning when the oldest one has waited more than 24 hours, and a note when a phone runs an older version of the app. The
// button "מכשירים" opens a dialog that lists the active phones from GET /api/admin/providers/:id/devices, read only, with the way
// to sign them all out at its bottom.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import ProvidersView from '../../src/admin/views/ProvidersView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const NOW = '2026-10-05T10:00:00.000Z' // 13:00 in the building (UTC+3 on that day)
const MIN = 60 * 1000
const HOUR = 60 * MIN
const agoIso = (ms) => new Date(Date.parse(NOW) - ms).toISOString()

let nextId = 1
/** One provider as GET /api/admin/providers writes it, with no phone health to show; `over` changes what a test is about. */
const provider = (over = {}) => ({
  id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, company: 'ניקיון', contact_name: 'פלוני', service_type: 'cleaning',
  is_active: true, is_demo: false, created_at: '2026-09-01T08:00:00.000Z', has_password: true, active_devices: 1, last_scan_at: null,
  scan_count: 0, waiting: 0, oldest_waiting_at: null, outdated_devices: 0, ...over,
})
/** One phone as GET /api/admin/providers/:id/devices writes it: a phone that reported everything. */
const phone = (over = {}) => ({
  id: `11111111-1111-4111-8111-${String(nextId++).padStart(12, '0')}`, created_at: '2026-09-20T05:05:00.000Z', last_seen_at: '2026-10-05T09:41:00.000Z',
  status_at: '2026-10-05T09:30:00.000Z', last_sync_at: '2026-10-04T18:15:00.000Z', app_build: 'abcdef1', waiting_count: 4,
  oldest_waiting_at: '2026-10-04T05:00:00.000Z', not_accepted_total: 2, overflow_total: 1, outdated: false, ...over,
})
/** A phone that never reported (an old version of the app never does): every reported field is empty. */
const silentPhone = (over = {}) => phone({
  status_at: null, app_build: null, waiting_count: null, oldest_waiting_at: null, not_accepted_total: 0, overflow_total: 0, last_sync_at: null, ...over,
})

/** What the server answers, by path. `devices` maps a provider id to its phones, or to an Error for a call that fails. */
function server({ providers, devices = {} }) {
  api.mockImplementation(async (path, options) => {
    if (path === '/admin/providers') return { providers }
    const list = path.match(/^\/admin\/providers\/([^/]+)\/devices$/)
    if (list) {
      const answer = devices[list[1]] ?? []
      if (answer instanceof Error) throw answer
      return { devices: answer }
    }
    if (/^\/admin\/providers\/[^/]+\/revoke-devices$/.test(path) && options?.method === 'POST') return { revoked: 1 }
    throw new Error(`the test does not expect ${path}`)
  })
}
const calls = (pattern) => api.mock.calls.filter(([path]) => pattern.test(path))
const failure = () => Object.assign(new Error('x'), { code: 'network' })

function show() {
  return render(<ToastProvider><ConfirmProvider><ProvidersView /></ConfirmProvider></ToastProvider>)
}
const WAIT = { timeout: 4000 }
const card = (name) => screen.getByRole('heading', { level: 2, name }).closest('article')
/** The text of the value (dd) that follows a label (dt) inside `scope`. */
const fact = (scope, label) => within(scope).getByText(label, { selector: 'dt' }).nextElementSibling
const opensPhones = (article) => fireEvent.click(within(article).getByRole('button', { name: 'מכשירים', exact: true }))
const phonesDialog = (name = 'מכשירים: פלוני') => screen.findByRole('dialog', { name }, WAIT)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  nextId = 1
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the card: visits that wait on the phones', () => {
  it('says how many wait and since when, as DD/MM/YYYY HH:MM in the building\'s time', async () => {
    server({ providers: [provider({ waiting: 3, oldest_waiting_at: '2026-10-05T07:30:00.000Z' })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    expect(fact(card('פלוני'), 'ממתינות בטלפון').textContent).toBe('3, מאז 05/10/2026 10:30')
  })

  it('says only the number when no time could be believed', async () => {
    server({ providers: [provider({ waiting: 5, oldest_waiting_at: null })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    expect(fact(card('פלוני'), 'ממתינות בטלפון').textContent).toBe('5')
  })

  it('has no such line when nothing waits, or when the server says nothing about it (an older server)', async () => {
    const older = provider({ company: 'גינון', contact_name: 'אלמוני' })
    delete older.waiting
    delete older.oldest_waiting_at
    delete older.outdated_devices
    server({ providers: [provider({ waiting: 0 }), older] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'אלמוני' }, WAIT)
    expect(screen.queryByText('ממתינות בטלפון')).toBeNull()
    expect(document.querySelector('.a-badge--warn')).toBeNull()
    expect(screen.queryByText(/גרסה ישנה/)).toBeNull()
  })

  it('keeps the two facts that the card always had', async () => {
    server({ providers: [provider({ waiting: 2, oldest_waiting_at: agoIso(HOUR), active_devices: 3, last_scan_at: '2026-10-05T06:05:00.000Z' })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    expect(fact(card('פלוני'), 'נוכחות אחרונה').textContent).toBe('05/10/2026 09:05')
    expect(fact(card('פלוני'), 'מכשירים מחוברים').textContent).toBe('3')
  })
})

describe('the card: a visit that has waited more than 24 hours', () => {
  const WARNING = 'ממתינות מעל 24 שעות'
  const cardWith = async (oldest, waiting = 2) => {
    server({ providers: [provider({ waiting, oldest_waiting_at: oldest })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    return within(card('פלוני'))
  }

  it('has no warning just under 24 hours', async () => {
    const view = await cardWith(agoIso(24 * HOUR - MIN))
    expect(view.queryByText(WARNING)).toBeNull()
    expect(view.getByText('ממתינות בטלפון')).toBeTruthy() // the line is there, only the warning is not
  })

  it('has no warning at exactly 24 hours, and a warning just over it', async () => {
    expect((await cardWith(agoIso(24 * HOUR))).queryByText(WARNING)).toBeNull()
    cleanup()
    const view = await cardWith(agoIso(24 * HOUR + MIN))
    expect(view.getByText(WARNING)).toBeTruthy()
  })

  it('is the warm warning badge of the app, and not the red one (red is only for deleting)', async () => {
    const view = await cardWith(agoIso(48 * HOUR))
    const badge = view.getByText(WARNING)
    expect(badge.className).toContain('a-badge--warn')
    expect(card('פלוני').querySelector('.a-badge--danger')).toBeNull()
    // the badge is one of the card's badges, in the same row as its state
    expect(badge.parentElement.className).toBe('a-meta')
    expect(within(badge.parentElement).getByText('פעיל')).toBeTruthy()
  })

  it('has no warning when nothing waits, whatever time is left over, and none when no time is known', async () => {
    expect((await cardWith(agoIso(72 * HOUR), 0)).queryByText(WARNING)).toBeNull()
    cleanup()
    expect((await cardWith(null, 4)).queryByText(WARNING)).toBeNull()
  })
})

describe('the card: a phone that runs an older version of the app', () => {
  it('has a small neutral note for one phone, and says how many for more', async () => {
    server({
      providers: [
        provider({ company: 'ניקיון', contact_name: 'פלוני', outdated_devices: 1 }),
        provider({ company: 'גינון', contact_name: 'אלמוני', outdated_devices: 2 }),
        provider({ company: 'תחזוקה', contact_name: 'שלישי', outdated_devices: 0 }),
      ],
    })
    show()
    await screen.findByRole('heading', { level: 2, name: 'שלישי' }, WAIT)
    const one = within(card('פלוני')).getByText('גרסה ישנה במכשיר')
    expect(one.className).toContain('a-badge--neutral')
    expect(one.className).not.toMatch(/--(warn|danger)/)
    expect(within(card('אלמוני')).getByText('גרסה ישנה ב-2 מכשירים').className).toContain('a-badge--neutral')
    expect(within(card('שלישי')).queryByText(/גרסה ישנה/)).toBeNull()
  })
})

describe('the card: its actions', () => {
  it('opens the phones with "מכשירים", which comes before the other actions and is not the sign-out of all phones', async () => {
    server({ providers: [provider({ active_devices: 2 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    const names = within(card('פלוני')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['מכשירים', 'סיסמה חדשה', 'עריכה', 'השבתה', 'מחיקת נותן השירות'])
    expect(screen.queryByRole('button', { name: 'ניתוק מכשירים' })).toBeNull()
  })

  it('has no such button for a provider with no phone signed in (as before)', async () => {
    server({ providers: [provider({ active_devices: 0 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    const names = within(card('פלוני')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['סיסמה חדשה', 'עריכה', 'השבתה', 'מחיקת נותן השירות'])
  })

  it('asks for the phones of that provider only when the dialog is opened', async () => {
    const a = provider({ contact_name: 'פלוני' })
    const b = provider({ company: 'גינון', contact_name: 'אלמוני' })
    server({ providers: [a, b], devices: { [b.id]: [phone()] } })
    show()
    await screen.findByRole('heading', { level: 2, name: 'אלמוני' }, WAIT)
    expect(calls(/devices$/)).toHaveLength(0)
    opensPhones(card('אלמוני'))
    await phonesDialog('מכשירים: אלמוני')
    expect(calls(/devices$/).map(([path]) => path)).toEqual([`/admin/providers/${b.id}/devices`])
  })
})

describe('the phones dialog', () => {
  const open = async (phones, over = {}) => {
    const p = provider({ active_devices: phones.length, ...over })
    server({ providers: [p], devices: { [p.id]: phones } })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    opensPhones(card('פלוני'))
    return { dialog: await phonesDialog(), p }
  }

  it('lists the phones, each with everything that it reported and when the server last heard from it', async () => {
    const { dialog } = await open([phone()])
    const row = await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' }).then((h) => h.closest('li'))
    expect(fact(row, 'התחברות').textContent).toBe('20/09/2026 08:05')
    expect(fact(row, 'דיווח אחרון').textContent).toBe('05/10/2026 12:30')
    expect(fact(row, 'העלאה אחרונה מהתור').textContent).toBe('04/10/2026 21:15')
    expect(fact(row, 'ממתינות בטלפון').textContent).toBe('4, מאז 04/10/2026 08:00')
    expect(fact(row, 'לא נקלטו').textContent).toContain('2')
    expect(fact(row, 'נזרקו כי התור התמלא').textContent).toContain('1')
    expect(fact(row, 'גרסה').textContent).toBe('abcdef1')
    expect(within(row).queryByText('ישנה')).toBeNull()
  })

  it('says that the last contact with the server is accurate to about 5 minutes', async () => {
    const { dialog } = await open([phone()])
    const row = (await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' })).closest('li')
    const contact = fact(row, 'קשר אחרון עם השרת')
    expect(contact.textContent).toBe('05/10/2026 12:41 מדויק עד כ-5 דקות')
    expect(within(contact).getByText('מדויק עד כ-5 דקות')).toBeTruthy()
  })

  it('says "לא מדווח" for a phone that never reported, with the two reasons, and shows what is not known as such', async () => {
    const { dialog } = await open([silentPhone()])
    const row = (await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' })).closest('li')
    expect(within(fact(row, 'דיווח אחרון')).getByText('לא מדווח')).toBeTruthy()
    expect(fact(row, 'דיווח אחרון').textContent).toContain('אפליקציה ישנה, או שעוד לא דיווחה')
    expect(fact(row, 'ממתינות בטלפון').textContent).toBe('-')
    expect(fact(row, 'העלאה אחרונה מהתור').textContent).toBe('עוד לא הייתה')
    expect(fact(row, 'גרסה').textContent).toBe('לא ידועה')
    // what the phone did not report is not guessed: no totals, no badge
    expect(within(row).queryByText('לא נקלטו')).toBeNull()
    expect(within(row).queryByText('נזרקו כי התור התמלא')).toBeNull()
    expect(within(row).queryByText('ישנה')).toBeNull()
    // the server knows these two for every phone
    expect(fact(row, 'התחברות').textContent).toBe('20/09/2026 08:05')
    expect(fact(row, 'קשר אחרון עם השרת').textContent).toContain('05/10/2026 12:41')
  })

  it('shows a phone that reported an empty queue as "אין", and the last upload it made', async () => {
    const { dialog } = await open([phone({ waiting_count: 0, oldest_waiting_at: null, not_accepted_total: 0, overflow_total: 0 })])
    const row = (await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' })).closest('li')
    expect(fact(row, 'ממתינות בטלפון').textContent).toBe('אין')
    expect(fact(row, 'העלאה אחרונה מהתור').textContent).toBe('04/10/2026 21:15')
  })

  it('shows each total only when it is above 0', async () => {
    const { dialog } = await open([phone({ not_accepted_total: 7, overflow_total: 0 }), phone({ not_accepted_total: 0, overflow_total: 9 })])
    const [one, two] = [1, 2].map((n) => within(dialog).getByRole('heading', { level: 3, name: `מכשיר ${n}` }).closest('li'))
    expect(fact(one, 'לא נקלטו').textContent).toContain('7')
    expect(within(one).queryByText('נזרקו כי התור התמלא')).toBeNull()
    expect(within(two).queryByText('לא נקלטו')).toBeNull()
    expect(fact(two, 'נזרקו כי התור התמלא').textContent).toContain('9')
  })

  it('puts a badge "ישנה" by the build of a phone that is outdated, a neutral one, and only there', async () => {
    const { dialog } = await open([phone({ app_build: '1234567', outdated: true }), phone({ app_build: 'abcdef1', outdated: false })])
    const [old, current] = [1, 2].map((n) => within(dialog).getByRole('heading', { level: 3, name: `מכשיר ${n}` }).closest('li'))
    expect(fact(old, 'גרסה').textContent).toBe('1234567 ישנה')
    expect(within(fact(old, 'גרסה')).getByText('ישנה').className).toContain('a-badge--neutral')
    expect(within(current).queryByText('ישנה')).toBeNull()
    expect(dialog.querySelector('.a-badge--danger')).toBeNull()
  })

  it('numbers the phones in the order of the list (the one used last first)', async () => {
    const { dialog } = await open([phone({ app_build: 'aaaaaaa' }), phone({ app_build: 'bbbbbbb' }), phone({ app_build: 'ccccccc' })])
    const builds = [1, 2, 3].map((n) => fact(within(dialog).getByRole('heading', { level: 3, name: `מכשיר ${n}` }).closest('li'), 'גרסה').textContent)
    expect(builds).toEqual(['aaaaaaa', 'bbbbbbb', 'ccccccc'])
  })

  it('writes every date and time as DD/MM/YYYY HH:MM, and no other way', async () => {
    const { dialog } = await open([phone(), silentPhone()])
    await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' })
    const text = dialog.textContent
    const dates = text.match(/\d{2}\/\d{2}\/\d{4}( \d{2}:\d{2})?/g)
    expect(dates).toHaveLength(7) // five from the phone that reported (signed in, report, upload, contact, oldest waiting) and two from the one that did not
    for (const date of dates) expect(date).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/) // no ISO date or time
    expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/) // no seconds
    expect(text).not.toMatch(/\b(GMT|UTC|AM|PM)\b/)
  })

  it('never shows the label of a phone or its token, even if the server were to send them', async () => {
    const leaky = phone({ label: 'Secret Browser String', token_hash: 'a'.repeat(64), token: 'BQR-secret-token' })
    const { dialog } = await open([leaky])
    await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' })
    for (const secret of ['Secret Browser String', 'a'.repeat(64), 'BQR-secret-token']) expect(document.body.textContent).not.toContain(secret)
    expect(document.body.innerHTML).not.toContain('Secret Browser String')
    // and it never asks for them: the request is the list of the provider and nothing else
    expect(calls(/devices/).every(([path]) => /\/devices$/.test(path))).toBe(true)
  })

  it('is read only: the only buttons are closing it and signing all the phones out', async () => {
    const { dialog } = await open([phone(), silentPhone()])
    await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' })
    expect(within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['סגירה', 'ניתוק כל המכשירים'])
    for (const li of within(dialog).getAllByRole('listitem')) expect(within(li).queryAllByRole('button')).toHaveLength(0)
  })

  it('has a list that a keyboard can reach, because the body of the dialog scrolls and holds nothing else to focus', async () => {
    const { dialog } = await open([phone(), silentPhone()])
    const list = await within(dialog).findByRole('list', { name: 'המכשירים המחוברים' })
    expect(list.tabIndex).toBe(0)
    expect(list.querySelectorAll('li')).toHaveLength(2)
  })

  it('has "ניתוק כל המכשירים" at its bottom, in the footer under the list', async () => {
    const { dialog } = await open([phone()])
    await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' })
    const button = within(dialog).getByRole('button', { name: 'ניתוק כל המכשירים' })
    expect(button.parentElement.className).toBe('a-modal__foot')
    expect(button.className).not.toContain('w-btn--danger') // red is only for deleting: the confirmation asks first
    // the list comes first in the dialog
    const list = within(dialog).getByRole('list')
    expect(list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('closes with the close button, and the Providers tab is as it was', async () => {
    const { dialog } = await open([phone()])
    fireEvent.click(within(dialog).getByRole('button', { name: 'סגירה' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls(/revoke-devices/)).toHaveLength(0)
  })
})

describe('signing every phone out, from the dialog', () => {
  const open = async () => {
    const p = provider({ active_devices: 2 })
    server({ providers: [p], devices: { [p.id]: [phone(), silentPhone()] } })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    opensPhones(card('פלוני'))
    const dialog = await phonesDialog()
    await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' })
    return { dialog, p }
  }

  it('asks first, with the same question as before, and does nothing when the committee says no', async () => {
    const { dialog } = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: 'ניתוק כל המכשירים' }))
    const question = await screen.findByRole('dialog', { name: 'לנתק את כל המכשירים?' })
    expect(question.textContent).toContain('פלוני יצטרך להיכנס שוב עם הסיסמה בכל טלפון')
    fireEvent.click(within(question).getByRole('button', { name: 'ביטול' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'לנתק את כל המכשירים?' })).toBeNull())
    expect(calls(/revoke-devices/)).toHaveLength(0)
    expect(screen.getByRole('dialog', { name: 'מכשירים: פלוני' })).toBeTruthy() // the phones are still on the screen
  })

  it('signs the phones out once confirmed, says so, closes the dialog and loads the list again', async () => {
    const { p } = await open()
    fireEvent.click(screen.getByRole('button', { name: 'ניתוק כל המכשירים' }))
    const question = await screen.findByRole('dialog', { name: 'לנתק את כל המכשירים?' })
    fireEvent.click(within(question).getByRole('button', { name: 'ניתוק' }))
    await waitFor(() => expect(calls(/revoke-devices/)).toHaveLength(1))
    expect(calls(/revoke-devices/)[0][0]).toBe(`/admin/providers/${p.id}/revoke-devices`)
    expect(calls(/revoke-devices/)[0][1]).toMatchObject({ method: 'POST' })
    expect(await screen.findByText('המכשירים נותקו')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(calls(/^\/admin\/providers$/)).toHaveLength(2)) // the tab reloaded its list
  })

  it('keeps the dialog open, and says so, when the sign-out fails', async () => {
    const { p } = await open()
    const answer = api.getMockImplementation()
    api.mockImplementation(async (path, options) => {
      if (/revoke-devices$/.test(path)) throw failure()
      return answer(path, options)
    })
    fireEvent.click(screen.getByRole('button', { name: 'ניתוק כל המכשירים' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'לנתק את כל המכשירים?' })).getByRole('button', { name: 'ניתוק' }))
    expect(await screen.findByText('אין חיבור לשרת. נסו שוב.')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'מכשירים: פלוני' })).toBeTruthy()
    expect(calls(/^\/admin\/providers$/)).toHaveLength(1) // nothing changed, so nothing is loaded again
    expect(p.id).toBeTruthy()
  })
})

describe('the phones dialog when there is nothing to show', () => {
  it('says that no phone is signed in, and offers no sign-out (there is nothing to sign out)', async () => {
    const p = provider({ active_devices: 1 }) // the card was loaded before the last phone was signed out elsewhere
    server({ providers: [p], devices: { [p.id]: [] } })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    opensPhones(card('פלוני'))
    const dialog = await phonesDialog()
    expect(await within(dialog).findByRole('heading', { name: 'אין מכשירים מחוברים' }, WAIT)).toBeTruthy()
    expect(within(dialog).queryByRole('list')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'ניתוק כל המכשירים' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'סגירה' })).toBeTruthy()
  })

  it('offers a retry when the phones could not be loaded, and still offers to sign them all out', async () => {
    const p = provider({ active_devices: 1 })
    server({ providers: [p], devices: { [p.id]: failure() } })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    opensPhones(card('פלוני'))
    const dialog = await phonesDialog()
    expect(await within(dialog).findByRole('heading', { name: 'לא הצלחנו לטעון' }, WAIT)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'ניתוק כל המכשירים' })).toBeTruthy() // for a lost phone, the list is not needed

    server({ providers: [p], devices: { [p.id]: [phone({ app_build: 'abcdef1' })] } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'נסו שוב' }))
    expect(await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' }, WAIT)).toBeTruthy()
    expect(calls(/devices$/)).toHaveLength(2)
  })

  it('shows a spinner while the phones load', async () => {
    const p = provider({ active_devices: 1 })
    let release
    api.mockImplementation(async (path) => {
      if (path === '/admin/providers') return { providers: [p] }
      await new Promise((resolve) => { release = resolve })
      return { devices: [phone()] }
    })
    show()
    await screen.findByRole('heading', { level: 2, name: 'פלוני' }, WAIT)
    opensPhones(card('פלוני'))
    const dialog = await phonesDialog()
    expect(within(dialog).getByRole('status').textContent).toContain('טוען')
    release()
    expect(await within(dialog).findByRole('heading', { level: 3, name: 'מכשיר 1' }, WAIT)).toBeTruthy()
  })
})
