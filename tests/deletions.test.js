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
