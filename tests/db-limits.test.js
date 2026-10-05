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
import { createPool, poolConfig, beginSql, getPool, setPool, query, tx, guardPool, spareClients, QUERY_LIMITS } from '../server/db.js'
import { assertNotProduction } from '../server/dbGuard.js'
import { STATEMENT_TIMEOUT_MS, IDLE_IN_TRANSACTION_TIMEOUT_MS } from '../server/config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SHORT = { statementMs: 1000, idleInTransactionMs: 2000 }
const SETTINGS =
  "select current_setting('statement_timeout') as statement_timeout, current_setting('idle_in_transaction_session_timeout') as idle_in_transaction_session_timeout"
// The same with the lock limit, for the tests of a statement that carries limits of its own.
const SETTINGS_WITH_LOCK = `${SETTINGS}, current_setting('lock_timeout') as lock_timeout`

/** How long `promise` took to settle, and how: { ms, ok, value } or { ms, ok: false, error }. */
async function timed(promise) {
  const started = Date.now()
  try {
    const value = await promise
    return { ms: Date.now() - started, ok: true, value }
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

  it('adds a lock limit only when one is asked for, and the default limits of the app have none', () => {
    expect(beginSql({ statementMs: 1500, idleInTransactionMs: 1500, lockMs: 500 })).toBe(
      'begin; set local statement_timeout = 1500; set local idle_in_transaction_session_timeout = 1500; set local lock_timeout = 500',
    )
    expect(QUERY_LIMITS.lockMs).toBeUndefined()
    expect(beginSql(QUERY_LIMITS)).not.toContain('lock_timeout')
    expect(beginSql({ ...QUERY_LIMITS, lockMs: undefined })).toBe(beginSql(QUERY_LIMITS))
  })

  it.each([
    ['zero (it would switch the limit off)', 0],
    ['negative', -1],
    ['a fraction', 0.5],
    ['text that is SQL', '500; drop table scans'],
    ['null', null],
    ['not a number', NaN],
  ])('refuses a lock limit that is %s, so a bad value never reaches the database', (_name, lockMs) => {
    const limits = { statementMs: 1500, idleInTransactionMs: 1500, lockMs }
    expect(() => beginSql(limits)).toThrow(/whole number of milliseconds/)
    expect(() => createPool({ connectionString: 'postgresql://user:pass@127.0.0.1:1/none' }, limits)).toThrow(/whole number/)
  })

  describe('spareClients, what a pool could hand out this instant', () => {
    const pool = (totalCount, idleCount, waitingCount, max = 3) => ({ totalCount, idleCount, waitingCount, options: { max } })

    it('is the idle clients plus the connections the pool may still open', () => {
      expect(spareClients(pool(0, 0, 0))).toBe(3) // nothing open yet
      expect(spareClients(pool(1, 1, 0))).toBe(3) // one idle, two more may be opened
      expect(spareClients(pool(2, 1, 0))).toBe(2)
      expect(spareClients(pool(3, 1, 0))).toBe(1) // the last idle one
      expect(spareClients(pool(3, 0, 0))).toBe(0) // at the maximum, all in use
      expect(spareClients(pool(5, 0, 0, 3))).toBe(0) // never below zero
    })

    it('is 0 while anything is waiting for a client, whatever is idle: a new statement would join the queue', () => {
      expect(spareClients(pool(3, 0, 1))).toBe(0)
      expect(spareClients(pool(1, 1, 2))).toBe(0)
    })

    it('treats a pool that reports no counts (a test double) as free, and reads and changes nothing on a real one', () => {
      expect(spareClients({ query: () => {} })).toBe(Infinity)
      expect(spareClients({ totalCount: 'many', idleCount: 0, waitingCount: 0, options: { max: 3 } })).toBe(Infinity)
      expect(spareClients({ totalCount: 0, idleCount: 0, waitingCount: 0 })).toBe(Infinity) // no maximum known
      const real = createPool({ connectionString: 'postgresql://user:pass@127.0.0.1:1/none', max: 3 })
      expect(spareClients(real)).toBe(3)
      expect([real.totalCount, real.idleCount, real.waitingCount]).toEqual([0, 0, 0]) // it opened nothing
      return real.end()
    })
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

  // The checked-out clients of a pool: all that it has, less the idle ones.
  const checkedOut = (pool) => pool.totalCount - pool.idleCount

  describe('a statement with limits of its own (the third argument of query)', () => {
    const own = { statementMs: 400, lockMs: 300 }

    it('runs with them, and keeps the pool limits for the fields it does not name', async () => {
      const { rows } = await query(SETTINGS_WITH_LOCK, undefined, { limits: own })
      expect(rows).toEqual([{ statement_timeout: '400ms', idle_in_transaction_session_timeout: '2s', lock_timeout: '300ms' }])
    })

    it('changes nothing for the next statement, for tx() or for the pool: the limits end with the transaction of the statement', async () => {
      await query('select 1', undefined, { limits: own })
      const defaults = { statement_timeout: '1s', idle_in_transaction_session_timeout: '2s', lock_timeout: '0' }
      expect((await query(SETTINGS_WITH_LOCK)).rows).toEqual([defaults])
      expect((await tx(async (c) => (await c.query(SETTINGS_WITH_LOCK)).rows[0]))).toEqual(defaults)
      expect(limited.limits).toEqual(SHORT)
      // And the connection that carried them is clean for whoever takes it next.
      const client = await limited.connect()
      try {
        const { rows } = await client.query(SETTINGS_WITH_LOCK)
        expect(rows[0].statement_timeout).not.toBe('400ms')
        expect(rows[0].lock_timeout).toBe('0')
      } finally {
        client.release()
      }
    })

    it('cuts a statement at its own limit, which is shorter than that of the pool', async () => {
      // Compared with the same statement under the limit of the pool (1 s), so that the round trips and the connection time,
      // which a slow network makes long, cancel out: the two differ by the 0.6 s between the limits.
      const own400 = await timed(query('select pg_sleep(8)', undefined, { limits: own }))
      expect(own400.ok).toBe(false)
      expect(own400.error.code).toBe('57014')
      expect(own400.ms).toBeGreaterThanOrEqual(350)
      expect(own400.ms).toBeLessThan(5000) // nowhere near the 8 s of the sleep
      const pool1000 = await timed(query('select pg_sleep(8)'))
      expect(pool1000.error.code).toBe('57014')
      expect(own400.ms + 300).toBeLessThan(pool1000.ms)
      expect(checkedOut(limited)).toBe(0) // the connection is back
    })

    it('gives up on a row that another transaction holds, at the lock limit (SQLSTATE 55P03), and leaves the row alone', async () => {
      await db.pool.query("insert into limit_rows (id, note) values (11, 'locked') on conflict (id) do nothing")
      const holder = await db.pool.connect()
      try {
        await holder.query('begin')
        await holder.query('select 1 from limit_rows where id = 11 for update')
        const r = await timed(query("update limit_rows set note = 'changed' where id = 11", undefined, { limits: own }))
        expect(r.ok).toBe(false)
        expect(r.error.code).toBe('55P03')
        expect(r.ms).toBeGreaterThanOrEqual(250)
        // The pool's own limits have no lock limit: the same wait there lasts until the statement limit ends it (SQLSTATE 57014),
        // which is 0.7 s later than the lock limit above.
        const plain = await timed(query("update limit_rows set note = 'changed' where id = 11"))
        expect(plain.error.code).toBe('57014')
        expect(plain.ms).toBeGreaterThanOrEqual(900)
        expect(r.ms + 300).toBeLessThan(plain.ms)
      } finally {
        await holder.query('rollback')
        holder.release()
      }
      expect((await db.pool.query('select note from limit_rows where id = 11')).rows).toEqual([{ note: 'locked' }])
      await db.pool.query('delete from limit_rows where id = 11')
      expect(checkedOut(limited)).toBe(0)
    })

    it('refuses a bad limit before it takes a connection', async () => {
      const connect = vi.spyOn(limited, 'connect')
      for (const limits of [{ statementMs: 0 }, { lockMs: -5 }, { idleInTransactionMs: 1.5 }, { statementMs: '1; drop table limit_rows' }]) {
        await expect(query('select 1', undefined, { limits }), JSON.stringify(limits)).rejects.toThrow(/whole number of milliseconds/)
      }
      expect(connect).not.toHaveBeenCalled()
    })

    it('does not run the statement when the caller stopped waiting before it started, and gives the connection back', async () => {
      // All the clients of the pool are held, so the statement has to wait for one.
      const held = []
      while (held.length < limited.options.max) held.push(await limited.connect())
      const stop = new AbortController()
      const waiting = query("insert into limit_rows (id, note) values (20, 'late')", undefined, { signal: stop.signal })
      const outcome = timed(waiting)
      await sleep(50)
      expect(limited.waitingCount).toBe(1)
      stop.abort()
      for (const client of held) client.release() // the connection that it was waiting for arrives
      const r = await outcome
      expect(r.ok).toBe(false)
      expect(r.error.name).toBe('AbortError')
      expect((await db.pool.query('select count(*)::int as n from limit_rows where id = 20')).rows[0].n).toBe(0)
      expect(limited.waitingCount).toBe(0)
      expect(checkedOut(limited)).toBe(0)
      // A signal that is already aborted does the same without waiting, and a signal that is not aborted changes nothing.
      const early = await timed(query('select 1', undefined, { signal: AbortSignal.abort() }))
      expect(early.error.name).toBe('AbortError')
      expect(checkedOut(limited)).toBe(0)
      expect((await query('select 7 as seven', undefined, { signal: new AbortController().signal })).rows).toEqual([{ seven: 7 }])
    })

    it('what spareClients says follows the clients that are held and the statements that wait', async () => {
      const held = []
      try {
        expect(spareClients(limited)).toBe(limited.options.max)
        held.push(await limited.connect())
        expect(spareClients(limited)).toBe(limited.options.max - 1)
        while (held.length < limited.options.max) held.push(await limited.connect())
        expect(spareClients(limited)).toBe(0)
        const waiting = limited.connect() // a statement that waits for a client
        await sleep(50)
        expect(limited.waitingCount).toBe(1)
        expect(spareClients(limited)).toBe(0)
        held.pop().release()
        held.push(await waiting) // it gets the client that was released
      } finally {
        for (const client of held) client.release()
      }
      expect(spareClients(limited)).toBe(limited.options.max)
    })
  })
})
