// Authorization is enforced by the router (server/router.js), before any code of a handler runs, from the policy of
// server/access.js: the PUBLIC list (the routes that answer without credentials, each with a reason) and the rules that
// give every other route the guard of its role by its path. A handler may still call its guard to learn who is signed in
// (the guards remember their answer for the request, server/auth.js). This test walks EVERY registered route
// (server/router.js, routeTable()) and proves from the outside that each route that is not on PUBLIC is guarded, and
// guarded by the right check, and that a refused request gets no further than the router.
//
// How it works:
//   - A route is protected unless it is on PUBLIC (imported from server/access.js: a route is open only through that list,
//     with its reason). A new route does not need an edit here: it is picked up from the table and tested automatically.
//   - The guard a protected route must have comes from its path (GUARDS below, this test's own copy of the rules, which
//     the server's rules in server/access.js are compared with, so a weakened server rule fails here): /admin/ routes need
//     a committee session, /agent/v1/ routes and /health/db an agent key, the provider routes a provider device token. A
//     protected route that fits none of those rules fails loudly, so a new route group needs a rule in both places.
//   - Each protected route is called with no credentials, and with every kind of malformed credential (a cookie or a
//     bearer token that does not exist, with and without the prefixes of server/config.js). All of them must get a 401
//     with the code of THAT route's guard (not just any guard's), and must not leak data or set a cookie.
//   - A refused request must make exactly the database statements that its guard makes on its own, and nothing else.
//     Work before the guard (a query or a write that only happens when a cookie is present, when an Authorization header
//     is) would pass the checks above while the caller had already made the server do protected work. So the pool is
//     wrapped with a counter for every request of this test (a connection taken for a transaction counts too), and the
//     statements of the request are compared, text by text and in order, with those of the same request (method and
//     credentials) sent to a test-only route whose handler does nothing, so only the router's guard runs. The request with
//     no credentials at all must make ZERO statements. The counter writes a statement down when it is asked for, so
//     nothing in the comparison depends on timing.
//   - A refused request must not touch its body at all. Every request that has a body (any method but GET and HEAD) is
//     sent a body that writes down every access (a Proxy over an empty object, see watchedBody), so the test does not
//     guess which field a handler looks at. And the router itself must not read the body (`req.body`) or build the query
//     for a handler before its guard has refused: the request writes down both (see sendRequest). Nothing the guard does
//     touches any of it (a test proves that), so the guard has run before any use of the body when the lists are empty.
//   - Each protected route is also called with VALID credentials of the other two roles (a real committee session, a
//     real provider device token, a real agent key, all made in the throwaway schema), sent the usual way and the wrong
//     way round (a bearer token in the cookie, a cookie value as a bearer token). It must refuse them with the 401 of
//     its own guard, so a route that is switched to another role's guard is noticed.
//   - 'the router guards every route before the handler runs' registers canaries under guarded paths (/admin/canary-...,
//     /my/canary-..., /agent/v1/canary-...) whose handlers are written the unsafe way (they query, write, read the body,
//     the query or the parameters before they call their guard, or never call it, or call the wrong one) and proves that
//     for every refused request the handler never ran at all, and that it does run once a valid credential is sent.
//   - 'the checks themselves' proves that the checks above notice these mistakes in a handler. The router now makes the
//     mistakes impossible, so those canaries live on /canary-open/ paths, which this file alone makes public with vi.mock
//     (below): a module mock reaches only this test file's own module graph, so server/ has no switch, flag or function
//     that registers a route without the policy.
// Credentials are looked up in the database, so this runs against the throwaway schema like the other API tests.
// Random UUIDs stand in for path parameters, so even a route that was left open would find nothing to change.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import '../server/index.js' // importing it registers every route file with the router
import { route, routeTable } from '../server/router.js'
import { PUBLIC, accessFor } from '../server/access.js'
import { requireAdmin, requireProvider, requireApiKey } from '../server/auth.js'
import { getPool, setPool, query, tx } from '../server/db.js'
import { bad, unauthorized } from '../server/http.js'
import { ADMIN_COOKIE, ADMIN_TOKEN_PREFIX, PROVIDER_TOKEN_PREFIX, API_KEY_PREFIX } from '../server/config.js'

// Only the canaries of 'the checks themselves' (under /canary-open/) are made open here: they are handlers that do their
// authorization themselves, or not at all, to prove that the checks notice that. Everything else, the whole API and every
// other canary, gets the real policy. vi.mock changes the module only inside this test file's own module graph.
vi.mock('../server/access.js', async (importOriginal) => {
  const real = await importOriginal()
  const open = Object.freeze({ public: true })
  return { ...real, accessFor: (method, pattern) => (pattern.startsWith('/canary-open/') ? open : real.accessFor(method, pattern)) }
})

// The policy as it is in server/access.js, whatever the mock above does.
const policy = await vi.importActual('../server/access.js')

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

// The routes that answer without credentials, written out a second time on purpose (the reasons live in PUBLIC in
// server/access.js). The walk below trusts PUBLIC to say which routes are open, so without this list a protected route that
// is moved to PUBLIC would simply stop being tested. With it, that change fails a test unless the test is changed too,
// and a reviewer sees both edits.
const EXPECTED_PUBLIC = [
  'GET /health',
  'GET /public/providers',
  'GET /public/building',
  'GET /public/points/resolve',
  'POST /session',
  'POST /admin/google',
  'GET /admin/config',
  'POST /admin/dev-login',
  'POST /admin/logout',
]

