// Authorization is opt-in per handler: every committee route calls requireAdmin(req) itself, every provider route
// requireProvider(req), every agent route requireApiKey(req). A forgotten call would leave a route open and nothing
// would notice, so this test walks EVERY registered route (server/router.js, routeTable()) and proves that each route
// that is not on the PUBLIC list below is guarded, and guarded by the right check.
//
// How it works:
//   - A route is protected unless it is on PUBLIC. A new route does not need an edit here when it checks authorization
//     first with the right guard: it is picked up from the table and tested automatically.
//   - The guard a protected route must use comes from its path (GUARDS below): /admin/ routes need a committee session,
//     /agent/v1/ routes and /health/db an agent key, the provider routes a provider device token. A protected route
//     that fits none of those rules fails loudly, so a new route group needs a rule here.
//   - Each protected route is called with no credentials, and with every kind of malformed credential (a cookie or a
//     bearer token that does not exist, with and without the prefixes of server/config.js). All of them must get a 401
//     with the code of THAT route's guard (not just any guard's), and must not leak data or set a cookie.
//   - The request with no credentials at all must also make ZERO database statements. Every guard refuses such a request
//     before it touches the database, so a handler that runs a query or a write before its guard (and only then refuses
//     with the right 401) would pass the checks above while an unauthenticated caller had already made it do protected
//     work. The pool is wrapped with a counter for that one request (a connection taken for a transaction counts too).
//     The variants with a malformed credential are not counted: a guard makes one lookup for a well-formed unknown token.
//   - Each protected route is also called with VALID credentials of the other two roles (a real committee session, a
//     real provider device token, a real agent key, all made in the throwaway schema), sent the usual way and the wrong
//     way round (a bearer token in the cookie, a cookie value as a bearer token). It must refuse them with the 401 of
//     its own guard, so a route that is switched to another role's guard is noticed.
//   - A new route that is meant to be open, a protected route that forgets its check, and one that uses the wrong
//     check all fail. The fix is the right authorization call at the top of the handler, or, for a route that is meant
//     to be open, an entry in PUBLIC with the reason (a reviewer reads that line).
//   - The last describe block proves that the checks notice these mistakes (an open route, a route that validates its
//     input before it checks authorization, a route that queries or writes before it checks authorization, and a route
//     guarded by another role's check).
// Credentials are looked up in the database, so this runs against the throwaway schema like the other API tests.
// Random UUIDs stand in for path parameters, so even a route that was left open would find nothing to change.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import '../server/index.js' // importing it registers every route file with the router
import { route, routeTable } from '../server/router.js'
import { requireAdmin, requireProvider, requireApiKey } from '../server/auth.js'
import { getPool, setPool, query, tx } from '../server/db.js'
import { bad, unauthorized } from '../server/http.js'
import { ADMIN_COOKIE, ADMIN_TOKEN_PREFIX, PROVIDER_TOKEN_PREFIX, API_KEY_PREFIX } from '../server/config.js'

// The routes that are meant to answer without credentials, each with the reason. Everything else must refuse a request
// without credentials. Adding a route here, or making a protected route public, is a security decision: say why.
const PUBLIC = [
  { method: 'GET', path: '/health', why: 'Uptime monitor liveness check; answers ok and the commit, never queries the database.' },
  { method: 'GET', path: '/public/providers', why: 'Names for the provider login tiles, shown before anyone has signed in (company, contact name, service type only).' },
  { method: 'GET', path: '/public/building', why: 'The building address for the header of the provider app, shown before sign-in; only the address, nothing else about the building.' },
  { method: 'GET', path: '/public/points/resolve', why: 'Lets the phone show the name of a point before sign-in; returns name, description, active flag and GPS mode, never the token or the coordinates.' },
  { method: 'POST', path: '/session', why: 'Provider sign-in: the password in the body is the credential, and attempts are throttled.' },
  { method: 'POST', path: '/admin/google', why: 'Committee sign-in: the Google ID token in the body is the credential, checked with Google and against the committee list.' },
  { method: 'GET', path: '/admin/config', why: 'What the login screen needs to draw the Google button (the client id is public by design) and whether the dev shortcut is on.' },
  { method: 'POST', path: '/admin/dev-login', why: 'Local development shortcut; answers 404 unless DEV_ADMIN_LOGIN is 1 and the code is not running on Vercel.' },
  { method: 'POST', path: '/admin/logout', why: 'Ends the session named by the cookie, if there is one, and clears the cookie; works the same without a cookie and reveals nothing.' },
]

