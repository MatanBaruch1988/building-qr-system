import { timingSafeEqual } from 'node:crypto'
import { query, tx } from './db.js'
import { sha256 } from './crypto.js'
import { bearerToken, getCookie, unauthorized, ApiError } from './http.js'
import {
  ADMIN_COOKIE,
  ADMIN_TOKEN_PREFIX,
  AGENT_KEY_MAX_PER_DAY,
  AGENT_KEY_MAX_PER_MINUTE,
  API_KEY_PREFIX,
  LOGIN_MAX_FAILURES,
  LOGIN_MAX_PER_ACCOUNT,
  LOGIN_MAX_PER_IP,
  LOGIN_WINDOW_MINUTES,
  MAX_TOKEN_LENGTH,
  PROVIDER_TOKEN_PREFIX,
  TIMEZONE,
} from './config.js'

const TOUCH_EVERY_MS = 5 * 60 * 1000

// The router runs the guard of a route before the handler (server/router.js, server/access.js), and a handler may call the
// same guard again to learn who is signed in. A guard therefore answers once per request: the first call starts the lookup
// and every later call for the same `req` gets the same promise, so the second call makes no query, touches nothing, and
// gives the same answer (or the same refusal). Each guard has its own WeakMap, so the answers go away with the request.
function oncePerRequest(guard) {
  const answers = new WeakMap()
  return (req) => {
    if (!answers.has(req)) answers.set(req, guard(req))
    return answers.get(req)
  }
}

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
export const requireProvider = oncePerRequest(async function requireProvider(req) {
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
})

/** Committee member: HttpOnly session cookie. A cookie that is not shaped like a session token is refused without a query. */
export const requireAdmin = oncePerRequest(async function requireAdmin(req) {
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
})

// The whole database work of the guard of an agent key: ONE statement, so that a request costs one round trip and the lookup,
// the count and the bookkeeping cannot disagree. (AGENTS.md, Safety, "The committee's agent is its analyst": these are the
// only two writes that a request of an agent makes.)
//   $1 the hash of the key   $2 the building's time zone   $3 how often last_used_at is written, in seconds
//   $4 the most requests in a minute   $5 the most requests in a building day
//  - `k`: the key, only when it exists and is not revoked, and locked `for key share` (see the lock order below). An unknown or
//    revoked key leaves nothing after it, so nothing is counted and nothing is written for it (the guard answers 401
//    api_key_invalid).
//  - `used`: the requests that were let through (api_key_usage.requests) since the start of the building's day, and in the
//    current minute. The day starts at midnight in the time zone of the building (`day_start`), whatever the time zone of
//    the database session is; `day_end` is the next midnight, for Retry-After.
//  - `verdict`: which limit the key is over, if any: 'day' first (it is the longer wait), else 'minute', else null.
//  - `bump`: counts this request in the row of the current minute (made on the first request of the minute). A request
//    that is let through adds 1 to `requests`; a request that is over a limit adds 1 to `refused` and nothing to `requests`,
//    so a limited key does not keep itself limited by asking again, and a screen can show both numbers.
//  - `touch`: writes api_keys.last_used_at, only when it is empty or older than TOUCH_EVERY_MS (the rule that provider phones
//    use, so a busy key is not one write per request on the row of the key).
// The lock order is the same for every request, on every serverless instance: the key row first, in the weakest mode (`k`,
// `for key share`, which does not conflict with another request or with revoking the key), then the usage row (`bump`), then the
// key row again in the stronger mode that an update needs (`touch` reads what `bump` returns, so its update cannot happen before
// the usage row was written). Two requests of one key therefore queue on the usage row and never wait for each other crosswise.
// The key comes FIRST on purpose: deleting a key (DELETE /api/admin/api-keys/:id) locks the key row and then, through the
// cascade of the foreign key, its usage rows. A request that took the usage row first and then asked for the key row (the check
// of the foreign key, or `touch`) would wait for the delete while the delete waits for it, and the database would end one of
// the two with a deadlock (40P01, an answer of 500 for either). With the key first, the delete waits for the requests that are
// in flight (milliseconds), and a request that comes after it finds no key and is answered 401.
// The counts are read from the snapshot of the statement, before this request is added, so requests that start in the same
// instant can each be let in: the limit is soft by about the number of requests in flight.
const API_KEY_GUARD_SQL = `
  with w as (
    select date_trunc('minute', now()) as minute,
           (date_trunc('day', now() at time zone $2::text) at time zone $2::text) as day_start,
           ((date_trunc('day', now() at time zone $2::text) + interval '1 day') at time zone $2::text) as day_end
  ),
  k as (
    select id from api_keys where key_hash = $1 and revoked_at is null for key share
  ),
  used as (
    select k.id,
           coalesce(sum(u.requests), 0)::int as today,
           coalesce(sum(u.requests) filter (where u.minute = w.minute), 0)::int as this_minute
      from k
      cross join w
      left join api_key_usage u on u.key_id = k.id and u.minute >= w.day_start
     group by k.id
  ),
  verdict as (
    select id,
           case when today >= $5::int then 'day' when this_minute >= $4::int then 'minute' end as limited_by
      from used
  ),
  bump as (
    insert into api_key_usage as u (key_id, minute, requests, refused)
    select v.id, w.minute, (v.limited_by is null)::int, (v.limited_by is not null)::int
      from verdict v
      cross join w
    on conflict (key_id, minute) do update
      set requests = u.requests + excluded.requests, refused = u.refused + excluded.refused
    returning key_id
  ),
  touch as (
    update api_keys a
       set last_used_at = now()
      from bump b
     where a.id = b.key_id
       and (a.last_used_at is null or a.last_used_at < now() - make_interval(secs => $3::double precision))
    returning a.id
  )
  select v.id,
         v.limited_by,
         case v.limited_by
           when 'day' then ceil(extract(epoch from w.day_end - now()))::int
           when 'minute' then ceil(extract(epoch from w.minute + interval '1 minute' - now()))::int
         end as retry_after_s
    from verdict v
    cross join w
`

