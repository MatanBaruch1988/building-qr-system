import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

// Two runs on one schema (two deployments building at once, a retried build) must not apply the same file twice.
// The wait is long enough for a normal migration to finish, short enough that a stuck one fails the build.
const LOCK_WAIT_MS = 60_000
const LOCK_RETRY_MS = 1_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The migration files of `dir` in the order they are applied: *.sql, sorted by name. The one rule for "which files". */
export function migrationFiles(dir = DEFAULT_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
}

/**
 * The files of `dir` that schema_migrations does not list yet, in order. It only reads: the table may not exist yet (a new
 * database), and then every file is pending. `db` is a pg Pool or Client on the schema that migrate() will use.
 */
export async function pendingMigrations(db, dir = DEFAULT_DIR) {
  const { rows: found } = await db.query("select to_regclass('schema_migrations') is not null as present")
  const done = found[0].present
    ? new Set((await db.query('select name from schema_migrations')).rows.map((r) => r.name))
    : new Set()
  return migrationFiles(dir).filter((file) => !done.has(file))
}

/**
 * Takes the session-level advisory lock of the current schema on `client`, retrying until `waitMs` has passed.
 * Returns the lock key. The key depends on the schema because schema_migrations is per schema (search_path): the unit
 * tests and the E2E run in different schemas of one database at the same time and must not wait for each other.
 */
async function acquireLock(client, waitMs, retryMs) {
  const { rows } = await client.query(
    "select hashtext('building-qr-system:migrate:' || coalesce(current_schema(), '')) as key",
  )
  const key = rows[0].key
  const deadline = Date.now() + waitMs
  for (;;) {
    const { rows: got } = await client.query('select pg_try_advisory_lock($1) as locked', [key])
    if (got[0].locked) return key
    if (Date.now() + retryMs > deadline) {
      throw new Error(`Another migration run holds the lock for this schema (waited ${Math.round(waitMs / 1000)} s)`)
    }
    await sleep(retryMs)
  }
}

/**
 * Applies db/migrations/*.sql in name order, each in its own transaction, once. Returns the names applied.
 * The whole run uses one connection, because an advisory lock belongs to a session (so `pool` must be a direct
 * connection, not a transaction pooler). `options` is for the tests only: how long to wait for the lock.
 */
export async function migrate(pool, dir = DEFAULT_DIR, { lockWaitMs = LOCK_WAIT_MS, lockRetryMs = LOCK_RETRY_MS } = {}) {
  const client = await pool.connect()
  let key = null
  let broken = false
  try {
    key = await acquireLock(client, lockWaitMs, lockRetryMs)
    // After the lock, never before: two runs that create the table at the same moment can fail on each other.
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    )
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name))
    const applied = []
    for (const file of migrationFiles(dir)) {
      if (done.has(file)) continue
      const sql = fs.readFileSync(path.join(dir, file), 'utf8')
      try {
        await client.query('begin')
        // The live site keeps serving while this runs. A migration that waits for a lock that live traffic holds would
        // queue every request behind it, so it fails fast instead (the build fails and the old deployment keeps serving).
        await client.query("set local lock_timeout = '5s'")
        // The app pool cuts a statement off after 15 s; a migration (an index, a backfill) may need longer than that.
        await client.query("set local statement_timeout = '5min'")
        await client.query(sql)
        await client.query('insert into schema_migrations (name) values ($1)', [file])
        await client.query('commit')
        applied.push(file)
      } catch (err) {
        // If even the rollback fails the connection is unusable: destroy it instead of recycling it.
        await client.query('rollback').catch(() => {
          broken = true
        })
        // eslint-disable-next-line preserve-caught-error -- no `cause` on purpose: a Postgres error carries `detail`, `where`, `table`, `column` and `parameters` (row values), and a logged error prints its cause
        throw new Error(`Migration ${file} failed: ${err.message}`)
      }
    }
    return applied
  } finally {
    // Always let go of the lock. If that fails, destroy the connection: it ends the session, which frees the lock, and
    // the pool must never hand a connection that still holds it to someone else.
    if (key !== null) {
      await client.query('select pg_advisory_unlock($1)', [key]).catch(() => {
        broken = true
      })
    }
    client.release(broken)
  }
}
