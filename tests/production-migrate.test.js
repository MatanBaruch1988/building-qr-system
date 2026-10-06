// The gate of the Vercel production build (productionBuildDecision, no database) and the production migration itself
// (migrateProduction) against a throwaway schema. The marker table the tests use lives INSIDE that schema
// (`<schema>.environment_marker`): public.environment_marker is the real marker of the non-production database, and no
// test creates, changes or drops it. The throwaway schema is reached through an `options=-c search_path=...` parameter
// of the connection string, which pg passes to the server as a startup option: migrateProduction needs no test-only
// argument for it, and the test exercises the same connection code that production uses.
// GitHub is never contacted: migrateProduction takes its `fetch` as a parameter, and the tests pass a stub that plays
// GitHub: the discovery that names the default branch (git's smart HTTP, answered from tests/fixtures/github-info-refs.js,
// a real answer) and the raw migration files of that branch, from a table of files.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { setupDb } from './helpers.js'
import { REAL_ADVERTISEMENT, REAL_ADVERTISEMENT_LINES } from './fixtures/github-info-refs.js'
import { productionBuildDecision, migrateProduction, buildFailureText } from '../server/productionMigrate.js'
import { maskDatabaseHost } from '../server/dbGuard.js'
import { MigrationError } from '../server/migrate.js'
import { SafeMessageError } from '../server/logSafe.js'

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
// A value that looks personal, to see that a failed production build never prints it. Fake data only.
const PERSONAL = 'someone@example.com'

// ---- GitHub, as the stubs play it ------------------------------------------------------------------------------------

const DISCOVERY_URL = 'https://github.com/test-owner/test-repo.git/info/refs?service=git-upload-pack'
const isDiscovery = (url) => url.includes('/info/refs?service=git-upload-pack')
const rawUrlOn = (branch, name) => `https://raw.githubusercontent.com/test-owner/test-repo/refs/heads/${branch}/db/migrations/${name}`

/** One pkt-line of git's wire format: four hex digits that count themselves, then the payload. */
const pkt = (payload) => (Buffer.byteLength(payload) + 4).toString(16).padStart(4, '0') + payload
// The pieces of the real answer (tests/fixtures/github-info-refs.js): the two lines before the first reference, the HEAD line
// without its length prefix, one more branch, and the commit that the real master was at.
const [SERVICE_LINE, FLUSH, REAL_HEAD_LINE, OTHER_BRANCH_LINE, REAL_MASTER_LINE] = REAL_ADVERTISEMENT_LINES
const REAL_HEAD = REAL_HEAD_LINE.slice(4)
const OID = REAL_MASTER_LINE.slice(4, 44)
/** The real answer, with HEAD (the symref and the branch list) pointing at `branch`. For `master` it is the real answer. */
const advertisement = (branch) =>
  SERVICE_LINE +
  FLUSH +
  pkt(REAL_HEAD.replace('symref=HEAD:refs/heads/master', `symref=HEAD:refs/heads/${branch}`)) +
  OTHER_BRANCH_LINE +
  pkt(`${OID} refs/heads/${branch}\n`) +
  '0000'
/** The real answer with the capability list of the HEAD line replaced by `capabilities`. */
const advertisementWith = (capabilities) => SERVICE_LINE + FLUSH + pkt(`${OID} HEAD\0${capabilities}\n`) + '0000'
const answer = (body, status = 200) => new Response(body, { status })
/** A 200 answer whose body arrives in chunks of `size` bytes. */
const chunked = (text, size) => {
  const bytes = Buffer.from(text)
  let at = 0
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (at >= bytes.length) return controller.close()
        controller.enqueue(bytes.subarray(at, at + size))
        at += size
      },
    }),
    { status: 200 },
  )
}

/**
 * Runs `action` and says what it did to the database: how often a pool connected or ran a statement meanwhile (every
 * statement of a pool goes through one of the two), with the outcome of `action`, which is never thrown.
 */
