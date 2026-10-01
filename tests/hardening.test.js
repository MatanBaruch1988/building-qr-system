// Regression tests for the issues found in the independent backend review.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'

let db, cookie, token, provider
const HOME = { lat: 32.3132, lng: 34.9442 }
const far = { lat: HOME.lat + 0.05, lng: HOME.lng, accuracy: 12 }

const point = async (extra = {}) =>
  (await call('POST', '/api/admin/points', { cookie, body: { name: 'p-' + randomUUID().slice(0, 6), lat: HOME.lat, lng: HOME.lng, ...extra } })).json.point
const scan = (body, t = token) => call('POST', '/api/scan', { token: t, body: { id: randomUUID(), ...body } })

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  provider = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'ניקיון', contact_name: 'ליאור', password: 'lior-1234' } })).json.provider
  token = (await call('POST', '/api/session', { body: { provider_id: provider.id, password: 'lior-1234' } })).json.token
})
afterAll(async () => db?.teardown())

describe('untrusted input never becomes a server error', () => {
  it('null / blank / non-numeric GPS is "no fix", not a phone standing at (0,0)', async () => {
    for (const gps of [
      { lat: null, lng: null, accuracy: 10 }, { lat: '', lng: '', accuracy: '' }, { lat: [], lng: [], accuracy: [] },
      {}, [], 'here', { lat: true, lng: false, accuracy: 5 },
    ]) {
      const p = await point()
      const r = await scan({ code: p.qr_token, gps })
      expect(r.status).toBe(200)
      expect(r.json.scan.outcome, JSON.stringify(gps)).toBe('accepted')
      expect(r.json.scan.flags).toContain('location_unverified')
      expect(r.json.scan.distance_m).toBeNull()
    }
  })

  it('an absurd accuracy is clamped instead of overflowing the integer column', async () => {
    const p = await point()
    const r = await scan({ code: p.qr_token, gps: { ...HOME, accuracy: 1e10 } })
    expect(r.status).toBe(200)
    expect(r.json.scan.gps_accuracy_m).toBe(1_000_000)
    expect(r.json.scan.flags).toContain('location_unverified') // too vague to trust
  })

  it('an impossible client_time is ignored and flagged (online and offline)', { timeout: 90_000 }, async () => {
    for (const client_time of [-8.64e15, '0000-01-01', 'yesterday']) {
      const p = await point()
      const online = await scan({ code: p.qr_token, client_time })
      expect(online.status, String(client_time)).toBe(200)
      expect(online.json.scan.flags).toContain('clock_skew')
      const p2 = await point()
      const sync = await call('POST', '/api/scans/sync', { token, body: { scans: [{ id: randomUUID(), code: p2.qr_token, client_time }] } })
      expect(sync.status).toBe(200)
      expect(sync.json.results[0].ok).toBe(true)
      expect(sync.json.results[0].scan.flags).toEqual(expect.arrayContaining(['offline_sync', 'clock_skew']))
    }
  })

  it('a point with no coordinates says "unverified" instead of silently passing', async () => {
    const p = await point({ lat: null, lng: null })
    const r = await scan({ code: p.qr_token, gps: { ...HOME, accuracy: 5 } })
    expect(r.json.scan.outcome).toBe('accepted')
    expect(r.json.scan.flags).toEqual(['location_unverified'])
  })

  it('one bad item in a sync batch does not stop the good ones behind it', async () => {
    const [a, b] = [await point(), await point()]
    const r = await call('POST', '/api/scans/sync', {
      token,
      body: { scans: [
        { id: 'not-a-uuid', code: a.qr_token, client_time: '2026-09-01T10:00:00Z' },
        { id: randomUUID(), code: b.qr_token, client_time: '2026-09-01T11:00:00Z' },
      ] },
    })
    expect(r.status).toBe(200)
    expect(r.json.results.map((x) => x.ok)).toEqual([false, true])
  })

  it('a client-supplied non-object body or list is just empty input', async () => {
    expect((await call('POST', '/api/session', { body: [1, 2] })).status).toBe(400)
    expect((await call('POST', '/api/scan', { token, body: 'text' })).status).toBe(400)
  })
})

