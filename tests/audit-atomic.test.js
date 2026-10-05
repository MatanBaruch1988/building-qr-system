// Every change that the committee makes and its audit row are ONE transaction (server/audit.js, server/routes/admin.js): there
// is no change without its row and no row without its change. This file proves it for every committee route that writes:
//   - (a) a call that succeeds writes exactly one new audit row, with the right actor, action, entity and detail;
//   - (b) a call whose audit row is refused by the database (a check constraint that refuses that action, added `not valid` so
//     the rows that are already there are left alone) answers 500 and changes NOTHING: a snapshot of every table of the schema
//     equals the one taken before the call. And once the constraint is gone the same call succeeds, which it could not if
//     the change had been kept (a retry used to get a 404 or a 409 for a change that did happen).
// A walk over the route table fails when a committee route that writes is not in the table below, so a new route cannot be added
// without its atomic test. The two non-atomic spots that this change fixed (switching a member off, and the Google sign-in) have
// tests of their own, and so have the pieces of server/audit.js. The data is fake.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import '../server/index.js' // registers every route, so that routeTable() has them
import { routeTable } from '../server/router.js'
import { audit, adminActor } from '../server/audit.js'
import { getPool, query, tx } from '../server/db.js'
import { AUDIT_ACTOR_NAME_MAX_LENGTH } from '../server/config.js'

let db, cookie, admin, helper

