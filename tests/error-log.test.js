// Server errors recorded in our own database (server/errorLog.js, db/migrations/010_app_errors.sql, docs/adr/0007). The
// runtime log of the host is kept for about an hour, so an unhandled error (a 500) is also written to app_errors, one row per
// kind of event per hour with a count, with safe fields only. This file proves:
//   - a 500 on a matched route writes one row with the right fields, and a second one in the same hour adds 1 to its count;
//   - nothing sensitive is stored: not the message of the error, not the path that was asked for or its query string;
//   - the request id (the x-vercel-id header) is in the 500 answer and in the row only when it is well formed, and the answer
//     is exactly what it always was when there is none;
//   - when the database is the failure the answer is not held up: a connection failure attempts no insert, a hanging insert
//     is cut at ERROR_RECORD_TIMEOUT_MS, a failing insert changes nothing in the answer, and there is one log line in every case;
//   - recording never turns into the outage it reports on: it makes no query while the pool is busy (nothing is held, nothing
//     waits, the last free connection is never taken), the database itself cancels an insert that is slow or blocked within
//     about the limit of the insert and the connection goes back to the pool, a connection that arrives after the request gave
//     up is returned unused, and no other statement of the app gets the limits of the insert;
//   - every field is checked or cut before the query, so a bad value cannot make the insert fail;
//   - the lists of source and kind in the code are the check constraints of the table;
//   - a refusal (a 4xx), an Answer and a request that matched no route write nothing.
// It runs against the throwaway schema like the other API tests. The data is fake. The routes below exist only for this file
// (they answer without credentials: the same vi.mock of server/access.js as tests/router-log.test.js, which changes the module
// only inside this file's own module graph, so the production code has no way to register a route that skips the policy).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { setupDb, call } from './helpers.js'
import { route } from '../server/router.js'
import { getPool, setPool, createPool, poolConfig, QUERY_LIMITS } from '../server/db.js'
import { assertNotProduction } from '../server/dbGuard.js'
import {
  recordEvent,
  isConnectionFailure,
  requestIdOf,
  EVENT_SOURCES,
  EVENT_KINDS,
  EVENT_METHODS,
  ERROR_RECORD_LIMITS,
  PLACE_MAX_LENGTH,
  CODE_MAX_LENGTH,
  APP_BUILD_MAX_LENGTH,
  REQUEST_ID_MAX_LENGTH,
  STATUS_MAX,
} from '../server/errorLog.js'
import { ERROR_RECORD_TIMEOUT_MS, ERROR_RECORD_LOCK_TIMEOUT_MS, ERROR_RECORD_POOL_RESERVE } from '../server/config.js'
import { ApiError, Answer, bad, forbidden } from '../server/http.js'

vi.mock('../server/access.js', async (importOriginal) => {
  const real = await importOriginal()
  const open = Object.freeze({ public: true })
  return { ...real, accessFor: (method, pattern) => (pattern.startsWith('/test/') ? open : real.accessFor(method, pattern)) }
})

const PERSONAL = 'someone@example.com'
const MESSAGE = `could not write the row of ${PERSONAL}`
const REQUEST_ID = 'fra1::iad1::abcde-1700000000000-0123456789ab'
const LONG_SEGMENT = 'segment'.repeat(30) // a route pattern longer than the column

/** A Postgres-shaped error with a SQLSTATE that the router does not turn into a 4xx, and a message with a personal value. */
const pgError = (code = 'XX000') => Object.assign(new Error(MESSAGE), { name: 'error', code, detail: `Key (email)=(${PERSONAL})` })

route('GET', '/test/boom', async () => {
  throw pgError()
})
route('GET', '/test/secret/:id', async () => {
  throw pgError()
})
route('GET', '/test/other', async () => {
  throw new TypeError(MESSAGE)
})
route('POST', '/test/boom', async () => {
  throw pgError()
})
route('GET', '/test/thrown-string', async () => {
  throw PERSONAL
})
route('GET', `/test/long/${LONG_SEGMENT}`, async () => {
  throw pgError()
})
route('GET', '/test/refused', async () => {
  throw bad('bad_thing', 'A refusal')
})
route('GET', '/test/forbidden', async () => {
  throw forbidden()
})
route('GET', '/test/api-error-5xx-shaped', async () => {
  throw new ApiError(503, 'unavailable', 'The caller can retry')
})
route('GET', '/test/answer', async () => {
  throw new Answer({ status: 503, json: { ok: false } })
})
route('GET', '/test/unique-violation', async () => {
  throw Object.assign(new Error('duplicate key value'), { code: '23505', detail: `Key (email)=(${PERSONAL})` })
})
route('GET', '/test/socket-refused', async () => {
  throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
})
route('GET', '/test/connection-exception', async () => {
  throw pgError('08006')
})
route('GET', '/test/pool-timeout', async () => {
  throw new Error('timeout exceeded when trying to connect')
})

