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
//   - A refused request must make exactly the database statements that its guard makes on its own, and nothing else.
//     A handler that runs a query or a write before its guard (and only then refuses with the right 401) would pass the
//     checks above while the caller had already made it do protected work, and it can do so only for some requests
//     (when a cookie is present, when an Authorization header is). So the pool is wrapped with a counter for every
//     request of this test (a connection taken for a transaction counts too), and the statements of the request are
//     compared, text by text and in order, with those of the same request (method and credentials) sent to a test-only
//     route whose handler is just the guard. The request with no credentials at all must make ZERO statements. The
//     counter writes a statement down when it is asked for, so nothing in the comparison depends on timing.
//   - A refused request must not touch its body at all. Every request that has a body (any method but GET and HEAD) is
//     sent a body that writes down every access (a Proxy over an empty object, see watchedBody), so the test does not
//     guess which field a handler looks at: a read, `in`, Object.keys, a validation, any write counts. Nothing the guard
//     does touches it (a test proves that), so the guard has run before any use of the body when the list is empty.
//   - Each protected route is also called with VALID credentials of the other two roles (a real committee session, a
//     real provider device token, a real agent key, all made in the throwaway schema), sent the usual way and the wrong
//     way round (a bearer token in the cookie, a cookie value as a bearer token). It must refuse them with the 401 of
//     its own guard, so a route that is switched to another role's guard is noticed.
//   - A new route that is meant to be open, a protected route that forgets its check, and one that uses the wrong
//     check all fail. The fix is the right authorization call at the top of the handler, or, for a route that is meant
//     to be open, an entry in PUBLIC with the reason (a reviewer reads that line).
//   - The last describe block proves that the checks notice these mistakes (an open route, a route that validates its
//     input before it checks authorization, a route that queries or writes before it checks authorization, always or
//     only when a cookie or an Authorization header is present, a route that uses its body before it checks
//     authorization, and a route guarded by another role's check).
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

const checks = { committee: requireAdmin, provider: requireProvider, agent: requireApiKey }

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
// not make a single database statement (see countingPool). Every other request must make the statements of its guard
// alone (see refusal).
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
  'that call, for any kind of request (a cookie, an Authorization header, none): no query, no write, no transaction, ' +
  'and no use of the body (not a read of a field, not `in`, not Object.keys, not a validation). ' +
  'Until the guard has refused, the route may make only the statements that the guard makes on its own, and a request ' +
  'without credentials must not touch the database at all. ' +
  'If the route is meant to answer without credentials, add it to PUBLIC with the reason.'

const urlOf = (r) => '/api' + r.path.replace(/:[A-Za-z_]\w*/g, () => randomUUID())
const hasBody = (r) => r.method !== 'GET' && r.method !== 'HEAD'

/**
 * The body of a request that writes down every way a handler can use it. It is an empty object behind a Proxy whose traps
 * cover everything that can reveal or change its content (a read, `in`, the list of keys, the descriptor of a key, the
 * prototype, and every write), so the test does not have to guess which field a handler looks at. call() in helpers.js
 * puts it on `req.body` as it is, and readBody() in server/router.js only checks `typeof` and `Array.isArray` and hands it
 * on, and neither of those reaches a trap (a test below proves it), so every touch written down is the handler's own.
 */