// The test's own statements (fixtures, snapshots, the refusing constraints) run on one connection of their own, outside a
// transaction, so that each is one round trip to the remote database instead of three (the pool wraps a statement in one).
const q = (text, params) => helper.query(text, params)
const one = async (text, params) => (await q(text, params)).rows[0]
const uniq = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`

// ---------- fixtures: made with SQL, so that a test does not depend on another route ----------

const newMember = async ({ active = true, session = false, googleSub = null, name = 'Fake Member' } = {}) => {
  const email = `${uniq('member')}@test.local`
  const { id } = await one('insert into admins (email, name, is_active, google_sub) values ($1, $2, $3, $4) returning id', [email, name, active, googleSub])
  if (session) {
    await q("insert into admin_sessions (admin_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')", [id, uniq('session')])
  }
  return { id, email }
}
const newPoint = async () => (await one('insert into points (name, qr_token) values ($1, $2) returning id, name', [uniq('Point'), `BQR-${uniq('code')}`]))
const newProvider = async ({ device = false } = {}) => {
  const provider = await one("insert into providers (company, contact_name) values ($1, '') returning id, company", [uniq('Company')])
  if (device) await q('insert into provider_devices (provider_id, token_hash) values ($1, $2)', [provider.id, uniq('device')])
  return provider
}
const SCAN_TIME = '2026-01-02T03:04:05.000Z' // the time of every fixture scan, as the audit entry of a deleted scan writes it
const newScan = async ({ voided = false } = {}) => {
  const id = randomUUID()
  await q(
    `insert into scans (id, point_id, provider_id, point_name, provider_name, checked_in_at, local_date, source, outcome, voided_at)
     values ($1, $2, $3, 'Fake point', 'Fake provider', $4, '2026-01-02', 'online', 'accepted', $5)`,
    [id, randomUUID(), randomUUID(), SCAN_TIME, voided ? SCAN_TIME : null],
  )
  return id
}
const newKey = async () =>
  one("insert into api_keys (name, key_prefix, key_hash) values ($1, 'qrk_fake', $2) returning id, name", [uniq('Key'), uniq('hash')])

// ---------- the state of the whole schema ----------

let TABLES
/** Every row of every table of the schema, as JSON, by table name: the state of the whole database, in one round trip. */
async function snapshot() {
  TABLES ??= (
    await q(
      `select table_name as name from information_schema.tables
        where table_schema = current_schema() and table_type = 'BASE TABLE' order by 1`,
    )
  ).rows.map((r) => r.name)
  const parts = TABLES.map(
    (name) => `'${name}', (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) from "${name}" t)`,
  )
  return (await q(`select jsonb_build_object(${parts.join(', ')}) as state`)).rows[0].state
}

const auditCount = async (where = 'true', params = []) => (await one(`select count(*)::int as n from audit_log where ${where}`, params)).n
const lastAuditId = async () => (await one('select coalesce(max(id), 0)::int as n from audit_log')).n

/** Runs `fn` while every new row of audit_log with this action is refused by the database. The constraint is dropped after. */
async function refusingAudit(action, fn) {
  const name = `refuse_${action.replace(/\W/g, '_')}`
  await q(`alter table audit_log add constraint ${name} check (action <> '${action}') not valid`)
  try {
    return await fn()
  } finally {
    await q(`alter table audit_log drop constraint ${name}`)
  }
}

/** Runs `fn` with console.error silenced (a 500 logs one line by design) and returns what was logged with the result. */
async function quietly(fn) {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const result = await fn()
    return { result, logged: [...spy.mock.calls] }
  } finally {
    spy.mockRestore()
  }
}

beforeAll(async () => {
  db = await setupDb()
  helper = await db.pool.connect()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  admin = await one("select id, email, name from admins where email = 'admin@test.local'")
})
afterAll(async () => {
  helper?.release()
  await db?.teardown()
})

// ---------- the table: every committee route that writes ----------

// The committee routes that sign a member in or out. They write no audit row today (a later change records sign-ins), and the
// sign-in itself has its own tests below.
const SESSION_ROUTES = ['POST /admin/google', 'POST /admin/dev-login', 'POST /admin/logout']

// One entry for every route (and every action of a route that has two): `route` is the method and the path as the route is
// registered; `prepare()` creates what the call needs and returns the url, the body and the id of the entity (or
// `entityId(answer)` says how to read it from the answer of a route that creates it); `detail` is what the entry says, exactly
// as it did before the change (null: nothing). `status` is the answer of a success.
const ROUTES = [
  {
    route: 'POST /admin/admins', action: 'admin.add', entity: 'admin', status: 201,
    prepare: async () => {
      const email = `${uniq('added')}@test.local` // a new address every time: the insert must be rolled back, not an update
      return { url: '/api/admin/admins', body: { email, name: 'Added Member' }, detail: { email } }
    },
    entityId: (a) => a.json.admin.id,
  },
  {
    route: 'PATCH /admin/admins/:id', action: 'admin.disable', entity: 'admin',
    prepare: async () => {
      const { id } = await newMember({ session: true })
      return { url: `/api/admin/admins/${id}`, body: { is_active: false }, entityId: id }
    },
    detail: null,
  },
  {
    route: 'PATCH /admin/admins/:id', action: 'admin.enable', entity: 'admin',
    prepare: async () => {
      const { id } = await newMember({ active: false })
      return { url: `/api/admin/admins/${id}`, body: { is_active: true }, entityId: id }
    },
    detail: null,
  },
  {
    route: 'DELETE /admin/admins/:id', action: 'admin.delete', entity: 'admin',
    prepare: async () => {
      const { id, email } = await newMember({ name: 'Doomed Member' })
      return { url: `/api/admin/admins/${id}`, entityId: id, detail: { email, name: 'Doomed Member' } }
    },
  },
  {
    route: 'PUT /admin/building', action: 'building.update', entity: 'building',
    prepare: async () => ({ url: '/api/admin/building', body: { address: 'Fake street 1' }, entityId: null }),
    detail: { address: 'Fake street 1' },
  },
  {
    route: 'POST /admin/points', action: 'point.create', entity: 'point', status: 201,
    prepare: async () => ({ url: '/api/admin/points', body: { name: 'Created point', lat: 32, lng: 34.8 } }),
    entityId: (a) => a.json.point.id,
    detail: { name: 'Created point', lat: 32, lng: 34.8 },
  },
  {
    route: 'PATCH /admin/points/:id', action: 'point.update', entity: 'point',
    prepare: async () => {
      const { id } = await newPoint()
      return { url: `/api/admin/points/${id}`, body: { name: 'Renamed point' }, entityId: id }
    },
    detail: { name: 'Renamed point' },
  },
  {
    route: 'DELETE /admin/points/:id', action: 'point.delete', entity: 'point',
    prepare: async () => {
      const { id, name } = await newPoint()
      return { url: `/api/admin/points/${id}`, entityId: id, detail: { name, scans_kept: 0 } }
    },
  },
  {
    route: 'POST /admin/points/:id/regenerate-qr', action: 'point.regenerate_qr', entity: 'point',
    prepare: async () => {
      const { id } = await newPoint()
      return { url: `/api/admin/points/${id}/regenerate-qr`, body: {}, entityId: id }
    },
    detail: null,
  },
  {
    route: 'POST /admin/providers', action: 'provider.create', entity: 'provider', status: 201,
    prepare: async () => ({ url: '/api/admin/providers', body: { company: 'Created company', password: 'fake-password-1' } }),
    entityId: (a) => a.json.provider.id,
    detail: { company: 'Created company' },
  },
  {
    route: 'PATCH /admin/providers/:id', action: 'provider.update', entity: 'provider',
    prepare: async () => {
      const { id } = await newProvider({ device: true })
      return { url: `/api/admin/providers/${id}`, body: { company: 'Renamed company', is_active: false }, entityId: id }
    },
    detail: { company: 'Renamed company', is_active: false, password_changed: false },
  },
  {
    route: 'DELETE /admin/providers/:id', action: 'provider.delete', entity: 'provider',
    prepare: async () => {
      const { id, company } = await newProvider({ device: true })
      return { url: `/api/admin/providers/${id}`, entityId: id, detail: { company, contact_name: '', scans_kept: 0 } }
    },
  },
  {
    route: 'POST /admin/providers/:id/revoke-devices', action: 'provider.revoke_devices', entity: 'provider',
    prepare: async () => {
      const { id } = await newProvider({ device: true })
      return { url: `/api/admin/providers/${id}/revoke-devices`, body: {}, entityId: id }
    },
    detail: { devices: 1 },
  },
  {
    route: 'POST /admin/scans/:id/void', action: 'scan.void', entity: 'scan',
    prepare: async () => {
      const id = await newScan()
      return { url: `/api/admin/scans/${id}/void`, body: { reason: 'Fake reason' }, entityId: id }
    },
    detail: { reason: 'Fake reason' },
  },
  {
    route: 'POST /admin/scans/:id/unvoid', action: 'scan.unvoid', entity: 'scan',
    prepare: async () => {
      const id = await newScan({ voided: true })
      return { url: `/api/admin/scans/${id}/unvoid`, body: {}, entityId: id }
    },
    detail: { reason: null },
  },
  {
    route: 'DELETE /admin/scans/:id', action: 'scan.delete', entity: 'scan',
    prepare: async () => {
      const id = await newScan()
      return {
        url: `/api/admin/scans/${id}`,
        entityId: id,
        detail: { point_name: 'Fake point', provider_name: 'Fake provider', checked_in_at: SCAN_TIME, outcome: 'accepted', voided: false },
      }
    },
  },
  {
    route: 'POST /admin/api-keys', action: 'api_key.create', entity: 'api_key', status: 201,
    prepare: async () => ({ url: '/api/admin/api-keys', body: { name: 'Created key' } }),
    entityId: (a) => a.json.api_key.id,
    detail: { name: 'Created key' },
  },
  {
    route: 'POST /admin/api-keys/:id/revoke', action: 'api_key.revoke', entity: 'api_key',
    prepare: async () => {
      const { id } = await newKey()
      return { url: `/api/admin/api-keys/${id}/revoke`, body: {}, entityId: id }
    },
    detail: null,
  },
  {
    route: 'DELETE /admin/api-keys/:id', action: 'api_key.delete', entity: 'api_key',
    prepare: async () => {
      const { id, name } = await newKey()
      return { url: `/api/admin/api-keys/${id}`, entityId: id, detail: { name, key_prefix: 'qrk_fake', was_revoked: false } }
    },
  },
]

const methodOf = (entry) => entry.route.split(' ')[0]
const send = (entry, prepared) => call(methodOf(entry), prepared.url, { cookie, body: prepared.body ?? {} })

describe('every committee route that writes: the change and its audit row are one transaction', () => {
  for (const entry of ROUTES) {
    describe(`${entry.route} (${entry.action})`, () => {
      it('(a) writes exactly one audit row, with the actor and what was done', async () => {
        const prepared = await entry.prepare()
        const after = await lastAuditId()
        const answer = await send(entry, prepared)
        expect(answer.status, answer.text).toBe(entry.status ?? 200)

        const { rows } = await q('select * from audit_log where id > $1 order by id', [after])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          actor_type: 'admin',
          actor_id: admin.id,
          actor_name: 'Test Admin',
          action: entry.action,
          entity: entry.entity,
          entity_id: (entry.entityId ? entry.entityId(answer) : prepared.entityId) ?? null,
        })
        expect(rows[0].detail).toEqual(prepared.detail ?? entry.detail ?? null)
      })

      it('(b) changes nothing when its audit row is refused, answers 500, and works when it is tried again', async () => {
        const prepared = await entry.prepare()
        const before = await snapshot()
        const { result: refused, logged } = await quietly(() => refusingAudit(entry.action, () => send(entry, prepared)))
        expect(refused.status, refused.text).toBe(500)
        expect(refused.json.error.code).toBe('server_error')
        expect(logged).toHaveLength(1) // the router logs the failure once, and nothing else logs it
        // The whole database is as it was: the change was rolled back with its row, in every table.
        expect(await snapshot()).toEqual(before)

        // A retry is a first try: nothing of the failed call is left to make it a 404 or a 409.
        const retry = await send(entry, prepared)
        expect(retry.status, retry.text).toBe(entry.status ?? 200)
        expect(await auditCount('action = $1', [entry.action])).toBeGreaterThanOrEqual(1)
      })
    })
  }
})

describe('the table covers every committee route that writes', () => {
  const key = (r) => `${r.method} ${r.path}`
  const writing = routeTable().filter((r) => r.method !== 'GET' && r.path.startsWith('/admin/')).map(key)

  it('fails for a committee route that is neither in the table above nor a session route: a new route needs its atomic test', () => {
    const covered = new Set([...ROUTES.map((e) => e.route), ...SESSION_ROUTES])
    expect(
      writing.filter((k) => !covered.has(k)),
      'add the route to ROUTES in tests/audit-atomic.test.js (its change and its audit row in one transaction), or to SESSION_ROUTES if it only signs a member in or out',
    ).toEqual([])
  })

  it('has no entry for a route that does not exist', () => {
    const stale = [...ROUTES.map((e) => e.route), ...SESSION_ROUTES].filter((k) => !writing.includes(k))
    expect(stale, 'a route was renamed or removed: fix or remove its entry').toEqual([])
  })

  it('has one entry for every action, and the actions are the ones the code writes', () => {
    const actions = ROUTES.map((e) => e.action)
    expect(new Set(actions).size).toBe(actions.length)
    const source = readFileSync(new URL('../server/routes/admin.js', import.meta.url), 'utf8')
    for (const action of actions) expect(source, action).toContain(`'${action}'`)
  })
})

describe('there is one way to write an audit row', () => {
  /** Every .js and .mjs file under a folder, as a path relative to the repository. */
  const filesUnder = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? filesUnder(path) : /\.m?js$/.test(name) ? [path] : []
    })
  const root = fileURLToPath(new URL('..', import.meta.url))

  it('is server/audit.js: no other file of the server or the API inserts into audit_log', () => {
    const writers = [...filesUnder(join(root, 'server')), ...filesUnder(join(root, 'api'))]
      .filter((file) => /insert\s+into\s+audit_log/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).replaceAll('\\', '/'))
    expect(writers).toEqual(['server/audit.js'])
  })

  it('is not called with the module query() in the routes: every audit() call there passes the client of its transaction', () => {
    const source = readFileSync(join(root, 'server/routes/admin.js'), 'utf8')
    const calls = [...source.matchAll(/\baudit\(([^,)]*)/g)].map((m) => m[1].trim())
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls)).toEqual(new Set(['c']))
  })
})

describe('audit() and adminActor()', () => {
  const actor = { type: 'admin', id: 'fake-actor', name: 'Fake Person' }

  it('refuse to run without the client of a transaction: nothing is written', async () => {
    const before = await auditCount()
    await expect(audit(undefined, actor, 'test.no_client')).rejects.toThrow(TypeError)
    await expect(audit(null, actor, 'test.no_client')).rejects.toThrow(/client of the transaction/)
    await expect(audit({}, actor, 'test.no_client')).rejects.toThrow(TypeError)
    await expect(audit({ query: 'not a function' }, actor, 'test.no_client')).rejects.toThrow(TypeError)
    // The module's query function is not a client either, and neither is the pool: both would write in a transaction of their own.
    await expect(audit(query, actor, 'test.no_client')).rejects.toThrow(TypeError)
    await expect(audit(getPool(), actor, 'test.no_client')).rejects.toThrow(/not the pool/)
    expect(await auditCount()).toBe(before)
  })

  it('refuse an actor of an unknown type and a missing action', async () => {
    await tx(async (c) => {
      await expect(audit(c, undefined, 'test.bad')).rejects.toThrow(TypeError)
      await expect(audit(c, { type: 'robot', id: null, name: null }, 'test.bad')).rejects.toThrow(/actor of type/)
      await expect(audit(c, actor, '')).rejects.toThrow(/the action/)
      await expect(audit(c, actor, undefined)).rejects.toThrow(TypeError)
    })
    expect(await auditCount("action = 'test.bad' or action = ''")).toBe(0)
  })

  it('write the row with the client: it is committed with the transaction, and gone when the transaction is rolled back', async () => {
    await tx((c) => audit(c, actor, 'test.committed', { entity: 'point', entityId: 'p-1', detail: { name: 'Fake point' } }))
    expect(await one("select * from audit_log where action = 'test.committed'")).toMatchObject({
      actor_type: 'admin', actor_id: 'fake-actor', actor_name: 'Fake Person', entity: 'point', entity_id: 'p-1', detail: { name: 'Fake point' },
    })

    await expect(
      tx(async (c) => {
        await audit(c, actor, 'test.rolled_back')
        throw new Error('the change failed after the row was written')
      }),
    ).rejects.toThrow(/the change failed/)
    expect(await auditCount("action = 'test.rolled_back'")).toBe(0)
  })

  it('take every part of the row except the actor and the action as optional, and write them as null', async () => {
    await tx((c) => audit(c, { type: 'system', id: null, name: null }, 'test.minimal'))
    expect(await one("select * from audit_log where action = 'test.minimal'")).toMatchObject({
      actor_type: 'system', actor_id: null, actor_name: null, entity: null, entity_id: null, detail: null,
    })
  })

  it('build the actor of a member: the name, else the e-mail, else null, cut by characters to the limit of the column', () => {
    expect(adminActor({ id: 'a-1', name: 'Fake Person', email: 'fake@test.local' })).toEqual({ type: 'admin', id: 'a-1', name: 'Fake Person' })
    expect(adminActor({ id: 'a-1', name: '', email: 'fake@test.local' })).toMatchObject({ name: 'fake@test.local' })
    expect(adminActor({ id: 'a-1', name: null, email: 'fake@test.local' })).toMatchObject({ name: 'fake@test.local' })
    expect(adminActor({ id: 'a-1', name: '', email: '' })).toMatchObject({ name: null })
    // Two UTF-16 units per character: a cut by units would keep half of them, and could split one in two.
    const cut = adminActor({ id: 'a-1', name: '😀'.repeat(AUDIT_ACTOR_NAME_MAX_LENGTH + 5), email: 'fake@test.local' }).name
    expect(Array.from(cut)).toHaveLength(AUDIT_ACTOR_NAME_MAX_LENGTH)
    expect(cut).toBe('😀'.repeat(AUDIT_ACTOR_NAME_MAX_LENGTH))
  })
})

describe('a refused change records nothing', () => {
  it('writes no audit row when the route answers 404 or 409', async () => {
    const before = await auditCount()
    const missing = randomUUID()
    const voided = await newScan({ voided: true })
    const key = await newKey()
    await q('update api_keys set revoked_at = now() where id = $1', [key.id])
    const answers = [
      await call('PATCH', `/api/admin/admins/${missing}`, { cookie, body: { is_active: false } }),
      await call('DELETE', `/api/admin/admins/${missing}`, { cookie }),
      await call('PATCH', `/api/admin/points/${missing}`, { cookie, body: { name: 'x' } }),
      await call('DELETE', `/api/admin/points/${missing}`, { cookie }),
      await call('POST', `/api/admin/points/${missing}/regenerate-qr`, { cookie, body: {} }),
      await call('PATCH', `/api/admin/providers/${missing}`, { cookie, body: { company: 'x' } }),
      await call('DELETE', `/api/admin/providers/${missing}`, { cookie }),
      await call('DELETE', `/api/admin/scans/${missing}`, { cookie }),
      await call('POST', `/api/admin/scans/${missing}/void`, { cookie, body: {} }),
      await call('POST', `/api/admin/scans/${voided}/void`, { cookie, body: {} }), // already voided: 409
      await call('POST', `/api/admin/api-keys/${key.id}/revoke`, { cookie, body: {} }), // already revoked: 404
      await call('DELETE', `/api/admin/api-keys/${missing}`, { cookie }),
    ]
    expect(answers.map((a) => a.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 404, 409, 404, 404])
    expect(await auditCount()).toBe(before)
  })
})

describe('POST /api/admin/providers/:id/revoke-devices', () => {
  const revoke = (id) => call('POST', `/api/admin/providers/${id}/revoke-devices`, { cookie, body: {} })

  it('answers 0 for a provider that does not exist, as before, and writes no audit row for it', async () => {
    const id = randomUUID()
    const answer = await revoke(id)
    expect([answer.status, answer.json]).toEqual([200, { revoked: 0 }])
    expect(await auditCount('entity = $1 and entity_id = $2', ['provider', id])).toBe(0)
  })

  it('still records a provider that exists and has no phone to revoke, with 0 devices', async () => {
    const { id } = await newProvider()
    const answer = await revoke(id)
    expect([answer.status, answer.json]).toEqual([200, { revoked: 0 }])
    expect((await one("select detail from audit_log where action = 'provider.revoke_devices' and entity_id = $1", [id])).detail).toEqual({ devices: 0 })
  })
})

describe('PATCH /api/admin/admins/:id: the switch and the sign-out of the sessions are one step', () => {
  const patch = (id, is_active) => call('PATCH', `/api/admin/admins/${id}`, { cookie, body: { is_active } })

  it('leaves the member enabled, with every session still working, when revoking the sessions fails', async () => {
    const { id } = await newMember({ session: true })
    const before = await snapshot()
    // Revoking a session sets revoked_at: refuse every row that has it set (NOT VALID leaves the rows that are there alone).
    await q('alter table admin_sessions add constraint refuse_revoke check (revoked_at is null) not valid')
    let answer
    try {
      answer = (await quietly(() => patch(id, false))).result
    } finally {
      await q('alter table admin_sessions drop constraint refuse_revoke')
    }
    expect(answer.status).toBe(500)
    expect((await one('select is_active from admins where id = $1', [id])).is_active).toBe(true)
    expect((await one('select count(*)::int as n from admin_sessions where admin_id = $1 and revoked_at is null', [id])).n).toBe(1)
    expect(await snapshot()).toEqual(before)
  })

  it('switches the member off, signs out their sessions and records it, together', async () => {
    const { id } = await newMember({ session: true })
    const after = await lastAuditId()
    const answer = await patch(id, false)
    expect([answer.status, answer.json.admin.is_active]).toEqual([200, false])
    expect((await one('select count(*)::int as n from admin_sessions where admin_id = $1 and revoked_at is null', [id])).n).toBe(0)
    expect((await q('select action from audit_log where id > $1', [after])).rows).toEqual([{ action: 'admin.disable' }])
  })

  it('answers 404 for a member that does not exist, and 409 when you switch yourself off, and writes nothing', async () => {
    const before = await snapshot()
    expect((await patch(randomUUID(), false)).json.error.code).toBe('admin_not_found')
    expect((await patch(admin.id, false)).json.error.code).toBe('cannot_deactivate_self')
    expect(await snapshot()).toEqual(before)
  })
})

describe('POST /api/admin/google: the sign-in is one step, and a refused one writes nothing', () => {
  // The test verifier (tests/helpers.js) takes the credential as the e-mail and answers with the name 'Test Admin' and the
  // Google account 'sub-<e-mail>'.
  const signIn = (email) => call('POST', '/api/admin/google', { body: { credential: email } })
  const stored = async (id) => one('select * from admins where id = $1', [id])
  const sessions = async (id) => (await one('select count(*)::int as n from admin_sessions where admin_id = $1', [id])).n

  it('writes nothing to the committee list when the e-mail is linked to another Google account', async () => {
    const { id, email } = await newMember({ googleSub: 'sub-someone-else', name: '' })
    const before = await stored(id)
    const answer = await signIn(email)
    expect([answer.status, answer.json.error.code]).toEqual([403, 'google_account_mismatch'])
    // Not the name either: it used to be written from the Google account before the mismatch was looked at.
    expect(await stored(id)).toEqual(before)
    expect(before.name).toBe('')
    expect(before.last_login_at).toBeNull()
    expect(await sessions(id)).toBe(0)
  })

  it('on a first sign-in links the account, fills in the name, records the time and opens one session, together', async () => {
    const { id, email } = await newMember({ name: '' })
    const answer = await signIn(email)
    expect(answer.status).toBe(200)
    expect(answer.json.admin).toEqual({ id, email, name: 'Test Admin' })
    expect(String(answer.headers['set-cookie'])).toMatch(/^qr_admin=qra_/)
    expect(await stored(id)).toMatchObject({ google_sub: `sub-${email}`, name: 'Test Admin' })
    expect((await stored(id)).last_login_at).not.toBeNull()
    expect(await sessions(id)).toBe(1)
    // The next sign-in of the same account is fine and keeps the link.
    expect((await signIn(email)).status).toBe(200)
    expect(await sessions(id)).toBe(2)
  })

  it('keeps the name the member already has', async () => {
    const { id, email } = await newMember({ name: 'Chosen Name' })
    expect((await signIn(email)).json.admin.name).toBe('Chosen Name')
    expect((await stored(id)).name).toBe('Chosen Name')
  })

  it('writes no link, no name and no time when the session cannot be opened', async () => {
    const { id, email } = await newMember({ name: '' })
    const before = await stored(id)
    await q('alter table admin_sessions add constraint refuse_session check (false) not valid')
    let answer
    try {
      answer = (await quietly(() => signIn(email))).result
    } finally {
      await q('alter table admin_sessions drop constraint refuse_session')
    }
    expect(answer.status).toBe(500)
    expect(await stored(id)).toEqual(before)
    expect(before.google_sub).toBeNull()
    expect(await sessions(id)).toBe(0)
  })

  it('refuses an e-mail that is not on the list, and one that was switched off, and creates nothing', async () => {
    const off = await newMember({ active: false })
    const before = await snapshotWithout('auth_attempts')
    expect((await signIn('stranger@test.local')).json.error.code).toBe('not_an_admin')
    expect((await signIn(off.email)).json.error.code).toBe('not_an_admin')
    expect(await snapshotWithout('auth_attempts')).toEqual(before)
  })

  it('writes no audit row (sign-ins are not recorded by this change)', async () => {
    const { email } = await newMember()
    const after = await lastAuditId()
    expect((await signIn(email)).status).toBe(200)
    expect(await lastAuditId()).toBe(after)
  })
})

/** The snapshot of the schema without the tables that a request writes whatever its answer is (the login throttle). */
async function snapshotWithout(...skipped) {
  const state = await snapshot()
  return Object.fromEntries(Object.entries(state).filter(([name]) => !skipped.includes(name)))
}
