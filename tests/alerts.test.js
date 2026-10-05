// The first server error of a building day alerts the owner (server/alerts.js, server/heartbeat.js,
// db/migrations/011_alert_pings.sql, docs/adr/0007). The host has no alerts and the owner's computer is not always on, so the
// server pings its check on healthchecks.io at /fail, once a day, and once an hour (per function instance) when the database is
// the failure. Nothing here reaches the network: the address is fake, and the fetch of the process is replaced by a fake that
// writes down what it was asked. The data is fake too. This file proves:
//   - the first error of a building day sends exactly one /fail, a second error the same day sends nothing, a new building
//     day (in the building's time zone, not UTC's) sends again, and of errors that arrive together exactly one sends;
//   - what is sent is one line: the route as written in the code, the method, the code, and the time as DD/MM/YYYY HH:MM in the
//     building's time. Never the message of an error, a personal value in it, the path that was asked for or the request id;
//   - without HEALTH_HEARTBEAT_URL (or with an address that is not usable) nothing happens, not even a database statement;
//   - a connection failure makes no database statement, pings once, and not again within the hour; an insert that fails or
//     hangs takes the same way out; the whole call stays inside its bound even when the database and the fetch both hang;
//   - noteServerError never throws and never logs;
//   - through the router: a 500 sends one ping and is still answered with the same body and logged exactly once, and a
//     refusal, an Answer, a 404 and a request that its guard refused send nothing and make no statement.
// It runs against the throwaway schema like the other API tests. The routes below exist only for this file (they answer without
// credentials: the same vi.mock of server/access.js as tests/error-log.test.js, which changes the module only inside this
// file's own module graph).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupDb, call } from './helpers.js'
import { route } from '../server/router.js'
import { getPool, setPool } from '../server/db.js'
import { noteServerError, resetAlertThrottle, ALERT_LIMITS } from '../server/alerts.js'
import {
  ALERT_DB_TIMEOUT_MS,
  ALERT_LOCK_TIMEOUT_MS,
  ALERT_TOTAL_TIMEOUT_MS,
  ALERT_UNREACHABLE_INTERVAL_MS,
  ERROR_RECORD_LOCK_TIMEOUT_MS,
  ERROR_RECORD_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
} from '../server/config.js'
import { Answer, bad } from '../server/http.js'

vi.mock('../server/access.js', async (importOriginal) => {
  const real = await importOriginal()
  const open = Object.freeze({ public: true })
  return { ...real, accessFor: (method, pattern) => (pattern.startsWith('/test/') ? open : real.accessFor(method, pattern)) }
})

// Fake on purpose: the host ends in .test, and the "uuid" is made up. A real address is a secret and never goes in a file.
const ADDRESS = 'https://hc.example.test/ping/00000000-0000-4000-8000-0000000000bb'
const PERSONAL = 'someone@example.com'
const MESSAGE = `could not write the row of ${PERSONAL}`
const REQUEST_ID = 'fra1::iad1::abcde-1700000000000-0123456789ab'
const PLAIN_500 = { error: { code: 'server_error', message: 'Something went wrong' } }

// 05/10/2026 14:03 in the building (Asia/Jerusalem is UTC+3 until the last Sunday of October).
const NOON = '2026-10-05T11:03:20Z'

/** A Postgres-shaped error with a SQLSTATE that the router does not turn into a 4xx, and a message with a personal value. */
const pgError = (code = '57014') =>
  Object.assign(new Error(MESSAGE), { name: 'error', code, detail: `Key (email)=(${PERSONAL})`, where: `statement for ${PERSONAL}`, parameters: [PERSONAL] })
