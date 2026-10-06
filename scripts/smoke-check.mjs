// Smoke test of a production deployment (see .github/workflows/smoke.yml, which runs it after every production deploy).
//
// Usage: EXPECTED_SHA=<the full SHA of the deployed commit> SMOKE_BASE_URL=https://<your-domain>
//        [SMOKE_AGENT_KEY=<read-only agent key>] node scripts/smoke-check.mjs
//
// Why this exists: a green build does not prove that the live site works. The build can pass while the domain still
// serves the old deployment, while the app page is empty, or while the database is one migration behind the code (the
// case that ADR 0002 closes in the build and that this checks again from the outside). Three steps, each prints one line:
//   1. GET /api/health until the production domain serves the expected commit (a promotion can lag behind the
//      deployment event, and a CDN can answer from its cache for a moment, so it polls with a cache-busting query).
//   2. GET / returns the app page with its root element.
//   3. GET /api/health/db with the agent key: the database answers, and its newest migration is the newest file in
//      db/migrations of the checked-out commit. Without a key this step is a warning, not a failure.
// Steps 2 and 3 only run when step 1 passed, because otherwise they would test a different deployment.
//
// The environment: EXPECTED_SHA and SMOKE_BASE_URL (both required; the address is the production domain of this copy, the
// repository variable of the same name in the workflow), SMOKE_AGENT_KEY (optional), and for a quick local try
// SMOKE_TIMEOUT_MS and SMOKE_INTERVAL_MS (how long and how often step 1 polls). There is no default address: a copy of
// the repository would otherwise test the first installation's site.
//
// The key goes only into the Authorization header of one request, never into a log line, and the request does not follow
// a redirect. Nothing the server answers is printed except the known fields of the two health routes, cleaned so that a
// response cannot write a line or a workflow command into the log. Node built-ins and the global fetch only, no install.
import { migrationFiles, DEFAULT_DIR } from '../server/migrate.js'
import { isMain } from './ci-git.mjs'

export const DEFAULT_TIMEOUT_MS = 5 * 60_000
export const DEFAULT_INTERVAL_MS = 10_000
// The database step asks up to this many times, this far apart, when the answer is a 5xx or no answer: a sleeping Neon
// compute can need a moment, and one slow wake-up must not open an issue. A 401 (a bad key) is final at once.
export const DB_ATTEMPTS = 3
export const DB_RETRY_MS = 5_000
const REQUEST_TIMEOUT_MS = 20_000
// The element that main.jsx mounts the app into (index.html).
const ROOT_ELEMENT = /<div\b[^>]*\bid\s*=\s*["']?root["']?[\s>/]/i
const FULL_SHA = /^[0-9a-f]{40}$/

/** The newest migration file name of `dir` (the last by name, the same rule that migrate() uses), or null for none. */
export function newestMigration(dir = DEFAULT_DIR) {
  return migrationFiles(dir).at(-1) ?? null
}

/** Text that came from the network, made safe to print: letters, digits, space and a few marks, never a new line. */
export function printable(value, max = 60) {
  return String(value).replace(/[^A-Za-z0-9 _.()-]/g, '?').slice(0, max)
}

/**
 * The origin of the address to test, without a path or a user name. It must be https (the key travels to it), except
 * localhost, so that a copy on this machine can be tried.
 */
export function parseBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('SMOKE_BASE_URL is not a web address')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('SMOKE_BASE_URL must be an https address (http only for localhost), because the key is sent to it')
  }
  return url.origin
}

function wholeNumber(name, raw, fallback) {
  if (raw === undefined || String(raw).trim() === '') return fallback
  if (!/^[1-9]\d{0,8}$/.test(String(raw).trim())) throw new Error(`${name} must be a whole number of milliseconds`)
  return Number(String(raw).trim())
}

