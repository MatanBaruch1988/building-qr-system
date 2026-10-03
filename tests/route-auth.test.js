// Authorization is opt-in per handler: every committee route calls requireAdmin(req) itself, every provider route
// requireProvider(req), every agent route requireApiKey(req). A forgotten call would leave a route open and nothing
// would notice, so this test walks EVERY registered route (server/router.js, routeTable()) and proves that each route
// that is not on the PUBLIC list below refuses a request that carries no usable credentials.
//
// How it works:
//   - A route is protected unless it is on PUBLIC. A new route does not need an edit here when it checks authorization
//     first: it is picked up from the table and tested automatically.
//   - A new route that is meant to be open, and a protected route that forgets its check, both fail the same test:
//     the route answers something other than 401. The fix is the authorization call at the top of the handler, or an
//     entry in PUBLIC with the reason (a reviewer reads that line).
//   - Each protected route is called with no credentials, and with every kind of malformed credential (a cookie or a
//     bearer token that does not exist, with and without the prefixes qra_, qrp_ and qrk_). All of them must get a 401
//     that comes from an authorization check, and must not leak data or set a cookie.
//   - The last describe block proves that the check itself notices an open route, and one that validates its input
//     before it checks authorization.
// Some checks look the credential up in the database, so this runs against the throwaway schema like the other API
// tests. Random UUIDs stand in for path parameters, so even a route that was left open would find nothing to change.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { setupDb, call } from './helpers.js'
import '../server/index.js' // importing it registers every route file with the router
import { route, routeTable } from '../server/router.js'
import { requireAdmin } from '../server/auth.js'
import { bad, unauthorized } from '../server/http.js'
import { ADMIN_COOKIE } from '../server/config.js'

// The routes that are meant to answer without credentials, each with the reason. Everything else must refuse a request
// without credentials. Adding a route here, or making a protected route public, is a security decision: say why.
const PUBLIC = [
  { method: 'GET', path: '/health', why: 'Uptime monitor liveness check; answers ok and the commit, never queries the database.' },
  { method: 'GET', path: '/public/providers', why: 'Names for the provider login tiles, shown before anyone has signed in (company, contact name, service type only).' },
  { method: 'GET', path: '/public/points/resolve', why: 'Lets the phone show the name of a point before sign-in; returns name, description, active flag and GPS mode, never the token or the coordinates.' },
  { method: 'POST', path: '/session', why: 'Provider sign-in: the password in the body is the credential, and attempts are throttled.' },
  { method: 'POST', path: '/admin/google', why: 'Committee sign-in: the Google ID token in the body is the credential, checked with Google and against the committee list.' },
  { method: 'GET', path: '/admin/config', why: 'What the login screen needs to draw the Google button (the client id is public by design) and whether the dev shortcut is on.' },
  { method: 'POST', path: '/admin/dev-login', why: 'Local development shortcut; answers 404 unless DEV_ADMIN_LOGIN is 1 and the code is not running on Vercel.' },
  { method: 'POST', path: '/admin/logout', why: 'Ends the session named by the cookie, if there is one, and clears the cookie; works the same without a cookie and reveals nothing.' },
]

// Read once, before any test registers a route of its own, so that the generated tests are the routes of the real API.
const ROUTES = routeTable()
const keyOf = (r) => `${r.method} ${r.path}`
const publicKeys = new Set(PUBLIC.map(keyOf))
const PROTECTED = ROUTES.filter((r) => !publicKeys.has(keyOf(r)))

// The 401 codes that server/auth.js throws: a 401 for any other reason (a bad Google token, a wrong password) does not
// prove that an authorization check ran.
const GUARD_CODES = new Set(['admin_required', 'invalid_session', 'api_key_required', 'api_key_invalid'])

const token = (prefix = '') => prefix + randomBytes(32).toString('base64url')

// What a request can carry that is not a valid credential. Each entry builds fresh values, so no two routes share one.
const CREDENTIALS = [
  ['no credentials at all', () => ({})],
  ['an admin cookie that does not exist', () => ({ cookie: `${ADMIN_COOKIE}=${token()}` })],
  ['an admin cookie with the qra_ prefix that does not exist', () => ({ cookie: `${ADMIN_COOKIE}=${token('qra_')}` })],
  ['an admin cookie that cannot be decoded', () => ({ cookie: `${ADMIN_COOKIE}=%` })],
  ['an empty admin cookie', () => ({ cookie: `${ADMIN_COOKIE}=` })],
  ['a bearer token that does not exist', () => ({ token: token() })],
  ['a bearer token with the qrp_ prefix that does not exist', () => ({ token: token('qrp_') })],
  ['a bearer token with the qrk_ prefix that does not exist', () => ({ token: token('qrk_') })],
  ['an Authorization header with no token', () => ({ headers: { authorization: 'Bearer' } })],
  ['an Authorization header of another scheme', () => ({ headers: { authorization: `Basic ${token('qrk_')}` } })],
]

const HOW_TO_FIX =
  'A route that is not on the PUBLIC list of tests/route-auth.test.js must call requireAdmin, requireProvider or ' +
  'requireApiKey as the first thing its handler does (before it reads the body or looks anything up). If the route is ' +
  'meant to answer without credentials, add it to PUBLIC with the reason.'

