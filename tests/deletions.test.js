// Deleting on purpose: a point can be deleted without losing the scans recorded there, and a single scan row can be
// deleted from the committee screen. Everything else is still refused by the database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'

let db, cookie, provider, token
const HOME = { lat: 32.3132, lng: 34.9442 }
const near = { ...HOME, accuracy: 10 }
const far = { lat: HOME.lat + 0.05, lng: HOME.lng, accuracy: 10 }

const point = async (extra = {}) =>
  (await call('POST', '/api/admin/points', { cookie, body: { name: 'p-' + randomUUID().slice(0, 6), lat: HOME.lat, lng: HOME.lng, ...extra } })).json.point
const scan = (code, gps = near) => call('POST', '/api/scan', { token, body: { id: randomUUID(), code, gps } })
const allScans = async (extra = '') => (await call('GET', `/api/admin/scans?limit=500&outcome=all${extra}`, { cookie })).json.scans
const audit = async (action, entityId) =>
  (await db.pool.query('select detail from audit_log where action = $1 and entity_id = $2', [action, entityId])).rows

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  provider = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'ניקיון', contact_name: 'ליאור', password: 'lior-1234' } })).json.provider
  token = (await call('POST', '/api/session', { body: { provider_id: provider.id, password: 'lior-1234' } })).json.token
})
afterAll(async () => db?.teardown())

