// What the two apps report about their errors (server/routes/clientErrors.js, shared/contract.js section 9, docs/adr/0007, decision 3):
// POST /api/my/errors for the provider's phone and POST /api/admin/client-errors for the committee app. Both are recorded in
// app_errors through recordEvent only, with safe fields only. The data is fake. This file proves, through BOTH routes:
//   - an event is recorded with its source, kind, place, code (the code, else the name, else nothing), build and count, and the answer is
//     always 200 `{ ok: true, recorded }`, never a 400, whatever was sent;
//   - every rule of the validator: `events` that is not an array gives nothing, only the first 20 events are used, an event needs a
//     valid kind and a place of the list and of its own app (the other app's place is skipped), name, code and build are kept only in
//     their shape, a count is a whole number cut to 1..1000 (else 1), and a field that is not known is ignored;
//   - repeated events in the same hour aggregate into one row, and a count adds its number;
//   - a message, a stack, an address or a token in an event is never stored: the whole row is compared, and the answer echoes nothing;
//   - a crash or an unhandled error is the first error of the building day and pings once (through a fake fetch: nothing leaves the
//     process), together with the server's own errors; a signed-out event never pings and does not take the day;
//   - the guards: no credentials, or the other role's credentials, get a 401 and write nothing (tests/route-auth.test.js walks the same
//     routes, for every kind of credential, from the table of the router);
//   - the validator never throws and reads nothing past the first 20 events; recordEvent takes an optional count; noteAppError tells only
//     about the two apps and only with fields of the shape of a build.
// It runs against the throwaway schema like the other API tests.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { getPool, setPool } from '../server/db.js'
import { parseClientErrorReport } from '../server/routes/clientErrors.js'
import { noteAppError, noteServerError, resetAlertThrottle } from '../server/alerts.js'
import { recordEvent, EVENT_KINDS, EVENT_COUNT_MAX, PLACE_MAX_LENGTH } from '../server/errorLog.js'
import { ADMIN_COOKIE, ERROR_RECORD_TIMEOUT_MS } from '../server/config.js'
import { CLIENT_ERROR_KINDS, CLIENT_PLACES, MAX_CLIENT_ERROR_EVENTS, CLIENT_ERROR_MAX_COUNT } from '../shared/contract.js'

// Fake on purpose: the host ends in .test. A real address is a secret and never goes in a file.
const ADDRESS = 'https://hc.example.test/ping/00000000-0000-4000-8000-0000000000cc'
const PERSONAL = 'someone@example.com'
const SECRET = 'qrp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE000'
const ADDRESS_OF_A_PAGE = 'https://example.test/scan?code=BQR-FAKE0001'
const MESSAGE = `Cannot read properties of ${PERSONAL}`
const STACK = 'TypeError: x\n    at fake (https://example.test/assets/app.js:1:1)'
const BUILD = 'abc1234'
const REQUEST_ID = 'fra1::iad1::abcde-1700000000000-0123456789ab'

// 05/10/2026 14:03 in the building (Asia/Jerusalem is UTC+3 until the last Sunday of October).
const NOON = '2026-10-05T11:03:20Z'

let db
let cookie
let token

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  const password = 'fake-pass-' + randomUUID().slice(0, 6)
  const provider = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'Fake company', contact_name: 'Fake Person', password } })).json.provider
  const signedIn = await call('POST', '/api/session', { body: { provider_id: provider.id, password, device_label: '' } })
  expect(signedIn.status).toBe(200)
  token = signedIn.json.token
})
afterAll(async () => db?.teardown())

let saved
let pings
let faked = false

/** Replaces the fetch of the process by a fake that writes down what it was asked and answers 200. Nothing leaves the process. */
function stubFetch() {
  pings = []
  vi.stubGlobal('fetch', (url, init) => {
    pings.push({ url: String(url), method: init?.method, body: init?.body })
    return Promise.resolve({ status: 200, body: { cancel: async () => {} } })
  })
}

/** Freezes the clock of the process (only the date: timers stay real) at `iso`, or moves it. */
function at(iso) {
  if (!faked) {
    vi.useFakeTimers({ toFake: ['Date'] })
    faked = true
  }
  vi.setSystemTime(new Date(iso))
}

beforeEach(async () => {
  saved = process.env.HEALTH_HEARTBEAT_URL
  stubFetch()
  resetAlertThrottle()
  await db.pool.query('delete from alert_pings')
  await db.pool.query('delete from app_errors')
})
afterEach(() => {
  if (saved === undefined) delete process.env.HEALTH_HEARTBEAT_URL
  else process.env.HEALTH_HEARTBEAT_URL = saved
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  faked = false
  setPool(db.pool)
})

