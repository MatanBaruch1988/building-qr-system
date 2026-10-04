// The limits that the app puts on its own database work: a statement is cut off after STATEMENT_TIMEOUT_MS, and a
// transaction that sits idle is ended after IDLE_IN_TRANSACTION_TIMEOUT_MS (server/db.js).
//
// Why the app sets them itself, for every transaction: a connection setting does not reach the database through Neon.
// Measured on the non-production project: the pooler (PgBouncer in transaction mode) refuses `-c statement_timeout` in
// `options` and silently drops the same setting as a startup parameter, and Neon's proxy drops it on the direct URL too,
// so `current_setting('statement_timeout')` was 0 whatever the pool asked for. `set local` inside the transaction is
// what works everywhere (pooled, direct, a plain Postgres), so that is what these tests prove, on a live connection.
//
// The live tests build their pool WITHOUT any startup parameter, like Neon's proxy would leave it, so that they pass
// only when the app itself sets the limits (on a plain Postgres, such as the CI container, a startup parameter alone
// would have been honoured and would hide a missing `set local`). The limits are shortened to about a second so that a
// test takes a couple of seconds.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import pg from 'pg'
import { setupDb } from './helpers.js'
import { createPool, poolConfig, beginSql, getPool, setPool, query, tx, guardPool, QUERY_LIMITS } from '../server/db.js'
import { assertNotProduction } from '../server/dbGuard.js'
import { STATEMENT_TIMEOUT_MS, IDLE_IN_TRANSACTION_TIMEOUT_MS } from '../server/config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SHORT = { statementMs: 1000, idleInTransactionMs: 2000 }
const SETTINGS =
  "select current_setting('statement_timeout') as statement_timeout, current_setting('idle_in_transaction_session_timeout') as idle_in_transaction_session_timeout"

/** How long `promise` took to settle, and how: { ms, ok, value } or { ms, ok: false, error }. */
async function timed(promise) {
  const started = Date.now()
  try {
    return { ms: Date.now() - started, ok: true, value: await promise }
  } catch (error) {
    return { ms: Date.now() - started, ok: false, error }
  }
}

