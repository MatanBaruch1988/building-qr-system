// What the router records, besides the 500, in app_errors (server/router.js `recordAdmitted`, server/errorLog.js,
// docs/adr/0007), and the one failure of the database that now has a name of its own. This file proves:
//   - a request that its guard let in and that a handler or the router answered with a 4xx (an ApiError, or a database 4xx that
//     the router turns into one) writes one `refusal` row: the route as it is written in the code, the method, the status and the
//     code of the refusal, and nothing that was asked for (the path, the query, the message, the body);
//   - nothing is recorded for a request that its guard refused (a 401 with no credentials, with a wrong or a bad credential, with
//     the credential of another role), for a 4xx of a public route (sign-in, the public lookups), for a 404 or a 405, for a write that
//     failed the origin or content-type check before the guard, or for an answer that is not a 4xx;
//   - a request that its guard let in and that took longer than SLOW_REQUEST_MS writes one `slow` row with the final status,
//     measured with a clock that the test injects; a fast one writes nothing; a slow 500 is the `error` row and not a second one;
//     a slow request of a public route, one that the guard refused and a 404 write nothing;
//   - neither event logs anything (the one console.error of the router is the 500's), and both are recorded before the answer is sent;
//   - when the pool cannot hand out a client in time (pg: "timeout exceeded when trying to connect", an error with no code), the
//     router's 500 is labelled `db_connect_timeout` in its log line and in its record, nothing of the original message is kept,
//     and no insert is attempted for it, because the database cannot be reached.
// It runs against the throwaway schema like the other API tests. The data is fake. The routes below exist only for this file:
// `/test/...` ones answer without credentials, and `/test-committee/...` ones get the guard that the real policy gives an
// `/admin/` route (the real requireAdmin). The vi.mock of server/access.js changes the module only inside this file's own module graph,
// so the production code has no way to register a route that skips the policy. The mock of server/errorLog.js only lets the test see
// what the router asked to record (the real recordEvent still runs).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { route } from '../server/router.js'
import { getPool, setPool, query, tx, DB_CONNECT_TIMEOUT } from '../server/db.js'
import { recordEvent, isConnectionFailure } from '../server/errorLog.js'
import { SLOW_REQUEST_MS, MAX_SYNC_BATCH } from '../server/config.js'
import { ApiError, Answer, bad, forbidden, notFound } from '../server/http.js'

vi.mock('../server/access.js', async (importOriginal) => {
  const real = await importOriginal()
  const open = Object.freeze({ public: true })
  return {
    ...real,
    accessFor: (method, pattern) => {
      if (pattern.startsWith('/test/')) return open
      // The committee's guard, whatever the test route is called: the policy decides it for the `/admin/` path.
      if (pattern.startsWith('/test-committee/')) return real.accessFor(method, pattern.replace('/test-committee/', '/admin/test-'))
      return real.accessFor(method, pattern)
    },
  }
})

vi.mock('../server/errorLog.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, recordEvent: vi.fn(real.recordEvent) }
})

const PERSONAL = 'someone@example.com'
const MESSAGE = `could not write the row of ${PERSONAL}`
const REQUEST_ID = 'fra1::iad1::abcde-1700000000000-0123456789ab'
const POOL_TIMEOUT = 'timeout exceeded when trying to connect'
const SLOW = SLOW_REQUEST_MS + 1

/** A Postgres-shaped error with a SQLSTATE that the router does not turn into a 4xx, and a message with a personal value. */
const pgError = (code = 'XX000') => Object.assign(new Error(MESSAGE), { name: 'error', code, detail: `Key (email)=(${PERSONAL})` })

// Public routes: what the router does for a route that answers without credentials.
route('GET', '/test/fine', async () => ({ ok: true }))
route('GET', '/test/refused', async () => {
  throw bad('bad_thing', MESSAGE)
})
route('GET', '/test/boom', async () => {
  throw pgError()
})
route('GET', '/test/db', async () => (await query('select 1 as one')).rows[0])