let db
beforeAll(async () => {
  db = await setupDb()
})
afterAll(async () => db?.teardown())
beforeEach(async () => {
  await db.pool.query('delete from app_errors')
})
afterEach(() => {
  vi.restoreAllMocks()
  setPool(db.pool)
})

const rows = async () => (await db.pool.query('select * from app_errors order by id')).rows

/** Calls the API and returns the response with everything that was passed to console.error. */
async function boom(path, options) {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  // Since Vitest 4, spying on a method that is already spied returns the same spy, so start every call from an empty record.
  logged.mockClear()
  const r = await call('GET', path, options)
  return { r, calls: [...logged.mock.calls] }
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

/** The hour is the key of a row, so a test that makes two events and compares them must not straddle the turn of the hour. */
async function notNearTheTurnOfTheHour() {
  const { rows: left } = await db.pool.query(
    "select (3600 - extract(epoch from now() - date_trunc('hour', now())))::float as seconds",
  )
  if (left[0].seconds < 20) await new Promise((resolve) => setTimeout(resolve, (left[0].seconds + 1) * 1000))
}

/** Waits until `condition()` is true, and fails if it is not within `ms`. */
async function until(condition, ms = 4000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`the condition did not come true within ${ms} ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const PLAIN_500 = { error: { code: 'server_error', message: 'Something went wrong' } }

describe('a 500 on a matched route', () => {
  it('writes one row with the route as written in the code, the method, the status, the code and the build', async () => {
    const before = process.env.VERCEL_GIT_COMMIT_SHA
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890'
    try {
      const { r } = await boom('/api/test/boom')
      expect(r.status).toBe(500)
    } finally {
      if (before === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA
      else process.env.VERCEL_GIT_COMMIT_SHA = before
    }
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      source: 'server',
      kind: 'error',
      place: '/test/boom',
      method: 'GET',
      status: 500,
      code: 'XX000',
      app_build: 'abcdef1', // the first 7 characters of the commit, as /api/health says it
      count: 1,
      last_request_id: null,
    })
    expect(found[0].first_at).toBeInstanceOf(Date)
    expect(found[0].last_at).toBeInstanceOf(Date)
    const { rows: bucket } = await db.pool.query("select bucket = date_trunc('hour', first_at) as same from app_errors")
    expect(bucket[0].same).toBe(true)
  })

  it('leaves the build empty when the deployment has no commit (local, tests)', async () => {
    const before = process.env.VERCEL_GIT_COMMIT_SHA
    delete process.env.VERCEL_GIT_COMMIT_SHA
    try {
      await boom('/api/test/boom')
    } finally {
      if (before !== undefined) process.env.VERCEL_GIT_COMMIT_SHA = before
    }
    expect((await rows())[0].app_build).toBe('')
  })

  it('adds 1 to the count of the same row for a second 500 in the same hour', async () => {
    await notNearTheTurnOfTheHour()
    await boom('/api/test/boom')
    const first = (await rows())[0]
    await boom('/api/test/boom')
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0].id).toBe(first.id)
    expect(found[0].count).toBe(2)
    expect(found[0].first_at).toEqual(first.first_at)
    expect(found[0].last_at.getTime()).toBeGreaterThanOrEqual(first.last_at.getTime())
  })

  it('keeps a different route, method, code or name in a row of its own', async () => {
    await notNearTheTurnOfTheHour()
    await boom('/api/test/boom')
    await boom('/api/test/other') // another route, and a TypeError that has no code (its name is the label)
    await call('POST', '/api/test/boom', { body: {} }) // the same route, another method
    await boom('/api/test/thrown-string') // not an Error: only its type is the label
    const found = await rows()
    expect(found.map((r) => [r.method, r.place, r.code]).sort()).toEqual(
      [
        ['GET', '/test/boom', 'XX000'],
        ['GET', '/test/other', 'TypeError'],
        ['POST', '/test/boom', 'XX000'],
        ['GET', '/test/thrown-string', 'thrown string'],
      ].sort(),
    )
    for (const r of found) expect(r.count).toBe(1)
  })

  it('is answered and logged exactly as before: the same 500 and one console.error call', async () => {
    const { r, calls } = await boom('/api/test/boom')
    expect(r.status).toBe(500)
    expect(r.json).toEqual(PLAIN_500)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1)
    expect(calls[0][0]).toContain('unhandled API error: GET /api/test/boom')
  })
})

describe('nothing sensitive is stored', () => {
  it('keeps no message, no path value and no query string, only the route as written in the code', async () => {
    const { r } = await boom('/api/test/secret/secret-value-123?x=private')
    expect(r.status).toBe(500)
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0].place).toBe('/test/secret/:id')
    const everything = JSON.stringify(found)
    for (const value of [MESSAGE, 'could not write', PERSONAL, 'example.com', 'secret-value-123', 'private', 'x=', 'Key (email)']) {
      expect(everything, value).not.toContain(value)
    }
    // And not in the answer either.
    for (const value of [MESSAGE, PERSONAL, 'secret-value-123', 'private']) expect(r.text, value).not.toContain(value)
  })

  it('stores only the type of something that is not an Error', async () => {
    await boom('/api/test/thrown-string')
    const found = await rows()
    expect(found[0].code).toBe('thrown string')
    expect(JSON.stringify(found)).not.toContain(PERSONAL)
  })
})

describe('the request id', () => {
  it('is in the 500 answer and in the row when x-vercel-id is well formed', async () => {
    const { r } = await boom('/api/test/boom', { headers: { 'x-vercel-id': REQUEST_ID } })
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ error: { code: 'server_error', message: 'Something went wrong', request_id: REQUEST_ID } })
    expect((await rows())[0].last_request_id).toBe(REQUEST_ID)
  })

  it('is neither answered nor stored when the header is malformed or too long', async () => {
    for (const bad of ['bad id!', 'x'.repeat(300), 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1), '<script>', 'id\nforged: header', 'a,b']) {
      await db.pool.query('delete from app_errors')
      const { r } = await boom('/api/test/boom', { headers: { 'x-vercel-id': bad } })
      expect(r.status, bad).toBe(500)
      expect(r.json, bad).toEqual(PLAIN_500)
      const found = await rows()
      expect(found, bad).toHaveLength(1)
      expect(found[0].last_request_id, bad).toBeNull()
    }
  })

  it('accepts the longest one the column holds, and is exactly the old answer when there is none', async () => {
    const longest = 'a'.repeat(REQUEST_ID_MAX_LENGTH)
    const { r } = await boom('/api/test/boom', { headers: { 'x-vercel-id': longest } })
    expect(r.json.error.request_id).toBe(longest)
    expect((await rows())[0].last_request_id).toBe(longest)

    await db.pool.query('delete from app_errors')
    const none = await boom('/api/test/boom')
    expect(none.r.json).toEqual(PLAIN_500)
    expect(Object.keys(none.r.json.error)).toEqual(['code', 'message'])
    expect(none.r.text).toBe(JSON.stringify(PLAIN_500))
    expect((await rows())[0].last_request_id).toBeNull()
  })

  it('is the latest well-formed one on the row, and a missing one does not erase it', async () => {
    await notNearTheTurnOfTheHour()
    await boom('/api/test/boom', { headers: { 'x-vercel-id': 'first-id' } })
    await boom('/api/test/boom', { headers: { 'x-vercel-id': 'second-id' } })
    expect((await rows())[0].last_request_id).toBe('second-id')
    await boom('/api/test/boom') // no id: the row keeps the one it has
    await boom('/api/test/boom', { headers: { 'x-vercel-id': 'bad id!' } }) // a bad one counts as none
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0].count).toBe(4)
    expect(found[0].last_request_id).toBe('second-id')
  })

  it('is read by requestIdOf from the header only', () => {
    expect(requestIdOf({ 'x-vercel-id': REQUEST_ID })).toBe(REQUEST_ID)
    expect(requestIdOf({ 'x-vercel-id': 'a'.repeat(REQUEST_ID_MAX_LENGTH) })).toHaveLength(REQUEST_ID_MAX_LENGTH)
    for (const headers of [undefined, {}, { 'x-vercel-id': '' }, { 'x-vercel-id': ['a', 'b'] }, { 'x-vercel-id': 5 }, { 'x-request-id': 'abc' }]) {
      expect(requestIdOf(headers), JSON.stringify(headers)).toBeNull()
    }
  })
})

describe('when the database is the failure', () => {
  it('attempts no insert for a failure to reach the database, and still answers with one log line', async () => {
    for (const path of ['/api/test/socket-refused', '/api/test/connection-exception', '/api/test/pool-timeout']) {
      const { result, statements } = await withStatements(() => boom(path))
      expect(result.r.status, path).toBe(500)
      expect(result.r.json, path).toEqual(PLAIN_500)
      expect(result.calls, path).toHaveLength(1)
      expect(statements, `${path}: not a single statement`).toEqual([])
    }
    expect(await rows()).toEqual([])
  })

  it('attempts exactly one statement, the upsert, for any other error', async () => {
    const { result, statements } = await withStatements(() => boom('/api/test/boom'))
    expect(result.r.status).toBe(500)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^insert into app_errors .* on conflict on constraint app_errors_key do update/)
  })

  it('answers within about the timeout when the insert hangs, and logs once', async () => {
    setPool({ query: () => new Promise(() => {}) }) // a query that never answers
    const started = Date.now()
    const { r, calls } = await boom('/api/test/boom', { headers: { 'x-vercel-id': REQUEST_ID } })
    const took = Date.now() - started
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ error: { code: 'server_error', message: 'Something went wrong', request_id: REQUEST_ID } })
    expect(calls).toHaveLength(1)
    expect(took).toBeGreaterThanOrEqual(ERROR_RECORD_TIMEOUT_MS - 50) // it did wait for the bounded insert
    expect(took).toBeLessThan(ERROR_RECORD_TIMEOUT_MS + 1000) // and not much longer
  })

  it('answers the same 500, with one console.error call, when the insert fails', async () => {
    const secret = Object.assign(new Error(`insert failed for ${PERSONAL}`), { code: 'XX000', detail: `Key (email)=(${PERSONAL})` })
    for (const broken of [
      { query: () => Promise.reject(secret) }, // the insert fails
      {
        query: () => {
          throw secret // the pool fails before it returns a promise
        },
      },
    ]) {
      setPool(broken)
      const { r, calls } = await boom('/api/test/boom')
      expect(r.status).toBe(500)
      expect(r.json).toEqual(PLAIN_500)
      expect(calls).toHaveLength(1) // the one line of the router, nothing about the failed record
      expect(String(calls[0])).not.toContain(PERSONAL)
    }
  })

  it('does not record, and does not throw, when the table is not there', async () => {
    await db.pool.query('alter table app_errors rename to app_errors_away')
    try {
      const { r, calls } = await boom('/api/test/boom')
      expect(r.status).toBe(500)
      expect(r.json).toEqual(PLAIN_500)
      expect(calls).toHaveLength(1)
    } finally {
      await db.pool.query('alter table app_errors_away rename to app_errors')
    }
  })
})

// A pool of the size of the app's (3) on the schema of this file, so that "busy" and "back in the pool" can be counted. The
// statements below are the real ones, on a real database; only the pool is the test's, and the file's afterEach puts the
// pool of setupDb back.
describe('recording never queues behind other work, and the database bounds the insert', () => {
  const event = { source: 'server', kind: 'error', place: '/test/boom', method: 'GET', status: 500, code: 'XX000', appBuild: 'abcdef1' }
  const SETTINGS =
    "select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout, current_setting('idle_in_transaction_session_timeout') as idle"
  let own

  // A new pool for every test, with one idle client, so that every test starts from the same state (1 open, 1 idle, nobody
  // waiting) whatever the test before it did, and a client that the idle timeout of the pool would have closed cannot change a count.
  beforeEach(async () => {
    const raw = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
    own = createPool({ ...poolConfig(raw, db.schema), max: 3 })
    await assertNotProduction(own)
    setPool(own)
    await own.query('select 1')
  })
  afterEach(async () => {
    vi.restoreAllMocks() // the spies of the test are on this pool, and it is about to end
    await own.end()
  })

  const checkedOut = () => own.totalCount - own.idleCount
  const shape = () => ({ total: own.totalCount, idle: own.idleCount })

  /** Calls through to the pool and writes down how every query ends (a SQLSTATE, a name, or 'ok'), also after the caller gave up. */
  function watch() {
    const ends = []
    const real = own.query.bind(own)
    const spy = vi.spyOn(own, 'query').mockImplementation((...args) => {
      const promise = real(...args)
      promise.then(
        () => ends.push('ok'),
        (err) => ends.push(typeof err.code === 'string' ? err.code : err.name), // an AbortError has a number for a code
      )
      return promise
    })
    return { ends, spy }
  }

  /** Runs `fn` while `count` clients of the pool are held by the test, and gives them back after it. */
  async function whileHolding(count, fn) {
    const held = []
    try {
      while (held.length < count) held.push(await own.connect())
      return await fn()
    } finally {
      for (const client of held) client.release()
    }
  }

  it('records when the pool has room: a client at once, and still one left for the requests that are being served', async () => {
    const seen = watch()
    await whileHolding(own.options.max - ERROR_RECORD_POOL_RESERVE - 1, () => recordEvent(event))
    expect(seen.spy).toHaveBeenCalledTimes(1)
    expect(seen.ends).toEqual(['ok'])
    expect((await rows()).map((r) => r.count)).toEqual([1])
  })

  it('makes no query, and returns at once, when every client of the pool is held', async () => {
    const seen = watch()
    const took = await whileHolding(own.options.max, async () => {
      const started = Date.now()
      await recordEvent(event)
      return Date.now() - started
    })
    expect(took).toBeLessThan(100)
    expect(seen.spy).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
  })

  it('does not take the last free connection: one that is left is kept for a request that is being served', async () => {
    const seen = watch()
    await whileHolding(own.options.max - ERROR_RECORD_POOL_RESERVE, () => recordEvent(event))
    expect(seen.spy).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
    // The pool kept that client: a request that came next is served at once.
    const next = await own.connect()
    next.release()
  })

  it('does not join a queue: with a request waiting for a client, a burst of failures asks for nothing and adds no waiter', async () => {
    const seen = watch()
    let waiter
    await whileHolding(own.options.max, async () => {
      waiter = own.connect() // a request that waits for a client
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(own.waitingCount).toBe(1)
      await Promise.all(Array.from({ length: 25 }, () => recordEvent(event)))
      expect(own.waitingCount).toBe(1) // still only the request
    })
    ;(await waiter).release() // the request got the client that was given back
    expect(seen.spy).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
  })

  it('does not record while anything waits for a client, also when a client is idle (a pool that says so)', async () => {
    const attempted = []
    const query = (...args) => (attempted.push(args), Promise.resolve({ rows: [], rowCount: 0 }))
    setPool({ totalCount: 1, idleCount: 1, waitingCount: 1, options: { max: 3 }, query })
    await recordEvent(event)
    expect(attempted).toEqual([])
    setPool({ totalCount: 1, idleCount: 1, waitingCount: 0, options: { max: 3 }, query })
    await recordEvent(event)
    expect(attempted).toHaveLength(1) // the same pool with nobody waiting is used
  })

  it('has the database cancel an insert that is slow, at the limit of the insert: the client goes back to the pool, nothing is half written', async () => {
    await recordEvent(event) // the row exists, with a count of 1
    const before = shape()
    expect(before).toEqual({ total: 1, idle: 1 }) // the one client of the pool, idle
    await db.pool.query(
      `create function slow_app_errors() returns trigger language plpgsql as $$ begin perform pg_sleep(8); return new; end $$`,
    )
    await db.pool.query('create trigger slow_app_errors before insert or update on app_errors for each row execute function slow_app_errors()')
    try {
      const seen = watch()
      const started = Date.now()
      await recordEvent(event) // would be the second event of the hour: the count would be 2
      const took = Date.now() - started
      expect(took).toBeGreaterThanOrEqual(ERROR_RECORD_TIMEOUT_MS - 50) // the request waited for the bounded insert
      expect(took).toBeLessThan(ERROR_RECORD_TIMEOUT_MS + 1000) // and not for the 8 s of the sleep
      // It is the database that ended the statement (query_canceled), about as soon as the request gave up, not the 8 s of the
      // sleep and not the 15 s that every other statement may take.
      await until(() => seen.ends.length === 1, 3000)
      expect(seen.ends).toEqual(['57014'])
      await until(() => checkedOut() === 0, 3000)
      expect(shape()).toEqual(before) // the connection is back, and it is the same one
    } finally {
      await db.pool.query('drop trigger slow_app_errors on app_errors')
      await db.pool.query('drop function slow_app_errors()')
    }
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0].count).toBe(1) // the update was rolled back with the cut statement
    // The pool serves the next request.
    expect((await own.query('select 41 + 1 as answer')).rows).toEqual([{ answer: 42 }])
  })

  it('gives up on a row that another transaction holds at the lock limit, well before the time limit, and releases the client', async () => {
    await recordEvent(event)
    const before = shape()
    const holder = await db.pool.connect()
    try {
      await holder.query('begin')
      await holder.query('select 1 from app_errors for update')
      const seen = watch()
      const started = Date.now()
      await recordEvent(event)
      const took = Date.now() - started
      expect(took).toBeGreaterThanOrEqual(ERROR_RECORD_LOCK_TIMEOUT_MS - 50)
      expect(took).toBeLessThan(ERROR_RECORD_TIMEOUT_MS) // it did not wait for the time limit of the insert either
      await until(() => seen.ends.length === 1, 3000)
      expect(seen.ends).toEqual(['55P03']) // lock_not_available: the lock limit, not query_canceled
    } finally {
      await holder.query('rollback')
      holder.release()
    }
    await until(() => checkedOut() === 0, 3000)
    expect(shape()).toEqual(before)
    expect((await rows())[0].count).toBe(1)
  })

  it('returns a connection that arrives after the request gave up, unused', async () => {
    const connect = own.connect.bind(own)
    // A connection that takes longer than the request waits (a database that is slow to answer).
    vi.spyOn(own, 'connect').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, ERROR_RECORD_TIMEOUT_MS + 300))
      return connect()
    })
    const seen = watch()
    const started = Date.now()
    await recordEvent(event)
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(ERROR_RECORD_TIMEOUT_MS - 50)
    expect(took).toBeLessThan(ERROR_RECORD_TIMEOUT_MS + 200) // the request was answered at the limit, not when the connection came
    expect(seen.ends).toEqual([]) // nothing has come of it yet
    await until(() => seen.ends.length === 1, 3000)
    expect(seen.ends).toEqual(['AbortError']) // it started nothing
    await until(() => checkedOut() === 0, 3000)
    expect(await rows()).toEqual([]) // and wrote nothing
  })

  it('gives the client back when the insert fails', async () => {
    await db.pool.query('alter table app_errors rename to app_errors_away')
    try {
      const before = shape()
      const seen = watch()
      await recordEvent(event)
      expect(seen.ends).toEqual(['42P01']) // undefined_table
      expect(checkedOut()).toBe(0)
      expect(shape()).toEqual(before)
    } finally {
      await db.pool.query('alter table app_errors_away rename to app_errors')
    }
  })

  it('puts the limits on the insert only: the insert runs with its own, and every other statement keeps the limits of the pool', async () => {
    expect(ERROR_RECORD_LIMITS).toEqual({
      statementMs: ERROR_RECORD_TIMEOUT_MS,
      idleInTransactionMs: ERROR_RECORD_TIMEOUT_MS,
      lockMs: ERROR_RECORD_LOCK_TIMEOUT_MS,
    })
    expect(Object.isFrozen(ERROR_RECORD_LIMITS)).toBe(true)
    expect(ERROR_RECORD_LOCK_TIMEOUT_MS).toBeLessThan(ERROR_RECORD_TIMEOUT_MS)
    // The limits of the app are what they were: 15 s and 20 s, and no lock limit.
    expect(QUERY_LIMITS).toEqual({ statementMs: 15_000, idleInTransactionMs: 20_000 })
    expect(own.limits).toEqual(QUERY_LIMITS)

    // A trigger writes down the limits that the insert ran with.
    await db.pool.query('create table seen_limits (statement_timeout text, lock_timeout text, idle text)')
    await db.pool.query(
      `create function note_limits() returns trigger language plpgsql as $$
         begin
           insert into seen_limits values (current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('idle_in_transaction_session_timeout'));
           return new;
         end $$`,
    )
    await db.pool.query('create trigger note_limits before insert on app_errors for each row execute function note_limits()')
    try {
      await recordEvent(event)
      const { rows: seen } = await db.pool.query('select * from seen_limits')
      expect(seen).toEqual([{ statement_timeout: '1500ms', lock_timeout: '500ms', idle: '1500ms' }])
      // Straight after it, on the same pool and the same connection, nothing has changed for anybody else.
      const others = { statement_timeout: '15s', lock_timeout: '0', idle: '20s' }
      expect((await own.query(SETTINGS)).rows).toEqual([others])
      expect((await db.pool.query(SETTINGS)).rows).toEqual([others])
      const client = await own.connect()
      try {
        expect((await client.query(SETTINGS)).rows[0].lock_timeout).toBe('0')
        expect((await client.query(SETTINGS)).rows[0].statement_timeout).not.toBe('1500ms')
      } finally {
        client.release()
      }
    } finally {
      await db.pool.query('drop trigger note_limits on app_errors')
      await db.pool.query('drop function note_limits()')
      await db.pool.query('drop table seen_limits')
    }
  })
})

describe('isConnectionFailure', () => {
  const withCode = (code) => Object.assign(new Error('x'), { code })

  it('is true for a SQLSTATE of class 08, for 57P01, 57P02 and 57P03, and for the socket codes of Node', () => {
    for (const code of ['08000', '08001', '08003', '08004', '08006', '08007', '08P01', '57P01', '57P02', '57P03']) {
      expect(isConnectionFailure(withCode(code)), code).toBe(true)
    }
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']) {
      expect(isConnectionFailure(withCode(code)), code).toBe(true)
    }
  })

  it('is true for the pool that waited too long for a connection and for a connection that ended', () => {
    expect(isConnectionFailure(new Error('timeout exceeded when trying to connect'))).toBe(true)
    expect(isConnectionFailure(new Error('Connection terminated unexpectedly'))).toBe(true)
    expect(isConnectionFailure(new Error('Connection terminated due to connection timeout'))).toBe(true)
  })

  it('is true for an error that wraps one (a cause, or the errors of an AggregateError)', () => {
    expect(isConnectionFailure(new Error('outer', { cause: withCode('ECONNRESET') }))).toBe(true)
    expect(isConnectionFailure(new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')], 'both addresses'))).toBe(true)
    expect(isConnectionFailure(new Error('outer', { cause: new Error('inner', { cause: withCode('08006') }) }))).toBe(true)
  })

  it('is false for everything else: a data error, a statement that ran too long, a bug, and anything that is not an error', () => {
    for (const code of ['23505', '22P02', '57014', '25P03', 'XX000', '42P01', '0A000', 'ECONNABORTED', 'timeout', '']) {
      expect(isConnectionFailure(withCode(code)), code).toBe(false)
    }
    expect(isConnectionFailure(new TypeError('Cannot read properties of undefined'))).toBe(false)
    expect(isConnectionFailure(new Error('a timeout happened'))).toBe(false)
    expect(isConnectionFailure(new Error('x', { cause: withCode('23505') }))).toBe(false)
    for (const value of [undefined, null, 'ECONNRESET', 42, true, [], {}]) expect(isConnectionFailure(value), String(value)).toBe(false)
    // Only an Error is read for the message of the pool, so a plain object that quotes it is not taken for one.
    expect(isConnectionFailure({ message: 'timeout exceeded when trying to connect' })).toBe(false)
    // A cycle in the causes ends.
    const loop = new Error('loop')
    loop.cause = loop
    expect(isConnectionFailure(loop)).toBe(false)
  })
})

describe('every field is checked or cut before the query', () => {
  const valid = { source: 'server', kind: 'error', place: '/test/boom', method: 'GET', status: 500, code: 'XX000', appBuild: 'abcdef1' }

  it('cuts a very long code, place and build to the limit of the column, and the row is still written', async () => {
    await recordEvent({ ...valid, place: `/${'p'.repeat(500)}`, code: 'c'.repeat(500), appBuild: 'b'.repeat(500) })
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0].place).toHaveLength(PLACE_MAX_LENGTH)
    expect(found[0].code).toBe('c'.repeat(CODE_MAX_LENGTH))
    expect(found[0].app_build).toBe('b'.repeat(APP_BUILD_MAX_LENGTH))
  })

  it('cuts the long route of a real 500 and the row is still written', async () => {
    const { r } = await boom(`/api/test/long/${LONG_SEGMENT}`)
    expect(r.status).toBe(500)
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0].place).toHaveLength(PLACE_MAX_LENGTH)
    expect(found[0].place.startsWith('/test/long/segment')).toBe(true)
  })

  it('turns a bad method, status or request id into the empty value, and never lets it fail the insert', async () => {
    for (const status of [-1, 600, 99999, 3.5, NaN, Infinity, 'abc', undefined, null, {}]) {
      await recordEvent({ ...valid, status })
    }
    for (const method of ['TRACE', 'get', '', 'GET\r\nX: y', undefined, null, 5]) await recordEvent({ ...valid, method, status: 500 })
    await recordEvent({ ...valid, requestId: 'bad id!' })
    await recordEvent({ ...valid, requestId: 42 })
    const found = await rows()
    // Every call above wrote (or added to) a row: none of them failed.
    expect(found.reduce((sum, r) => sum + r.count, 0)).toBe(10 + 7 + 2)
    expect(found.every((r) => r.status >= 0 && r.status <= STATUS_MAX)).toBe(true)
    expect(found.every((r) => ['', ...EVENT_METHODS].includes(r.method))).toBe(true)
    expect(found.every((r) => r.last_request_id === null)).toBe(true)
    expect(found.find((r) => r.method === 'GET' && r.status === 500)).toBeDefined()
  })

  it('writes one line and without control characters, so that a NUL byte cannot fail the insert', async () => {
    await recordEvent({ ...valid, code: 'bad\u0000code\nline two', place: '/a\u0000b', appBuild: 'x\u0000y' })
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ code: 'bad code line two', place: '/a b', app_build: 'x y' })
  })

  it('stores a place of at least one character, also when the caller gives none', async () => {
    for (const place of ['', '   ', undefined, null, 7]) await recordEvent({ ...valid, place })
    const found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0].place).toBe('(unknown)')
    expect(found[0].count).toBe(5)
  })

  it('writes nothing for a source or a kind that is not on the lists', async () => {
    await recordEvent({ ...valid, source: 'phone' })
    await recordEvent({ ...valid, kind: 'warning' })
    await recordEvent({ ...valid, source: undefined })
    await recordEvent({ ...valid, kind: 'ERROR' })
    await recordEvent(undefined)
    expect(await rows()).toEqual([])
  })

  it('never throws, whatever it is given', async () => {
    for (const event of [undefined, null, {}, 5, 'x', [], { source: 'server', kind: 'error', place: {} }]) {
      await expect(recordEvent(event)).resolves.toBeUndefined()
    }
  })

  it('accepts every source and kind of the lists', async () => {
    for (const source of EVENT_SOURCES) for (const kind of EVENT_KINDS) await recordEvent({ ...valid, source, kind })
    expect(await rows()).toHaveLength(EVENT_SOURCES.length * EVENT_KINDS.length)
  })
})

describe('the vocabulary of the code is the table', () => {
  // The values that a check constraint of app_errors lists for one column, read from the database itself.
  async function checkOf(column) {
    const { rows: found } = await db.pool.query(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'app_errors'::regclass and c.contype = 'c' and a.attname = $1`,
      [column],
    )
    expect(found, `exactly one check on ${column}`).toHaveLength(1)
    return found[0].def
  }
  const listed = (def) => [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1])
  const numbers = (def) => [...def.matchAll(/(?:<=|>=|<|>) (\d+)/g)].map((m) => Number(m[1]))

  it('source, kind and method are the lists of server/errorLog.js, and nothing else', async () => {
    expect(listed(await checkOf('source')).sort()).toEqual([...EVENT_SOURCES].sort())
    expect(listed(await checkOf('kind')).sort()).toEqual([...EVENT_KINDS].sort())
    expect(listed(await checkOf('method')).sort()).toEqual(['', ...EVENT_METHODS].sort())
  })

  it('the lists are frozen (a caller cannot add a value that the table would refuse)', () => {
    for (const list of [EVENT_SOURCES, EVENT_KINDS, EVENT_METHODS]) {
      expect(Object.isFrozen(list)).toBe(true)
      expect(() => list.push('x')).toThrow(TypeError)
    }
  })

  it('the length limits and the largest status are the checks of the table', async () => {
    expect(numbers(await checkOf('place'))).toEqual([1, PLACE_MAX_LENGTH])
    expect(numbers(await checkOf('code'))).toEqual([CODE_MAX_LENGTH])
    expect(numbers(await checkOf('app_build'))).toEqual([APP_BUILD_MAX_LENGTH])
    expect(numbers(await checkOf('last_request_id'))).toEqual([REQUEST_ID_MAX_LENGTH])
    expect(numbers(await checkOf('status'))).toEqual([0, STATUS_MAX])
  })

  it('the table refuses what the code never sends (the checks are the second line)', async () => {
    const insert = (over) =>
      db.pool.query(
        `insert into app_errors (bucket, source, kind, place, method, status, code, app_build)
         values (date_trunc('hour', now()), $1, $2, $3, $4, $5, $6, $7)`,
        [over.source ?? 'server', over.kind ?? 'error', over.place ?? '/x', over.method ?? '', over.status ?? 0, over.code ?? '', over.appBuild ?? ''],
      )
    await expect(insert({ source: 'phone' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ kind: 'warning' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ place: '' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ place: 'p'.repeat(PLACE_MAX_LENGTH + 1) })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ method: 'TRACE' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ status: 600 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ code: 'c'.repeat(CODE_MAX_LENGTH + 1) })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ appBuild: 'b'.repeat(APP_BUILD_MAX_LENGTH + 1) })).rejects.toMatchObject({ code: '23514' })
    expect(await rows()).toEqual([])
  })
})

