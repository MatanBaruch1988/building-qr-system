// readEnvironmentMarker and assertNotProduction against fake `query` objects (no database), the host masking that
// create-admin prints, and the connection-string normalizer that decides how the tooling reaches the database.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertNotProduction, maskDatabaseHost, readEnvironmentMarker } from '../server/dbGuard.js'
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
const VERCEL_KEYS = ['VERCEL_ENV', 'VERCEL']
let savedVercel

beforeEach(() => {
  savedVercel = Object.fromEntries(VERCEL_KEYS.map((key) => [key, process.env[key]]))
  for (const key of VERCEL_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of VERCEL_KEYS) {
    if (savedVercel[key] === undefined) delete process.env[key]
    else process.env[key] = savedVercel[key]
  }
})

describe('readEnvironmentMarker', () => {
  it('returns production, nonprod or null', async () => {
    await expect(readEnvironmentMarker(fakeDb([row('production')]))).resolves.toBe('production')
    await expect(readEnvironmentMarker(fakeDb([row('nonprod')]))).resolves.toBe('nonprod')
  })

  it('returns null when the table is missing, without reading it', async () => {
    const db = fakeDb(null)
    await expect(readEnvironmentMarker(db)).resolves.toBeNull()
    expect(db.sent).toHaveLength(1)
  })

  it('returns null when the table has no row, or a value it does not know', async () => {
    await expect(readEnvironmentMarker(fakeDb([]))).resolves.toBeNull()
    await expect(readEnvironmentMarker(fakeDb([row('staging')]))).resolves.toBeNull()
  })

  it('lets production win when there are several rows, in any order', async () => {
    await expect(readEnvironmentMarker(fakeDb([row('nonprod'), row('production')]))).resolves.toBe('production')
    await expect(readEnvironmentMarker(fakeDb([row('production'), row('nonprod')]))).resolves.toBe('production')
  })

  it('ignores case and surrounding spaces in the stored value', async () => {
    await expect(readEnvironmentMarker(fakeDb([row(' Production ')]))).resolves.toBe('production')
    await expect(readEnvironmentMarker(fakeDb([row('NONPROD')]))).resolves.toBe('nonprod')
  })

  it('reads the schema-qualified table, so a search_path cannot hide it', async () => {
    const db = fakeDb([row('nonprod')])
    await readEnvironmentMarker(db)
    expect(db.sent).toHaveLength(2)
    for (const text of db.sent) expect(text).toContain('public.environment_marker')
  })

  it('lets a failing database query through as an error', async () => {
    const db = { query: async () => Promise.reject(new Error('connection refused')) }
    await expect(readEnvironmentMarker(db)).rejects.toThrow('connection refused')
  })
})

describe('maskDatabaseHost', () => {
  it('keeps 6 characters of the first label, masks the rest of it and keeps the domain', () => {
    expect(maskDatabaseHost('postgres://u:secret@ep-wit-cool-123456-pooler.eu-central-1.aws.neon.tech/db?sslmode=require')).toBe(
      'ep-wit****.eu-central-1.aws.neon.tech',
    )
  })

  it('never prints the user, the password, the path or the query', () => {
    const masked = maskDatabaseHost('postgres://someuser:s3cr3t-pass@ep-wit-cool-123456.eu-central-1.aws.neon.tech:5432/neondb?sslmode=require')
    for (const secret of ['someuser', 's3cr3t', 'neondb', 'sslmode', '5432', 'postgres://']) expect(masked).not.toContain(secret)
  })

  it('handles a host without a domain and a short label', () => {
    expect(maskDatabaseHost('postgres://postgres:postgres@localhost:5432/postgres')).toBe('localh****')
    expect(maskDatabaseHost('postgres://u:p@db.example.com/x')).toBe('db****.example.com')
  })

  it('says unknown host for anything that is not a URL, without echoing it', () => {
    for (const value of [undefined, '', 'not a url', 'user:secret@host']) expect(maskDatabaseHost(value)).toBe('unknown host')
  })
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

describe('assertNotProduction ignores the environment variables', () => {
  it('refuses production when VERCEL_ENV=production', async () => {
    process.env.VERCEL_ENV = 'production'
    await expect(assertNotProduction(fakeDb([row('production')]))).rejects.toThrow(/this database is production/i)
  })

  it('refuses production when VERCEL=1 and VERCEL_ENV=production (what a local `vercel build --prod` sets)', async () => {
    process.env.VERCEL = '1'
    process.env.VERCEL_ENV = 'production'
    await expect(assertNotProduction(fakeDb([row('production')]))).rejects.toThrow(/this database is production/i)
  })

  it('refuses production whatever VERCEL_ENV and VERCEL hold', async () => {
    for (const value of [undefined, '', 'preview', 'development', 'production']) {
      if (value === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = value
      process.env.VERCEL = '1'
      await expect(assertNotProduction(fakeDb([row('production')])), String(value)).rejects.toThrow(/production/)
    }
  })

  it('has no option that lets production through: a second argument changes nothing', async () => {
    process.env.VERCEL_ENV = 'production'
    await expect(assertNotProduction(fakeDb([row('production')]), { allowOnVercelProduction: true })).rejects.toThrow(/production/)
  })

  it('still passes a non-production database when VERCEL_ENV=production', async () => {
    process.env.VERCEL_ENV = 'production'
    await expect(assertNotProduction(fakeDb([row('nonprod')]))).resolves.toBeUndefined()
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

describe('a marker table of its own (the tests and the production migration pass one)', () => {
  const table = 't_0a1b2c.environment_marker'

  it('reads the table it is given, and not the default one', async () => {
    const db = fakeDb([row('production')])
    await expect(readEnvironmentMarker(db, table)).resolves.toBe('production')
    expect(db.sent).toHaveLength(2)
    for (const text of db.sent) {
      expect(text).toContain(table)
      expect(text).not.toContain('public.environment_marker')
    }
  })

  it('still refuses a production row in that table, and passes a nonprod or missing one', async () => {
    await expect(assertNotProduction(fakeDb([row('production')]), table)).rejects.toThrow(/this database is production/i)
    await expect(assertNotProduction(fakeDb([row('nonprod')]), table)).resolves.toBeUndefined()
    await expect(assertNotProduction(fakeDb(null), table)).resolves.toBeUndefined()
  })

  it('refuses a table name that is not a plain schema.table, before any SQL is sent', async () => {
    const bad = ['environment_marker', 'public.environment_marker; drop table points', "x.y') or true --", 'Public.Marker', 'a.b.c', '', null, {}]
    for (const name of bad) {
      const db = fakeDb([row('nonprod')])
      await expect(readEnvironmentMarker(db, name), String(name)).rejects.toThrow(/schema\.table/)
      await expect(assertNotProduction(db, name), String(name)).rejects.toThrow(/schema\.table/)
      expect(db.sent).toHaveLength(0)
    }
  })

  it('uses the default table when no name is given', async () => {
    const db = fakeDb([row('nonprod')])
    await readEnvironmentMarker(db)
    await readEnvironmentMarker(db, undefined)
    for (const text of db.sent) expect(text).toContain('public.environment_marker')
  })
})