/**
 * Every route of the table that `lookup` (a function like `accessFor` of server/access.js) does not give the access that
 * this test expects, as sentences: a PUBLIC route must be open, every other route must get the guard that GUARDS says for
 * its path, with a check to run. Empty when the policy and this test agree.
 */
function guardDisagreements(lookup) {
  const problems = []
  for (const r of ROUTES) {
    let got
    try {
      got = lookup(r.method, r.path)
    } catch (err) {
      problems.push(`${keyOf(r)}: ${err.message}`)
      continue
    }
    if (publicKeys.has(keyOf(r))) {
      if (got.public !== true) problems.push(`${keyOf(r)} is on PUBLIC but the policy guards it with the ${got.guard} guard`)
    } else if (got.public === true) {
      problems.push(`${keyOf(r)} is not on PUBLIC but the policy lets it answer without credentials`)
    } else if (got.guard !== guardOf(r.path)) {
      problems.push(`${keyOf(r)} needs the ${guardOf(r.path)} guard but the policy gives it ${got.guard}`)
    } else if (typeof got.check !== 'function') {
      problems.push(`${keyOf(r)} is given the ${got.guard} guard but no check to run`)
    }
  }
  return problems
}

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
  'A route that is not on the PUBLIC list of server/access.js is guarded by the router before any code of its handler ' +
  'runs: requireAdmin for /admin/ routes, requireApiKey for /agent/v1/ routes and /health/db, requireProvider for the ' +
  'provider routes (see GUARDS, and RULES in server/access.js). handle() in server/router.js must run that guard first ' +
  'and only then read the body, build the query and the parameters and call the handler. Until the guard has refused, ' +
  'nothing may run for any kind of request (a cookie, an Authorization header, none): only the statements that the guard ' +
  'makes on its own, and a request without credentials must not touch the database at all. ' +
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

// Test-only routes under the guarded paths of each role (the router gives them the guard of that role), named canary-... .
// They are registered in beforeAll, after ROUTES was read, so they are never walked as routes of the API (see the test
// that says so).
const CANARY = { committee: '/admin/canary-', provider: '/my/canary-', agent: '/agent/v1/canary-' }
const isCanary = (path) => /\/canary-/.test(path)
// A route per guard and per method whose handler does nothing: only the router's guard runs for it. It measures what a
// guard makes on its own for a given request.
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const guardAloneRoute = (guard, method) => ({ method, path: `${CANARY[guard]}guard-alone` })
const shown = (text) => (text.length > 70 ? `${text.slice(0, 67)}...` : text)

/**
 * Sends the request through a counting pool, with a watched body when the method carries one, and returns the response,
 * every database statement it made (in order), every way the handler touched the body (empty for a method without one) and
 * what the router read for a handler: how many times `req.body` was read, and how many times the query string was turned
 * into the object that the handler gets (that is an iteration of URLSearchParams, which nothing else in a request does).
 */
async function sendRequest(r, creds) {
  const real = getPool()
  const counter = countingPool(real)
  const watched = hasBody(r) ? watchedBody() : null
  const reads = { body: 0, query: 0 }
  const iterate = URLSearchParams.prototype[Symbol.iterator]
  URLSearchParams.prototype[Symbol.iterator] = function (...args) {
    reads.query++
    return iterate.apply(this, args)
  }
  setPool(counter)
  try {
    const res = await call(r.method, `${urlOf(r)}?probe=1`, {
      ...(watched ? { body: watched.body } : {}),
      onBodyRead: () => reads.body++,
      ...creds,
    })
    return { res, statements: counter.seen, touched: watched?.touched ?? [], reads }
  } finally {
    URLSearchParams.prototype[Symbol.iterator] = iterate
    setPool(real)
  }
}

/** Whether the router guards this route before its handler: it is registered, and the policy does not make it public. */
function guardedByRouter(r) {
  try {
    return accessFor(r.method, r.path).public !== true
  } catch {
    return false
  }
}

/**
 * The sentence that says that the router read the body or built the query for a handler before the guard refused, or null.
 * It only applies to a route that the router guards: a route that is open on purpose has its context built at once.
 */
function readsProblem(r, label, reads) {
  const what = [reads.body && 'read the request body', reads.query && 'built the query for the handler'].filter(Boolean)
  if (!what.length) return null
  return (
    `with ${label} the router ${what.join(' and ')} of ${keyOf(r)} before its guard had refused the request. The guard ` +
    'must run first: handle() in server/router.js reads nothing of the request for a handler until the guard has let it in'
  )
}

/**
 * The sentence that says that the handler used the request body before it refused, or null. A refused request must not
 * have touched the body at all: the guard runs before any use of it, whatever the field or the way it is looked at.
 */