// Routes behind the committee's guard: what the router does for a request that the guard let in.
route('GET', '/test-committee/ok', async () => ({ ok: true }))
route('GET', '/test-committee/accepted', async () => ({ status: 202, json: { ok: true } }))
route('GET', '/test-committee/refused', async () => {
  throw bad('batch_too_large', MESSAGE)
})
route('GET', '/test-committee/forbidden', async () => {
  throw forbidden('not_yours', MESSAGE)
})
route('GET', '/test-committee/missing/:id', async () => {
  throw notFound('thing_not_found', MESSAGE)
})
route('GET', '/test-committee/conflict', async () => {
  throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', detail: `Key (email)=(${PERSONAL})` })
})
route('GET', '/test-committee/out-of-range', async () => {
  throw Object.assign(new Error(MESSAGE), { code: '22003' })
})
route('GET', '/test-committee/unavailable', async () => {
  throw new ApiError(503, 'unavailable', 'The caller can retry')
})
route('GET', '/test-committee/answer', async () => {
  throw new Answer({ status: 503, json: { ok: false } })
})
route('GET', '/test-committee/boom', async () => {
  throw pgError()
})

let db, cookie, providerToken
beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  const provider = (
    await call('POST', '/api/admin/providers', {
      cookie,
      body: { company: 'Fake cleaning', contact_name: 'Fake Contact', service_type: 'cleaning', password: 'ploni-1234' },
    })
  ).json.provider
  providerToken = (await call('POST', '/api/session', { body: { provider_id: provider.id, password: 'ploni-1234' } })).json.token
})
afterAll(async () => db?.teardown())
beforeEach(async () => {
  await db.pool.query('delete from app_errors')
  vi.mocked(recordEvent).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  setPool(db.pool)
})

const rows = async () => (await db.pool.query('select * from app_errors order by id')).rows
/** What matters of a row, in the order of the key. */
const shape = (r) => [r.kind, r.method, r.place, r.status, r.code]
const events = (found) => found.reduce((sum, r) => sum + r.count, 0)

/** A clock for handle(): 0 when the request starts, `ms` for every reading after that. */
const clockOf = (ms) => {
  let started = false
  return () => (started ? ms : ((started = true), 0))
}

/** Silences and collects every console method that the code under test could log with. */
function logging() {
  const spies = ['error', 'warn', 'log', 'info', 'debug'].map((name) => vi.spyOn(console, name).mockImplementation(() => {}))
  for (const spy of spies) spy.mockClear()
  return { all: () => spies.flatMap((spy) => spy.mock.calls), errors: () => spies[0].mock.calls }
}

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
const recordingStatements = (statements) => statements.filter((s) => /app_errors/.test(s))

