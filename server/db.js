import pg from 'pg'
import { failureLabel } from './logSafe.js'
import { STATEMENT_TIMEOUT_MS, IDLE_IN_TRANSACTION_TIMEOUT_MS } from './config.js'

// Return DATE columns as plain 'YYYY-MM-DD' strings (the default is a Date at local midnight).
pg.types.setTypeParser(1082, (value) => value)

let pool

/**
 * How long the database lets one statement run, and a transaction sit idle, before it ends it (server/config.js).
 *
 * The app cannot ask for these as a setting of the connection, because Neon does not pass one on. Measured against the
 * non-production project: through the pooler (PgBouncer in transaction mode) a startup parameter is silently dropped and
 * `options: '-c statement_timeout=...'` is refused ("unsupported startup parameter"); on the direct URL Neon's proxy
 * drops the startup parameter too (only `options` gets through there). So `current_setting('statement_timeout')` was 0
 * whatever the pool asked for, and a query could run until the 30 s limit of the Vercel function. `set local` inside the
 * transaction works on every route (pooled, direct, a plain Postgres), so every transaction starts with it (`beginSql`),
 * and a statement that is not in a transaction of its own is run in one (`LimitedPool.query`).
 */
export const QUERY_LIMITS = Object.freeze({
  statementMs: STATEMENT_TIMEOUT_MS,
  idleInTransactionMs: IDLE_IN_TRANSACTION_TIMEOUT_MS,
})

/**
 * Neon URLs say sslmode=require, which `pg` currently treats as verify-full and warns about.
 * Spell out the behaviour we rely on (full certificate verification) to keep it stable.
 */
export function normalizeConnectionString(url) {
  return url.replace(/sslmode=(require|prefer|verify-ca)(?=&|$)/, 'sslmode=verify-full')
}

export function poolConfig(connectionString, schema, limits = QUERY_LIMITS) {
  return {
    connectionString: normalizeConnectionString(connectionString),
    max: 3,
    idleTimeoutMillis: 10_000,
    // Fail instead of queueing every request behind one hung connection, but leave room for a Neon
    // compute that is waking from sleep (a few seconds); Vercel gives the function 30 s.
    connectionTimeoutMillis: 10_000,
    // Startup parameters: a plain Postgres honours them (CI, a self-hosted database) and gives every session of this pool
    // the limits, also to code that takes a connection and never calls tx(). Neon drops them (see QUERY_LIMITS), so the
    // limits do not depend on them: every transaction sets its own.
    statement_timeout: limits.statementMs,
    idle_in_transaction_session_timeout: limits.idleInTransactionMs,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  }
}

/**
 * The statement that opens a transaction with the limits on it, in one round trip (a simple query that holds several
 * statements; the transaction stays open after it). `limits` undefined (a test double) opens a plain transaction. A limit
 * is written into the SQL, so it must be a whole number of milliseconds of 1 or more: 0 would switch the limit off.
 */
export function beginSql(limits) {
  if (!limits) return 'begin'
  const { statementMs, idleInTransactionMs } = limits
  for (const ms of [statementMs, idleInTransactionMs]) {
    if (!Number.isInteger(ms) || ms < 1) throw new Error('A query limit must be a whole number of milliseconds, 1 or more')
  }
  return `begin; set local statement_timeout = ${statementMs}; set local idle_in_transaction_session_timeout = ${idleInTransactionMs}`
}

/** Runs `fn(client)` in one transaction that carries the pool's limits: commit when it returns, roll back when it throws. */
async function inTransaction(p, fn) {
  const client = await p.connect()
  let broken = false
  try {
    await client.query(beginSql(p.limits))
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    // If even the rollback fails the connection is unusable: destroy it instead of recycling it.
    await client.query('rollback').catch(() => {
      broken = true
    })
    throw err
  } finally {
    client.release(broken)
  }
}

/**
 * A pool whose `query` runs the statement in a transaction of its own that carries the limits (begin, the statement,
 * commit: three round trips instead of one, which is milliseconds between a Vercel function and Neon in the same region).
 * Only the promise form `query(text, params)` is supported, the only one the app uses. Behind a transaction pooler a
 * single statement is a transaction of its own anyway, so this changes nothing but the limits.
 */
class LimitedPool extends pg.Pool {
  constructor(config, limits) {
    beginSql(limits) // refuse a bad limit before anything is built
    super(config)
    this.limits = limits
  }

  query(text, params) {
    return inTransaction(this, (client) => client.query(text, params))
  }
}

/** The pool of the app: a pg pool that puts `limits` on every transaction and every single statement it runs. */
export function createPool(config, limits = QUERY_LIMITS) {
  return guardPool(new LimitedPool(config, limits))
}

/**
 * A pool must never crash the function with an 'error' event nobody listens to. Two kinds exist:
 *  - an idle client that Neon dropped: the pool's own handler (below) logs it;
 *  - a client that is in use, between two of its statements, that the server ended (the idle-in-transaction limit does
 *    exactly that): `pg` emits 'error' on it and the pool has no listener on a client that is checked out. Without one,
 *    Node would throw an uncaught exception. The next statement of that client fails by itself ("not queryable"), which
 *    rolls back and destroys it, so the listener only has to log the cause.
 * The log lines hold the error's code or name and never its message (it can quote the database user or a value:
 * server/logSafe.js).
 */
export function guardPool(p) {
  p.on('error', (err) => console.error(`idle database client error: ${failureLabel(err)}`))
  p.on('connect', (client) => client.on('error', (err) => console.error(`database client error: ${failureLabel(err)}`)))
  return p
}

export function getPool() {
  if (!pool) {
    // DB_SCHEMA (local development only) points the app at a scratch schema so manual testing
    // never touches real data. It needs the direct URL: the pooled one cannot set search_path.
    const schema = process.env.DB_SCHEMA
    if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA must be lower-case letters, digits or _')
    const connectionString = schema
      ? process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
      : process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    pool = createPool(poolConfig(connectionString, schema))
  }
  return pool
}

/** Tests inject a pool bound to a throwaway schema. */
export function setPool(custom) {
  pool = custom
}

export const query = (text, params) => getPool().query(text, params)

export const tx = (fn) => inTransaction(getPool(), fn)
