// What the router writes to the log when no route handled an error. The runtime logs are kept by the host and read by more
// people than the committee, so the line may hold only fields that cannot carry personal data (see describeUnhandled in
// server/router.js). A Postgres error object carries the values of the failing row in `detail`: it must never be logged.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { call } from './helpers.js'
import { route } from '../server/router.js'

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

afterEach(() => vi.restoreAllMocks())

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
