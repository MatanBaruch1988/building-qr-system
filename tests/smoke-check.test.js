// The smoke test that runs after a production deployment (scripts/smoke-check.mjs, .github/workflows/smoke.yml).
// No network and no waiting: fetch is a stub that answers with real Response objects, and the clock is a fake that
// only moves when the script sleeps.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DB_ATTEMPTS,
  expectedPolicy,
  newestMigration,
  POLICY_HEADERS,
  parseBaseUrl,
  printable,
  readConfig,
  runSmoke,
} from '../scripts/smoke-check.mjs'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const BASE = 'https://smoke.example.test' // what the variable SMOKE_BASE_URL of the environment smoke holds in the workflow
const SHORT = SHA.slice(0, 7)
const OTHER = 'fedcba9'
const KEY = 'qrk_TEST_0123456789_abcdefghijklmnopq' // 37 characters
const LATEST = newestMigration() // the real newest file of db/migrations
const PAGE = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
// The page sends the Content-Security-Policy of the real vercel.json, as production does; a test that wants another one
// says so.
const POLICY = expectedPolicy()
const page = (body = PAGE, status = 200, headers = { [POLICY.name]: POLICY.value }) =>
  new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } })

/**
 * Runs the smoke test against a stub. `handlers` has one function per address: health(n), home(n) and db(n), each given
 * the number of the call (1, 2, ...) and returning a Response, or throwing to look like a network error. Everything that
 * is printed is collected in `lines`, and every request in `calls`.
 */
async function run({ health, home = () => page(), db, env = {}, migrationsDir, policy } = {}) {
  let clock = 1_000_000
  const lines = []
  const calls = []
  const counts = { health: 0, home: 0, db: 0 }
  const sleeps = []
  const stub = async (url, init = {}) => {
    const address = new URL(url)
    calls.push({ url: address, init })
    const name = address.pathname === '/api/health' ? 'health' : address.pathname === '/api/health/db' ? 'db' : 'home'
    const handler = { health, home, db }[name]
    if (!handler) throw new Error(`the test did not expect a request to ${address.pathname}`)
    counts[name]++
    return handler(counts[name])
  }
  const result = await runSmoke({
    env: { EXPECTED_SHA: SHA, SMOKE_BASE_URL: BASE, ...env },
    fetch: stub,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    log: (line) => lines.push(line),
    migrationsDir,
    ...(policy === undefined ? {} : { policy }),
  })
  return { ...result, lines, calls, counts, sleeps, output: lines.join('\n'), elapsed: clock - 1_000_000 }
}

const healthy = () => json({ ok: true, commit: SHORT })
const dbOk = () => json({ ok: true, commit: SHORT, migration: LATEST })