describe('a refusal after the guard', () => {
  it('on a real committee route (a bad body) writes one row with the route as written in the code, the method, the status and the code', async () => {
    const before = process.env.VERCEL_GIT_COMMIT_SHA
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890'
    let r
    try {
      r = await call('POST', '/api/admin/providers', { cookie, body: {} })
    } finally {
      if (before === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA
      else process.env.VERCEL_GIT_COMMIT_SHA = before
    }
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBeTruthy()
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      source: 'server',
      kind: 'refusal',
      place: '/admin/providers',
      method: 'POST',
      status: 400,
      code: r.json.error.code,
      app_build: 'abcdef1',
      count: 1,
      last_request_id: null,
    })
  })

  it('on a real provider route (a sync batch that is too big) writes the refusal that leaves a phone queue stuck', async () => {
    const r = await call('POST', '/api/scans/sync', { token: providerToken, body: { scans: Array.from({ length: MAX_SYNC_BATCH + 1 }, () => ({})) } })
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBe('batch_too_large')
    const found = await rows()
    expect(found.map(shape)).toEqual([['refusal', 'POST', '/scans/sync', 400, 'batch_too_large']])
  })

  it('adds 1 to the count of the same row for a second refusal, and keeps a request id that is well formed', async () => {
    await call('POST', '/api/admin/providers', { cookie, body: {}, headers: { 'x-vercel-id': REQUEST_ID } })
    await call('POST', '/api/admin/providers', { cookie, body: {} })
    const found = await rows()
    // Two events of one key: one row with a count of 2 (two rows of 1 only when the hour turned between the two requests).
    expect(events(found)).toBe(2)
    expect(new Set(found.map((r) => JSON.stringify(shape(r)))).size).toBe(1)
    expect(found.some((r) => r.last_request_id === REQUEST_ID)).toBe(true)
  })

  it('records every kind of 4xx that a handler or the database makes after the guard, with the code of the refusal', async () => {
    const cases = [
      ['/api/test-committee/refused', 400, 'batch_too_large'],
      ['/api/test-committee/forbidden', 403, 'not_yours'],
      ['/api/test-committee/missing/abc', 404, 'thing_not_found'],
      ['/api/test-committee/conflict', 409, 'conflict'], // a unique violation of the database, turned into a 409 by the router
      ['/api/test-committee/out-of-range', 400, 'invalid_input'], // SQLSTATE class 22, turned into a 400
    ]
    for (const [path, status, code] of cases) {
      const r = await call('GET', path, { cookie })
      expect([r.status, r.json.error.code], path).toEqual([status, code])
    }
    const found = await rows()
    expect(found.map(shape).sort()).toEqual(
      [
        ['refusal', 'GET', '/test-committee/refused', 400, 'batch_too_large'],
        ['refusal', 'GET', '/test-committee/forbidden', 403, 'not_yours'],
        ['refusal', 'GET', '/test-committee/missing/:id', 404, 'thing_not_found'],
        ['refusal', 'GET', '/test-committee/conflict', 409, 'conflict'],
        ['refusal', 'GET', '/test-committee/out-of-range', 400, 'invalid_input'],
      ].sort(),
    )
    expect(found.every((r) => r.source === 'server' && r.count === 1)).toBe(true)
  })

  it('records a malformed path parameter that the router refuses after the guard (400 bad_request), by the route and not the path', async () => {
    const r = await call('PATCH', '/api/admin/points/%E0%A4%A', { cookie, body: {} })
    expect([r.status, r.json.error.code]).toEqual([400, 'bad_request'])
    expect((await rows()).map(shape)).toEqual([['refusal', 'PATCH', '/admin/points/:id', 400, 'bad_request']])
  })

  it('stores nothing that was asked for or that the refusal said: no path value, query string, message, body or name', async () => {
    const secret = 'secret-value-123'
    const r = await call('GET', `/api/test-committee/missing/${secret}?x=private&email=${PERSONAL}`, {
      cookie,
      headers: { 'x-vercel-id': 'bad id!' },
    })
    expect(r.status).toBe(404)
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0].place).toBe('/test-committee/missing/:id')
    expect(found[0].last_request_id).toBeNull() // a malformed request id is not stored
    const everything = JSON.stringify([found, vi.mocked(recordEvent).mock.calls])
    for (const value of [secret, 'private', 'x=', PERSONAL, 'example.com', 'could not write']) {
      expect(everything, value).not.toContain(value)
    }

    await db.pool.query('delete from app_errors')
    // A body with personal values in it that is refused (is_active must be true or false): none of it reaches the record.
    const withBody = await call('POST', '/api/admin/providers', { cookie, body: { company: PERSONAL, contact_name: PERSONAL, is_active: PERSONAL } })
    expect(withBody.status).toBe(400)
    expect((await rows()).map(shape)).toEqual([['refusal', 'POST', '/admin/providers', 400, 'invalid_field']])
    expect(JSON.stringify(await rows())).not.toContain(PERSONAL)
  })

  it('is recorded once, before the answer is sent, with no statement but the insert of the record', async () => {
    const { result, statements } = await withStatements(() => call('GET', '/api/test-committee/refused', { cookie }))
    expect(result.status).toBe(400)
    // The guard's own lookup, then the one insert of the record: nothing else, and nothing after the answer (`call` returns
    // when the answer was sent, and the row is already there).
    expect(recordingStatements(statements)).toHaveLength(1)
    expect(recordingStatements(statements)[0]).toMatch(/^insert into app_errors .* on conflict on constraint app_errors_key do update/)
    expect(await rows()).toHaveLength(1)
    const [event] = vi.mocked(recordEvent).mock.calls[0]
    expect(event).toMatchObject({ source: 'server', kind: 'refusal', place: '/test-committee/refused', method: 'GET', status: 400, code: 'batch_too_large' })
    expect(event).not.toHaveProperty('error') // nothing of the error itself is passed
  })

  it('is not a refusal when the status is not a 4xx: a 5xx ApiError and an Answer of the handler record nothing', async () => {
    const { result, statements } = await withStatements(async () => [
      await call('GET', '/api/test-committee/unavailable', { cookie }),
      await call('GET', '/api/test-committee/answer', { cookie }),
      await call('GET', '/api/test-committee/ok', { cookie }),
    ])
    expect(result.map((r) => r.status)).toEqual([503, 503, 200])
    expect(recordingStatements(statements)).toEqual([])
    expect(await rows()).toEqual([])
  })
})

