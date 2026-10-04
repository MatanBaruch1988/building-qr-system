// What the server may write to the log about a failure it handled itself (server/logSafe.js): the error's code or name, never
// its message. The runtime logs are kept by the host and read by more people than the committee, and the message of a
// library or database error can quote a value (an e-mail, a name, a database user).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import pg from 'pg'
import { failureLabel } from '../server/logSafe.js'
import { guardPool, poolConfig } from '../server/db.js'

const PERSONAL = 'someone@example.com'

afterEach(() => vi.restoreAllMocks())

describe('failureLabel', () => {
  it('says the code of an error, and never its message', () => {
    const err = Object.assign(new Error(`invalid input syntax for type uuid: "${PERSONAL}"`), { code: '22P02' })
    expect(failureLabel(err)).toBe('22P02')
  })

  it('says a numeric code', () => {
    expect(failureLabel(Object.assign(new Error(PERSONAL), { code: 57014 }))).toBe('57014')
  })

  it('says the name of an error that has no code', () => {
    expect(failureLabel(new TypeError(`Cannot read ${PERSONAL}`))).toBe('TypeError')
    expect(failureLabel(Object.assign(new Error(PERSONAL), { name: 'error' }))).toBe('error')
  })

  it('falls back from an empty or unusable code to the name, and from an empty name to Error', () => {
    expect(failureLabel(Object.assign(new TypeError(PERSONAL), { code: '' }))).toBe('TypeError')
    expect(failureLabel(Object.assign(new TypeError(PERSONAL), { code: { detail: PERSONAL } }))).toBe('TypeError')
    expect(failureLabel(Object.assign(new Error(PERSONAL), { name: '' }))).toBe('Error')
  })

  it('never says anything but the code, whatever else the error carries', () => {
    const err = Object.assign(new Error(PERSONAL), {
      code: 'XX000',
      detail: `Key (email)=(${PERSONAL}) already exists.`,
      where: PERSONAL,
      table: PERSONAL,
      column: PERSONAL,
      parameters: [PERSONAL],
    })
    expect(failureLabel(err)).toBe('XX000')
  })

  it('puts a long or multi-line code on one short line', () => {
    const label = failureLabel(Object.assign(new Error('x'), { code: `first\n2026-01-01 FORGED log line ${'y'.repeat(200)}` }))
    expect(label).not.toMatch(/[\r\n]/)
    expect(label.length).toBeLessThanOrEqual(40)
  })

  it('says only the type of anything that is not an Error (its content is not known to be safe)', () => {
    expect(failureLabel(PERSONAL)).toBe('thrown string')
    expect(failureLabel({ code: PERSONAL, name: PERSONAL, message: PERSONAL })).toBe('thrown object')
    expect(failureLabel(null)).toBe('thrown object')
    expect(failureLabel(undefined)).toBe('thrown undefined')
  })
})

describe('guardPool: the handler of an idle database client that failed', () => {
  it('logs the code in one string, and never the message or any other field', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A real pool of the app's own configuration. It opens no connection until it is asked for one.
    const pool = guardPool(new pg.Pool(poolConfig('postgresql://user:pass@127.0.0.1:1/none')))
    const err = Object.assign(new Error(`password authentication failed for user "${PERSONAL}"`), {
      code: '28P01',
      detail: `Key (email)=(${PERSONAL}) already exists.`,
      parameters: [PERSONAL],
    })
    pool.emit('error', err)
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('idle database client error: 28P01')
    expect(JSON.stringify(logged.mock.calls)).not.toContain(PERSONAL)
    expect(JSON.stringify(logged.mock.calls)).not.toContain('password authentication')
    await pool.end()
  })

  it('logs the name of an error that has no code', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pool = guardPool(new EventEmitter())
    pool.emit('error', new Error(`Connection terminated unexpectedly (${PERSONAL})`))
    expect(logged).toHaveBeenCalledWith('idle database client error: Error')
  })

  it('keeps the process alive: an error event with the handler does not throw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pool = guardPool(new EventEmitter())
    expect(() => pool.emit('error', new Error('dropped'))).not.toThrow()
  })
})
