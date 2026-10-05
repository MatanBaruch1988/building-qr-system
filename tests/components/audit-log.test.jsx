// @vitest-environment jsdom
// The audit log of the committee app (ADR 0007, decision 4): the real AuditView, with the network (`api`) answered by the test,
// and the section of the Committee tab that opens it. It is read only, so the rows have no actions; it shows what the API
// gives, in Hebrew, by the keys it knows, and nothing else (never a key, a hash or a token, and never as HTML).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import AuditView from '../../src/admin/views/AuditView.jsx'
import CommitteeView from '../../src/admin/views/CommitteeView.jsx'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { ACTION_LABELS, GROUP_OPTIONS } from '../../src/admin/auditLabels.js'
import { describeEntry, looksSecret } from '../../src/admin/auditDescribe.js'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const DANA = { id: '11111111-1111-4111-8111-111111111111', name: 'דנה לוי', email: 'dana@example.test', is_active: true, last_login_at: null }
const YOSSI = { id: '22222222-2222-4222-8222-222222222222', name: '', email: 'yossi@example.test', is_active: true, last_login_at: null }
const POINT = '33333333-3333-4333-8333-333333333333'
const PROVIDER = '44444444-4444-4444-8444-444444444444'

let nextId = 1
/** One entry as GET /api/admin/audit gives it (ISO times, UTC); `over` changes what a test is about. 07:14 UTC is 10:14 in the building. */
const entry = (over = {}) => ({
  id: nextId++, at: '2026-10-05T07:14:00.000Z', action: 'point.update', entity: 'point', entity_id: POINT, entity_name: 'לובי',
  actor_type: 'admin', actor_id: DANA.id, actor_name: 'דנה לוי', actor_deleted: false, detail: null, ...over,
})

/** What the server answers, by path. `audit` is a function of the parsed query, so a test can page and filter. */
function server({ audit = () => ({ entries: [], next_cursor: null }), admins = [DANA, YOSSI] } = {}) {
  api.mockImplementation(async (path) => {
    if (path === '/admin/admins') return { admins }
    if (path === '/admin/building') return { building: { address: '' } }
    if (path.startsWith('/admin/audit')) return audit(new URL(path, 'http://x').searchParams)
    throw new Error(`the test does not expect ${path}`)
  })
}
const auditCalls = () => api.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/admin/audit'))
const lastParams = () => new URL(auditCalls().at(-1), 'http://x').searchParams
const page = (entries, next_cursor = null) => () => ({ entries, next_cursor })

const show = () => render(<ToastProvider><ConfirmProvider><AuditView /></ConfirmProvider></ToastProvider>)
const WAIT = { timeout: 4000 } // the pause before a query is 350 ms
/** Shows one entry and returns its row. */
async function rowFor(over, phrase) {
  server({ audit: page([entry(over)]) })
  show()
  // by the class of the phrase: a word like "ניקוי אוטומטי" is also an option of the group filter
  return (await screen.findAllByText(phrase, { selector: '.a-audit__action' }, WAIT))[0].closest('li')
}

beforeEach(() => { nextId = 1 })
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the phrase of every action', () => {
  // Each action of the table at the top of server/audit.js, and the Hebrew that the screen says for it.
  const PHRASES = {
    'admin.add': 'הוספת חבר ועד', 'admin.enable': 'הפעלת חבר ועד', 'admin.disable': 'השבתת חבר ועד', 'admin.delete': 'מחיקת חבר ועד',
    'building.update': 'עדכון כתובת הבניין',
    'point.create': 'יצירת נקודה', 'point.update': 'עדכון נקודה', 'point.delete': 'מחיקת נקודה', 'point.regenerate_qr': 'החלפת קוד QR',
    'provider.create': 'הוספת נותן שירות', 'provider.update': 'עדכון נותן שירות', 'provider.delete': 'מחיקת נותן שירות', 'provider.revoke_devices': 'ניתוק מכשירים',
    'scan.void': 'ביטול נוכחות', 'scan.unvoid': 'שחזור נוכחות', 'scan.delete': 'מחיקת נוכחות',
    'api_key.create': "יצירת מפתח אייג'נט", 'api_key.revoke': "השבתת מפתח אייג'נט", 'api_key.delete': "מחיקת מפתח אייג'נט",
    'session.sign_in': 'כניסה', 'session.sign_out': 'יציאה',
    'retention.run': 'ניקוי אוטומטי',
  }

  it('says every action in words, and the map has exactly these', () => {
    expect(ACTION_LABELS).toEqual(PHRASES)
  })

  it('draws every action of the map as its phrase (one row each)', async () => {
    server({ audit: page(Object.keys(PHRASES).map((action, i) => entry({ action, entity_name: null, at: `2026-10-05T07:${String(10 + i).padStart(2, '0')}:00.000Z` }))) })
    show()
    for (const phrase of Object.values(PHRASES)) {
      const rows = await screen.findAllByText(phrase, { selector: '.a-audit__action' }, WAIT)
      expect(rows, phrase).toHaveLength(1)
    }
  })

  it('has a phrase for every action that server/audit.js describes (so a new action cannot be left without words)', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server', 'audit.js'), 'utf8')
    const table = source.split('\n').filter((line) => line.startsWith('//   ')).map((line) => /^\/\/ {3}([a-z_]+\.[a-z_]+)\s/.exec(line)?.[1]).filter(Boolean)
    expect(table.length, 'the table of actions was found').toBeGreaterThan(15)
    for (const action of table) expect(Object.hasOwn(ACTION_LABELS, action), action).toBe(true)
  })

  it('has the nine choices of the group filter, in the order of the screen', () => {
    expect(GROUP_OPTIONS.map((g) => g.label)).toEqual(['הכל', 'חברי ועד', 'פרטי הבניין', 'נקודות', 'נותני שירות', 'נוכחות', "מפתחות אייג'נט", 'כניסות ויציאות', 'ניקוי אוטומטי'])
    expect(GROUP_OPTIONS.map((g) => g.value)).toEqual(['', 'admin', 'building', 'point', 'provider', 'scan', 'api_key', 'session', 'retention'])
  })
})

