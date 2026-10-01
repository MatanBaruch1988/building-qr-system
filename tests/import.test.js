import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { importFirestore } from '../server/importFirestore.js'

let db

const OLD_QR = 'https://building-qr-system.web.app/scan?code=BQR-1770182207272-1770182207272-08tcx7'

const data = {
  workers: [
    { id: 'w1', company: 'ניקיון', name: 'ליאור', isActive: true, pinHash: 'old', createdAt: { __ts: '2026-02-01T08:00:00.000Z' } },
    { id: 'w2', company: 'גינון', name: 'חמודי', isActive: true },
    { id: 'w3', company: 'בדיקות', name: 'מערכת', isActive: false },
  ],
  locations: [
    {
      id: 'l1', name: 'לובי', description: 'קומת קרקע', latitude: 32.3132, longitude: 34.9442, radiusMeters: 50,
      isActive: true, qrCode: OLD_QR, assignedWorkerIds: ['', 'w1', 'w-deleted'], createdAt: { __ts: '2026-02-01T08:00:00.000Z' },
    },
    { id: 'l2', name: 'גימבורי', latitude: 32.31, longitude: 34.94, radiusMeters: 5000, isActive: true,
      qrCode: 'https://building-qr-system.web.app/scan?code=BQR-1770302217878-1770302217878-sd1vhk', assignedWorkerId: 'w2' },
    { id: 'l3', name: 'בלי QR', isActive: false, qrCode: 'garbage' },
    { id: 'l4', name: 'יתום', qrCode: 'https://x.web.app/scan?code=BQR-1770999999999-1770999999999-orphan', assignedWorkerIds: ['ghost'] },
  ],
  scans: [
    // online scan, ISO-string timestamp (old shape)
    { id: 's1', locationId: 'l1', workerId: 'w1', timestamp: '2026-02-02T06:00:00.000Z', createdAt: { __ts: '2026-02-02T06:00:01.000Z' }, distanceMeters: 12.6, gpsAccuracy: 8 },
    // offline-synced: timestamp = sync time, originalTimestamp = real scan time, no createdAt
    { id: 's2', locationId: 'l1', workerId: 'w1', timestamp: { __ts: '2026-02-03T20:00:00.000Z' }, originalTimestamp: '2026-02-03T07:00:00.000Z', syncedFromOffline: true },
    { id: 's3', locationId: 'gone', workerId: 'w1', timestamp: '2026-02-03T07:00:00.000Z' },
    { id: 's4', locationId: 'l1', workerId: 'w1' },
  ],
  failedScans: [{ id: 'f1', locationId: 'l2', workerId: 'w2', timestamp: '2026-02-04T09:00:00.000Z', distanceMeters: 800, gpsAccuracy: 20 }],
}

beforeAll(async () => {
  db = await setupDb()
})
afterAll(async () => db?.teardown())

const run = async () => {
  const c = await db.pool.connect()
  try {
    await c.query('begin')
    const report = await importFirestore(c, data)
    await c.query('commit')
    return report
  } finally {
    c.release()
  }
}