describe('deleting a point', () => {
  it('keeps every scan recorded there, with the point name, and takes the point, its assignments and its QR away', async () => {
    const p = await point({ provider_ids: [provider.id] })
    const first = (await scan(p.qr_token)).json.scan
    expect(first.outcome).toBe('accepted')
    const listed = (await call('GET', '/api/admin/points', { cookie })).json.points.find((x) => x.id === p.id)
    expect(listed.scan_count).toBe(1)

    const del = await call('DELETE', `/api/admin/points/${p.id}`, { cookie })
    expect(del.status).toBe(200)
    expect(del.json).toEqual({ ok: true, scans_kept: 1 })

    // gone from the committee's list, and its assignments went with it
    expect((await call('GET', '/api/admin/points', { cookie })).json.points.find((x) => x.id === p.id)).toBeUndefined()
    const left = await db.pool.query('select count(*)::int n from point_providers where point_id = $1', [p.id])
    expect(left.rows[0].n).toBe(0)
    // the scan is still there, still readable by name
    const kept = (await allScans()).find((s) => s.id === first.id)
    expect(kept).toMatchObject({ point_name: p.name, point_id: p.id, outcome: 'accepted' })
    // the printed QR no longer works
    expect((await call('GET', `/api/public/points/resolve?code=${encodeURIComponent(p.qr_token)}`)).status).toBe(404)
    const again = await scan(p.qr_token)
    expect(again.status).toBe(404)
    expect(again.json.error.code).toBe('unknown_code')
    // who did it is on record
    const rows = await audit('point.delete', p.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toMatchObject({ name: p.name, scans_kept: 1 })
  })

  it('works for a point with no scans, and for an inactive one', async () => {
    const empty = await point()
    expect((await call('DELETE', `/api/admin/points/${empty.id}`, { cookie })).json).toEqual({ ok: true, scans_kept: 0 })
    const off = await point({ is_active: true })
    await call('PATCH', `/api/admin/points/${off.id}`, { cookie, body: { is_active: false } })
    expect((await call('DELETE', `/api/admin/points/${off.id}`, { cookie })).status).toBe(200)
  })

  it('says 404 for a point that is not there (or already deleted), and 400 for a malformed id', async () => {
    const p = await point()
    await call('DELETE', `/api/admin/points/${p.id}`, { cookie })
    const twice = await call('DELETE', `/api/admin/points/${p.id}`, { cookie })
    expect(twice.status).toBe(404)
    expect(twice.json.error.code).toBe('point_not_found')
    expect((await call('DELETE', `/api/admin/points/${randomUUID()}`, { cookie })).status).toBe(404)
    expect((await call('DELETE', '/api/admin/points/not-an-id', { cookie })).status).toBe(400)
  })

  it('needs a signed-in committee member', async () => {
    const p = await point()
    expect((await call('DELETE', `/api/admin/points/${p.id}`)).status).toBe(401)
    expect((await call('DELETE', `/api/admin/points/${p.id}`, { token })).status).toBe(401) // a provider is not a committee member
    expect((await call('GET', '/api/admin/points', { cookie })).json.points.find((x) => x.id === p.id)).toBeDefined()
  })
})

describe('deleting a scan row', () => {
  it('removes one row for good, records who did it, and leaves the others', async () => {
    const p = await point()
    const keep = (await scan(p.qr_token)).json.scan
    const other = await point()
    const doomed = (await scan(other.qr_token)).json.scan

    const del = await call('DELETE', `/api/admin/scans/${doomed.id}`, { cookie })
    expect(del.status).toBe(200)
    expect(del.json).toEqual({ ok: true })
    const rows = await allScans('&include_voided=true')
    expect(rows.find((s) => s.id === doomed.id)).toBeUndefined()
    expect(rows.find((s) => s.id === keep.id)).toBeDefined()

    const trail = await audit('scan.delete', doomed.id)
    expect(trail).toHaveLength(1)
    expect(trail[0].detail).toMatchObject({ point_name: other.name, outcome: 'accepted', voided: false })

    const twice = await call('DELETE', `/api/admin/scans/${doomed.id}`, { cookie })
    expect(twice.status).toBe(404)
    expect(twice.json.error.code).toBe('scan_not_found')
  })

  it('also deletes a voided scan and a refused attempt (any row can be cleaned up)', async () => {
    const p = await point({ gps_mode: 'required' })
    const refused = (await scan(p.qr_token, far)).json.scan
    expect(refused.outcome).toBe('rejected_far')
    expect((await call('DELETE', `/api/admin/scans/${refused.id}`, { cookie })).status).toBe(200)

    const q = await point()
    const s = (await scan(q.qr_token)).json.scan
    await call('POST', `/api/admin/scans/${s.id}/void`, { cookie, body: { reason: 'test' } })
    expect((await call('DELETE', `/api/admin/scans/${s.id}`, { cookie })).status).toBe(200)
    const trail = await audit('scan.delete', s.id)
    expect(trail[0].detail.voided).toBe(true)
  })

  it('needs a signed-in committee member, and a well-formed id', async () => {
    const p = await point()
    const s = (await scan(p.qr_token)).json.scan
    expect((await call('DELETE', `/api/admin/scans/${s.id}`)).status).toBe(401)
    expect((await call('DELETE', `/api/admin/scans/${s.id}`, { token })).status).toBe(401)
    expect((await call('DELETE', '/api/admin/scans/nope', { cookie })).status).toBe(400)
    expect((await allScans()).find((x) => x.id === s.id)).toBeDefined()
  })
})

describe('deleting a provider', () => {
  const newProvider = async (extra = {}) =>
    (await call('POST', '/api/admin/providers', { cookie, body: { company: 'גינון', contact_name: 'חמודי', password: 'hamudi-1234', ...extra } })).json.provider
  const signIn = async (p) => (await call('POST', '/api/session', { body: { provider_id: p.id, password: 'hamudi-1234' } })).json.token

  it('keeps every scan recorded for them, with their name, and takes their phones and assignments away', async () => {
    const p = await newProvider()
    const t = await signIn(p)
    const pt = await point({ provider_ids: [p.id] })
    const done = (await call('POST', '/api/scan', { token: t, body: { id: randomUUID(), code: pt.qr_token, gps: near } })).json.scan
    expect(done.outcome).toBe('accepted')
    const listed = (await call('GET', '/api/admin/providers', { cookie })).json.providers.find((x) => x.id === p.id)
    expect(listed.scan_count).toBe(1)

    const del = await call('DELETE', `/api/admin/providers/${p.id}`, { cookie })
    expect(del.status).toBe(200)
    expect(del.json).toEqual({ ok: true, scans_kept: 1 })

    // gone from the list and from the sign-in screen, and signed out of the phone they were on
    expect((await call('GET', '/api/admin/providers', { cookie })).json.providers.find((x) => x.id === p.id)).toBeUndefined()
    expect((await call('GET', '/api/public/providers')).json.providers.find((x) => x.id === p.id)).toBeUndefined()
    expect((await call('GET', '/api/session', { token: t })).status).toBe(401)
    expect((await call('POST', '/api/session', { body: { provider_id: p.id, password: 'hamudi-1234' } })).status).toBeGreaterThanOrEqual(400)
    // their devices and their entry on the point's list went with them
    expect((await db.pool.query('select count(*)::int n from provider_devices where provider_id = $1', [p.id])).rows[0].n).toBe(0)
    expect((await db.pool.query('select count(*)::int n from point_providers where provider_id = $1', [p.id])).rows[0].n).toBe(0)
    // the scan is still there, readable by name, and the history still protects it
    const kept = (await allScans()).find((s) => s.id === done.id)
    expect(kept).toMatchObject({ provider_id: p.id, provider_name: expect.stringContaining('חמודי'), outcome: 'accepted' })
    await expect(db.pool.query('delete from scans where id = $1', [done.id])).rejects.toThrow(/append-only/)
    // who did it is on record
    const rows = await audit('provider.delete', p.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toMatchObject({ company: 'גינון', contact_name: 'חמודי', scans_kept: 1 })
  })

  it('works for a provider with no scans, an inactive one and the demo account', async () => {
    const empty = await newProvider()
    expect((await call('DELETE', `/api/admin/providers/${empty.id}`, { cookie })).json).toEqual({ ok: true, scans_kept: 0 })
    const off = await newProvider()
    await call('PATCH', `/api/admin/providers/${off.id}`, { cookie, body: { is_active: false } })
    expect((await call('DELETE', `/api/admin/providers/${off.id}`, { cookie })).status).toBe(200)
    const demo = await newProvider({ is_demo: true })
    expect((await call('DELETE', `/api/admin/providers/${demo.id}`, { cookie })).status).toBe(200)
  })

  it('says 404 for a provider that is not there, 400 for a malformed id, and needs a committee member', async () => {
    const p = await newProvider()
    expect((await call('DELETE', `/api/admin/providers/${p.id}`)).status).toBe(401)
    expect((await call('DELETE', `/api/admin/providers/${p.id}`, { token })).status).toBe(401) // a provider cannot delete one
    expect((await call('DELETE', `/api/admin/providers/${p.id}`, { cookie })).status).toBe(200)
    const twice = await call('DELETE', `/api/admin/providers/${p.id}`, { cookie })
    expect(twice.status).toBe(404)
    expect(twice.json.error.code).toBe('provider_not_found')
    expect((await call('DELETE', '/api/admin/providers/not-an-id', { cookie })).status).toBe(400)
  })
})

describe('deleting a committee member', () => {
  const add = async (email) => (await call('POST', '/api/admin/admins', { cookie, body: { email, name: 'חבר ועד' } })).json.admin

  it('takes them off the list for good, signs them out, and records who did it', async () => {
    const other = await add('second@test.local')
    const theirCookie = await adminCookie('second@test.local')
    expect((await call('GET', '/api/admin/points', { cookie: theirCookie })).status).toBe(200)

    const del = await call('DELETE', `/api/admin/admins/${other.id}`, { cookie })
    expect(del.status).toBe(200)
    expect(del.json).toEqual({ ok: true })
    expect((await call('GET', '/api/admin/admins', { cookie })).json.admins.find((a) => a.id === other.id)).toBeUndefined()
    expect((await call('GET', '/api/admin/points', { cookie: theirCookie })).status).toBe(401) // their session went with them
    const trail = await audit('admin.delete', other.id)
    expect(trail).toHaveLength(1)
    expect(trail[0].detail).toMatchObject({ email: 'second@test.local' })
    // the same address can be added again later, as a new member
    expect((await add('second@test.local')).id).not.toBe(other.id)
  })

  it('refuses to delete yourself, so the list is never left without someone who can sign in', async () => {
    const me = (await call('GET', '/api/admin/admins', { cookie })).json.admins.find((a) => a.email === 'admin@test.local')
    const r = await call('DELETE', `/api/admin/admins/${me.id}`, { cookie })
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('cannot_delete_self')
    expect((await call('GET', '/api/admin/admins', { cookie })).json.admins.find((a) => a.id === me.id)).toBeDefined()
  })

  it('says 404 for a member that is not there, 400 for a malformed id, and needs a committee member', async () => {
    const other = await add('third@test.local')
    expect((await call('DELETE', `/api/admin/admins/${other.id}`)).status).toBe(401)
    expect((await call('DELETE', `/api/admin/admins/${other.id}`, { token })).status).toBe(401)
    expect((await call('DELETE', `/api/admin/admins/${other.id}`, { cookie })).status).toBe(200)
    const twice = await call('DELETE', `/api/admin/admins/${other.id}`, { cookie })
    expect(twice.status).toBe(404)
    expect(twice.json.error.code).toBe('admin_not_found')
    expect((await call('DELETE', '/api/admin/admins/not-an-id', { cookie })).status).toBe(400)
  })
})

describe('deleting an agent key', () => {
  const newKey = async (name) => (await call('POST', '/api/admin/api-keys', { cookie, body: { name } })).json
  const listed = async () => (await call('GET', '/api/admin/api-keys', { cookie })).json.api_keys

  it('removes the key for good, active or revoked, and an active one stops working at once', async () => {
    const live = await newKey('live')
    expect((await call('GET', '/api/agent/v1/scans', { token: live.key })).status).toBe(200)
    expect((await call('DELETE', `/api/admin/api-keys/${live.api_key.id}`, { cookie })).json).toEqual({ ok: true })
    expect((await listed()).find((k) => k.id === live.api_key.id)).toBeUndefined()
    expect((await call('GET', '/api/agent/v1/scans', { token: live.key })).json.error.code).toBe('api_key_invalid')

    const old = await newKey('old')
    await call('POST', `/api/admin/api-keys/${old.api_key.id}/revoke`, { cookie })
    expect((await listed()).find((k) => k.id === old.api_key.id).revoked_at).not.toBeNull() // revoking keeps the row
    expect((await call('DELETE', `/api/admin/api-keys/${old.api_key.id}`, { cookie })).status).toBe(200)
    expect((await listed()).find((k) => k.id === old.api_key.id)).toBeUndefined()

    const trail = await audit('api_key.delete', live.api_key.id)
    expect(trail[0].detail).toMatchObject({ name: 'live', was_revoked: false })
    expect((await audit('api_key.delete', old.api_key.id))[0].detail.was_revoked).toBe(true)
  })

  it('says 404 for a key that is not there, 400 for a malformed id, and needs a committee member', async () => {
    const k = await newKey('once')
    expect((await call('DELETE', `/api/admin/api-keys/${k.api_key.id}`)).status).toBe(401)
    expect((await call('DELETE', `/api/admin/api-keys/${k.api_key.id}`, { token: k.key })).status).toBe(401) // the key cannot delete itself
    await call('DELETE', `/api/admin/api-keys/${k.api_key.id}`, { cookie })
    const twice = await call('DELETE', `/api/admin/api-keys/${k.api_key.id}`, { cookie })
    expect(twice.status).toBe(404)
    expect(twice.json.error.code).toBe('api_key_not_found')
    expect((await call('DELETE', '/api/admin/api-keys/nope', { cookie })).status).toBe(400)
  })

  it('revoking is its own action: it needs a committee member and a key that is still active', async () => {
    const k = await newKey('rev')
    expect((await call('POST', `/api/admin/api-keys/${k.api_key.id}/revoke`)).status).toBe(401)
    expect((await call('POST', `/api/admin/api-keys/${k.api_key.id}/revoke`, { cookie })).status).toBe(200)
    expect((await call('POST', `/api/admin/api-keys/${k.api_key.id}/revoke`, { cookie })).status).toBe(404) // already revoked
  })
})

describe('the history is still protected from accidents', () => {
  it('refuses every delete that does not come through the committee screen, also right after one that did', async () => {
    const p = await point()
    const s = (await scan(p.qr_token)).json.scan
    await call('DELETE', `/api/admin/scans/${(await scan((await point()).qr_token)).json.scan.id}`, { cookie }) // an allowed delete first
    await expect(db.pool.query('delete from scans where id = $1', [s.id])).rejects.toThrow(/append-only/)
    await expect(db.pool.query('delete from scans')).rejects.toThrow(/append-only/)
    await expect(db.pool.query('truncate scans')).rejects.toThrow(/append-only/)
    await expect(db.pool.query("update scans set point_name = 'x' where id = $1", [s.id])).rejects.toThrow(/append-only/)
    expect((await allScans()).find((x) => x.id === s.id)).toBeDefined()
  })

  it('does not let a delete flag leak out of its transaction', async () => {
    const c = await db.pool.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.allow_scan_delete', 'on', true)")
      await c.query('commit')
      const flag = await c.query("select coalesce(current_setting('app.allow_scan_delete', true), '') as v")
      expect(flag.rows[0].v).not.toBe('on')
    } finally {
      c.release()
    }
  })
})
