// The gate of the Vercel production build (productionBuildDecision, no database) and the production migration itself
// (migrateProduction) against a throwaway schema. The marker table the tests use lives INSIDE that schema
// (`<schema>.environment_marker`): public.environment_marker is the real marker of the non-production database, and no
// test creates, changes or drops it. The throwaway schema is reached through an `options=-c search_path=...` parameter
// of the connection string, which pg passes to the server as a startup option: migrateProduction needs no test-only
// argument for it, and the test exercises the same connection code that production uses.
// GitHub is never contacted: migrateProduction takes its `fetch` as a parameter, and the tests pass a stub that plays
// "master" from a table of files.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setupDb } from './helpers.js'
import { productionBuildDecision, migrateProduction } from '../server/productionMigrate.js'
import { maskDatabaseHost } from '../server/dbGuard.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const PRODUCTION = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_GIT_COMMIT_REF: 'master',
  VERCEL_GIT_COMMIT_SHA: SHA,
  VERCEL_GIT_REPO_OWNER: 'some-owner',
  VERCEL_GIT_REPO_SLUG: 'some-repo',
}
const without = (env, ...keys) => Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)))

describe('productionBuildDecision', () => {
  it('migrates a production build of a commit on master from Git', () => {
    expect(productionBuildDecision(PRODUCTION)).toMatchObject({ action: 'migrate' })
    expect(productionBuildDecision(PRODUCTION).reason).toBeTruthy()
  })

  it('skips a Vercel preview and a development build, whatever else is set', () => {
    expect(productionBuildDecision({ VERCEL_ENV: 'preview' })).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ VERCEL_ENV: 'development' })).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ ...PRODUCTION, VERCEL_ENV: 'preview' })).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ ...PRODUCTION, VERCEL_ENV: 'development' })).toMatchObject({ action: 'skip' })
    expect(productionBuildDecision({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'a-branch' }).action).toBe('skip')
  })

  it('refuses a build with no VERCEL_ENV at all: it fails closed, and says what to do', () => {
    for (const env of [{}, { CI: 'true' }, { VERCEL: '1' }, without(PRODUCTION, 'VERCEL_ENV')]) {
      const decision = productionBuildDecision(env)
      expect(decision.action, JSON.stringify(Object.keys(env))).toBe('refuse')
      expect(decision.reason).toMatch(/only Vercel's build command/)
      expect(decision.reason).toMatch(/npm run build/)
      expect(decision.reason).toMatch(/Automatically expose System Environment Variables/)
    }
  })

  it('refuses a VERCEL_ENV it does not know, in any spelling', () => {
    for (const value of ['', 'staging', 'Production', 'PRODUCTION', ' production', 'production ', 'prod', 'test']) {
      expect(productionBuildDecision({ ...PRODUCTION, VERCEL_ENV: value }).action, JSON.stringify(value)).toBe('refuse')
    }
  })

  it('refuses VERCEL_ENV=production without VERCEL=1', () => {
    expect(productionBuildDecision(without(PRODUCTION, 'VERCEL')).action).toBe('refuse')
    for (const value of ['true', '', '0', 'yes']) {
      expect(productionBuildDecision({ ...PRODUCTION, VERCEL: value }).action, value).toBe('refuse')
    }
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

  it('refuses a production build without the repository owner or name (the GitHub check needs them)', () => {
    for (const key of ['VERCEL_GIT_REPO_OWNER', 'VERCEL_GIT_REPO_SLUG']) {
      expect(productionBuildDecision(without(PRODUCTION, key)).action, key).toBe('refuse')
      expect(productionBuildDecision({ ...PRODUCTION, [key]: '' }).action, key + ' empty').toBe('refuse')
    }
  })

  it('reads only the object it is given, never process.env', () => {
    const saved = Object.fromEntries(Object.keys(PRODUCTION).map((key) => [key, process.env[key]]))
    Object.assign(process.env, PRODUCTION)
    try {
      expect(productionBuildDecision({}).action).toBe('refuse')
      expect(productionBuildDecision({ VERCEL_ENV: 'preview' }).action).toBe('skip')
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
  const repo = { repoOwner: 'some-owner', repoSlug: 'some-repo' }
  const quiet = { markerTable, dir: os.tmpdir(), log: () => {}, ...repo }
  const direct = 'postgres://user:pass@localhost:5432/db'

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
    for (const name of ['environment_marker', 'public.environment_marker; drop table points', 'Public.Marker', 'a.b.c', '']) {
      await expect(migrateProduction({ ...quiet, connectionString: direct, markerTable: name }), name).rejects.toThrow(/schema\.table/)
    }
  })

  it('refuses a missing or invalid GitHub owner or repository name, which would go into a URL', async () => {
    const bad = [
      {},
      { repoOwner: 'some-owner' },
      { repoSlug: 'some-repo' },
      { repoOwner: '', repoSlug: 'some-repo' },
      { repoOwner: 'some/owner', repoSlug: 'some-repo' },
      { repoOwner: 'some-owner', repoSlug: '../other' },
      { repoOwner: 'some-owner', repoSlug: '..' },
      { repoOwner: 'some-owner', repoSlug: 'repo?x=1' },
      { repoOwner: '-owner', repoSlug: 'some-repo' },
      { repoOwner: 'some-owner', repoSlug: 'a'.repeat(101) },
    ]
    for (const repoArgs of bad) {
      const error = await migrateProduction({ ...quiet, repoOwner: undefined, repoSlug: undefined, ...repoArgs, connectionString: direct }).catch((err) => err)
      expect(error.message, JSON.stringify(repoArgs)).toMatch(/VERCEL_GIT_REPO_OWNER and VERCEL_GIT_REPO_SLUG/)
    }
  })
})

describe('migrateProduction against a throwaway schema', () => {
  const TOKEN = 'ghp_test_token_that_must_never_be_logged'
  let db
  let tmpDir
  let connectionString
  let markerTable
  let raw
  let master // the files "on GitHub master": name -> Buffer
  let calls // what the stub was asked: [{ url, headers }]

  const write = (name, sql) => fs.writeFileSync(path.join(tmpDir, name), sql)
  const publish = (...names) => names.forEach((name) => (master[name] = fs.readFileSync(path.join(tmpDir, name))))
  const migrationRows = async () =>
    (await db.pool.query("select name from schema_migrations where name like 'pm\\_%' order by name")).rows.map((r) => r.name)
  const markerRows = async () => (await db.pool.query(`select environment from ${markerTable}`)).rows.map((r) => r.environment)
  const present = async (table) => (await db.pool.query('select to_regclass($1) is not null as present', [table])).rows[0].present
  const rawUrl = (name) => `https://raw.githubusercontent.com/test-owner/test-repo/refs/heads/master/db/migrations/${name}`

  /** A fetch that plays GitHub master: 200 with the bytes of the file in `master`, else 404. It records every call. */
  const stubFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const name = decodeURIComponent(url.split('/').pop())
    return name in master ? new Response(master[name], { status: 200 }) : new Response('not found', { status: 404 })
  }
  const run = (extra = {}) => {
    const lines = []
    const promise = migrateProduction({
      connectionString,
      markerTable,
      dir: tmpDir,
      log: (line) => lines.push(line),
      repoOwner: 'test-owner',
      repoSlug: 'test-repo',
      fetch: stubFetch,
      retryDelaysMs: [1, 1],
      ...extra,
    })
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
    master = {}
    publish('pm_001_first.sql', 'pm_002_second.sql')
    calls = []
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

  it('applies nothing the second time, keeps a single marker row, and makes no network call at all', async () => {
    await run().promise
    calls = []
    const { lines, promise } = run({
      fetch: async () => {
        throw new Error('GitHub must not be contacted when nothing is pending')
      },
    })
    await expect(promise).resolves.toEqual([])
    expect(calls).toEqual([])
    expect(await markerRows()).toEqual(['production'])
    expect(lines.join('\n')).toContain('Database is up to date.')
    expect(lines.join('\n')).not.toContain('verified against GitHub master')
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

  it('throws on a nonprod marker before it applies any migration and before it asks GitHub anything', async () => {
    await db.pool.query(`create table ${markerTable} (environment text primary key check (environment in ('production', 'nonprod')))`)
    await db.pool.query(`insert into ${markerTable} values ('nonprod')`)
    await expect(run().promise).rejects.toThrow(/non-production database: check the Production environment variables in Vercel/)
    expect(await migrationRows()).toEqual([])
    expect(await present(`${db.schema}.pm_first`)).toBe(false)
    expect(await markerRows()).toEqual(['nonprod'])
    expect(calls).toEqual([])
  })

  it('does not mark the database when a migration fails, and says which one failed', async () => {
    write('pm_003_broken.sql', 'create table pm_extra (id int); select * from pm_does_not_exist;')
    publish('pm_003_broken.sql')
    await expect(run().promise).rejects.toThrow(/^Migration pm_003_broken\.sql failed: /)
    expect(await migrationRows()).toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
    expect(await present(`${db.schema}.pm_extra`)).toBe(false)
    expect(await present(markerTable)).toBe(false)
  })

  describe('only migrations that are on GitHub master are applied', () => {
    it('applies pending files that are byte-identical on master, and says so for each one', async () => {
      const { lines, promise } = run()
      await expect(promise).resolves.toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
      expect(calls.map((call) => call.url)).toEqual([rawUrl('pm_001_first.sql'), rawUrl('pm_002_second.sql')])
      const log = lines.join('\n')
      expect(log).toContain('Migration pm_001_first.sql: verified against GitHub master')
      expect(log).toContain('Migration pm_002_second.sql: verified against GitHub master')
    })

    it('asks only about the files that are pending', async () => {
      await run().promise
      write('pm_003_third.sql', 'create table pm_extra (id int primary key);')
      publish('pm_003_third.sql')
      calls = []
      await expect(run().promise).resolves.toEqual(['pm_003_third.sql'])
      expect(calls.map((call) => call.url)).toEqual([rawUrl('pm_003_third.sql')])
    })

    it('throws before any migration is applied when a pending file differs from master', async () => {
      master['pm_002_second.sql'] = Buffer.from('create table pm_second (id int primary key, sneaky int);')
      const { promise } = run()
      await expect(promise).rejects.toThrow(/^Migration pm_002_second\.sql differs from the file on GitHub master/)
      // Nothing was applied, not even the first file that matched, and the database was not marked.
      expect(await migrationRows()).toEqual([])
      expect(await present(`${db.schema}.pm_first`)).toBe(false)
      expect(await present(markerTable)).toBe(false)
    })

    it('does not retry a difference: it is final', async () => {
      master['pm_001_first.sql'] = Buffer.from('create table pm_first (id int);')
      await expect(run({ retryDelaysMs: [1, 1, 1, 1] }).promise).rejects.toThrow(/differs from the file on GitHub master/)
      expect(calls).toHaveLength(1)
    })

    it('compares the bytes exactly: a CRLF copy is not the same file', async () => {
      write('pm_001_first.sql', 'create table pm_first (\n  id int primary key\n);\n')
      master['pm_001_first.sql'] = Buffer.from('create table pm_first (\r\n  id int primary key\r\n);\r\n')
      await expect(run().promise).rejects.toThrow(/^Migration pm_001_first\.sql differs from the file on GitHub master/)
      expect(await migrationRows()).toEqual([])
    })

    it('throws when a file is not on master at all, after it retried', async () => {
      delete master['pm_002_second.sql']
      const { lines, promise } = run({ retryDelaysMs: [1, 1] })
      await expect(promise).rejects.toThrow(/^Migration pm_002_second\.sql could not be read from GitHub master after 3 tries \(HTTP 404\)/)
      expect(calls.filter((call) => call.url === rawUrl('pm_002_second.sql'))).toHaveLength(3)
      expect(await migrationRows()).toEqual([])
      expect(await present(`${db.schema}.pm_first`)).toBe(false)
      expect(lines.join('\n')).not.toContain('Applied:')
    })

    it('succeeds when a 404 is followed by the file (the raw CDN can be stale for a moment after a merge)', async () => {
      let first = true
      const flaky = async (url, init) => {
        if (first && url.endsWith('pm_001_first.sql')) {
          first = false
          calls.push({ url, headers: init?.headers ?? {} })
          return new Response('not found', { status: 404 })
        }
        return stubFetch(url, init)
      }
      await expect(run({ fetch: flaky }).promise).resolves.toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
      expect(calls.filter((call) => call.url === rawUrl('pm_001_first.sql'))).toHaveLength(2)
    })

    it('retries a network error, and a server error, before it gives up', async () => {
      let failures = 0
      const shaky = async (url, init) => {
        if (failures < 2) {
          failures++
          if (failures === 1) throw new TypeError('fetch failed')
          return new Response('', { status: 503 })
        }
        return stubFetch(url, init)
      }
      await expect(run({ fetch: shaky, retryDelaysMs: [1, 1, 1] }).promise).resolves.toHaveLength(2)

      await db.pool.query(`drop table if exists pm_first, pm_second, ${markerTable}`)
      await db.pool.query("delete from schema_migrations where name like 'pm\\_%'")
      const down = async () => {
        throw new TypeError('fetch failed')
      }
      await expect(run({ fetch: down, retryDelaysMs: [1, 1] }).promise).rejects.toThrow(/could not be read from GitHub master after 3 tries \(network error\)/)
      expect(await migrationRows()).toEqual([])
    })

    it('does not retry a refused token (401 or 403), and points at MIGRATION_GITHUB_TOKEN', async () => {
      for (const status of [401, 403]) {
        calls = []
        const refused = async (url, init) => {
          calls.push({ url, headers: init?.headers ?? {} })
          return new Response('', { status })
        }
        await expect(run({ fetch: refused, retryDelaysMs: [1, 1, 1] }).promise).rejects.toThrow(
          new RegExp(`GitHub refused to give migration pm_001_first.sql \\(HTTP ${status}\\): check MIGRATION_GITHUB_TOKEN`),
        )
        expect(calls).toHaveLength(1)
      }
      expect(await migrationRows()).toEqual([])
    })

    it('sends the token as a Bearer header when given, and never logs it or puts it in an error', async () => {
      const { lines, promise } = run({ githubToken: TOKEN })
      await promise
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.headers).toEqual({ Authorization: `Bearer ${TOKEN}` })
      expect(lines.join('\n')).not.toContain(TOKEN)

      // And on a failure: a missing file with the token set.
      await db.pool.query(`drop table if exists pm_first, pm_second, ${markerTable}`)
      await db.pool.query("delete from schema_migrations where name like 'pm\\_%'")
      delete master['pm_001_first.sql']
      const failing = run({ githubToken: TOKEN })
      const error = await failing.promise.catch((err) => err)
      expect(error.message).toMatch(/could not be read from GitHub master/)
      expect(error.message).not.toContain(TOKEN)
      expect(failing.lines.join('\n')).not.toContain(TOKEN)
    })

    it('sends no Authorization header when there is no token', async () => {
      await run().promise
      for (const call of calls) expect(call.headers).toEqual({})
    })
  })
})
