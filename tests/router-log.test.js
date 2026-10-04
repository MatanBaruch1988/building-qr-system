// What the router writes to the log when no route handled an error. The runtime logs are kept by the host and read by more
// people than the committee, so the line may hold only fields that cannot carry personal data (see describeUnhandled in
// server/router.js). A Postgres error object carries the values of the failing row in `detail`: it must never be logged.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { call } from './helpers.js'
import { route } from '../server/router.js'

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

  it('is logged as one line with the route, the error name, the code and the message, and nothing from the row', async () => {
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
    expect(line).toContain('message="internal failure while writing a row"')
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
    expect(line.split('Cannot read properties of undefined')).toHaveLength(2) // the message appears once
  })

  it('leaves the query string out of the path (it can hold a QR code or a name)', async () => {
    const { calls } = await boom(`/api/test/postgres-error?code=BQR-1234&name=${PERSONAL}#frag`)
    const line = calls[0][0]
    expect(line).toContain('GET /api/test/postgres-error ')
    expect(line).not.toMatch(/BQR-1234|someone|[?#]frag|name=/)
  })

  it('cannot be made to forge a second log line, or to fill the log', async () => {
    const forged = (await boom('/api/test/multi-line')).calls[0][0]
    expect(forged).not.toMatch(/[\r\n]/)
    expect(forged).toContain('message="first line 2026-01-01 00:00:00 FORGED log line third"')
    const long = (await boom('/api/test/long-message')).calls[0][0]
    expect(long.length).toBeLessThan(3000)
    expect(long).toContain('x'.repeat(300))
    expect(long).not.toContain('x'.repeat(301))
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