// The three guards of server/auth.js. `owns` says which paths must use it. `missing` is the exact 401 code for a request
// that carries nothing of that kind (also what a valid credential of another role gets); `codes` is every 401 code the
// guard may give (an agent key that does not exist is api_key_invalid, one that is missing or has no agent key prefix is
// api_key_required). A 401 with any other code does not prove that this guard ran.
const GUARDS = {
  committee: { owns: /^\/admin\//, missing: 'admin_required', codes: ['admin_required'] },
  provider: { owns: /^\/(session|scan|scans\/sync|my\/.*)$/, missing: 'invalid_session', codes: ['invalid_session'] },
  agent: { owns: /^\/(agent\/v1\/.*|health\/db)$/, missing: 'api_key_required', codes: ['api_key_required', 'api_key_invalid'] },
}

/** The guard a protected route must use, from its path. Throws for a path that no rule owns (or that two rules own). */
function guardOf(path) {
  const owners = Object.keys(GUARDS).filter((name) => GUARDS[name].owns.test(path))
  if (owners.length !== 1) {
    throw new Error(
      `${path} fits ${owners.length === 0 ? 'no guard rule' : `several guard rules (${owners.join(', ')})`}. ` +
        'If the route is meant to answer without credentials, add it to PUBLIC (tests/route-auth.test.js) with the reason. ' +
        'Otherwise add or fix its rule in GUARDS so that the test knows which role it needs.',
    )
  }
  return owners[0]
}

// Read once, before any test registers a route of its own, so that the generated tests are the routes of the real API.
const ROUTES = routeTable()
const keyOf = (r) => `${r.method} ${r.path}`
const publicKeys = new Set(PUBLIC.map(keyOf))
const PROTECTED = ROUTES.filter((r) => !publicKeys.has(keyOf(r)))

const token = (prefix = '') => prefix + randomBytes(32).toString('base64url')

// What a request can carry that is not a valid credential. Each entry builds fresh values, so no two routes share one.
// The third item is true for the request with nothing at all, which must get the guard's exact `missing` code and must
// not make a single database statement (see countingPool).
const CREDENTIALS = [
  ['no credentials at all', () => ({}), true],
  ['an admin cookie that does not exist', () => ({ cookie: `${ADMIN_COOKIE}=${token()}` })],
  ['an admin cookie with the committee prefix that does not exist', () => ({ cookie: `${ADMIN_COOKIE}=${token(ADMIN_TOKEN_PREFIX)}` })],
  ['an admin cookie that cannot be decoded', () => ({ cookie: `${ADMIN_COOKIE}=%` })],
  ['an empty admin cookie', () => ({ cookie: `${ADMIN_COOKIE}=` })],
  ['a bearer token that does not exist', () => ({ token: token() })],
  ['a bearer token with the provider prefix that does not exist', () => ({ token: token(PROVIDER_TOKEN_PREFIX) })],
  ['a bearer token with the agent key prefix that does not exist', () => ({ token: token(API_KEY_PREFIX) })],
  ['an Authorization header with no token', () => ({ headers: { authorization: 'Bearer' } })],
  ['an Authorization header of another scheme', () => ({ headers: { authorization: `Basic ${token(API_KEY_PREFIX)}` } })],
]

// The secret of each role, made in beforeAll: the value of the committee session cookie, the provider device token
// from POST /session, and the agent key from POST /admin/api-keys.
let VALID = {}
const asCookie = (value) => ({ cookie: `${ADMIN_COOKIE}=${value}` })
const asBearer = (value) => ({ token: value })
// Where a role's secret normally travels, then the wrong place (it is still a valid secret, but sent the wrong way).
const PLACES = {
  committee: [['', asCookie], [' sent as a bearer token', asBearer]],
  provider: [['', asBearer], [' sent in the admin cookie', asCookie]],
  agent: [['', asBearer], [' sent in the admin cookie', asCookie]],
}

const HOW_TO_FIX =
  'A route that is not on the PUBLIC list of tests/route-auth.test.js must call its guard as the first thing its ' +
  'handler does (before it looks anything up or uses the body): requireAdmin for /admin/ routes, requireApiKey for ' +
  '/agent/v1/ routes and /health/db, requireProvider for the provider routes (see GUARDS). Nothing may run before ' +
  'that call: no query, no write, no transaction (a request without credentials must not touch the database at all). ' +
  'If the route is meant to answer without credentials, add it to PUBLIC with the reason.'

const urlOf = (r) => '/api' + r.path.replace(/:[A-Za-z_]\w*/g, () => randomUUID())
const bodyOf = (r) => (r.method !== 'GET' && r.method !== 'HEAD' ? { body: {} } : {})

/**
 * A stand-in for the pool of the throwaway schema that passes everything on to it and writes down every statement:
 * each `query` on the pool, each `query` on a client taken with `connect()`, and the `connect()` itself (a transaction
 * takes a client, so it always shows up). The statement is written down when it is asked for, not when it finishes, so a
 * query that nobody waits for is counted too.
 */
function countingPool(real) {
  const seen = []
  const note = (text) => seen.push(String(typeof text === 'string' ? text : text?.text).replace(/\s+/g, ' ').trim().slice(0, 70))
  return {
    seen,
    query: (text, params) => {
      note(text)
      return real.query(text, params)
    },
    connect: async () => {
      note('(a connection for a transaction)')
      const client = await real.connect()
      return {
        query: (text, params) => {
          note(text)
          return client.query(text, params)
        },
        release: (err) => client.release(err),
      }
    },
  }
}

/** Sends the request, and returns the response and, when `count` is set, every database statement it made (else null). */
async function sendRequest(r, creds, count) {
  const real = getPool()
  const counter = count ? countingPool(real) : null
  if (counter) setPool(counter)
  try {
    const res = await call(r.method, urlOf(r), { ...bodyOf(r), ...creds })
    return { res, statements: counter?.seen ?? null }
  } finally {
    if (counter) setPool(real)
  }
}

/**
 * One request that must be refused with the 401 of `guard`: the sentence that says how it was not, or null.
 * `exact`: the 401 code must be the guard's `missing` one. `noQueries`: the request must not touch the database.
 */
async function refusal(r, guard, label, creds, { exact = false, noQueries = false } = {}) {
  const { res, statements } = await sendRequest(r, creds, noQueries)
  const code = res.json?.error?.code
  const want = exact ? [GUARDS[guard].missing] : GUARDS[guard].codes
  const problems = []
  if (res.status !== 401) problems.push(`with ${label} it answered ${res.status}${code ? ` (${code})` : ''}, expected 401`)
  else if (!want.includes(code)) {
    problems.push(`with ${label} it answered 401 (${code}), expected ${want.join(' or ')} (the code of the ${guard} guard)`)
  } else if (res.json && Object.keys(res.json).some((k) => k !== 'error')) {
    problems.push(`with ${label} the 401 holds more than an error: ${Object.keys(res.json).join(', ')}`)
  } else if (res.headers['set-cookie'] !== undefined) problems.push(`with ${label} it set a cookie`)
  if (statements?.length) {
    problems.push(
      `with ${label} the handler of ${keyOf(r)} made ${statements.length} database statement${statements.length === 1 ? '' : 's'} before it refused ` +
        `(the first: ${statements[0]}). The authorization call must come first in the handler: a request without ` +
        'credentials must not make the database run anything',
    )
  }
  return problems.length ? problems.join('; ') : null
}

/** Every way that `r` fails to refuse a request without a valid credential of its own role, as sentences (empty when fine). */
async function authProblems(r, guard = guardOf(r.path)) {
  const problems = []
  for (const [label, build, nothing] of CREDENTIALS) {
    // The request with nothing at all gets the guard's exact code, and every guard refuses it before any query.
    const problem = await refusal(r, guard, label, build(), { exact: nothing, noQueries: nothing })
    if (problem) problems.push(problem)
  }
  return problems
}

/** Every way that `r` fails to refuse the VALID credentials of the other two roles, as sentences (empty when fine). */
async function crossRoleProblems(r, guard = guardOf(r.path)) {
  const problems = []
  for (const role of Object.keys(GUARDS).filter((name) => name !== guard)) {
    for (const [how, place] of PLACES[role]) {
      const problem = await refusal(r, guard, `a valid ${role} credential${how}`, place(VALID[role]), { exact: true })
      if (problem) problems.push(problem)
    }
  }
  return problems
}

let db

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  const cookie = await adminCookie()
  const provider = await call('POST', '/api/admin/providers', {
    cookie,
    body: { company: 'Route auth test company', contact_name: 'Route auth tester', password: 'route-auth-pass-1' },
  })
  const signedIn = await call('POST', '/api/session', {
    body: { provider_id: provider.json.provider.id, password: 'route-auth-pass-1' },
  })
  const key = await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'route-auth' } })
  VALID = {
    committee: cookie.slice(cookie.indexOf('=') + 1),
    provider: signedIn.json.token,
    agent: key.json.key,
  }
  // The three secrets must be real ones, or the cross-role tests below would prove nothing.
  expect(VALID.committee.startsWith(ADMIN_TOKEN_PREFIX)).toBe(true)
  expect(VALID.provider.startsWith(PROVIDER_TOKEN_PREFIX)).toBe(true)
  expect(VALID.agent.startsWith(API_KEY_PREFIX)).toBe(true)
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

