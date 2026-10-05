// @vitest-environment jsdom
// The committee's History tab, in its "visits not counted" view (ADR 0007, "Visits not counted"): the real HistoryView, with
// the network (`api`) answered by the test. The list of refused visits is GET /api/admin/scan-refusals, which is not the
// list of scans, so this view has to ask for it with the same filters, page it by its cursor, show every reason, and offer
// nothing that is about a scan (the file, cancelling, deleting).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import HistoryView from '../../src/admin/views/HistoryView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { api } from '../../src/api/client.js'
import {
  OUTCOME_ACCEPTED, SOURCE_ONLINE, SOURCE_OFFLINE_SYNC, SYNC_PERMANENT_ERROR_CODES,
  SCAN_ERROR_INVALID_CODE, SCAN_ERROR_UNKNOWN_CODE, SCAN_ERROR_POINT_INACTIVE, SCAN_ERROR_NOT_ASSIGNED,
  SCAN_ERROR_INVALID_SCAN_ID, SCAN_ERROR_SCAN_ID_CONFLICT, SCAN_ERROR_INVALID_ITEM,
} from '../../shared/contract.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const POINT = { id: '11111111-1111-4111-8111-111111111111', name: 'לובי' }
const OTHER_POINT = { id: '22222222-2222-4222-8222-222222222222', name: 'מינוס 1' }
const PROVIDER = { id: '33333333-3333-4333-8333-333333333333', company: 'ניקיון', contact_name: 'פלוני' }

// A fixed "today", so that the default week of the filter is known: 29/09/2026 to 05/10/2026 (DD/MM/YYYY). Only the clock of
// Date is faked: the pause before a query and Testing Library's waiting keep running on real timers.
const FROM = '2026-09-29'
const TO = '2026-10-05'

const scan = {
  id: 's1', local_date: TO, checked_in_at: '2026-10-05T06:00:00Z', point_id: POINT.id, point_name: POINT.name,
  provider_id: PROVIDER.id, provider_name: 'נותן סריקה', outcome: OUTCOME_ACCEPTED, source: SOURCE_ONLINE,
  distance_m: null, flags: [], voided: false, void_reason: null,
}

let nextId = 1
/** One refusal as the API writes it (ISO times); `over` changes what a test is about. */
const refusal = (over = {}) => ({
  id: nextId++, at: '2026-10-05T07:00:00.000Z', scan_id: null, source: SOURCE_ONLINE, code: SCAN_ERROR_POINT_INACTIVE,
  provider_id: PROVIDER.id, provider_name: 'ניקיון - פלוני', point_id: POINT.id, point_name: POINT.name, client_time: null, ...over,
})

/** What the server answers, by path. `refusals` is a function of the parsed query, so a test can page. */
function server({ refusals = () => ({ refusals: [], next_cursor: null }), scans = { scans: [scan], next_cursor: null } } = {}) {
  api.mockImplementation(async (path) => {
    if (path === '/admin/points') return { points: [POINT, OTHER_POINT] }
    if (path === '/admin/providers') return { providers: [PROVIDER] }
    if (path.startsWith('/admin/scans')) return scans
    if (path.startsWith('/admin/scan-refusals')) return refusals(new URL(path, 'http://x').searchParams)
    throw new Error(`the test does not expect ${path}`)
  })
}
const calls = (prefix) => api.mock.calls.map(([path]) => path).filter((path) => path.startsWith(prefix))
const lastParams = (prefix) => new URL(calls(prefix).at(-1), 'http://x').searchParams

