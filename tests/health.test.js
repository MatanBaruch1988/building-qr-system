// GET /api/health (no database) and GET /api/health/db (the smoke test after a deploy).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { setupDb, call } from './helpers.js'
import { setPool } from '../server/db.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const newestMigration = fs
  .readdirSync(new URL('../db/migrations', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .at(-1)

let db
let savedSha

beforeAll(async () => {
  db = await setupDb()
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
  it('answers 200 with the newest migration', async () => {
    const r = await call('GET', '/api/health/db')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, commit: null, migration: newestMigration })
  })

  it('shows the short commit too', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = SHA
    const r = await call('GET', '/api/health/db')
    expect(r.json).toEqual({ ok: true, commit: SHA.slice(0, 7), migration: newestMigration })
  })

  it('answers 503 with no detail when the query fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.VERCEL_GIT_COMMIT_SHA = SHA
    setPool({
      query: async () => {
        throw new Error('password authentication failed for user "secret-user"')
      },
    })
    const r = await call('GET', '/api/health/db')
    expect(r.status).toBe(503)
    expect(r.json).toEqual({ ok: false, commit: SHA.slice(0, 7) })
    expect(r.text).not.toContain('secret-user')
    // The cause goes to the log, not to the response.
    expect(logged).toHaveBeenCalledWith('health/db failed:', expect.stringContaining('secret-user'))
  })

  it('answers 503 when the database does not answer within about 5 seconds', { timeout: 20_000 }, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setPool({ query: () => new Promise(() => {}) })
    const started = Date.now()
    const r = await call('GET', '/api/health/db')
    const took = Date.now() - started
    expect(r.status).toBe(503)
    expect(r.json).toEqual({ ok: false, commit: null })
    expect(took).toBeGreaterThan(4500)
    expect(took).toBeLessThan(8000)
  })

  it('does not accept a write', async () => {
    const r = await call('POST', '/api/health/db', { body: {} })
    expect(r.status).toBe(405)
  })
})