describe('the guards', () => {
  it('every protected route belongs to exactly one guard, which says what credential it needs', () => {
    const unowned = []
    for (const r of PROTECTED) {
      try {
        guardOf(r.path)
      } catch (err) {
        unowned.push(`${keyOf(r)}: ${err.message}`)
      }
    }
    expect(unowned, `a protected route fits no single guard rule:\n${unowned.join('\n')}\n`).toEqual([])
  })

  it('fails loudly for a path that no rule owns', () => {
    expect(() => guardOf('/canary/unknown-group')).toThrow(/fits no guard rule/)
  })

  it('has a real committee session, provider device token and agent key, each accepted by its own routes', async () => {
    const sample = (guard) => PROTECTED.find((r) => r.method === 'GET' && !r.path.includes(':') && guardOf(r.path) === guard)
    const plain = {
      committee: asCookie(VALID.committee),
      provider: asBearer(VALID.provider),
      agent: asBearer(VALID.agent),
    }
    for (const guard of Object.keys(GUARDS)) {
      const r = sample(guard)
      expect(r, `no protected GET route without a parameter for the ${guard} guard`).toBeDefined()
      const res = await call(r.method, urlOf(r), plain[guard])
      expect(res.status, `${keyOf(r)} with a valid ${guard} credential: ${res.text}`).toBe(200)
    }
  })
})

