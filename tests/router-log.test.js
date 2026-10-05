// What the router writes to the log when no route handled an error. The runtime logs are kept by the host and read by more
// people than the committee, so the line may hold only fields that cannot carry personal data (see describeUnhandled in
// server/router.js). A Postgres error object carries the values of the failing row in `detail`: it must never be logged.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import pg from 'pg'
import { call } from './helpers.js'
import { route } from '../server/router.js'
import { getPool, setPool } from '../server/db.js'
import { resetAlertThrottle, ALERT_LIMITS } from '../server/alerts.js'

// An unhandled error on a matched route is also recorded in app_errors (server/errorLog.js), so the router asks the database for
// an insert. This file has no database and must not reach one: it is not in a throwaway schema, and it does not run the guard
// that refuses a production database (setupDb in tests/helpers.js). So the only pool is a stub that writes down what it is asked
// and writes nothing, the URLs of the database are blanked for the file (a pool that was not the stub could not be built), and
// every test ends by checking that no connection was opened. The same holds for the network: the first error of a day also
// pings healthchecks.io (server/alerts.js), but the tests have no address for it (tests/setup-no-heartbeat.js), and every test
// ends by checking that the real fetch was not asked for anything. The one test that does set an address sends through a fetch
// that it injects.
//
// The routes below exist only for this file, and they answer without credentials because what is tested is what the router
// logs, not who may call. The router gives a route to nobody by default (server/access.js: a pattern that is neither PUBLIC
// nor owned by a rule cannot be registered), and the production PUBLIC list must not learn about test routes. So this file
// replaces `accessFor` with a version that calls the real one for everything except the `/test/` paths. vi.mock changes the
// module only inside this test file's own module graph, so the production code has no hook for it: no function, flag or
// environment variable in server/ can register a route that skips the policy.
vi.mock('../server/access.js', async (importOriginal) => {
  const real = await importOriginal()
  const open = Object.freeze({ public: true })
  return { ...real, accessFor: (method, pattern) => (pattern.startsWith('/test/') ? open : real.accessFor(method, pattern)) }
})

const PERSONAL = 'someone@example.com'

route('GET', '/test/postgres-error', async () => {
  // The shape of a real `pg` error, with a SQLSTATE that the router does not turn into a 4xx.
  const err = new Error('internal failure while writing a row')
  err.name = 'error'
  Object.assign(err, {
    code: 'XX000',
    detail: `Key (email)=(${PERSONAL}) already exists.`,
    where: `SQL statement "insert ... ${PERSONAL}"`,
    table: 'secret_table',
    column: 'secret_column',
    schema: 'secret_schema',
    constraint: 'secret_constraint',
    parameters: [PERSONAL],
  })
  throw err
})

route('GET', '/test/unique-violation', async () => {
  // SQLSTATE 23505 is the caller's fault (409) and is not logged at all.
  throw Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    detail: `Key (email)=(${PERSONAL}) already exists.`,
  })
})

route('GET', '/test/personal-message', async () => {
  // Some errors quote an input or a row value in the message itself (here with an internal code, so it reaches the log).
  throw Object.assign(new Error(`invalid input syntax for type uuid: "${PERSONAL}"`), { code: 'XX001' })
})

route('GET', '/test/person/:id', async () => {
  throw new TypeError('Cannot read properties of undefined')
})

route('GET', '/test/fake-frame', async () => {
  // A message that quotes a value after a newline, shaped like a stack frame: V8 copies it into the stack.
  throw Object.assign(new Error(`bad input\n    at ${PERSONAL} (/server/x.js:1:1)\n    at next`), { code: 'XX001' })
})

route('GET', '/test/changed-message', async () => {
  const err = new Error(`bad input\n    at ${PERSONAL}`)
  void err.stack // V8 writes the stack when it is first read, so after this it keeps the first message
  err.message = 'something else'
  throw err
})

route('GET', '/test/plain-error', async () => {
  throw new TypeError('Cannot read properties of undefined')
})