describe('what is not recorded', () => {
  it('a refusal (an ApiError, a 4xx, whatever its status), an Answer and a database 4xx write nothing and make no statement', async () => {
    const paths = [
      ['/api/test/refused', 400],
      ['/api/test/forbidden', 403],
      ['/api/test/api-error-5xx-shaped', 503], // an ApiError is the router's own answer, not an unhandled error
      ['/api/test/answer', 503],
      ['/api/test/unique-violation', 409],
    ]
    const { result, statements } = await withStatements(async () => {
      const out = []
      for (const [path, status] of paths) {
        const { r, calls } = await boom(path)
        out.push({ path, status, got: r.status, calls })
      }
      return out
    })
    for (const { path, status, got, calls } of result) {
      expect(got, path).toBe(status)
      expect(calls, `${path}: nothing logged either`).toEqual([])
    }
    expect(statements).toEqual([])
    expect(await rows()).toEqual([])
  })

  it('a request that matched no route (404, or 405 for another method) writes nothing', async () => {
    const { result, statements } = await withStatements(async () => [
      await boom('/api/test/nothing-here'),
      await call('PUT', '/api/test/boom', { body: {} }), // the path of a route, but not for this method
    ])
    expect(result[0].r.status).toBe(404)
    expect(result[1].status).toBe(405)
    expect(statements).toEqual([])
    expect(await rows()).toEqual([])
  })
})
