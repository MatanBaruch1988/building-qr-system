import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { SAMPLE_POINT, SAMPLE_PROVIDER_NAMES } from '../scripts/sample-data.mjs'

let db, cookie
const ids = {} // created ids shared across tests
let lobbyCode, basementCode, gymCode, inactiveCode

// ~111 m per 0.001° of latitude
const HOME = SAMPLE_POINT
const near = { ...HOME, accuracy: 12 }
const far = { lat: HOME.lat + 0.05, lng: HOME.lng, accuracy: 12 }

const login = (provider_id, password, ip) => call('POST', '/api/session', { body: { provider_id, password }, ip })
const scan = (token, body) => call('POST', '/api/scan', { token, body: { id: randomUUID(), ...body } })
// Same provider + same point within 10 minutes counts as one visit, so tests that need a
// "first scan" use a brand-new point to stay independent of each other.
const freshPoint = async (extra = {}) =>
  (await call('POST', '/api/admin/points', {
    cookie,
    body: { name: 'p-' + randomUUID().slice(0, 6), lat: HOME.lat, lng: HOME.lng, ...extra },
  })).json.point

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()

  const mk = async (body) => (await call('POST', '/api/admin/points', { cookie, body })).json.point
  const ploni = (await call('POST', '/api/admin/providers', {
    cookie, body: { company: 'ניקיון', contact_name: SAMPLE_PROVIDER_NAMES.cleaner, service_type: 'cleaning', password: 'ploni-1234' },
  })).json.provider
  const gardener = (await call('POST', '/api/admin/providers', {
    cookie, body: { company: 'גינון', contact_name: SAMPLE_PROVIDER_NAMES.gardener, service_type: 'gardening', password: 'gard-1234' },
  })).json.provider
  ids.ploni = ploni.id
  ids.gardener = gardener.id
  ids.gardenerToken = (await login(gardener.id, 'gard-1234')).json.token

  const lobby = await mk({ name: 'לובי', lat: HOME.lat, lng: HOME.lng, gps_mode: 'optional' })
  const basement = await mk({ name: 'מינוס 1', lat: HOME.lat, lng: HOME.lng, gps_mode: 'none' })
  const gym = await mk({ name: 'גימבורי', lat: HOME.lat, lng: HOME.lng, gps_mode: 'required', provider_ids: [ploni.id] })
  const inactive = await mk({ name: 'ישן', lat: HOME.lat, lng: HOME.lng })
  await call('PATCH', `/api/admin/points/${inactive.id}`, { cookie, body: { is_active: false } })
  Object.assign(ids, { lobby: lobby.id, basement: basement.id, gym: gym.id, inactive: inactive.id })
  lobbyCode = lobby.qr_token
  basementCode = basement.qr_token
  gymCode = gym.qr_token
  inactiveCode = inactive.qr_token
})

afterAll(async () => db?.teardown())

describe('security basics', () => {
  it('refuses writes that are not JSON', async () => {
    const r = await call('POST', '/api/admin/google', { body: {}, headers: { 'content-type': 'text/plain' } })
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBe('json_required')
  })
  it('refuses cross-origin writes, but accepts the browser origin seen through a proxy', async () => {
    const evil = await call('POST', '/api/admin/google', { body: {}, headers: { origin: 'https://evil.example' } })
    expect(evil.status).toBe(403)
    // dev proxy rewrites Host to :3001 but forwards the real host
    const proxied = await call('POST', '/api/session', {
      body: { provider_id: randomUUID(), password: 'whatever1' },
      headers: { host: 'localhost:3001', 'x-forwarded-host': 'localhost:3000', origin: 'http://localhost:3000' },
    })
    expect(proxied.status).toBe(401) // got past the origin check and failed on credentials
  })
  it('admin endpoints need a session', async () => {
    expect((await call('GET', '/api/admin/points')).status).toBe(401)
    expect((await call('GET', '/api/admin/scans')).status).toBe(401)
  })
  it('unknown endpoints and wrong methods', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404)
    expect((await call('GET', '/api/session/extra/x')).status).toBe(404)
    expect((await call('PUT', '/api/scan', { body: {} })).status).toBe(405)
  })
  it('malformed JSON, bad URL encoding and bad cookies are client errors, never 500', async () => {
    const badJson = await call('POST', '/api/session', { body: {}, badJsonBody: true })
    expect(badJson.status).toBe(400)
    expect(badJson.json.error.code).toBe('invalid_json')
    const badUrl = await call('GET', '/api/admin/points/%E0%A4%A', { cookie })
    expect(badUrl.status).toBe(400)
    const badCookie = await call('GET', '/api/admin/points', { cookie: 'qr_admin=%' })
    expect(badCookie.status).toBe(401)
  })
})