function watchedBody() {
  const touched = []
  const note = (what, key) => touched.push(key === undefined ? what : `${what} ${String(key)}`)
  const body = new Proxy(
    {},
    {
      get: (t, k, rcv) => (note('read', k), Reflect.get(t, k, rcv)),
      has: (t, k) => (note('check for', k), Reflect.has(t, k)),
      ownKeys: (t) => (note('list the keys'), Reflect.ownKeys(t)),
      getOwnPropertyDescriptor: (t, k) => (note('inspect', k), Reflect.getOwnPropertyDescriptor(t, k)),
      getPrototypeOf: (t) => (note('read the prototype'), Reflect.getPrototypeOf(t)),
      isExtensible: (t) => (note('ask if it is extensible'), Reflect.isExtensible(t)),
      set: (t, k, v, rcv) => (note('write', k), Reflect.set(t, k, v, rcv)),
      defineProperty: (t, k, d) => (note('define', k), Reflect.defineProperty(t, k, d)),
      deleteProperty: (t, k) => (note('delete', k), Reflect.deleteProperty(t, k)),
      setPrototypeOf: (t, p) => (note('change the prototype'), Reflect.setPrototypeOf(t, p)),
      preventExtensions: (t) => (note('seal'), Reflect.preventExtensions(t)),
    },
  )
  return { body, touched }
}

/**
 * A stand-in for the pool of the throwaway schema that passes everything on to it and writes down every statement:
 * each `query` on the pool, each `query` on a client taken with `connect()`, and the `connect()` itself (a transaction
 * takes a client, so it always shows up). The statement is written down when it is asked for, not when it finishes, so a
 * query that nobody waits for is counted too.
 */