/** Every way that `r` fails to refuse a request without usable credentials, as a list of sentences (empty when it is fine). */
async function authProblems(r) {
  const problems = []
  const path = '/api' + r.path.replace(/:[A-Za-z_]\w*/g, () => randomUUID())
  const withBody = r.method !== 'GET' && r.method !== 'HEAD'
  for (const [label, build] of CREDENTIALS) {
    const res = await call(r.method, path, { ...(withBody ? { body: {} } : {}), ...build() })
    const code = res.json?.error?.code
    if (res.status !== 401) {
      problems.push(`with ${label} it answered ${res.status}${code ? ` (${code})` : ''}, expected 401`)
    } else if (!GUARD_CODES.has(code)) {
      problems.push(`with ${label} it answered 401 (${code}), which is not an authorization check's code`)
    } else if (res.json && Object.keys(res.json).some((k) => k !== 'error')) {
      problems.push(`with ${label} the 401 holds more than an error: ${Object.keys(res.json).join(', ')}`)
    }
    if (res.headers['set-cookie'] !== undefined) problems.push(`with ${label} it set a cookie`)
  }
  return problems
}

let db

beforeAll(async () => {
  db = await setupDb()
})
afterAll(async () => db?.teardown())

describe('the route table', () => {
  it('is a frozen, read-only copy that shows only the method and the path as registered', () => {
    const table = routeTable()
    expect(Object.isFrozen(table)).toBe(true)
    expect(() => table.push({ method: 'GET', path: '/x' })).toThrow(TypeError)
    expect(() => {
      table[0].path = '/changed'
    }).toThrow(TypeError)
    for (const r of table) expect(Object.keys(r).sort()).toEqual(['method', 'path'])
    expect(routeTable()[0].path).not.toBe('/changed')
  })

  it('covers every route file, as the Vercel function serves them', () => {
    // api/index.js imports server/index.js, the same module this test imports.
    for (const prefix of ['/admin/', '/agent/v1/', '/public/', '/session', '/scan', '/health']) {
      expect(
        ROUTES.some((r) => r.path.startsWith(prefix)),
        `no route starts with ${prefix}`,
      ).toBe(true)
    }
  })

  it('lists every route once, in the form METHOD /path', () => {
    const keys = ROUTES.map(keyOf)
    expect(keys.filter((k, i) => keys.indexOf(k) !== i), 'registered twice').toEqual([])
    for (const r of ROUTES) {
      expect(r.method, keyOf(r)).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/)
      expect(r.path, keyOf(r)).toMatch(/^\/[A-Za-z0-9_\-/:]*$/)
    }
  })
})

describe('the PUBLIC list', () => {
  it('gives every entry a reason', () => {
    for (const p of PUBLIC) expect(p.why.trim().length, `${keyOf(p)} needs a reason`).toBeGreaterThanOrEqual(20)
  })

  it('names each route once, and only routes that exist (a removed route leaves no stale entry)', () => {
    const keys = PUBLIC.map(keyOf)
    expect(keys.filter((k, i) => keys.indexOf(k) !== i), 'listed twice').toEqual([])
    const registered = new Set(ROUTES.map(keyOf))
    expect(
      keys.filter((k) => !registered.has(k)),
      'on the PUBLIC list but not registered: remove it from PUBLIC (tests/route-auth.test.js)',
    ).toEqual([])
  })

  it('splits the table in two: every registered route is either public or protected', () => {
    expect(PROTECTED.length + PUBLIC.length).toBe(ROUTES.length)
    for (const r of ROUTES) expect(publicKeys.has(keyOf(r)) !== PROTECTED.includes(r), keyOf(r)).toBe(true)
  })
})

describe('every protected route refuses a request without usable credentials', () => {
  for (const r of PROTECTED) {
    it(`${r.method} ${r.path}`, async () => {
      const problems = await authProblems(r)
      expect(problems, `${keyOf(r)} is not on the PUBLIC list but does not refuse a request without credentials.\n${HOW_TO_FIX}\n`).toEqual([])
    })
  }
})

describe('the check itself', () => {
  it('shows a route that is added later in the table', () => {
    route('GET', '/canary/new-route', async () => ({ ok: true }))
    expect(routeTable().map(keyOf)).toContain('GET /canary/new-route')
    expect(ROUTES.map(keyOf)).not.toContain('GET /canary/new-route') // the generated tests do not move under it
  })

  it('catches a route that was added without an authorization check', async () => {
    route('GET', '/canary/open/:id', async () => ({ ok: true }))
    const problems = await authProblems({ method: 'GET', path: '/canary/open/:id' })
    expect(problems.length).toBe(CREDENTIALS.length) // every kind of request got a 200
    expect(problems[0]).toMatch(/no credentials at all it answered 200, expected 401/)
  })

  it('catches a route that validates its input before it checks authorization', async () => {
    route('POST', '/canary/validates-first', async ({ req, body }) => {
      if (!body.name) throw bad('missing_field', 'name is required')
      await requireAdmin(req)
      return { ok: true }
    })
    const problems = await authProblems({ method: 'POST', path: '/canary/validates-first' })
    expect(problems.length).toBe(CREDENTIALS.length)
    expect(problems[0]).toMatch(/answered 400 \(missing_field\), expected 401/)
  })

  it('catches a 401 that does not come from an authorization check', async () => {
    route('GET', '/canary/other-401', async () => {
      throw unauthorized('google_invalid')
    })
    const problems = await authProblems({ method: 'GET', path: '/canary/other-401' })
    expect(problems.length).toBe(CREDENTIALS.length)
    expect(problems[0]).toMatch(/answered 401 \(google_invalid\), which is not an authorization check's code/)
  })

  it('passes a route that checks authorization first, with a path parameter', async () => {
    route('POST', '/canary/guarded/:id', async ({ req }) => {
      await requireAdmin(req)
      return { ok: true }
    })
    expect(await authProblems({ method: 'POST', path: '/canary/guarded/:id' })).toEqual([])
  })
})
