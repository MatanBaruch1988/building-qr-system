// The health of a provider's phones on the committee's Providers list (ADR 0007, decision 4, "Phone health"; migration 009,
// server/deviceStatus.js for what a phone reports, `PROVIDER_SELECT` in server/routes/admin.js for what the list adds).
//
// What this file proves, for GET /api/admin/providers (and the single provider that POST and PATCH answer with):
//   - three new fields per provider, over its ACTIVE phones only: `waiting` (the sum of what the phones say waits, 0 when none),
//     `oldest_waiting_at` (the oldest time among the phones that have something waiting, else null) and `outdated_devices` (how many
//     phones reported a build that is not the server's own, 0 when the server does not know its build);
//   - a phone that was signed out is not counted by any of them;
//   - a phone that never reported counts for nothing, and an old app version never reports;
//   - the fields that the list had before are there, with the same values and in the same order, the new ones after them (so an old
//     reader of the list is not affected), and no phone's label or token hash comes along.
// The data is fake. The numbers are written straight into the rows, so that the test says exactly what the list adds up.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { sha256 } from '../server/crypto.js'

const HOME = { lat: 32.0853, lng: 34.7818 }
const HOUR = 3600 * 1000
const SHA = 'abcdef1234567890abcdef1234567890abcdef12' // a commit: the server's build is its first 7 characters
const BUILD = 'abcdef1'
const OLD_BUILD = '1234567'
// The fields of a provider in the list, in the order the list always wrote them, and then the three new ones.
const OLD_KEYS = ['id', 'company', 'contact_name', 'service_type', 'is_active', 'is_demo', 'created_at', 'has_password', 'active_devices', 'last_scan_at', 'scan_count']
const NEW_KEYS = ['waiting', 'oldest_waiting_at', 'outdated_devices']

let db, cookie
const agoIso = (ms) => new Date(Date.now() - ms).toISOString()

const makeProvider = async (company, extra = {}) => {
  const password = 'fake-pass-' + randomUUID().slice(0, 6)
  const res = await call('POST', '/api/admin/providers', { cookie, body: { company, contact_name: 'Fake Person', password, ...extra } })
  expect(res.status).toBe(201)
  return { ...res.json.provider, password }
}
/** Signs the provider in on a new phone, with the label that the app would send, and returns its token and the id of its row. */
const signIn = async (provider, label = 'Fake Browser Label') => {
  const res = await call('POST', '/api/session', { body: { provider_id: provider.id, password: provider.password, device_label: label } })
  expect(res.status).toBe(200)
  const { rows } = await db.pool.query('select id from provider_devices where token_hash = $1', [sha256(res.json.token)])
  return { token: res.json.token, deviceId: rows[0].id }
}
/** Writes what a phone would have reported straight into its row (a missing field stays what a phone that never reported has). */
const setStatus = (deviceId, { build = null, waiting = null, oldest = null } = {}) =>
  db.pool.query(
    'update provider_devices set app_build = $2, waiting_count = $3, oldest_waiting_at = $4, status_at = now() where id = $1',
    [deviceId, build, waiting, oldest],
  )