function show() {
  return render(<ToastProvider><ConfirmProvider><HistoryView /></ConfirmProvider></ToastProvider>)
}
const WAIT = { timeout: 4000 } // the pause before a query is 350 ms
const typeFilter = () => screen.getByLabelText('סוג')
const choose = (value) => fireEvent.change(typeFilter(), { target: { value } })
const NOT_COUNTED = () => screen.getByRole('option', { name: 'לא נקלטו' }).getAttribute('value')
/** Opens the view and switches it to "visits not counted", and waits for the list to arrive. */
async function openNotCounted() {
  show()
  await screen.findByText('נותן סריקה', {}, WAIT) // the scans arrived first
  choose(NOT_COUNTED())
  await waitFor(() => expect(calls('/admin/scan-refusals')).not.toHaveLength(0), WAIT)
}
const rowOf = (text) => screen.getByText(text).closest('li')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
  nextId = 1
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('switching History to the visits that were not counted', () => {
  it('has the choice "לא נקלטו" in the type filter, next to the three kinds of scans', () => {
    server()
    show()
    expect(within(typeFilter()).getAllByRole('option').map((o) => o.textContent)).toEqual(['נוכחויות שנרשמו', 'ניסיונות שנדחו', 'הכול', 'לא נקלטו'])
  })

  it('asks for the refusals with the dates of the filter, and not for scans', async () => {
    server()
    await openNotCounted()
    const params = lastParams('/admin/scan-refusals')
    expect(Object.fromEntries(params)).toEqual({ from: FROM, to: TO, limit: '100' })
    // the scans were asked for before the switch, and not again after it
    expect(calls('/admin/scans')).toHaveLength(1)
  })

  it('keeps the point and the provider that are chosen, and leaves out the filters that are about scans', async () => {
    server()
    show()
    await screen.findByText('נותן סריקה', {}, WAIT)
    await screen.findByRole('option', { name: 'לובי' })
    await screen.findByRole('option', { name: 'פלוני' })
    fireEvent.change(screen.getByLabelText('נקודה'), { target: { value: POINT.id } })
    fireEvent.change(screen.getByLabelText('נותן שירות'), { target: { value: PROVIDER.id } })
    fireEvent.click(screen.getByLabelText('כולל מבוטלות')) // set before the switch: it must not travel to the refusals
    choose(NOT_COUNTED())
    await waitFor(() => expect(calls('/admin/scan-refusals')).toHaveLength(1), WAIT)
    expect(Object.fromEntries(lastParams('/admin/scan-refusals'))).toEqual({
      from: FROM, to: TO, point_id: POINT.id, provider_id: PROVIDER.id, limit: '100',
    })
  })

  it('goes back to the scans, with the file, when another type is chosen', async () => {
    server({ refusals: () => ({ refusals: [refusal({ provider_name: 'נותן שלא נקלט' })], next_cursor: null }) })
    await openNotCounted()
    await screen.findByText('נקודה כבויה', {}, WAIT)
    choose('all')
    await screen.findByText('נותן סריקה', {}, WAIT)
    expect(screen.queryByText('נותן שלא נקלט')).toBeNull()
    expect(screen.queryByText('נקודה כבויה')).toBeNull()
    expect(screen.getByRole('link', { name: 'ייצוא ל-Excel' })).toBeTruthy()
    expect(screen.getByLabelText('כולל חשבון דמו')).toBeTruthy()
    expect(calls('/admin/scans').length).toBeGreaterThan(1)
  })
})

