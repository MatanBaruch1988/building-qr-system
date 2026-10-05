// migrate(): the lock that lets only one run per schema work at a time, and the timeouts that protect the live site.
// Every test works in a throwaway schema (setupDb) with tiny migration files of its own in a temporary folder.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { setupDb } from './helpers.js'
import { migrate, MigrationError } from '../server/migrate.js'
import { SafeMessageError } from '../server/logSafe.js'

// A value that looks personal, to see that a failed migration never prints it. Fake data only.
const PERSONAL = 'someone@example.com'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dirs = []

/** A temporary folder with the given migration files ({ name: sql }). */
function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'))
  dirs.push(dir)
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql)
  return dir
}

/** Waits until a statement that contains `token` is running on the database: then the migration of that file holds the lock. */
async function waitUntilRunning(pool, token) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(
      "select 1 from pg_stat_activity where state = 'active' and pid <> pg_backend_pid() and query like $1",
      [`%${token}%`],
    )
    if (rows.length) return
    await sleep(100)
  }
  throw new Error(`the statement with ${token} never started`)
}

let db
let other
const mine = async (pool = db.pool) =>
  (await pool.query("select name from schema_migrations where name like 'm\\_%' order by name")).rows.map((r) => r.name)

beforeAll(async () => {
  db = await setupDb()
  other = await setupDb()
})
afterAll(async () => {
  await db?.teardown()
  await other?.teardown()
})
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the migration lock', () => {
  it('lets two concurrent runs on one schema apply each file exactly once, and both succeed', async () => {
    // The first file holds the lock for a moment, so the second run really has to wait for it.
    const dir = folder({
      'm_001_first.sql': 'create table m_first (id int primary key); select pg_sleep(1.5);',
      'm_002_second.sql': 'create table m_second (id int primary key);',
    })
    const [a, b] = await Promise.all([migrate(db.pool, dir), migrate(db.pool, dir)])
    expect([...a, ...b].sort()).toEqual(['m_001_first.sql', 'm_002_second.sql'])
    expect([a.length, b.length].sort()).toEqual([0, 2])
    expect(await mine()).toEqual(['m_001_first.sql', 'm_002_second.sql'])
  })

  it('gives up with a clear error when another run keeps the lock, and the lock is free afterwards', async () => {
    const slow = folder({ 'm_010_slow.sql': "create table m_slow (id int); select 'token_hold_1', pg_sleep(3);" })
    const later = folder({ 'm_011_later.sql': 'create table m_later (id int);' })
    const holder = migrate(db.pool, slow)
    await waitUntilRunning(db.pool, 'token_hold_1')
    await expect(migrate(db.pool, later, { lockWaitMs: 1200, lockRetryMs: 300 })).rejects.toThrow(
      /another migration run holds the lock/i,
    )
    expect(await holder).toEqual(['m_010_slow.sql'])
    // It is free now (a leaked lock would make this wait and fail), and the file that was refused was not applied.
    expect(await mine()).not.toContain('m_011_later.sql')
    await expect(migrate(db.pool, later, { lockWaitMs: 3000 })).resolves.toEqual(['m_011_later.sql'])
  })

  it('does not make a run in another schema wait: the key depends on the schema', async () => {
    const slow = folder({ 'm_020_slow.sql': "select 'token_hold_2', pg_sleep(3);" })
    const quick = folder({ 'm_021_quick.sql': 'create table m_quick (id int);' })
    const holder = migrate(db.pool, slow)
    await waitUntilRunning(db.pool, 'token_hold_2')
    await expect(migrate(other.pool, quick, { lockWaitMs: 500 })).resolves.toEqual(['m_021_quick.sql'])
    await holder
    expect(await mine(other.pool)).toEqual(['m_021_quick.sql'])
  })
})