/** Makes the server ping the fake address (every other test runs without one, as the whole suite does). */
const withAddress = () => {
  process.env.HEALTH_HEARTBEAT_URL = ADDRESS
}

const COLUMNS = 'source, kind, place, method, status, code, app_build, count'
const rows = async () => (await db.pool.query(`select ${COLUMNS} from app_errors order by id`)).rows
const days = async () => (await db.pool.query('select day from alert_pings order by day')).rows.map((r) => r.day)
const bodies = () => pings.map((p) => p.body)

// The two endpoints. `home` is a place of the app that the endpoint serves, `other` is a place of the other app.
const ROUTES = [
  { label: 'POST /api/my/errors (the provider)', source: 'provider_app', path: '/api/my/errors', home: 'provider:home', other: 'committee:points', credentials: () => ({ token }) },
  { label: 'POST /api/admin/client-errors (the committee)', source: 'committee_app', path: '/api/admin/client-errors', home: 'committee:points', other: 'provider:home', credentials: () => ({ cookie }) },
]
const send = (r, body, extra = {}) => call('POST', r.path, { ...r.credentials(), body, ...extra })

describe.each(ROUTES)('$label: what is recorded', (r) => {
  it('records an event with its source, kind, place, name, build and count, and answers 200 with the number taken', async () => {
    const res = await send(r, { events: [{ kind: 'crash', place: r.home, name: 'TypeError', build: BUILD }] })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, recorded: 1 })
    expect(await rows()).toEqual([{ source: r.source, kind: 'crash', place: r.home, method: '', status: 0, code: 'TypeError', app_build: BUILD, count: 1 }])
  })

  it('takes every kind and every place of its own app', async () => {
    const places = CLIENT_PLACES.filter((place) => place.startsWith(r.home.split(':')[0] + ':'))
    const events = CLIENT_ERROR_KINDS.flatMap((kind) => places.map((place) => ({ kind, place })))
    expect(events.length).toBeLessThanOrEqual(MAX_CLIENT_ERROR_EVENTS * 2)
    for (let i = 0; i < events.length; i += MAX_CLIENT_ERROR_EVENTS) {
      const chunk = events.slice(i, i + MAX_CLIENT_ERROR_EVENTS)
      const res = await send(r, { events: chunk })
      expect(res.json).toEqual({ ok: true, recorded: chunk.length })
    }
    const stored = (await rows()).map((row) => `${row.kind} ${row.place}`).sort()
    expect(stored).toEqual(events.map((e) => `${e.kind} ${e.place}`).sort())
  })

  it('stores the code of an event, else its name, else nothing', async () => {
    await send(r, {
      events: [
        { kind: 'crash', place: r.home, code: 'invalid_session', name: 'TypeError' },
        { kind: 'unhandled', place: r.home, name: 'RangeError' },
        { kind: 'signed_out', place: r.home },
      ],
    })
    expect((await rows()).map((row) => [row.kind, row.code])).toEqual([
      ['crash', 'invalid_session'],
      ['unhandled', 'RangeError'],
      ['signed_out', ''],
    ])
  })

  it('keeps a name, a code and a build only in their shape, and still takes the event', async () => {
    const wrong = [
      { name: 'a name typed by somebody', code: 'Not A Code', build: 'ABCDEFG' },
      { name: '9Lives', code: 'UPPER_CASE', build: 'abc123' },
      { name: 'N'.repeat(65), code: 'c'.repeat(41), build: 'abc12345' },
      { name: PERSONAL, code: PERSONAL, build: 'DEV' },
      { name: 42, code: {}, build: [BUILD] },
      { name: null, code: true, build: 7 },
    ]
    const res = await send(r, { events: wrong.map((fields) => ({ kind: 'unhandled', place: r.home, ...fields })) })
    expect(res.json).toEqual({ ok: true, recorded: wrong.length })
    expect(await rows()).toEqual([{ source: r.source, kind: 'unhandled', place: r.home, method: '', status: 0, code: '', app_build: '', count: wrong.length }])
    // The edges of each shape are accepted.
    await db.pool.query('delete from app_errors')
    await send(r, {
      events: [
        { kind: 'unhandled', place: r.home, name: 'N'.repeat(64) },
        { kind: 'unhandled', place: r.home, name: 'Err$or_1', build: 'dev' },
        { kind: 'unhandled', place: r.home, code: 'c'.repeat(40), build: '0123abc' },
      ],
    })
    const stored = await rows()
    expect(stored.map((row) => row.code)).toEqual(['N'.repeat(60), 'Err$or_1', 'c'.repeat(40)]) // the column keeps 60 characters of a name
    expect(stored.map((row) => row.app_build)).toEqual(['', 'dev', '0123abc'])
  })

  it('skips an event without a valid kind or a valid place, and takes the others of the same report', async () => {
    const skipped = [
      { place: r.home },
      { kind: 'crash' },
      { kind: 'error', place: r.home }, // a kind of the server, not of an app
      { kind: 'refusal', place: r.home },
      { kind: 'CRASH', place: r.home },
      { kind: 5, place: r.home },
      { kind: null, place: r.home },
      { kind: 'crash', place: 'provider:nowhere' },
      { kind: 'crash', place: 'committee:' },
      { kind: 'crash', place: 'Provider:home' },
      { kind: 'crash', place: `${r.home} ` },
      { kind: 'crash', place: '/admin/points/:id' },
      { kind: 'crash', place: 5 },
      { kind: 'crash', place: { toString: () => r.home } },
      null,
      'crash',
      5,
      true,
      [],
      [{ kind: 'crash', place: r.home }],
    ]
    // The valid one is among the first 20 (only those are looked at), with 10 skipped ones before it and 10 after.
    const res = await send(r, { events: [...skipped.slice(0, 10), { kind: 'crash', place: r.home, name: 'TypeError' }, ...skipped.slice(10)] })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, recorded: 1 })
    expect(await rows()).toEqual([{ source: r.source, kind: 'crash', place: r.home, method: '', status: 0, code: 'TypeError', app_build: '', count: 1 }])
  })

  it('skips a place of the other app', async () => {
    const res = await send(r, { events: [{ kind: 'crash', place: r.other, name: 'TypeError' }] })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, recorded: 0 })
    expect(await rows()).toEqual([])
  })

  it('takes nothing, and still answers 200, when `events` is not an array or the body is not an object', async () => {
    const event = { kind: 'crash', place: r.home, name: 'TypeError' }
    for (const body of [{}, { events: null }, { events: 'crash' }, { events: 5 }, { events: event }, { events: { 0: event, length: 1 } }, [event], 'crash', 5, null]) {
      const res = await send(r, body)
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(res.json, JSON.stringify(body)).toEqual({ ok: true, recorded: 0 })
    }
    expect(await rows()).toEqual([])
  })

  it('uses only the first 20 events: 25 events give 20 recorded', async () => {
    const events = Array.from({ length: 25 }, (_, i) => ({ kind: 'unhandled', place: r.home, name: `Error${i}` }))
    const res = await send(r, { events })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, recorded: 20 })
    expect((await rows()).map((row) => row.code).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `Error${i}`).sort())
  })

  it('looks at the first 20 only, so a report whose first 20 are not valid gives nothing, whatever follows', async () => {
    const events = [...Array.from({ length: 20 }, () => ({ kind: 'nope', place: r.home })), ...Array.from({ length: 5 }, () => ({ kind: 'crash', place: r.home }))]
    const res = await send(r, { events })
    expect(res.json).toEqual({ ok: true, recorded: 0 })
    expect(await rows()).toEqual([])
  })

  it('takes a count that is a whole number, cut to 1..1000, and 1 for anything else', async () => {
    const cases = [
      [5, 5],
      [1, 1],
      [1000, 1000],
      [1001, 1000],
      [5000, 1000],
      [1e21, 1000],
      [0, 1],
      [-3, 1],
      [2.5, 1],
      ['7', 1],
      [null, 1],
      [NaN, 1],
      [Infinity, 1],
      [[3], 1],
      [{ valueOf: () => 4 }, 1],
      [undefined, 1],
    ]
    const events = cases.map(([count], i) => ({ kind: 'unhandled', place: r.home, name: `Case${i}`, ...(count === undefined ? {} : { count }) }))
    const res = await send(r, { events })
    expect(res.json).toEqual({ ok: true, recorded: cases.length })
    const stored = Object.fromEntries((await rows()).map((row) => [row.code, row.count]))
    cases.forEach(([count, expected], i) => expect(stored[`Case${i}`], `count ${String(count)}`).toBe(expected))
  })

  it('adds the count of an event to the row of the hour, and aggregates repeated events into one row', async () => {
    const event = { kind: 'crash', place: r.home, name: 'TypeError', build: BUILD }
    await send(r, { events: [{ ...event, count: 2 }] })
    await send(r, { events: [{ ...event, count: 5 }] })
    expect(await rows()).toEqual([{ source: r.source, kind: 'crash', place: r.home, method: '', status: 0, code: 'TypeError', app_build: BUILD, count: 7 }])
    // Two of them in one report, and one more without a count: 7 + 3 + 1 + 1.
    await send(r, { events: [{ ...event, count: 3 }, event] })
    await send(r, { events: [event] })
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0].count).toBe(12)
    // A different name, build, place or kind is another row.
    await send(r, { events: [{ ...event, name: 'RangeError' }, { ...event, build: 'dev' }, { ...event, kind: 'unhandled' }, { ...event, place: r.home.replace(/:.*/, ':app') }] })
    expect(await rows()).toHaveLength(5)
  })

  it('ignores a field that it does not know, and a newer app that sends more still gets its 200', async () => {
    const res = await send(r, {
      events: [{ kind: 'crash', place: r.home, name: 'TypeError', severity: 'fatal', extra: { deep: [1, 2, 3] } }],
      version: 3,
      note: 'from a newer app',
    })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, recorded: 1 })
    expect(await rows()).toEqual([{ source: r.source, kind: 'crash', place: r.home, method: '', status: 0, code: 'TypeError', app_build: '', count: 1 }])
  })

  it('stores nothing but the whitelist: a message, a stack, an address or a token in an event never reaches the table, the answer or the log', async () => {
    const logged = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    for (const spy of logged) spy.mockClear()
    const res = await send(r, {
      events: [
        {
          kind: 'crash',
          place: r.home,
          name: 'TypeError',
          message: MESSAGE,
          stack: STACK,
          componentStack: STACK,
          url: ADDRESS_OF_A_PAGE,
          href: ADDRESS_OF_A_PAGE,
          token: SECRET,
          authorization: `Bearer ${SECRET}`,
          user: PERSONAL,
          qr_code: 'BQR-FAKE0001',
          gps: { lat: 32.0853, lng: 34.7818 },
          body: { name: 'Fake Person' },
          count: 2,
        },
      ],
      message: MESSAGE,
      token: SECRET,
    }, { headers: { 'x-vercel-id': REQUEST_ID } }) // the id of the report's own request: it says nothing about the failure, so it is not stored
    expect(res.json).toEqual({ ok: true, recorded: 1 })
    expect(res.text).toBe('{"ok":true,"recorded":1}')
    const stored = (await db.pool.query('select to_jsonb(e) as row from app_errors e')).rows
    expect(stored).toHaveLength(1)
    const { id, bucket, first_at: firstAt, last_at: lastAt, ...row } = stored[0].row
    expect([typeof id, typeof bucket, typeof firstAt, typeof lastAt]).toEqual(['number', 'string', 'string', 'string'])
    // The whole row, every column: nothing in it but the whitelist.
    expect(row).toEqual({ source: r.source, kind: 'crash', place: r.home, method: '', status: 0, code: 'TypeError', app_build: '', count: 2, last_request_id: null })
    const everything = JSON.stringify([stored, res.json, res.text, ...logged.flatMap((spy) => spy.mock.calls)])
    for (const value of [MESSAGE, PERSONAL, 'Cannot read', STACK, 'app.js', ADDRESS_OF_A_PAGE, 'example.test', SECRET, 'qrp_', 'BQR-', 'Fake Person', '32.0853', '34.7818']) {
      expect(everything, value).not.toContain(value)
    }
    for (const spy of logged) expect(spy).not.toHaveBeenCalled()
  })

})