route('GET', '/test/multi-line', async () => {
  throw new Error('first line\n2026-01-01 00:00:00 FORGED log line\r\nthird')
})

route('GET', '/test/long-message', async () => {
  throw new Error('x'.repeat(5000))
})

route('GET', '/test/thrown-string', async () => {
  throw PERSONAL
})

route('GET', '/test/thrown-object', async () => {
  throw { detail: PERSONAL, code: 'XX000', message: PERSONAL }
})

/** What the 500 path asked of the database (the stub below answers every query with no rows and refuses every connection). */
const attempts = []
// The insert of the alert (alert_pings) is answered with one row ("the first error of the day") when a test sets this.
let firstErrorOfTheDay = false
const noDatabase = {
  query: (text, params, options) => {
    attempts.push({ text: String(text).replace(/\s+/g, ' ').trim(), params, options })
    const claimed = firstErrorOfTheDay && /^\s*insert into alert_pings /.test(String(text))
    return Promise.resolve({ rows: claimed ? [{ day: params[0] }] : [], rowCount: claimed ? 1 : 0 })
  },
  connect: () => {
    attempts.push({ text: '(a connection)' })
    return Promise.reject(new Error('tests/router-log.test.js does not open a connection'))
  },
}
let realConnections // spies on the real pool and client of `pg`: neither may be asked for a connection
let reachedForTheNetwork // what the real fetch was asked for: nothing may be

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('DATABASE_URL_UNPOOLED', '')
  vi.stubEnv('DB_SCHEMA', '')
  setPool(noDatabase)
})
afterAll(() => {
  setPool(undefined)
  vi.unstubAllEnvs()
})
beforeEach(() => {
  attempts.length = 0
  firstErrorOfTheDay = false
  realConnections = [vi.spyOn(pg.Pool.prototype, 'connect'), vi.spyOn(pg.Client.prototype, 'connect')]
  reachedForTheNetwork = []
  vi.stubGlobal('fetch', (url) => {
    reachedForTheNetwork.push(String(url))
    return Promise.reject(new Error('tests/router-log.test.js does not reach the network'))
  })
})
afterEach(() => {
  for (const spy of realConnections) expect(spy).not.toHaveBeenCalled()
  expect(reachedForTheNetwork, 'a test reached for the real fetch').toEqual([])
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Calls a route that throws and returns the response and everything that was passed to console.error. */
async function boom(path) {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  // Since Vitest 4, spying on a method that is already spied returns the same spy, so a second call in one test would still
  // hold what the first one logged. Start every call from an empty record.
  logged.mockClear()
  const r = await call('GET', path)
  return { r, calls: logged.mock.calls }
}

describe('an unhandled error', () => {
  it('is answered with a plain 500 that says nothing about the cause', async () => {
    const { r } = await boom('/api/test/postgres-error')
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ error: { code: 'server_error', message: 'Something went wrong' } })
    expect(r.text).not.toContain(PERSONAL)
    expect(r.text).not.toContain('XX000')
  })

  it('is logged as one line with the route, the error name and the code, and nothing from the row', async () => {
    const { calls } = await boom('/api/test/postgres-error')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1) // one string, not the error object
    const line = calls[0][0]
    expect(typeof line).toBe('string')
    expect(line).not.toMatch(/[\r\n]/)
    expect(line).toContain('unhandled API error:')
    expect(line).toContain('GET /api/test/postgres-error')
    expect(line).toContain(' error ') // the name of a pg error
    expect(line).toContain('code=XX000')
    expect(line).not.toContain('message')
    expect(line).not.toContain('internal failure while writing a row')
    expect(line).not.toContain(PERSONAL)
    expect(line).not.toContain('example.com')
    expect(line).not.toContain('detail')
    expect(line).not.toContain('Key (email)')
    expect(line).not.toContain('secret_')
    expect(line).not.toContain('parameters')
  })

  it('keeps the stack frames (where it happened) but not the first line of the stack, which repeats the message', async () => {
    const { calls } = await boom('/api/test/plain-error')
    const line = calls[0][0]
    expect(line).toContain('TypeError')
    expect(line).not.toContain('code=') // this error has no code
    expect(line).toMatch(/stack: at .*router-log\.test\.js/)
    expect(line).not.toContain('Cannot read properties of undefined') // the message is never logged
  })

  it('never logs the message, which can quote a personal value', async () => {
    const { calls } = await boom('/api/test/personal-message')
    const line = calls[0][0]
    expect(line).toContain('code=XX001')
    expect(line).not.toContain(PERSONAL)
    expect(line).not.toContain('invalid input syntax')
  })

  it('names the route as it is written in the code, never the path that was asked for (it can hold a QR code or a name)', async () => {
    const { calls } = await boom(`/api/test/postgres-error?code=BQR-1234&name=${PERSONAL}#frag`)
    const line = calls[0][0]
    expect(line).toContain('GET /api/test/postgres-error ')
    expect(line).not.toMatch(/BQR-1234|someone|[?#]frag|name=/)

    const segment = (await boom(`/api/test/person/${encodeURIComponent(PERSONAL)}`)).calls[0][0]
    expect(segment).toContain('GET /api/test/person/:id TypeError')
    expect(segment).not.toContain('someone')
    expect(segment).not.toContain('example.com')
  })

  it('never takes a line of the message for a stack frame', async () => {
    const fake = (await boom('/api/test/fake-frame')).calls[0][0]
    expect(fake).toContain('code=XX001')
    expect(fake).toMatch(/stack: at .*router-log\.test\.js/) // the real frames are kept
    expect(fake).not.toContain('someone')
    expect(fake).not.toContain('/server/x.js')
    expect(fake).not.toContain('at next')

    // When the message no longer matches the stack, the header cannot be found, so no frame is trusted.
    const changed = (await boom('/api/test/changed-message')).calls[0][0]
    expect(changed).toBe('unhandled API error: GET /api/test/changed-message Error')
  })

  it('cannot be made to forge a second log line, or to fill the log', async () => {
    const forged = (await boom('/api/test/multi-line')).calls[0][0]
    expect(forged).not.toMatch(/[\r\n]/)
    expect(forged).not.toContain('FORGED')
    const long = (await boom('/api/test/long-message')).calls[0][0]
    expect(long.length).toBeLessThan(3000)
    expect(long).not.toContain('xxxxxxxxxx')
  })

  it('logs only the type of something that is not an Error', async () => {
    for (const [path, type] of [['/api/test/thrown-string', 'string'], ['/api/test/thrown-object', 'object']]) {
      const { r, calls } = await boom(path)
      expect(r.status).toBe(500)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual([`unhandled API error: GET ${path} thrown ${type}`])
    }
  })

  it('is not logged at all when it is the caller fault (a unique violation is a 409)', async () => {
    const { r, calls } = await boom('/api/test/unique-violation')
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('conflict')
    expect(r.text).not.toContain(PERSONAL)
    expect(calls).toEqual([])
  })

  it('an unknown route (404) is not logged either', async () => {
    const { r, calls } = await boom('/api/test/nothing-here')
    expect(r.status).toBe(404)
    expect(calls).toEqual([])
  })
})

describe('the record of an unhandled error (app_errors), with no database behind it', () => {
  it('has the stub as its only pool, and no URL of a database in the environment', () => {
    expect(getPool()).toBe(noDatabase)
    expect(process.env.DATABASE_URL).toBe('')
    expect(process.env.DATABASE_URL_UNPOOLED).toBe('')
  })

  it('is attempted once for a 500 on a matched route: the insert, with the route as written in the code and nothing personal', async () => {
    const { r } = await boom(`/api/test/postgres-error?code=BQR-1234&name=${PERSONAL}`)
    expect(r.status).toBe(500)
    expect(attempts).toHaveLength(1) // the insert, and nothing else: no connection, no second statement
    expect(attempts[0].text).toMatch(/^insert into app_errors .* on conflict on constraint app_errors_key do update/)
    expect(attempts[0].params.slice(0, 6)).toEqual(['server', 'error', '/test/postgres-error', 'GET', 500, 'XX000'])
    const everything = JSON.stringify(attempts)
    for (const value of [PERSONAL, 'example.com', 'BQR-1234', 'internal failure', 'secret_', 'Key (email)']) {
      expect(everything, value).not.toContain(value)
    }
  })

  it('is attempted for every kind of 500 the logging tests above make, and for no other answer', async () => {
    for (const path of ['/api/test/plain-error', '/api/test/personal-message', '/api/test/thrown-string', '/api/test/thrown-object']) {
      attempts.length = 0
      expect((await boom(path)).r.status, path).toBe(500)
      expect(attempts, path).toHaveLength(1)
    }
    attempts.length = 0
    expect((await boom('/api/test/unique-violation')).r.status).toBe(409) // the caller's fault
    expect((await boom('/api/test/nothing-here')).r.status).toBe(404)
    expect(attempts).toEqual([])
  })
})

describe('the first-error alert of the day (server/alerts.js), with no database and no network behind it', () => {
  const ADDRESS = 'https://hc.example.test/ping/00000000-0000-4000-8000-0000000000cc' // fake: the real address is a secret
  let savedAddress
  beforeEach(() => {
    savedAddress = process.env.HEALTH_HEARTBEAT_URL
    resetAlertThrottle()
  })
  afterEach(() => {
    if (savedAddress === undefined) delete process.env.HEALTH_HEARTBEAT_URL
    else process.env.HEALTH_HEARTBEAT_URL = savedAddress
  })

  it('has no address in the tests, so a 500 sends nothing and asks the stub for the record only', async () => {
    expect(process.env.HEALTH_HEARTBEAT_URL).toBe('')
    const { r } = await boom('/api/test/postgres-error')
    expect(r.status).toBe(500)
    expect(attempts).toHaveLength(1) // the record of app_errors, and no alert insert
    expect(attempts[0].text).toMatch(/^insert into app_errors /)
    expect(reachedForTheNetwork).toEqual([])
  })

  it('with an address, asks the stub once more (the alert insert, with the short limits) and sends only through the fetch that the test injects', async () => {
    process.env.HEALTH_HEARTBEAT_URL = ADDRESS
    firstErrorOfTheDay = true
    const sent = []
    vi.stubGlobal('fetch', async (url, init) => {
      sent.push({ url: String(url), method: init.method, body: init.body })
      return { status: 200, body: null }
    })
    const { r } = await boom(`/api/test/postgres-error?code=BQR-1234&name=${PERSONAL}`)
    expect(r.status).toBe(500)
    expect(attempts).toHaveLength(2) // the record, then the alert insert: both through the stub, no connection
    expect(attempts[1].text).toBe('insert into alert_pings (day) values ($1) on conflict do nothing returning day')
    expect(attempts[1].options.limits).toBe(ALERT_LIMITS)
    expect(attempts[1].options.signal).toBeInstanceOf(AbortSignal)
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(`${ADDRESS}/fail`)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].body).toMatch(/^First server error today, \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}: GET \/test\/postgres-error XX000$/)
    for (const value of [PERSONAL, 'example.com', 'BQR-1234', 'internal failure', 'secret_', 'Key (email)']) {
      expect(JSON.stringify([attempts, sent]), value).not.toContain(value)
    }
    expect(reachedForTheNetwork).toEqual([])
  })

  it('sends nothing for a 500 that is not the first of the day (the stub says the day is taken)', async () => {
    process.env.HEALTH_HEARTBEAT_URL = ADDRESS
    const sent = []
    vi.stubGlobal('fetch', async (url) => {
      sent.push(String(url))
      return { status: 200, body: null }
    })
    const { r } = await boom('/api/test/postgres-error')
    expect(r.status).toBe(500)
    expect(attempts).toHaveLength(2)
    expect(sent).toEqual([])
  })
})