describe('a row of a visit that was not counted', () => {
  it('shows the time of the server, the point, the provider, the reason and how the visit arrived', async () => {
    server({ refusals: () => ({ refusals: [refusal({ at: '2026-10-05T07:30:00.000Z', provider_name: 'גינון - אלמוני' })], next_cursor: null }) })
    await openNotCounted()
    const row = within(rowOf('גינון - אלמוני'))
    expect(row.getByText('10:30')).toBeTruthy() // 07:30 UTC is 10:30 in the building
    expect(row.getByText(POINT.name)).toBeTruthy()
    expect(row.getByText('נקודה כבויה')).toBeTruthy()
    expect(row.getByText('בזמן אמת')).toBeTruthy()
  })

  it('has a badge for every reason, and one reason for the codes that mean the same to the committee', async () => {
    const reasons = [
      [SCAN_ERROR_POINT_INACTIVE, 'נקודה כבויה'],
      [SCAN_ERROR_NOT_ASSIGNED, 'לא משויך לנקודה'],
      [SCAN_ERROR_UNKNOWN_CODE, 'קוד לא מוכר'],
      [SCAN_ERROR_INVALID_CODE, 'קוד לא מוכר'],
      [SCAN_ERROR_INVALID_SCAN_ID, 'נתונים לא תקינים'],
      [SCAN_ERROR_SCAN_ID_CONFLICT, 'נתונים לא תקינים'],
      [SCAN_ERROR_INVALID_ITEM, 'נתונים לא תקינים'],
    ]
    // every code that the phone drops a visit for has a reason of its own on this screen
    expect(reasons.map(([code]) => code).sort()).toEqual([...SYNC_PERMANENT_ERROR_CODES].sort())
    server({
      refusals: () => ({
        refusals: reasons.map(([code], i) => refusal({ code, provider_name: `נותן ${i}`, point_name: `נקודה ${i}` })),
        next_cursor: null,
      }),
    })
    await openNotCounted()
    for (const [i, [code, label]] of reasons.entries()) {
      expect(within(rowOf(`נותן ${i}`)).getByText(label), code).toBeTruthy()
    }
    expect(screen.getAllByText('קוד לא מוכר')).toHaveLength(2)
    expect(screen.getAllByText('נתונים לא תקינים')).toHaveLength(3)
  })

  it('shows a neutral badge "סיבה אחרת" for a code that this screen does not know, and does not break', async () => {
    server({ refusals: () => ({ refusals: [refusal({ code: 'a_code_of_a_newer_server', provider_name: 'נותן חדש' }), refusal({ provider_name: 'נותן ישן' })], next_cursor: null }) })
    await openNotCounted()
    const badge = within(rowOf('נותן חדש')).getByText('סיבה אחרת')
    expect(badge.className).toContain('a-badge--neutral')
    expect(within(rowOf('נותן ישן')).getByText('נקודה כבויה')).toBeTruthy() // the others are drawn as before
    // a reason is not the red of deleting
    expect(document.querySelector('.a-badge--danger')).toBeNull()
  })

  it('tells a reason that the committee can act on (warm) from a fault of the data (neutral)', async () => {
    server({
      refusals: () => ({
        refusals: [
          refusal({ code: SCAN_ERROR_NOT_ASSIGNED, provider_name: 'נותן א' }),
          refusal({ code: SCAN_ERROR_INVALID_ITEM, provider_name: 'נותן ב' }),
        ],
        next_cursor: null,
      }),
    })
    await openNotCounted()
    expect(within(rowOf('נותן א')).getByText('לא משויך לנקודה').className).toContain('a-badge--warn')
    expect(within(rowOf('נותן ב')).getByText('נתונים לא תקינים').className).toContain('a-badge--neutral')
  })

  it('says "מהתור בטלפון" for a visit from the phone\'s queue and "בזמן אמת" for one that came online', async () => {
    server({
      refusals: () => ({
        refusals: [
          refusal({ source: SOURCE_OFFLINE_SYNC, provider_name: 'נותן תור', client_time: '2026-10-05T05:00:00.000Z' }),
          refusal({ source: SOURCE_ONLINE, provider_name: 'נותן מחובר' }),
          refusal({ source: 'a_source_of_a_newer_server', provider_name: 'נותן אחר' }),
        ],
        next_cursor: null,
      }),
    })
    await openNotCounted()
    const queue = within(rowOf('נותן תור')).getByText('מהתור בטלפון')
    expect(queue.className).toContain('a-badge--info')
    expect(within(rowOf('נותן מחובר')).getByText('בזמן אמת')).toBeTruthy()
    expect(screen.getAllByText('מהתור בטלפון')).toHaveLength(1)
    // a source that is not known shows no source badge, and the row is still there
    expect(within(rowOf('נותן אחר')).queryByText(/בזמן אמת|מהתור בטלפון/)).toBeNull()
  })

  it('writes the time that the phone scanned as DD/MM/YYYY HH:MM, for a visit from the queue', async () => {
    server({
      refusals: () => ({
        refusals: [refusal({ source: SOURCE_OFFLINE_SYNC, at: '2026-10-05T07:00:00.000Z', client_time: '2026-10-04T08:05:00.000Z', provider_name: 'נותן תור' })],
        next_cursor: null,
      }),
    })
    await openNotCounted()
    const row = within(rowOf('נותן תור'))
    expect(row.getByText(/נסרק בטלפון/)).toBeTruthy()
    expect(row.getByText('04/10/2026 11:05')).toBeTruthy() // 08:05 UTC, the evening before the server saw it
  })

  it('shows the phone\'s time for a visit that came online only when its minute is not the server\'s', async () => {
    server({
      refusals: () => ({
        refusals: [
          refusal({ at: '2026-10-05T07:00:20.000Z', client_time: '2026-10-05T07:00:15.000Z', provider_name: 'נותן אותה דקה' }),
          refusal({ at: '2026-10-05T07:10:00.000Z', client_time: '2026-10-05T07:04:00.000Z', provider_name: 'נותן שעון אחר' }),
          refusal({ source: SOURCE_OFFLINE_SYNC, client_time: null, provider_name: 'נותן בלי שעון' }),
        ],
        next_cursor: null,
      }),
    })
    await openNotCounted()
    expect(within(rowOf('נותן אותה דקה')).queryByText(/נסרק בטלפון/)).toBeNull()
    expect(within(rowOf('נותן שעון אחר')).getByText('05/10/2026 10:04')).toBeTruthy()
    // nothing to show when the phone's clock could not be believed, even from the queue
    expect(within(rowOf('נותן בלי שעון')).queryByText(/נסרק בטלפון/)).toBeNull()
  })

  it('names the point as "קוד לא מוכר" when the code named none, and by its name otherwise', async () => {
    server({
      refusals: () => ({
        refusals: [
          refusal({ code: SCAN_ERROR_POINT_INACTIVE, point_id: null, point_name: null, provider_name: 'נותן בלי נקודה' }),
          refusal({ code: SCAN_ERROR_POINT_INACTIVE, provider_name: 'נותן עם נקודה' }),
        ],
        next_cursor: null,
      }),
    })
    await openNotCounted()
    // the reason of that row is "point switched off", so the words appear once, as the name of the point
    expect(within(rowOf('נותן בלי נקודה')).getAllByText('קוד לא מוכר')).toHaveLength(1)
    expect(within(rowOf('נותן עם נקודה')).queryByText('קוד לא מוכר')).toBeNull()
    expect(within(rowOf('נותן עם נקודה')).getByText(POINT.name)).toBeTruthy()
  })

  it('is grouped by the building day, with a count, newest first', async () => {
    server({
      refusals: () => ({
        refusals: [
          refusal({ at: '2026-10-05T07:00:00.000Z' }),
          refusal({ at: '2026-10-03T21:30:00.000Z' }), // 00:30 on 04/10 in the building, still 03/10 in UTC
          refusal({ at: '2026-10-03T20:30:00.000Z' }), // 23:30 on 03/10
        ],
        next_cursor: null,
      }),
    })
    await openNotCounted()
    await screen.findAllByRole('heading', { level: 2 })
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(['05/10/2026 · 1', '04/10/2026 · 1', '03/10/2026 · 1'])
  })

  it('has no action at all: no cancel, no restore, no delete, and no file to export', async () => {
    server({ refusals: () => ({ refusals: [refusal({ provider_name: 'נותן א' }), refusal({ provider_name: 'נותן ב' })], next_cursor: null }) })
    await openNotCounted()
    await screen.findByText('נותן א')
    for (const name of ['נותן א', 'נותן ב']) expect(within(rowOf(name)).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /ביטול הנוכחות|שחזור הנוכחות|מחיקת הנוכחות/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'ייצוא ל-Excel' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'ייצוא ל-Excel' })).toBeNull()
    // the two switches are about scans: cancelled ones and the demo account's
    expect(screen.queryByLabelText('כולל מבוטלות')).toBeNull()
    expect(screen.queryByLabelText('כולל חשבון דמו')).toBeNull()
    // the page still has its own controls
    expect(screen.getByRole('button', { name: 'רענון' })).toBeTruthy()
  })
})

