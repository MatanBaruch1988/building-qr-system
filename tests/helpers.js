import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { loadEnv } from '../server/loadEnv.js'
import { migrate } from '../server/migrate.js'
import { setPool, poolConfig, guardPool, createPool } from '../server/db.js'
import { assertNotProduction } from '../server/dbGuard.js'
import { setGoogleVerifier } from '../server/google.js'

loadEnv()

/** Creates a throwaway schema on the real database, migrates it, and points the server at it. */
export async function setupDb() {
  // The pooled URL (pgbouncer) does not support per-connection search_path, so use the direct one.
  const raw = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL(_UNPOOLED) is not set (see .env.local)')
  const schema = 't_' + randomBytes(6).toString('hex')
  const control = guardPool(new pg.Pool(poolConfig(raw)))
  // Never create anything on a database that is marked as production (see server/dbGuard.js).
  try {
    await assertNotProduction(control)
  } catch (err) {
    await control.end()
    throw err
  }
  await control.query(`create schema ${schema}`)
  // The app's own kind of pool (server/db.js), so that every test also runs through the query limits of every statement.
  const pool = createPool({ ...poolConfig(raw, schema), max: 6 })
  setPool(pool)
  await migrate(pool)
  // Tests sign in "with Google" by presenting the e-mail as the credential.
  setGoogleVerifier(async (credential) => ({ email: String(credential).toLowerCase(), name: 'Test Admin', sub: 'sub-' + String(credential).toLowerCase() }))
  return {
    pool,
    schema,
    async teardown() {
      setGoogleVerifier(null)
      await pool.end()
      await control.query(`drop schema ${schema} cascade`)
      await control.end()
    },
  }
}

function mockRes() {
  const headers = {}
  let resolveDone
  const done = new Promise((r) => (resolveDone = r))
  return {
    statusCode: 200,
    setHeader: (k, v) => (headers[k.toLowerCase()] = v),
    getHeader: (k) => headers[k.toLowerCase()],
    end(body) {
      this.body = body
      resolveDone()
    },
    headers,
    done,
  }
}

const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`

/**
 * Calls the API handler directly (no network). Each call comes from a fresh address unless `ip` is given.
 * `onBodyRead` is called each time something reads `req.body` (the router does, once, when it builds the context of a
 * handler), so a test can tell whether a request got that far.
 */
export async function call(method, path, { body, token, cookie, headers = {}, ip = randomIp(), badJsonBody = false, onBodyRead } = {}) {
  const { handle } = await import('../server/index.js')
  const req = {
    method,
    url: path,
    headers: {
      host: 'test.local',
      ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      'x-forwarded-for': ip,
      ...headers,
    },
    socket: { remoteAddress: ip },
  }
  // On Vercel `req.body` is a getter that throws when the JSON is malformed.
  if (badJsonBody) Object.defineProperty(req, 'body', { get() { throw new SyntaxError('Unexpected token') } })
  else if (onBodyRead) {
    Object.defineProperty(req, 'body', {
      get() {
        onBodyRead()
        return body
      },
    })
  } else req.body = body
  const res = mockRes()
  await handle(req, res)
  await res.done
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* text response */
  }
  return { status: res.statusCode, json, text: res.body, headers: res.headers }
}

export async function seedAdmin(pool, email = 'admin@test.local') {
  await pool.query('insert into admins (email, name) values ($1, $2)', [email, 'Test Admin'])
  return { email }
}

/** Signs in through the real /admin/google endpoint and returns the Cookie header to send back. */
export async function adminCookie(email = 'admin@test.local') {
  const r = await call('POST', '/api/admin/google', { body: { credential: email } })
  if (r.status !== 200) throw new Error('admin sign-in failed: ' + r.text)
  return String(r.headers['set-cookie']).split(';')[0]
}
