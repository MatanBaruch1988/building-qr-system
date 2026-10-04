// A provider device token (qrp_), a committee session cookie (qra_) and an agent key (qrk_) are checked for their shape
// before any database query: a random string in a header or a cookie costs no round trip (and cannot wake the Neon
// compute). Every token the server mints has its prefix and is short (config.js), so this refuses nothing that is real.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { setPool } from '../server/db.js'
import { randomToken } from '../server/crypto.js'
import { isAdminToken, isProviderToken } from '../server/auth.js'
import {
  ADMIN_COOKIE, ADMIN_TOKEN_PREFIX, API_KEY_PREFIX, MAX_TOKEN_LENGTH, PROVIDER_TOKEN_PREFIX,
} from '../server/config.js'
import { SAMPLE_PROVIDER_NAMES } from '../scripts/sample-data.mjs'

let db

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
})
afterAll(async () => db?.teardown())
afterEach(() => setPool(db.pool))

/** A pool that records every query it is asked and finds nothing (so a token that reaches it is "unknown"). */
function countingPool() {
  const queries = []
  return {
    queries,
    query: async (text) => {
      queries.push(text)
      return { rows: [] }
    },
    connect: async () => {
      throw new Error('the database must not be used')
    },
  }
}

const body43 = 'a'.repeat(43) // what randomToken adds after the prefix
const adminCookieOf = (token) => `${ADMIN_COOKIE}=${encodeURIComponent(token)}`

describe('the shape of a token', () => {
  it('every minted token passes its own check and stays far below the limit', () => {
    const provider = randomToken(PROVIDER_TOKEN_PREFIX)
    const admin = randomToken(ADMIN_TOKEN_PREFIX)
    const key = randomToken(API_KEY_PREFIX)
    expect(isProviderToken(provider)).toBe(true)
    expect(isAdminToken(admin)).toBe(true)
    expect(provider).toHaveLength(47)
    expect(admin).toHaveLength(47)
    expect(key).toHaveLength(47)
    expect(MAX_TOKEN_LENGTH).toBeGreaterThanOrEqual(2 * provider.length)
  })

  it('the kinds are told apart, and the limit is on the whole token', () => {
    expect(isProviderToken(randomToken(ADMIN_TOKEN_PREFIX))).toBe(false)
    expect(isAdminToken(randomToken(PROVIDER_TOKEN_PREFIX))).toBe(false)
    expect(isProviderToken(randomToken(API_KEY_PREFIX))).toBe(false)
    expect(isProviderToken('QRP_' + body43)).toBe(false) // the prefix is case-sensitive, like the tokens
    expect(isProviderToken(' ' + PROVIDER_TOKEN_PREFIX + body43)).toBe(false)
    const atLimit = PROVIDER_TOKEN_PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH - PROVIDER_TOKEN_PREFIX.length)
    expect(atLimit).toHaveLength(MAX_TOKEN_LENGTH)
    expect(isProviderToken(atLimit)).toBe(true)
    expect(isProviderToken(atLimit + 'a')).toBe(false)
    expect(isAdminToken(ADMIN_TOKEN_PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH))).toBe(false)
  })
})