const listed = async () => {
  const res = await call('GET', '/api/admin/providers', { cookie })
  expect(res.status).toBe(200)
  return res.json.providers
}
const listedProvider = async (id) => (await listed()).find((p) => p.id === id)
const health = (p) => ({ waiting: p.waiting, oldest_waiting_at: p.oldest_waiting_at, outdated_devices: p.outdated_devices })

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
})
afterAll(async () => db?.teardown())
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/admin/providers: the health of the phones of each provider', () => {
  it('is nothing for a provider with no phone: 0 waiting, no time, 0 outdated', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const p = await makeProvider('Fake Nobody Signed In')
    const row = await listedProvider(p.id)
    expect(row.active_devices).toBe(0)
    expect(health(row)).toEqual({ waiting: 0, oldest_waiting_at: null, outdated_devices: 0 })
  })

  it('is nothing for phones that never reported (an old app version never does): they are connected, and count for nothing', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const p = await makeProvider('Fake Silent Phones')
    await signIn(p)
    await signIn(p)
    const row = await listedProvider(p.id)
    expect(row.active_devices).toBe(2)
    expect(health(row)).toEqual({ waiting: 0, oldest_waiting_at: null, outdated_devices: 0 })
  })

  it('adds up what the active phones say waits, and takes the oldest time among those that have something waiting', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const p = await makeProvider('Fake Two Phones')
    const one = await signIn(p)
    const two = await signIn(p)
    const three = await signIn(p)
    const oldest = agoIso(30 * HOUR)
    await setStatus(one.deviceId, { build: BUILD, waiting: 3, oldest: agoIso(2 * HOUR) })
    await setStatus(two.deviceId, { build: BUILD, waiting: 4, oldest })
    await setStatus(three.deviceId, { build: BUILD, waiting: 0 }) // it reported, and nothing waits on it
    const row = await listedProvider(p.id)
    expect(row.waiting).toBe(7)
    expect(row.oldest_waiting_at).toBe(oldest)
    expect(row.outdated_devices).toBe(0)
    expect(row.active_devices).toBe(3)
  })

  it('answers whole numbers and ISO times: the sum is a number, not the text that a database gives for a sum', async () => {
    const p = await makeProvider('Fake Types')
    const one = await signIn(p)
    await setStatus(one.deviceId, { build: BUILD, waiting: 12, oldest: agoIso(5 * HOUR) })
    const row = await listedProvider(p.id)
    expect(typeof row.waiting).toBe('number')
    expect(typeof row.outdated_devices).toBe('number')
    expect(row.oldest_waiting_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('takes the oldest time only from phones that have something waiting: a phone that reports 0 keeps no old time in the answer', async () => {
    const p = await makeProvider('Fake Leftover Time')
    const waiting = await signIn(p)
    const empty = await signIn(p)
    const recent = agoIso(HOUR)
    await setStatus(waiting.deviceId, { build: BUILD, waiting: 2, oldest: recent })
    // A time left in a row that says 0 waiting (the phone sends none when its queue is empty, but the column could hold an old one).
    await setStatus(empty.deviceId, { build: BUILD, waiting: 0, oldest: agoIso(40 * HOUR) })
    const row = await listedProvider(p.id)
    expect(row.waiting).toBe(2)
    expect(row.oldest_waiting_at).toBe(recent)
  })

  it('has no time when the phones that wait sent none that could be believed (the sum is still there)', async () => {
    const p = await makeProvider('Fake No Time')
    const one = await signIn(p)
    await setStatus(one.deviceId, { build: BUILD, waiting: 5, oldest: null })
    expect(health(await listedProvider(p.id))).toEqual({ waiting: 5, oldest_waiting_at: null, outdated_devices: 0 })
  })

  it('does not count a phone that was signed out, in any of the three fields', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const p = await makeProvider('Fake Signed Out')
    const active = await signIn(p)
    const gone = await signIn(p)
    const recent = agoIso(3 * HOUR)
    await setStatus(active.deviceId, { build: BUILD, waiting: 2, oldest: recent })
    await setStatus(gone.deviceId, { build: OLD_BUILD, waiting: 9, oldest: agoIso(50 * HOUR) })
    expect(health(await listedProvider(p.id))).toEqual({ waiting: 11, oldest_waiting_at: expect.any(String), outdated_devices: 1 }) // both count while signed in
    expect((await call('DELETE', '/api/session', { token: gone.token })).status).toBe(200)
    const row = await listedProvider(p.id)
    expect(health(row)).toEqual({ waiting: 2, oldest_waiting_at: recent, outdated_devices: 0 })
    expect(row.active_devices).toBe(1)
  })

  it('is 0 for a provider whose phones were all signed out by the committee', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const p = await makeProvider('Fake All Signed Out')
    const one = await signIn(p)
    await setStatus(one.deviceId, { build: OLD_BUILD, waiting: 6, oldest: agoIso(2 * HOUR) })
    expect((await call('POST', `/api/admin/providers/${p.id}/revoke-devices`, { cookie, body: {} })).status).toBe(200)
    const row = await listedProvider(p.id)
    expect(row.active_devices).toBe(0)
    expect(health(row)).toEqual({ waiting: 0, oldest_waiting_at: null, outdated_devices: 0 })
  })

  it('keeps the phones of one provider apart from those of another', async () => {
    const a = await makeProvider('Fake Apart A')
    const b = await makeProvider('Fake Apart B')
    const timeA = agoIso(4 * HOUR)
    const timeB = agoIso(8 * HOUR)
    await setStatus((await signIn(a)).deviceId, { build: BUILD, waiting: 1, oldest: timeA })
    await setStatus((await signIn(b)).deviceId, { build: BUILD, waiting: 10, oldest: timeB })
    await setStatus((await signIn(b)).deviceId, { build: BUILD, waiting: 20, oldest: agoIso(6 * HOUR) })
    const rows = await listed()
    expect(health(rows.find((p) => p.id === a.id))).toMatchObject({ waiting: 1, oldest_waiting_at: timeA })
    expect(health(rows.find((p) => p.id === b.id))).toMatchObject({ waiting: 30, oldest_waiting_at: timeB })
  })

  it('shows what a phone really reported through POST /api/my/device-status', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const p = await makeProvider('Fake Reporting')
    const phone = await signIn(p)
    const oldest = agoIso(26 * HOUR)
    const res = await call('POST', '/api/my/device-status', { token: phone.token, body: { build: OLD_BUILD, waiting: 4, oldest_waiting_at: oldest } })
    expect(res.status).toBe(200)
    expect(health(await listedProvider(p.id))).toEqual({ waiting: 4, oldest_waiting_at: oldest, outdated_devices: 1 })
  })
})