describe('the timeouts of a migration', () => {
  it('runs each migration with a 5 s lock timeout and a 5 min statement timeout', async () => {
    const dir = folder({
      'm_030_settings.sql':
        "create table m_settings as select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout;",
    })
    const setting = async () =>
      (await db.pool.query("select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt")).rows[0]
    const before = await setting()
    await migrate(db.pool, dir)
    const { rows } = await db.pool.query('select lock_timeout, statement_timeout from m_settings')
    expect(rows).toEqual([{ lock_timeout: '5s', statement_timeout: '5min' }])
    // The settings are local to the migration's transaction: the connection goes back to the pool as it was.
    expect(await setting()).toEqual(before)
  })

  it('fails fast when a migration has to wait for a lock that someone else holds, and frees its own lock', async () => {
    const first = folder({ 'm_040_table.sql': 'create table m_locked (id int);' })
    await migrate(db.pool, first)
    const dir = folder({
      'm_040_table.sql': 'create table m_locked (id int);',
      'm_041_alter.sql': 'alter table m_locked add column extra int;',
    })

    // What live traffic does: a transaction that holds the table.
    const traffic = await db.pool.connect()
    try {
      await traffic.query('begin')
      await traffic.query('lock table m_locked in access exclusive mode')

      const started = Date.now()
      const err = await migrate(db.pool, dir).catch((e) => e)
      const took = Date.now() - started
      // The message says the file and the SQLSTATE with its name; the database's text is apart, and not in the message.
      expect(err).toBeInstanceOf(MigrationError)
      expect(err.message).toBe('Migration m_041_alter.sql failed: 55P03 (lock_not_available)')
      expect(err.file).toBe('m_041_alter.sql')
      expect(err.code).toBe('55P03')
      expect(err.databaseMessage).toMatch(/lock timeout/)
      expect(err.message).not.toContain(err.databaseMessage)
      expect(took).toBeGreaterThan(4000) // it did wait for the 5 s lock timeout...
      expect(took).toBeLessThan(10_000) // ...and not for the lock to be released
    } finally {
      await traffic.query('rollback').catch(() => {})
      traffic.release()
    }

    // Nothing was recorded for the failed file, and a later run applies it (so the migration lock was released).
    expect(await mine()).not.toContain('m_041_alter.sql')
    await expect(migrate(db.pool, dir, { lockWaitMs: 3000 })).resolves.toEqual(['m_041_alter.sql'])
    const column = await db.pool.query(
      "select 1 from information_schema.columns where table_schema = $1 and table_name = 'm_locked' and column_name = 'extra'",
      [db.schema],
    )
    expect(column.rowCount).toBe(1)
  })
})

describe('a failing migration', () => {
  it('reports the file and the reason, rolls the file back, and keeps what ran before it', async () => {
    const dir = folder({
      'm_050_ok.sql': 'create table m_ok (id int);',
      'm_051_broken.sql': 'create table m_half (id int); select * from m_does_not_exist;',
      'm_052_after.sql': 'create table m_after (id int);',
    })
    const err = await migrate(db.pool, dir).catch((e) => e)
    expect(err).toBeInstanceOf(MigrationError)
    expect(err.message).toBe('Migration m_051_broken.sql failed: 42P01 (undefined_table)')
    expect(err.file).toBe('m_051_broken.sql')
    expect(err.code).toBe('42P01')
    expect(err.databaseMessage).toMatch(/m_does_not_exist/)
    expect(err.message).not.toContain('m_does_not_exist')
    expect(err.message).not.toContain(err.databaseMessage)
    // Where in the file the database stopped: the table name in `select * from m_does_not_exist`.
    expect(err.position).toBe(
      'create table m_half (id int); select * from m_does_not_exist;'.indexOf('m_does_not_exist') + 1,
    )
    expect(await mine()).toContain('m_050_ok.sql')
    expect(await mine()).not.toContain('m_051_broken.sql')
    expect(await mine()).not.toContain('m_052_after.sql')
    const tables = await db.pool.query(
      "select to_regclass($1) is not null as half, to_regclass($2) is not null as after",
      [`${db.schema}.m_half`, `${db.schema}.m_after`],
    )
    expect(tables.rows[0]).toEqual({ half: false, after: false })
  })
})