describe('what a refusal records nothing for', () => {
  /** Sends every request, and proves that no statement of the record was made and no row was written. */
  async function recordsNothing(requests, options = {}) {
    const { result, statements } = await withStatements(async () => {
      const out = []
      for (const [method, path, init] of requests) out.push([`${method} ${path}`, await call(method, path, { ...init, ...options })])
      return out
    })
    expect(recordingStatements(statements)).toEqual([])
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
    return result
  }

  it('a request that its guard refused, with no credentials: a 401 on a committee, a provider and a cron route', async () => {
    const result = await recordsNothing([
      ['GET', '/api/admin/points'],
      ['POST', '/api/admin/providers', { body: {} }],
      ['GET', '/api/my/scans'],
      ['POST', '/api/scans/sync', { body: { scans: Array.from({ length: MAX_SYNC_BATCH + 1 }, () => ({})) } }],
      ['GET', '/api/cron/retention'],
    ])
    for (const [label, r] of result) expect(r.status, label).toBe(401)
  })

  it('a request that its guard refused, with a credential that does not exist or is not shaped like ours', async () => {
    const result = await recordsNothing([
      ['GET', '/api/admin/points', { cookie: 'qr_admin=not-a-session' }],
      ['GET', '/api/admin/points', { cookie: `qr_admin=${'a'.repeat(500)}` }],
      ['GET', '/api/my/scans', { token: 'not-a-device-token' }],
      ['GET', '/api/test-committee/refused', { cookie: 'qr_admin=not-a-session' }],
    ])
    for (const [label, r] of result) expect(r.status, label).toBe(401)
  })

  it('a request that its guard refused because it came with the credential of another role (a 401)', async () => {
    const result = await recordsNothing([
      ['GET', '/api/my/scans', { cookie }], // a committee session on a provider route
      ['POST', '/api/scans/sync', { cookie, body: { scans: [] } }],
      ['GET', '/api/admin/points', { token: providerToken }], // a provider's token on a committee route
      ['POST', '/api/admin/providers', { token: providerToken, body: {} }],
      ['GET', '/api/test-committee/refused', { token: providerToken }],
    ])
    for (const [label, r] of result) expect(r.status, label).toBe(401)
  })

  it('a 4xx of a public route: a wrong password and a bad body on sign-in, and the 4xx of a public test route', async () => {
    const result = await recordsNothing([
      ['POST', '/api/session', { body: { provider_id: '00000000-0000-4000-8000-000000000000', password: 'wrong-password-1' } }],
      ['POST', '/api/session', { body: {} }],
      ['POST', '/api/admin/google', { body: { credential: 'stranger@example.test' } }],
      ['GET', '/api/public/points/resolve'],
      ['GET', '/api/test/refused'],
    ])
    for (const [label, r] of result) {
      expect(r.status, label).toBeGreaterThanOrEqual(400)
      expect(r.status, label).toBeLessThan(500)
    }
  })

  it('a 404 for an unknown path, a 405 for another method, and the 400 of a malformed parameter on a path that has no route for the method', async () => {
    const result = await recordsNothing(
      [
        ['GET', '/api/nothing/here'],
        ['GET', '/api/admin/nothing/here'],
        ['PUT', '/api/scan', { body: {} }],
        ['GET', '/api/admin/points/abc'],
        ['PUT', '/api/test/refused', { body: {} }],
        ['GET', '/api/admin/providers/%E0%A4%A'],
      ],
      { cookie },
    )
    // The last one is the path of a route (PATCH, DELETE) but not for GET: no guard and no handler run, and the router checks the
    // parameter anyway, so a malformed one is the 400 that it always was.
    expect(result.map(([, r]) => r.status)).toEqual([404, 404, 405, 405, 405, 400])
  })

  it('a write that failed the content-type or origin check, which is answered before the guard', async () => {
    const result = await recordsNothing([
      ['POST', '/api/admin/providers', { cookie, body: {}, headers: { 'content-type': 'text/plain' } }],
      ['POST', '/api/admin/providers', { cookie, body: {}, headers: { origin: 'https://elsewhere.example' } }],
    ])
    expect(result.map(([, r]) => [r.status, r.json.error.code])).toEqual([
      [400, 'json_required'],
      [403, 'bad_origin'],
    ])
  })
})