describe('committee sign-in with Google', () => {
  it('exposes only what the login screen needs', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com'
    const r = await call('GET', '/api/admin/config')
    delete process.env.GOOGLE_CLIENT_ID
    expect(r.json).toEqual({ google_client_id: 'client-123.apps.googleusercontent.com', dev_login: false })
  })
  it('lets a listed e-mail in (case-insensitive) with an HttpOnly session cookie', async () => {
    const r = await call('POST', '/api/admin/google', { body: { credential: 'ADMIN@test.local' } })
    expect(r.status).toBe(200)
    expect(r.json.admin).toMatchObject({ email: 'admin@test.local' })
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/)
    const me = await call('GET', '/api/admin/me', { cookie: String(r.headers['set-cookie']).split(';')[0] })
    expect(me.json.admin.email).toBe('admin@test.local')
  })
  it('refuses a valid Google account that is not on the committee list', async () => {
    const r = await call('POST', '/api/admin/google', { body: { credential: 'stranger@gmail.com' } })
    expect(r.status).toBe(403)
    expect(r.json.error.code).toBe('not_an_admin')
    expect(r.headers['set-cookie']).toBeUndefined()
  })
  it('refuses a missing credential and a credential Google would not vouch for', async () => {
    expect((await call('POST', '/api/admin/google', { body: {} })).json.error.code).toBe('missing_field')
    const { setGoogleVerifier } = await import('../server/google.js')
    const { unauthorized } = await import('../server/http.js')
    setGoogleVerifier(async () => { throw unauthorized('google_invalid') })
    const r = await call('POST', '/api/admin/google', { body: { credential: 'forged' } })
    setGoogleVerifier(async (c) => ({ email: String(c).toLowerCase(), name: 'Test Admin', sub: 'sub-' + String(c).toLowerCase() }))
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('google_invalid')
  })
  it('an e-mail is bound to the first Google account that used it', async () => {
    const { setGoogleVerifier } = await import('../server/google.js')
    await call('POST', '/api/admin/admins', { cookie, body: { email: 'second@test.local', name: 'Second' } })
    setGoogleVerifier(async () => ({ email: 'second@test.local', name: 'S', sub: 'sub-A' }))
    expect((await call('POST', '/api/admin/google', { body: { credential: 'x' } })).status).toBe(200)
    setGoogleVerifier(async () => ({ email: 'second@test.local', name: 'S', sub: 'sub-B' }))
    const r = await call('POST', '/api/admin/google', { body: { credential: 'x' } })
    setGoogleVerifier(async (c) => ({ email: String(c).toLowerCase(), name: 'Test Admin', sub: 'sub-' + String(c).toLowerCase() }))
    expect(r.status).toBe(403)
    expect(r.json.error.code).toBe('google_account_mismatch')
  })
  it('the committee manages who is on the list; removed members lose access at once', async () => {
    await call('POST', '/api/admin/admins', { cookie, body: { email: 'third@test.local', name: 'Third' } })
    const list = (await call('GET', '/api/admin/admins', { cookie })).json.admins
    const third = list.find((a) => a.email === 'third@test.local')
    const thirdCookie = await adminCookie('third@test.local')
    expect((await call('GET', '/api/admin/points', { cookie: thirdCookie })).status).toBe(200)

    await call('PATCH', `/api/admin/admins/${third.id}`, { cookie, body: { is_active: false } })
    expect((await call('GET', '/api/admin/points', { cookie: thirdCookie })).status).toBe(401) // session revoked
    expect((await call('POST', '/api/admin/google', { body: { credential: 'third@test.local' } })).json.error.code).toBe('not_an_admin')

    const self = list.find((a) => a.email === 'admin@test.local')
    const own = await call('PATCH', `/api/admin/admins/${self.id}`, { cookie, body: { is_active: false } })
    expect(own.status).toBe(409)
    expect(own.json.error.code).toBe('cannot_deactivate_self')
    expect((await call('POST', '/api/admin/admins', { cookie, body: { email: 'not-an-email' } })).status).toBe(400)
  })
  it('logging out ends the session', async () => {
    const c = await adminCookie()
    await call('POST', '/api/admin/logout', { cookie: c, body: {} })
    expect((await call('GET', '/api/admin/me', { cookie: c })).status).toBe(401)
  })
  it('the dev-only shortcut does not exist unless explicitly enabled off Vercel', async () => {
    expect((await call('POST', '/api/admin/dev-login', { body: { email: 'admin@test.local' } })).status).toBe(404)
    process.env.DEV_ADMIN_LOGIN = '1'
    process.env.VERCEL = '1'
    const onVercel = await call('POST', '/api/admin/dev-login', { body: { email: 'admin@test.local' } })
    delete process.env.VERCEL
    const local = await call('POST', '/api/admin/dev-login', { body: { email: 'admin@test.local' } })
    const stranger = await call('POST', '/api/admin/dev-login', { body: { email: 'nobody@test.local' } })
    delete process.env.DEV_ADMIN_LOGIN
    expect(onVercel.status).toBe(404)
    expect(local.status).toBe(200)
    expect(stranger.status).toBe(403)
  })
})