describe('the configuration of the limits', () => {
  it('names the limits in server/config.js, and the pool configuration and the default limits read them', () => {
    expect(STATEMENT_TIMEOUT_MS).toBe(15_000)
    expect(IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(20_000)
    expect(QUERY_LIMITS).toEqual({ statementMs: STATEMENT_TIMEOUT_MS, idleInTransactionMs: IDLE_IN_TRANSACTION_TIMEOUT_MS })
    const config = poolConfig('postgresql://user:pass@127.0.0.1:1/none')
    // The startup parameters still go out (a plain Postgres honours them). They are not what the app relies on.
    expect(config.statement_timeout).toBe(STATEMENT_TIMEOUT_MS)
    expect(config.idle_in_transaction_session_timeout).toBe(IDLE_IN_TRANSACTION_TIMEOUT_MS)
  })

  it('opens every transaction with the limits as `set local`, in one round trip', () => {
    expect(beginSql(QUERY_LIMITS)).toBe(
      'begin; set local statement_timeout = 15000; set local idle_in_transaction_session_timeout = 20000',
    )
    expect(beginSql({ statementMs: 1000, idleInTransactionMs: 2000 })).toContain('set local statement_timeout = 1000;')
  })

  it('opens a plain transaction for a pool that has no limits (a test double)', () => {
    expect(beginSql(undefined)).toBe('begin')
  })

  it.each([
    ['zero (it would switch the limit off)', { statementMs: 0, idleInTransactionMs: 2000 }],
    ['negative', { statementMs: 1000, idleInTransactionMs: -1 }],
    ['a fraction', { statementMs: 1000.5, idleInTransactionMs: 2000 }],
    ['text that is SQL', { statementMs: '1000; drop table scans', idleInTransactionMs: 2000 }],
    ['missing', { statementMs: 1000 }],
  ])('refuses a limit that is %s, so a bad value never reaches the database', (_name, limits) => {
    expect(() => beginSql(limits)).toThrow(/whole number of milliseconds/)
    expect(() => createPool({ connectionString: 'postgresql://user:pass@127.0.0.1:1/none' }, limits)).toThrow(/whole number/)
  })

  it('builds the pool of the app with the limits (the pool opens no connection until it is asked for one)', async () => {
    const saved = { url: process.env.DATABASE_URL, schema: process.env.DB_SCHEMA }
    process.env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:1/none'
    delete process.env.DB_SCHEMA
    setPool(undefined)
    try {
      const app = getPool()
      expect(app).toBeInstanceOf(pg.Pool)
      expect(app.limits).toEqual(QUERY_LIMITS)
      expect(app.options.statement_timeout).toBe(STATEMENT_TIMEOUT_MS)
      await app.end()
    } finally {
      setPool(undefined) // the live tests below set their own
      if (saved.url === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved.url
      if (saved.schema !== undefined) process.env.DB_SCHEMA = saved.schema
    }
  })
})

describe('a client that is in use and fails', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not crash the process: the pool leaves an error event of a checked-out client without a listener', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pool = guardPool(new EventEmitter())
    const client = new EventEmitter()
    pool.emit('connect', client)
    expect(() => client.emit('error', Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03' }))).not.toThrow()
    expect(logged).toHaveBeenCalledWith('database client error: 25P03')
    expect(JSON.stringify(logged.mock.calls)).not.toContain('terminating')
  })
})

describe('the limits, on a live database', () => {
  let db // a migrated throwaway schema, and the pool that the other tests use
  let limited // the pool under test: the app's own pool class, short limits, no startup parameters

  beforeAll(async () => {
    db = await setupDb()
    const raw = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
    const { statement_timeout, idle_in_transaction_session_timeout, ...bare } = poolConfig(raw, db.schema)
    expect(statement_timeout).toBe(STATEMENT_TIMEOUT_MS) // what was taken out
    expect(idle_in_transaction_session_timeout).toBe(IDLE_IN_TRANSACTION_TIMEOUT_MS)
    limited = createPool({ ...bare, max: 4 }, SHORT)
    await assertNotProduction(limited)
    await db.pool.query('create table limit_rows (id int primary key, note text)')
    setPool(limited)
  })

  afterAll(async () => {
    setPool(db.pool)
    await limited.end()
    await db.teardown()
  })

  afterEach(() => vi.restoreAllMocks())

  it('carries the injected limits, and no startup parameter', () => {
    expect(limited.limits).toEqual(SHORT)
    expect(limited.options.statement_timeout).toBeUndefined()
    expect(limited.options.idle_in_transaction_session_timeout).toBeUndefined()
  })

  it('query() runs a statement with the limits set', async () => {
    const { rows } = await query(SETTINGS)
    expect(rows).toEqual([{ statement_timeout: '1s', idle_in_transaction_session_timeout: '2s' }])
  })

  it('tx() runs its statements with the limits set', async () => {
    const rows = await tx(async (c) => [(await c.query(SETTINGS)).rows[0], (await c.query(SETTINGS)).rows[0]])
    expect(rows).toEqual(Array(2).fill({ statement_timeout: '1s', idle_in_transaction_session_timeout: '2s' }))
  })

  it('keeps the limits inside the transaction: a connection that is used again does not carry them', async () => {
    await query('select 1')
    const client = await limited.connect()
    try {
      const { rows } = await client.query(SETTINGS)
      expect(rows[0].statement_timeout).not.toBe('1s')
      expect(rows[0].idle_in_transaction_session_timeout).not.toBe('2s')
    } finally {
      client.release()
    }
  })

  it('cuts a query() that runs longer than the limit, with SQLSTATE 57014 (query_canceled)', async () => {
    const r = await timed(query('select pg_sleep(8)'))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe('57014')
    expect(r.ms).toBeGreaterThanOrEqual(900) // it was the limit, not an early failure
    expect(r.ms).toBeLessThan(5000) // and not the 8 s of the sleep
  })

  it('cuts a statement of a tx() the same way, and rolls the transaction back', async () => {
    const r = await timed(
      tx(async (c) => {
        await c.query("insert into limit_rows (id, note) values (1, 'rolled back')")
        await c.query('select pg_sleep(8)')
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe('57014')
    expect(r.ms).toBeLessThan(5000)
    expect((await db.pool.query('select count(*)::int as n from limit_rows')).rows[0].n).toBe(0)
  })

  it('still works after a cut: the connection goes back to the pool in a usable state', async () => {
    await expect(query('select pg_sleep(8)')).rejects.toMatchObject({ code: '57014' })
    expect((await query('select 41 + 1 as answer')).rows).toEqual([{ answer: 42 }])
    expect(await tx(async (c) => (await c.query('select 1 as one')).rows[0].one)).toBe(1)
  })

  it('passes parameters, rows, rowCount and database errors through unchanged', async () => {
    expect((await query('select $1::int + $2::int as sum', [2, 3])).rows).toEqual([{ sum: 5 }])
    const inserted = await query('insert into limit_rows (id, note) values ($1, $2) returning id', [7, 'kept'])
    expect(inserted.rowCount).toBe(1)
    expect(inserted.rows).toEqual([{ id: 7 }])
    // It was committed: another connection sees it.
    expect((await db.pool.query('select note from limit_rows where id = 7')).rows).toEqual([{ note: 'kept' }])
    // A constraint error keeps its SQLSTATE and the statement is rolled back, so the next one starts clean.
    await expect(query('insert into limit_rows (id, note) values (7, $1)', ['again'])).rejects.toMatchObject({ code: '23505' })
    expect((await query('select count(*)::int as n from limit_rows where id = 7')).rows[0].n).toBe(1)
    await query('delete from limit_rows where id = 7')
  })

  it('ends a transaction that sits idle longer than the limit, and the process does not crash', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The callback waits outside the database for longer than the 2 s idle limit, then asks again.
    const r = await timed(
      tx(async (c) => {
        await c.query("insert into limit_rows (id, note) values (2, 'idle')")
        await sleep(3500)
        await c.query('select 1')
      }),
    )
    expect(r.ok).toBe(false)
    // The server ended the session (25P03), and the pool's error handler said so without the message.
    expect(logged).toHaveBeenCalledWith('database client error: 25P03')
    expect(JSON.stringify(logged.mock.calls)).not.toContain('terminating connection')
    // The dead connection was dropped, nothing of the transaction was kept, and the pool still serves.
    expect((await query('select count(*)::int as n from limit_rows where id = 2')).rows[0].n).toBe(0)
  })

  it('does not end a transaction that keeps working (the idle limit counts only the time between statements)', async () => {
    const r = await tx(async (c) => {
      for (let i = 0; i < 4; i++) {
        await sleep(700)
        await c.query('select 1')
      }
      return 'done' // 2.8 s in all: more than the idle limit, never idle for that long
    })
    expect(r).toBe('done')
  })
})
