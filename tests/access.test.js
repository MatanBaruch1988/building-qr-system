// The lookup of server/access.js that decides, when a route is registered, whether it is public or which guard it gets.
// tests/route-auth.test.js proves from the outside that every real route is guarded; this file tries the lookup itself with
// rules of its own, for the cases that the real rules cannot produce (a pattern that two rules own), and checks the shape
// of what the module exports. No database is needed.
import { describe, it, expect } from 'vitest'
import { makeAccessFor, accessFor, PUBLIC } from '../server/access.js'
import { requireAdmin, requireProvider, requireApiKey } from '../server/auth.js'

const check = async () => ({})
const rules = [
  { guard: 'one', owns: /^\/a\//, check },
  { guard: 'two', owns: /^\/a\/b\//, check },
  { guard: 'three', owns: /^\/c\//, check },
]
const open = [{ method: 'GET', path: '/c/open', why: 'A route of this test that answers without credentials.' }]
const lookup = makeAccessFor(open, rules)

describe('the lookup of a route', () => {
  it('gives a route the guard and the check of the one rule that owns its pattern', () => {
    expect(lookup('GET', '/a/x')).toEqual({ guard: 'one', check })
    expect(lookup('DELETE', '/c/y/:id')).toEqual({ guard: 'three', check })
    expect(lookup('GET', '/a/x').check).toBe(check)
  })

  it('throws for a pattern that no rule owns, and says to add a rule or a PUBLIC entry with its reason', () => {
    expect(() => lookup('GET', '/nobody/x')).toThrow(/GET \/nobody\/x is owned by no access rule/)
    expect(() => lookup('GET', '/nobody/x')).toThrow(/add it to PUBLIC in server\/access\.js with the reason/)
    expect(() => lookup('GET', '/nobody/x')).toThrow(/add or fix the rule/)
  })

  it('throws for a pattern that several rules own, and names them', () => {
    expect(() => lookup('GET', '/a/b/x')).toThrow(/is owned by several access rules \(one, two\)/)
  })

  it('lets a public route win over the rule that owns its pattern, for its own method only', () => {
    expect(lookup('GET', '/c/open')).toEqual({ public: true })
    expect(lookup('POST', '/c/open')).toEqual({ guard: 'three', check })
  })

  it('does not let a public path open a longer or a shorter one', () => {
    expect(lookup('GET', '/c/open/more')).toEqual({ guard: 'three', check })
    expect(() => lookup('GET', '/c')).toThrow(/no access rule/)
  })
})

describe('the policy of the server', () => {
  it('gives each of the three roles its own guard, and the agent key to /agent/v1/ and /health/db', () => {
    expect(accessFor('GET', '/admin/me')).toEqual({ guard: 'committee', check: requireAdmin })
    expect(accessFor('GET', '/my/scans')).toEqual({ guard: 'provider', check: requireProvider })
    expect(accessFor('POST', '/scans/sync').guard).toBe('provider')
    expect(accessFor('POST', '/scan').guard).toBe('provider')
    expect(accessFor('GET', '/agent/v1/points')).toEqual({ guard: 'agent', check: requireApiKey })
    // /health/db has a check of its own (it also answers a database that is down with its 503), still the agent role.
    expect(accessFor('GET', '/health/db').guard).toBe('agent')
    expect(typeof accessFor('GET', '/health/db').check).toBe('function')
  })

  it('is public only where PUBLIC says so, and every entry says why', () => {
    for (const entry of PUBLIC) {
      expect(accessFor(entry.method, entry.path), `${entry.method} ${entry.path}`).toEqual({ public: true })
      expect(entry.why.trim().length, `${entry.method} ${entry.path} needs a reason`).toBeGreaterThanOrEqual(20)
    }
    expect(() => accessFor('GET', '/health/db/')).toThrow(/no access rule/) // not the route that it looks like
  })
})