describe('one row', () => {
  it('has the time of the building, the phrase, what it is about, who did it, and no actions at all', async () => {
    const row = await rowFor({ action: 'point.regenerate_qr' }, 'החלפת קוד QR')
    expect(within(row).getByText('10:14')).toBeTruthy() // 07:14 UTC, the building's time
    expect(within(row).getByText('לובי')).toBeTruthy()
    expect(within(row).getByText('דנה לוי')).toBeTruthy()
    expect(row.textContent).toContain('על ידי')
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
    expect(within(row).queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryByRole('link', { name: /ייצוא/ })).toBeNull() // no file, either
  })

  it('groups the rows by building day, newest first, with the date as DD/MM/YYYY and the count', async () => {
    server({
      audit: page([
        entry({ at: '2026-10-05T20:59:00.000Z' }), // 05/10 23:59
        entry({ at: '2026-10-05T21:00:00.000Z', action: 'point.delete' }), // 06/10 00:00: the next building day
        entry({ at: '2026-10-04T10:00:00.000Z' }),
      ].sort((a, b) => b.at.localeCompare(a.at))),
    })
    show()
    await screen.findByRole('heading', { level: 3, name: '06/10/2026 · 1' }, WAIT)
    expect(screen.getByRole('heading', { level: 3, name: '05/10/2026 · 1' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: '04/10/2026 · 1' })).toBeTruthy()
    // 06/10 00:00 is the first minute of its day, and 05/10 23:59 the last of the one before
    expect(within(screen.getByRole('region', { name: '06/10/2026' })).getByText('00:00')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '05/10/2026' })).getByText('23:59')).toBeTruthy()
  })
})

describe('who did it', () => {
  it('is the name on the entry', async () => {
    const row = await rowFor({ actor_name: 'יוסי כהן' }, 'עדכון נקודה')
    expect(within(row).getByText('יוסי כהן')).toBeTruthy()
    expect(row.textContent).not.toContain('(נמחק)')
  })

  it('says "(נמחק)" after a member who is no longer on the committee', async () => {
    const row = await rowFor({ actor_name: 'אבי מזרחי', actor_deleted: true }, 'עדכון נקודה')
    expect(within(row).getByText('אבי מזרחי (נמחק)')).toBeTruthy()
  })

  it('is "המערכת" for the system (the daily job), whatever name or id the entry carries', async () => {
    const row = await rowFor({ action: 'retention.run', entity: null, entity_id: null, entity_name: null, actor_type: 'system', actor_id: null, actor_name: null, detail: { sessions: 2, login_attempts: 14, device_labels: 0 } }, 'ניקוי אוטומטי')
    expect(within(row).getByText('המערכת')).toBeTruthy()
    expect(row.textContent).toContain('חיבורים שפג תוקפם: 2')
    expect(row.textContent).toContain('ניסיונות כניסה: 14')
    expect(row.textContent).toContain('שמות מכשירים: 0')
  })

  it('is "סקריפט התקנה" for the script of the owner, which has no name', async () => {
    const row = await rowFor({ action: 'admin.add', entity: 'admin', entity_id: YOSSI.id, entity_name: 'yossi@example.test', actor_type: 'script', actor_id: null, actor_name: null, detail: { email: 'yossi@example.test' } }, 'הוספת חבר ועד')
    expect(within(row).getByText('סקריפט התקנה')).toBeTruthy()
  })

  it('is "חבר ועד" when a member has no name at all, and shows an e-mail used as a name as it is', async () => {
    const row = await rowFor({ actor_name: null }, 'עדכון נקודה')
    expect(within(row).getByText('חבר ועד')).toBeTruthy()
    cleanup()
    const row2 = await rowFor({ actor_name: 'someone@example.test' }, 'עדכון נקודה')
    expect(within(row2).getByText('someone@example.test')).toBeTruthy()
  })
})