describe('a slow request', () => {
  it('writes one `slow` row with the route, the method and the final status, when it took longer than SLOW_REQUEST_MS', async () => {
    expect(SLOW_REQUEST_MS).toBe(5000)
    const r = await call('GET', '/api/test-committee/accepted', { cookie, now: clockOf(SLOW) })
    expect(r.status).toBe(202)
    expect(r.json).toEqual({ ok: true }) // the answer is what it always was
    const found = await rows()
    expect(found.map(shape)).toEqual([['slow', 'GET', '/test-committee/accepted', 202, '']])
    expect(found[0]).toMatchObject({ source: 'server', count: 1 })
  })

  it('is slow only above the limit: SLOW_REQUEST_MS itself, and anything less, record nothing', async () => {
    for (const ms of [0, 1, SLOW_REQUEST_MS - 1, SLOW_REQUEST_MS]) {
      const r = await call('GET', '/api/test-committee/ok', { cookie, now: clockOf(ms) })
      expect(r.status, `${ms} ms`).toBe(200)
    }
    expect(await rows()).toEqual([])
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled()
    await call('GET', '/api/test-committee/ok', { cookie, now: clockOf(SLOW_REQUEST_MS + 1) })
    expect((await rows()).map(shape)).toEqual([['slow', 'GET', '/test-committee/ok', 200, '']])
  })

  it('is not slow with the real clock: a fast request on a real route records nothing', async () => {
    expect((await call('GET', '/api/admin/points', { cookie })).status).toBe(200)
    expect(await rows()).toEqual([])
  })

  it('is measured from the start of the router, once, and the clock is not read for a request that is not recorded anyway', async () => {
    let reads = 0
    const now = () => (reads++ === 0 ? 0 : SLOW)
    await call('GET', '/api/test-committee/ok', { cookie, now })
    expect(reads).toBe(2) // the start, and the moment the answer was ready
    expect((await rows()).map(shape)).toEqual([['slow', 'GET', '/test-committee/ok', 200, '']])
  })

  it('that is also refused writes both rows: the refusal with its code, and the slow request with the final status', async () => {
    const r = await call('GET', '/api/test-committee/refused', { cookie, now: clockOf(SLOW) })
    expect(r.status).toBe(400)
    expect((await rows()).map(shape).sort()).toEqual(
      [
        ['refusal', 'GET', '/test-committee/refused', 400, 'batch_too_large'],
        ['slow', 'GET', '/test-committee/refused', 400, ''],
      ].sort(),
    )
  })

  it('that is a 5xx of the route (not a 500) is recorded as slow with that status, and a fast one is not', async () => {
    await call('GET', '/api/test-committee/unavailable', { cookie, now: clockOf(SLOW) })
    await call('GET', '/api/test-committee/answer', { cookie, now: clockOf(SLOW) })
    expect((await rows()).map(shape).sort()).toEqual(
      [
        ['slow', 'GET', '/test-committee/unavailable', 503, ''],
        ['slow', 'GET', '/test-committee/answer', 503, ''],
      ].sort(),
    )
  })

  it('that ends in a 500 is the `error` row and not a second `slow` one, and is logged once', async () => {
    const logged = logging()
    const r = await call('GET', '/api/test-committee/boom', { cookie, now: clockOf(SLOW) })
    expect(r.status).toBe(500)
    expect(logged.errors()).toHaveLength(1)
    expect((await rows()).map(shape)).toEqual([['error', 'GET', '/test-committee/boom', 500, 'XX000']])
  })

  it('writes nothing for a route that is public, a request that its guard refused, a 404 and a 405, however slow', async () => {
    const { result, statements } = await withStatements(async () => [
      await call('GET', '/api/test/fine', { now: clockOf(SLOW) }), // public
      await call('GET', '/api/test/refused', { now: clockOf(SLOW) }), // public, and a 4xx
      await call('GET', '/api/admin/points', { now: clockOf(SLOW) }), // refused by the guard
      await call('GET', '/api/my/scans', { cookie, now: clockOf(SLOW) }), // refused by the guard: the other role
      await call('GET', '/api/nothing/here', { cookie, now: clockOf(SLOW) }), // 404
      await call('PUT', '/api/scan', { cookie, body: {}, now: clockOf(SLOW) }), // 405
    ])
    expect(result.map((r) => r.status)).toEqual([200, 400, 401, 401, 404, 405])
    expect(recordingStatements(statements)).toEqual([])
    expect(await rows()).toEqual([])
  })
})

