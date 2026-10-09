// @vitest-environment jsdom
// The committee's History tab, on the badge that says how far from the point a visit was: it also says how accurate the
// phone's location was (`gps_accuracy_m`, which the API already returns), because a distance of 58 m from a reading that could
// be 35 m off means something different from the same distance from a reading that could be 150 m off. The real HistoryView,
// with the network (`api`) answered by the test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import HistoryView from '../../src/admin/views/HistoryView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { api } from '../../src/api/client.js'
import { OUTCOME_ACCEPTED, SOURCE_ONLINE } from '../../shared/contract.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const POINT = { id: '11111111-1111-4111-8111-111111111111', name: 'לובי' }
const PROVIDER = { id: '33333333-3333-4333-8333-333333333333', company: 'ניקיון', contact_name: 'פלוני' }
const WAIT = { timeout: 4000 }

let nextId = 1
/** One scan as the API writes it; `over` changes what a test is about. */
const scan = (over = {}) => ({
  id: `s${nextId++}`, local_date: '2026-10-05', checked_in_at: '2026-10-05T06:00:00Z', point_id: POINT.id, point_name: POINT.name,
  provider_id: PROVIDER.id, provider_name: 'נותן סריקה', outcome: OUTCOME_ACCEPTED, source: SOURCE_ONLINE,
  distance_m: 58, gps_accuracy_m: 35, flags: [], voided: false, void_reason: null, ...over,
})

async function show(scans) {
  api.mockImplementation(async (path) => {
    if (path === '/admin/points') return { points: [POINT] }
    if (path === '/admin/providers') return { providers: [PROVIDER] }
    if (path.startsWith('/admin/scans')) return { scans, next_cursor: null }
    throw new Error(`the test does not expect ${path}`)
  })
  render(<ToastProvider><ConfirmProvider><HistoryView /></ConfirmProvider></ToastProvider>)
  await screen.findByText(scans[0].provider_name, {}, WAIT)
}
const rowOf = (text) => screen.getByText(text).closest('li')

// The same fixed "today" as the other History tests: only the clock of Date is faked, the pause before a query keeps running.
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

describe('the distance badge of a visit in History', () => {
  it('says how accurate the location was, after how far from the point', async () => {
    await show([scan({ provider_name: 'נותן א', distance_m: 58, gps_accuracy_m: 35 })])
    expect(within(rowOf('נותן א')).getByText('58 מ׳ מהנקודה, דיוק 35 מ׳')).toBeTruthy()
  })

  it('says only how far from the point when the phone reported no accuracy', async () => {
    await show([scan({ provider_name: 'נותן ב', distance_m: 58, gps_accuracy_m: null })])
    const row = within(rowOf('נותן ב'))
    expect(row.getByText('58 מ׳ מהנקודה')).toBeTruthy()
    expect(row.queryByText(/דיוק/)).toBeNull()
  })

  it('says an accuracy of 0 too: zero is a reading, not a missing one', async () => {
    await show([scan({ provider_name: 'נותן ג', distance_m: 3, gps_accuracy_m: 0 })])
    expect(within(rowOf('נותן ג')).getByText('3 מ׳ מהנקודה, דיוק 0 מ׳')).toBeTruthy()
  })

  it('tells each visit by its own reading', async () => {
    await show([
      scan({ provider_name: 'נותן ד', distance_m: 12, gps_accuracy_m: 8 }),
      scan({ provider_name: 'נותן ה', distance_m: 70, gps_accuracy_m: 120 }),
    ])
    expect(within(rowOf('נותן ד')).getByText('12 מ׳ מהנקודה, דיוק 8 מ׳')).toBeTruthy()
    expect(within(rowOf('נותן ה')).getByText('70 מ׳ מהנקודה, דיוק 120 מ׳')).toBeTruthy()
  })
})