/** Reads and checks the environment. Throws an Error whose message is safe to print (it never holds a value). */
export function readConfig(env) {
  const sha = String(env.EXPECTED_SHA ?? '').trim().toLowerCase()
  if (!sha) throw new Error('EXPECTED_SHA is not set: it is the full 40-character SHA of the deployed commit')
  if (!FULL_SHA.test(sha)) throw new Error('EXPECTED_SHA is not a full 40-character SHA')
  const base = String(env.SMOKE_BASE_URL ?? '').trim()
  if (!base) {
    throw new Error(
      'SMOKE_BASE_URL is not set: it is the production domain, the repository variable of the same name (gh variable set SMOKE_BASE_URL --body https://<your-domain>)',
    )
  }
  const key = String(env.SMOKE_AGENT_KEY ?? '').trim() || null
  if (key && !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error('SMOKE_AGENT_KEY holds a space or another character that cannot be sent in a header (a bad paste?)')
  }
  return {
    baseUrl: parseBaseUrl(base),
    sha,
    key,
    timeoutMs: wholeNumber('SMOKE_TIMEOUT_MS', env.SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    intervalMs: wholeNumber('SMOKE_INTERVAL_MS', env.SMOKE_INTERVAL_MS, DEFAULT_INTERVAL_MS),
  }
}

/** One GET. Always resolves: { status, text } or { problem } (no answer). The query makes a cached answer impossible. */
async function get(fetchFn, now, baseUrl, pathname, { headers = {}, redirect = 'follow' } = {}) {
  try {
    const res = await fetchFn(`${baseUrl}${pathname}?smoke=${now()}`, {
      headers: { 'cache-control': 'no-cache', ...headers },
      redirect,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return { status: res.status, text: await res.text() }
  } catch (err) {
    return { problem: `no answer (${printable(err?.cause?.code ?? err?.name ?? 'error')})` }
  }
}

function parseObject(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** What one answer of /api/health says: { commit (a string or null), ok (the route said so), words (for a message) }. */
function readHealth(answer) {
  if (answer.problem) return { commit: null, ok: false, words: `it gave ${answer.problem}` }
  if (answer.status !== 200) return { commit: null, ok: false, words: `it answered HTTP ${answer.status}` }
  const body = parseObject(answer.text)
  if (!body) return { commit: null, ok: false, words: 'its answer is not the health answer' }
  const commit = typeof body.commit === 'string' && body.commit ? body.commit : null
  const ok = body.ok === true
  if (!commit) return { commit, ok, words: 'it serves no commit (an older deployment, or a build without Git data)' }
  return { commit, ok, words: `it serves ${printable(commit, 40)}` }
}

/**
 * Step 1. Polls until the domain serves `sha`, or the time is up. `now` and `sleep` are injected, so a test needs no wait.
 * Returns { ok, line }.
 */
export async function waitForCommit({ baseUrl, sha, fetch: fetchFn, sleep, now, timeoutMs, intervalMs }) {
  const want = sha.slice(0, 7)
  const start = now()
  const deadline = start + timeoutMs
  let checks = 0
  for (;;) {
    checks++
    const seen = readHealth(await get(fetchFn, now, baseUrl, '/api/health'))
    const seconds = Math.round((now() - start) / 1000)
    if (seen.ok && seen.commit === want) {
      return { ok: true, line: `production serves ${want} (${checks} ${checks === 1 ? 'check' : 'checks'}, ${seconds} s)` }
    }
    const left = deadline - now()
    if (left <= 0) {
      return { ok: false, line: `production does not serve ${want}, ${seen.words} (${checks} checks over ${seconds} s)` }
    }
    await sleep(Math.min(intervalMs, left))
  }
}

/** Step 2. The app page. Returns { ok, line }. */
export async function checkHome({ baseUrl, fetch: fetchFn, now }) {
  const answer = await get(fetchFn, now, baseUrl, '/')
  if (answer.problem) return { ok: false, line: `GET / gave ${answer.problem}` }
  if (answer.status !== 200) return { ok: false, line: `GET / answered HTTP ${answer.status}` }
  if (!ROOT_ELEMENT.test(answer.text)) {
    return { ok: false, line: 'GET / answered HTTP 200 but the page has no root element, so the app cannot start' }
  }
  return { ok: true, line: 'GET / returns the app page (HTTP 200, root element found)' }
}

/** Step 3. The database and its newest migration, with the agent key. Returns { ok, line }. */
export async function checkDatabase({ baseUrl, key, expected, fetch: fetchFn, sleep, now }) {
  if (!expected) return { ok: false, line: 'there is no migration file in db/migrations to compare with' }
  let answer
  for (let attempt = 1; attempt <= DB_ATTEMPTS; attempt++) {
    // A redirect is not followed: the key must not travel anywhere but to the address that was asked for.
    answer = await get(fetchFn, now, baseUrl, '/api/health/db', {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'manual',
    })
    const retry = answer.problem || answer.status >= 500
    if (!retry || attempt === DB_ATTEMPTS) break
    await sleep(DB_RETRY_MS)
  }
  if (answer.problem) return { ok: false, line: `GET /api/health/db gave ${answer.problem}` }
  if (answer.status === 401) {
    return {
      ok: false,
      line: 'the agent key was refused (HTTP 401): it is wrong or revoked, so make a new one and set the secret again',
    }
  }
  if (answer.status === 503) {
    return { ok: false, line: 'the database check failed (HTTP 503): this deployment cannot reach its database, see the Vercel logs' }
  }
  if (answer.status !== 200) return { ok: false, line: `GET /api/health/db answered HTTP ${answer.status}` }
  const body = parseObject(answer.text)
  if (!body || body.ok !== true || typeof body.migration !== 'string') {
    return { ok: false, line: 'GET /api/health/db answered HTTP 200 but not with the database health answer' }
  }
  if (body.migration !== expected) {
    return {
      ok: false,
      line: `the database is at ${printable(body.migration, 80)}, the code expects ${printable(expected, 80)}: the deployment skipped a migration`,
    }
  }
  return { ok: true, line: `database reachable, newest migration is ${printable(expected, 80)}` }
}

export const KEY_HELP =
  'SMOKE_AGENT_KEY is not set, so the database step was not run. Make a read-only key in the Agent tab of /admin ' +
  '(name it "smoke test") and run: gh secret set SMOKE_AGENT_KEY (paste the key at the prompt)'

/**
 * Runs the three steps. Everything it needs comes in as an argument, so a test can use a stub fetch and a fake clock.
 * `log` gets every line, `warn` gets the warning line (the workflow shows it as an annotation).
 * Returns { exitCode, failures (messages), warnings (messages) }.
 */
export async function runSmoke({
  env = {},
  fetch: fetchFn,
  sleep,
  now,
  log: write = console.log,
  warn: writeWarning = write,
  migrationsDir = DEFAULT_DIR,
}) {
  // Whatever a line is made of, the key is cut out of it before it is written (the lines are cleaned already: this is a
  // second net, for example against a server that repeats the key in a field that is printed).
  const hidden = String(env.SMOKE_AGENT_KEY ?? '').trim()
  const mask = (line) => (hidden ? line.split(hidden).join('[key]') : line)
  const log = (line) => write(mask(line))
  const warn = (line) => writeWarning(mask(line))
  let config
  try {
    config = readConfig(env)
  } catch (err) {
    log(`FAIL setup: ${err.message}`)
    return { exitCode: 1, failures: [err.message], warnings: [] }
  }
  const { baseUrl, sha, key, timeoutMs, intervalMs } = config
  const failures = []
  const warnings = []
  const report = (tag, step, result) => {
    log(`${tag} ${step}/3 ${result.line}`)
    if (!result.ok) failures.push(result.line)
  }

  const served = await waitForCommit({ baseUrl, sha, fetch: fetchFn, sleep, now, timeoutMs, intervalMs })
  report(served.ok ? 'ok  ' : 'FAIL', 1, served)

  if (served.ok) {
    const home = await checkHome({ baseUrl, fetch: fetchFn, now })
    report(home.ok ? 'ok  ' : 'FAIL', 2, home)

    if (key) {
      const database = await checkDatabase({ baseUrl, key, expected: newestMigration(migrationsDir), fetch: fetchFn, sleep, now })
      report(database.ok ? 'ok  ' : 'FAIL', 3, database)
    } else {
      warnings.push(KEY_HELP)
      warn(`warn 3/3 ${KEY_HELP}`)
    }
  } else {
    log('skip 2/3 and 3/3: they would test a different deployment than the one that was just deployed')
  }

  if (failures.length) {
    log(`Smoke test FAILED for ${sha.slice(0, 7)} on ${baseUrl}: ${failures.length} ${failures.length === 1 ? 'problem' : 'problems'}`)
    for (const failure of failures) log(`  - ${failure}`)
    return { exitCode: 1, failures, warnings }
  }
  const note = warnings.length ? ` (${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'})` : ''
  log(`Smoke test passed for ${sha.slice(0, 7)} on ${baseUrl}${note}`)
  return { exitCode: 0, failures, warnings }
}

async function main() {
  // On GitHub Actions a line that starts with ::warning:: becomes an annotation on the run, where a person will see it.
  const warn = process.env.GITHUB_ACTIONS === 'true' ? (line) => console.log(`::warning::${line}`) : console.log
  const result = await runSmoke({
    env: process.env,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: console.log,
    warn,
  })
  process.exitCode = result.exitCode
}

if (isMain(import.meta.url)) await main()