describe.each(ROUTES)('$label: a database that is not at its best', (r) => {
  const many = () => ({ events: Array.from({ length: 5 }, (_, i) => ({ kind: 'unhandled', place: r.home, name: `Error${i}` })) })
  /** Runs the guard and everything else on the real pool, and gives `insert` the statement that writes app_errors. */
  const withInsert = (insert) => {
    const real = getPool()
    setPool({ query: (text, params, options) => (/insert into app_errors/.test(text) ? insert() : real.query(text, params, options)) })
  }

  it('holds the request for one wait and not for one for each event when the inserts do not answer, and still answers 200', async () => {
    let inserts = 0
    withInsert(() => {
      inserts++
      return new Promise(() => {}) // never answers: recordEvent gives up after ERROR_RECORD_TIMEOUT_MS
    })
    const started = Date.now()
    const res = await send(r, many())
    const took = Date.now() - started
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, recorded: 5 })
    expect(inserts).toBe(1)
    expect(took).toBeGreaterThanOrEqual(ERROR_RECORD_TIMEOUT_MS - 50)
    expect(took).toBeLessThan(ERROR_RECORD_TIMEOUT_MS * 2.5) // five waits would be 7.5 seconds
  })

  it('goes on with the next event when an insert fails fast, and answers 200', async () => {
    const real = getPool()
    let inserts = 0
    setPool({
      query: (text, params, options) => {
        if (!/insert into app_errors/.test(text)) return real.query(text, params, options)
        inserts++
        return inserts === 1 ? Promise.reject(Object.assign(new Error(`could not write the row of ${PERSONAL}`), { code: 'XX000' })) : real.query(text, params, options)
      },
    })
    const logged = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const res = await send(r, many())
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, recorded: 5 }) // the events that were taken, not the rows that were written
    expect(inserts).toBe(5)
    expect((await rows()).map((row) => row.code).sort()).toEqual(['Error1', 'Error2', 'Error3', 'Error4'])
    for (const spy of logged) expect(spy).not.toHaveBeenCalled()
  })

  it('skips the record, without a query and without waiting, when the pool is busy, and answers 200', async () => {
    const real = getPool()
    const statements = []
    // The guard needs the real pool, so the pool turns busy at its first statement of app_errors: every statement is passed on, and
    // what recordEvent sees is the state that this double reports.
    setPool({
      options: { max: 3 },
      idleCount: 0,
      totalCount: 3,
      waitingCount: 0,
      query: (text, params, options) => (statements.push(String(text)), real.query(text, params, options)),
    })
    const res = await send(r, many())
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, recorded: 5 })
    expect(statements.filter((text) => /app_errors/.test(text))).toEqual([])
    expect(await rows()).toEqual([])
  })
})