describe('a deployment that is fine', () => {
  it('passes at once when the commit already matches, and prints one line per step', async () => {
    const r = await run({ health: healthy, db: dbOk, env: { SMOKE_AGENT_KEY: KEY } })
    expect(r.exitCode).toBe(0)
    expect(r.failures).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.counts).toEqual({ health: 1, home: 1, db: 1 })
    expect(r.sleeps).toEqual([])
    expect(r.lines.filter((line) => /^ok {2} \d\/3 /.test(line))).toHaveLength(3)
    expect(r.lines.at(-1)).toBe(`Smoke test passed for ${SHORT} on ${BASE}`)
    expect(r.output).toContain(`production serves ${SHORT}`)
    expect(r.output).toContain(`newest migration is ${LATEST}`)
  })

  it('tests the origin of the address in SMOKE_BASE_URL, and only that one', async () => {
    const first = await run({ health: healthy })
    expect(new Set(first.calls.map((c) => c.url.origin))).toEqual(new Set([BASE]))
    const other = await run({ health: healthy, env: { SMOKE_BASE_URL: 'https://example.test/some/path?x=1' } })
    expect(new Set(other.calls.map((c) => c.url.origin))).toEqual(new Set(['https://example.test']))
  })

  it('accepts the SHA in upper case, with white space around it', async () => {
    const r = await run({ health: healthy, env: { EXPECTED_SHA: `  ${SHA.toUpperCase()}\n` } })
    expect(r.exitCode).toBe(0)
  })

  it('keeps asking until the commit matches, whatever the answers in between (old commit, error, no answer, no commit)', async () => {
    const answers = [
      () => json({ ok: true, commit: OTHER }),
      () => new Response('bad gateway', { status: 502 }),
      () => {
        throw new TypeError('fetch failed')
      },
      () => json({ ok: true, commit: null }),
      healthy,
    ]
    const r = await run({ health: (n) => answers[n - 1](), db: dbOk, env: { SMOKE_AGENT_KEY: KEY } })
    expect(r.exitCode).toBe(0)
    expect(r.counts.health).toBe(5)
    expect(r.sleeps).toEqual([10_000, 10_000, 10_000, 10_000])
    expect(r.output).toContain('(5 checks, 40 s)')
  })

  it('asks with a new query every time and tells caches not to answer', async () => {
    const answers = [() => json({ ok: true, commit: OTHER }), healthy]
    const r = await run({ health: (n) => answers[n - 1]() })
    const polls = r.calls.filter((c) => c.url.pathname === '/api/health')
    expect(polls).toHaveLength(2)
    expect(new Set(polls.map((c) => c.url.search)).size).toBe(2)
    for (const { url, init } of r.calls) {
      expect(url.searchParams.has('smoke')).toBe(true)
      expect(init.headers['cache-control']).toBe('no-cache')
    }
  })

  it('does not take a health answer that is not ok for the new deployment, even with the right commit', async () => {
    const r = await run({ health: () => json({ ok: false, commit: SHORT }), env: { SMOKE_TIMEOUT_MS: '30000' } })
    expect(r.exitCode).toBe(1)
  })
})

describe('step 1: the domain must serve the new commit', () => {
  it('fails with both commits in the message when it never does, after about five minutes, and does not test the old deployment', async () => {
    const r = await run({ health: () => json({ ok: true, commit: OTHER }), db: dbOk, env: { SMOKE_AGENT_KEY: KEY } })
    expect(r.exitCode).toBe(1)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain(`production does not serve ${SHORT}`)
    expect(r.failures[0]).toContain(`it serves ${OTHER}`)
    expect(r.output).toContain('FAIL 1/3')
    expect(r.elapsed).toBe(300_000)
    expect(r.counts.health).toBe(31)
    // Steps 2 and 3 would have tested the wrong deployment, so they did not run.
    expect(r.counts.home).toBe(0)
    expect(r.counts.db).toBe(0)
    expect(r.output).toContain('skip 2/3 and 3/3')
    expect(r.lines.at(-2)).toBe(`Smoke test FAILED for ${SHORT} on ${BASE}: 1 problem`)
  })

  it('says so when the last answer was no commit at all (a deployment from before the health route had one)', async () => {
    const r = await run({ health: () => json({ ok: true }), env: { SMOKE_TIMEOUT_MS: '30000', SMOKE_INTERVAL_MS: '10000' } })
    expect(r.exitCode).toBe(1)
    expect(r.failures[0]).toContain('it serves no commit')
    expect(r.counts.health).toBe(4)
  })

  it('says so when the site gives an error or no answer', async () => {
    const error = await run({ health: () => new Response('x', { status: 503 }), env: { SMOKE_TIMEOUT_MS: '20000' } })
    expect(error.failures[0]).toContain('it answered HTTP 503')
    const none = await run({
      health: () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
      },
      env: { SMOKE_TIMEOUT_MS: '20000' },
    })
    expect(none.failures[0]).toContain('no answer (ENOTFOUND)')
    const html = await run({ health: () => page('<html>Not found</html>'), env: { SMOKE_TIMEOUT_MS: '20000' } })
    expect(html.failures[0]).toContain('not the health answer')
  })

  it('can be given another timeout and interval', async () => {
    const r = await run({ health: () => json({ ok: true, commit: OTHER }), env: { SMOKE_TIMEOUT_MS: '1000', SMOKE_INTERVAL_MS: '400' } })
    expect(r.sleeps).toEqual([400, 400, 200])
    expect(r.counts.health).toBe(4)
  })
})