async function withPoolSpied(action) {
  const connect = vi.spyOn(pg.Pool.prototype, 'connect')
  const query = vi.spyOn(pg.Pool.prototype, 'query')
  try {
    const outcome = await action().then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    return { ...outcome, connects: connect.mock.calls.length, queries: query.mock.calls.length }
  } finally {
    connect.mockRestore()
    query.mockRestore()
  }
}

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
    expect(decision.reason).toMatch(/merge to the production branch/)
    expect(decision.reason).toMatch(/Git integration/)
  })

  it('refuses a production build without a branch', () => {
    for (const ref of ['', undefined]) {
      expect(productionBuildDecision({ ...PRODUCTION, VERCEL_GIT_COMMIT_REF: ref }).action, String(ref)).toBe('refuse')
    }
  })

  // The refusal of another branch used to be decided here, with the branch written in the code. It is decided in
  // migrateProduction now, from the default branch that GitHub reports: see 'refuses a production build of any branch but
  // the default branch' below, which keeps the branches that were listed here (main, master-fix, refs/heads/master,
  // Master).
  it('does not decide which branch is the production branch: only GitHub knows it', () => {
    for (const ref of ['master', 'main', 'release/2026', 'master-fix']) {
      expect(productionBuildDecision({ ...PRODUCTION, VERCEL_GIT_COMMIT_REF: ref }).action, ref).toBe('migrate')
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

describe('buildFailureText: what the production build prints when the migration fails', () => {
  /** A pg-like error with a personal-looking value in its message and in every field that a Postgres error has. */
  const databaseError = (code = '23505') =>
    Object.assign(new Error(`duplicate key value violates unique constraint (${PERSONAL})`), {
      code,
      detail: `Key (email)=(${PERSONAL}) already exists.`,
      where: `SQL statement "insert ... '${PERSONAL}'"`,
      table: PERSONAL,
      column: PERSONAL,
      parameters: [PERSONAL],
    })

  it('prints a MigrationError as its message: the file and the SQLSTATE with its name', () => {
    const text = buildFailureText(new MigrationError('012_x.sql', databaseError()))
    expect(text).toBe('Migration 012_x.sql failed: 23505 (unique_violation)')
  })

  it('prints a database error as its code and never its message or any other field', () => {
    const text = buildFailureText(databaseError())
    expect(text).toBe('23505')
    expect(text).not.toContain(PERSONAL)
    expect(buildFailureText(databaseError('XX000'))).toBe('XX000')
  })

  it('prints an error with no code as its name, and anything that is not an Error as its type', () => {
    expect(buildFailureText(new Error(`password authentication failed for user "${PERSONAL}"`))).toBe('Error')
    expect(buildFailureText(new TypeError(PERSONAL))).toBe('TypeError')
    expect(buildFailureText(Object.assign(new Error(PERSONAL), { code: 'ENOTFOUND' }))).toBe('ENOTFOUND')
    expect(buildFailureText(PERSONAL)).toBe('thrown string')
    expect(buildFailureText({ message: PERSONAL })).toBe('thrown object')
    expect(buildFailureText(undefined)).toBe('thrown undefined')
  })

  it('trusts the class and nothing else: an error that only looks like ours is printed as its code', () => {
    const lookalike = Object.assign(new Error(`Migration x.sql failed: ${PERSONAL}`), {
      name: 'MigrationError',
      file: 'x.sql',
      code: '23505',
    })
    expect(buildFailureText(lookalike)).toBe('23505')
    expect(buildFailureText(Object.assign(new Error(PERSONAL), { name: 'SafeMessageError' }))).toBe('SafeMessageError')
  })

  it('prints an error of ours on one line of bounded length', () => {
    expect(buildFailureText(new SafeMessageError('first\n  second'))).toBe('first second')
    expect(buildFailureText(new SafeMessageError('x'.repeat(2000)))).toHaveLength(500)
  })

  it("prints the gate's own refusals as their message, so that the owner still reads what to fix", async () => {
    const quiet = { markerTable: 't_never_connected.environment_marker', dir: os.tmpdir(), log: () => {} }
    const repo = { repoOwner: 'some-owner', repoSlug: 'some-repo' }
    const pooled = 'postgres://user:pass@ep-cool-123456-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'
    const failures = [
      await migrateProduction({ ...quiet, ...repo, connectionString: undefined }).catch((e) => e),
      await migrateProduction({ ...quiet, ...repo, connectionString: pooled }).catch((e) => e),
      await migrateProduction({ ...quiet, ...repo, connectionString: 'not a url' }).catch((e) => e),
      await migrateProduction({ ...quiet, connectionString: 'postgres://user:pass@localhost:5432/db' }).catch((e) => e),
    ]
    const expected = [/DATABASE_URL_UNPOOLED is not set/, /pooled host/, /not a valid connection URL/, /VERCEL_GIT_REPO_OWNER/]
    failures.forEach((err, i) => {
      expect(err, String(i)).toBeInstanceOf(SafeMessageError)
      expect(buildFailureText(err), String(i)).toBe(err.message)
      expect(buildFailureText(err), String(i)).toMatch(expected[i])
    })
    expect(buildFailureText(failures[1])).not.toContain('ep-cool-123456')
  })
})

describe('scripts/vercel-build.mjs', () => {
  // The script runs the whole build when it is imported, so it cannot be loaded in a test: the one line that matters is read.
  it('prints a failed migration only through buildFailureText, never through a message', () => {
    const source = fs.readFileSync(new URL('../scripts/vercel-build.mjs', import.meta.url), 'utf8')
    expect(source).toContain('Production migration failed: ${buildFailureText(err)}')
    expect(source).not.toMatch(/\berr(?:or)?\.message\b/)
    expect(source).not.toMatch(/\.stack\b/)
  })

  it('hands the branch of the commit to migrateProduction, which compares it with the default branch on GitHub', () => {
    const source = fs.readFileSync(new URL('../scripts/vercel-build.mjs', import.meta.url), 'utf8')
    expect(source).toContain('commitRef: env.VERCEL_GIT_COMMIT_REF')
  })

  // The rule (AGENTS.md): the production branch is the default branch as GitHub reports it, never an environment variable,
  // a file of the build or a name written in the code. A branch name in the code of the gate is what this looks for.
  it('has no branch name in the code of the gate, and the gate does not read the environment itself', () => {
    const code = (file) =>
      fs
        .readFileSync(new URL(file, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
    for (const file of ['../server/productionMigrate.js', '../scripts/vercel-build.mjs']) {
      expect(code(file), file).not.toMatch(/\b(?:master|main)\b/)
    }
    expect(code('../server/productionMigrate.js')).not.toMatch(/process\.env/)
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

// The production branch is the default branch of the repository, as GitHub reports it during the build. None of these tests
// has a database: the connection string points at a port where nothing listens, so a connection that was tried would fail
// with ECONNREFUSED, and the pool is spied on, so that "no statement" is counted and not guessed.
describe('migrateProduction: the production branch is the default branch of the repository on GitHub', () => {
  const TOKEN = 'ghp_test_token_that_must_never_be_logged'
  const unreachable = 'postgresql://user:pass@127.0.0.1:1/none'
  let discoveries // what the stub was asked for the default branch: [{ url, headers }]
  let files // what the stub was asked for a migration file
  const github = (discover) => async (url, init) => {
    const call = { url, headers: init?.headers ?? {} }
    if (isDiscovery(url)) {
      discoveries.push(call)
      return discover(url, init, discoveries.length)
    }
    files.push(call)
    return answer('not found', 404)
  }
  /** migrateProduction against the stub, spied on the pool. `defaultBranch` is what GitHub says; the rest overrides the options. */
  const run = ({ defaultBranch = 'master', discover = () => answer(advertisement(defaultBranch)), ...extra } = {}) => {
    const lines = []
    const outcome = withPoolSpied(() =>
      migrateProduction({
        connectionString: unreachable,
        markerTable: 't_never_connected.environment_marker',
        dir: os.tmpdir(),
        log: (line) => lines.push(line),
        repoOwner: 'test-owner',
        repoSlug: 'test-repo',
        commitRef: 'master',
        fetch: github(discover),
        retryDelaysMs: [1, 1],
        ...extra,
      }),
    )
    return outcome.then((result) => ({ ...result, lines }))
  }
  const untouched = (result) => {
    expect(result.connects, 'connections').toBe(0)
    expect(result.queries, 'statements').toBe(0)
    expect(files, 'migration files asked for').toEqual([])
  }
  const refusalOf = (result) => {
    expect(result.error).toBeInstanceOf(SafeMessageError)
    expect(buildFailureText(result.error)).toBe(result.error.message)
    return result.error.message
  }
  const REASONS_TO_READ = 'The default branch of test-owner/test-repo could not be read from GitHub'

  beforeEach(() => {
    discoveries = []
    files = []
  })

  it('reads the real answer of GitHub: the fixture is as GitHub sent it, and its default branch is the one it names', async () => {
    // Every pkt-line of the capture still has its own length prefix, so a trim that cut a line would show here.
    let offset = 0
    const lengths = []
    while (offset < REAL_ADVERTISEMENT.length) {
      const length = parseInt(REAL_ADVERTISEMENT.slice(offset, offset + 4), 16)
      lengths.push(length)
      offset += length === 0 ? 4 : length
    }
    expect(offset).toBe(REAL_ADVERTISEMENT.length)
    expect(lengths).toEqual([0x1e, 0, 0x15b, 0x49, 0x3f, 0])
    expect(REAL_ADVERTISEMENT).toContain('symref=HEAD:refs/heads/master')
    // The generator of the other answers reproduces the real one exactly when it is asked for master.
    expect(advertisement('master')).toBe(REAL_ADVERTISEMENT)

    const result = await run({ discover: () => answer(REAL_ADVERTISEMENT) })
    // The branch check passed, so the first thing that failed is the connection to the database that is not there.
    expect(buildFailureText(result.error)).toBe('ECONNREFUSED')
    expect(result.lines).toContain('Production branch: master (the default branch on GitHub)')
  })

  it('asks GitHub with git\'s discovery request, and sends nothing that is not needed (no token, no protocol version)', async () => {
    await run()
    expect(discoveries).toEqual([{ url: DISCOVERY_URL, headers: {} }])
    expect(discoveries[0].url).not.toContain('api.github.com')
    // Protocol version 2 would answer without the symref that names the branch.
    expect(JSON.stringify(discoveries[0].headers).toLowerCase()).not.toContain('git-protocol')
  })

  it('logs the production branch once, in one line', async () => {
    const result = await run({ defaultBranch: 'main', commitRef: 'main' })
    expect(result.lines.filter((line) => line.startsWith('Production branch:'))).toEqual([
      'Production branch: main (the default branch on GitHub)',
    ])
  })

  it('goes on to the database when the default branch is main and the build is of main', async () => {
    const result = await run({ defaultBranch: 'main', commitRef: 'main' })
    expect(buildFailureText(result.error)).toBe('ECONNREFUSED')
    expect(result.error).not.toBeInstanceOf(SafeMessageError)
  })

  it('accepts a default branch with a slash, a dot or an underscore, and one of 100 characters', async () => {
    for (const name of ['release/2026', 'v1.2', '_work', 'a.b-c_d/e', 'x'.repeat(100)]) {
      const result = await run({ defaultBranch: name, commitRef: name })
      expect(buildFailureText(result.error), name).toBe('ECONNREFUSED')
    }
  })

  it('refuses a production build of any branch but the default branch, and says both', async () => {
    const cases = [
      // The branches that the gate refused when the branch was written in the code, with master as the default branch.
      ...['main', 'master-fix', 'refs/heads/master', 'Master'].map((commitRef) => ({ defaultBranch: 'master', commitRef })),
      // And the other way round: main is the default branch (a copy), master is not production.
      { defaultBranch: 'main', commitRef: 'master' },
      { defaultBranch: 'main', commitRef: 'Main' },
      { defaultBranch: 'main', commitRef: 'refs/heads/main' },
      { defaultBranch: 'release/2026', commitRef: 'release' },
      { defaultBranch: 'release', commitRef: 'release/2026' },
      // A branch of the build that is not a plain name is refused too, and is not printed (see the next but one test).
      { defaultBranch: 'main', commitRef: 'main ', shown: '(not a plain branch name)' },
      { defaultBranch: 'main', commitRef: 'main/', shown: '(not a plain branch name)' },
    ]
    for (const { defaultBranch, commitRef, shown = commitRef } of cases) {
      discoveries = []
      const result = await run({ defaultBranch, commitRef })
      const label = `${defaultBranch} vs ${commitRef}`
      const message = refusalOf(result)
      expect(message, label).toContain(`production branch of test-owner/test-repo is its default branch on GitHub, ${defaultBranch}`)
      expect(message, label).toContain(`build is of the branch ${shown},`)
      expect(message, label).toContain(`only from a merge to ${defaultBranch}`)
      untouched(result)
      expect(discoveries, label).toHaveLength(1)
    }
  })

  it('refuses a build whose commit has no branch, before it asks GitHub or the database anything', async () => {
    for (const commitRef of ['', undefined, null]) {
      const result = await run({ commitRef })
      expect(refusalOf(result), String(commitRef)).toMatch(/VERCEL_GIT_COMMIT_REF/)
      untouched(result)
      expect(discoveries).toEqual([])
    }
  })

  it('does not print a branch of the build that is not a plain branch name', async () => {
    const result = await run({ commitRef: `feature ${PERSONAL};drop` })
    const message = refusalOf(result)
    expect(message).toContain('build is of the branch (not a plain branch name)')
    expect(message).not.toContain(PERSONAL)
    untouched(result)
  })

  describe('when GitHub does not say what the default branch is, the build is refused and the database is never touched', () => {
    const expectRefused = (result, pattern) => {
      expect(refusalOf(result)).toMatch(pattern)
      untouched(result)
    }

    it('refuses an answer that is missing, empty or not a reference list', async () => {
      const bodies = {
        'an empty answer': () => answer(''),
        'a web page': () => answer('<!doctype html><title>GitHub</title><p>Not Found</p>'),
        'a JSON body': () => answer('{"message":"Not Found"}'),
        'a length that is not hex': () => answer('zzzz# service=git-upload-pack\n0000'),
        'a different service': () => answer(pkt('# service=git-receive-pack\n') + FLUSH + REAL_HEAD_LINE),
        'a flush instead of the service line': () => answer(FLUSH + REAL_HEAD_LINE),
        'no flush after the service line': () => answer(SERVICE_LINE + REAL_HEAD_LINE),
        'a length that is more than git allows': () => answer(SERVICE_LINE + FLUSH + 'ffff' + 'x'.repeat(100)),
        'a line shorter than its own length prefix': () => answer(SERVICE_LINE + FLUSH + '0003'),
        'the answer cut in the middle of a line': () => answer(REAL_ADVERTISEMENT.slice(0, 120)),
        'the answer cut before the first reference': () => answer(SERVICE_LINE + FLUSH),
        'no references at all': () => answer(SERVICE_LINE + FLUSH + '0000'),
      }
      for (const [name, discover] of Object.entries(bodies)) {
        discoveries = []
        const result = await run({ discover })
        expectRefused(result, new RegExp(`^${REASONS_TO_READ}: the answer `))
        // A malformed answer is final: it is not asked for again.
        expect(discoveries, name).toHaveLength(1)
      }
    })

    it('refuses an answer without a symref for HEAD: protocol version 2, an empty repository, a symref of another name', async () => {
      const bodies = {
        'protocol version 2': () => answer(SERVICE_LINE + FLUSH + pkt('version 2\n') + pkt('agent=git/github-x\n') + pkt('ls-refs=unborn\n') + '0000'),
        'an empty repository': () => answer(SERVICE_LINE + FLUSH + pkt(`${'0'.repeat(40)} capabilities^{}\0multi_ack thin-pack agent=git/github-x\n`) + '0000'),
        'a first line with no capabilities': () => answer(SERVICE_LINE + FLUSH + pkt(`${OID} HEAD\n`) + '0000'),
        'capabilities without a symref': () => answer(advertisementWith('multi_ack thin-pack object-format=sha1')),
        'a symref of another reference only': () =>
          answer(advertisementWith('multi_ack symref=refs/remotes/origin/HEAD:refs/remotes/origin/master agent=git/github-x')),
        'a symref that only looks like HEAD': () => answer(advertisementWith('multi_ack xsymref=HEAD:refs/heads/master symref=HEAD')),
      }
      for (const [name, discover] of Object.entries(bodies)) {
        const result = await run({ discover })
        expect(refusalOf(result), name).toMatch(new RegExp(`^${REASONS_TO_READ}: the answer `))
        untouched(result)
      }
    })

    it('refuses a HEAD that is not a branch, and a branch name that is not a plain one', async () => {
      const notABranch = await run({ discover: () => answer(advertisementWith('multi_ack symref=HEAD:refs/tags/v1 agent=git/github-x')) })
      expectRefused(notABranch, /^The default branch of test-owner\/test-repo could not be read from GitHub: the answer says that HEAD is not a branch$/)

      const names = [
        '', // nothing after refs/heads/
        '-x',
        '.hidden',
        '/abs',
        'a..b',
        'a//b',
        'trailing/',
        'trailing.',
        'a@{b',
        'a;b',
        'a?b',
        'a#b',
        'a%2Eb',
        'a\\b',
        'a:b',
        'a~b',
        'a^b',
        'a*b',
        'a"b',
        "a'b",
        'a$(b)',
        'ü',
        'x'.repeat(101),
      ]
      for (const name of names) {
        const result = await run({ discover: () => answer(advertisementWith(`multi_ack symref=HEAD:refs/heads/${name} agent=git/github-x`)) })
        expect(refusalOf(result), JSON.stringify(name)).toMatch(/the name of the default branch is not a plain branch name$/)
        untouched(result)
      }
    })

    it('refuses after the same tries as a migration file when GitHub says 404 or 5xx, and says the last answer', async () => {
      for (const status of [404, 500, 502, 503]) {
        discoveries = []
        const result = await run({ discover: () => answer('nope', status), retryDelaysMs: [1, 1] })
        expect(refusalOf(result)).toBe(`${REASONS_TO_READ} after 3 tries (HTTP ${status}). A private repository needs MIGRATION_GITHUB_TOKEN`)
        expect(discoveries).toHaveLength(3)
        untouched(result)
      }
      const longer = await run({ discover: () => answer('nope', 404), retryDelaysMs: [1, 1, 1, 1, 1] })
      expect(refusalOf(longer)).toContain('after 6 tries (HTTP 404)')
    })

    it('refuses after its tries on a network error and on a timeout, and never says what the library said', async () => {
      const down = await run({
        discover: () => {
          throw Object.assign(new TypeError(`fetch failed for ${PERSONAL}`), { cause: new Error(PERSONAL) })
        },
      })
      expect(refusalOf(down)).toBe(`${REASONS_TO_READ} after 3 tries (network error). A private repository needs MIGRATION_GITHUB_TOKEN`)
      expect(down.error.message).not.toContain(PERSONAL)
      untouched(down)

      const slow = await run({
        discover: () => {
          throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        },
      })
      expect(refusalOf(slow)).toContain('after 3 tries (timed out)')
      untouched(slow)
    })

    it('does not retry a refused token (401 or 403): it is final, and points at MIGRATION_GITHUB_TOKEN', async () => {
      for (const status of [401, 403]) {
        discoveries = []
        const result = await run({ discover: () => answer('', status), retryDelaysMs: [1, 1, 1] })
        expect(refusalOf(result)).toBe(
          `GitHub refused to give the default branch of test-owner/test-repo (HTTP ${status}): check MIGRATION_GITHUB_TOKEN`,
        )
        expect(discoveries).toHaveLength(1)
        untouched(result)
      }
    })

    it('never falls back to master, to main or to the branch of the build when it cannot read the answer', async () => {
      for (const commitRef of ['master', 'main', 'release']) {
        const result = await run({ commitRef, discover: () => answer('nope', 404) })
        expect(result.error).toBeInstanceOf(SafeMessageError)
        expect(result.error.message).toMatch(/could not be read from GitHub after 3 tries/)
        expect(result.lines.filter((line) => line.startsWith('Production branch:'))).toEqual([])
        untouched(result)
      }
    })
  })

  describe('reading the answer', () => {
    it('tries again after a 404, a server error, a dropped connection or a body that breaks off, and then succeeds', async () => {
      const broken = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from(REAL_ADVERTISEMENT.slice(0, 50)))
            controller.error(new TypeError('terminated'))
          },
        }),
        { status: 200 },
      )
      const steps = [
        () => answer('', 404),
        () => answer('', 503),
        () => {
          throw new TypeError('fetch failed')
        },
        () => broken,
      ]
      const result = await run({ discover: (url, init, n) => (n <= steps.length ? steps[n - 1]() : answer(advertisement('master'))), retryDelaysMs: [1, 1, 1, 1] })
      expect(discoveries).toHaveLength(5)
      expect(buildFailureText(result.error)).toBe('ECONNREFUSED')
      expect(result.lines).toContain('Production branch: master (the default branch on GitHub)')
    })

    it('understands an answer that arrives in pieces, down to one byte at a time', async () => {
      for (const size of [1, 7, 64, 100_000]) {
        const result = await run({ defaultBranch: 'release/2026', commitRef: 'release/2026', discover: () => chunked(advertisement('release/2026'), size) })
        expect(buildFailureText(result.error), String(size)).toBe('ECONNREFUSED')
      }
    })

    it('reads only as far as the default branch is named: a repository with thousands of references is not downloaded', async () => {
      // The real answer is followed by endless references. The stub counts what it was asked to produce and whether the
      // reader let go of the body.
      let produced = 0
      let cancelled = false
      const filler = Buffer.from(pkt(`${OID} refs/tags/${'t'.repeat(60)}\n`).repeat(500))
      const endless = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from(advertisement('master').replace(/0000$/, '')))
            },
            pull(controller) {
              produced += filler.length
              controller.enqueue(filler)
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 200 },
        )
      const result = await run({ discover: endless })
      expect(buildFailureText(result.error)).toBe('ECONNREFUSED')
      expect(cancelled).toBe(true)
      expect(produced).toBeLessThan(1_000_000)
    })

    it('reads a long list of references as well: only the first line matters', async () => {
      const many = advertisement('master').replace(/0000$/, '') + pkt(`${OID} refs/tags/v1\n`).repeat(20_000) + '0000'
      expect(many.length).toBeGreaterThan(1_000_000)
      const result = await run({ discover: () => answer(many) })
      expect(buildFailureText(result.error)).toBe('ECONNREFUSED')
    })
  })

  describe('a private repository', () => {
    const basic = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`

    it('sends the token to GitHub as the password of Basic authentication, the way git does', async () => {
      await run({ githubToken: TOKEN })
      expect(discoveries).toHaveLength(1)
      expect(discoveries[0].headers).toEqual({ Authorization: basic })
      expect(discoveries[0].url).toBe(DISCOVERY_URL)
      expect(discoveries[0].url).not.toContain(TOKEN)
    })

    it('sends no Authorization header when there is no token', async () => {
      await run()
      expect(discoveries[0].headers).toEqual({})
    })

    it('never logs the token or puts it in an error, whatever happens (a refusal, a 404, a mismatch, a bad answer, a success)', async () => {
      const results = [
        await run({ githubToken: TOKEN, discover: () => answer('', 401) }),
        await run({ githubToken: TOKEN, discover: () => answer('', 403) }),
        await run({ githubToken: TOKEN, discover: () => answer('', 404) }),
        await run({ githubToken: TOKEN, discover: () => answer('', 500) }),
        await run({
          githubToken: TOKEN,
          discover: () => {
            throw new TypeError(`fetch failed ${TOKEN}`)
          },
        }),
        await run({ githubToken: TOKEN, discover: () => answer('not a list') }),
        await run({ githubToken: TOKEN, defaultBranch: 'main', commitRef: 'master' }),
        await run({ githubToken: TOKEN, defaultBranch: 'master', commitRef: 'master' }),
      ]
      for (const result of results) {
        const text = [result.error?.message ?? '', result.error ? buildFailureText(result.error) : '', ...result.lines].join('\n')
        expect(text).not.toContain(TOKEN)
        expect(text).not.toContain(basic)
        expect(text).not.toContain(basic.replace('Basic ', ''))
      }
    })
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
  let defaultBranch // what the stub says the default branch is: the production branch
  let calls // what the stub was asked for a migration file: [{ url, headers }]
  let discoveries // what the stub was asked for the default branch: [{ url, headers }]

  const write = (name, sql) => fs.writeFileSync(path.join(tmpDir, name), sql)
  const publish = (...names) => names.forEach((name) => (master[name] = fs.readFileSync(path.join(tmpDir, name))))
  const migrationRows = async () =>
    (await db.pool.query("select name from schema_migrations where name like 'pm\\_%' order by name")).rows.map((r) => r.name)
  const markerRows = async () => (await db.pool.query(`select environment from ${markerTable}`)).rows.map((r) => r.environment)
  const present = async (table) => (await db.pool.query('select to_regclass($1) is not null as present', [table])).rows[0].present
  const rawUrl = (name) => `https://raw.githubusercontent.com/test-owner/test-repo/refs/heads/master/db/migrations/${name}`

  /**
   * A fetch that plays GitHub: the discovery names `defaultBranch` (recorded in `discoveries`), and a migration file is 200
   * with the bytes of the file in `master`, else 404 (recorded in `calls`).
   */
  const stubFetch = async (url, init) => {
    if (isDiscovery(url)) {
      discoveries.push({ url, headers: init?.headers ?? {} })
      return new Response(advertisement(defaultBranch), { status: 200 })
    }
    calls.push({ url, headers: init?.headers ?? {} })
    const name = decodeURIComponent(url.split('/').pop())
    return name in master ? new Response(master[name], { status: 200 }) : new Response('not found', { status: 404 })
  }
  // For a test that makes the migration files fail in its own way: the discovery still goes to the stub, so that the test
  // is about the files, as it was before the production branch was read from GitHub.
  const discoveryOr = (other) => (url, init) => (isDiscovery(url) ? stubFetch(url, init) : other(url, init))
  const run = (extra = {}) => {
    const lines = []
    const promise = migrateProduction({
      connectionString,
      markerTable,
      dir: tmpDir,
      log: (line) => lines.push(line),
      repoOwner: 'test-owner',
      repoSlug: 'test-repo',
      commitRef: defaultBranch,
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
    defaultBranch = 'master'
    calls = []
    discoveries = []
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

  // The default branch is asked for in every production build, before the database is touched, so "no network call" became
  // "no call for a migration file": that call is still made only for a file that is pending.
  it('applies nothing the second time, keeps a single marker row, and asks for no migration file at all', async () => {
    await run().promise
    calls = []
    const { lines, promise } = run({
      fetch: discoveryOr(async () => {
        throw new Error('GitHub must not be asked for a migration file when nothing is pending')
      }),
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

  it('throws on a nonprod marker before it applies any migration and before it asks GitHub for any migration file', async () => {
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
    const err = await run().promise.catch((e) => e)
    expect(err).toBeInstanceOf(MigrationError)
    expect(err.message).toBe('Migration pm_003_broken.sql failed: 42P01 (undefined_table)')
    expect(err.file).toBe('pm_003_broken.sql')
    expect(err.code).toBe('42P01')
    expect(err.databaseMessage).toMatch(/pm_does_not_exist/)
    expect(err.message).not.toContain('pm_does_not_exist')
    expect(err.message).not.toContain(err.databaseMessage)
    expect(await migrationRows()).toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
    expect(await present(`${db.schema}.pm_extra`)).toBe(false)
    expect(await present(markerTable)).toBe(false)
  })

  describe('what the build would print for a failure', () => {
    it('is the file and the SQLSTATE for a migration that fails on a value, and never the value', async () => {
      write('pm_003_cast.sql', `create table pm_extra (n int); insert into pm_extra values ('${PERSONAL}'::int);`)
      publish('pm_003_cast.sql')
      const err = await run().promise.catch((e) => e)
      expect(err).toBeInstanceOf(MigrationError)
      // The database quoted the value in its message, so the check is meaningful: it is only in databaseMessage.
      expect(err.databaseMessage).toContain(PERSONAL)
      const text = buildFailureText(err)
      expect(text).toBe('Migration pm_003_cast.sql failed: 22P02 (invalid_text_representation)')
      expect(text).not.toContain(PERSONAL)
      expect(await migrationRows()).toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
    })

    it('is the message of a refusal of the gate itself: a file that differs from master, a file not on master, a nonprod marker', async () => {
      master['pm_002_second.sql'] = Buffer.from('create table pm_second (id int primary key, sneaky int);')
      const differs = await run().promise.catch((e) => e)
      expect(buildFailureText(differs)).toBe(
        'Migration pm_002_second.sql differs from the file on GitHub master: only merged migrations are applied',
      )

      publish('pm_002_second.sql')
      delete master['pm_001_first.sql']
      const missing = await run({ retryDelaysMs: [1] }).promise.catch((e) => e)
      expect(buildFailureText(missing)).toMatch(
        /^Migration pm_001_first\.sql could not be read from GitHub master after 2 tries \(HTTP 404\)/,
      )

      publish('pm_001_first.sql')
      await db.pool.query(
        `create table ${markerTable} (environment text primary key check (environment in ('production', 'nonprod')))`,
      )
      await db.pool.query(`insert into ${markerTable} values ('nonprod')`)
      const nonprod = await run().promise.catch((e) => e)
      expect(buildFailureText(nonprod)).toMatch(/non-production database: check the Production environment variables in Vercel/)
    })

    it('is only the code for a failure of the connection to the database, which has no message of ours', async () => {
      // Nothing listens on this port: pg fails with ECONNREFUSED, and its message names the address that it tried.
      const err = await run({ connectionString: 'postgresql://user:pass@127.0.0.1:1/none' }).promise.catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(SafeMessageError)
      expect(err.message).toContain('127.0.0.1')
      expect(buildFailureText(err)).toBe('ECONNREFUSED')
    })
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
      await expect(run({ fetch: discoveryOr(shaky), retryDelaysMs: [1, 1, 1] }).promise).resolves.toHaveLength(2)

      await db.pool.query(`drop table if exists pm_first, pm_second, ${markerTable}`)
      await db.pool.query("delete from schema_migrations where name like 'pm\\_%'")
      const down = async () => {
        throw new TypeError('fetch failed')
      }
      await expect(run({ fetch: discoveryOr(down), retryDelaysMs: [1, 1] }).promise).rejects.toThrow(/could not be read from GitHub master after 3 tries \(network error\)/)
      expect(await migrationRows()).toEqual([])
    })

    it('does not retry a refused token (401 or 403), and points at MIGRATION_GITHUB_TOKEN', async () => {
      for (const status of [401, 403]) {
        calls = []
        const refused = async (url, init) => {
          calls.push({ url, headers: init?.headers ?? {} })
          return new Response('', { status })
        }
        await expect(run({ fetch: discoveryOr(refused), retryDelaysMs: [1, 1, 1] }).promise).rejects.toThrow(
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

  describe('the production branch is the default branch that GitHub reports', () => {
    const nothingChanged = async () => {
      expect(await migrationRows()).toEqual([])
      expect(await present(`${db.schema}.pm_first`)).toBe(false)
      expect(await present(markerTable)).toBe(false)
      expect(calls).toEqual([])
    }

    it('migrates a build of main when main is the default branch, and checks the files against main', async () => {
      defaultBranch = 'main'
      const { lines, promise } = run()
      await expect(promise).resolves.toEqual(['pm_001_first.sql', 'pm_002_second.sql'])
      expect(discoveries).toHaveLength(1)
      expect(calls.map((call) => call.url)).toEqual([rawUrlOn('main', 'pm_001_first.sql'), rawUrlOn('main', 'pm_002_second.sql')])
      const log = lines.join('\n')
      expect(log).toContain('Production branch: main (the default branch on GitHub)')
      expect(log).toContain('Migration pm_001_first.sql: verified against GitHub main')
      expect(log).toContain('Migration pm_002_second.sql: verified against GitHub main')
      expect(log).not.toContain('GitHub master')
      expect(await markerRows()).toEqual(['production'])
    })

    it('refuses a build of main when the default branch is master, and touches nothing', async () => {
      defaultBranch = 'master'
      const result = await withPoolSpied(() => run({ commitRef: 'main' }).promise)
      expect(result.error).toBeInstanceOf(SafeMessageError)
      expect(result.error.message).toMatch(/build is of the branch main, but the production branch of test-owner\/test-repo is its default branch on GitHub, master/)
      expect(result.connects).toBe(0)
      expect(result.queries).toBe(0)
      await nothingChanged()
    })

    it('refuses a build of master when the default branch is main, and touches nothing', async () => {
      defaultBranch = 'main'
      const result = await withPoolSpied(() => run({ commitRef: 'master' }).promise)
      expect(result.error).toBeInstanceOf(SafeMessageError)
      expect(result.error.message).toMatch(/build is of the branch master, but the production branch of test-owner\/test-repo is its default branch on GitHub, main/)
      expect(result.connects).toBe(0)
      expect(result.queries).toBe(0)
      await nothingChanged()
    })

    it('refuses when GitHub does not say what the default branch is, and touches nothing', async () => {
      const failures = [
        () => new Response('nope', { status: 404 }),
        () => new Response('', { status: 401 }),
        () => new Response(advertisementWith('multi_ack thin-pack')),
        () => new Response('<html></html>'),
        () => {
          throw new TypeError('fetch failed')
        },
      ]
      for (const failure of failures) {
        const result = await withPoolSpied(() => run({ fetch: async () => failure() }).promise)
        expect(result.error).toBeInstanceOf(SafeMessageError)
        expect(result.error.message).toMatch(/^(The default branch of test-owner\/test-repo could not be read from GitHub|GitHub refused to give the default branch)/)
        expect(result.connects).toBe(0)
        expect(result.queries).toBe(0)
        await nothingChanged()
      }
    })

    it('reads the default branch from GitHub before it touches the database, and the files after the database was read', async () => {
      const connect = vi.spyOn(pg.Pool.prototype, 'connect')
      const fetchSpy = vi.fn(stubFetch)
      let discoveredAt
      let firstFileAt
      let connectedAt
      try {
        await run({ fetch: fetchSpy }).promise
        discoveredAt = fetchSpy.mock.invocationCallOrder[0]
        firstFileAt = fetchSpy.mock.invocationCallOrder[1]
        connectedAt = Math.min(...connect.mock.invocationCallOrder)
        expect(fetchSpy.mock.calls[0][0]).toBe(DISCOVERY_URL)
        expect(fetchSpy.mock.calls[1][0]).toBe(rawUrlOn('master', 'pm_001_first.sql'))
      } finally {
        connect.mockRestore()
      }
      expect(discoveredAt).toBeLessThan(connectedAt)
      // The pending files are only known once the database was read, so the first file is asked for after that.
      expect(connectedAt).toBeLessThan(firstFileAt)
    })

    it('writes the branch into the address one segment at a time, so that a slash stays a slash', async () => {
      defaultBranch = 'release/v1.2'
      await expect(run().promise).resolves.toHaveLength(2)
      expect(calls.map((call) => call.url)).toEqual([
        rawUrlOn('release/v1.2', 'pm_001_first.sql'),
        rawUrlOn('release/v1.2', 'pm_002_second.sql'),
      ])
      expect(calls[0].url).toContain('/refs/heads/release/v1.2/db/migrations/')
      expect(calls[0].url).not.toContain('%2F')
    })

    it('reads the default branch again in every build: a branch that was renamed on GitHub is the new production branch', async () => {
      await run().promise
      write('pm_003_third.sql', 'create table pm_extra (id int primary key);')
      publish('pm_003_third.sql')
      defaultBranch = 'main'
      calls = []
      await expect(run({ commitRef: 'master' }).promise).rejects.toThrow(/production branch of test-owner\/test-repo is its default branch on GitHub, main/)
      await expect(run({ commitRef: 'main' }).promise).resolves.toEqual(['pm_003_third.sql'])
      expect(calls.map((call) => call.url)).toEqual([rawUrlOn('main', 'pm_003_third.sql')])
    })

    it('never reads the files of the branch of the build when it is not the default branch: a topic branch cannot vouch for itself', async () => {
      // The files exist on "release", the topic branch of the build, but not on the default branch.
      defaultBranch = 'main'
      const onlyOnRelease = async (url, init) => {
        if (isDiscovery(url)) return stubFetch(url, init)
        calls.push({ url, headers: init?.headers ?? {} })
        return url.includes('/refs/heads/release/') ? new Response(master['pm_001_first.sql'], { status: 200 }) : new Response('not found', { status: 404 })
      }
      const error = await run({ commitRef: 'release', fetch: onlyOnRelease }).promise.catch((err) => err)
      expect(error.message).toMatch(/is its default branch on GitHub, main/)
      expect(calls).toEqual([])
      expect(await migrationRows()).toEqual([])
    })
  })
})
