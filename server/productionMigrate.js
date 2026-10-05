// The production migration: what scripts/vercel-build.mjs runs in the Vercel production build, after the app was built
// (ADR 0002). The pieces are small and take everything they need as arguments, so the tests can run them against a
// throwaway schema. Nothing here reads process.env: the build script passes the environment and the connection string.
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { normalizeConnectionString, guardPool } from './db.js'
import { DEFAULT_DIR, migrate, pendingMigrations } from './migrate.js'
import { MARKER_TABLE, markerTableName, maskDatabaseHost, readEnvironmentMarker } from './dbGuard.js'
import { SafeMessageError, failureLabel, oneLine } from './logSafe.js'

// Vercel puts the full commit hash in VERCEL_GIT_COMMIT_SHA for a deployment that it built from Git.
const FULL_SHA = /^[0-9a-f]{40}$/

// The GitHub owner and repository name go into a URL, so they are checked first (the rules of GitHub names, and never
// `.` or `..`).
const REPO_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_SLUG = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/

const GITHUB_RAW = 'https://raw.githubusercontent.com'
const GITHUB_FETCH_TIMEOUT_MS = 15_000
// The raw CDN can serve a stale 404 for a short time after a merge, so a missing file is retried with a growing wait
// (about 67 s in all) before the build gives up.
const GITHUB_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]

const present = (value) => typeof value === 'string' && value.length > 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The text that the production build prints when the migration fails (scripts/vercel-build.mjs). The build log is read by more
 * people than the owner, and the message of a database or library error can quote a row value (a duplicate key, a failed
 * check, a value that does not cast) or the host of the database, so only an error that our own code wrote is printed as its
 * message: a SafeMessageError (the errors of this file, the lock error and MigrationError of server/migrate.js, which says the
 * file and the SQLSTATE). Anything else, a database or a network error, is printed as failureLabel says: its code or its name,
 * never its message. The answer is one short line. It decides only what is printed, never whether the build fails.
 */
export function buildFailureText(err) {
  return err instanceof SafeMessageError ? oneLine(err.message, 500) : failureLabel(err)
}

/**
 * Decides what the build does about the database, from the build environment (the caller passes `process.env`).
 * Returns `{ action: 'migrate' | 'skip' | 'refuse', reason }`:
 * - `skip`: a Vercel preview or development build. It builds and never touches a database.
 * - `migrate`: a production build of a commit on master that the Vercel Git integration built (it sets the branch, the full
 *   commit hash and the repository only for a deployment triggered from Git).
 * - `refuse`: everything else, including a build whose environment is unknown. It fails closed: this script is only
 *   Vercel's build command, so a build that does not say what it is must not deploy. The deployment fails and the current
 *   one keeps serving.
 * VERCEL_ENV=production alone proves nothing (any shell can set it, and a local `vercel build --prod` sets it too), and the
 * Git data alone does not prove that the files are the merged ones: migrateProduction checks that against GitHub.
 */
export function productionBuildDecision(env) {
  if (env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'development') {
    return { action: 'skip', reason: `a Vercel ${env.VERCEL_ENV} build, so no database is touched` }
  }
  if (env.VERCEL_ENV === 'production') {
    const fromGit =
      env.VERCEL === '1' &&
      env.VERCEL_GIT_COMMIT_REF === 'master' &&
      FULL_SHA.test(env.VERCEL_GIT_COMMIT_SHA ?? '') &&
      present(env.VERCEL_GIT_REPO_OWNER) &&
      present(env.VERCEL_GIT_REPO_SLUG)
    if (fromGit) {
      return { action: 'migrate', reason: 'a production build of a commit on master, built by the Vercel Git integration' }
    }
    return {
      action: 'refuse',
      reason:
        'A production build needs the Git data of a commit on master (VERCEL=1, branch master, a full 40-character commit ' +
        'hash, the repository owner and name). Production is deployed only from a merge to master through the Vercel Git ' +
        'integration, never from a local checkout or the CLI.',
    }
  }
  return {
    action: 'refuse',
    reason:
      'The build environment is unknown (VERCEL_ENV is not preview, development or production). This script is only ' +
      "Vercel's build command: a local build is `npm run build`. On Vercel, the project setting \"Automatically expose " +
      'System Environment Variables" must be on.',
  }
}