describe('the detail of an update (`changes`)', () => {
  it('says each field as "field: old ← new", in Hebrew, in a fixed order', async () => {
    const row = await rowFor({
      detail: { changes: { radius_m: { from: 40, to: 60 }, name: { from: 'לובי', to: 'לובי ראשי' }, gps_mode: { from: 'optional', to: 'required' } } },
    }, 'עדכון נקודה')
    const lines = [...row.querySelectorAll('.a-audit__detail > div')].map((d) => d.textContent)
    expect(lines).toEqual(['שם: לובי ← לובי ראשי', 'בדיקת מיקום: מיקום אם אפשר ← מיקום חובה', 'רדיוס (מטרים): 40 ← 60'])
  })

  it('says an empty value as "ריק", a switch as yes and no, and a kind of service in its word', async () => {
    const row = await rowFor({
      action: 'provider.update', entity: 'provider', entity_id: PROVIDER, entity_name: 'ניקיון – יוסי',
      detail: { changes: { contact_name: { from: null, to: 'עמית' }, is_active: { from: true, to: false }, service_type: { from: 'cleaning', to: 'maintenance' }, is_demo: { from: false, to: true } }, password_changed: true },
    }, 'עדכון נותן שירות')
    const lines = [...row.querySelectorAll('.a-audit__detail > div')].map((d) => d.textContent)
    expect(lines).toEqual([
      'איש קשר: ריק ← עמית', 'סוג שירות: ניקיון ← תחזוקה', 'פעיל: כן ← לא', 'חשבון דמו: לא ← כן', 'הסיסמה הוחלפה',
    ])
  })

  it('writes a date inside a change as DD/MM/YYYY, and a moment as DD/MM/YYYY HH:MM in the building\'s time', async () => {
    const row = await rowFor({ detail: { changes: { description: { from: '2026-10-01', to: '2026-10-02T06:30:00.000Z' }, address: { from: '2026-02-30', to: null } } } }, 'עדכון נקודה')
    const [description, address] = [...row.querySelectorAll('.a-audit__detail > div')].map((d) => d.textContent)
    expect(description).toBe('תיאור: 01/10/2026 ← 02/10/2026 09:30') // the ISO text of the API is never shown for a real date
    expect(address).toBe('כתובת: 2026-02-30 ← ריק') // a day that does not exist is not a date: shown as it was written
  })

  it('shows the address change of the building, and an enable with its e-mail and what switched', async () => {
    const building = await rowFor({ action: 'building.update', entity: 'building', entity_id: null, entity_name: null, detail: { changes: { address: { from: null, to: 'רחוב הדוגמה 1' } } } }, 'עדכון כתובת הבניין')
    expect(building.querySelector('.a-audit__detail').textContent).toBe('כתובת: ריק ← רחוב הדוגמה 1')
    expect(building.querySelector('.a-audit__subject')).toBeNull() // nothing for the building: it is the only one
    cleanup()
    const enable = await rowFor({ action: 'admin.enable', entity: 'admin', entity_id: YOSSI.id, entity_name: 'yossi@example.test', detail: { email: 'yossi@example.test', changes: { is_active: { from: false, to: true } } } }, 'הפעלת חבר ועד')
    expect(enable.textContent).toContain('פעיל: לא ← כן')
    expect(enable.textContent).not.toContain('אימייל') // the e-mail is the subject already
  })

  it('cuts a long value and never lets it break the row', async () => {
    const long = 'א'.repeat(300)
    const row = await rowFor({ detail: { changes: { description: { from: null, to: long } } } }, 'עדכון נקודה')
    const line = row.querySelector('.a-audit__detail').textContent
    expect(line.length).toBeLessThan(120)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('the providers of a point', () => {
  it('counts what an update added and removed, in the words of the number', async () => {
    const row = await rowFor({ detail: { provider_ids: { added: ['a'], removed: ['b', 'c'] } } }, 'עדכון נקודה')
    expect(row.textContent).toContain('נוסף נותן שירות אחד לנקודה')
    expect(row.textContent).toContain('הוסרו 2 נותני שירות מהנקודה')
    cleanup()
    const many = await rowFor({ detail: { provider_ids: { added: ['a', 'b', 'c'], removed: [] } } }, 'עדכון נקודה')
    expect(many.textContent).toContain('נוספו 3 נותני שירות לנקודה')
    expect(many.textContent).not.toContain('הוסר')
  })

  it('counts the whole list of a create (and of the older update)', async () => {
    const created = await rowFor({ action: 'point.create', detail: { name: 'לובי', gps_mode: 'optional', provider_ids: ['a', 'b'] } }, 'יצירת נקודה')
    expect(created.textContent).toContain('2 נותני שירות מורשים')
    expect(created.textContent).toContain('בדיקת מיקום: מיקום אם אפשר')
    expect(created.querySelectorAll('.a-audit__detail > div')[0].textContent).not.toContain('שם:') // the name is the subject already
    cleanup()
    const none = await rowFor({ action: 'point.create', detail: { name: 'לובי', provider_ids: [] } }, 'יצירת נקודה')
    expect(none.textContent).toContain('אין נותני שירות מורשים')
  })

  it('does not show a list of ids: a count, never the ids', async () => {
    const row = await rowFor({ detail: { provider_ids: { added: [PROVIDER], removed: [] } } }, 'עדכון נקודה')
    expect(row.textContent).not.toContain(PROVIDER)
  })
})

describe('the other known keys', () => {
  it('shows the reason that was typed for a cancelled visit, and the one that a restore cleared', async () => {
    const voided = await rowFor({ action: 'scan.void', entity: 'scan', entity_id: 's1', entity_name: null, detail: { reason: 'נסרק בטעות' } }, 'ביטול נוכחות')
    expect(voided.querySelector('.a-audit__detail').textContent).toBe('סיבה: נסרק בטעות')
    cleanup()
    const restored = await rowFor({ action: 'scan.unvoid', entity: 'scan', entity_id: 's1', entity_name: null, detail: { previous_reason: 'נסרק בטעות' } }, 'שחזור נוכחות')
    expect(restored.querySelector('.a-audit__detail').textContent).toBe('הסיבה לביטול: נסרק בטעות')
    cleanup()
    const noReason = await rowFor({ action: 'scan.void', entity: 'scan', entity_id: 's1', entity_name: null, detail: { reason: null } }, 'ביטול נוכחות')
    expect(noReason.querySelector('.a-audit__detail')).toBeNull()
  })

  it('counts the phones that were signed out (also none, and one)', async () => {
    const cases = [[3, 'נותקו 3 מכשירים'], [1, 'נותק מכשיר אחד'], [0, 'אף מכשיר לא היה מחובר']]
    for (const [devices, text] of cases) {
      const row = await rowFor({ action: 'provider.revoke_devices', entity: 'provider', entity_id: PROVIDER, entity_name: 'ניקיון', detail: { devices } }, 'ניתוק מכשירים')
      expect(row.querySelector('.a-audit__detail').textContent, String(devices)).toBe(text)
      cleanup()
    }
  })

  it('says how many visits stay in the history after a delete, and names a thing that is gone by the detail', async () => {
    const point = await rowFor({ action: 'point.delete', entity_name: null, detail: { name: 'חדר אופניים', scans_kept: 12 } }, 'מחיקת נקודה')
    expect(within(point).getByText('חדר אופניים')).toBeTruthy()
    expect(point.textContent).toContain('נוכחויות שנשארו בהיסטוריה: 12')
    cleanup()
    const provider = await rowFor({ action: 'provider.delete', entity: 'provider', entity_id: PROVIDER, entity_name: null, detail: { company: 'גינון ירוק', contact_name: 'שרה ברק', scans_kept: 0 } }, 'מחיקת נותן שירות')
    expect(within(provider).getByText('גינון ירוק – שרה ברק')).toBeTruthy() // as the history names a provider
    expect(provider.querySelectorAll('.a-audit__detail > div')).toHaveLength(1) // the company and the contact are not said twice
    cleanup()
    const member = await rowFor({ action: 'admin.delete', entity: 'admin', entity_id: YOSSI.id, entity_name: null, detail: { email: 'gone@example.test', name: 'רונית אבני' } }, 'מחיקת חבר ועד')
    expect(within(member).getByText('רונית אבני')).toBeTruthy()
    expect(member.textContent).toContain('אימייל: gone@example.test')
  })

  it('names the visit that was deleted by its detail: the point, who, and when', async () => {
    const row = await rowFor({
      action: 'scan.delete', entity: 'scan', entity_id: 's1', entity_name: null,
      detail: { point_name: 'מחסן', provider_name: 'ניקיון – יוסי', checked_in_at: '2026-09-30T05:15:00.000Z', outcome: 'accepted', voided: true },
    }, 'מחיקת נוכחות')
    expect(within(row).getByText('מחסן')).toBeTruthy()
    const text = row.querySelector('.a-audit__detail').textContent
    expect(text).toContain('נותן שירות: ניקיון – יוסי')
    expect(text).toContain('זמן הנוכחות: 30/09/2026 08:15')
    expect(text).toContain('הנוכחות הייתה מבוטלת')
    expect(text).not.toContain('accepted')
  })

  it('says how a member signed in (and no subject: the member is the actor)', async () => {
    const google = await rowFor({ action: 'session.sign_in', entity: 'admin', entity_id: DANA.id, entity_name: 'דנה לוי', detail: { method: 'google' } }, 'כניסה')
    expect(google.querySelector('.a-audit__detail').textContent).toBe('כניסה עם Google')
    expect(google.querySelector('.a-audit__subject')).toBeNull()
    cleanup()
    const dev = await rowFor({ action: 'session.sign_in', entity: 'admin', entity_id: DANA.id, entity_name: 'דנה לוי', detail: { method: 'dev' } }, 'כניסה')
    expect(dev.querySelector('.a-audit__detail').textContent).toBe('כניסת פיתוח')
    cleanup()
    const other = await rowFor({ action: 'session.sign_in', entity: 'admin', entity_id: DANA.id, entity_name: 'דנה לוי', detail: { method: 'something-new' } }, 'כניסה')
    expect(other.querySelector('.a-audit__detail')).toBeNull() // a method that the screen does not know is not shown
  })
})

describe('the older shapes of a detail (before #78)', () => {
  it('reads the fields that were sent, flat, as the new values', async () => {
    const row = await rowFor({ detail: { name: 'לובי', is_active: false, radius_m: 50, provider_ids: ['a', 'b'] } }, 'עדכון נקודה')
    const lines = [...row.querySelectorAll('.a-audit__detail > div')].map((d) => d.textContent)
    expect(lines).toEqual(['רדיוס (מטרים): 50', 'פעיל: לא', '2 נותני שירות מורשים'])
  })

  it('reads an older provider update, with a password that was not changed (nothing said)', async () => {
    const changed = await rowFor({ action: 'provider.update', entity: 'provider', entity_id: PROVIDER, entity_name: 'ניקיון', detail: { company: 'ניקיון', is_active: true, password_changed: true } }, 'עדכון נותן שירות')
    const lines = [...changed.querySelectorAll('.a-audit__detail > div')].map((d) => d.textContent)
    expect(lines).toEqual(['פעיל: כן', 'הסיסמה הוחלפה'])
    cleanup()
    const same = await rowFor({ action: 'provider.update', entity: 'provider', entity_id: PROVIDER, entity_name: 'ניקיון', detail: { company: 'ניקיון', password_changed: false } }, 'עדכון נותן שירות')
    expect(same.querySelector('.a-audit__detail')).toBeNull()
  })

  it('reads the older building update (the address as it was saved), the older enable (no detail) and the older unvoid', async () => {
    const building = await rowFor({ action: 'building.update', entity: 'building', entity_id: null, entity_name: null, detail: { address: 'רחוב הדוגמה 1' } }, 'עדכון כתובת הבניין')
    expect(building.querySelector('.a-audit__detail').textContent).toBe('כתובת: רחוב הדוגמה 1')
    cleanup()
    const enable = await rowFor({ action: 'admin.enable', entity: 'admin', entity_id: YOSSI.id, entity_name: 'yossi@example.test', detail: null }, 'הפעלת חבר ועד')
    expect(enable.querySelector('.a-audit__detail')).toBeNull()
    cleanup()
    const unvoid = await rowFor({ action: 'scan.unvoid', entity: 'scan', entity_id: 's1', entity_name: null, detail: { reason: null } }, 'שחזור נוכחות')
    expect(unvoid.querySelector('.a-audit__detail')).toBeNull()
  })
})

describe('an action that the screen has no words for', () => {
  it('is shown by its own name, in a neutral way, left to right, and its subject is still named', async () => {
    const row = await rowFor({ action: 'widget.frobnicate', entity: 'widget', entity_id: 'w1', entity_name: null, detail: { name: 'ווידג׳ט' } }, 'widget.frobnicate')
    const name = within(row).getByText('widget.frobnicate')
    expect(name.className).toContain('a-audit__action--raw')
    expect(name.getAttribute('dir')).toBe('ltr')
    expect(within(row).getByText('ווידג׳ט')).toBeTruthy()
  })

  it('does not break on an action that is not text, empty, or the name of something on every object', async () => {
    for (const action of [null, '', 'constructor', '__proto__', 'toString']) {
      server({ audit: page([entry({ action, entity_name: 'לובי' })]) })
      show()
      await screen.findByText('לובי', {}, WAIT)
      expect(document.querySelectorAll('.a-audit'), String(action)).toHaveLength(1)
      cleanup()
    }
  })
})

describe('what is never shown', () => {
  it('does not show a key of the detail that the screen does not know, or its value', async () => {
    const row = await rowFor({ detail: { note: 'a private note', foo: 'bar', extra_count: 7, nested: { deep: 'value' }, reason: 'visible' } }, 'עדכון נקודה')
    expect(row.textContent).toContain('סיבה: visible')
    for (const hidden of ['a private note', 'bar', 'private', 'deep', 'value', 'extra_count', 'foo', 'nested']) expect(row.textContent, hidden).not.toContain(hidden)
  })

  it('does not show a key that is not in the table of a change, whatever its name', async () => {
    const row = await rowFor({ detail: { changes: { surprise: { from: 'x', to: 'y' }, name: { from: 'ישן', to: 'חדש' } } } }, 'עדכון נקודה')
    expect(row.querySelector('.a-audit__detail').textContent).toBe('שם: ישן ← חדש')
  })

  it('never shows anything that looks like a key, a hash or a token, under a key with a secret name or under a known key', async () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const token = 'qrk_AbCdEfGhIjKlMnOpQrStUvWx'
    const session = 'qra_0123456789abcdefghijklmn'
    const row = await rowFor({
      detail: {
        password_hash: hash, token, api_key: token, key_prefix: 'qrk_ab12', secret: session, session,
        changes: { password_hash: { from: hash, to: hash }, name: { from: token, to: 'לובי' }, description: { from: null, to: hash } },
        reason: session, email: 'ok@example.test', scans_kept: 2,
      },
    }, 'עדכון נקודה')
    const text = document.body.textContent
    for (const secret of [hash, token, session, 'qrk_ab12', 'password_hash', 'api_key', 'key_prefix']) expect(text, secret).not.toContain(secret)
    // the lines that were safe are still there; a change that holds a secret on either side is left out whole
    expect(row.textContent).toContain('נוכחויות שנשארו בהיסטוריה: 2')
    expect(row.textContent).not.toContain('שם:')
    expect(row.textContent).not.toContain('תיאור:')
    expect(row.textContent).not.toContain('סיבה:')
  })

  it('does not show a secret as the name of the subject, or as the action of an unknown entry', async () => {
    const token = 'qrk_AbCdEfGhIjKlMnOpQrStUvWx'
    const row = await rowFor({ action: token, entity_name: null, entity: 'api_key', detail: { name: token } }, 'פעולה לא מוכרת')
    expect(row.textContent).not.toContain(token)
  })

  it('draws text as text: a detail that holds markup shows the characters, and makes no element', async () => {
    const row = await rowFor({ action: 'scan.void', entity: 'scan', entity_id: 's1', entity_name: null, detail: { reason: '<img src=x onerror=alert(1)><b>bold</b>' } }, 'ביטול נוכחות')
    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('b')).toBeNull()
    expect(row.textContent).toContain('<img src=x onerror=alert(1)><b>bold</b>')
  })

  it('knows what looks like a secret, and what does not', () => {
    for (const yes of ['qrk_abcdef123456', 'qra_ABCDEFGHIJ', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', '3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f', 'eyJhbGciOiJIUzI1NiJ9.abc123DEF456ghi789']) expect(looksSecret(yes), yes).toBe(true)
    for (const no of ['לובי', 'Lobby 2', 'נסרק בטעות', 'dana@example.test', 'point_name', 'a b c d e f g h i j k l m n o p q r s', 'Parking', 'ab_cd', '', null, 12, undefined]) expect(looksSecret(no), String(no)).toBe(false)
  })
})

describe('describeEntry', () => {
  it('survives any shape of detail: null, a list, a text, a number', () => {
    for (const detail of [null, undefined, [], ['a'], 'text', 12, true, {}]) {
      const described = describeEntry(entry({ detail }))
      expect(described.lines, JSON.stringify(detail)).toEqual([])
    }
  })

  it('survives a change whose sides are objects or lists, and a count that is not a number', () => {
    const described = describeEntry(entry({ detail: { changes: { name: { from: { a: 1 }, to: ['x'] }, lat: 'not an object' }, devices: '3', scans_kept: -1, provider_ids: 'x' } }))
    expect(described.lines).toEqual([])
  })
})

describe('the filters', () => {
  it('asks for the newest page with no filter at first', async () => {
    server({ audit: page([entry()]) })
    show()
    await screen.findByText('עדכון נקודה', {}, WAIT)
    expect(Object.fromEntries(lastParams())).toEqual({ limit: '50' })
    expect(auditCalls()).toHaveLength(1)
  })

  it('offers the committee members, by name or by e-mail, and the nine groups', async () => {
    server({ audit: page([entry()]) })
    show()
    await screen.findByRole('option', { name: 'דנה לוי' })
    expect(within(screen.getByLabelText('חבר ועד')).getAllByRole('option').map((o) => o.textContent)).toEqual(['כל החברים', 'דנה לוי', 'yossi@example.test'])
    expect(within(screen.getByLabelText('סוג פעולה')).getAllByRole('option').map((o) => o.textContent)).toEqual(GROUP_OPTIONS.map((g) => g.label))
  })

  it('asks with the group and the member that were chosen (the member by id)', async () => {
    server({ audit: page([entry()]) })
    show()
    await screen.findByRole('option', { name: 'דנה לוי' })
    fireEvent.change(screen.getByLabelText('סוג פעולה'), { target: { value: 'api_key' } })
    fireEvent.change(screen.getByLabelText('חבר ועד'), { target: { value: DANA.id } })
    await waitFor(() => expect(auditCalls()).toHaveLength(2), WAIT)
    expect(Object.fromEntries(lastParams())).toEqual({ group: 'api_key', actor_id: DANA.id, limit: '50' })
    // back to "all": the parameter is gone, not empty
    fireEvent.change(screen.getByLabelText('סוג פעולה'), { target: { value: '' } })
    await waitFor(() => expect(auditCalls()).toHaveLength(3), WAIT)
    expect(Object.fromEntries(lastParams())).toEqual({ actor_id: DANA.id, limit: '50' })
  })

  it('asks with the dates typed as DD/MM/YYYY as building days (YYYY-MM-DD), and only once a date is complete', async () => {
    server({ audit: page([entry()]) })
    show()
    await screen.findByText('עדכון נקודה', {}, WAIT)
    const from = screen.getByLabelText('מתאריך')
    const until = screen.getByLabelText('עד תאריך')
    expect(from.getAttribute('placeholder')).toBe('DD/MM/YYYY')
    expect(from.getAttribute('type')).toBe('text') // never the browser's own date field
    fireEvent.change(from, { target: { value: '0110' } }) // half a date: nothing is sent for it
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(auditCalls()).toHaveLength(1)
    fireEvent.change(from, { target: { value: '01102026' } })
    fireEvent.change(until, { target: { value: '05102026' } })
    await waitFor(() => expect(auditCalls()).toHaveLength(2), WAIT)
    expect(Object.fromEntries(lastParams())).toEqual({ from: '2026-10-01', to: '2026-10-05', limit: '50' })
    expect((from).value).toBe('01/10/2026')
  })

  it('shows no rows of the old filter under the new one while the new answer is on its way', async () => {
    let release
    server({ audit: (q) => (q.get('group') === 'point' ? new Promise((resolve) => { release = () => resolve({ entries: [entry({ action: 'point.delete' })], next_cursor: null }) }) : { entries: [entry({ action: 'scan.void', entity: 'scan', entity_name: null })], next_cursor: null }) })
    show()
    await screen.findByText('ביטול נוכחות', {}, WAIT)
    fireEvent.change(screen.getByLabelText('סוג פעולה'), { target: { value: 'point' } })
    await waitFor(() => expect(auditCalls()).toHaveLength(2), WAIT)
    expect(screen.queryByText('ביטול נוכחות')).toBeNull()
    release()
    await screen.findByText('מחיקת נקודה', {}, WAIT)
  })

  it('ignores an answer to a filter that is not the current one any more', async () => {
    const waiting = {}
    server({ audit: (q) => new Promise((resolve) => { waiting[q.get('group') ?? 'all'] = () => resolve({ entries: [entry({ action: q.get('group') === 'point' ? 'point.delete' : 'scan.void', entity_name: null })], next_cursor: null }) }) })
    show()
    await waitFor(() => expect(waiting.all).toBeTruthy(), WAIT)
    fireEvent.change(screen.getByLabelText('סוג פעולה'), { target: { value: 'point' } })
    await waitFor(() => expect(waiting.point).toBeTruthy(), WAIT)
    waiting.point()
    await screen.findByText('מחיקת נקודה', {}, WAIT)
    waiting.all() // the older answer arrives late
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText('ביטול נוכחות')).toBeNull()
    expect(screen.getByText('מחיקת נקודה')).toBeTruthy()
  })
})

describe('paging', () => {
  const first = [entry({ action: 'point.create' }), entry({ action: 'point.update' })]
  const second = [entry({ action: 'point.delete' })]

  it('loads the next page with the cursor, adds it below, and the button goes when there is no more', async () => {
    server({ audit: (q) => (q.get('cursor') === 'c1' ? { entries: second, next_cursor: null } : { entries: first, next_cursor: 'c1' }) })
    show()
    await screen.findByText('יצירת נקודה', {}, WAIT)
    expect(screen.queryByText('מחיקת נקודה')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'טעינת עוד' }))
    await screen.findByText('מחיקת נקודה', {}, WAIT)
    expect(Object.fromEntries(lastParams())).toEqual({ limit: '50', cursor: 'c1' })
    expect(screen.getByText('יצירת נקודה')).toBeTruthy() // the first page stays
    expect(screen.queryByRole('button', { name: 'טעינת עוד' })).toBeNull()
  })

  it('keeps the filters on the next page, and does not list an entry twice', async () => {
    server({ audit: (q) => (q.get('cursor') ? { entries: [first[1], ...second], next_cursor: null } : { entries: first, next_cursor: 'c1' }) })
    show()
    await screen.findByText('יצירת נקודה', {}, WAIT)
    fireEvent.change(screen.getByLabelText('סוג פעולה'), { target: { value: 'point' } })
    await waitFor(() => expect(auditCalls()).toHaveLength(2), WAIT)
    await screen.findByText('יצירת נקודה', {}, WAIT)
    fireEvent.click(await screen.findByRole('button', { name: 'טעינת עוד' }))
    await screen.findByText('מחיקת נקודה', {}, WAIT)
    expect(Object.fromEntries(lastParams())).toEqual({ group: 'point', limit: '50', cursor: 'c1' })
    expect(screen.getAllByText('עדכון נקודה')).toHaveLength(1)
  })

  it('says so, and keeps the rows, when a next page cannot be loaded', async () => {
    server({ audit: (q) => { if (q.get('cursor')) throw Object.assign(new Error('x'), { status: 400, code: 'invalid_cursor' }); return { entries: first, next_cursor: 'c1' } } })
    show()
    await screen.findByText('יצירת נקודה', {}, WAIT)
    fireEvent.click(screen.getByRole('button', { name: 'טעינת עוד' }))
    await screen.findByText('הרשימה השתנתה. רעננו ונסו שוב.', {}, WAIT)
    expect(screen.getByText('יצירת נקודה')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'טעינת עוד' })).toBeTruthy() // it can be tried again
  })
})