describe('a provider token that cannot be ours is refused without a query', () => {
  const refused = [
    ['no Authorization header', {}],
    ['a bearer with nothing after it', { headers: { authorization: 'Bearer' } }],
    ['a bearer with only a space after it', { headers: { authorization: 'Bearer ' } }],
    ['a token with no prefix', { token: 'abc123' }],
    ['a random token as long as a real one', { token: body43 + 'aaaa' }],
    ['the prefix of a committee session', { token: ADMIN_TOKEN_PREFIX + body43 }],
    ['an agent key', { token: API_KEY_PREFIX + body43 }],
    ['the prefix in capital letters', { token: 'QRP_' + body43 }],
    ['the prefix in the middle', { token: 'x' + PROVIDER_TOKEN_PREFIX + body43 }],
    ['a token with the prefix that is too long', { token: PROVIDER_TOKEN_PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH) }],
    ['a very long token', { token: PROVIDER_TOKEN_PREFIX + 'a'.repeat(5000) }],
  ]

  it.each(refused)('%s: 401 invalid_session, as for a missing token, and zero queries', async (_name, options) => {
    const pool = countingPool()
    setPool(pool)
    const r = await call('GET', '/api/session', options)
    expect(r.status).toBe(401)
    expect(r.json).toEqual({ error: { code: 'invalid_session', message: 'Sign in required' } })
    expect(pool.queries).toEqual([])
  })

  it('holds on every provider route', async () => {
    const pool = countingPool()
    setPool(pool)
    const token = 'not-a-device-token'
    for (const [method, path] of [
      ['GET', '/api/session'],
      ['DELETE', '/api/session'],
      ['POST', '/api/scan'],
      ['POST', '/api/scans/sync'],
      ['GET', '/api/my/scans'],
    ]) {
      const r = await call(method, path, { token, body: {} })
      expect(r.status, `${method} ${path}`).toBe(401)
      expect(r.json.error.code).toBe('invalid_session')
    }
    expect(pool.queries).toEqual([])
  })

  it('a well-formed token that is unknown still goes to the database, once, and gets 401', async () => {
    const pool = countingPool()
    setPool(pool)
    const r = await call('GET', '/api/session', { token: randomToken(PROVIDER_TOKEN_PREFIX) })
    expect(r.status).toBe(401)
    expect(r.json).toEqual({ error: { code: 'invalid_session', message: 'Session expired' } })
    expect(pool.queries).toHaveLength(1)
    expect(pool.queries[0]).toMatch(/provider_devices/)
  })

  it('a token of exactly the longest length is still looked up', async () => {
    const pool = countingPool()
    setPool(pool)
    const token = PROVIDER_TOKEN_PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH - PROVIDER_TOKEN_PREFIX.length)
    const r = await call('GET', '/api/session', { token })
    expect(r.status).toBe(401)
    expect(pool.queries).toHaveLength(1)
  })
})

describe('a committee cookie that cannot be ours is refused without a query', () => {
  const refused = [
    ['no cookie at all', {}],
    ['a cookie of another name', { cookie: `other=${ADMIN_TOKEN_PREFIX}${body43}` }],
    ['an empty cookie', { cookie: `${ADMIN_COOKIE}=` }],
    ['a cookie that cannot be decoded', { cookie: `${ADMIN_COOKIE}=%` }],
    ['a cookie with no prefix', { cookie: `${ADMIN_COOKIE}=abc123` }],
    ['a random value as long as a real one', { cookie: `${ADMIN_COOKIE}=${body43}aaaa` }],
    ['the prefix of a provider device', { cookie: adminCookieOf(PROVIDER_TOKEN_PREFIX + body43) }],
    ['the prefix in capital letters', { cookie: adminCookieOf('QRA_' + body43) }],
    ['a cookie with the prefix that is too long', { cookie: adminCookieOf(ADMIN_TOKEN_PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH)) }],
    ['a very long cookie', { cookie: adminCookieOf(ADMIN_TOKEN_PREFIX + 'a'.repeat(5000)) }],
  ]

  it.each(refused)('%s: 401 admin_required, as for a missing cookie, and zero queries', async (_name, options) => {
    const pool = countingPool()
    setPool(pool)
    const r = await call('GET', '/api/admin/me', options)
    expect(r.status).toBe(401)
    expect(r.json).toEqual({ error: { code: 'admin_required', message: 'Admin sign in required' } })
    expect(pool.queries).toEqual([])
  })

  it('holds on a read and on a write', async () => {
    const pool = countingPool()
    setPool(pool)
    const cookie = `${ADMIN_COOKIE}=not-a-session`
    expect((await call('GET', '/api/admin/points', { cookie })).json.error.code).toBe('admin_required')
    expect((await call('POST', '/api/admin/points', { cookie, body: {} })).json.error.code).toBe('admin_required')
    expect(pool.queries).toEqual([])
  })

  it('a well-formed cookie that is unknown still goes to the database, once, and gets 401', async () => {
    const pool = countingPool()
    setPool(pool)
    const r = await call('GET', '/api/admin/me', { cookie: adminCookieOf(randomToken(ADMIN_TOKEN_PREFIX)) })
    expect(r.status).toBe(401)
    expect(r.json).toEqual({ error: { code: 'admin_required', message: 'Admin session expired' } })
    expect(pool.queries).toHaveLength(1)
    expect(pool.queries[0]).toMatch(/admin_sessions/)
  })
})

