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
const GITHUB_WEB = 'https://github.com'
const GITHUB_FETCH_TIMEOUT_MS = 15_000
// The raw CDN can serve a stale 404 for a short time after a merge, so a missing file is retried with a growing wait
// (about 67 s in all) before the build gives up. Reading the default branch uses the same waits.
const GITHUB_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]

// A branch name goes into a URL and into the build log, so it is only used when it is a plain one: letters, digits and
// `._/-`, at most 100 characters, not starting with `-`, `.` or `/`, with no `..`, `//` or `@{` in it and no `/` or `.` at
// its end. Git allows more than that, and a repository that has a default branch outside this set must rename it.
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/
const isPlainBranchName = (name) =>
  typeof name === 'string' &&
  BRANCH_NAME.test(name) &&
  !name.includes('..') &&
  !name.includes('//') &&
  !name.includes('@{') &&
  !/[/.]$/.test(name)

// The longest line that git's framing allows (four hex digits that count themselves).
const MAX_PKT_LINE = 65_520

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
 * - `migrate`: a production build of a commit that the Vercel Git integration built (it sets the branch, the full commit
 *   hash and the repository only for a deployment triggered from Git). Whether that branch is the production branch is not
 *   decided here, because only GitHub can say which branch that is (its default branch) and asking is a network call:
 *   migrateProduction asks, before it touches the database, and refuses any other branch.
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
      present(env.VERCEL_GIT_COMMIT_REF) &&
      FULL_SHA.test(env.VERCEL_GIT_COMMIT_SHA ?? '') &&
      present(env.VERCEL_GIT_REPO_OWNER) &&
      present(env.VERCEL_GIT_REPO_SLUG)
    if (fromGit) {
      return {
        action: 'migrate',
        reason:
          'a production build of a commit built by the Vercel Git integration, if its branch is the default branch on ' +
          'GitHub (checked before the database is touched)',
      }
    }
    return {
      action: 'refuse',
      reason:
        'A production build needs the Git data of a commit (VERCEL=1, a branch, a full 40-character commit hash, the ' +
        'repository owner and name). Production is deployed only from a merge to the production branch through the Vercel ' +
        'Git integration, never from a local checkout or the CLI.',
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
 * Asks GitHub for `url` until it answers 200, and returns what `read` makes of that answer, as `{ value }`. A 404, another
 * failing status, a network error and a timeout (also while the body is read) are retried after each of `delays`; a
 * refused token (401 or 403) is final and says `refused(status)`, and so is anything that `read` throws as a final error
 * (an answer that came but is not what was asked for). When the tries run out it returns `{ last }`, what the last try
 * ended with (`HTTP 404`, `network error`, `timed out`), and the caller says what could not be read. The headers carry the
 * token and nothing else does: it is in no message and in no log.
 */
async function readFromGithub({ url, headers, fetchFile, delays, read, refused }) {
  let last = ''
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    try {
      const res = await fetchFile(url, { headers, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) })
      if (res.status === 200) return { value: await read(res) }
      if (res.status === 401 || res.status === 403) throw finalError(refused(res.status))
      last = `HTTP ${res.status}`
    } catch (err) {
      if (err.final) throw err
      last = err?.name === 'TimeoutError' ? 'timed out' : 'network error'
    }
  }
  return { last }
}

/** An answer of GitHub to the discovery that is not what git says. Only its fixed `message` is ever shown. */
class BadAdvertisement extends Error {}

/**
 * One pkt-line of git's wire format at `offset` of `buf`: four hex digits that give the length of the line with those four
 * digits included, then the payload. `0000` is a flush (no payload). Returns null while `buf` does not hold the whole line
 * yet. The special lines of protocol version 2 (`0001`, `0002`, `0003`) never start the answer that is asked for here.
 */
function pktLine(buf, offset) {
  if (buf.length < offset + 4) return null
  const header = buf.toString('latin1', offset, offset + 4)
  if (!/^[0-9a-f]{4}$/.test(header)) throw new BadAdvertisement('the answer is not a git reference list')
  const length = parseInt(header, 16)
  if (length === 0) return { flush: true, next: offset + 4 }
  if (length < 4 || length > MAX_PKT_LINE) throw new BadAdvertisement('the answer is not a git reference list')
  if (buf.length < offset + length) return null
  return { flush: false, payload: buf.toString('utf8', offset + 4, offset + length), next: offset + length }
}