describe('an empty log, and one that could not load', () => {
  it('says that nothing was recorded yet, when there is no filter', async () => {
    server()
    show()
    await screen.findByRole('heading', { level: 2, name: 'עוד לא נרשמו פעולות' }, WAIT)
    expect(screen.queryByRole('button', { name: 'טעינת עוד' })).toBeNull()
  })

  it('says that nothing was found, when a filter is on', async () => {
    server()
    show()
    await screen.findByRole('heading', { name: 'עוד לא נרשמו פעולות' }, WAIT)
    fireEvent.change(screen.getByLabelText('סוג פעולה'), { target: { value: 'scan' } })
    await screen.findByRole('heading', { level: 2, name: 'אין פעולות בטווח הזה' }, WAIT)
    expect(screen.getByText('נסו להרחיב את טווח התאריכים או לשנות את הסינון.')).toBeTruthy()
  })

  it('says it could not load, with a way to try again that works', async () => {
    let fail = true
    server({ audit: () => { if (fail) throw Object.assign(new Error('x'), { status: 500, code: 'server_error' }); return { entries: [entry()], next_cursor: null } } })
    show()
    await screen.findByRole('heading', { level: 2, name: 'לא הצלחנו לטעון' }, WAIT)
    await screen.findByText('משהו השתבש. נסו שוב.') // the toast
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'נסו שוב' }))
    await screen.findByText('עדכון נקודה', {}, WAIT)
    expect(screen.queryByText('לא הצלחנו לטעון')).toBeNull()
  })

  it('reloads on the refresh button', async () => {
    server({ audit: page([entry()]) })
    show()
    await screen.findByText('עדכון נקודה', {}, WAIT)
    fireEvent.click(screen.getByRole('button', { name: 'רענון היומן' }))
    await waitFor(() => expect(auditCalls()).toHaveLength(2), WAIT)
  })
})