describe('public endpoints', () => {
  it('lists only providers who can sign in, without secrets', async () => {
    const r = await call('GET', '/api/public/providers')
    expect(r.status).toBe(200)
    expect(r.json.providers.map((p) => p.contact_name).sort()).toEqual([SAMPLE_PROVIDER_NAMES.gardener, SAMPLE_PROVIDER_NAMES.cleaner])
    expect(JSON.stringify(r.json)).not.toMatch(/hash|password/)
  })
  it('resolves a QR to a point name without coordinates or token', async () => {
    const r = await call('GET', `/api/public/points/resolve?code=${encodeURIComponent('https://x.web.app/scan?code=' + lobbyCode)}`)
    expect(r.status).toBe(200)
    expect(r.json.point).toEqual({ name: 'לובי', description: '', is_active: true, gps_mode: 'optional' })
    expect((await call('GET', '/api/public/points/resolve?code=BQR-doesnotexist123')).json.error.code).toBe('unknown_code')
    expect((await call('GET', '/api/public/points/resolve?code=junk')).json.error.code).toBe('invalid_code')
  })
})

describe('provider sign-in', () => {
  it('wrong password is 401 and throttled after repeated failures', async () => {
    const ip = '203.0.113.7'
    for (let i = 0; i < 8; i++) {
      expect((await login(ids.gardener, 'wrong-pass-' + i, ip)).status).toBe(401)
    }
    const locked = await login(ids.gardener, 'gard-1234', ip) // even the right password is refused while locked
    expect(locked.status).toBe(429)
    expect(locked.json.error.code).toBe('too_many_attempts')
    // ...but a stranger's typos do not lock the real person out on their own phone/address
    expect((await login(ids.gardener, 'gard-1234', '203.0.113.8')).status).toBe(200)
    await db.pool.query('delete from auth_attempts') // unlock for the rest of the suite
  })
  it('the lockout cannot be dodged by changing the id\'s letter case', async () => {
    const ip = '203.0.113.20'
    const shout = ids.gardener.toUpperCase()
    for (let i = 0; i < 8; i++) {
      await login(i % 2 ? shout : ids.gardener, 'wrong-pass-' + i, ip)
    }
    expect((await login(shout, 'gard-1234', ip)).status).toBe(429)
    expect((await login(ids.gardener, 'gard-1234', ip)).status).toBe(429)
    await db.pool.query('delete from auth_attempts')
  })
  it('parallel guesses cannot all slip past the counter', async () => {
    const ip = '203.0.113.30'
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login(ids.gardener, 'guess-pass-' + i, ip)))
    const verified = results.filter((r) => r.status === 401).length
    const refused = results.filter((r) => r.status === 429).length
    expect(verified).toBeLessThanOrEqual(8) // never more than the limit gets a password check
    expect(verified + refused).toBe(12) // and everything else is a clean refusal, not a crash
    expect(refused).toBeGreaterThanOrEqual(4)
    await db.pool.query('delete from auth_attempts')
  })
  it('one address cannot burn unlimited password checks across many accounts', async () => {
    const ip = '203.0.113.40'
    const statuses = []
    for (let batch = 0; batch < 7; batch++) {
      const res = await Promise.all(Array.from({ length: 10 }, () => login(randomUUID(), 'spray-pass-1', ip)))
      statuses.push(...res.map((r) => r.status))
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10) // 70 attempts, cap is 60
    await db.pool.query('delete from auth_attempts')
  })
  it('old attempt rows are pruned so the table cannot grow forever', async () => {
    await db.pool.query(`insert into auth_attempts (scope, key, at) values ('provider', 'stale', now() - interval '3 days')`)
    await login(randomUUID(), 'whatever-1', '203.0.113.50')
    const n = await db.pool.query(`select count(*)::int n from auth_attempts where key = 'stale'`)
    expect(n.rows[0].n).toBe(0)
    await db.pool.query('delete from auth_attempts')
  })
  it('signs in, returns a device token, and the session endpoint recognises it', async () => {
    const r = await login(ids.ploni, 'ploni-1234')
    expect(r.status).toBe(200)
    expect(r.json.token).toMatch(/^qrp_/)
    expect(r.json.provider).toMatchObject({ contact_name: SAMPLE_PROVIDER_NAMES.cleaner })
    const me = await call('GET', '/api/session', { token: r.json.token })
    expect(me.json.provider.company).toBe('ניקיון')
    ids.ploniToken = r.json.token
  })
  it('signing out revokes only that device', async () => {
    const a = (await login(ids.ploni, 'ploni-1234')).json.token
    const b = (await login(ids.ploni, 'ploni-1234')).json.token
    await call('DELETE', '/api/session', { token: a })
    expect((await call('GET', '/api/session', { token: a })).status).toBe(401)
    expect((await call('GET', '/api/session', { token: b })).status).toBe(200)
  })
  it('requests without a token are 401', async () => {
    expect((await call('POST', '/api/scan', { body: { id: randomUUID(), code: lobbyCode } })).json.error.code).toBe('invalid_session')
  })
})