/**
 * The default branch that the start of a reference list names, or null while `buf` is too short to say. The list (protocol
 * version 0, which is what an HTTP request without a `Git-Protocol` header gets) is: the line `# service=git-upload-pack`, a
 * flush, and then one line per reference, the first of which is `HEAD` and carries the capabilities of the server after a
 * NUL byte. The capability `symref=HEAD:refs/heads/<branch>` is the branch that HEAD points at, which for a repository on
 * GitHub is its default branch. Everything after the first reference is never read: a repository lists every branch, tag and
 * pull request there.
 */
function advertisedDefaultBranch(buf) {
  const service = pktLine(buf, 0)
  if (!service) return null
  if (service.flush || service.payload.replace(/\n$/, '') !== '# service=git-upload-pack') {
    throw new BadAdvertisement('the answer is not a git reference list')
  }
  const flush = pktLine(buf, service.next)
  if (!flush) return null
  if (!flush.flush) throw new BadAdvertisement('the answer is not a git reference list')
  const first = pktLine(buf, flush.next)
  if (!first) return null
  if (first.flush) throw new BadAdvertisement('the answer lists no references (is the repository empty?)')
  const nul = first.payload.indexOf('\0')
  const capabilities = nul === -1 ? [] : first.payload.slice(nul + 1).replace(/\n$/, '').split(' ')
  const symref = capabilities.find((capability) => capability.startsWith('symref=HEAD:'))
  if (!symref) throw new BadAdvertisement('the answer names no default branch (is the repository empty?)')
  const target = symref.slice('symref=HEAD:'.length)
  if (!target.startsWith('refs/heads/')) throw new BadAdvertisement('the answer says that HEAD is not a branch')
  const branch = target.slice('refs/heads/'.length)
  if (!isPlainBranchName(branch)) throw new BadAdvertisement('the name of the default branch is not a plain branch name')
  return branch
}

