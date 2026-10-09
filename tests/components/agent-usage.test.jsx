// @vitest-environment jsdom
// The committee's Agent screen, in what it says about how much each key is used (GET /api/admin/api-keys): the real AgentView, with
// the network (`api`) answered by the test. Each card shows the requests of today and of the last 7 days; a quiet warning line
// appears on the card of a key that was turned away in the last 30 days and only then; and the limits are said once on the screen,
// from the numbers the server sends (the constants of server/config.js), never from numbers written in the screen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import AgentView from '../../src/admin/views/AgentView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { clearLoadCache } from '../../src/admin/loadCache.js'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

let nextId = 1
/** One key as GET /api/admin/api-keys writes it, never used; `over` changes what a test is about. */
const apiKey = (over = {}) => ({
  id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, name: 'הסוכן של הוועד', key_prefix: 'qrk_a1b2',
  created_at: '2026-09-01T08:00:00.000Z', last_used_at: null, revoked_at: null,
  requests_today: 0, requests_7d: 0, refused_30d: 0, ...over,
})
const LIMITS = { per_minute: 60, per_day: 2000 }

/** What the server answers: the keys, and the limits (`limits: null` is an older server, whose answer has none). */
function server({ keys, limits = LIMITS }) {
  api.mockImplementation(async (path) => {
    if (path === '/admin/api-keys') return limits === null ? { api_keys: keys } : { api_keys: keys, limits }
    throw new Error(`the test does not expect ${path}`)
  })
}

function show() {
  return render(<ToastProvider><ConfirmProvider><AgentView /></ConfirmProvider></ToastProvider>)
}
const WAIT = { timeout: 4000 }
const card = (name) => screen.getByRole('heading', { level: 2, name }).closest('article')
/** The text of the value (dd) that follows a label (dt) inside `scope`. */
const fact = (scope, label) => within(scope).getByText(label, { selector: 'dt' }).nextElementSibling
const WARNING = /נחס(מו|מה)/