describe('Firestore import', () => {
  it('imports points, providers, assignments and scans with sensible defaults, and warns about the rest', async () => {
    const r = await run()
    expect(r.inserted).toEqual({ points: 4, providers: 3, assignments: 2, scans: 3 })
    expect(r.warnings.join('\n')).toMatch(/w-deleted.*no longer exists/)
    expect(r.warnings.join('\n')).toMatch(/"יתום": every assigned worker was deleted.*OPEN TO ALL/)
    expect(r.warnings.join('\n')).toMatch(/refers to a missing point/)
    expect(r.warnings.join('\n')).toMatch(/no usable time/)
    expect(r.warnings.join('\n')).toMatch(/no readable QR/)
    expect(r.warnings.join('\n')).toMatch(/set a new password/)

    const providers = (await db.pool.query('select company, contact_name, service_type, is_active, password_hash from providers order by company')).rows
    expect(providers).toEqual([
      { company: 'בדיקות', contact_name: 'מערכת', service_type: null, is_active: false, password_hash: null },
      { company: 'גינון', contact_name: 'חמודי', service_type: 'gardening', is_active: true, password_hash: null },
      { company: 'ניקיון', contact_name: 'ליאור', service_type: 'cleaning', is_active: true, password_hash: null },
    ])

    const points = (await db.pool.query('select name, qr_token, radius_m, is_active, gps_mode from points order by name')).rows
    const byName = Object.fromEntries(points.map((p) => [p.name, p]))
    expect(byName['לובי'].qr_token).toBe('BQR-1770182207272-1770182207272-08tcx7') // printed QR preserved
    expect(byName['גימבורי'].radius_m).toBe(50) // out-of-range radius replaced by the default
    expect(byName['בלי QR'].qr_token).toMatch(/^BQR-[0-9a-f]{24}$/)
    expect(byName['לובי'].gps_mode).toBe('optional')
  })

  it('unifies the old timestamp shapes into checked_in_at / client_time', async () => {
    const rows = (await db.pool.query('select point_name, checked_in_at, client_time, source, outcome, distance_m, gps_accuracy_m, flags, local_date from scans order by checked_in_at')).rows
    expect(rows).toHaveLength(3)
    const [online, offline, failed] = rows // sorted by time
    // online: the server's createdAt wins over the phone's clock, which is kept as client_time
    expect(online.checked_in_at.toISOString()).toBe('2026-02-02T06:00:01.000Z')
    expect(online.client_time.toISOString()).toBe('2026-02-02T06:00:00.000Z')
    expect(online.outcome).toBe('accepted')
    expect(online.distance_m).toBe(13)
    expect(online.local_date).toBe('2026-02-02')
    // offline: the real scan time, not the (later) sync time
    expect(offline.checked_in_at.toISOString()).toBe('2026-02-03T07:00:00.000Z')
    expect(offline.source).toBe('offline_sync')
    expect(offline.flags).toEqual(['legacy_import', 'offline_sync'])
    expect(failed.outcome).toBe('rejected_far')
    expect(failed.distance_m).toBe(800)
  })

  it('is idempotent: a second run inserts nothing', async () => {
    const r = await run()
    expect(r.inserted).toEqual({ points: 0, providers: 0, assignments: 0, scans: 0 })
    expect(r.alreadyPresent).toEqual({ points: 4, providers: 3 })
    expect((await db.pool.query('select count(*)::int n from scans')).rows[0].n).toBe(3)
  })

  it('the old printed QR URL still resolves and can be scanned after the migration', async () => {
    await seedAdmin(db.pool)
    const cookie = await adminCookie()
    const providers = (await call('GET', '/api/admin/providers', { cookie })).json.providers
    const lior = providers.find((p) => p.contact_name === 'ליאור')
    expect(lior.has_password).toBe(false)

    // Can't sign in until the committee sets a password...
    expect((await call('POST', '/api/session', { body: { provider_id: lior.id, password: 'x1234567' } })).status).toBe(401)
    await call('PATCH', `/api/admin/providers/${lior.id}`, { cookie, body: { password: 'fresh-pass-1' } })
    const token = (await call('POST', '/api/session', { body: { provider_id: lior.id, password: 'fresh-pass-1' } })).json.token

    const resolved = await call('GET', `/api/public/points/resolve?code=${encodeURIComponent(OLD_QR)}`)
    expect(resolved.json.point.name).toBe('לובי')
    const r = await call('POST', '/api/scan', { token, body: { id: randomUUID(), code: OLD_QR } })
    expect(r.status).toBe(200)
    expect(r.json.scan.point_name).toBe('לובי')

    // assignment carried over: the gardener-only point refuses the cleaner
    const gym = await call('POST', '/api/scan', {
      token,
      body: { id: randomUUID(), code: 'BQR-1770302217878-1770302217878-sd1vhk' },
    })
    expect(gym.json.error.code).toBe('not_assigned')
  })
})