/** Reads the body of the discovery only as far as the default branch is named, then drops the rest of it. */
async function readAdvertisement(res) {
  if (!res.body) throw new BadAdvertisement('the answer is empty')
  const reader = res.body.getReader()
  let buf = Buffer.alloc(0)
  try {
    for (;;) {
      const branch = advertisedDefaultBranch(buf)
      if (branch !== null) return branch
      const { done, value } = await reader.read()
      if (done) throw new BadAdvertisement('the answer ended before it named the default branch')
      buf = Buffer.concat([buf, value])
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/**
 * The default branch of `owner/slug` as GitHub reports it right now, the way `git ls-remote --symref` learns it: the smart
 * HTTP discovery of the repository, `GET <repo>.git/info/refs?service=git-upload-pack`. It is not the REST API on purpose:
 * that allows 60 requests an hour for each address without a token, and the build servers of Vercel share their addresses.
 * Nothing but GitHub's answer decides the name: no environment variable, no file of the build, no default. When the answer
 * cannot be read or understood this throws and the build is refused. A private repository needs `token`, which is sent
 * the way git sends one to github.com: Basic authentication with the token as the password (the user name is not checked).
 * Do not ask for protocol version 2 here (`Git-Protocol: version=2`): its answer lists no `symref`.
 */
async function readDefaultBranch({ owner, slug, token, fetchFile, delays }) {
  const repository = `${owner}/${slug}`
  const url = `${GITHUB_WEB}/${owner}/${slug}.git/info/refs?service=git-upload-pack`
  const headers = token ? { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {}
  const answer = await readFromGithub({
    url,
    headers,
    fetchFile,
    delays,
    read: (res) =>
      readAdvertisement(res).catch((err) => {
        if (!(err instanceof BadAdvertisement)) throw err
        throw finalError(`The default branch of ${repository} could not be read from GitHub: ${err.message}`)
      }),
    refused: (status) => `GitHub refused to give the default branch of ${repository} (HTTP ${status}): check MIGRATION_GITHUB_TOKEN`,
  })
  if ('value' in answer) return answer.value
  throw new SafeMessageError(
    `The default branch of ${repository} could not be read from GitHub after ${delays.length + 1} tries (${answer.last}). ` +
      'A private repository needs MIGRATION_GITHUB_TOKEN',
  )
}

/**
 * The bytes of `file` on `branch` of the repository on GitHub. A 404, another failing status and a network error are
 * retried after each of `delays` (the raw CDN can briefly serve a stale 404 right after a merge); a refused token is final.
 * `url` is the address of the file. The token goes into the header and nowhere else: not into a message, not into the log.
 */
async function fetchMigrationFile({ file, branch, url, token, fetchFile, delays }) {
  const answer = await readFromGithub({
    url,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    fetchFile,
    delays,
    read: async (res) => Buffer.from(await res.arrayBuffer()),
    refused: (status) => `GitHub refused to give migration ${file} (HTTP ${status}): check MIGRATION_GITHUB_TOKEN`,
  })
  if ('value' in answer) return answer.value
  throw new SafeMessageError(
    `Migration ${file} could not be read from GitHub ${branch} after ${delays.length + 1} tries (${answer.last}). Is it ` +
      `merged to ${branch}? A private repository needs MIGRATION_GITHUB_TOKEN`,
  )
}

/**
 * Throws unless every file of `files` (names in `dir`) is byte-identical to the file of the same name on `branch` of the
 * repository on GitHub (the production branch: its default branch, as GitHub reported it a moment ago). Migration files
 * never change once merged (the `guards` CI check), so this means only reviewed, merged migrations are applied, whatever
 * started the build (a CLI deploy uploads local files, which may be uncommitted or unpushed).
 * The bytes are compared exactly: the repository stores LF and the Vercel checkout is LF, so nothing is normalized.
 * The branch is a plain branch name (isPlainBranchName); it is written after `refs/heads/` one segment at a time, so that
 * the `/` of a name such as `release/2026` stays a path separator.
 */
async function verifyOnGithubBranch({ files, dir, owner, slug, branch, token, fetchFile, delays, log }) {
  const branchPath = branch.split('/').map(encodeURIComponent).join('/')
  for (const file of files) {
    const url = `${GITHUB_RAW}/${owner}/${slug}/refs/heads/${branchPath}/db/migrations/${encodeURIComponent(file)}`
    const remote = await fetchMigrationFile({ file, branch, url, token, fetchFile, delays })
    if (!remote.equals(fs.readFileSync(path.join(dir, file)))) {
      throw new SafeMessageError(`Migration ${file} differs from the file on GitHub ${branch}: only merged migrations are applied`)
    }
    log(`Migration ${file}: verified against GitHub ${branch}`)
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
 * @property {string} [commitRef]  the branch of the commit that is built (`VERCEL_GIT_COMMIT_REF`): it must be the default
 *   branch of the repository on GitHub, which this function asks GitHub for
 * @property {string} [githubToken]  for a private fork, so that it can deploy; never logged (see migrateProduction)
 * @property {typeof fetch} [fetch]  default the global fetch
 * @property {number[]} [retryDelaysMs]  the waits between the tries to read from GitHub
 */

/**
 * Migrates the database behind `connectionString` and, when it is not marked yet, marks it as production.
 * The production branch is the default branch of `repoOwner/repoSlug` as GitHub reports it at this moment, never a value
 * from the environment and never a name written here. First, before any connection to the database, it reads that branch
 * and refuses unless `commitRef` (the branch of the commit being built) is exactly it. Then it refuses a non-production
 * marker, and it applies only migrations that are on that branch on GitHub: every pending file must be byte-identical to
 * the file in `repoOwner/repoSlug` on it (and with no pending file no file is asked for).
 * `githubToken` (optional) lets a private fork deploy: it is sent as `Authorization: Bearer` when a file is fetched and as
 * the password of Basic authentication when the default branch is read, and it is never logged.
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
  commitRef,
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
  if (!present(commitRef)) {
    throw new SafeMessageError('The branch of the commit (VERCEL_GIT_COMMIT_REF) is missing: a production build needs it')
  }

  // The production branch is the default branch of the repository, as GitHub says it now. This comes before the pool is
  // created, so a build of another branch, or one that cannot ask GitHub, touches no database at all.
  const defaultBranch = await readDefaultBranch({ owner: repoOwner, slug: repoSlug, token: githubToken, fetchFile, delays: retryDelaysMs })
  log(`Production branch: ${defaultBranch} (the default branch on GitHub)`)
  if (commitRef !== defaultBranch) {
    // The branch of the build comes from the environment: it is only shown when it is a plain branch name.
    const built = isPlainBranchName(commitRef) ? commitRef : '(not a plain branch name)'
    throw new SafeMessageError(
      `This production build is of the branch ${built}, but the production branch of ${repoOwner}/${repoSlug} is its default ` +
        `branch on GitHub, ${defaultBranch}. Production is deployed only from a merge to ${defaultBranch}: the production ` +
        'branch of the Vercel project and the default branch on GitHub must be the same',
    )
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

    // Before anything is applied: every pending file must be the merged one, the one on the production branch. A file that
    // was applied by another run in the meantime only makes migrate() do less than what was verified here, never more.
    const pending = await pendingMigrations(pool, dir)
    await verifyOnGithubBranch({
      files: pending,
      dir,
      owner: repoOwner,
      slug: repoSlug,
      branch: defaultBranch,
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