describe('signing out', () => {
  const answers = async (options) => {
    const r = await call('POST', '/api/admin/logout', { body: {}, ...options })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true })
    expect(String(r.headers['set-cookie'])).toMatch(new RegExp(`^${ADMIN_COOKIE}=; .*Max-Age=0`))
  }

  it('costs no query for a cookie that cannot be ours, and answers the same', async () => {
    const pool = countingPool()
    setPool(pool)
    for (const options of [
      {},
      { cookie: `${ADMIN_COOKIE}=` },
      { cookie: `${ADMIN_COOKIE}=abc123` },
      { cookie: adminCookieOf(PROVIDER_TOKEN_PREFIX + body43) },
      { cookie: adminCookieOf(ADMIN_TOKEN_PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH)) },
    ]) {
      await answers(options)
    }
    expect(pool.queries).toEqual([])
  })

  it('still revokes a cookie shaped like a session token, with one query', async () => {
    const pool = countingPool()
    setPool(pool)
    await answers({ cookie: adminCookieOf(randomToken(ADMIN_TOKEN_PREFIX)) })
    expect(pool.queries).toHaveLength(1)
    expect(pool.queries[0]).toMatch(/update admin_sessions set revoked_at/)
  })
})

describe('an agent key', () => {
  it('without its prefix is refused without a query, and so is one that is too long', async () => {
    const pool = countingPool()
    setPool(pool)
    const noKey = await call('GET', '/api/agent/v1/points', { token: 'abc123' })
    expect(noKey.json.error).toEqual({ code: 'api_key_required', message: 'API key required' })
    const tooLong = await call('GET', '/api/agent/v1/points', { token: API_KEY_PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH) })
    expect(tooLong.status).toBe(401)
    expect(tooLong.json.error).toEqual({ code: 'api_key_invalid', message: 'API key is invalid or revoked' })
    expect(pool.queries).toEqual([])
  })

  it('a well-formed key that is unknown goes to the database, once', async () => {
    const pool = countingPool()
    setPool(pool)
    const r = await call('GET', '/api/agent/v1/points', { token: randomToken(API_KEY_PREFIX) })
    expect(r.json.error.code).toBe('api_key_invalid')
    expect(pool.queries).toHaveLength(1)
  })
})

describe('the real flow still works', () => {
  it('a provider signs in, uses the token, and signing out revokes it', async () => {
    const cookie = await adminCookie()
    const made = await call('POST', '/api/admin/providers', {
      cookie,
      body: { company: 'Cleaning Ltd', contact_name: SAMPLE_PROVIDER_NAMES.cleaner, service_type: 'cleaning', password: 'test-pass-1234' },
    })
    expect(made.status).toBe(201)
    const login = await call('POST', '/api/session', { body: { provider_id: made.json.provider.id, password: 'test-pass-1234' } })
    expect(login.status).toBe(200)
    const token = login.json.token
    expect(token.startsWith(PROVIDER_TOKEN_PREFIX)).toBe(true)
    expect(isProviderToken(token)).toBe(true)

    const me = await call('GET', '/api/session', { token })
    expect(me.status).toBe(200)
    expect(me.json.provider.company).toBe('Cleaning Ltd')
    expect((await call('GET', '/api/my/scans', { token })).status).toBe(200)

    expect((await call('DELETE', '/api/session', { token })).status).toBe(200)
    const after = await call('GET', '/api/session', { token })
    expect(after.status).toBe(401)
    expect(after.json.error).toEqual({ code: 'invalid_session', message: 'Session expired' }) // well-formed, so it was looked up
  })

  it('a committee member signs in, uses the cookie, and signing out revokes it', async () => {
    const login = await call('POST', '/api/admin/google', { body: { credential: 'admin@test.local' } })
    expect(login.status).toBe(200)
    const cookie = String(login.headers['set-cookie']).split(';')[0]
    const [name, ...rest] = cookie.split('=')
    expect(name).toBe(ADMIN_COOKIE)
    expect(isAdminToken(decodeURIComponent(rest.join('=')))).toBe(true)

    expect((await call('GET', '/api/admin/me', { cookie })).json.admin.email).toBe('admin@test.local')

    // A cookie that is not ours signs nobody out: the real session stays valid.
    await call('POST', '/api/admin/logout', { body: {}, cookie: `${ADMIN_COOKIE}=abc123` })
    expect((await call('GET', '/api/admin/me', { cookie })).status).toBe(200)

    await call('POST', '/api/admin/logout', { body: {}, cookie })
    const after = await call('GET', '/api/admin/me', { cookie })
    expect(after.status).toBe(401)
    expect(after.json.error).toEqual({ code: 'admin_required', message: 'Admin session expired' })
  })

  it('an agent key the committee creates works', async () => {
    const cookie = await adminCookie()
    const made = await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'shape test' } })
    expect(made.status).toBe(201)
    expect(made.json.key.startsWith(API_KEY_PREFIX)).toBe(true)
    expect((await call('GET', '/api/agent/v1/points', { token: made.json.key })).status).toBe(200)
  })
})