// An advisory lock belongs to one session, and a transaction pooler (the -pooler host of Neon) hands the next statement
// to another connection, so the lock would protect nothing.
function hostOf(connectionString) {
  let hostname = ''
  try {
    hostname = new URL(connectionString).hostname
  } catch {
    // the empty host is refused below, the same as a URL without one
  }
  if (!hostname) throw new SafeMessageError('DATABASE_URL_UNPOOLED is not a valid connection URL')
  return hostname
}

/** Marks the database as production: one transaction, safe to run again. */
async function markProduction(pool, table) {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('begin')
    await client.query(
      `create table if not exists ${table} (environment text primary key check (environment in ('production', 'nonprod')))`,
    )
    await client.query(
      `comment on table ${table} is 'Marks this database as production or nonprod: tests and local scripts refuse a ` +
        `database marked production (server/dbGuard.js). Written by the Vercel production build on its first deploy.'`,
    )
    await client.query(`insert into ${table} (environment) values ('production') on conflict do nothing`)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {
      broken = true
    })
    throw err
  } finally {
    client.release(broken)
  }
}

/** An error that retrying cannot change (a different file, a refused token). */
function finalError(message) {
  return Object.assign(new SafeMessageError(message), { final: true })
}

/**
 * The bytes of `file` on GitHub master. A 404, another failing status and a network error are retried after each of
 * `delays` (the raw CDN can briefly serve a stale 404 right after a merge); a refused token is final. The token goes into
 * the header and nowhere else: not into a message, not into the log.
 */
async function fetchFromGithubMaster({ file, url, token, fetchFile, delays }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  let last = ''
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    try {
      const res = await fetchFile(url, { headers, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) })
      if (res.status === 200) return Buffer.from(await res.arrayBuffer())
      if (res.status === 401 || res.status === 403) {
        throw finalError(`GitHub refused to give migration ${file} (HTTP ${res.status}): check MIGRATION_GITHUB_TOKEN`)
      }
      last = `HTTP ${res.status}`
    } catch (err) {
      if (err.final) throw err
      last = err?.name === 'TimeoutError' ? 'timed out' : 'network error'
    }
  }
  throw new SafeMessageError(
    `Migration ${file} could not be read from GitHub master after ${delays.length + 1} tries (${last}). Is it merged to ` +
      'master? A private repository needs MIGRATION_GITHUB_TOKEN',
  )
}

/**
 * Throws unless every file of `files` (names in `dir`) is byte-identical to the file of the same name on GitHub master.
 * Migration files never change once merged (the `guards` CI check), so this means only reviewed, merged migrations are
 * applied, whatever started the build (a CLI deploy uploads local files, which may be uncommitted or unpushed).
 * The bytes are compared exactly: the repository stores LF and the Vercel checkout is LF, so nothing is normalized.
 */
async function verifyOnGithubMaster({ files, dir, owner, slug, token, fetchFile, delays, log }) {
  for (const file of files) {
    const url = `${GITHUB_RAW}/${owner}/${slug}/refs/heads/master/db/migrations/${encodeURIComponent(file)}`
    const remote = await fetchFromGithubMaster({ file, url, token, fetchFile, delays })
    if (!remote.equals(fs.readFileSync(path.join(dir, file)))) {
      throw new SafeMessageError(`Migration ${file} differs from the file on GitHub master: only merged migrations are applied`)
    }
    log(`Migration ${file}: verified against GitHub master`)
  }
}

