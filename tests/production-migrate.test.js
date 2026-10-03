// The gate of the Vercel production build (productionBuildDecision, no database) and the production migration itself
// (migrateProduction) against a throwaway schema. The marker table the tests use lives INSIDE that schema
// (`<schema>.environment_marker`): public.environment_marker is the real marker of the non-production database, and no
// test creates, changes or drops it. The throwaway schema is reached through an `options=-c search_path=...` parameter
// of the connection string, which pg passes to the server as a startup option: migrateProduction needs no test-only
// argument for it, and the test exercises the same connection code that production uses.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setupDb } from './helpers.js'
import { productionBuildDecision, migrateProduction } from '../server/productionMigrate.js'
import { maskDatabaseHost } from '../server/dbGuard.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const PRODUCTION = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'master', VERCEL_GIT_COMMIT_SHA: SHA }

describe('productionBuildDecision', () => {
  it('migrates a production build of a commit on master from Git', () => {
    expect(productionBuildDecision(PRODUCTION)).toMatchObject({ action: 'migrate' })
    expect(productionBuildDecision(PRODUCTION).reason).toBeTruthy()
  })

  it('skips a build that is not a Vercel build (a local or CI build)', () => {
    expect(productionBuildDecision({})).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ CI: 'true' })).toMatchObject({ action: 'skip' })
  })

  it('skips VERCEL_ENV=production without VERCEL=1, because that is not a Vercel build', () => {
    const { VERCEL, ...withoutVercel } = PRODUCTION
    expect(VERCEL).toBe('1')
    expect(productionBuildDecision(withoutVercel)).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ ...PRODUCTION, VERCEL: 'true' })).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ ...PRODUCTION, VERCEL: '' })).toMatchObject({ action: 'skip' })
  })

  it('skips a preview and a development build, even from master with a full commit hash', () => {
    expect(productionBuildDecision({ ...PRODUCTION, VERCEL_ENV: 'preview' })).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ ...PRODUCTION, VERCEL_ENV: 'development' })).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ VERCEL: '1' })).toMatchObject({ action: 'skip' })
  })

  it('refuses a production build with no Git data', () => {
    const decision = productionBuildDecision({ VERCEL: '1', VERCEL_ENV: 'production' })
    expect(decision.action).toBe('refuse')
    expect(decision.reason).toMatch(/merge to master/)
    expect(decision.reason).toMatch(/Git integration/)
  })

  it('refuses a production build of another branch, or without a branch', () => {
    for (const ref of ['main', 'master-fix', 'refs/heads/master', 'Master', '', undefined]) {
      expect(productionBuildDecision({ ...PRODUCTION, VERCEL_GIT_COMMIT_REF: ref }).action, String(ref)).toBe('refuse')
    }
  })

  it('refuses a missing, empty, short, long, upper-case or non-hex commit hash', () => {
    const bad = ['', undefined, SHA.slice(0, 7), SHA + '0', SHA.toUpperCase(), 'g'.repeat(40), ' ' + SHA.slice(1)]
    for (const sha of bad) {
      expect(productionBuildDecision({ ...PRODUCTION, VERCEL_GIT_COMMIT_SHA: sha }).action, String(sha)).toBe('refuse')
    }
  })

  it('reads only the object it is given, never process.env', () => {
    const saved = Object.fromEntries(Object.keys(PRODUCTION).map((key) => [key, process.env[key]]))
    Object.assign(process.env, PRODUCTION)
    try {
      expect(productionBuildDecision({}).action).toBe('skip')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('migrateProduction refuses before it connects', () => {
  const markerTable = 't_never_connected.environment_marker'
  const quiet = { markerTable, dir: os.tmpdir(), log: () => {} }

  it('refuses a missing connection string', async () => {
    await expect(migrateProduction({ ...quiet, connectionString: undefined })).rejects.toThrow(/DATABASE_URL_UNPOOLED is not set/)
    await expect(migrateProduction({ ...quiet, connectionString: '' })).rejects.toThrow(/not set/)
  })

  it('refuses a pooled connection string, which cannot hold a session lock', async () => {
    const pooled = 'postgres://user:pass@ep-cool-123456-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'
    await expect(migrateProduction({ ...quiet, connectionString: pooled })).rejects.toThrow(/pooled host/)
  })

  it('refuses a value that is not a URL, without echoing it', async () => {
    for (const value of ['not a url', 'user:secret-word@host']) {
      const error = await migrateProduction({ ...quiet, connectionString: value }).catch((err) => err)
      expect(error.message).toMatch(/not a valid connection URL/)
      expect(error.message).not.toContain('secret-word')
    }
  })

  it('refuses a marker table name that is not schema.table before using it in SQL', async () => {
    const url = 'postgres://user:pass@localhost:5432/db'
    for (const name of ['environment_marker', 'public.environment_marker; drop table points', 'Public.Marker', 'a.b.c', '']) {
      await expect(migrateProduction({ ...quiet, connectionString: url, markerTable: name }), name).rejects.toThrow(/schema\.table/)
    }
  })
})

describe('migrateProduction against a throwaway schema', () => {
  let db
  let tmpDir
  let connectionString
  let markerTable
  let raw

  const write = (name, sql) => fs.writeFileSync(path.join(tmpDir, name), sql)
  const migrationRows = async () =>
    (await db.pool.query("select name from schema_migrations where name like 'pm\\_%' order by name")).rows.map((r) => r.name)
  const markerRows = async () => (await db.pool.query(`select environment from ${markerTable}`)).rows.map((r) => r.environment)
  const present = async (table) => (await db.pool.query('select to_regclass($1) is not null as present', [table])).rows[0].present
  const run = (extra = {}) => {
    const lines = []
    const promise = migrateProduction({ connectionString, markerTable, dir: tmpDir, log: (line) => lines.push(line), ...extra })
    return { lines, promise }
  }

  beforeAll(async () => {
    db = await setupDb()
    // The same URL that setupDb used, pointed at the throwaway schema.
    raw = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
    const options = encodeURIComponent(`-c search_path=${db.schema}`)
    connectionString = `${raw}${raw.includes('?') ? '&' : '?'}options=${options}`
    markerTable = `${db.schema}.environment_marker`
    // Never the real marker: the table is in the throwaway schema, and the schema name is the random one of setupDb.
    expect(db.schema).toMatch(/^t_[0-9a-f]+$/)
    expect(markerTable).not.toBe('public.environment_marker')
  })
  afterAll(async () => db?.teardown())

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-migrate-'))
    write('pm_001_first.sql', 'create table pm_first (id int primary key);')
    write('pm_002_second.sql', 'create table pm_second (id int primary key);')
    await db.pool.query(`drop table if exists pm_first, pm_second, pm_extra, ${markerTable}`)
    await db.pool.query("delete from schema_migrations where name like 'pm\\_%'")
  })
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('migrates an unmarked database and then marks it production', async () => {
    const { lines, promise } = run()
    await expect(promise).resolves.toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
    expect(await migrationRows()).toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
    // The throwaway schema was reached (the tables are in it), and the marker is in it too.
    expect(await present(`${db.schema}.pm_first`)).toBe(true)
    expect(await markerRows()).toEqual(['production'])
    expect(lines.join('\n')).toContain('Applied: pm_001_first.sql, pm_002_second.sql')
  })

  it('logs the masked host and never the connection string', async () => {
    const { lines, promise } = run()
    await promise
    const log = lines.join('\n')
    expect(log).toContain(`Production migration target: ${maskDatabaseHost(raw)}`)
    expect(log).not.toContain(raw)
    const { password, username } = new URL(raw)
    for (const secret of [password, username].filter(Boolean)) expect(log).not.toContain(secret)
  })

  it('applies nothing the second time and keeps a single marker row', async () => {
    await run().promise
    const { lines, promise } = run()
    await expect(promise).resolves.toEqual([])
    expect(await markerRows()).toEqual(['production'])
    expect(lines.join('\n')).toContain('Database is up to date.')
  })

  it('migrates a database that is already marked production and leaves the marker alone', async () => {
    await db.pool.query(`create table ${markerTable} (environment text primary key check (environment in ('production', 'nonprod')))`)
    await db.pool.query(`insert into ${markerTable} values ('production')`)
    await expect(run().promise).resolves.toHaveLength(2)
    expect(await markerRows()).toEqual(['production'])
  })

  it('marks a database whose marker table exists but has no row', async () => {
    await db.pool.query(`create table ${markerTable} (environment text primary key check (environment in ('production', 'nonprod')))`)
    await run().promise
    expect(await markerRows()).toEqual(['production'])
  })

  it('throws on a nonprod marker before it applies any migration', async () => {
    await db.pool.query(`create table ${markerTable} (environment text primary key check (environment in ('production', 'nonprod')))`)
    await db.pool.query(`insert into ${markerTable} values ('nonprod')`)
    await expect(run().promise).rejects.toThrow(/non-production database: check the Production environment variables in Vercel/)
    expect(await migrationRows()).toEqual([])
    expect(await present(`${db.schema}.pm_first`)).toBe(false)
    expect(await markerRows()).toEqual(['nonprod'])
  })

  it('does not mark the database when a migration fails, and says which one failed', async () => {
    write('pm_003_broken.sql', 'create table pm_extra (id int); select * from pm_does_not_exist;')
    await expect(run().promise).rejects.toThrow(/^Migration pm_003_broken\.sql failed: /)
    expect(await migrationRows()).toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
    expect(await present(`${db.schema}.pm_extra`)).toBe(false)
    expect(await present(markerTable)).toBe(false)
  })
})