describe.each(ROUTES)('$label: the guard', (r) => {
  const event = () => ({ events: [{ kind: 'crash', place: r.home, name: 'TypeError' }] })
  const code = r.source === 'provider_app' ? 'invalid_session' : 'admin_required'

  it('refuses a request without credentials with a 401 and writes nothing', async () => {
    const res = await call('POST', r.path, { body: event() })
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe(code)
    expect(await rows()).toEqual([])
    expect(await days()).toEqual([])
  })

  it('refuses the valid credentials of the other role, in either place, and writes nothing', async () => {
    const sessionValue = cookie.slice(cookie.indexOf('=') + 1)
    // The provider route reads a bearer token and the committee route a cookie, so the other role's secret is tried the way it
    // normally travels and the wrong way round.
    const others = r.source === 'provider_app' ? [{ cookie }, { token: sessionValue }] : [{ token }, { cookie: `${ADMIN_COOKIE}=${token}` }]
    for (const [i, credentials] of others.entries()) {
      const res = await call('POST', r.path, { body: event(), ...credentials })
      expect(res.status, `try ${i}`).toBe(401)
      expect(res.json.error.code, `try ${i}`).toBe(code)
    }
    expect(await rows()).toEqual([])
  })
})

describe.each(ROUTES)('$label: the alert for a crash', (r) => {
  const crash = (extra = {}) => ({ events: [{ kind: 'crash', place: r.home, name: 'TypeError', build: BUILD, ...extra }] })
  const FIRST_LINE = `First app error today, 05/10/2026 14:03: ${r.home} TypeError (build ${BUILD})`

  it('pings once for the first crash of the building day, with the screen key, the name and the build, and takes the day', async () => {
    withAddress()
    at(NOON)
    const res = await send(r, crash())
    expect(res.json).toEqual({ ok: true, recorded: 1 })
    expect(pings).toHaveLength(1)
    expect(pings[0]).toEqual({ url: `${ADDRESS}/fail`, method: 'POST', body: FIRST_LINE })
    expect(await days()).toEqual(['2026-10-05'])
    // The second one of the same day, of either kind, sends nothing more; both are recorded.
    await send(r, crash())
    await send(r, { events: [{ kind: 'unhandled', place: r.home, name: 'RangeError' }] })
    at('2026-10-05T20:59:59Z') // the last second of the building day
    await send(r, crash({ name: 'SyntaxError' }))
    expect(pings).toHaveLength(1)
    expect((await rows()).reduce((sum, row) => sum + row.count, 0)).toBe(4)
  })

  it('pings again on a new building day, which turns at midnight in the building and not at midnight UTC', async () => {
    withAddress()
    at('2026-10-05T20:30:00Z') // 23:30 on the 5th in the building
    await send(r, crash())
    at('2026-10-05T21:30:00Z') // 00:30 on the 6th in the building, still the 5th in UTC
    await send(r, crash())
    at('2026-10-06T08:00:00Z') // the same day as the one before
    await send(r, crash())
    expect(bodies()).toEqual([
      `First app error today, 05/10/2026 23:30: ${r.home} TypeError (build ${BUILD})`,
      `First app error today, 06/10/2026 00:30: ${r.home} TypeError (build ${BUILD})`,
    ])
    expect(await days()).toHaveLength(2)
  })

  it('also pings for an unhandled error, with its code in place of its name', async () => {
    withAddress()
    at(NOON)
    await send(r, { events: [{ kind: 'unhandled', place: r.home, name: 'TypeError', code: 'invalid_session' }] })
    expect(bodies()).toEqual([`First app error today, 05/10/2026 14:03: ${r.home} invalid_session`])
  })

  it('never pings for a signed-out event, and does not take the day: a crash after it still pings', async () => {
    withAddress()
    at(NOON)
    await send(r, { events: [{ kind: 'signed_out', place: r.home, code: 'invalid_session', build: BUILD }] })
    await send(r, { events: [{ kind: 'signed_out', place: r.home, code: 'invalid_session', count: 40 }] })
    expect(pings).toEqual([])
    expect(await days()).toEqual([])
    expect((await rows()).reduce((sum, row) => sum + row.count, 0)).toBe(41)
    await send(r, crash())
    expect(bodies()).toEqual([FIRST_LINE])
  })

  it('pings once for a report with several crashes, for the first of them, and not for the signed-out events before it', async () => {
    withAddress()
    at(NOON)
    await send(r, {
      events: [
        { kind: 'signed_out', place: r.home },
        { kind: 'crash', place: r.home, name: 'TypeError' },
        { kind: 'unhandled', place: r.home.replace(/:.*/, ':app'), name: 'RangeError' },
      ],
    })
    expect(bodies()).toEqual([`First app error today, 05/10/2026 14:03: ${r.home} TypeError`])
  })

  it('shares the day with a server error: whichever comes first is the only one that pings', async () => {
    withAddress()
    at(NOON)
    await noteServerError({ place: '/scans/sync', method: 'POST', code: '57014' })
    await send(r, crash())
    expect(bodies()).toEqual(['First server error today, 05/10/2026 14:03: POST /scans/sync 57014'])
    pings.length = 0
    await db.pool.query('delete from alert_pings')
    await send(r, crash())
    await noteServerError({ place: '/scans/sync', method: 'POST', code: '57014' })
    expect(bodies()).toEqual([FIRST_LINE])
    expect(await days()).toEqual(['2026-10-05'])
  })

  it('sends nothing, and takes no day, without an address (every preview, local run and test), and still records the crash', async () => {
    at(NOON)
    expect(process.env.HEALTH_HEARTBEAT_URL).toBe('')
    const res = await send(r, crash())
    expect(res.json).toEqual({ ok: true, recorded: 1 })
    expect(pings).toEqual([])
    expect(await days()).toEqual([])
    expect(await rows()).toHaveLength(1)
  })

  it('sends a line with nothing but the key, the name or code, the build and the time', async () => {
    withAddress()
    at(NOON)
    await send(r, { events: [{ kind: 'crash', place: r.home, name: 'TypeError', build: BUILD, message: MESSAGE, stack: STACK, url: ADDRESS_OF_A_PAGE, token: SECRET }] })
    expect(bodies()).toEqual([FIRST_LINE])
    const everything = JSON.stringify(pings)
    for (const value of [MESSAGE, PERSONAL, STACK, ADDRESS_OF_A_PAGE, SECRET]) expect(everything, value).not.toContain(value)
    expect(pings[0].body).toMatch(/^First app error today, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}: /)
  })
})