describe('logging', () => {
  it('a refusal and a slow request log nothing at all: the record is the only trace', async () => {
    const logged = logging()
    for (const [path, init] of [
      ['/api/test-committee/refused', { cookie }],
      ['/api/test-committee/forbidden', { cookie }],
      ['/api/test-committee/conflict', { cookie }],
      ['/api/test-committee/ok', { cookie, now: clockOf(SLOW) }],
      ['/api/test-committee/refused', { cookie, now: clockOf(SLOW) }],
      ['/api/test-committee/answer', { cookie, now: clockOf(SLOW) }],
    ]) {
      await call('GET', path, init)
    }
    expect(logged.all()).toEqual([])
    expect((await rows()).length).toBeGreaterThan(0) // they were recorded, and still nothing was logged
  })

  it('a 500 is still exactly one console.error call, and its answer and record are the same as before', async () => {
    const logged = logging()
    const r = await call('GET', '/api/test-committee/boom', { cookie })
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ error: { code: 'server_error', message: 'Something went wrong' } })
    expect(logged.errors()).toHaveLength(1)
    expect(logged.errors()[0]).toHaveLength(1)
    expect(logged.errors()[0][0]).toContain('unhandled API error: GET /api/test-committee/boom')
    expect(logged.all()).toHaveLength(1)
    expect((await rows()).map(shape)).toEqual([['error', 'GET', '/test-committee/boom', 500, 'XX000']])
  })
})

