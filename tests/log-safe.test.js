// What the server may write to the log about a failure it handled itself (server/logSafe.js): the error's code or name, never
// its message. The runtime logs are kept by the host and read by more people than the committee, and the message of a
// library or database error can quote a value (an e-mail, a name, a database user).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import pg from 'pg'
import { failureLabel, sqlstateName, SafeMessageError } from '../server/logSafe.js'
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

describe('sqlstateName', () => {
  // The names are those of appendix A of the PostgreSQL documentation. The table is pinned here on purpose: a wrong name in
  // a deploy log would send the person who reads it the wrong way.
  const KNOWN = {
    '0A000': 'feature_not_supported',
    '22P02': 'invalid_text_representation',
    23502: 'not_null_violation',
    23503: 'foreign_key_violation',
    23505: 'unique_violation',
    23514: 'check_violation',
    '25P02': 'in_failed_sql_transaction',
    '40P01': 'deadlock_detected',
    42601: 'syntax_error',
    42701: 'duplicate_column',
    42703: 'undefined_column',
    42704: 'undefined_object',
    42710: 'duplicate_object',
    42883: 'undefined_function',
    '42P01': 'undefined_table',
    '42P07': 'duplicate_table',
    '55P03': 'lock_not_available',
    57014: 'query_canceled',
  }

  it('says the condition name of every code that a migration plausibly hits', () => {
    for (const [code, name] of Object.entries(KNOWN)) expect(sqlstateName(code), code).toBe(name)
  })

  it('knows exactly these codes: no other code gets a name', () => {
    const names = new Set(Object.values(KNOWN))
    expect(names.size).toBe(Object.keys(KNOWN).length)
    for (const code of ['00000', '23000', '42000', '42P02', '58P01', 'XX000', 'P0001']) expect(sqlstateName(code), code).toBeNull()
  })

  it('says null for a code that is not a string, not exact, or not a code at all', () => {
    expect(sqlstateName(undefined)).toBeNull()
    expect(sqlstateName(null)).toBeNull()
    expect(sqlstateName(23505)).toBeNull()
    expect(sqlstateName('')).toBeNull()
    expect(sqlstateName('42p01')).toBeNull()
    expect(sqlstateName(' 42P01')).toBeNull()
    expect(sqlstateName('42P01 ')).toBeNull()
    expect(sqlstateName(['42P01'])).toBeNull()
    expect(sqlstateName({ toString: () => '42P01' })).toBeNull()
  })

  it('does not take a property of Object for a code', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) expect(sqlstateName(key), key).toBeNull()
  })
})

describe('SafeMessageError', () => {
  it('is an Error that keeps the message it was given', () => {
    const err = new SafeMessageError('Migration 012_x.sql differs from the file on GitHub master')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(SafeMessageError)
    expect(err.message).toBe('Migration 012_x.sql differs from the file on GitHub master')
  })

  it('is not what an ordinary Error is: that stays an error whose message is not printed', () => {
    expect(new Error('x')).not.toBeInstanceOf(SafeMessageError)
    expect(failureLabel(new Error(PERSONAL))).toBe('Error')
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