describe('noteAppError', () => {
  const EVENT = { source: 'provider_app', place: 'provider:home', code: 'TypeError', build: BUILD }

  it('tells about the two apps and not about the server, and ignores a source that it does not know', async () => {
    withAddress()
    at(NOON)
    for (const source of ['server', 'nobody', '', undefined, 5, null, {}]) await noteAppError({ ...EVENT, source })
    expect(pings).toEqual([])
    expect(await days()).toEqual([])
    await noteAppError({ ...EVENT, source: 'committee_app', place: 'committee:app' })
    expect(bodies()).toEqual([`First app error today, 05/10/2026 14:03: committee:app TypeError (build ${BUILD})`])
  })

  it('leaves a build out of the line unless it has the shape of a build id, and a code that is missing', async () => {
    withAddress()
    at(NOON)
    await noteAppError({ ...EVENT, build: `${BUILD}\nFake: 1` })
    expect(bodies()).toEqual(['First app error today, 05/10/2026 14:03: provider:home TypeError'])
    for (const [build, code, written] of [
      [undefined, undefined, 'provider:home'],
      ['dev', '', 'provider:home (build dev)'],
      [PERSONAL, 'x', 'provider:home x'],
    ]) {
      await db.pool.query('delete from alert_pings')
      pings.length = 0
      await noteAppError({ ...EVENT, build, code })
      expect(bodies()).toEqual([`First app error today, 05/10/2026 14:03: ${written}`])
    }
  })

  it('never throws and never logs, whatever it is given', async () => {
    withAddress()
    const logged = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const hostile = { get source() { throw new Error('no') } }
    for (const event of [undefined, null, 5, 'x', [], {}, hostile, { source: 'provider_app', place: {}, code: {}, build: {} }]) {
      resetAlertThrottle()
      await expect(noteAppError(event)).resolves.toBeUndefined()
    }
    for (const spy of logged) expect(spy).not.toHaveBeenCalled()
  })

  it('says so, with the same wording of the way out, when the pool is busy: one ping an hour, never a query', async () => {
    withAddress()
    at(NOON)
    const queries = []
    setPool({ options: { max: 3 }, idleCount: 0, totalCount: 3, waitingCount: 0, query: (...args) => (queries.push(args), Promise.reject(new Error('the pool is busy'))) })
    await noteAppError(EVENT)
    await noteAppError(EVENT)
    expect(bodies()).toEqual([`App error, database busy, 05/10/2026 14:03: provider:home TypeError (build ${BUILD})`])
    expect(queries).toEqual([])
  })

  it('says "Database unreachable" when the insert cannot reach the database, without the code or the build', async () => {
    withAddress()
    at(NOON)
    setPool({
      options: { max: 3 },
      idleCount: 1,
      totalCount: 1,
      waitingCount: 0,
      connect: () => Promise.reject(Object.assign(new Error(`connect ECONNREFUSED for ${PERSONAL}`), { code: 'ECONNREFUSED' })),
      query: () => Promise.reject(Object.assign(new Error(`connect ECONNREFUSED for ${PERSONAL}`), { code: 'ECONNREFUSED' })),
    })
    await noteAppError(EVENT)
    expect(bodies()).toEqual(['Database unreachable, 05/10/2026 14:03: provider:home'])
    expect(JSON.stringify(pings)).not.toContain(PERSONAL)
  })
})