function countingPool(real) {
  const seen = []
  const note = (text) => seen.push(String(typeof text === 'string' ? text : text?.text).replace(/\s+/g, ' ').trim())
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

// A test-only route per guard and per method whose handler is just the guard. It measures what a guard makes on its own
// for a given request. The routes are registered in beforeAll, after ROUTES was read, so they are never walked as routes
// of the API (see the test that says so).
const GUARD_ALONE = '/canary/guard-alone'
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const guardAloneRoute = (guard, method) => ({ method, path: `${GUARD_ALONE}/${guard}` })
const shown = (text) => (text.length > 70 ? `${text.slice(0, 67)}...` : text)

/**
 * Sends the request through a counting pool, with a watched body when the method carries one, and returns the response,
 * every database statement it made (in order) and every way the handler touched the body (empty for a method without one).
 */
async function sendRequest(r, creds) {
  const real = getPool()
  const counter = countingPool(real)
  const watched = hasBody(r) ? watchedBody() : null
  setPool(counter)
  try {
    const res = await call(r.method, urlOf(r), { ...(watched ? { body: watched.body } : {}), ...creds })
    return { res, statements: counter.seen, touched: watched?.touched ?? [] }
  } finally {
    setPool(real)
  }
}

/**
 * The sentence that says that the handler used the request body before it refused, or null. A refused request must not
 * have touched the body at all: the guard runs before any use of it, whatever the field or the way it is looked at.
 */
function bodyProblem(r, label, touched) {
  if (!touched.length) return null
  const list = touched.slice(0, 3).join(', ') + (touched.length > 3 ? ` and ${touched.length - 3} more` : '')
  return (
    `with ${label} the handler of ${keyOf(r)} used the request body before it refused (it did: ${list}). The authorization ` +
    'call must come first in the handler: nothing may read, check or validate the body before the guard has refused the request'
  )
}

/**
 * How the statements of a request (`actual`) differ from the ones its guard makes on its own for the same request
 * (`expected`), as a sentence, or null when they are the same texts in the same order. An extra or a different statement
 * names the first one that does not belong; fewer statements mean that the guard of this role did not run in full.
 */
function statementProblem(r, guard, label, actual, expected) {
  const count = (list) => `${list.length} database statement${list.length === 1 ? '' : 's'}`
  const who = `with ${label} the handler of ${keyOf(r)}`
  const at = actual.findIndex((text, i) => text !== expected[i])
  if (at !== -1 && expected.length === 0) {
    return (
      `${who} made ${count(actual)} before it refused (the first: ${shown(actual[at])}). The authorization call must ` +
      'come first in the handler: the guard alone makes no database statement for this request, so neither may the handler'
    )
  }
  if (at !== -1) {
    return (
      `${who} made ${count(actual)}, but the ${guard} guard alone makes ${count(expected)} for the same request, and the ` +
      `first statement that is not the guard's own is number ${at + 1}: ${shown(actual[at])}. The authorization call must ` +
      "come first in the handler: until it has refused the request, nothing but the guard's own statements may run"
    )
  }
  if (actual.length < expected.length) {
    return `${who} made ${count(actual)} but the ${guard} guard alone makes ${count(expected)} for the same request: the guard of this role did not run in full`
  }
  return null
}

/**
 * One request that must be refused with the 401 of `guard`: the sentence that says how it was not, or null.
 * `exact`: the 401 code must be the guard's `missing` one. `nothing`: the request carries no credentials, so it must not
 * touch the database; any other request must make the statements that its guard makes on its own, measured by sending
 * the same method and the very same credentials to the guard-alone route (the answer is not looked at, only the statements).
 */
async function refusal(r, guard, label, creds, { exact = false, nothing = false } = {}) {
  const { res, statements, touched } = await sendRequest(r, creds)
  const expected = nothing ? [] : (await sendRequest(guardAloneRoute(guard, r.method), creds)).statements
  const code = res.json?.error?.code
  const want = exact ? [GUARDS[guard].missing] : GUARDS[guard].codes
  const problems = []
  if (res.status !== 401) problems.push(`with ${label} it answered ${res.status}${code ? ` (${code})` : ''}, expected 401`)
  else if (!want.includes(code)) {
    problems.push(`with ${label} it answered 401 (${code}), expected ${want.join(' or ')} (the code of the ${guard} guard)`)
  } else if (res.json && Object.keys(res.json).some((k) => k !== 'error')) {
    problems.push(`with ${label} the 401 holds more than an error: ${Object.keys(res.json).join(', ')}`)
  } else if (res.headers['set-cookie'] !== undefined) problems.push(`with ${label} it set a cookie`)
  const extra = statementProblem(r, guard, label, statements, expected)
  if (extra) problems.push(extra)
  const used = bodyProblem(r, label, touched)
  if (used) problems.push(used)
  return problems.length ? problems.join('; ') : null
}

/** Every way that `r` fails to refuse a request without a valid credential of its own role, as sentences (empty when fine). */
async function authProblems(r, guard = guardOf(r.path)) {
  const problems = []
  for (const [label, build, nothing] of CREDENTIALS) {
    // The request with nothing at all gets the guard's exact code, and every guard refuses it before any query.
    const problem = await refusal(r, guard, label, build(), { exact: nothing, nothing })
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
  // After ROUTES was read at the top of this file, so these routes are not part of the walked table.
  for (const guard of Object.keys(GUARDS)) {
    for (const method of METHODS) {
      route(method, guardAloneRoute(guard, method).path, async ({ req }) => {
        await checks[guard](req)
        return { ok: true }
      })
    }
  }
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

  it('keeps the test-only routes that measure a guard alone out of the walked table', () => {
    expect(ROUTES.filter((r) => r.path.startsWith(GUARD_ALONE))).toEqual([])
    expect(PROTECTED.filter((r) => r.path.startsWith(GUARD_ALONE))).toEqual([])
    // They are registered (that is how a request reaches them), after the walked table was read.
    const live = routeTable().map(keyOf)
    for (const guard of Object.keys(GUARDS)) {
      for (const method of METHODS) expect(live).toContain(keyOf(guardAloneRoute(guard, method)))
    }
  })

  it('measures each guard on its own: no statement without credentials, a lookup for a credential it can look up', async () => {
    const own = { committee: asCookie(VALID.committee), provider: asBearer(VALID.provider), agent: asBearer(VALID.agent) }
    // A token shaped like the guard's own kind, that does not exist: the guard has to look it up to refuse it.
    const unknown = {
      committee: asCookie(token(ADMIN_TOKEN_PREFIX)),
      provider: asBearer(token(PROVIDER_TOKEN_PREFIX)),
      agent: asBearer(token(API_KEY_PREFIX)),
    }
    for (const guard of Object.keys(GUARDS)) {
      const alone = guardAloneRoute(guard, 'GET')
      const nothing = await sendRequest(alone, {})
      expect(nothing.res.json?.error?.code, guard).toBe(GUARDS[guard].missing)
      expect(nothing.statements, `the ${guard} guard must refuse a request with no credentials before any query`).toEqual([])
      const missing = await sendRequest(alone, unknown[guard])
      expect(missing.res.status, guard).toBe(401)
      expect(missing.statements.length, `the ${guard} guard looks up a credential that is shaped like its own`).toBeGreaterThanOrEqual(1)
      const accepted = await sendRequest(alone, own[guard])
      expect(accepted.res.status, guard).toBe(200)
      expect(accepted.statements.length, `the ${guard} guard looks up a valid credential`).toBeGreaterThanOrEqual(1)
    }
  })

  it('never touches the request body in a guard, whatever it is sent, so a touch before the guard is always the handler\'s', async () => {
    const own = { committee: asCookie(VALID.committee), provider: asBearer(VALID.provider), agent: asBearer(VALID.agent) }
    const unknown = {
      committee: asCookie(token(ADMIN_TOKEN_PREFIX)),
      provider: asBearer(token(PROVIDER_TOKEN_PREFIX)),
      agent: asBearer(token(API_KEY_PREFIX)),
    }
    for (const guard of Object.keys(GUARDS)) {
      for (const method of METHODS.filter((m) => hasBody({ method: m }))) {
        for (const [what, creds] of [['no credentials', {}], ['an unknown token', unknown[guard]], ['a valid credential', own[guard]]]) {
          const { touched } = await sendRequest(guardAloneRoute(guard, method), creds)
          expect(touched, `${method} through the ${guard} guard alone with ${what}`).toEqual([])
        }
      }
    }
  })

  it('hands the watched body to the handler as it is: call() and the router check only its type', async () => {
    let received
    route('POST', '/canary/body-received', async ({ body }) => {
      received = body
      return { ok: true }
    })
    const watched = watchedBody()
    const res = await call('POST', '/api/canary/body-received', { body: watched.body })
    expect(res.status).toBe(200)
    // Compared outside expect(), which is not told about the Proxy: the same object, not a copy and not a serialised one.
    const same = received === watched.body
    expect(same).toBe(true)
    const touchedByTheRouter = [...watched.touched]
    expect(touchedByTheRouter, 'call(), assertSafeWrite and readBody must not reach a trap').toEqual([])
    void received.name // and a use by the handler is written down
    expect(watched.touched).toEqual(['read name'])
  })

  // Every way to look at the body that a handler could use, each alone: the first thing written down says which.
  const USES = [
    ['a read of a field', (b) => b.name, 'read name'],
    ['a destructured field', (b) => { const { name } = b; return name }, 'read name'],
    ['the in operator', (b) => 'name' in b, 'check for name'],
    ['Object.keys', (b) => Object.keys(b), 'list the keys'],
    ['Object.entries', (b) => Object.entries(b), 'list the keys'],
    ['a spread', (b) => ({ ...b }), 'list the keys'],
    ['Object.hasOwn', (b) => Object.hasOwn(b, 'name'), 'inspect name'],
    ['JSON.stringify', (b) => JSON.stringify(b), 'read toJSON'],
    ['the prototype', (b) => Object.getPrototypeOf(b), 'read the prototype'],
    ['instanceof', (b) => b instanceof Object, 'read the prototype'],
    ['a write of a field', (b) => { b.name = 'x' }, 'write name'],
    ['a delete of a field', (b) => delete b.name, 'delete name'],
    ['defineProperty', (b) => Object.defineProperty(b, 'name', { value: 'x' }), 'define name'],
    ['preventExtensions', (b) => Object.preventExtensions(b), 'seal'],
  ]
  for (const [what, use, first] of USES) {
    it(`writes down ${what} of the body`, () => {
      const watched = watchedBody()
      use(watched.body)
      expect(watched.touched[0]).toBe(first)
    })
  }

  it('does not write down what readBody does with the body: typeof, Array.isArray, truthiness and identity', () => {
    const { body, touched } = watchedBody()
    expect(body && typeof body === 'object' && !Array.isArray(body)).toBe(true)
    expect(body === body).toBe(true)
    expect(touched).toEqual([])
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
    // Two checks catch this one, each on its own: the status (a 400 where the guard's 401 belongs), and the body check
    // (the handler read `name` before the guard). The body check alone catches the same mistake when the answer is a 401.
    for (const p of problems) expect(p).toMatch(/used the request body before it refused \(it did: read name\)/)
    const cross = await crossRoleProblems(r, 'committee')
    expect(cross.length).toBe(4)
    for (const p of cross) expect(p).toMatch(/answered 400 \(missing_field\)(.|\n)*read name/)
  })

  // A handler that does work before its guard and then refuses with the right 401: the status and the code are all
  // correct, so only the database statements of the request can show it. Work that happens for every kind of request is
  // seen in every variant; the two checks differ only in what they compare with (nothing, or the guard on its own).
  it('catch a route that runs a query before it checks authorization', async () => {
    route('GET', '/canary/queries-first', async ({ req }) => {
      await query('select 1 as one')
      await requireAdmin(req)
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary/queries-first' }
    const problems = await authProblems(r, 'committee')
    expect(problems.length).toBe(CREDENTIALS.length) // the extra statement shows in every variant, the 401 and its code were right in all
    expect(problems[0]).toMatch(/^with no credentials at all the handler of GET \/canary\/queries-first made 1 database statement before it refused/)
    expect(problems[0]).toMatch(/\(the first: select 1 as one\)/)
    for (const p of problems) {
      expect(p).toMatch(/select 1 as one/)
      expect(p).toMatch(/The authorization call must come first/)
      expect(p).not.toMatch(/answered/) // it did refuse with admin_required
    }
    const cross = await crossRoleProblems(r, 'committee')
    expect(cross.length).toBe(4) // and so does every credential of the other roles
    for (const p of cross) expect(p).toMatch(/select 1 as one/)
    expect(getPool()).toBe(db.pool) // the counting pool was taken out again
  })

  it('catch a route that starts a transaction before it checks authorization', async () => {
    route('GET', '/canary/transaction-first', async ({ req }) => {
      await tx((c) => c.query('select 1 as one'))
      await requireProvider(req)
      return { ok: true }
    })
    const problems = await authProblems({ method: 'GET', path: '/canary/transaction-first' }, 'provider')
    expect(problems.length).toBe(CREDENTIALS.length)
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
      expect(problems.length).toBe(CREDENTIALS.length)
      expect(problems[0]).toMatch(/made 1 database statement before it refused \(the first: insert into canary_writes_first/)
      // The unauthenticated request really did write a row, although every response was a clean 401.
      const { rows } = await db.pool.query('select count(*)::int as n from canary_writes_first')
      expect(rows[0].n).toBeGreaterThanOrEqual(1)
    } finally {
      await db.pool.query('drop table canary_writes_first')
    }
  })

  // Work before the guard that happens only when the request carries something. The request with no credentials at all
  // stays clean (zero statements), so the zero-statement check passes these routes: only the comparison with the guard on
  // its own can catch them, and it must catch every variant that carries the thing the handler looks at.
  it('catch a route that queries before its guard only when a cookie is present', async () => {
    route('GET', '/canary/queries-first-with-cookie', async ({ req }) => {
      if (req.headers.cookie) await query('select 1 as one')
      await requireAdmin(req)
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary/queries-first-with-cookie' }
    const problems = await authProblems(r, 'committee')
    expect(problems.some((p) => p.startsWith('with no credentials at all'))).toBe(false) // the zero-statement check is not what catches it
    expect(problems.length).toBe(4) // the four variants with the admin cookie (the ones with a bearer token stay clean)
    for (const p of problems) {
      expect(p).toMatch(/^with (an admin cookie|an empty admin cookie)/)
      expect(p).toMatch(/select 1 as one/)
      expect(p).toMatch(/The authorization call must come first/)
    }
    const cross = await crossRoleProblems(r, 'committee')
    expect(cross.length).toBe(2) // a provider token and an agent key sent in the admin cookie
    for (const p of cross) {
      expect(p).toMatch(/^with a valid (provider|agent) credential sent in the admin cookie/)
      expect(p).toMatch(/select 1 as one/)
    }
  })

  it('catch a route that queries before its guard only when an Authorization header is present', async () => {
    route('GET', '/canary/queries-first-with-authorization', async ({ req }) => {
      if (req.headers.authorization) await query('select 1 as one')
      await requireProvider(req)
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary/queries-first-with-authorization' }
    const problems = await authProblems(r, 'provider')
    expect(problems.some((p) => p.startsWith('with no credentials at all'))).toBe(false)
    expect(problems.length).toBe(5) // four kinds of bearer token (one with no token) and the header of another scheme
    for (const p of problems) {
      expect(p).toMatch(/^with (a bearer token|an Authorization header)/)
      expect(p).toMatch(/select 1 as one/)
    }
    const cross = await crossRoleProblems(r, 'provider')
    expect(cross.length).toBe(2) // the committee session and the agent key, each sent as a bearer token
    for (const p of cross) {
      expect(p).toMatch(/^with a valid (committee|agent) credential/)
      expect(p).toMatch(/select 1 as one/)
    }
  })

  it('catch a route that writes before its guard only when a bearer token with the agent key prefix is present', async () => {
    await db.pool.query('create table canary_writes_on_key (n int not null)')
    try {
      route('POST', '/canary/writes-first-with-agent-key', async ({ req }) => {
        if (String(req.headers.authorization ?? '').startsWith(`Bearer ${API_KEY_PREFIX}`)) {
          await query('insert into canary_writes_on_key (n) values (1)')
        }
        await requireProvider(req)
        return { ok: true }
      })
      const r = { method: 'POST', path: '/canary/writes-first-with-agent-key' }
      const problems = await authProblems(r, 'provider')
      expect(problems.length).toBe(1) // only the bearer token with the agent key prefix
      expect(problems[0]).toMatch(/^with a bearer token with the agent key prefix that does not exist the handler of POST \/canary\/writes-first-with-agent-key made /)
      expect(problems[0]).toMatch(/insert into canary_writes_on_key/)
      const cross = await crossRoleProblems(r, 'provider')
      expect(cross.length).toBe(1) // and the valid agent key sent as a bearer token
      expect(cross[0]).toMatch(/^with a valid agent credential the handler of POST/)
      expect(cross[0]).toMatch(/insert into canary_writes_on_key/)
      // Those two unauthenticated requests really wrote a row each, although every response was a clean 401.
      const { rows } = await db.pool.query('select count(*)::int as n from canary_writes_on_key')
      expect(rows[0].n).toBe(2)
    } finally {
      await db.pool.query('drop table canary_writes_on_key')
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

  it('pass a route whose guard comes first, even when it then does work that depends on the cookie or the header', async () => {
    route('POST', '/canary/guard-first-then-work/:id', async ({ req }) => {
      await requireProvider(req)
      if (req.headers.authorization) await query('select 1 as one')
      if (req.headers.cookie) await query('select 2 as two')
      return { ok: true }
    })
    const r = { method: 'POST', path: '/canary/guard-first-then-work/:id' }
    expect(await authProblems(r, 'provider')).toEqual([])
    expect(await crossRoleProblems(r, 'provider')).toEqual([])
    const signedIn = await call('POST', `/api/canary/guard-first-then-work/${randomUUID()}`, { body: {}, ...asBearer(VALID.provider) })
    expect(signedIn.status).toBe(200)
  })

  // Use of the body before the guard. The body of every request here is empty, so a handler that looks at a field gets
  // `undefined`, does not act on it, and still refuses with the guard's own 401 and its own statements: only the body
  // check can show it, and it must show it for every variant, no credentials included, and for every cross-role credential.
  async function expectCaughtByTheBodyCheckAlone(r, guard, touchedPattern) {
    const problems = await authProblems(r, guard)
    expect(problems.length).toBe(CREDENTIALS.length)
    expect(problems[0]).toMatch(new RegExp(`^with no credentials at all the handler of ${r.method} ${r.path.replace(/\//g, '\\/')} used the request body`))
    const cross = await crossRoleProblems(r, guard)
    expect(cross.length).toBe(4)
    for (const p of [...problems, ...cross]) {
      expect(p).toMatch(/used the request body before it refused/)
      expect(p).toMatch(touchedPattern)
      expect(p).toMatch(/The authorization call must come first/)
      expect(p).not.toMatch(/answered|database statement/) // a 401 with the guard's code, and only the guard's own statements
    }
  }

  it('catch a route that reads a field of the body before it checks authorization, without acting on it', async () => {
    route('POST', '/canary/body-field-read', async ({ req, body }) => {
      const name = body.name
      await requireAdmin(req)
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'POST', path: '/canary/body-field-read' }, 'committee', /\(it did: read name\)/)
  })

  it('catch a route that reads a field of the body before its guard and acts on it only when it is set', async () => {
    route('POST', '/canary/body-field-acts', async ({ req, body }) => {
      if (body.confirm) await query('select 1 as one') // an empty body never gets here, which is how it slipped through
      await requireProvider(req)
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'POST', path: '/canary/body-field-acts' }, 'provider', /\(it did: read confirm\)/)
  })

  it('catch a route that checks the body with the in operator before it checks authorization', async () => {
    route('DELETE', '/canary/body-in', async ({ req, body }) => {
      const confirmed = 'confirm' in body
      await requireApiKey(req)
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'DELETE', path: '/canary/body-in' }, 'agent', /\(it did: check for confirm\)/)
  })

  it('catch a route that lists the keys of the body before it checks authorization', async () => {
    route('PUT', '/canary/body-keys', async ({ req, body }) => {
      const keys = Object.keys(body)
      await requireAdmin(req)
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'PUT', path: '/canary/body-keys' }, 'committee', /\(it did: list the keys\)/)
  })

  it('catch a route that validates the shape of the body before it checks authorization, and uses the result after', async () => {
    route('PATCH', '/canary/body-shape-first', async ({ req, body }) => {
      const valid = typeof body.name === 'string' && body.name.trim() !== ''
      await requireProvider(req)
      if (!valid) throw bad('missing_field', 'name is required')
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'PATCH', path: '/canary/body-shape-first' }, 'provider', /\(it did: read name\)/)
  })

  it('pass a route that reads the body only after its guard let the request in', async () => {
    route('POST', '/canary/body-after-guard/:id', async ({ req, body }) => {
      await requireProvider(req)
      if (body.confirm) await query('select 1 as one')
      const keys = Object.keys(body)
      return { ok: true, keys: keys.length, has: 'confirm' in body }
    })
    const r = { method: 'POST', path: '/canary/body-after-guard/:id' }
    expect(await authProblems(r, 'provider')).toEqual([])
    expect(await crossRoleProblems(r, 'provider')).toEqual([])
    // With a real device token it gets in, and the body it sends is the one it reads (so the canary is not a dead route).
    const res = await call('POST', `/api/canary/body-after-guard/${randomUUID()}`, { body: { confirm: true }, ...asBearer(VALID.provider) })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, keys: 1, has: true })
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