describe('paging the visits that were not counted', () => {
  const page = (params) => (params.get('cursor') === 'next-page'
    ? { refusals: [refusal({ provider_name: 'נותן שני' })], next_cursor: null }
    : { refusals: [refusal({ provider_name: 'נותן ראשון' })], next_cursor: 'next-page' })

  it('loads the next page with the cursor of the endpoint, with the same filters, and ends when there is none', async () => {
    server({ refusals: page })
    await openNotCounted()
    await screen.findByText('נותן ראשון')
    fireEvent.click(screen.getByRole('button', { name: 'טעינת עוד' }))
    await screen.findByText('נותן שני')
    expect(screen.getByText('נותן ראשון')).toBeTruthy() // the first page stays
    const params = lastParams('/admin/scan-refusals')
    expect(Object.fromEntries(params)).toEqual({ from: FROM, to: TO, limit: '100', cursor: 'next-page' })
    expect(screen.queryByRole('button', { name: 'טעינת עוד' })).toBeNull()
  })

  it('does not draw the same visit twice when two pages overlap', async () => {
    const same = refusal({ provider_name: 'נותן כפול' })
    server({ refusals: (params) => ({ refusals: [same], next_cursor: params.get('cursor') ? null : 'next-page' }) })
    await openNotCounted()
    await screen.findByText('נותן כפול')
    fireEvent.click(screen.getByRole('button', { name: 'טעינת עוד' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'טעינת עוד' })).toBeNull())
    expect(screen.getAllByText('נותן כפול')).toHaveLength(1)
  })
})

describe('when there is nothing to show', () => {
  it('says that no visit was left uncounted in the period, with a heading of the second level', async () => {
    server()
    await openNotCounted()
    expect(await screen.findByRole('heading', { level: 2, name: 'אין ביקורים שלא נקלטו בטווח הזה' }, WAIT)).toBeTruthy()
    expect(screen.queryByText('אין נוכחויות בטווח הזה')).toBeNull() // not the empty state of the scans
  })

  it('offers a retry, not an empty list, when the list could not be loaded', async () => {
    server({ refusals: () => { throw Object.assign(new Error('x'), { code: 'network' }) } })
    await openNotCounted()
    expect(await screen.findByRole('heading', { level: 2, name: 'לא הצלחנו לטעון' }, WAIT)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'נסו שוב' })).toBeTruthy()
  })
})