describe('step 2: the app page', () => {
  it('fails when the page has no root element', async () => {
    const r = await run({ health: healthy, home: () => page('<!doctype html><html><body>Hello</body></html>') })
    expect(r.exitCode).toBe(1)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toContain('no root element')
    expect(r.output).toContain('FAIL 2/3')
  })

  it('does not take an element that only has root in its id for the root', async () => {
    const r = await run({ health: healthy, home: () => page('<div id="rooted"></div><div class="root"></div>') })
    expect(r.exitCode).toBe(1)
  })

  it('fails on an error status and on no answer', async () => {
    const status = await run({ health: healthy, home: () => page(PAGE, 500) })
    expect(status.failures[0]).toContain('GET / answered HTTP 500')
    const none = await run({
      health: healthy,
      home: () => {
        throw new TypeError('fetch failed')
      },
    })
    expect(none.failures[0]).toContain('GET / gave no answer')
  })

  it('passes with the policy of vercel.json, and says which header it checked', async () => {
    const r = await run({ health: healthy })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain(`ok   2/3 GET / returns the app page (HTTP 200, root element found, ${POLICY.name} as in vercel.json)`)
  })

  it('fails when the page sends no policy, or the other kind of policy header than vercel.json sets', async () => {
    const none = await run({ health: healthy, home: () => page(PAGE, 200, {}) })
    expect(none.exitCode).toBe(1)
    expect(none.failures[0]).toBe(`GET / sends no ${POLICY.name} header, which vercel.json sets`)
    const otherName = POLICY_HEADERS.find((name) => name !== POLICY.name)
    const swapped = await run({ health: healthy, home: () => page(PAGE, 200, { [otherName]: POLICY.value }) })
    expect(swapped.exitCode).toBe(1)
    expect(swapped.failures[0]).toContain(`sends no ${POLICY.name} header`)
  })

  it('fails when the policy differs from vercel.json, and never prints what the server sent', async () => {
    const sent = "default-src * 'unsafe-inline' SERVER-SENT-THIS"
    const r = await run({ health: healthy, home: () => page(PAGE, 200, { [POLICY.name]: sent }) })
    expect(r.exitCode).toBe(1)
    expect(r.failures[0]).toBe(`GET / sends a ${POLICY.name} that is not the one in vercel.json`)
    expect(r.output).not.toContain('SERVER-SENT-THIS')
  })

  it('checks no header when vercel.json sets no policy', async () => {
    const r = await run({ health: healthy, home: () => page(PAGE, 200, {}), policy: null })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('ok   2/3 GET / returns the app page (HTTP 200, root element found)')
  })

  it('reads the policy from the rule of vercel.json for every page, enforced or report-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-policy-'))
    try {
      const file = path.join(dir, 'vercel.json')
      const write = (headers) =>
        fs.writeFileSync(file, JSON.stringify({ headers: [{ source: '/assets/(.*)', headers: [{ key: 'Content-Security-Policy', value: 'not this one' }] }, { source: '/(.*)', headers }] }))
      write([{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'Content-Security-Policy-Report-Only', value: "default-src 'self'" }])
      expect(expectedPolicy(file)).toEqual({ name: 'Content-Security-Policy-Report-Only', value: "default-src 'self'" })
      write([{ key: 'Content-Security-Policy', value: "default-src 'none'" }])
      expect(expectedPolicy(file)).toEqual({ name: 'Content-Security-Policy', value: "default-src 'none'" })
      write([{ key: 'X-Frame-Options', value: 'DENY' }])
      expect(expectedPolicy(file)).toBe(null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still runs the database step after a failed page, and reports both', async () => {
    const r = await run({ health: healthy, home: () => page('<p>x</p>'), db: dbOk, env: { SMOKE_AGENT_KEY: KEY } })
    expect(r.counts.db).toBe(1)
    expect(r.failures).toHaveLength(1)
  })
})