function bodyProblem(r, label, touched) {
  if (!touched.length) return null
  const list = touched.slice(0, 3).join(', ') + (touched.length > 3 ? ` and ${touched.length - 3} more` : '')
  return (
    `with ${label} the handler of ${keyOf(r)} used the request body before it refused (it did: ${list}). The guard ` +
    'must run first: nothing may read, check or validate the body before the guard has refused the request'
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
      `${who} made ${count(actual)} before it refused (the first: ${shown(actual[at])}). The guard must run first: ` +
      'the guard alone makes no database statement for this request, so nothing else may'
    )
  }
  if (at !== -1) {
    return (
      `${who} made ${count(actual)}, but the ${guard} guard alone makes ${count(expected)} for the same request, and the ` +
      `first statement that is not the guard's own is number ${at + 1}: ${shown(actual[at])}. The guard must run first: ` +
      "until it has refused the request, nothing but the guard's own statements may run"
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
  const { res, statements, touched, reads } = await sendRequest(r, creds)
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
  const read = guardedByRouter(r) ? readsProblem(r, label, reads) : null
  if (read) problems.push(read)
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
    for (const method of METHODS) route(method, guardAloneRoute(guard, method).path, async () => ({ ok: true }))
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
  it('holds exactly the routes of EXPECTED_PUBLIC', () => {
    const actual = PUBLIC.map(keyOf).sort()
    const expected = [...EXPECTED_PUBLIC].sort()
    const added = actual.filter((k) => !expected.includes(k))
    const removed = expected.filter((k) => !actual.includes(k))
    expect(
      { added, removed },
      'Making a route public (or protected again) is a security decision: it needs BOTH lists changed, PUBLIC in ' +
        'server/access.js with the reason, and EXPECTED_PUBLIC in tests/route-auth.test.js, so that a reviewer sees it twice. ' +
        `Routes on PUBLIC but not expected: ${added.join(', ') || 'none'}. Expected but not on PUBLIC: ${removed.join(', ') || 'none'}.`,
    ).toEqual({ added: [], removed: [] })
    expect(new Set(EXPECTED_PUBLIC).size, 'EXPECTED_PUBLIC lists a route twice').toBe(EXPECTED_PUBLIC.length)
  })

  it('gives every entry a non-empty reason', () => {
    for (const p of PUBLIC) {
      expect(typeof p.why, `${keyOf(p)} needs a reason (why)`).toBe('string')
      expect(p.why.trim(), `${keyOf(p)} needs a reason (why)`).not.toBe('')
      expect(p.why.trim().length, `${keyOf(p)} needs a real reason, not a word`).toBeGreaterThanOrEqual(20)
    }
  })

  it('names each route once, and only routes that exist (a removed route leaves no stale entry)', () => {
    const keys = PUBLIC.map(keyOf)
    expect(keys.filter((k, i) => keys.indexOf(k) !== i), 'listed twice').toEqual([])
    const registered = new Set(ROUTES.map(keyOf))
    expect(
      keys.filter((k) => !registered.has(k)),
      'on the PUBLIC list but not registered: remove it from PUBLIC (server/access.js) and from EXPECTED_PUBLIC (tests/route-auth.test.js)',
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
    expect(ROUTES.filter((r) => isCanary(r.path))).toEqual([])
    expect(PROTECTED.filter((r) => isCanary(r.path))).toEqual([])
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
    route('POST', '/canary-open/body-received', async ({ body }) => {
      received = body
      return { ok: true }
    })
    const watched = watchedBody()
    const res = await call('POST', '/api/canary-open/body-received', { body: watched.body })
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

describe('the checks themselves, on routes that are open on purpose (the mock at the top of this file makes /canary-open/ public)', () => {
  it('show a route that is added later in the table', () => {
    route('GET', '/canary-open/new-route', async () => ({ ok: true }))
    expect(routeTable().map(keyOf)).toContain('GET /canary-open/new-route')
    expect(ROUTES.map(keyOf)).not.toContain('GET /canary-open/new-route') // the generated tests do not move under it
  })

  it('catch a route that was added without an authorization check', async () => {
    route('GET', '/canary-open/open/:id', async () => ({ ok: true }))
    const r = { method: 'GET', path: '/canary-open/open/:id' }
    const problems = await authProblems(r, 'committee')
    expect(problems.length).toBe(CREDENTIALS.length) // every kind of request got a 200
    expect(problems[0]).toMatch(/no credentials at all it answered 200, expected 401/)
    expect((await crossRoleProblems(r, 'committee')).length).toBe(4) // and so did every credential of the other roles
  })

  it('catch a route that validates its input before it checks authorization', async () => {
    route('POST', '/canary-open/validates-first', async ({ req, body }) => {
      if (!body.name) throw bad('missing_field', 'name is required')
      await requireAdmin(req)
      return { ok: true }
    })
    const r = { method: 'POST', path: '/canary-open/validates-first' }
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
    route('GET', '/canary-open/queries-first', async ({ req }) => {
      await query('select 1 as one')
      await requireAdmin(req)
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary-open/queries-first' }
    const problems = await authProblems(r, 'committee')
    expect(problems.length).toBe(CREDENTIALS.length) // the extra statement shows in every variant, the 401 and its code were right in all
    expect(problems[0]).toMatch(/^with no credentials at all the handler of GET \/canary-open\/queries-first made 1 database statement before it refused/)
    expect(problems[0]).toMatch(/\(the first: select 1 as one\)/)
    for (const p of problems) {
      expect(p).toMatch(/select 1 as one/)
      expect(p).toMatch(/The guard must run first/)
      expect(p).not.toMatch(/answered/) // it did refuse with admin_required
    }
    const cross = await crossRoleProblems(r, 'committee')
    expect(cross.length).toBe(4) // and so does every credential of the other roles
    for (const p of cross) expect(p).toMatch(/select 1 as one/)
    expect(getPool()).toBe(db.pool) // the counting pool was taken out again
  })

  it('catch a route that starts a transaction before it checks authorization', async () => {
    route('GET', '/canary-open/transaction-first', async ({ req }) => {
      await tx((c) => c.query('select 1 as one'))
      await requireProvider(req)
      return { ok: true }
    })
    const problems = await authProblems({ method: 'GET', path: '/canary-open/transaction-first' }, 'provider')
    expect(problems.length).toBe(CREDENTIALS.length)
    expect(problems[0]).toMatch(/made 4 database statements before it refused \(the first: \(a connection for a transaction\)\)/) // connect, begin, select, commit
  })

  it('catch a route that writes before it checks authorization, which an unauthenticated caller could then trigger', async () => {
    await db.pool.query('create table canary_writes_first (n int not null)')
    try {
      route('POST', '/canary-open/writes-first', async ({ req }) => {
        await query('insert into canary_writes_first (n) values (1)')
        await requireApiKey(req)
        return { ok: true }
      })
      const problems = await authProblems({ method: 'POST', path: '/canary-open/writes-first' }, 'agent')
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
    route('GET', '/canary-open/queries-first-with-cookie', async ({ req }) => {
      if (req.headers.cookie) await query('select 1 as one')
      await requireAdmin(req)
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary-open/queries-first-with-cookie' }
    const problems = await authProblems(r, 'committee')
    expect(problems.some((p) => p.startsWith('with no credentials at all'))).toBe(false) // the zero-statement check is not what catches it
    expect(problems.length).toBe(4) // the four variants with the admin cookie (the ones with a bearer token stay clean)
    for (const p of problems) {
      expect(p).toMatch(/^with (an admin cookie|an empty admin cookie)/)
      expect(p).toMatch(/select 1 as one/)
      expect(p).toMatch(/The guard must run first/)
    }
    const cross = await crossRoleProblems(r, 'committee')
    expect(cross.length).toBe(2) // a provider token and an agent key sent in the admin cookie
    for (const p of cross) {
      expect(p).toMatch(/^with a valid (provider|agent) credential sent in the admin cookie/)
      expect(p).toMatch(/select 1 as one/)
    }
  })

  it('catch a route that queries before its guard only when an Authorization header is present', async () => {
    route('GET', '/canary-open/queries-first-with-authorization', async ({ req }) => {
      if (req.headers.authorization) await query('select 1 as one')
      await requireProvider(req)
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary-open/queries-first-with-authorization' }
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
      route('POST', '/canary-open/writes-first-with-agent-key', async ({ req }) => {
        if (String(req.headers.authorization ?? '').startsWith(`Bearer ${API_KEY_PREFIX}`)) {
          await query('insert into canary_writes_on_key (n) values (1)')
        }
        await requireProvider(req)
        return { ok: true }
      })
      const r = { method: 'POST', path: '/canary-open/writes-first-with-agent-key' }
      const problems = await authProblems(r, 'provider')
      expect(problems.length).toBe(1) // only the bearer token with the agent key prefix
      expect(problems[0]).toMatch(/^with a bearer token with the agent key prefix that does not exist the handler of POST \/canary-open\/writes-first-with-agent-key made /)
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
    route('GET', '/canary-open/queries-after', async ({ req }) => {
      await requireAdmin(req)
      await query('select 1 as one')
      return { ok: true }
    })
    const r = { method: 'GET', path: '/canary-open/queries-after' }
    expect(await authProblems(r, 'committee')).toEqual([])
    expect(await crossRoleProblems(r, 'committee')).toEqual([])
    // With a real session it gets past the guard and does run its query (so the canary is not simply a dead route).
    expect((await call('GET', '/api/canary-open/queries-after', asCookie(VALID.committee))).status).toBe(200)
  })

  it('pass a route whose guard comes first, even when it then does work that depends on the cookie or the header', async () => {
    route('POST', '/canary-open/guard-first-then-work/:id', async ({ req }) => {
      await requireProvider(req)
      if (req.headers.authorization) await query('select 1 as one')
      if (req.headers.cookie) await query('select 2 as two')
      return { ok: true }
    })
    const r = { method: 'POST', path: '/canary-open/guard-first-then-work/:id' }
    expect(await authProblems(r, 'provider')).toEqual([])
    expect(await crossRoleProblems(r, 'provider')).toEqual([])
    const signedIn = await call('POST', `/api/canary-open/guard-first-then-work/${randomUUID()}`, { body: {}, ...asBearer(VALID.provider) })
    expect(signedIn.status).toBe(200)
  })

  // Use of the body before the guard. The body of every request here is empty, so a handler that looks at a field gets
  // `undefined`, does not act on it, and still refuses with the guard's own 401 and its own statements: only the body
  // check can show it, and it must show it for every variant, no credentials included, and for every cross-role credential.
  // (The canary handlers below only touch the body: `void` runs the read and leaves no unused variable for the linter.)
  async function expectCaughtByTheBodyCheckAlone(r, guard, touchedPattern) {
    const problems = await authProblems(r, guard)
    expect(problems.length).toBe(CREDENTIALS.length)
    expect(problems[0]).toMatch(new RegExp(`^with no credentials at all the handler of ${r.method} ${r.path.replace(/\//g, '\\/')} used the request body`))
    const cross = await crossRoleProblems(r, guard)
    expect(cross.length).toBe(4)
    for (const p of [...problems, ...cross]) {
      expect(p).toMatch(/used the request body before it refused/)
      expect(p).toMatch(touchedPattern)
      expect(p).toMatch(/The guard must run first/)
      expect(p).not.toMatch(/answered|database statement/) // a 401 with the guard's code, and only the guard's own statements
    }
  }

  it('catch a route that reads a field of the body before it checks authorization, without acting on it', async () => {
    route('POST', '/canary-open/body-field-read', async ({ req, body }) => {
      void body.name
      await requireAdmin(req)
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'POST', path: '/canary-open/body-field-read' }, 'committee', /\(it did: read name\)/)
  })

  it('catch a route that reads a field of the body before its guard and acts on it only when it is set', async () => {
    route('POST', '/canary-open/body-field-acts', async ({ req, body }) => {
      if (body.confirm) await query('select 1 as one') // an empty body never gets here, which is how it slipped through
      await requireProvider(req)
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'POST', path: '/canary-open/body-field-acts' }, 'provider', /\(it did: read confirm\)/)
  })

  it('catch a route that checks the body with the in operator before it checks authorization', async () => {
    route('DELETE', '/canary-open/body-in', async ({ req, body }) => {
      void ('confirm' in body)
      await requireApiKey(req)
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'DELETE', path: '/canary-open/body-in' }, 'agent', /\(it did: check for confirm\)/)
  })

  it('catch a route that lists the keys of the body before it checks authorization', async () => {
    route('PUT', '/canary-open/body-keys', async ({ req, body }) => {
      void Object.keys(body)
      await requireAdmin(req)
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'PUT', path: '/canary-open/body-keys' }, 'committee', /\(it did: list the keys\)/)
  })

  it('catch a route that validates the shape of the body before it checks authorization, and uses the result after', async () => {
    route('PATCH', '/canary-open/body-shape-first', async ({ req, body }) => {
      const valid = typeof body.name === 'string' && body.name.trim() !== ''
      await requireProvider(req)
      if (!valid) throw bad('missing_field', 'name is required')
      return { ok: true }
    })
    await expectCaughtByTheBodyCheckAlone({ method: 'PATCH', path: '/canary-open/body-shape-first' }, 'provider', /\(it did: read name\)/)
  })

  it('pass a route that reads the body only after its guard let the request in', async () => {
    route('POST', '/canary-open/body-after-guard/:id', async ({ req, body }) => {
      await requireProvider(req)
      if (body.confirm) await query('select 1 as one')
      const keys = Object.keys(body)
      return { ok: true, keys: keys.length, has: 'confirm' in body }
    })
    const r = { method: 'POST', path: '/canary-open/body-after-guard/:id' }
    expect(await authProblems(r, 'provider')).toEqual([])
    expect(await crossRoleProblems(r, 'provider')).toEqual([])
    // With a real device token it gets in, and the body it sends is the one it reads (so the canary is not a dead route).
    const res = await call('POST', `/api/canary-open/body-after-guard/${randomUUID()}`, { body: { confirm: true }, ...asBearer(VALID.provider) })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, keys: 1, has: true })
  })

  it('catch a 401 that does not come from an authorization check', async () => {
    route('GET', '/canary-open/other-401', async () => {
      throw unauthorized('google_invalid')
    })
    const problems = await authProblems({ method: 'GET', path: '/canary-open/other-401' }, 'committee')
    expect(problems.length).toBe(CREDENTIALS.length)
    expect(problems[0]).toMatch(/answered 401 \(google_invalid\), expected admin_required/)
  })

  // A route that is guarded, but by another role's check: the case that every credential being invalid cannot show.
  for (const needs of Object.keys(GUARDS)) {
    for (const uses of Object.keys(GUARDS).filter((name) => name !== needs)) {
      it(`catch a route of the ${needs} role that is guarded by the ${uses} check`, async () => {
        const path = `/canary-open/${needs}-route-with-${uses}-check`
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
      const path = `/canary-open/guarded-${guard}/:id`
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

describe('the access policy of server/access.js', () => {
  it('cannot be changed once it is loaded: PUBLIC, its entries and the access it hands out are frozen', () => {
    expect(Object.isFrozen(PUBLIC)).toBe(true)
    for (const entry of PUBLIC) expect(Object.isFrozen(entry), keyOf(entry)).toBe(true)
    expect(() => PUBLIC.push({ method: 'GET', path: '/admin/me', why: 'a protected route made public at run time' })).toThrow(TypeError)
    expect(() => {
      PUBLIC[0].path = '/admin/me'
    }).toThrow(TypeError)
    for (const [method, path] of [['GET', '/admin/me'], ['GET', '/health']]) {
      const access = policy.accessFor(method, path)
      expect(Object.isFrozen(access), keyOf({ method, path })).toBe(true)
      expect(() => {
        access.guard = 'agent'
      }, keyOf({ method, path })).toThrow(TypeError)
    }
  })

  it('gives every registered route the guard that GUARDS says, and lets only the PUBLIC routes answer without credentials', () => {
    expect(guardDisagreements(policy.accessFor)).toEqual([])
    // The same through the function that the router calls when a route is registered.
    expect(guardDisagreements(accessFor)).toEqual([])
  })

  it('notices a rule that gives a route the wrong guard, a protected route made public, and a route that no rule owns', () => {
    const real = policy.accessFor
    const wrongGuard = (method, path) => (path.startsWith('/my/') ? { guard: 'committee', check: requireAdmin } : real(method, path))
    expect(guardDisagreements(wrongGuard).join('\n')).toMatch(/GET \/my\/scans needs the provider guard but the policy gives it committee/)
    const madePublic = (method, path) => (path.startsWith('/agent/v1/') ? { public: true } : real(method, path))
    expect(guardDisagreements(madePublic).join('\n')).toMatch(/GET \/agent\/v1\/points is not on PUBLIC but the policy lets it answer without credentials/)
    const unowned = (method, path) => {
      if (path === '/admin/me') throw new Error('is owned by no access rule')
      return real(method, path)
    }
    expect(guardDisagreements(unowned).join('\n')).toMatch(/GET \/admin\/me: is owned by no access rule/)
    const noCheck = (method, path) => (path === '/admin/me' ? { guard: 'committee' } : real(method, path))
    expect(guardDisagreements(noCheck).join('\n')).toMatch(/GET \/admin\/me is given the committee guard but no check to run/)
    const closed = (method, path) => (path === '/health' ? { guard: 'agent', check: requireApiKey } : real(method, path))
    expect(guardDisagreements(closed).join('\n')).toMatch(/GET \/health is on PUBLIC but the policy guards it with the agent guard/)
  })

  it('opens one method of a path and no other: POST /session is public, GET and DELETE /session are the provider\'s', () => {
    expect(policy.accessFor('POST', '/session')).toEqual({ public: true })
    expect(policy.accessFor('GET', '/session').guard).toBe('provider')
    expect(policy.accessFor('DELETE', '/session').guard).toBe('provider')
    expect(policy.accessFor('GET', '/admin/config').public).toBe(true)
    expect(policy.accessFor('PUT', '/admin/config').guard).toBe('committee')
    expect(policy.accessFor('GET', '/admin/google').guard).toBe('committee') // only POST is open
  })

  it('refuses to register a route that no rule owns, and leaves the route table as it was', () => {
    const before = routeTable().map(keyOf)
    for (const [method, path] of [
      ['GET', '/canary/unowned'],
      ['POST', '/admin'], // the group itself, without the slash that the rule asks for
      ['GET', '/administrator/x'],
      ['PUT', '/health'], // only GET /health is public
      ['GET', '/'],
    ]) {
      expect(() => route(method, path, async () => ({ ok: true })), `${method} ${path}`).toThrow(/is owned by no access rule/)
    }
    expect(routeTable().map(keyOf)).toEqual(before)
  })

  it('has no other way to register a route than route(method, pattern, handler): no option, no second function', async () => {
    const router = await import('../server/router.js')
    expect(Object.keys(router).sort()).toEqual(['handle', 'route', 'routeTable'])
    expect(route.length).toBe(3)
  })
})

describe('a guard answers once per request', () => {
  it('hands the same answer to every call for a request, a refusal included, and keeps requests apart', async () => {
    for (const guard of [requireAdmin, requireProvider, requireApiKey]) {
      const req = { headers: {} }
      const first = guard(req)
      expect(guard(req)).toBe(first)
      const other = guard({ headers: {} })
      expect(other).not.toBe(first)
      const [a, b] = await Promise.allSettled([first, other])
      expect(a.status).toBe('rejected')
      expect(a.reason?.status).toBe(401)
      expect(b.status).toBe('rejected')
    }
  })
})

describe('the router guards every route before the handler runs', () => {
  const own = (guard) => ({ committee: asCookie(VALID.committee), provider: asBearer(VALID.provider), agent: asBearer(VALID.agent) })[guard]

  /** A route under the guarded path of `guard`. `ran` lists the requests that reached its handler, whatever the handler does. */
  function canary(guard, name, method, handler) {
    const ran = []
    const path = `${CANARY[guard]}${name}`
    route(method, path, async (context) => {
      ran.push(name)
      return handler(context)
    })
    return { r: { method, path }, ran }
  }

  /**
   * Every kind of request that the checks of this file send (no credentials, malformed ones, the valid ones of the other
   * roles) is refused as the guard's 401 with only the guard's own statements, and none of them reached the handler.
   */
  async function expectProtected({ r, ran }, guard) {
    expect(await authProblems(r, guard)).toEqual([])
    expect(await crossRoleProblems(r, guard)).toEqual([])
    expect(ran, `the handler of ${keyOf(r)} ran for a request that its guard refused`).toEqual([])
  }

  /** A request with the valid credential of `guard`: it gets past the guard, so the handler runs (a canary is not a dead route). */
  const signedIn = ({ r }, guard, extra = {}) =>
    call(r.method, `${urlOf(r)}?probe=1`, { ...(hasBody(r) ? { body: {} } : {}), ...own(guard), ...extra })

  it('does not run a handler that queries before it calls its own guard', async () => {
    const c = canary('committee', 'queries-first', 'GET', async ({ req }) => {
      await query('select 1 as one')
      await requireAdmin(req)
      return { ok: true }
    })
    await expectProtected(c, 'committee')
    expect((await signedIn(c, 'committee')).status).toBe(200)
    expect(c.ran).toEqual(['queries-first'])
    expect(getPool()).toBe(db.pool) // the counting pool was taken out again
  })

  it('does not run a handler that starts a transaction before it calls its own guard', async () => {
    const c = canary('provider', 'transaction-first', 'GET', async ({ req }) => {
      await tx((client) => client.query('select 1 as one'))
      await requireProvider(req)
      return { ok: true }
    })
    await expectProtected(c, 'provider')
    expect((await signedIn(c, 'provider')).status).toBe(200)
    expect(c.ran).toEqual(['transaction-first'])
  })

  it('does not run a handler that writes before it calls its own guard: nothing is written for a refused request', async () => {
    await db.pool.query('create table router_writes_first (n int not null)')
    try {
      const c = canary('agent', 'writes-first', 'POST', async ({ req }) => {
        await query('insert into router_writes_first (n) values (1)')
        await requireApiKey(req)
        return { ok: true }
      })
      await expectProtected(c, 'agent')
      const count = async () => (await db.pool.query('select count(*)::int as n from router_writes_first')).rows[0].n
      expect(await count()).toBe(0)
      // A valid agent key gets past the guard, and then the write does land (so the canary is not a dead route).
      expect((await signedIn(c, 'agent')).status).toBe(200)
      expect(await count()).toBe(1)
    } finally {
      await db.pool.query('drop table router_writes_first')
    }
  })

  it('does not run a handler that uses the body before it calls its own guard, in any way', async () => {
    const c = canary('provider', 'body-first', 'PATCH', async ({ req, body }) => {
      const valid = typeof body.name === 'string' && body.name.trim() !== ''
      const seen = ['confirm' in body, Object.keys(body).length, { ...body }]
      await requireProvider(req)
      if (!valid) throw bad('missing_field', 'name is required')
      return { ok: true, seen: seen.length }
    })
    await expectProtected(c, 'provider')
    // Past the guard the handler reads the body it was sent (400 for an empty one, 200 for a good one).
    const empty = await signedIn(c, 'provider')
    expect(empty.status).toBe(400)
    expect(empty.json.error.code).toBe('missing_field')
    expect((await signedIn(c, 'provider', { body: { name: 'x' } })).json).toEqual({ ok: true, seen: 3 })
    expect(c.ran.length).toBe(2)
  })

  it('does not run a handler that reads the query or the parameters before it calls its own guard, and gives them to it afterwards', async () => {
    const q = canary('agent', 'query-first', 'GET', async ({ req, query: fromUrl }) => {
      const probe = fromUrl.probe
      await requireApiKey(req)
      return { probe }
    })
    await expectProtected(q, 'agent')
    expect((await signedIn(q, 'agent')).json).toEqual({ probe: '1' })

    const p = canary('committee', 'params-first/:id', 'PUT', async ({ req, params }) => {
      const id = params.id
      await requireAdmin(req)
      return { id }
    })
    await expectProtected(p, 'committee')
    const res = await signedIn(p, 'committee')
    expect(res.status).toBe(200)
    expect(res.json.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(q.ran.length + p.ran.length).toBe(2)
  })

  it('does not run a handler that answers with a 401 of its own: a refused request gets the 401 of the guard', async () => {
    const c = canary('committee', 'own-401', 'GET', async () => {
      throw unauthorized('google_invalid')
    })
    await expectProtected(c, 'committee')
    // Only a request that the guard let in reaches the handler, and gets its answer.
    const res = await signedIn(c, 'committee')
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('google_invalid')
    expect(c.ran).toEqual(['own-401'])
  })

  for (const guard of Object.keys(GUARDS)) {
    it(`guards a route of the ${guard} role whose handler never calls a guard, with a path parameter`, async () => {
      const c = canary(guard, 'no-guard-call/:id', 'POST', async () => ({ ok: true }))
      await expectProtected(c, guard)
      expect((await signedIn(c, guard)).status).toBe(200)
      expect(c.ran).toEqual(['no-guard-call/:id'])
    })
  }

  // A handler that calls the guard of another role: the router's guard decides, so the handler's own check is never what
  // lets a request in. A credential of the route's own role gets past the router and then meets the handler's wrong check.
  for (const needs of Object.keys(GUARDS)) {
    for (const uses of Object.keys(GUARDS).filter((name) => name !== needs)) {
      it(`guards a route of the ${needs} role whose handler calls the ${uses} check`, async () => {
        const c = canary(needs, `with-${uses}-check`, 'GET', async ({ req }) => {
          await checks[uses](req)
          return { ok: true }
        })
        // Valid credentials of the ${uses} role are among the requests of crossRoleProblems: all refused by the router.
        await expectProtected(c, needs)
        const res = await signedIn(c, needs)
        expect(res.status).toBe(401)
        expect(GUARDS[uses].codes).toContain(res.json.error.code)
        expect(c.ran).toEqual([`with-${uses}-check`])
      })
    }
  }

  const WHO = {
    committee: (auth) => auth.admin.email === 'admin@test.local' && typeof auth.sessionId === 'string',
    provider: (auth) => auth.provider.company === 'Route auth test company' && typeof auth.deviceId === 'string',
    agent: (auth) => typeof auth.apiKeyId === 'string',
  }
  for (const guard of Object.keys(GUARDS)) {
    it(`gives the handler of a ${guard} route the answer of the guard as \`auth\`, the same one that its own call gets`, async () => {
      const c = canary(guard, 'reads-auth', 'GET', async ({ req, auth }) => {
        const again = await checks[guard](req)
        return { auth, same: again === auth }
      })
      await expectProtected(c, guard)
      const res = await signedIn(c, guard)
      expect(res.status).toBe(200)
      expect(WHO[guard](res.json.auth), JSON.stringify(res.json.auth)).toBe(true)
      expect(res.json.same).toBe(true)
    })

    it(`runs the ${guard} guard once for a request: a handler that calls it again makes no more statements`, async () => {
      const twice = canary(guard, 'guard-twice', 'GET', async ({ req }) => {
        await checks[guard](req)
        await checks[guard](req)
        return { ok: true }
      })
      const alone = await sendRequest(guardAloneRoute(guard, 'GET'), own(guard))
      const calledTwice = await sendRequest(twice.r, own(guard))
      expect(calledTwice.res.status).toBe(200)
      expect(alone.statements.length).toBeGreaterThanOrEqual(1)
      expect(calledTwice.statements).toEqual(alone.statements)
    })
  }

  it('reads the body and builds the query for a handler only after the guard has let the request in', async () => {
    const alone = guardAloneRoute('committee', 'POST')
    const refused = await sendRequest(alone, {})
    expect(refused.res.status).toBe(401)
    expect(refused.reads).toEqual({ body: 0, query: 0 })
    const accepted = await sendRequest(alone, asCookie(VALID.committee))
    expect(accepted.res.status).toBe(200)
    expect(accepted.reads.body).toBe(1)
    expect(accepted.reads.query).toBeGreaterThanOrEqual(1)
  })

  it('refuses a request whose JSON cannot be read with the 401 of the guard, not with invalid_json (the body is read after the guard)', async () => {
    const without = await call('POST', '/api/admin/providers', { badJsonBody: true })
    expect(without.status).toBe(401)
    expect(without.json.error.code).toBe('admin_required')
    const signed = await call('POST', '/api/admin/providers', { badJsonBody: true, ...asCookie(VALID.committee) })
    expect(signed.status).toBe(400)
    expect(signed.json.error.code).toBe('invalid_json')
  })

  it('still checks the origin and the content type of a write before the guard, as it always did', async () => {
    const wrongType = await call('POST', '/api/admin/providers', { body: {}, headers: { 'content-type': 'text/plain' } })
    expect(wrongType.status).toBe(400)
    expect(wrongType.json.error.code).toBe('json_required')
    const crossOrigin = await call('POST', '/api/admin/providers', { body: {}, headers: { origin: 'https://elsewhere.example' } })
    expect(crossOrigin.status).toBe(403)
    expect(crossOrigin.json.error.code).toBe('bad_origin')
  })

  // A parameter of the path that is not valid percent-encoding is a 400 `bad_request` for the handler, so it is looked at
  // only after the guard has let the request in. Finding the route compares segment counts and fixed segments and decodes
  // nothing, so a request that the guard refuses never learns anything about its parameters.
  const MALFORMED = '%E0%A4%A'

  /** The database statements that a request makes (through a counting pool), with its answer. */
  async function withStatements(method, url, creds = {}) {
    const real = getPool()
    const counter = countingPool(real)
    setPool(counter)
    try {
      const res = await call(method, url, { ...(method === 'GET' ? {} : { body: {} }), ...creds })
      return { res, statements: counter.seen }
    } finally {
      setPool(real)
    }
  }

  for (const guard of Object.keys(GUARDS)) {
    it(`answers a malformed path parameter on a ${guard} route with the 401 of the guard, and with the 400 only for a request that the guard let in`, async () => {
      const c = canary(guard, 'malformed/:id', 'GET', async ({ params }) => ({ id: params.id }))
      const url = `/api${c.r.path.replace(':id', MALFORMED)}`
      // Without credentials, with a malformed one, and with the valid credentials of the other roles: the guard's 401.
      const refused = [['no credentials at all', {}], ['a bearer token that does not exist', asBearer(token())]]
      for (const role of Object.keys(GUARDS).filter((name) => name !== guard)) {
        for (const [how, place] of PLACES[role]) refused.push([`a valid ${role} credential${how}`, place(VALID[role])])
      }
      for (const [label, creds] of refused) {
        const res = await call('GET', url, creds)
        expect(res.status, label).toBe(401)
        expect(GUARDS[guard].codes, label).toContain(res.json.error.code)
      }
      // The request with nothing at all is refused without a statement, and without decoding anything.
      expect((await withStatements('GET', url)).statements).toEqual([])
      // A request that the guard lets in meets the malformed value: a 400 from the router, before the handler.
      const signed = await call('GET', url, own(guard))
      expect(signed.status).toBe(400)
      expect(signed.json.error.code).toBe('bad_request')
      expect(c.ran, 'the handler must not run for a malformed parameter').toEqual([])
      // A well-formed value is decoded and handed to the handler.
      const fine = await call('GET', `/api${c.r.path.replace(':id', 'a%20b')}`, own(guard))
      expect(fine.json).toEqual({ id: 'a b' })
      expect(c.ran.length).toBe(1)
    })
  }

  it('answers a malformed parameter on a real route with the 401 of its guard, and with the 400 after a valid session', async () => {
    const url = `/api/admin/points/${MALFORMED}`
    const without = await withStatements('PATCH', url)
    expect(without.res.status).toBe(401)
    expect(without.res.json.error.code).toBe('admin_required')
    expect(without.statements).toEqual([])
    const asProvider = await call('PATCH', url, { body: {}, ...asBearer(VALID.provider) })
    expect(asProvider.status).toBe(401)
    expect(asProvider.json.error.code).toBe('admin_required')
    const signed = await call('PATCH', url, { body: {}, ...asCookie(VALID.committee) })
    expect(signed.status).toBe(400)
    expect(signed.json.error.code).toBe('bad_request')
  })

  // The path is a route's but not for the method: no guard and no handler run, so nothing is exposed, and the answer is
  // what it always was (tests/api.test.js): a 400 for a malformed parameter, otherwise a 405. An unknown path is a 404.
  it('keeps the 405 for a method that the path has no route for, and the 400 when its parameter is malformed, without a statement', async () => {
    for (const [method, url, status, code] of [
      ['PUT', '/api/scan', 405, 'method_not_allowed'],
      ['GET', '/api/admin/points/abc', 405, 'method_not_allowed'],
      ['GET', `/api/admin/points/${MALFORMED}`, 400, 'bad_request'],
      ['GET', '/api/nothing/here', 404, 'not_found'],
      ['GET', `/api/nothing/${MALFORMED}`, 404, 'not_found'],
    ]) {
      const { res, statements } = await withStatements(method, url)
      expect([res.status, res.json.error.code], `${method} ${url}`).toEqual([status, code])
      expect(statements, `${method} ${url}`).toEqual([])
    }
    // The same with a session, as tests/api.test.js sends it.
    expect((await call('GET', `/api/admin/points/${MALFORMED}`, asCookie(VALID.committee))).status).toBe(400)
    expect((await call('GET', '/api/admin/points/abc', asCookie(VALID.committee))).status).toBe(405)
  })
})