/**
 * @typedef {object} MigrateProductionOptions
 * @property {string} connectionString  the direct (not pooled) connection string, `DATABASE_URL_UNPOOLED`
 * @property {string} [markerTable]  default public.environment_marker
 * @property {string} [dir]  the folder of the migrations, default db/migrations
 * @property {(message: string) => void} [log]  default: no log
 * @property {string} [repoOwner]  the GitHub owner of the repository, the rules of GitHub names apply
 * @property {string} [repoSlug]  the name of the repository
 * @property {string} [githubToken]  sent as `Authorization: Bearer` so that a private fork can deploy; never logged
 * @property {typeof fetch} [fetch]  default the global fetch
 * @property {number[]} [retryDelaysMs]  the waits between the tries to read a file from GitHub master
 */

/**
 * Migrates the database behind `connectionString` and, when it is not marked yet, marks it as production.
 * It refuses a non-production marker, and it applies only migrations that are on GitHub master: every pending file must
 * be byte-identical to the file in `repoOwner/repoSlug` on master (and with no pending file there is no network call).
 * `githubToken` (optional) is sent as `Authorization: Bearer` so that a private fork can deploy; it is never logged.
 * `markerTable` (default public.environment_marker), `dir`, `fetch` and `retryDelaysMs` are for the tests, which point
 * them at a table and a folder of their own, a stub and tiny waits. Returns the names of the migrations it applied.
 * @param {MigrateProductionOptions} options
 * @returns {Promise<string[]>}
 */
export async function migrateProduction({
  connectionString,
  markerTable = MARKER_TABLE,
  dir = DEFAULT_DIR,
  log = () => {},
  repoOwner,
  repoSlug,
  githubToken,
  fetch: fetchFile = globalThis.fetch,
  retryDelaysMs = GITHUB_RETRY_DELAYS_MS,
}) {
  // The name is interpolated into SQL below, so it is checked first (see server/dbGuard.js).
  const table = markerTableName(markerTable)
  if (!connectionString) {
    throw new SafeMessageError(
      'DATABASE_URL_UNPOOLED is not set: the production migration needs the direct connection string of the database',
    )
  }
  if (hostOf(connectionString).includes('-pooler')) {
    throw new SafeMessageError(
      'DATABASE_URL_UNPOOLED points at a pooled host (-pooler): the migration lock needs a direct connection, a ' +
        'session of its own',
    )
  }
  if (!REPO_OWNER.test(repoOwner ?? '') || !REPO_SLUG.test(repoSlug ?? '')) {
    throw new SafeMessageError('The GitHub repository (VERCEL_GIT_REPO_OWNER and VERCEL_GIT_REPO_SLUG) is missing or not a valid name')
  }

  log(`Production migration target: ${maskDatabaseHost(connectionString)}`)
  const pool = guardPool(
    new pg.Pool({
      connectionString: normalizeConnectionString(connectionString),
      max: 1,
      // A Neon compute that is waking from sleep needs a few seconds to accept the first connection.
      connectionTimeoutMillis: 20_000,
    }),
  )
  try {
    const marker = await readEnvironmentMarker(pool, table)
    if (marker === 'nonprod') {
      throw new SafeMessageError(
        'This production build points at a non-production database: check the Production environment variables in Vercel',
      )
    }
    log(marker === 'production' ? 'Database marker: production' : 'Database is not marked yet: it is marked production after the migration')

    // Before anything is applied: every pending file must be the merged one. A file that was applied by another run in
    // the meantime only makes migrate() do less than what was verified here, never more.
    const pending = await pendingMigrations(pool, dir)
    await verifyOnGithubMaster({
      files: pending,
      dir,
      owner: repoOwner,
      slug: repoSlug,
      token: githubToken,
      fetchFile,
      delays: retryDelaysMs,
      log,
    })

    const applied = await migrate(pool, dir)

    // A new self-hosted deployment has no marker: its first deploy marks it, so that local tooling refuses it from then on.
    if (marker === null) {
      await markProduction(pool, table)
      log('Database marked production')
    }
    log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.')
    return applied
  } finally {
    await pool.end()
  }
}