describe('recordEvent with a count', () => {
  const base = { source: 'provider_app', kind: 'crash', place: 'provider:home', code: 'TypeError' }

  it('adds 1 when no count is given, as it always did, and the number of the count when one is', async () => {
    await recordEvent(base)
    await recordEvent(base)
    expect((await rows())[0].count).toBe(2)
    await recordEvent({ ...base, count: 5 })
    expect((await rows())[0].count).toBe(7)
    await recordEvent({ ...base, count: 1 })
    expect(await rows()).toHaveLength(1)
    expect((await rows())[0].count).toBe(8)
  })

  it('makes a row with the count of its first event, and the count is not part of the key', async () => {
    await recordEvent({ ...base, count: 40 })
    await recordEvent({ ...base, count: 2 })
    expect(await rows()).toEqual([{ source: 'provider_app', kind: 'crash', place: 'provider:home', method: '', status: 0, code: 'TypeError', app_build: '', count: 42 }])
  })

  it('takes a whole number from 1 to the cap, and 1 for anything else', async () => {
    const cases = [
      [EVENT_COUNT_MAX, EVENT_COUNT_MAX],
      [EVENT_COUNT_MAX + 1, EVENT_COUNT_MAX],
      [Number.MAX_SAFE_INTEGER, EVENT_COUNT_MAX],
      [0, 1],
      [-5, 1],
      [1.5, 1],
      ['3', 1],
      [NaN, 1],
      [Infinity, 1],
      [null, 1],
      [undefined, 1],
      [{}, 1],
    ]
    for (const [i, [count]] of cases.entries()) await recordEvent({ ...base, code: `Case${i}`, count })
    const stored = Object.fromEntries((await rows()).map((row) => [row.code, row.count]))
    cases.forEach(([count, expected], i) => expect(stored[`Case${i}`], `count ${String(count)}`).toBe(expected))
    expect(EVENT_COUNT_MAX).toBe(CLIENT_ERROR_MAX_COUNT)
  })
})