describe('recording scans', () => {
  it('accepts a normal scan and stores signals, not raw coordinates', async () => {
    const r = await scan(ids.ploniToken, { code: lobbyCode, gps: near, client_time: new Date().toISOString() })
    expect(r.status).toBe(200)
    expect(r.json.duplicate).toBe(false)
    expect(r.json.scan).toMatchObject({
      outcome: 'accepted', point_name: 'לובי', source: 'online', flags: [], service_type: 'cleaning',
    })
    expect(r.json.scan.distance_m).toBeLessThan(30)
    expect(r.json.scan.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(r.json.scan.checked_in_local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(JSON.stringify(r.json)).not.toMatch(/lat|lng|latitude/)
  })
  it('a retry with the same id returns the stored scan (idempotent)', async () => {
    const id = randomUUID()
    const first = await call('POST', '/api/scan', { token: ids.ploniToken, body: { id, code: basementCode } })
    const again = await call('POST', '/api/scan', { token: ids.ploniToken, body: { id, code: basementCode } })
    expect(again.json.scan.id).toBe(first.json.scan.id)
    const n = await db.pool.query('select count(*)::int n from scans where id = $1', [id])
    expect(n.rows[0].n).toBe(1)
  })
  it('the same provider at the same point within 10 minutes is one visit', async () => {
    const first = await scan(ids.ploniToken, { code: basementCode })
    const second = await scan(ids.ploniToken, { code: basementCode })
    expect(second.json.duplicate).toBe(true)
    expect(second.json.scan.id).toBe(first.json.scan.id)
  })
  it('a scan id cannot be replayed by another provider', async () => {
    const p = await freshPoint()
    const id = randomUUID()
    const first = await call('POST', '/api/scan', { token: ids.ploniToken, body: { id, code: p.qr_token } })
    expect(first.status).toBe(200)
    const r = await call('POST', '/api/scan', { token: ids.gardenerToken, body: { id, code: p.qr_token } })
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('scan_id_conflict')
  })
  it('rejects a clearly-far fix but keeps the attempt on record', async () => {
    const p = await freshPoint()
    const r = await scan(ids.gardenerToken, { code: p.qr_token, gps: far })
    expect(r.status).toBe(200)
    expect(r.json.scan.outcome).toBe('rejected_far')
    expect(r.json.scan.distance_m).toBeGreaterThan(5000)
    // a rejected attempt does not block the real visit that follows
    const retry = await scan(ids.gardenerToken, { code: p.qr_token, gps: near })
    expect(retry.json.scan.outcome).toBe('accepted')
    expect(retry.json.duplicate).toBe(false)
  })
  it('accepts with a location_unverified flag when there is no GPS (optional point)', async () => {
    const p = await freshPoint()
    const r = await scan(ids.gardenerToken, { code: p.qr_token })
    expect(r.json.scan.outcome).toBe('accepted')
    expect(r.json.scan.flags).toEqual(['location_unverified'])
  })
  it("'none' points are never judged by GPS", async () => {
    const p = await freshPoint({ gps_mode: 'none' })
    const r = await scan(ids.gardenerToken, { code: p.qr_token, gps: far })
    expect(r.json.scan.outcome).toBe('accepted')
    expect(r.json.scan.flags).toEqual([])
  })
  it("'required' points refuse a scan with no fix, and enforce assignment", async () => {
    const r = await scan(ids.ploniToken, { code: gymCode })
    expect(r.json.scan.outcome).toBe('rejected_no_location')
    const ok = await scan(ids.ploniToken, { code: gymCode, gps: near })
    expect(ok.json.scan.outcome).toBe('accepted')
    const denied = await scan(ids.gardenerToken, { code: gymCode, gps: near })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('not_assigned')
  })
  it('refuses inactive points and unknown or malformed codes', async () => {
    expect((await scan(ids.ploniToken, { code: inactiveCode })).json.error.code).toBe('point_inactive')
    expect((await scan(ids.ploniToken, { code: 'BQR-unknown0000000' })).json.error.code).toBe('unknown_code')
    expect((await scan(ids.ploniToken, { code: 'nonsense' })).json.error.code).toBe('invalid_code')
    expect((await call('POST', '/api/scan', { token: ids.ploniToken, body: { id: 'x', code: lobbyCode } })).json.error.code).toBe('invalid_scan_id')
  })
  it('accepts a legacy printed URL as the code', async () => {
    const p = await freshPoint()
    const r = await scan(ids.gardenerToken, { code: `https://building-qr-system.web.app/scan?code=${p.qr_token}` })
    expect(r.status).toBe(200)
    expect(r.json.scan.point_name).toBe(p.name)
  })
})

describe('offline sync', () => {
  it('keeps plausible phone times, flags bad clocks, reports per-item errors, is idempotent', async () => {
    const token = ids.gardenerToken
    const [pGood, pBad] = [await freshPoint(), await freshPoint()]
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const good = { id: randomUUID(), code: pGood.qr_token, client_time: twoHoursAgo }
    const badClock = { id: randomUUID(), code: pBad.qr_token, client_time: '2001-01-01T00:00:00Z' }
    const unknown = { id: randomUUID(), code: 'BQR-unknown0000000', client_time: twoHoursAgo }

    const r = await call('POST', '/api/scans/sync', { token, body: { scans: [good, badClock, unknown] } })
    expect(r.status).toBe(200)
    const byId = Object.fromEntries(r.json.results.map((x) => [x.id, x]))
    expect(byId[good.id].ok).toBe(true)
    expect(byId[good.id].scan.source).toBe('offline_sync')
    expect(byId[good.id].scan.checked_in_at).toBe(twoHoursAgo)
    expect(byId[good.id].scan.flags).toContain('offline_sync')
    expect(byId[badClock.id].scan.flags).toEqual(expect.arrayContaining(['offline_sync', 'clock_skew']))
    expect(byId[unknown.id]).toMatchObject({ ok: false, error: { code: 'unknown_code' } })

    const again = await call('POST', '/api/scans/sync', { token, body: { scans: [good] } })
    expect(again.json.results[0].ok).toBe(true)
    const n = await db.pool.query('select count(*)::int n from scans where id = $1', [good.id])
    expect(n.rows[0].n).toBe(1)
  })
  it('validates the batch', async () => {
    expect((await call('POST', '/api/scans/sync', { token: ids.ploniToken, body: { scans: 'x' } })).status).toBe(400)
    const many = Array.from({ length: 51 }, () => ({ id: randomUUID(), code: lobbyCode }))
    expect((await call('POST', '/api/scans/sync', { token: ids.ploniToken, body: { scans: many } })).json.error.code).toBe('batch_too_large')
  })
})

describe('committee controls', () => {
  it('deactivating a provider signs them out everywhere and hides them from the login list', async () => {
    const p = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'זמני', contact_name: 'בדיקה', password: 'temp-1234' } })).json.provider
    const t = (await login(p.id, 'temp-1234')).json.token
    expect((await call('GET', '/api/session', { token: t })).status).toBe(200)
    await call('PATCH', `/api/admin/providers/${p.id}`, { cookie, body: { is_active: false } })
    expect((await call('GET', '/api/session', { token: t })).status).toBe(401)
    expect((await login(p.id, 'temp-1234')).status).toBe(401)
    const list = (await call('GET', '/api/public/providers')).json.providers
    expect(list.find((x) => x.id === p.id)).toBeUndefined()
    // ...but the record (and any history) is still there
    const all = (await call('GET', '/api/admin/providers', { cookie })).json.providers
    expect(all.find((x) => x.id === p.id).is_active).toBe(false)
  })
  it('resetting a password signs out old devices; short passwords are refused', async () => {
    const t = (await login(ids.ploni, 'ploni-1234')).json.token
    const short = await call('PATCH', `/api/admin/providers/${ids.ploni}`, { cookie, body: { password: '123' } })
    expect(short.json.error.code).toBe('password_too_short')
    await call('PATCH', `/api/admin/providers/${ids.ploni}`, { cookie, body: { password: 'ploni-5678' } })
    expect((await call('GET', '/api/session', { token: t })).status).toBe(401)
    const fresh = await login(ids.ploni, 'ploni-5678')
    expect(fresh.status).toBe(200)
    ids.ploniToken = fresh.json.token
  })
  it('regenerating a QR kills the old code', async () => {
    const p = (await call('POST', '/api/admin/points', { cookie, body: { name: 'זמני' } })).json.point
    const before = p.qr_token
    const after = (await call('POST', `/api/admin/points/${p.id}/regenerate-qr`, { cookie })).json.point.qr_token
    expect(after).not.toBe(before)
    expect((await scan(ids.ploniToken, { code: before })).json.error.code).toBe('unknown_code')
    expect((await scan(ids.ploniToken, { code: after })).status).toBe(200)
  })
  it('point QR urls use APP_BASE_URL when set', async () => {
    process.env.APP_BASE_URL = 'https://qr.example.com/'
    const list = (await call('GET', '/api/admin/points', { cookie })).json.points
    delete process.env.APP_BASE_URL
    expect(list[0].qr_url).toMatch(/^https:\/\/qr\.example\.com\/scan\?code=BQR-/)
  })
  it('scans are append-only, but can be voided and restored', async () => {
    await expect(db.pool.query('delete from scans')).rejects.toThrow(/append-only/)
    await expect(db.pool.query("update scans set point_name = 'x'")).rejects.toThrow(/append-only/)

    const s = (await scan((await login(ids.gardener, 'gard-1234')).json.token, { code: lobbyCode, gps: near })).json.scan
    const v = await call('POST', `/api/admin/scans/${s.id}/void`, { cookie, body: { reason: 'שגיאה' } })
    expect(v.json.scan).toMatchObject({ voided: true, void_reason: 'שגיאה' })
    const visible = (await call('GET', '/api/admin/scans?limit=500', { cookie })).json.scans
    expect(visible.find((x) => x.id === s.id)).toBeUndefined()
    const withVoided = (await call('GET', '/api/admin/scans?limit=500&include_voided=true', { cookie })).json.scans
    expect(withVoided.find((x) => x.id === s.id).voided).toBe(true)
    await call('POST', `/api/admin/scans/${s.id}/unvoid`, { cookie, body: {} })
    expect(((await call('GET', '/api/admin/scans?limit=500', { cookie })).json.scans).find((x) => x.id === s.id)).toBeDefined()
  })
  it('writes an audit trail', async () => {
    const n = await db.pool.query("select count(*)::int n from audit_log where action like 'provider.%' or action like 'point.%'")
    expect(n.rows[0].n).toBeGreaterThan(5)
  })
})