describe('every protected route refuses a request without usable credentials', () => {
  for (const r of PROTECTED) {
    it(`${r.method} ${r.path}`, async () => {
      const problems = await authProblems(r)
      expect(problems, `${keyOf(r)} is not on the PUBLIC list but does not refuse a request without credentials (or does work before it refuses).\n${HOW_TO_FIX}\n`).toEqual([])
    })
  }
})

describe('every protected route refuses the valid credentials of the other roles', () => {
  for (const r of PROTECTED) {
    it(`${r.method} ${r.path}`, async () => {
      const problems = await crossRoleProblems(r)
      expect(problems, `${keyOf(r)} accepts a credential of another role (it needs the ${guardOf(r.path)} guard).\n${HOW_TO_FIX}\n`).toEqual([])
    })
  }
})

describe('the checks themselves', () => {
  it('show a route that is added later in the table', () => {
    route('GET', '/canary/new-route', async () => ({ ok: true }))
    expect(routeTable().map(keyOf)).toContain('GET /canary/new-route')
    expect(ROUTES.map(keyOf)).not.toContain('GET /canary/new-route') // the generated tests do not move under it
  })

  it('catch a route that was added without an authorization check', async () => {
    route('GET', '/canary/open/:id', async () => ({ ok: true }))
    const r = { method: 'GET', path: '/canary/open/:id' }
    const problems = await authProblems(r, 'committee')
    expect(problems.length).toBe(CREDENTIALS.length) // every kind of request got a 200
    expect(problems[0]).toMatch(/no credentials at all it answered 200, expected 401/)
    expect((await crossRoleProblems(r, 'committee')).length).toBe(4) // and so did every credential of the other roles
  })

  it('catch a route that validates its input before it checks authorization', async () => {
    route('POST', '/canary/validates-first', async ({ req, body }) => {
      if (!body.name) throw bad('missing_field', 'name is required')
      await requireAdmin(req)
      return { ok: true }
    })
    const r = { method: 'POST', path: '/canary/validates-first' }
    const problems = await authProblems(r, 'committee')
    expect(problems.length).toBe(CREDENTIALS.length)
    expect(problems[0]).toMatch(/answered 400 \(missing_field\), expected 401/)
    expect((await crossRoleProblems(r, 'committee')).length).toBe(4)
  })

  // A handler that does work before its guard and then refuses with the right 401: the status and the code are all
  // correct, so only the count of database statements of the request without credentials can show it.
  it('catch a route that runs a query before it checks authorization', async () => {
    route('GET', '/canary/queries-first', async ({ req }) => {
      await query('select 1 as one')
      await requireAdmin(req)
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary/queries-first' }
    const problems = await authProblems(r, 'committee')
    expect(problems.length).toBe(1) // the 401 and its code were right in every variant, only the request with nothing is counted
    expect(problems[0]).toMatch(/^with no credentials at all the handler of GET \/canary\/queries-first made 1 database statement before it refused/)
    expect(problems[0]).toMatch(/\(the first: select 1 as one\)/)
    expect(problems[0]).toMatch(/The authorization call must come first/)
    expect(problems[0]).not.toMatch(/answered/) // it did refuse with admin_required
    expect(await crossRoleProblems(r, 'committee')).toEqual([]) // the credentials of the other roles are still refused
    expect(getPool()).toBe(db.pool) // the counting pool was taken out again
  })

  it('catch a route that starts a transaction before it checks authorization', async () => {
    route('GET', '/canary/transaction-first', async ({ req }) => {
      await tx((c) => c.query('select 1 as one'))
      await requireProvider(req)
      return { ok: true }
    })
    const problems = await authProblems({ method: 'GET', path: '/canary/transaction-first' }, 'provider')
    expect(problems.length).toBe(1)
    expect(problems[0]).toMatch(/made 4 database statements before it refused \(the first: \(a connection for a transaction\)\)/) // connect, begin, select, commit
  })

  it('catch a route that writes before it checks authorization, which an unauthenticated caller could then trigger', async () => {
    await db.pool.query('create table canary_writes_first (n int not null)')
    try {
      route('POST', '/canary/writes-first', async ({ req }) => {
        await query('insert into canary_writes_first (n) values (1)')
        await requireApiKey(req)
        return { ok: true }
      })
      const problems = await authProblems({ method: 'POST', path: '/canary/writes-first' }, 'agent')
      expect(problems.length).toBe(1)
      expect(problems[0]).toMatch(/made 1 database statement before it refused \(the first: insert into canary_writes_first/)
      // The unauthenticated request really did write a row, although every response was a clean 401.
      const { rows } = await db.pool.query('select count(*)::int as n from canary_writes_first')
      expect(rows[0].n).toBeGreaterThanOrEqual(1)
    } finally {
      await db.pool.query('drop table canary_writes_first')
    }
  })

  it('pass a route that queries only after its guard let the request in', async () => {
    route('GET', '/canary/queries-after', async ({ req }) => {
      await requireAdmin(req)
      await query('select 1 as one')
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary/queries-after' }
    expect(await authProblems(r, 'committee')).toEqual([])
    expect(await crossRoleProblems(r, 'committee')).toEqual([])
    // With a real session it gets past the guard and does run its query (so the canary is not simply a dead route).
    expect((await call('GET', '/api/canary/queries-after', asCookie(VALID.committee))).status).toBe(200)
  })

  it('catch a 401 that does not come from an authorization check', async () => {
    route('GET', '/canary/other-401', async () => {
      throw unauthorized('google_invalid')
    })
    const problems = await authProblems({ method: 'GET', path: '/canary/other-401' }, 'committee')
    expect(problems.length).toBe(CREDENTIALS.length)
    expect(problems[0]).toMatch(/answered 401 \(google_invalid\), expected admin_required/)
  })

  // A route that is guarded, but by another role's check: the case that every credential being invalid cannot show.
  const checks = { committee: requireAdmin, provider: requireProvider, agent: requireApiKey }
  for (const needs of Object.keys(GUARDS)) {
    for (const uses of Object.keys(GUARDS).filter((name) => name !== needs)) {
      it(`catch a route of the ${needs} role that is guarded by the ${uses} check`, async () => {
        const path = `/canary/${needs}-route-with-${uses}-check`
        route('GET', path, async ({ req }) => {
          await checks[uses](req)
          return { ok: true }
        })
        const r = { method: 'GET', path }
        // With no credentials it still answers 401, but with the wrong guard's code.
        const missing = await authProblems(r, needs)
        expect(missing.length).toBeGreaterThan(0)
        expect(missing[0]).toMatch(new RegExp(`expected ${GUARDS[needs].missing} \\(the code of the ${needs} guard\\)`))
        // And a valid credential of the role that the route really checks gets in (a 200), which is the real danger.
        const cross = await crossRoleProblems(r, needs)
        expect(cross.length).toBeGreaterThan(0)
        expect(cross.some((p) => p.includes(`valid ${uses} credential`) && /answered 200/.test(p))).toBe(true)
      })
    }
  }

  for (const guard of Object.keys(GUARDS)) {
    it(`pass a route of the ${guard} role that checks the ${guard} guard first, with a path parameter`, async () => {
      const path = `/canary/guarded-${guard}/:id`
      route('POST', path, async ({ req }) => {
        await checks[guard](req)
        return { ok: true }
      })
      const r = { method: 'POST', path }
      expect(await authProblems(r, guard)).toEqual([])
      expect(await crossRoleProblems(r, guard)).toEqual([])
    })
  }
})