describe('parseClientErrorReport', () => {
  const home = { kind: 'crash', place: 'provider:home' }

  it('returns the events of the app that it is asked for, with the fields that have their shape and a count', () => {
    expect(parseClientErrorReport({ events: [{ ...home, name: 'TypeError', code: 'x_1', build: BUILD, count: 3, message: MESSAGE }] }, 'provider_app')).toEqual([
      { kind: 'crash', place: 'provider:home', name: 'TypeError', code: 'x_1', build: BUILD, count: 3 },
    ])
    expect(parseClientErrorReport({ events: [home] }, 'provider_app')).toEqual([{ kind: 'crash', place: 'provider:home', name: undefined, code: undefined, build: undefined, count: 1 }])
    expect(parseClientErrorReport({ events: [home] }, 'committee_app')).toEqual([])
    expect(parseClientErrorReport({ events: [{ kind: 'signed_out', place: 'committee:app' }] }, 'committee_app')).toHaveLength(1)
  })

  it('takes nothing for a source that is not one of the two apps, also one that is a property of every object', () => {
    for (const source of ['server', '', undefined, null, 5, '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(parseClientErrorReport({ events: [home] }, source), String(source)).toEqual([])
    }
  })

  it('never throws, whatever the body is, and returns a list', () => {
    const circular = { events: [] }
    circular.events.push(circular)
    const hostile = {
      get events() {
        throw new Error('no')
      },
    }
    const hostileEvent = { events: [{ get kind() { throw new Error('no') } }] }
    const proxy = new Proxy({}, { get() { throw new Error('no') }, has() { throw new Error('no') }, ownKeys() { throw new Error('no') } })
    for (const body of [undefined, null, 0, '', 'x', true, [], [home], {}, { events: [] }, circular, hostile, hostileEvent, proxy, Object.create(null), { events: Object.create(null) }, { events: new Proxy([], { get() { throw new Error('no') } }) }]) {
      for (const source of ['provider_app', 'committee_app']) expect(Array.isArray(parseClientErrorReport(body, source))).toBe(true)
    }
  })

  it('reads nothing past the first 20 events', () => {
    let touched = 0
    const watched = () => ({
      get kind() {
        touched++
        return 'crash'
      },
      place: 'provider:home',
    })
    const events = [...Array.from({ length: MAX_CLIENT_ERROR_EVENTS }, () => ({ ...home })), ...Array.from({ length: 1000 }, watched)]
    expect(parseClientErrorReport({ events }, 'provider_app')).toHaveLength(MAX_CLIENT_ERROR_EVENTS)
    expect(touched).toBe(0)
  })
})

describe('the lists of the contract', () => {
  it('every kind that an app reports is a kind that app_errors accepts, and the table takes it', async () => {
    for (const kind of CLIENT_ERROR_KINDS) expect(EVENT_KINDS, kind).toContain(kind)
    for (const kind of CLIENT_ERROR_KINDS) {
      await recordEvent({ source: 'provider_app', kind, place: 'provider:app' })
    }
    expect((await rows()).map((row) => row.kind).sort()).toEqual([...CLIENT_ERROR_KINDS].sort())
  })

  it('every place is one key of an app, fits the column, appears once, and is accepted by the table', async () => {
    expect(new Set(CLIENT_PLACES).size).toBe(CLIENT_PLACES.length)
    for (const place of CLIENT_PLACES) {
      expect(place, place).toMatch(/^(?:provider|committee):[a-z]+$/)
      expect(place.length, place).toBeLessThanOrEqual(PLACE_MAX_LENGTH)
      await recordEvent({ source: place.startsWith('provider:') ? 'provider_app' : 'committee_app', kind: 'crash', place })
    }
    expect((await rows()).map((row) => row.place).sort()).toEqual([...CLIENT_PLACES].sort())
  })

  it('has the fallback of each app, the sign-in screen of each, and a key for each tab of the committee app', () => {
    for (const place of ['provider:app', 'committee:app', 'provider:login', 'committee:login']) expect(CLIENT_PLACES).toContain(place)
    const source = fs.readFileSync(fileURLToPath(new URL('../src/pages/AdminApp.jsx', import.meta.url)), 'utf8')
    const tabs = /const TABS = \[([\s\S]*?)\n\]/.exec(source)?.[1]
    expect(tabs, 'the TABS of src/pages/AdminApp.jsx').toBeTruthy()
    const keys = [...tabs.matchAll(/key: '([a-z]+)'/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(CLIENT_PLACES, `a tab of the committee app (${key}) has no key`).toContain(`committee:${key}`)
    const committee = CLIENT_PLACES.filter((place) => place.startsWith('committee:')).map((place) => place.slice('committee:'.length))
    for (const key of committee) expect([...keys, 'login', 'app'], `committee:${key} is not a tab`).toContain(key)
  })
})