describe('retries and races on the same scan id', () => {
  it('parallel identical requests give identical answers and exactly one row, even for a rejected scan', async () => {
    const p = await point()
    const id = randomUUID()
    const res = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/scan', { token, body: { id, code: p.qr_token, gps: far } })))
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(new Set(res.map((r) => r.json.scan.id)).size).toBe(1)
    expect(res[0].json.scan.outcome).toBe('rejected_far')
    expect((await db.pool.query('select count(*)::int n from scans where id = $1', [id])).rows[0].n).toBe(1)
  })

  it('another provider racing for the same id gets a clean 409, never a 500', async () => {
    const other = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'גינון', contact_name: 'חמודי', password: 'gard-1234' } })).json.provider
    const otherToken = (await call('POST', '/api/session', { body: { provider_id: other.id, password: 'gard-1234' } })).json.token
    const p = await point()
    const id = randomUUID()
    const [a, b] = await Promise.all([
      call('POST', '/api/scan', { token, body: { id, code: p.qr_token, gps: far } }),
      call('POST', '/api/scan', { token: otherToken, body: { id, code: p.qr_token, gps: far } }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })
})

describe('committee input validation', () => {
  it('rejects blank names, blank/odd numbers and wrong types instead of writing NULLs', async () => {
    const p = await point()
    const cases = [
      { name: '' }, { name: '   ' }, { radius_m: '' }, { radius_m: ' ' }, { radius_m: true }, { radius_m: [] },
      { lat: '' }, { lat: ' ' }, { lat: true }, { lat: [] }, { lng: 999 }, { gps_mode: 'sometimes' }, { is_active: 'yes' },
    ]
    for (const body of cases) {
      const r = await call('PATCH', `/api/admin/points/${p.id}`, { cookie, body })
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    const still = (await call('GET', '/api/admin/points', { cookie })).json.points.find((x) => x.id === p.id)
    expect([still.lat, still.radius_m]).toEqual([HOME.lat, 50]) // nothing was silently cleared
    expect((await call('PATCH', `/api/admin/providers/${provider.id}`, { cookie, body: { company: '' } })).status).toBe(400)
    expect((await call('PATCH', `/api/admin/providers/${provider.id}`, { cookie, body: { is_demo: 'x' } })).status).toBe(400)
  })

  it("a 'required' point must have somewhere to check against", async () => {
    const created = await call('POST', '/api/admin/points', { cookie, body: { name: 'x', gps_mode: 'required' } })
    expect(created.status).toBe(400)
    expect(created.json.error.code).toBe('coordinates_required')
    const p = await point({ gps_mode: 'required' })
    const clear = await call('PATCH', `/api/admin/points/${p.id}`, { cookie, body: { lat: null } })
    expect(clear.json.error.code).toBe('coordinates_required')
    // clearing coordinates is fine once the point no longer requires GPS
    expect((await call('PATCH', `/api/admin/points/${p.id}`, { cookie, body: { gps_mode: 'none', lat: null, lng: null } })).status).toBe(200)
  })

  it('voiding is once, restoring is explicit; unknown scans are 404', async () => {
    const p = await point()
    const s = (await scan({ code: p.qr_token, gps: { ...HOME, accuracy: 5 } })).json.scan
    expect((await call('POST', `/api/admin/scans/${s.id}/unvoid`, { cookie, body: {} })).json.error.code).toBe('not_voided')
    expect((await call('POST', `/api/admin/scans/${s.id}/void`, { cookie, body: { reason: 'first' } })).status).toBe(200)
    const again = await call('POST', `/api/admin/scans/${s.id}/void`, { cookie, body: { reason: 'second' } })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('already_voided')
    const stored = await db.pool.query('select void_reason from scans where id = $1', [s.id])
    expect(stored.rows[0].void_reason).toBe('first') // history is not overwritten
    expect((await call('POST', `/api/admin/scans/${randomUUID()}/void`, { cookie, body: {} })).status).toBe(404)
  })

  it('history cannot be truncated either', async () => {
    await expect(db.pool.query('truncate scans')).rejects.toThrow(/append-only/)
  })
})

describe('CSV exports', () => {
  it("the committee's export contains every matching row, not just one page", async () => {
    const p = await point({ name: 'export-point' })
    await db.pool.query(
      `insert into scans (id, point_id, provider_id, point_name, provider_name, checked_in_at, local_date, source, outcome, flags)
       select gen_random_uuid(), $1, $2, 'export-point', 'x', now() - g * interval '1 hour',
              (now() - g * interval '1 hour')::date, 'online', 'accepted', '{}'
         from generate_series(1, 230) g`,
      [p.id, provider.id],
    )
    const page = await call('GET', `/api/admin/scans?point_id=${p.id}`, { cookie })
    expect(page.json.scans).toHaveLength(100) // the screen pages
    expect(page.json.next_cursor).toBeTruthy()
    const csv = await call('GET', `/api/admin/scans?point_id=${p.id}&format=csv`, { cookie })
    expect(csv.text.charCodeAt(0)).toBe(0xfeff) // Excel-friendly for the committee
    expect(csv.text.trim().split('\r\n')).toHaveLength(231) // header + 230
    expect(csv.headers['x-truncated']).toBeUndefined()
  })

  it('cells a spreadsheet would run as formulas are defused', async () => {
    const names = ['=HYPERLINK("http://evil.example","click")', '+1+1', '@SUM(A1)', '-2+3', 'plain']
    for (const name of names) {
      const p = await point({ name })
      await scan({ code: p.qr_token, gps: { ...HOME, accuracy: 5 } })
    }
    const csv = (await call('GET', '/api/admin/scans?format=csv&limit=500', { cookie })).text
    for (const name of names.slice(0, 4)) expect(csv).toContain(`'${name.replace(/"/g, '""')}`)
    expect(csv).toContain(',plain,')
    expect(csv).not.toMatch(/,=HYPERLINK/)
  })
})

describe('pagination with identical timestamps', () => {
  it('walks 25 rows that share one instant without gaps or repeats', async () => {
    const p = await point({ name: 'same-instant' })
    await db.pool.query(
      `insert into scans (id, point_id, provider_id, point_name, provider_name, checked_in_at, local_date, source, outcome, flags)
       select gen_random_uuid(), $1, $2, 'same-instant', 'x', '2026-03-03T10:00:00.123Z', '2026-03-03', 'online', 'accepted', '{}'
         from generate_series(1, 25)`,
      [p.id, provider.id],
    )
    const key = (await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'k' } })).json.key
    for (const order of ['asc', 'desc']) {
      const seen = []
      let cursor = ''
      for (let i = 0; i < 20; i++) {
        const r = (await call('GET', `/api/agent/v1/scans?point_id=${p.id}&limit=7&order=${order}${cursor}`, { token: key })).json
        seen.push(...r.scans.map((s) => s.id))
        if (!r.next_cursor) break
        cursor = `&cursor=${r.next_cursor}`
      }
      expect(seen, order).toHaveLength(25)
      expect(new Set(seen).size, order).toBe(25)
    }
  })
})