describe('outdated_devices: the phone reported a build, the server knows its own, and they differ', () => {
  let p, same, other, silent
  beforeAll(async () => {
    p = await makeProvider('Fake Builds')
    same = await signIn(p)
    other = await signIn(p)
    silent = await signIn(p)
    await setStatus(same.deviceId, { build: BUILD })
    await setStatus(other.deviceId, { build: OLD_BUILD })
    expect(silent.deviceId).toBeTruthy() // never reported: build null
  })
  const outdated = async () => (await listedProvider(p.id)).outdated_devices

  it('counts the phones of another build, and not those of the same build or those that never reported', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    expect(await outdated()).toBe(1)
  })

  it('counts every phone of another build, and a development build is another build', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    await setStatus(same.deviceId, { build: 'dev' })
    expect(await outdated()).toBe(2)
    await setStatus(same.deviceId, { build: BUILD })
    expect(await outdated()).toBe(1)
  })

  it('follows the build of the server, which is read for each request', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '7654321fedcba0987654321fedcba0987654321f')
    expect(await outdated()).toBe(2) // now both reported builds differ from the server's
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', OLD_BUILD + 'fedcba0987654321fedcba0987654321')
    expect(await outdated()).toBe(1) // and now the phone of OLD_BUILD is the current one
  })

  it('is 0 for every provider when the server does not know its build (a local server)', async () => {
    for (const sha of [undefined, '']) {
      vi.stubEnv('VERCEL_GIT_COMMIT_SHA', sha)
      expect(await outdated(), String(sha)).toBe(0)
      expect((await listed()).every((row) => row.outdated_devices === 0), String(sha)).toBe(true)
    }
  })

  it('is the same on the single provider that POST and PATCH answer with', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const patched = await call('PATCH', `/api/admin/providers/${p.id}`, { cookie, body: { contact_name: 'Fake Renamed' } })
    expect(patched.status).toBe(200)
    expect(health(patched.json.provider)).toEqual({ waiting: 0, oldest_waiting_at: null, outdated_devices: 1 })
    const created = await call('POST', '/api/admin/providers', { cookie, body: { company: 'Fake Created', password: 'fake-pass-created' } })
    expect(created.status).toBe(201)
    expect(health(created.json.provider)).toEqual({ waiting: 0, oldest_waiting_at: null, outdated_devices: 0 })
  })
})