describe('the section of the Committee tab', () => {
  const committee = () => render(<ToastProvider><ConfirmProvider><CommitteeView admin={DANA} /></ConfirmProvider></ToastProvider>)
  const opener = () => screen.getByRole('button', { name: 'יומן פעולות' })

  it('is closed at first: a button "יומן פעולות", and nothing is asked of the server', async () => {
    server({ audit: page([entry()]) })
    committee()
    await screen.findByRole('heading', { level: 1, name: 'חברי הוועד' })
    expect(opener().getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('heading', { level: 2, name: 'יומן פעולות' }).contains(opener())).toBe(true)
    expect(auditCalls()).toHaveLength(0)
    expect(screen.queryByLabelText('סוג פעולה')).toBeNull()
  })

  it('opens the log with the button, and closes it with the same button', async () => {
    server({ audit: page([entry({ action: 'point.delete' })]) })
    committee()
    await screen.findByRole('heading', { level: 1, name: 'חברי הוועד' })
    fireEvent.click(opener())
    expect(opener().getAttribute('aria-expanded')).toBe('true')
    await screen.findByText('מחיקת נקודה', {}, WAIT)
    expect(auditCalls()).toHaveLength(1)
    const panel = document.getElementById(opener().getAttribute('aria-controls'))
    expect(panel.hidden).toBe(false)
    expect(within(panel).getByLabelText('סוג פעולה')).toBeTruthy()
    fireEvent.click(opener())
    expect(opener().getAttribute('aria-expanded')).toBe('false')
    expect(panel.hidden).toBe(true)
    expect(screen.queryByText('מחיקת נקודה')).toBeNull()
  })

  it('keeps the rest of the tab as it was: the members, the building, and the version', async () => {
    server({ audit: page([]) })
    committee()
    await screen.findByRole('heading', { level: 1, name: 'חברי הוועד' })
    expect(await screen.findByRole('heading', { level: 2, name: 'פרטי הבניין' })).toBeTruthy()
    // the log is the last section of the page, after the building and the version line
    const sections = [...document.querySelectorAll('section')]
    expect(sections.at(-1).className).toBe('a-audit-section')
  })
})