describe('the pool that gave no connection in time', () => {
  /** A pool of the app's kind (the limits, the transactions) whose `connect` fails the way pg-pool does when it waited too long. */
  const timedOutPool = (message = POOL_TIMEOUT) =>
    Object.assign(Object.create(db.pool), {
      connect: vi.fn(() => Promise.reject(new Error(message))),
    })

  it('is thrown by the pool of the app as an error of ours: the code db_connect_timeout, a message of ours, no cause, nothing of the original', async () => {
    const pool = timedOutPool()
    setPool(pool)
    const err = await tx(async () => 'never').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe(DB_CONNECT_TIMEOUT)
    expect(DB_CONNECT_TIMEOUT).toBe('db_connect_timeout')
    expect(err.message).not.toContain('timeout exceeded')
    expect(err.cause).toBeUndefined()
    expect(Object.keys(err)).toEqual(['code'])
    // A single statement goes through the same place, and the connection was asked for once.
    await expect(query('select 1')).rejects.toMatchObject({ code: DB_CONNECT_TIMEOUT })
    expect(pool.connect).toHaveBeenCalledTimes(2)
  })

  it('is recognised by its exact message only: any other failure of connect is thrown as it was', async () => {
    const others = [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      new Error(`${POOL_TIMEOUT} to a host`), // not the message of the pool
      new Error(POOL_TIMEOUT.toUpperCase()),
      new Error(` ${POOL_TIMEOUT}`),
      new Error('Connection terminated due to connection timeout'),
    ]
    for (const other of others) {
      const pool = Object.assign(Object.create(db.pool), { connect: () => Promise.reject(other) })
      setPool(pool)
      await expect(query('select 1'), other.message).rejects.toBe(other)
    }
    // Something that is not an Error is thrown as it is too, even with that text.
    const text = { message: POOL_TIMEOUT }
    setPool(Object.assign(Object.create(db.pool), { connect: () => Promise.reject(text) }))
    await expect(query('select 1')).rejects.toBe(text)
  })

  it('is a failure to reach the database for isConnectionFailure, so no insert is attempted for it', async () => {
    const err = Object.assign(new Error('The pool gave no database connection in time'), { code: DB_CONNECT_TIMEOUT })
    expect(isConnectionFailure(err)).toBe(true)
    expect(isConnectionFailure(new Error('x', { cause: err }))).toBe(true)
    expect(isConnectionFailure(Object.assign(new Error('x'), { code: 'db_connect_timeout_not' }))).toBe(false)
    const { statements } = await withStatements(() => recordEvent({ source: 'server', kind: 'error', place: '/test/db', method: 'GET', status: 500, code: DB_CONNECT_TIMEOUT, error: err }))
    expect(statements).toEqual([])
  })

  it('makes the 500 say db_connect_timeout in its log line and in its record, and attempts no insert', async () => {
    const pool = timedOutPool()
    setPool(pool)
    const logged = logging()
    const r = await call('GET', '/api/test/db')
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ error: { code: 'server_error', message: 'Something went wrong' } })
    // One log line, with the code, and nothing of the message of the pool.
    expect(logged.all()).toHaveLength(1)
    expect(logged.errors()).toHaveLength(1)
    const line = logged.errors()[0][0]
    expect(line).toContain('unhandled API error: GET /api/test/db')
    expect(line).toContain('code=db_connect_timeout')
    expect(line).not.toContain('timeout exceeded')
    // The record that the router asked for says the same, with no error of the pool in it to store.
    expect(vi.mocked(recordEvent)).toHaveBeenCalledTimes(1)
    const [event] = vi.mocked(recordEvent).mock.calls[0]
    expect(event).toMatchObject({ source: 'server', kind: 'error', place: '/test/db', method: 'GET', status: 500, code: 'db_connect_timeout' })
    expect(isConnectionFailure(event.error)).toBe(true)
    // No insert was attempted: the only connection that was asked for is the one of the handler's own statement.
    expect(pool.connect).toHaveBeenCalledTimes(1)
    setPool(db.pool)
    expect(await rows()).toEqual([])
  })

  it('does the same when the guard is the one that waited for a connection', async () => {
    const pool = timedOutPool()
    setPool(pool)
    const logged = logging()
    const r = await call('GET', '/api/test-committee/ok', { cookie })
    expect(r.status).toBe(500)
    expect(logged.errors()).toHaveLength(1)
    expect(logged.errors()[0][0]).toContain('code=db_connect_timeout')
    expect(vi.mocked(recordEvent).mock.calls[0][0]).toMatchObject({ kind: 'error', place: '/test-committee/ok', code: 'db_connect_timeout' })
    expect(pool.connect).toHaveBeenCalledTimes(1) // the guard's lookup; the insert was not attempted
    setPool(db.pool)
    expect(await rows()).toEqual([])
  })
})
