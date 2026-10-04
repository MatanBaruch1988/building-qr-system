// Who may call what: the access policy of the API, in one place. The router (server/router.js) reads it when a route is
// registered and enforces it on every request before any code of the handler runs, so a route is protected by default.
//
//   PUBLIC  The routes that answer without credentials, each with a one-line reason that a reviewer reads. This is the
//           only way to make a route open, and the reason has to justify it.
//   RULES   The guard of every other route, chosen by the path the route is registered with (`/admin/providers/:id`, the
//           pattern, never the path of a request): `/admin/` the committee (requireAdmin), the provider routes the
//           provider (requireProvider), `/agent/v1/` and `/health/db` the agent key (requireApiKey).
//
// How to add a route (route() in server/router.js throws at startup, so the server cannot run with an unguarded route):
//   - A route under an existing rule needs nothing here: it is guarded by the router. Its handler may still call the guard
//     (`const { admin } = await requireAdmin(req)`) to learn who is signed in; the guard remembers its answer for the
//     request, so that costs no second lookup. The context of the handler also has the guard's answer as `auth`.
//   - A route that is meant to answer without credentials gets an entry in PUBLIC, with the reason, and the same route
//     is added to EXPECTED_PUBLIC in tests/route-auth.test.js (a second list, without reasons, so that making a route
//     public needs two edits that a reviewer sees).
//   - A route in a new group of paths needs a rule in RULES (and the same rule in GUARDS of tests/route-auth.test.js, an
//     independent copy that the test compares with this one).
//   - A pattern that no rule owns, or that several rules own, throws when it is registered.
//
// The policy is data and a lookup. There is no function that registers a route without it, and nothing here can be changed
// after the module has loaded: the exports are frozen.
import { requireAdmin, requireProvider, requireApiKey } from './auth.js'
import { requireApiKeyForHealth } from './health.js'

// The routes that are meant to answer without credentials, each with the reason. Everything else must refuse a request
// without credentials. Adding a route here, or making a protected route public, is a security decision: say why.
export const PUBLIC = Object.freeze(
  [
    { method: 'GET', path: '/health', why: 'Uptime monitor liveness check; answers ok and the commit, never queries the database.' },
    { method: 'GET', path: '/public/providers', why: 'Names for the provider login tiles, shown before anyone has signed in (company, contact name, service type only).' },
    { method: 'GET', path: '/public/building', why: 'The building address for the header of the provider app, shown before sign-in; only the address, nothing else about the building.' },
    { method: 'GET', path: '/public/points/resolve', why: 'Lets the phone show the name of a point before sign-in; returns name, description, active flag and GPS mode, never the token or the coordinates.' },
    { method: 'POST', path: '/session', why: 'Provider sign-in: the password in the body is the credential, and attempts are throttled.' },
    { method: 'POST', path: '/admin/google', why: 'Committee sign-in: the Google ID token in the body is the credential, checked with Google and against the committee list.' },
    { method: 'GET', path: '/admin/config', why: 'What the login screen needs to draw the Google button (the client id is public by design) and whether the dev shortcut is on.' },
    { method: 'POST', path: '/admin/dev-login', why: 'Local development shortcut; answers 404 unless DEV_ADMIN_LOGIN is 1 and the code is not running on Vercel.' },
    { method: 'POST', path: '/admin/logout', why: 'Ends the session named by the cookie, if there is one, and clears the cookie; works the same without a cookie and reveals nothing.' },
  ].map((entry) => Object.freeze(entry)),
)

// The guard of a route, by the pattern it is registered with. A rule says which patterns it owns (`owns`), the name of the
// guard (what a route of that role is called in the tests and in a message) and the function that checks the request
// (`check`: resolves with who is signed in, or throws the 401 of its role). `/health/db` has a guard of its own that does
// what requireApiKey does and also answers a database that is down with the 503 of that route (server/health.js).
const RULES = Object.freeze(
  [
    { guard: 'committee', owns: /^\/admin\//, check: requireAdmin },
    { guard: 'provider', owns: /^\/(session|scan|scans\/sync|my\/.*)$/, check: requireProvider },
    { guard: 'agent', owns: /^\/agent\/v1\//, check: requireApiKey },
    { guard: 'agent', owns: /^\/health\/db$/, check: requireApiKeyForHealth },
  ].map((rule) => Object.freeze(rule)),
)

const OPEN = Object.freeze({ public: true })

/**
 * The lookup for a list of public routes and a list of rules. The router uses the one made from PUBLIC and RULES below
 * (`accessFor`); the factory is exported so that tests/access.test.js can try the lookup with other lists (several rules that
 * own one pattern, say). It only answers a question and registers nothing: a route reaches the router through route(), which
 * asks `accessFor`.
 */
export function makeAccessFor(publicRoutes, rules) {
  const guarded = new Map(rules.map((rule) => [rule, Object.freeze({ guard: rule.guard, check: rule.check })]))
  /**
   * The access of a route that is registered as `method` and `pattern`: `{ public: true }` for a public route, otherwise
   * `{ guard, check }` of the one rule that owns the pattern. A public route wins over a rule (POST /session is public while
   * GET and DELETE /session are the provider's). It throws for a pattern that no rule owns and for one that several rules own,
   * so a route can never be registered without a decision about who may call it.
   */
  return function accessFor(method, pattern) {
    if (publicRoutes.some((entry) => entry.method === method && entry.path === pattern)) return OPEN
    const owners = rules.filter((rule) => rule.owns.test(pattern))
    if (owners.length !== 1) {
      throw new Error(
        `${method} ${pattern} is owned by ${owners.length === 0 ? 'no access rule' : `several access rules (${owners.map((r) => r.guard).join(', ')})`}. ` +
          'If the route is meant to answer without credentials, add it to PUBLIC in server/access.js with the reason (and to EXPECTED_PUBLIC in tests/route-auth.test.js). ' +
          'Otherwise add or fix the rule that gives its path a guard in RULES in server/access.js, and in GUARDS of tests/route-auth.test.js.',
      )
    }
    return guarded.get(owners[0])
  }
}

export const accessFor = makeAccessFor(PUBLIC, RULES)