describe('providers have no language of their own', () => {
  // The language is each person's own choice, kept on their phone (like light/dark). The committee does not set one.
  it('is in no answer of the API: sign-in list, session, committee list, agent list', async () => {
    expect((await call('GET', '/api/public/providers')).json.providers[0]).not.toHaveProperty('lang')
    // a provider of its own: the others were locked out by the sign-in throttling tests above
    const fresh = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'חדש', contact_name: 'ללא שפה', password: 'fresh-1234' } })).json.provider
    const session = await login(fresh.id, 'fresh-1234')
    expect(session.status).toBe(200)
    expect(session.json.provider).not.toHaveProperty('lang')
    expect((await call('GET', '/api/session', { token: session.json.token })).json.provider).not.toHaveProperty('lang')
    expect((await call('GET', '/api/admin/providers', { cookie })).json.providers[0]).not.toHaveProperty('lang')
    const key = (await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'no-lang' } })).json.key
    expect((await call('GET', '/api/agent/v1/providers', { token: key })).json.providers[0]).not.toHaveProperty('lang')
  })

  it('a language sent anyway is ignored, not an error (an old committee screen that is still open)', async () => {
    const made = await call('POST', '/api/admin/providers', { cookie, body: { company: 'ישן', contact_name: 'מסך פתוח', lang: 'xx', password: 'old-screen-1' } })
    expect(made.status).toBe(201)
    expect(made.json.provider).not.toHaveProperty('lang')
    const edited = await call('PATCH', `/api/admin/providers/${made.json.provider.id}`, { cookie, body: { lang: 'ru', company: 'ישן 2' } })
    expect(edited.status).toBe(200)
    expect(edited.json.provider.company).toBe('ישן 2')
  })
})

