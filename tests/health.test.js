// GET /api/health (public, no database) and GET /api/health/db (needs a read-only agent key: the smoke test after a deploy).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { setPool } from '../server/db.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const newestMigration = fs
  .readdirSync(new URL('../db/migrations', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .at(-1)

let db
let key
let savedSha

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  const cookie = await adminCookie()
  // The key the agent API uses: the committee creates it in the admin screen, and it is shown once.
  key = (await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'health' } })).json.key
})
afterAll(async () => db?.teardown())
beforeEach(() => {
  savedSha = process.env.VERCEL_GIT_COMMIT_SHA
  delete process.env.VERCEL_GIT_COMMIT_SHA
})
afterEach(() => {
  setPool(db.pool)
  vi.restoreAllMocks()
  if (savedSha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA
  else process.env.VERCEL_GIT_COMMIT_SHA = savedSha
})

/** A pool that fails the test if anything asks it for a connection or a query. */
const forbiddenPool = {
  query: async () => {
    throw new Error('the database must not be queried')
  },
  connect: async () => {
    throw new Error('the database must not be used')
  },
}

/** A pool that records every query it is asked and fails it (nothing reaches a database). */
function recordingPool() {
  const queries = []
  return {
    queries,
    query: async (text) => {
      queries.push(text)
      throw new Error('the database is not reachable in this test')
    },
    connect: async () => {
      throw new Error('the database must not be used')
    },
  }
}

/** A real pool for the key lookup, and a failing one for the health query itself (the only one that reads schema_migrations). */
const failingHealthQuery = {
  query: (text, params) =>
    /schema_migrations/.test(text)
      ? Promise.reject(new Error('password authentication failed for user "secret-user"'))
      : db.pool.query(text, params),
}

describe('GET /api/health', () => {
  it('answers ok with commit null when Vercel gave no commit, and never queries the database', async () => {
    setPool(forbiddenPool)
    const r = await call('GET', '/api/health')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, commit: null })
  })

  it('shows the first 7 characters of the commit that Vercel built', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = SHA
    setPool(forbiddenPool)
    const r = await call('GET', '/api/health')
    expect(r.json).toEqual({ ok: true, commit: SHA.slice(0, 7) })
    expect(r.text).not.toContain(SHA)
  })
})

describe('GET /api/health/db', () => {
  it('refuses a request with no key, without any database query', async () => {
    const pool = recordingPool()
    setPool(pool)
    const r = await call('GET', '/api/health/db')
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('api_key_required')
    expect(pool.queries).toEqual([])
    expect(r.text).not.toContain('migration')
  })

  it('refuses a malformed key, without any database query', async () => {
    const pool = recordingPool()
    setPool(pool)
    for (const headers of [{ authorization: 'Bearer not-a-key' }, { authorization: 'Basic cXJrX2Fi' }, { authorization: 'qrk_abc' }, { authorization: 'Bearer' }]) {
      const r = await call('GET', '/api/health/db', { headers })
      expect(r.status, JSON.stringify(headers)).toBe(401)
      expect(r.json.error.code).toBe('api_key_required')
    }
    expect(pool.queries).toEqual([])
  })

  it('refuses a key that does not exist', async () => {
    const r = await call('GET', '/api/health/db', { token: 'qrk_does_not_exist' })
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('api_key_invalid')
    expect(r.json).not.toHaveProperty('migration')
  })

  it('refuses a revoked key', async () => {
    const cookie = await adminCookie()
    const made = (await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'to revoke' } })).json
    expect((await call('GET', '/api/health/db', { token: made.key })).status).toBe(200)
    expect((await call('POST', `/api/admin/api-keys/${made.api_key.id}/revoke`, { cookie, body: {} })).status).toBe(200)
    const r = await call('GET', '/api/health/db', { token: made.key })
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('api_key_invalid')
  })

  it('answers 200 with the newest migration for a valid key', async () => {
    const r = await call('GET', '/api/health/db', { token: key })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, commit: null, migration: newestMigration })
  })

  it('shows the short commit too', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = SHA
    const r = await call('GET', '/api/health/db', { token: key })
    expect(r.json).toEqual({ ok: true, commit: SHA.slice(0, 7), migration: newestMigration })
  })

  it('answers 503 with no detail when the query fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.VERCEL_GIT_COMMIT_SHA = SHA
    setPool(failingHealthQuery)
    const r = await call('GET', '/api/health/db', { token: key })
    expect(r.status).toBe(503)
    expect(r.json).toEqual({ ok: false, commit: SHA.slice(0, 7) })
    expect(r.text).not.toContain('secret-user')
    // The cause goes to the log, not to the response.
    expect(logged).toHaveBeenCalledWith('health/db failed:', expect.stringContaining('secret-user'))
  })

  it('answers 503, not 500, when the database is down altogether (the key lookup fails too)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPool(recordingPool())
    const r = await call('GET', '/api/health/db', { token: key })
    expect(r.status).toBe(503)
    expect(r.json).toEqual({ ok: false, commit: null })
  })

  it('answers 503 when the database does not answer within about 5 seconds', { timeout: 20_000 }, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPool({ query: () => new Promise(() => {}) })
    const started = Date.now()
    const r = await call('GET', '/api/health/db', { token: key })
    const took = Date.now() - started
    expect(r.status).toBe(503)
    expect(r.json).toEqual({ ok: false, commit: null })
    expect(took).toBeGreaterThan(4500)
    expect(took).toBeLessThan(8000)
  })

  it('does not accept a write', async () => {
    const r = await call('POST', '/api/health/db', { body: {}, token: key })
    expect(r.status).toBe(405)
  })
})