describe('the fields that the list had before are as they were', () => {
  it('lists them first and in the same order, then the three new fields, and nothing else (no label, no token hash)', async () => {
    const p = await makeProvider('Fake Old Fields', { service_type: 'cleaning' })
    const phone = await signIn(p, 'Fake Browser Label For The Committee')
    await setStatus(phone.deviceId, { build: BUILD, waiting: 1, oldest: agoIso(HOUR) })
    const res = await call('GET', '/api/admin/providers', { cookie })
    expect(res.status).toBe(200)
    expect(Object.keys(res.json)).toEqual(['providers'])
    for (const row of res.json.providers) expect(Object.keys(row)).toEqual([...OLD_KEYS, ...NEW_KEYS])
    for (const secret of ['Fake Browser Label', phone.token, sha256(phone.token)]) expect(res.text, secret).not.toContain(secret)
  })

  it('has the same values as before: the password flag, the phones, the last accepted visit and the scans recorded', async () => {
    const p = await makeProvider('Fake Old Values', { service_type: 'gardening', is_demo: true })
    const noPassword = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'Fake No Password' } })).json.provider
    const point = (await call('POST', '/api/admin/points', { cookie, body: { name: 'Fake point ' + randomUUID().slice(0, 6), ...HOME, gps_mode: 'none' } })).json.point
    const phone = await signIn(p)
    const before = await listedProvider(p.id)
    expect(before).toMatchObject({
      company: 'Fake Old Values', contact_name: 'Fake Person', service_type: 'gardening', is_active: true, is_demo: true,
      has_password: true, active_devices: 1, last_scan_at: null, scan_count: 0,
    })
    expect(before.created_at).toMatch(/Z$/)
    expect(await listedProvider(noPassword.id)).toMatchObject({ has_password: false, active_devices: 0, scan_count: 0 })

    const scan = await call('POST', '/api/scan', { token: phone.token, body: { id: randomUUID(), code: point.qr_token, gps: null } })
    expect(scan.status).toBe(200)
    const after = await listedProvider(p.id)
    expect(after.scan_count).toBe(1)
    expect(after.last_scan_at).toMatch(/Z$/)
    expect(after.active_devices).toBe(1)
  })

  it('keeps the order of the list: the active first, then by company and by name, as the database sorts them', async () => {
    const off = await makeProvider('Fake Order Off')
    expect((await call('PATCH', `/api/admin/providers/${off.id}`, { cookie, body: { is_active: false } })).status).toBe(200)
    const { rows } = await db.pool.query('select id from providers p order by p.is_active desc, p.company, p.contact_name')
    expect((await listed()).map((p) => p.id)).toEqual(rows.map((r) => r.id))
    expect((await listed()).at(-1).id).toBe(off.id) // the one that is switched off comes last
  })

  it('answers the same fields for the one provider that POST and PATCH answer with', async () => {
    const created = await call('POST', '/api/admin/providers', { cookie, body: { company: 'Fake Single', password: 'fake-pass-single' } })
    expect(created.status).toBe(201)
    expect(Object.keys(created.json.provider)).toEqual([...OLD_KEYS, ...NEW_KEYS])
    const patched = await call('PATCH', `/api/admin/providers/${created.json.provider.id}`, { cookie, body: { company: 'Fake Single 2' } })
    expect(patched.status).toBe(200)
    expect(Object.keys(patched.json.provider)).toEqual([...OLD_KEYS, ...NEW_KEYS])
    expect(patched.json.provider).toMatchObject({ company: 'Fake Single 2', waiting: 0, oldest_waiting_at: null, outdated_devices: 0 })
  })
})