describe('demo account', () => {
  it('signs in with a password like anyone else, but its scans stay out of the data', async () => {
    const demo = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'דמו', contact_name: 'לקוח דמה', password: 'demo-1234', is_demo: true } })).json.provider
    expect(demo.is_demo).toBe(true)
    const demoToken = (await call('POST', '/api/session', { body: { provider_id: demo.id, password: 'demo-1234' } })).json.token
    const p = await point({ name: 'demo-target' })
    const s = await scan({ code: p.qr_token, gps: { ...HOME, accuracy: 5 } }, demoToken)
    expect(s.json.scan.outcome).toBe('accepted')
    expect(s.json.scan.flags).toContain('demo')

    const key = (await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'demo-check' } })).json.key
    const hidden = (await call('GET', `/api/agent/v1/scans?point_id=${p.id}`, { token: key })).json
    expect(hidden.count).toBe(0)
    const shown = (await call('GET', `/api/agent/v1/scans?point_id=${p.id}&include_demo=true`, { token: key })).json
    expect(shown.count).toBe(1)
    expect((await call('GET', `/api/admin/scans?point_id=${p.id}`, { cookie })).json.scans).toHaveLength(0)
    const view = await db.pool.query('select count(*)::int n from v_attendance where point_id = $1', [p.id])
    expect(view.rows[0].n).toBe(0)
    const providers = (await call('GET', '/api/agent/v1/providers', { token: key })).json.providers
    expect(providers.find((x) => x.id === demo.id).is_demo).toBe(true)
  })

  it('may scan every point, including ones assigned to somebody else (a tester must reach all QR codes)', async () => {
    const demo = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'דמו2', contact_name: 'בודק', password: 'demo-5678', is_demo: true } })).json.provider
    const demoToken = (await call('POST', '/api/session', { body: { provider_id: demo.id, password: 'demo-5678' } })).json.token
    const restricted = await point({ name: 'only-lior', provider_ids: [provider.id] })

    const asDemo = await scan({ code: restricted.qr_token, gps: { ...HOME, accuracy: 5 } }, demoToken)
    expect(asDemo.status).toBe(200)
    expect(asDemo.json.scan).toMatchObject({ outcome: 'accepted' })
    expect(asDemo.json.scan.flags).toContain('demo')

    // a regular provider who is NOT assigned is still refused
    const other = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'אחר', contact_name: 'אחר', password: 'other-1234' } })).json.provider
    const otherToken = (await call('POST', '/api/session', { body: { provider_id: other.id, password: 'other-1234' } })).json.token
    const refused = await scan({ code: restricted.qr_token, gps: { ...HOME, accuracy: 5 } }, otherToken)
    expect(refused.status).toBe(403)
    expect(refused.json.error.code).toBe('not_assigned')
  })
})