/**
 * External agent: `Authorization: Bearer qrk_…` (read-only). Three answers:
 *  - 401 `api_key_required` (no key, or not shaped like ours) and 401 `api_key_invalid` (unknown or revoked), the shape check
 *    first and without a query;
 *  - 429 `rate_limited` when the key is over AGENT_KEY_MAX_PER_MINUTE (in the current minute) or AGENT_KEY_MAX_PER_DAY (in the
 *    building's day): the body names the `window` ('minute' or 'day') and `retry_after_s`, and the Retry-After header says the
 *    same. It is part of the guard, so the router answers it before any handler runs and records nothing in app_errors;
 *  - otherwise the key's id. The request was counted (API_KEY_GUARD_SQL), once: the guard answers once per request.
 */
export const requireApiKey = oncePerRequest(async function requireApiKey(req) {
  const token = bearerToken(req)
  if (!token || !token.startsWith(API_KEY_PREFIX)) throw unauthorized('api_key_required', 'API key required')
  // Too long to be one of ours: the answer an unknown key gets, without a query.
  if (token.length > MAX_TOKEN_LENGTH) throw unauthorized('api_key_invalid', 'API key is invalid or revoked')
  let rows
  try {
    ;({ rows } = await query(API_KEY_GUARD_SQL, [
      sha256(token),
      TIMEZONE,
      TOUCH_EVERY_MS / 1000,
      AGENT_KEY_MAX_PER_MINUTE,
      AGENT_KEY_MAX_PER_DAY,
    ]))
  } catch (err) {
    // The committee deleted the key between the lookup and the count of this very statement: the foreign key of
    // api_key_usage refuses the row. For the caller that is a key that is gone, not a conflict.
    if (err?.code === '23503') throw unauthorized('api_key_invalid', 'API key is invalid or revoked')
    throw err
  }
  if (!rows.length) throw unauthorized('api_key_invalid', 'API key is invalid or revoked')
  const { id, limited_by: window, retry_after_s: retryAfter } = rows[0]
  if (window) {
    const wait = `Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`
    const message =
      window === 'day'
        ? `Daily limit reached: at most ${AGENT_KEY_MAX_PER_DAY} requests per building day for one key. ${wait}`
        : `Rate limit reached: at most ${AGENT_KEY_MAX_PER_MINUTE} requests per minute for one key. ${wait}`
    throw new ApiError(429, 'rate_limited', message, { window, retry_after_s: retryAfter }, { 'Retry-After': String(retryAfter) })
  }
  return { apiKeyId: id }
})

/**
 * A scheduled job (the routes under /cron/): `Authorization: Bearer <CRON_SECRET>`, which is what Vercel Cron sends when the
 * project has the environment variable CRON_SECRET (Production only, docs/runbooks/secrets.md).
 *  - It decides from the request and the environment alone: no database statement, so a refused request costs nothing and
 *    cannot wake the database.
 *  - A missing or empty CRON_SECRET refuses EVERY request, with or without a header. There is no mode in which the route is
 *    open (a deployment that was never given the secret is closed, not open).
 *  - The secret is read on each request, not when the module loads, so a change of the variable takes effect with the next
 *    request and a test can set it.
 *  - Both values are hashed first, so the two buffers that timingSafeEqual compares always have the same length: the time it
 *    takes says nothing about the secret, and a header of a different length is a plain refusal.
 * One code for every refusal (`cron_required`), so the answer does not tell a missing header from a wrong one, nor a
 * deployment without a secret from one with it.
 */
export const requireCron = oncePerRequest(async function requireCron(req) {
  const expected = process.env.CRON_SECRET
  const given = bearerToken(req)
  if (typeof expected !== 'string' || expected === '' || !given) throw unauthorized('cron_required', 'Cron secret required')
  const same = timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(expected)))
  if (!same) throw unauthorized('cron_required', 'Cron secret required')
  return { cron: true }
})

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