beforeEach(() => {
  clearLoadCache() // every test stands for a new page load: the screen keeps its last answer in memory otherwise
  nextId = 1
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the card: how much the key is used', () => {
  it('says the requests of today and of the last 7 days, under the last use', async () => {
    server({ keys: [apiKey({ last_used_at: '2026-10-05T07:30:00.000Z', requests_today: 12, requests_7d: 140 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'הסוכן של הוועד' }, WAIT)
    const key = card('הסוכן של הוועד')
    expect(fact(key, 'קריאות היום').textContent).toBe('12')
    expect(fact(key, 'קריאות ב-7 ימים').textContent).toBe('140')
    // The three facts that were there keep their places (the dates are DD/MM/YYYY HH:MM, in the building's time: tests/dates.test.js),
    // and the usage comes after them.
    const labels = [...key.querySelectorAll('dt')].map((dt) => dt.textContent)
    expect(labels).toEqual(['מפתח', 'נוצר', 'שימוש אחרון', 'קריאות היום', 'קריאות ב-7 ימים'])
    expect(fact(key, 'שימוש אחרון').textContent).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
  })

  it('shows zeros for a key that was never used, and no warning', async () => {
    server({ keys: [apiKey()] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'הסוכן של הוועד' }, WAIT)
    const key = card('הסוכן של הוועד')
    expect(fact(key, 'קריאות היום').textContent).toMatch(/^0$/)
    expect(fact(key, 'קריאות ב-7 ימים').textContent).toMatch(/^0$/)
    expect(fact(key, 'שימוש אחרון').textContent).toBe('עוד לא נעשה בו שימוש')
    expect(within(key).queryByText(WARNING)).toBeNull()
  })

  it('shows the usage of a revoked key too, as a history', async () => {
    server({ keys: [apiKey({ name: 'ישן', revoked_at: '2026-09-20T08:00:00.000Z', requests_today: 0, requests_7d: 31 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'ישן' }, WAIT)
    const key = card('ישן')
    expect(within(key).getByText('בוטל')).toBeTruthy()
    expect(fact(key, 'קריאות ב-7 ימים').textContent).toBe('31')
  })

  it('writes the numbers plainly, with no separator', async () => {
    server({ keys: [apiKey({ requests_today: 1999, requests_7d: 13987 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'הסוכן של הוועד' }, WAIT)
    const key = card('הסוכן של הוועד')
    expect(fact(key, 'קריאות היום').textContent).toMatch(/^1999$/)
    expect(fact(key, 'קריאות ב-7 ימים').textContent).toMatch(/^13987$/)
  })
})

describe('the card: refused requests', () => {
  it('says how many requests were turned away in the last 30 days, in a line of its own under the facts, only for the key that was', async () => {
    server({ keys: [apiKey({ name: 'נחסם', refused_30d: 3, requests_today: 5, requests_7d: 5 }), apiKey({ name: 'שקט', requests_today: 5, requests_7d: 5 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'נחסם' }, WAIT)
    const limited = card('נחסם')
    const line = within(limited).getByText('נחסמו 3 קריאות ב-30 הימים האחרונים בגלל מגבלת הקצב')
    expect(line.tagName).toBe('P')
    // after the list of facts, not inside it
    expect(limited.querySelector('dl').contains(line)).toBe(false)
    expect(limited.querySelector('dl').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the other card has no such line
    expect(within(card('שקט')).queryByText(WARNING)).toBeNull()
  })

  it('says it in the singular for one request', async () => {
    server({ keys: [apiKey({ refused_30d: 1 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'הסוכן של הוועד' }, WAIT)
    expect(within(card('הסוכן של הוועד')).getByText('נחסמה קריאה אחת ב-30 הימים האחרונים בגלל מגבלת הקצב')).toBeTruthy()
  })

  it('shows no line for zero, also when the key was used a lot', async () => {
    server({ keys: [apiKey({ requests_today: 1500, requests_7d: 9000, refused_30d: 0 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'הסוכן של הוועד' }, WAIT)
    expect(screen.queryByText(WARNING)).toBeNull()
  })

  it('keeps the actions of the card as they were: cancel, then the red trash can last', async () => {
    server({ keys: [apiKey({ refused_30d: 4, requests_today: 61, requests_7d: 61 })] })
    show()
    await screen.findByRole('heading', { level: 2, name: 'הסוכן של הוועד' }, WAIT)
    const names = within(card('הסוכן של הוועד')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['ביטול המפתח', 'מחיקת המפתח'])
  })
})

describe('the limits', () => {
  it('are said once on the screen, not on every card, from the numbers the server sends', async () => {
    server({ keys: [apiKey({ name: 'א' }), apiKey({ name: 'ב' }), apiKey({ name: 'ג', refused_30d: 2 })], limits: { per_minute: 30, per_day: 500 } })
    show()
    await screen.findByRole('heading', { level: 2, name: 'ג' }, WAIT)
    expect(screen.getAllByText('כל מפתח מוגבל ל-30 קריאות בדקה ול-500 ביום.')).toHaveLength(1)
    // not inside any card, and the page does not say the numbers of the constants when the server says others
    for (const article of screen.getAllByRole('article')) expect(within(article).queryByText(/מוגבל/)).toBeNull()
    expect(screen.queryByText(/ל-60 קריאות/)).toBeNull()
  })

  it('read as the committee reads them: 60 a minute and 2000 a day', async () => {
    server({ keys: [apiKey()] })
    show()
    expect(await screen.findByText('כל מפתח מוגבל ל-60 קריאות בדקה ול-2000 ביום.', {}, WAIT)).toBeTruthy()
  })

  it('are said also when there is no key yet, so that the committee knows before it makes one', async () => {
    server({ keys: [] })
    show()
    expect(await screen.findByText('עוד אין מפתחות', {}, WAIT)).toBeTruthy()
    expect(screen.getByText('כל מפתח מוגבל ל-60 קריאות בדקה ול-2000 ביום.')).toBeTruthy()
  })
})

describe('an older server (no usage, no limits in the answer)', () => {
  it('still shows the cards, with no usage lines, no warning and no line of limits', async () => {
    server({ keys: [{ id: '00000000-0000-4000-8000-0000000000aa', name: 'ישן', key_prefix: 'qrk_old1', created_at: '2026-09-01T08:00:00.000Z', last_used_at: null, revoked_at: null }], limits: null })
    show()
    await screen.findByRole('heading', { level: 2, name: 'ישן' }, WAIT)
    const key = card('ישן')
    expect(within(key).queryByText('קריאות היום', { selector: 'dt' })).toBeNull()
    expect(within(key).queryByText('קריאות ב-7 ימים', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText(WARNING)).toBeNull()
    expect(screen.queryByText(/מוגבל/)).toBeNull()
  })
})