describe('step 3: the database and its migration', () => {
  it('fails when the database is behind the code, and names both', async () => {
    const r = await run({
      health: healthy,
      db: () => json({ ok: true, commit: SHORT, migration: '001_init.sql' }),
      env: { SMOKE_AGENT_KEY: KEY },
    })
    expect(r.exitCode).toBe(1)
    expect(r.failures).toEqual([`the database is at 001_init.sql, the code expects ${LATEST}: the deployment skipped a migration`])
    expect(r.output).toContain('FAIL 3/3')
  })

  it('sends the key as a bearer token, to the database route only, and does not follow a redirect', async () => {
    const r = await run({ health: healthy, db: dbOk, env: { SMOKE_AGENT_KEY: ` ${KEY}\n` } })
    const withKey = r.calls.filter((c) => c.init.headers.authorization)
    expect(withKey).toHaveLength(1)
    expect(withKey[0].url.pathname).toBe('/api/health/db')
    expect(withKey[0].init.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(withKey[0].init.redirect).toBe('manual')
  })

  it('treats a redirect and an unexpected status as failures', async () => {
    for (const status of [301, 404, 500]) {
      const r = await run({
        health: healthy,
        db: () => new Response('', { status, headers: status === 301 ? { location: 'https://evil.test/' } : {} }),
        env: { SMOKE_AGENT_KEY: KEY },
      })
      expect(r.exitCode, String(status)).toBe(1)
      expect(r.failures[0]).toContain(`HTTP ${status}`)
    }
  })

  it('fails on a 401 at once (no retry) and says what to do about the key', async () => {
    const r = await run({
      health: healthy,
      db: () => json({ error: { code: 'api_key_invalid', message: 'API key is invalid or revoked' } }, 401),
      env: { SMOKE_AGENT_KEY: KEY },
    })
    expect(r.exitCode).toBe(1)
    expect(r.counts.db).toBe(1)
    expect(r.failures[0]).toContain('HTTP 401')
    expect(r.failures[0]).toContain('make a new one')
  })

  it('fails on a 503 after trying again a few times, 5 s apart', async () => {
    const r = await run({ health: healthy, db: () => json({ ok: false, commit: SHORT }, 503), env: { SMOKE_AGENT_KEY: KEY } })
    expect(r.exitCode).toBe(1)
    expect(r.counts.db).toBe(DB_ATTEMPTS)
    expect(r.sleeps).toEqual([5_000, 5_000])
    expect(r.failures[0]).toContain('HTTP 503')
    expect(r.failures[0]).toContain('cannot reach its database')
  })

  it('passes when a sleeping database answers on the second try, and when the first try gets no answer', async () => {
    const slow = await run({
      health: healthy,
      db: (n) => (n === 1 ? json({ ok: false }, 503) : dbOk()),
      env: { SMOKE_AGENT_KEY: KEY },
    })
    expect(slow.exitCode).toBe(0)
    expect(slow.counts.db).toBe(2)
    const dropped = await run({
      health: healthy,
      db: (n) => {
        if (n === 1) throw new TypeError('fetch failed')
        return dbOk()
      },
      env: { SMOKE_AGENT_KEY: KEY },
    })
    expect(dropped.exitCode).toBe(0)
  })

  it('does not take an answer that is not the database health answer', async () => {
    const r = await run({ health: healthy, db: () => json({ ok: true, commit: SHORT }), env: { SMOKE_AGENT_KEY: KEY } })
    expect(r.exitCode).toBe(1)
    expect(r.failures[0]).toContain('not with the database health answer')
  })

  it('computes the newest migration from the folder it is given', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-migrations-'))
    try {
      for (const name of ['001_init.sql', '010_ten.sql', '002_two.sql', 'README.md']) fs.writeFileSync(path.join(dir, name), '-- x\n')
      expect(newestMigration(dir)).toBe('010_ten.sql')
      const ok = await run({
        health: healthy,
        db: () => json({ ok: true, commit: SHORT, migration: '010_ten.sql' }),
        env: { SMOKE_AGENT_KEY: KEY },
        migrationsDir: dir,
      })
      expect(ok.exitCode).toBe(0)
      const behind = await run({
        health: healthy,
        db: () => json({ ok: true, commit: SHORT, migration: '002_two.sql' }),
        env: { SMOKE_AGENT_KEY: KEY },
        migrationsDir: dir,
      })
      expect(behind.failures[0]).toContain('the database is at 002_two.sql, the code expects 010_ten.sql')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('has no migration to compare with in an empty folder: that is a failure, not a pass', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-empty-'))
    try {
      expect(newestMigration(dir)).toBeNull()
      const r = await run({ health: healthy, db: dbOk, env: { SMOKE_AGENT_KEY: KEY }, migrationsDir: dir })
      expect(r.exitCode).toBe(1)
      expect(r.counts.db).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('no key', () => {
  it('is a warning and not a failure, says how to set the key, and asks nothing of the database', async () => {
    for (const env of [{}, { SMOKE_AGENT_KEY: '' }, { SMOKE_AGENT_KEY: '  \n' }]) {
      const r = await run({ health: healthy, env })
      expect(r.exitCode).toBe(0)
      expect(r.failures).toEqual([])
      expect(r.warnings).toHaveLength(1)
      expect(r.counts.db).toBe(0)
      expect(r.output).toContain('warn 3/3')
      expect(r.output).toContain('gh secret set SMOKE_AGENT_KEY')
      expect(r.lines.at(-1)).toBe(`Smoke test passed for ${SHORT} on ${BASE} (1 warning)`)
    }
  })

  it('still fails when another step fails', async () => {
    const r = await run({ health: healthy, home: () => page('<p>x</p>') })
    expect(r.exitCode).toBe(1)
    expect(r.warnings).toHaveLength(1)
  })
})

describe('the key and the answers of the server are never printed', () => {
  it('prints the key in no line, in any outcome, also when the server repeats it, and prints no length either', async () => {
    const echoing = (status) => () => json({ ok: false, error: `bad key ${KEY}`, migration: KEY }, status)
    const scenarios = [
      { health: healthy, db: dbOk },
      { health: healthy, db: echoing(401) },
      { health: healthy, db: echoing(503) },
      { health: healthy, db: echoing(200) },
      { health: healthy, db: () => json({ ok: true, commit: SHORT, migration: `${KEY}_x.sql` }) },
      { health: () => json({ ok: true, commit: KEY }), db: dbOk },
      { health: healthy, home: () => page(`<p>${KEY}</p>`), db: dbOk },
    ]
    for (const scenario of scenarios) {
      const r = await run({ ...scenario, env: { SMOKE_AGENT_KEY: KEY, SMOKE_TIMEOUT_MS: '20000' } })
      expect(r.output).not.toContain(KEY)
      expect(r.output).not.toContain(KEY.slice(4, 20))
      expect(r.output).not.toMatch(new RegExp(`\\b${KEY.length}\\b`))
    }
  })

  it('prints a field of a health answer only after it is cleaned, so an answer cannot add a line or a command', async () => {
    const hostile = '1234567\n::error::pwned'
    const r = await run({ health: () => json({ ok: true, commit: hostile }), env: { SMOKE_TIMEOUT_MS: '10000' } })
    expect(r.failures[0]).toContain('it serves 1234567???error??pwned')
    expect(r.lines.every((line) => !line.includes('\n'))).toBe(true)
    expect(r.lines.every((line) => !line.startsWith('::'))).toBe(true)
    const db = await run({
      health: healthy,
      db: () => json({ ok: true, migration: '999_x.sql\n::error::pwned' }),
      env: { SMOKE_AGENT_KEY: KEY },
    })
    expect(db.failures[0]).toContain('the database is at 999_x.sql???error??pwned')
    expect(db.lines.every((line) => !line.startsWith('::'))).toBe(true)
  })

  it('prints no body of the app page', async () => {
    const r = await run({ health: healthy, home: () => page('<p>SECRET-PAGE-TEXT</p>') })
    expect(r.output).not.toContain('SECRET-PAGE-TEXT')
  })

  it('cleans text for the log', () => {
    expect(printable('005_delete_everywhere.sql')).toBe('005_delete_everywhere.sql')
    expect(printable('a\nb::c')).toBe('a?b??c')
    expect(printable('x'.repeat(100), 10)).toBe('xxxxxxxxxx')
  })
})

describe('a bad setup fails before any request', () => {
  it.each([
    ['no SHA', { EXPECTED_SHA: '' }, /EXPECTED_SHA is not set/],
    ['a short SHA', { EXPECTED_SHA: SHORT }, /not a full 40-character SHA/],
    ['a SHA with a letter that is not hex', { EXPECTED_SHA: `${SHA.slice(0, 39)}g` }, /not a full 40-character SHA/],
    ['no base URL (the variable of the environment is not set)', { SMOKE_BASE_URL: '' }, /SMOKE_BASE_URL is not set/],
    ['a base URL of white space only', { SMOKE_BASE_URL: '  \n' }, /SMOKE_BASE_URL is not set/],
    ['a base URL that is not an address', { SMOKE_BASE_URL: 'not a url' }, /not a web address/],
    ['a plain http base URL (the key would travel in the clear)', { SMOKE_BASE_URL: 'http://example.test' }, /must be an https address/],
    ['a key with a space inside', { SMOKE_AGENT_KEY: 'qrk_a b' }, /cannot be sent in a header/],
    ['a timeout that is not a number', { SMOKE_TIMEOUT_MS: 'soon' }, /SMOKE_TIMEOUT_MS must be a whole number/],
    ['an interval of zero', { SMOKE_INTERVAL_MS: '0' }, /SMOKE_INTERVAL_MS must be a whole number/],
  ])('%s', async (_name, env, message) => {
    const r = await run({ health: healthy, db: dbOk, env })
    expect(r.exitCode).toBe(1)
    expect(r.counts).toEqual({ health: 0, home: 0, db: 0 })
    expect(r.failures[0]).toMatch(message)
    expect(r.output).toMatch(/^FAIL setup: /)
    expect(r.output).not.toContain(KEY)
  })

  it('does not print a bad value back', async () => {
    const r = await run({ health: healthy, env: { SMOKE_AGENT_KEY: `${KEY} with a space` } })
    expect(r.output).not.toContain(KEY)
    const sha = await run({ health: healthy, env: { EXPECTED_SHA: 'SECRET-LOOKING-VALUE' } })
    expect(sha.output).not.toContain('SECRET-LOOKING-VALUE')
  })

  it('reads the defaults', () => {
    const config = readConfig({ EXPECTED_SHA: SHA, SMOKE_BASE_URL: BASE })
    expect(config).toMatchObject({ baseUrl: BASE, sha: SHA, key: null, timeoutMs: 300_000, intervalMs: 10_000 })
  })

  it('allows http for a copy on this machine, and drops the path and the user name of an address', () => {
    expect(parseBaseUrl('http://localhost:3101')).toBe('http://localhost:3101')
    expect(parseBaseUrl('http://127.0.0.1:3101/x')).toBe('http://127.0.0.1:3101')
    expect(parseBaseUrl('https://user:pass@example.test/a/b?c=d')).toBe('https://example.test')
  })
})