describe('MigrationError never carries the text of the database', () => {
  /** A pg-like error: the message and the fields a Postgres error has, with a personal-looking value in each. */
  const databaseError = (extra = {}) =>
    Object.assign(new Error(`invalid input syntax for type integer: "${PERSONAL}"`), {
      code: '22P02',
      position: '15',
      detail: `Key (email)=(${PERSONAL}) already exists.`,
      where: `SQL statement "select '${PERSONAL}'::int"`,
      table: PERSONAL,
      column: PERSONAL,
      parameters: [PERSONAL],
      ...extra,
    })

  it('says the file, the SQLSTATE and its name, and keeps the rest apart', () => {
    const err = new MigrationError('012_x.sql', databaseError())
    expect(err.message).toBe('Migration 012_x.sql failed: 22P02 (invalid_text_representation)')
    expect(err.name).toBe('MigrationError')
    expect(err.file).toBe('012_x.sql')
    expect(err.code).toBe('22P02')
    expect(err.position).toBe(15)
    expect(err.databaseMessage).toContain(PERSONAL)
    expect(err.message).not.toContain(PERSONAL)
    expect(err).toBeInstanceOf(SafeMessageError)
  })

  it('does not set a cause, and no printable form of it holds the value', () => {
    const err = new MigrationError('012_x.sql', databaseError())
    expect(err.cause).toBeUndefined()
    expect('cause' in err).toBe(false)
    expect(Object.keys(err).sort()).toEqual(['code', 'file', 'name', 'position'])
    // What a raw console.error(err), a JSON log line, a spread or a template string would print.
    for (const printed of [inspect(err), JSON.stringify(err), JSON.stringify({ ...err }), String(err), `${err}`, err.stack]) {
      expect(printed).not.toContain(PERSONAL)
      expect(printed).not.toContain('invalid input syntax')
    }
  })

  it('leaves the condition name out for a code it does not know, and says the name of an error that has no code', () => {
    expect(new MigrationError('012_x.sql', databaseError({ code: 'XX000' })).message).toBe('Migration 012_x.sql failed: XX000')
    expect(new MigrationError('012_x.sql', new Error(`Connection terminated (${PERSONAL})`)).message).toBe(
      'Migration 012_x.sql failed: Error',
    )
    expect(new MigrationError('012_x.sql', Object.assign(new Error(PERSONAL), { code: 'ECONNRESET' })).message).toBe(
      'Migration 012_x.sql failed: ECONNRESET',
    )
  })

  it('has a position only when the database gave a usable one, and no message for something that is not an Error', () => {
    expect(new MigrationError('012_x.sql', databaseError({ position: undefined })).position).toBeUndefined()
    expect(new MigrationError('012_x.sql', databaseError({ position: 'not a number' })).position).toBeUndefined()
    expect(new MigrationError('012_x.sql', databaseError({ position: '0' })).position).toBeUndefined()
    expect(new MigrationError('012_x.sql', databaseError({ position: Symbol('position') })).position).toBeUndefined()
    expect(new MigrationError('012_x.sql', databaseError({ position: 7 })).position).toBe(7)
    const odd = new MigrationError('012_x.sql', PERSONAL)
    expect(odd.message).toBe('Migration 012_x.sql failed: thrown string')
    expect(odd.databaseMessage).toBe('')
    expect(odd.position).toBeUndefined()
  })

  it('holds for a real failure on the database: a value that does not cast', async () => {
    const dir = folder({ 'm_060_cast.sql': `create table m_cast (n int); insert into m_cast values ('${PERSONAL}'::int);` })
    const err = await migrate(db.pool, dir).catch((e) => e)
    expect(err).toBeInstanceOf(MigrationError)
    expect(err.message).toBe('Migration m_060_cast.sql failed: 22P02 (invalid_text_representation)')
    // The database really did quote the value, and only databaseMessage has it.
    expect(err.databaseMessage).toContain(PERSONAL)
    for (const printed of [err.message, inspect(err), JSON.stringify(err), err.stack]) expect(printed).not.toContain(PERSONAL)
  })

  it('keeps the lock error as it was, and it too is an error that may be printed as it is', async () => {
    const slow = folder({ 'm_061_slow.sql': "create table m_slow2 (id int); select 'token_hold_3', pg_sleep(2);" })
    const later = folder({ 'm_062_later.sql': 'create table m_later2 (id int);' })
    const holder = migrate(db.pool, slow)
    await waitUntilRunning(db.pool, 'token_hold_3')
    const err = await migrate(db.pool, later, { lockWaitMs: 1000, lockRetryMs: 300 }).catch((e) => e)
    await holder
    expect(err).toBeInstanceOf(SafeMessageError)
    expect(err).not.toBeInstanceOf(MigrationError)
    expect(err.message).toBe('Another migration run holds the lock for this schema (waited 1 s)')
  })
})
