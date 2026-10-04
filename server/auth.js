import { query, tx } from './db.js'
import { sha256 } from './crypto.js'
import { bearerToken, getCookie, unauthorized, ApiError } from './http.js'
import {
  ADMIN_COOKIE,
  ADMIN_TOKEN_PREFIX,
  API_KEY_PREFIX,
  LOGIN_MAX_FAILURES,
  LOGIN_MAX_PER_ACCOUNT,
  LOGIN_MAX_PER_IP,
  LOGIN_WINDOW_MINUTES,
  MAX_TOKEN_LENGTH,
  PROVIDER_TOKEN_PREFIX,
} from './config.js'

const TOUCH_EVERY_MS = 5 * 60 * 1000

// Anything we minted starts with its prefix and is short (see config.js). Checking that first means a random string in
// a header or a cookie is refused without a database round trip, which would otherwise cost a query and could wake the
// Neon compute for anyone who asked.
const hasTokenShape = (token, prefix) => token.startsWith(prefix) && token.length <= MAX_TOKEN_LENGTH
export const isProviderToken = (token) => hasTokenShape(token, PROVIDER_TOKEN_PREFIX)
export const isAdminToken = (token) => hasTokenShape(token, ADMIN_TOKEN_PREFIX)

/**
 * Provider phone: `Authorization: Bearer <device token>`. Inactive provider or revoked device = 401.
 * A token that is not shaped like a device token gets the same answer as no token, without a query.
 */
export async function requireProvider(req) {
  const token = bearerToken(req)
  if (!token || !isProviderToken(token)) throw unauthorized('invalid_session', 'Sign in required')
  const { rows } = await query(
    `select d.id as device_id, d.last_seen_at, p.id, p.company, p.contact_name, p.service_type, p.is_demo
       from provider_devices d
       join providers p on p.id = d.provider_id
      where d.token_hash = $1 and d.revoked_at is null and p.is_active`,
    [sha256(token)],
  )
  if (!rows.length) throw unauthorized('invalid_session', 'Session expired')
  const row = rows[0]
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_EVERY_MS) {
    await query('update provider_devices set last_seen_at = now() where id = $1', [row.device_id])
  }
  return {
    deviceId: row.device_id,
    provider: {
      id: row.id,
      company: row.company,
      contact_name: row.contact_name,
      service_type: row.service_type,
      is_demo: row.is_demo,
    },
  }
}

/** Committee member: HttpOnly session cookie. A cookie that is not shaped like a session token is refused without a query. */
export async function requireAdmin(req) {
  const token = getCookie(req, ADMIN_COOKIE)
  if (!token || !isAdminToken(token)) throw unauthorized('admin_required', 'Admin sign in required')
  const { rows } = await query(
    `select a.id, a.email, a.name, s.id as session_id
       from admin_sessions s
       join admins a on a.id = s.admin_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and a.is_active`,
    [sha256(token)],
  )
  if (!rows.length) throw unauthorized('admin_required', 'Admin session expired')
  return { admin: { id: rows[0].id, email: rows[0].email, name: rows[0].name }, sessionId: rows[0].session_id }
}

/** External agent: `Authorization: Bearer qrk_…` (read-only). */
export async function requireApiKey(req) {
  const token = bearerToken(req)
  if (!token || !token.startsWith(API_KEY_PREFIX)) throw unauthorized('api_key_required', 'API key required')
  // Too long to be one of ours: the answer an unknown key gets, without a query.
  if (token.length > MAX_TOKEN_LENGTH) throw unauthorized('api_key_invalid', 'API key is invalid or revoked')
  const { rows } = await query(
    'select id from api_keys where key_hash = $1 and revoked_at is null',
    [sha256(token)],
  )
  if (!rows.length) throw unauthorized('api_key_invalid', 'API key is invalid or revoked')
  query('update api_keys set last_used_at = now() where id = $1', [rows[0].id]).catch(() => {})
  return { apiKeyId: rows[0].id }
}

// --- Login throttling, stored in the database so it works across serverless instances.

/**
 * Charges one attempt BEFORE the password is verified (so parallel guesses cannot all slip past the
 * check first), or throws 429. Call `.success()` after a correct password to give the attempt back.
 *  - `account` must be canonical (lower-case id / email), or upper/lower case would count separately.
 *  - Per-account-and-address, per-account, and per-address limits: see config.js.
 */
export async function guardLogin({ scope, account, ip }) {
  const perAccountIp = `${scope}:${account}:${ip}`
  const perAccount = `${scope}:${account}`
  const perIp = `ip:${ip}`
  const limits = [
    [perAccountIp, LOGIN_MAX_FAILURES],
    [perAccount, LOGIN_MAX_PER_ACCOUNT],
    [perIp, LOGIN_MAX_PER_IP],
  ]

  await tx(async (c) => {
    // One attempt at a time per account: count-then-insert cannot interleave.
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`login:${perAccount}`])
    await c.query(`delete from auth_attempts where at < now() - interval '1 day'`) // table cannot grow forever
    for (const [key, max] of limits) {
      const { rows } = await c.query(
        `select count(*)::int as n from auth_attempts
          where key = $1 and at > now() - ($2 || ' minutes')::interval`,
        [key, String(LOGIN_WINDOW_MINUTES)],
      )
      if (rows[0].n >= max) {
        throw new ApiError(429, 'too_many_attempts', 'Too many attempts, try again later', {
          retryAfterMinutes: LOGIN_WINDOW_MINUTES,
        })
      }
    }
    for (const [key] of limits) await c.query('insert into auth_attempts (scope, key) values ($1, $2)', [scope, key])
  })

  return {
    // A correct password clears this account's counters (the address-wide one keeps counting).
    success: () => query('delete from auth_attempts where key = any($1)', [[perAccountIp, perAccount]]),
  }
}
