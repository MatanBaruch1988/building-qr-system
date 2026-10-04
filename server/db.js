import pg from 'pg'
import { failureLabel } from './logSafe.js'

// Return DATE columns as plain 'YYYY-MM-DD' strings (the default is a Date at local midnight).
pg.types.setTypeParser(1082, (value) => value)

let pool

/**
 * Neon URLs say sslmode=require, which `pg` currently treats as verify-full and warns about.
 * Spell out the behaviour we rely on (full certificate verification) to keep it stable.
 */
export function normalizeConnectionString(url) {
  return url.replace(/sslmode=(require|prefer|verify-ca)(?=&|$)/, 'sslmode=verify-full')
}

export function poolConfig(connectionString, schema) {
  return {
    connectionString: normalizeConnectionString(connectionString),
    max: 3,
    idleTimeoutMillis: 10_000,
    // Fail instead of queueing every request behind one hung connection, but leave room for a Neon
    // compute that is waking from sleep (a few seconds); Vercel gives the function 30 s.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 20_000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  }
}

/**
 * Idle connections get dropped by Neon: without this handler the 'error' event would crash the function. The log line
 * holds the error's code or name and never its message (it can quote the database user or a value: server/logSafe.js).
 */
export function guardPool(p) {
  p.on('error', (err) => console.error(`idle database client error: ${failureLabel(err)}`))
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
    pool = guardPool(new pg.Pool(poolConfig(connectionString, schema)))
  }
  return pool
}

/** Tests inject a pool bound to a throwaway schema. */
export function setPool(custom) {
  pool = custom
}

export const query = (text, params) => getPool().query(text, params)

export async function tx(fn) {
  const client = await getPool().connect()
  let broken = false
  try {
    await client.query('begin')
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