const socketError = () => Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:5432 for ${PERSONAL}`), { code: 'ECONNREFUSED' })

route('GET', '/test/alert/boom', async () => {
  throw pgError()
})
route('GET', '/test/alert/secret/:id', async () => {
  throw pgError()
})
route('GET', '/test/alert/socket', async () => {
  throw socketError()
})
route('GET', '/test/alert/refused', async () => {
  throw bad('bad_thing', 'A refusal')
})
route('GET', '/test/alert/answer', async () => {
  throw new Answer({ status: 503, json: { ok: false } })
})

let db
beforeAll(async () => {
  db = await setupDb()
})
afterAll(async () => db?.teardown())

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace']
let consoles
let pings
let saved
let faked = false

/** Replaces the fetch of the process by a fake that writes down what it was asked and answers `answer`. Nothing leaves the process. */
function stubFetch(answer = async () => ({ status: 200, body: { cancel: async () => {} } })) {
  pings = []
  vi.stubGlobal('fetch', (url, init) => {
    pings.push({ url: String(url), method: init?.method, body: init?.body, init })
    return answer(url, init)
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
  process.env.HEALTH_HEARTBEAT_URL = ADDRESS
  stubFetch()
  consoles = Object.fromEntries(CONSOLE_METHODS.map((method) => [method, vi.spyOn(console, method).mockImplementation(() => {})]))
  for (const spy of Object.values(consoles)) spy.mockClear() // since Vitest 4 a method that is already spied returns the same spy
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

const loggedAnything = () => CONSOLE_METHODS.flatMap((method) => consoles[method].mock.calls)
const days = async () => (await db.pool.query("select day, sent_at from alert_pings order by day")).rows
const bodies = () => pings.map((p) => p.body)

/** Runs `fn` with a pool that writes down every statement and connection that is asked of it, and passes them on. */
async function withStatements(fn) {
  const real = getPool()
  const seen = []
  setPool({
    query: (text, params, options) => (seen.push(String(text).replace(/\s+/g, ' ').trim()), real.query(text, params, options)),
    connect: (...args) => (seen.push('(a connection for a transaction)'), real.connect(...args)),
  })
  try {
    return { result: await fn(), statements: seen }
  } finally {
    setPool(real)
  }
}

/** Calls the API and returns the response with everything that was passed to console.error. */
async function viaRouter(path, options, method = 'GET') {
  consoles.error.mockClear()
  const r = await call(method, path, options)
  return { r, errors: [...consoles.error.mock.calls] }
}

const EVENT = { place: '/scans/sync', method: 'POST', code: '57014', error: pgError() }
const FIRST_LINE = 'First server error today, 05/10/2026 14:03: POST /scans/sync 57014'

describe('the first server error of a building day', () => {
  it('sends exactly one /fail with the route, the method, the code and the time, and takes the day', async () => {
    at(NOON)
    await noteServerError(EVENT)
    expect(pings).toHaveLength(1)
    expect(pings[0].url).toBe(`${ADDRESS}/fail`)
    expect(pings[0].method).toBe('POST')
    expect(pings[0].body).toBe(FIRST_LINE)
    expect(pings[0].init.redirect).toBe('error')
    expect(await days()).toEqual([{ day: '2026-10-05', sent_at: expect.any(Date) }])
    expect(loggedAnything()).toEqual([])
  })

  it('sends nothing for a second error of the same day, whatever its route, method or code', async () => {
    at(NOON)
    await noteServerError(EVENT)
    at('2026-10-05T20:59:59Z') // the last second of the building day
    await noteServerError(EVENT)
    await noteServerError({ ...EVENT, place: '/admin/points', method: 'GET', code: 'XX000' })
    await noteServerError({ ...EVENT, error: pgError('XX000') })
    expect(pings).toHaveLength(1)
    expect(await days()).toHaveLength(1)
  })

  it('sends again on a new building day, which turns at midnight in the building and not at midnight UTC', async () => {
    at('2026-10-05T20:30:00Z') // 23:30 on the 5th in the building
    await noteServerError(EVENT)
    at('2026-10-05T21:30:00Z') // 00:30 on the 6th in the building, still the 5th in UTC
    await noteServerError(EVENT)
    at('2026-10-06T08:00:00Z')
    await noteServerError(EVENT) // the same day as the one before
    expect(bodies()).toEqual([
      'First server error today, 05/10/2026 23:30: POST /scans/sync 57014',
      'First server error today, 06/10/2026 00:30: POST /scans/sync 57014',
    ])
    expect((await days()).map((r) => r.day)).toEqual(['2026-10-05', '2026-10-06'])
  })

  it('is not held back by the row of yesterday, and is held back by the row of today', async () => {
    at(NOON)
    await db.pool.query("insert into alert_pings (day) values ('2026-10-04')")
    await noteServerError(EVENT)
    expect(pings).toHaveLength(1)
    await db.pool.query('delete from alert_pings')
    await db.pool.query("insert into alert_pings (day) values ('2026-10-05')")
    await noteServerError(EVENT)
    expect(pings).toHaveLength(1) // nothing more
  })

  it('sends one ping when several errors arrive together, on any instance (the database decides)', async () => {
    // Warm connections first: a new one costs a second on a slow link to the database, and the insert is bounded.
    await Promise.all([1, 2, 3].map(() => db.pool.query('select 1')))
    at(NOON)
    // Each call starts a few milliseconds after the one before (not in the same tick: pg's pool counts a client that was just asked
    // for as waiting until the next tick, which spareClients reads as busy), and all of them are in the database at the same time.
    const calls = []
    for (let i = 0; i < 3; i++) {
      calls.push(noteServerError(EVENT))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await Promise.all(calls)
    expect(bodies()).toEqual([FIRST_LINE])
    expect(await days()).toHaveLength(1)
  })

  it('holds no message, no personal value and nothing from the error but its code', async () => {
    at(NOON)
    const error = pgError('XX000')
    await noteServerError({ place: '/admin/providers/:id', method: 'PATCH', code: 'XX000', error })
    expect(pings).toHaveLength(1)
    expect(pings[0].body).toBe('First server error today, 05/10/2026 14:03: PATCH /admin/providers/:id XX000')
    const everything = JSON.stringify(pings)
    for (const value of [MESSAGE, 'could not write', PERSONAL, 'Key (email)', 'statement for']) expect(everything, value).not.toContain(value)
  })

  it('writes the time only as DD/MM/YYYY HH:MM, in the building time', async () => {
    for (const [iso, written] of [
      ['2026-10-05T11:03:00Z', '05/10/2026 14:03'], // UTC+3
      ['2026-12-31T22:59:00Z', '01/01/2027 00:59'], // UTC+2 in winter, past midnight
      ['2027-01-01T00:00:00Z', '01/01/2027 02:00'],
    ]) {
      await db.pool.query('delete from alert_pings')
      resetAlertThrottle()
      pings.length = 0
      at(iso)
      await noteServerError(EVENT)
      expect(pings[0].body, iso).toBe(`First server error today, ${written}: POST /scans/sync 57014`)
      expect(pings[0].body, iso).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}: /)
    }
  })

  it('cuts what it is given to one short line: no newline, a method from the list, a route and a code of the length that app_errors keeps', async () => {
    at(NOON)
    await noteServerError({ place: `/a\nb ${'p'.repeat(300)}`, method: 'TRACE', code: `c\r\n${'c'.repeat(200)}`, error: pgError() })
    const body = pings[0].body
    expect(body).not.toMatch(/[\r\n]/)
    expect(body).not.toContain('TRACE')
    const tail = /^First server error today, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}: (.*)$/s.exec(body)[1]
    expect(tail.startsWith('/a b pppp')).toBe(true)
    expect(tail).toHaveLength(120 + 1 + 60)
    expect(tail.endsWith('c'.repeat(58))).toBe(true)
  })

  it('keeps the line tidy when a field is missing, and never throws whatever it is given', async () => {
    at(NOON)
    await noteServerError(undefined)
    expect(bodies()).toEqual(['First server error today, 05/10/2026 14:03'])
    for (const event of [null, {}, 5, 'x', [], { place: {} }, { place: 5, method: 5, code: {} }, { error: 'ECONNREFUSED' }]) {
      resetAlertThrottle()
      await expect(noteServerError(event)).resolves.toBeUndefined()
    }
    expect(loggedAnything()).toEqual([])
  })

  it('does not throw, does not log and does not retry when the ping fails, and the day stays taken', async () => {
    at(NOON)
    for (const answer of [
      async () => ({ status: 500, body: { cancel: async () => {} } }),
      async () => ({ status: 404, body: null }),
      async () => {
        throw new Error(`getaddrinfo ENOTFOUND hc.example.test for ${ADDRESS}`)
      },
      () => {
        throw new TypeError('fetch failed')
      },
    ]) {
      await db.pool.query('delete from alert_pings')
      stubFetch(answer)
      await expect(noteServerError(EVENT)).resolves.toBeUndefined()
      expect(pings).toHaveLength(1) // one try
      await noteServerError(EVENT) // the same day: the row is there, so no second try
      expect(pings).toHaveLength(1)
      expect(await days()).toHaveLength(1)
    }
    expect(loggedAnything()).toEqual([])
  })
})

describe('without a usable address nothing happens', () => {
  it('makes no database statement and sends nothing, and does not take the day, so that a later address still alerts', async () => {
    for (const value of [undefined, '', '   ', 'http://hc.example.test/ping/x', 'https://user:pass@hc.example.test/ping/x', 'not an address']) {
      if (value === undefined) delete process.env.HEALTH_HEARTBEAT_URL
      else process.env.HEALTH_HEARTBEAT_URL = value
      const { statements } = await withStatements(() => noteServerError(EVENT))
      expect(statements, String(value)).toEqual([])
      for (const error of [socketError(), pgError()]) {
        await noteServerError({ ...EVENT, error })
      }
      expect(pings, String(value)).toEqual([])
      expect(await days(), String(value)).toEqual([])
    }
    process.env.HEALTH_HEARTBEAT_URL = ADDRESS
    at(NOON)
    await noteServerError(EVENT)
    expect(bodies()).toEqual([FIRST_LINE])
    expect(loggedAnything()).toEqual([])
  })
})

describe('when the database is the failure', () => {
  const unreachable = { place: '/admin/points', method: 'GET', code: 'ECONNREFUSED', error: socketError() }

  it('makes no database statement for a failure to reach it, pings once, and not again within the hour', async () => {
    at('2026-10-05T11:03:00Z')
    const { statements } = await withStatements(async () => {
      for (const error of [
        socketError(),
        pgError('08006'),
        Object.assign(new Error('x'), { code: '57P01' }),
        new Error('timeout exceeded when trying to connect'),
        new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }) }),
      ]) {
        await noteServerError({ ...unreachable, error })
      }
    })
    expect(statements).toEqual([]) // not one statement, so nothing waited for a database that is down
    expect(bodies()).toEqual(['Database unreachable, 05/10/2026 14:03: GET /admin/points'])
    expect(pings[0].url).toBe(`${ADDRESS}/fail`)
    expect(await days()).toEqual([])
  })

  it('pings again after the hour, and not before it', async () => {
    at('2026-10-05T11:03:00Z')
    await noteServerError(unreachable)
    expect(pings).toHaveLength(1)
    at('2026-10-05T11:03:01Z')
    await noteServerError(unreachable)
    at('2026-10-05T12:02:59Z') // one second short of the hour
    await noteServerError(unreachable)
    expect(pings).toHaveLength(1)
    expect(ALERT_UNREACHABLE_INTERVAL_MS).toBe(60 * 60 * 1000)
    at('2026-10-05T12:03:00Z') // the hour
    await noteServerError({ ...unreachable, place: '/provider/me', method: 'POST' })
    expect(bodies()).toEqual([
      'Database unreachable, 05/10/2026 14:03: GET /admin/points',
      'Database unreachable, 05/10/2026 15:03: POST /provider/me',
    ])
    at('2026-10-05T12:30:00Z')
    await noteServerError(unreachable)
    expect(pings).toHaveLength(2) // the hour starts again from the second ping
  })

  it('does not hold the alert back for longer than an hour when the clock goes backwards, and resetAlertThrottle forgets the hour', async () => {
    at('2026-10-05T11:03:00Z')
    await noteServerError(unreachable)
    at('2026-10-05T09:00:00Z') // a clock that went back
    await noteServerError(unreachable)
    expect(pings).toHaveLength(2)
    at('2026-10-05T09:00:01Z')
    await noteServerError(unreachable)
    expect(pings).toHaveLength(2)
    resetAlertThrottle()
    await noteServerError(unreachable)
    expect(pings).toHaveLength(3)
  })

  it('does not mix the two: a failure to reach the database does not take the day, and a day that is taken does not stop it', async () => {
    at(NOON)
    await noteServerError(unreachable)
    await noteServerError(EVENT) // the database works again: the first error of the day still alerts
    expect(bodies()).toEqual(['Database unreachable, 05/10/2026 14:03: GET /admin/points', FIRST_LINE])
    resetAlertThrottle()
    await noteServerError(unreachable) // the day is taken, but a database that is down is another alert
    expect(pings).toHaveLength(3)
  })

  it('takes the same way out when the insert fails because the database cannot be reached', async () => {
    at(NOON)
    for (const broken of [
      { query: () => Promise.reject(socketError()) },
      {
        query: () => {
          throw Object.assign(new Error(MESSAGE), { code: '08006' }) // the pool fails before it returns a promise
        },
      },
    ]) {
      resetAlertThrottle()
      pings.length = 0
      setPool(broken)
      await noteServerError(EVENT)
      expect(bodies()).toEqual(['Database unreachable, 05/10/2026 14:03: POST /scans/sync'])
      await noteServerError(EVENT) // a second one within the hour: nothing
      expect(pings).toHaveLength(1)
    }
    expect(loggedAnything()).toEqual([])
  })

  it('uses the throttle in memory, with its own words, when the insert fails for another reason (the table is not there, say)', async () => {
    at(NOON)
    await db.pool.query('alter table alert_pings rename to alert_pings_away')
    try {
      await noteServerError(EVENT)
      await noteServerError(EVENT)
      await noteServerError({ ...EVENT, place: '/admin/points' })
    } finally {
      await db.pool.query('alter table alert_pings_away rename to alert_pings')
    }
    expect(bodies()).toEqual(['Server error, alert record failed, 05/10/2026 14:03: POST /scans/sync 57014'])
    expect(loggedAnything()).toEqual([])
  })

  it('does not queue behind other work: with every connection of the pool in use it asks nothing and takes the way out, with its own words', async () => {
    at(NOON)
    // Every connection of the real pool is checked out, so a statement would have to wait in the queue of the pool.
    const held = await Promise.all(Array.from({ length: db.pool.options.max }, () => db.pool.connect()))
    try {
      expect(db.pool.idleCount).toBe(0)
      const started = performance.now() // the date is frozen in this test, the clock of the process is not
      await noteServerError(EVENT)
      expect(performance.now() - started).toBeLessThan(ALERT_DB_TIMEOUT_MS) // it did not wait for a connection
      expect(bodies()).toEqual(['Server error, database busy, 05/10/2026 14:03: POST /scans/sync 57014'])
      await noteServerError(EVENT) // the throttle in memory holds the second one back
      expect(pings).toHaveLength(1)
    } finally {
      for (const client of held) client.release()
    }
    // Nothing waited in a queue and ran later: the day was not taken, so the first error after the rush alerts as usual.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await days()).toEqual([])
    await noteServerError(EVENT)
    expect(bodies()).toEqual(['Server error, database busy, 05/10/2026 14:03: POST /scans/sync 57014', FIRST_LINE])
    expect(await days()).toHaveLength(1)
    expect(loggedAnything()).toEqual([])
  })

  it('reads the busy state from spareClients: not asked unless the pool has a client to give at once and one more to keep', async () => {
    at(NOON)
    const asked = []
    const pool = (state) => ({ options: { max: 3 }, ...state, query: (text) => (asked.push(text), Promise.resolve({ rowCount: 1, rows: [{}] })) })
    // spare = idle clients + connections that may still be opened, and 0 while something waits: the same rule, and the same
    // reserve of one, as the record of an error (ERROR_RECORD_POOL_RESERVE).
    const busyStates = [
      { idleCount: 0, totalCount: 3, waitingCount: 0 }, // spare 0
      { idleCount: 1, totalCount: 3, waitingCount: 0 }, // spare 1: the last free one is kept for the requests being served
      { idleCount: 2, totalCount: 3, waitingCount: 1 }, // something already waits: a statement would join the queue
      { idleCount: 0, totalCount: 2, waitingCount: 0 }, // spare 1 as well
    ]
    for (const busy of busyStates) {
      resetAlertThrottle()
      setPool(pool(busy))
      await noteServerError(EVENT)
    }
    expect(asked).toEqual([]) // not asked
    const busyLine = 'Server error, database busy, 05/10/2026 14:03: POST /scans/sync 57014'
    expect(bodies()).toEqual(busyStates.map(() => busyLine)) // one for each state (the throttle was reset between them)
    const freeStates = [
      { idleCount: 2, totalCount: 3, waitingCount: 0 }, // spare 2
      { idleCount: 0, totalCount: 1, waitingCount: 0 }, // spare 2
      { idleCount: 0, totalCount: 0, waitingCount: 0 }, // spare 3, a new instance
      {}, // a pool that does not report its counts (a test double) is taken as free
    ]
    for (const free of freeStates) {
      resetAlertThrottle()
      pings.length = 0
      asked.length = 0
      setPool(pool(free))
      await noteServerError(EVENT)
      expect(asked, JSON.stringify(free)).toHaveLength(1) // asked
      expect(bodies(), JSON.stringify(free)).toEqual([FIRST_LINE])
    }
  })

  it('asks with the short limits of the database and a signal, and stops waiting for the statement when it is done', async () => {
    at(NOON)
    const seen = []
    setPool({
      query: (text, params, options) => (seen.push({ text, params, options }), Promise.resolve({ rowCount: 1, rows: [{ day: '2026-10-05' }] })),
    })
    await noteServerError(EVENT)
    expect(seen).toHaveLength(1)
    expect(seen[0].text).toBe('insert into alert_pings (day) values ($1) on conflict do nothing returning day')
    expect(seen[0].params).toEqual(['2026-10-05'])
    expect(seen[0].options.limits).toEqual({ statementMs: ALERT_DB_TIMEOUT_MS, idleInTransactionMs: ALERT_DB_TIMEOUT_MS, lockMs: ALERT_LOCK_TIMEOUT_MS })
    expect(seen[0].options.limits).toBe(ALERT_LIMITS)
    expect(Object.isFrozen(ALERT_LIMITS)).toBe(true)
    // The same short limits as the record of an error: its statement time is the time that the call waits, and its lock limit is the short one.
    expect([ALERT_DB_TIMEOUT_MS, ALERT_LOCK_TIMEOUT_MS]).toEqual([ERROR_RECORD_TIMEOUT_MS, ERROR_RECORD_LOCK_TIMEOUT_MS])
    expect(seen[0].options.signal).toBeInstanceOf(AbortSignal)
    // Nobody waits for the insert any more: a connection that is still being made is given back unused.
    expect(seen[0].options.signal.aborted).toBe(true)
  })

  it('treats an insert that does not answer in time as a database that is down, and stays inside the bound', async () => {
    setPool({ query: () => new Promise(() => {}) }) // a query that never answers
    const started = Date.now()
    await noteServerError(EVENT)
    const took = Date.now() - started
    expect(bodies()).toHaveLength(1)
    expect(bodies()[0]).toMatch(/^Database unreachable, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}: POST \/scans\/sync$/)
    expect(took).toBeGreaterThanOrEqual(ALERT_DB_TIMEOUT_MS - 50) // it did wait for the insert, up to its limit
    expect(took).toBeLessThan(ALERT_TOTAL_TIMEOUT_MS)
    await noteServerError(EVENT) // and a second one within the hour is not made to wait again for the ping
    expect(pings).toHaveLength(1)
  })

  it('stays inside its bound when the fetch hangs and ignores its signal', async () => {
    stubFetch(() => new Promise(() => {}))
    const started = Date.now()
    await noteServerError(EVENT)
    const took = Date.now() - started
    expect(pings).toHaveLength(1)
    expect(pings[0].init.signal.aborted).toBe(true) // the ping was cut at its own timeout
    expect(took).toBeGreaterThanOrEqual(HEARTBEAT_TIMEOUT_MS - 50)
    expect(took).toBeLessThan(ALERT_TOTAL_TIMEOUT_MS + 500)
    expect(loggedAnything()).toEqual([])
  })

  it('stays inside the whole bound when the database and the fetch both hang', async () => {
    setPool({ query: () => new Promise(() => {}) })
    stubFetch(() => new Promise(() => {}))
    const started = Date.now()
    await noteServerError(EVENT)
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(ALERT_DB_TIMEOUT_MS) // it waited for both, one after the other, and no longer than the bound
    expect(took).toBeLessThan(ALERT_TOTAL_TIMEOUT_MS + 700)
    expect(loggedAnything()).toEqual([])
  })

  it('never throws and never logs a message, whatever fails', async () => {
    const secret = Object.assign(new Error(`failure for ${PERSONAL}`), { code: 'XX000', detail: `Key (email)=(${PERSONAL})` })
    for (const broken of [
      { query: () => Promise.reject(secret) },
      {
        query: () => {
          throw secret
        },
      },
      { query: () => Promise.reject('a string') },
      { query: () => Promise.reject(undefined) },
      { query: () => undefined }, // an answer that is not an answer
    ]) {
      resetAlertThrottle()
      setPool(broken)
      await expect(noteServerError(EVENT)).resolves.toBeUndefined()
    }
    expect(loggedAnything()).toEqual([])
    expect(JSON.stringify(pings)).not.toContain(PERSONAL)
  })
})

describe('through the router', () => {
  const SECRET_PATH = '/api/test/alert/secret/secret-value-123?x=private'

  it('a 500 sends one ping, and is answered and logged exactly as before', async () => {
    at(NOON)
    const { r, errors } = await viaRouter(SECRET_PATH, { headers: { 'x-vercel-id': REQUEST_ID } })
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ error: { code: 'server_error', message: 'Something went wrong', request_id: REQUEST_ID } })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toHaveLength(1)
    expect(errors[0][0]).toContain('unhandled API error: GET /api/test/alert/secret/:id')
    expect(pings).toHaveLength(1)
    expect(pings[0].url).toBe(`${ADDRESS}/fail`)
    expect(pings[0].body).toBe('First server error today, 05/10/2026 14:03: GET /test/alert/secret/:id 57014')
    expect(await days()).toHaveLength(1)
  })

  it('sends the route as written in the code, and nothing of the request: not the path, the query, the request id or the message', async () => {
    at(NOON)
    const { r } = await viaRouter(SECRET_PATH, { headers: { 'x-vercel-id': REQUEST_ID, 'x-forwarded-for': '10.1.2.3', cookie: 'qr_admin=token-value' } })
    expect(r.status).toBe(500)
    const everything = JSON.stringify(pings)
    for (const value of ['secret-value-123', 'private', 'x=', REQUEST_ID, 'fra1', '10.1.2.3', 'token-value', MESSAGE, PERSONAL, 'Key (email)']) {
      expect(everything, value).not.toContain(value)
    }
    // The request id stays where it is meant to be: in the record.
    const { rows } = await db.pool.query('select place, last_request_id from app_errors')
    expect(rows).toEqual([{ place: '/test/alert/secret/:id', last_request_id: REQUEST_ID }])
  })

  it('sends nothing for a second 500 of the same day, which is answered and logged just the same', async () => {
    at(NOON)
    await viaRouter('/api/test/alert/boom')
    const second = await viaRouter('/api/test/alert/boom')
    expect(second.r.status).toBe(500)
    expect(second.r.json).toEqual(PLAIN_500)
    expect(second.r.text).toBe(JSON.stringify(PLAIN_500))
    expect(second.errors).toHaveLength(1)
    expect(pings).toHaveLength(1)
    at('2026-10-06T08:00:00Z')
    const third = await viaRouter('/api/test/alert/boom') // the next day
    expect(third.r.json).toEqual(PLAIN_500)
    expect(pings).toHaveLength(2)
  })

  it('sends nothing, and makes no statement, for a refusal, an Answer, a 404, a 405 or a request that its guard refused', async () => {
    const { result, statements } = await withStatements(async () => [
      await viaRouter('/api/test/alert/refused'), // an ApiError, a 4xx
      await viaRouter('/api/test/alert/answer'), // an Answer
      await viaRouter('/api/test/alert/nothing-here'), // matches no route
      await viaRouter('/api/test/alert/boom', { body: {} }, 'PUT'), // the path of a route, not for this method
      await viaRouter('/api/admin/points'), // a real route that needs a committee session: the guard refuses it first
    ])
    expect(result.map(({ r }) => r.status)).toEqual([400, 503, 404, 405, 401])
    for (const { errors } of result) expect(errors).toEqual([])
    expect(statements).toEqual([])
    expect(pings).toEqual([])
    expect(await days()).toEqual([])
  })

  it('a 500 that is a failure to reach the database makes no statement, sends the database line once, and is answered as before', async () => {
    at(NOON)
    const { result, statements } = await withStatements(async () => [
      await viaRouter('/api/test/alert/socket'),
      await viaRouter('/api/test/alert/socket'),
    ])
    expect(statements).toEqual([])
    for (const { r, errors } of result) {
      expect(r.status).toBe(500)
      expect(r.json).toEqual(PLAIN_500)
      expect(errors).toHaveLength(1)
    }
    expect(bodies()).toEqual(['Database unreachable, 05/10/2026 14:03: GET /test/alert/socket'])
    expect(JSON.stringify(pings)).not.toContain(PERSONAL)
  })

  it('still answers the same 500, with one log line, when the database fails for the record and for the alert', async () => {
    at(NOON)
    setPool({ query: () => Promise.reject(Object.assign(new Error(`insert failed for ${PERSONAL}`), { code: 'XX000' })) })
    const { r, errors } = await viaRouter('/api/test/alert/boom')
    expect(r.status).toBe(500)
    expect(r.json).toEqual(PLAIN_500)
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).not.toContain(PERSONAL)
    expect(bodies()).toEqual(['Server error, alert record failed, 05/10/2026 14:03: GET /test/alert/boom 57014'])
    expect(JSON.stringify(pings)).not.toContain(PERSONAL)
  })

  it('still answers the same 500, with one log line, when the pool is busy, and says so in the ping', async () => {
    at(NOON)
    setPool({ options: { max: 3 }, idleCount: 0, totalCount: 3, waitingCount: 0, query: () => Promise.reject(new Error('the pool is busy')) })
    const { r, errors } = await viaRouter('/api/test/alert/boom')
    expect(r.status).toBe(500)
    expect(r.json).toEqual(PLAIN_500)
    expect(errors).toHaveLength(1)
    expect(bodies()).toEqual(['Server error, database busy, 05/10/2026 14:03: GET /test/alert/boom 57014'])
  })

  it('answers within its bound, with the same 500 and one log line, when the fetch hangs', async () => {
    stubFetch(() => new Promise(() => {}))
    const started = Date.now()
    const { r, errors } = await viaRouter('/api/test/alert/boom', { headers: { 'x-vercel-id': REQUEST_ID } })
    const took = Date.now() - started
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ error: { code: 'server_error', message: 'Something went wrong', request_id: REQUEST_ID } })
    expect(errors).toHaveLength(1)
    expect(pings).toHaveLength(1)
    expect(took).toBeGreaterThanOrEqual(HEARTBEAT_TIMEOUT_MS - 50) // the answer waited for the ping
    expect(took).toBeLessThan(ERROR_RECORD_TIMEOUT_MS + ALERT_TOTAL_TIMEOUT_MS + 1000) // the record, then the whole alert, which has its own bound
  })

  it('without HEALTH_HEARTBEAT_URL a 500 makes exactly one statement, the record of app_errors, and sends nothing', async () => {
    delete process.env.HEALTH_HEARTBEAT_URL
    const { result, statements } = await withStatements(() => viaRouter('/api/test/alert/boom'))
    expect(result.r.status).toBe(500)
    expect(result.r.json).toEqual(PLAIN_500)
    expect(result.errors).toHaveLength(1)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^insert into app_errors /)
    expect(pings).toEqual([])
    expect(await days()).toEqual([])
  })
})

describe('the table alert_pings', () => {
  it('holds a date and the moment of its row, refuses a second row for the same day, and nothing else', async () => {
    const { rows: columns } = await db.pool.query(
      `select column_name as name, data_type as type, is_nullable as nullable, column_default as "default"
         from information_schema.columns where table_schema = current_schema() and table_name = 'alert_pings' order by ordinal_position`,
    )
    expect(columns).toEqual([
      { name: 'day', type: 'date', nullable: 'NO', default: null },
      { name: 'sent_at', type: 'timestamp with time zone', nullable: 'NO', default: 'now()' },
    ])
    const claim = 'insert into alert_pings (day) values ($1) on conflict do nothing returning day'
    expect((await db.pool.query(claim, ['2026-10-05'])).rowCount).toBe(1)
    expect((await db.pool.query(claim, ['2026-10-05'])).rowCount).toBe(0)
    await expect(db.pool.query("insert into alert_pings (day) values ('2026-10-05')")).rejects.toMatchObject({ code: '23505' })
    expect((await db.pool.query(claim, ['2026-10-06'])).rowCount).toBe(1)
  })
})
