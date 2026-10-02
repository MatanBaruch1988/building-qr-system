// assertNotProduction against fake `query` objects (no database), and the connection-string normalizer that decides
// how the tooling reaches the database.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertNotProduction } from '../server/dbGuard.js'
import { normalizeConnectionString } from '../server/db.js'

/** A fake pg client: `marker` is the rows of public.environment_marker, or null when the table does not exist. */
function fakeDb(marker) {
  const sent = []
  return {
    sent,
    async query(text) {
      sent.push(text)
      if (/to_regclass/.test(text)) return { rows: [{ present: marker !== null }] }
      if (/environment_marker/.test(text)) return { rows: marker ?? [] }
      throw new Error('unexpected query: ' + text)
    },
  }
}

const row = (environment) => ({ environment })
let savedVercelEnv

beforeEach(() => {
  savedVercelEnv = process.env.VERCEL_ENV
  delete process.env.VERCEL_ENV
})

afterEach(() => {
  if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = savedVercelEnv
})

describe('assertNotProduction', () => {
  it('throws for a production row, and says what to do', async () => {
    await expect(assertNotProduction(fakeDb([row('production')]))).rejects.toThrow(/this database is production/i)
    await expect(assertNotProduction(fakeDb([row('production')]))).rejects.toThrow(/non-production/)
  })

  it('throws when any row is production', async () => {
    await expect(assertNotProduction(fakeDb([row('nonprod'), row('production')]))).rejects.toThrow(/production/)
  })

  it('passes for nonprod', async () => {
    await expect(assertNotProduction(fakeDb([row('nonprod')]))).resolves.toBeUndefined()
  })

  it('passes when the marker table is missing (CI container, fresh database)', async () => {
    const db = fakeDb(null)
    await expect(assertNotProduction(db)).resolves.toBeUndefined()
    expect(db.sent).toHaveLength(1) // it did not even try to read the table
  })

  it('always uses the schema-qualified table name, so a search_path cannot hide it', async () => {
    const db = fakeDb([row('nonprod')])
    await assertNotProduction(db)
    expect(db.sent).toHaveLength(2)
    for (const text of db.sent) expect(text).toContain('public.environment_marker')
  })

  it('lets a failing database query through as an error, not as "allowed"', async () => {
    const db = { query: async () => Promise.reject(new Error('connection refused')) }
    await expect(assertNotProduction(db)).rejects.toThrow('connection refused')
  })
})

describe('assertNotProduction on Vercel production (the migration build)', () => {
  it('allows production only with the option and VERCEL_ENV=production', async () => {
    process.env.VERCEL_ENV = 'production'
    const db = fakeDb([row('production')])
    await expect(assertNotProduction(db, { allowOnVercelProduction: true })).resolves.toBeUndefined()
  })

  it('refuses production without the option, even when VERCEL_ENV=production', async () => {
    process.env.VERCEL_ENV = 'production'
    await expect(assertNotProduction(fakeDb([row('production')]))).rejects.toThrow(/production/)
    await expect(assertNotProduction(fakeDb([row('production')]), { allowOnVercelProduction: false })).rejects.toThrow(/production/)
  })

  it('refuses production with the option when VERCEL_ENV is not production', async () => {
    for (const value of [undefined, '', 'preview', 'development']) {
      if (value === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = value
      await expect(assertNotProduction(fakeDb([row('production')]), { allowOnVercelProduction: true }), String(value)).rejects.toThrow(
        /production/,
      )
    }
  })

  it('still passes a non-production database with the option', async () => {
    await expect(assertNotProduction(fakeDb([row('nonprod')]), { allowOnVercelProduction: true })).resolves.toBeUndefined()
  })
})

describe('normalizeConnectionString', () => {
  it('returns a URL without sslmode unchanged (the CI container URL)', () => {
    const url = 'postgres://postgres:postgres@localhost:5432/postgres'
    expect(normalizeConnectionString(url)).toBe(url)
  })

  it('turns sslmode=require into verify-full', () => {
    expect(normalizeConnectionString('postgres://u:p@host.example/db?sslmode=require')).toBe('postgres://u:p@host.example/db?sslmode=verify-full')
    expect(normalizeConnectionString('postgres://u:p@host.example/db?sslmode=require&channel_binding=require')).toBe(
      'postgres://u:p@host.example/db?sslmode=verify-full&channel_binding=require',
    )
  })

  it('leaves an explicit verify-full alone', () => {
    const url = 'postgres://u:p@host.example/db?sslmode=verify-full'
    expect(normalizeConnectionString(url)).toBe(url)
  })
})
