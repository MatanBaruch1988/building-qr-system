import pg from 'pg'
import { failureLabel } from './logSafe.js'
import { STATEMENT_TIMEOUT_MS, IDLE_IN_TRANSACTION_TIMEOUT_MS } from './config.js'

// Return DATE columns as plain 'YYYY-MM-DD' strings (the default is a Date at local midnight).
pg.types.setTypeParser(1082, (value) => value)

let pool

/**
 * The `code` of the error that `takeClient` throws when the pool could not hand out a client in time. `pg` throws a plain
 * `Error` for that, with a message and no code, so the label of a failure (failureLabel in server/logSafe.js) would be just
 * "Error". With a code of our own the log line and the record of the 500 say what happened, and server/errorLog.js knows that
 * the database cannot be reached (it attempts no insert).
 */
export const DB_CONNECT_TIMEOUT = 'db_connect_timeout'

// The message of the error of the pool (pg-pool) that waited for a client for `connectionTimeoutMillis`. It is recognised here
// to decide and nothing else: it is never logged and never kept.
const POOL_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect'

/**
 * `p.connect()`, except that the timeout of the pool (the one `pg` error that has no code) is thrown again as an error of ours:
 * a sentence of ours as its message and `code: 'db_connect_timeout'`, with no `cause` and nothing of the original, so nothing the
 * driver wrote can reach a log or a record. Any other failure is thrown as it is.
 * @param {*} p
 * @returns {Promise<import('pg').PoolClient>}
 */
async function takeClient(p) {
  try {
    return await p.connect()
  } catch (err) {
    if (err instanceof Error && err.message === POOL_CONNECT_TIMEOUT_MESSAGE) {
      throw Object.assign(new Error('The pool gave no database connection in time'), { code: DB_CONNECT_TIMEOUT })
    }
    throw err
  }
}

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
 * `lockMs` is optional and the limits of the pool have none (a statement that waits for a lock is ended by `statementMs`
 * like any other): when it is there, a statement that waits for a lock longer than that is ended with SQLSTATE 55P03.
 */
export function beginSql(limits) {
  if (!limits) return 'begin'
  const { statementMs, idleInTransactionMs, lockMs } = limits
  for (const ms of lockMs === undefined ? [statementMs, idleInTransactionMs] : [statementMs, idleInTransactionMs, lockMs]) {
    if (!Number.isInteger(ms) || ms < 1) throw new Error('A query limit must be a whole number of milliseconds, 1 or more')
  }
  const lock = lockMs === undefined ? '' : `; set local lock_timeout = ${lockMs}`
  return `begin; set local statement_timeout = ${statementMs}; set local idle_in_transaction_session_timeout = ${idleInTransactionMs}${lock}`
}

/**
 * What a caller may add to one statement of `LimitedPool.query` (the third argument), for work that must not hold a
 * connection for as long as the app's own limits allow:
 *  - `limits`: replaces fields of the pool's limits for this statement only (a transaction that is not this statement's
 *    keeps the pool's, so nothing else changes), for example `{ statementMs: 1500, lockMs: 500 }`;
 *  - `signal`: when it is aborted before the statement has started (the caller stopped waiting while the pool was handing
 *    out a connection), the connection is given back at once and the statement is not run.
 * @typedef {object} StatementOptions
 * @property {{ statementMs?: number, idleInTransactionMs?: number, lockMs?: number }} [limits]
 * @property {AbortSignal} [signal]
 */

/**
 * Runs `fn(client)` in one transaction that carries the pool's limits (or those of `options.limits` over them): commit when
 * it returns, roll back when it throws. The client always goes back to the pool: after a commit, after a failure and when
 * `options.signal` was aborted while the connection was being made.
 * @param {*} p
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 * @param {StatementOptions} [options]
 */
async function inTransaction(p, fn, { limits, signal } = {}) {
  // Built first, so that a bad limit is refused before a connection is taken. A pool without limits (a test double) opens a
  // plain transaction whatever is asked.
  const begin = beginSql(p.limits ? { ...p.limits, ...limits } : undefined)
  const client = await takeClient(p)
  if (signal?.aborted) {
    client.release()
    signal.throwIfAborted()
  }
  let broken = false
  try {
    await client.query(begin)
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
 * Only the promise form `query(text, params)` is supported, the only one the app uses, with an optional third argument
 * (StatementOptions) that only work which needs its own, shorter, limits passes. Behind a transaction pooler a single
 * statement is a transaction of its own anyway, so this changes nothing but the limits.
 */
class LimitedPool extends pg.Pool {
  constructor(config, limits) {
    beginSql(limits) // refuse a bad limit before anything is built
    super(config)
    this.limits = limits
  }

  // `options` is a StatementOptions. The parameters are not typed on purpose: a type here would have to be as wide as the
  // overloads of pg.Pool#query, which this method narrows to the one form the app uses.
  query(text, params, options) {
    return inTransaction(this, (client) => client.query(text, params), options)
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

/**
 * How many statements could start on the pool this instant without anyone waiting for a client: the clients that sit idle
 * plus the connections it may still open (its maximum less the ones it has), and 0 while anything is already waiting for a
 * client, because a statement that is asked for now would join that queue. Read-only: it takes nothing and changes nothing.
 * It is for work that may be skipped when the pool is busy (server/errorLog.js), never for deciding whether a request is
 * served. A pool that does not report these counts (a test double) is taken as free, so that the double decides what a test sees.
 * @param {{ totalCount?: number, idleCount?: number, waitingCount?: number, options?: { max?: number } }} [p]
 */
export function spareClients(p = getPool()) {
  const { totalCount, idleCount, waitingCount } = p
  const max = p.options?.max
  if (!Number.isInteger(totalCount) || !Number.isInteger(idleCount) || !Number.isInteger(waitingCount) || !Number.isInteger(max)) {
    return Infinity
  }
  if (waitingCount > 0) return 0
  return idleCount + Math.max(0, max - totalCount)
}

/**
 * @param {string} text
 * @param {unknown[]} [params]
 * @param {StatementOptions} [options]  only for work that needs shorter limits than the app's own (server/errorLog.js)
 */
export const query = (text, params, options) => getPool().query(text, params, options)

export const tx = (fn) => inTransaction(getPool(), fn)