describe('agent API', () => {
  let key, keyId
  it('rejects missing, malformed and unknown keys', async () => {
    expect((await call('GET', '/api/agent/v1/scans')).json.error.code).toBe('api_key_required')
    expect((await call('GET', '/api/agent/v1/scans', { token: 'not-a-key' })).json.error.code).toBe('api_key_required')
    expect((await call('GET', '/api/agent/v1/scans', { token: 'qrk_nope' })).json.error.code).toBe('api_key_invalid')
    // a provider token is not an agent key
    expect((await call('GET', '/api/agent/v1/scans', { token: ids.ploniToken })).status).toBe(401)
  })
  it('committee creates a key (shown once) and it works', async () => {
    const r = await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'agent' } })
    expect(r.status).toBe(201)
    key = r.json.key
    keyId = r.json.api_key.id
    expect(key).toMatch(/^qrk_/)
    const list = (await call('GET', '/api/admin/api-keys', { cookie })).json.api_keys
    expect(JSON.stringify(list)).not.toContain(key)
    expect((await call('GET', '/api/agent/v1/health', { token: key })).json.ok).toBe(true)
  })
  it('returns raw records with filters, and never secrets', async () => {
    const all = (await call('GET', '/api/agent/v1/scans?outcome=all&limit=500', { token: key })).json
    expect(all.count).toBeGreaterThan(5)
    const accepted = (await call('GET', '/api/agent/v1/scans?limit=500', { token: key })).json.scans
    expect(accepted.every((s) => s.outcome === 'accepted')).toBe(true)
    const rejected = (await call('GET', '/api/agent/v1/scans?outcome=rejected', { token: key })).json.scans
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected.every((s) => s.outcome !== 'accepted')).toBe(true)
    const byPoint = (await call('GET', `/api/agent/v1/scans?point_id=${ids.gym}`, { token: key })).json.scans
    expect(byPoint.every((s) => s.point_id === ids.gym)).toBe(true)
    const byFlag = (await call('GET', '/api/agent/v1/scans?flag=location_unverified', { token: key })).json.scans
    expect(byFlag.length).toBeGreaterThan(0)
    const today = new Date().toISOString().slice(0, 10)
    expect((await call('GET', `/api/agent/v1/scans?from=${today}&to=${today}&limit=500`, { token: key })).json.count).toBeGreaterThan(0)
    expect((await call('GET', '/api/agent/v1/scans?from=2001-01-01&to=2001-01-02', { token: key })).json.count).toBe(0)

    const everything = JSON.stringify([
      all,
      (await call('GET', '/api/agent/v1/points', { token: key })).json,
      (await call('GET', '/api/agent/v1/providers', { token: key })).json,
    ])
    expect(everything).not.toMatch(/qr_token|BQR-|password|hash|qrp_|qra_/)
  })
  it('paginates with a cursor, in both directions, without gaps or repeats', async () => {
    const collect = async (order) => {
      const seen = []
      let cursor = ''
      for (let i = 0; i < 50; i++) {
        const r = (await call('GET', `/api/agent/v1/scans?outcome=all&limit=3&order=${order}${cursor}`, { token: key })).json
        seen.push(...r.scans.map((s) => s.id))
        if (!r.next_cursor) break
        cursor = `&cursor=${r.next_cursor}`
      }
      return seen
    }
    const total = (await call('GET', '/api/agent/v1/scans?outcome=all&limit=500', { token: key })).json.count
    const desc = await collect('desc')
    const asc = await collect('asc')
    expect(desc.length).toBe(total)
    expect(new Set(desc).size).toBe(total)
    expect(asc).toEqual([...desc].reverse())
  })
  it('exports CSV for machines: no BOM, header row first, next-page cursor in a header', async () => {
    const r = await call('GET', '/api/agent/v1/scans?format=csv&limit=2', { token: key })
    expect(r.headers['content-type']).toMatch(/text\/csv/)
    expect(r.text.charCodeAt(0)).not.toBe(0xfeff)
    expect(r.text.startsWith('id,checked_in_at')).toBe(true)
    expect(r.headers['x-next-cursor']).toBeTruthy()
  })
  it('validates filters strictly: real dates only, offsets on times, no forged cursors', async () => {
    for (const q of [
      'from=2026-02-30', 'to=2026-13-01', 'from=2026-06-01T10:00:00', 'from=1999-01-01T00:00:00Z', 'from=0000-01-01',
      `cursor=${Buffer.from(JSON.stringify({ t: 12345, id: randomUUID() })).toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify({ t: '2026', id: 'nope' })).toString('base64url')}`,
      'limit=1.5', 'limit=-3',
    ]) {
      const r = await call('GET', `/api/agent/v1/scans?${q}`, { token: key })
      expect(r.status, q).toBe(400)
    }
    const ok = await call('GET', '/api/agent/v1/scans?from=2026-01-01T00:00:00%2B02:00&to=2100-01-01T00:00:00Z', { token: key })
    expect(ok.status).toBe(200)
  })
  it('validates filters', async () => {
    for (const q of ['from=yesterday', 'point_id=abc', 'outcome=maybe', 'limit=0', 'limit=abc', 'cursor=zzz', 'order=sideways']) {
      const r = await call('GET', `/api/agent/v1/scans?${q}`, { token: key })
      expect(r.status, q).toBe(400)
    }
  })
  it('serves a self-describing schema', async () => {
    const r = await call('GET', '/api/agent/v1/schema', { token: key })
    expect(r.json.flags.location_unverified).toBeTruthy()
    expect(r.json.timezone).toBe('Asia/Jerusalem')
    expect(r.json.flags.legacy_import).toBeTruthy()
    expect(r.json.rules.history).toMatch(/provider can be deleted/)
    expect(r.json.rules.history).not.toMatch(/not deleted/)
  })
  it('a revoked key stops working', async () => {
    await call('POST', `/api/admin/api-keys/${keyId}/revoke`, { cookie })
    expect((await call('GET', '/api/agent/v1/scans', { token: key })).json.error.code).toBe('api_key_invalid')
  })
})
