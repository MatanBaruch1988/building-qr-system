// What the committee's analyst, the agent, reads beyond attendance since the owner's decision of 08/10/2026 (AGENTS.md, "Safety":
// the agent may see what the committee app shows, and never a secret; docs/privacy.md lists the parts). Three additions, all new
// fields or a new endpoint, so an agent that was written before them reads what it always read:
//   - GET /api/agent/v1/building: the name and the address of the building (the tests of the endpoint itself are in
//     tests/building.test.js; this file proves what it must not carry);
//   - GET /api/agent/v1/providers: the health of each provider's phones as seven numbers and times over its signed-in phones;
//   - GET /api/agent/v1/scans (JSON and CSV): voided_at, voided_by, received_at and device_id after the fields a scan always had.
// What this file proves:
//   1. the phone numbers of the agent are the numbers of the committee's providers list for the same data (they are the same SQL), the
//      three new ones are what the signed-in phones add up to, a phone that was signed out counts for nothing, and the answer is one
//      aggregate for each provider (no row per phone, no phone id);
//   2. voided_at and voided_by: the member's name as the audit entry of the void keeps it, the latest void wins, nothing for a scan that
//      was restored or never voided, the fallbacks for an entry with no name, and a lookup that costs the page and not the log;
//   3. received_at and device_id are there, in the JSON and in the CSV, and the CSV has the four columns at its end;
//   4. the shape of a scan that the committee and the provider phones get is exactly what it was (scanJson), and so is the committee's CSV;
//   5. no secret (a phone's label, a QR token, a password or its hash, a key or its hash, a token, a Google id, an address) is in the raw
//      text of the new or changed answers.
// The data is fake.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie, mintAgentKey } from './helpers.js'
import { sha256 } from '../server/crypto.js'
import { tx } from '../server/db.js'
import { AGENT_SCAN_CSV_COLUMNS, SCAN_CSV_COLUMNS, COMMITTEE_CSV_COLUMNS, agentScanJson, agentScanQuery, listAgentScans, listScans, scanJson } from '../server/scans.js'
import { AGENT_KEY_MAX_PER_MINUTE } from '../server/config.js'

const HOUR = 3600 * 1000
// The server's build is the first 7 characters of the commit; the phones report builds of their own. None of them looks like hex,
// so a build can never match by chance inside an id or a time in the raw text of an answer.
const SHA = 'srvbld1-and-the-rest-of-a-fake-commit'
const BUILD = 'srvbld1'
const OLD_BUILD = 'oldbld9'
const LABEL = 'Mozilla/5.0 (Fake; Phone-Marker-7731) FakeBrowser/1.0'
const IP = '10.55.66.77'
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const agoIso = (ms) => new Date(Date.now() - ms).toISOString()

const OLD_PROVIDER_KEYS = ['id', 'company', 'contact_name', 'service_type', 'is_active', 'is_demo', 'created_at', 'last_scan_at']
const PHONE_KEYS = ['active_devices', 'waiting', 'oldest_waiting_at', 'outdated_devices', 'last_sync_at', 'not_accepted_total', 'overflow_total']
const SCAN_KEYS = ['id', 'checked_in_at', 'checked_in_local', 'local_date', 'point_id', 'point_name', 'provider_id', 'provider_name', 'service_type', 'source', 'outcome', 'distance_m', 'gps_accuracy_m', 'flags', 'voided', 'void_reason']
const AGENT_ONLY_SCAN_KEYS = ['voided_at', 'voided_by', 'received_at', 'device_id']
const FILTER_ALL = 'outcome=all&include_voided=true&include_demo=true&limit=500'

let db, cookie, secondCookie
let agentKey, keyUses = 0
const world = {} // ids and values of the seed, by name

// One key may make AGENT_KEY_MAX_PER_MINUTE requests in a minute; this file stays under that by working through keys, as
// tests/agent-docs.test.js does.
const KEY_USES = Math.floor((AGENT_KEY_MAX_PER_MINUTE * 2) / 3)
async function currentKey() {
  if (!agentKey || keyUses >= KEY_USES) {
    agentKey = (await mintAgentKey(cookie, 'phones building voids')).key
    keyUses = 0
  }
  keyUses += 1
  return agentKey
}
const agent = async (path, opts = {}) => call('GET', `/api/agent/v1${path}`, { token: await currentKey(), ...opts })
const agentScans = async (qs = FILTER_ALL) => (await agent(`/scans?${qs}`)).json.scans
const agentScan = async (id) => (await agentScans()).find((s) => s.id === id)
const agentProvider = async (id) => (await agent('/providers')).json.providers.find((p) => p.id === id)
const committeeProviders = async () => (await call('GET', '/api/admin/providers', { cookie })).json.providers

const post = async (path, body, asCookie = cookie) => {
  const r = await call('POST', path, { cookie: asCookie, body })
  if (r.status !== 200 && r.status !== 201) throw new Error(`seed ${path}: ${r.status} ${r.text}`)
  return r.json
}
const makeProvider = async (company, password) => (await post('/api/admin/providers', { company, contact_name: 'Fake Person', password })).provider
const makePoint = async (name) => (await post('/api/admin/points', { name, gps_mode: 'none' })).point
/** Signs a provider in on a new phone and returns its token and the id of its row. */
const signIn = async (provider, password, label = 'Fake Browser') => {
  const res = await call('POST', '/api/session', { body: { provider_id: provider.id, password, device_label: label }, ip: IP })
  if (res.status !== 200) throw new Error(`sign-in: ${res.status} ${res.text}`)
  const { rows } = await db.pool.query('select id from provider_devices where token_hash = $1', [sha256(res.json.token)])
  return { token: res.json.token, deviceId: rows[0].id }
}
/** One online scan from a phone: its id. */
const scanOnline = async (phone, point) => {
  const id = randomUUID()
  const res = await call('POST', '/api/scan', { token: phone.token, body: { id, code: point.qr_token }, ip: IP })
  if (res.status !== 200 || res.json.scan.outcome !== 'accepted') throw new Error(`scan: ${res.status} ${res.text}`)
  return id
}
const setStatus = (deviceId, columns) => {
  const names = Object.keys(columns)
  return db.pool.query(`update provider_devices set ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')}, status_at = now() where id = $1`, [deviceId, ...Object.values(columns)])
}
const voidScan = (id, reason = 'fake reason', asCookie = cookie) => post(`/api/admin/scans/${id}/void`, { reason }, asCookie)
const restoreScan = (id, asCookie = cookie) => post(`/api/admin/scans/${id}/unvoid`, {}, asCookie)
const dbScan = async (id) => (await db.pool.query('select * from scans where id = $1', [id])).rows[0]

beforeAll(async () => {
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
  db = await setupDb()
  await seedAdmin(db.pool)
  await db.pool.query("insert into admins (email, name) values ('second@test.local', 'Second Member')")
  cookie = await adminCookie()
  secondCookie = await adminCookie('second@test.local')
  world.firstId = (await db.pool.query("select id from admins where email = 'admin@test.local'")).rows[0].id
  world.secondId = (await db.pool.query("select id from admins where email = 'second@test.local'")).rows[0].id

  // Providers: A has two phones in use and one that was signed out; B has one phone that never reported; C has none; D had one, and the
  // committee signed it out.
  world.pwA = 'pw-fake-secret-A-4821'
  world.a = await makeProvider('Fake Cleaning', world.pwA)
  world.b = await makeProvider('Fake Gardening', 'pw-fake-secret-B-7310')
  world.c = await makeProvider('Fake No Phones', 'pw-fake-secret-C-2093')
  world.d = await makeProvider('Fake Signed Out', 'pw-fake-secret-D-5566')
  world.points = []
  for (let i = 1; i <= 6; i++) world.points.push(await makePoint(`Fake Point ${i}`))
  const [p1, p2, p3, p4, p5] = world.points

  world.a1 = await signIn(world.a, world.pwA, LABEL)
  world.a2 = await signIn(world.a, world.pwA)
  world.a3 = await signIn(world.a, world.pwA)
  world.b1 = await signIn(world.b, 'pw-fake-secret-B-7310')
  world.d1 = await signIn(world.d, 'pw-fake-secret-D-5566')

  // Scans: s1 and s2 stay voided by two different members; s3 is never voided; s4 comes from a phone with no signal; s5 is voided and
  // restored; s6 is voided, restored and voided again by the other member.
  world.s1 = await scanOnline(world.a1, p1)
  world.s2 = await scanOnline(world.b1, p1)
  world.s3 = await scanOnline(world.a2, p2)
  world.s5 = await scanOnline(world.a1, p4)
  world.s6 = await scanOnline(world.a2, p5)
  world.s4 = randomUUID()
  const sync = await call('POST', '/api/scans/sync', { token: world.a2.token, body: { scans: [{ id: world.s4, code: p3.qr_token, client_time: agoIso(3 * HOUR) }] }, ip: IP })
  if (sync.status !== 200 || !sync.json.results[0].ok) throw new Error('the offline scan was refused')
  await voidScan(world.s1, 'duplicate visit')
  await voidScan(world.s2, 'wrong point', secondCookie)
  await voidScan(world.s5)
  await restoreScan(world.s5)
  await voidScan(world.s6, 'first void')
  await restoreScan(world.s6)
  await voidScan(world.s6, 'second void', secondCookie)

  // What the phones of A reported (written straight into the rows, so the test says exactly what the numbers add up to), and a phone of
  // A that was signed out, whose big numbers must count for nothing.
  world.t1 = agoIso(2 * HOUR)
  world.t2 = agoIso(30 * HOUR)
  world.sync1 = agoIso(5 * HOUR)
  world.sync2 = agoIso(HOUR)
  await setStatus(world.a1.deviceId, { app_build: BUILD, waiting_count: 3, oldest_waiting_at: world.t1, not_accepted_total: 2, overflow_total: 1, last_sync_at: world.sync1 })
  await setStatus(world.a2.deviceId, { app_build: OLD_BUILD, waiting_count: 4, oldest_waiting_at: world.t2, not_accepted_total: 5, overflow_total: 0, last_sync_at: world.sync2 })
  await setStatus(world.a3.deviceId, { app_build: OLD_BUILD, waiting_count: 99, oldest_waiting_at: agoIso(100 * HOUR), not_accepted_total: 50, overflow_total: 40, last_sync_at: agoIso(60_000) })
  expect((await call('DELETE', '/api/session', { token: world.a3.token })).status).toBe(200)
  await setStatus(world.d1.deviceId, { app_build: OLD_BUILD, waiting_count: 6, oldest_waiting_at: agoIso(HOUR), not_accepted_total: 3, overflow_total: 3, last_sync_at: agoIso(HOUR) })
  expect((await call('POST', `/api/admin/providers/${world.d.id}/revoke-devices`, { cookie, body: {} })).status).toBe(200)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await db?.teardown()
})

// ======================================================================================================================
// 1. The health of the phones
// ======================================================================================================================

describe('GET /api/agent/v1/providers: the health of the phones of each provider', () => {
  it('keeps the fields a provider always had, in their order, and adds the seven after them', async () => {
    const providers = (await agent('/providers')).json.providers
    expect(providers.length).toBe(4)
    for (const p of providers) expect(Object.keys(p)).toEqual([...OLD_PROVIDER_KEYS, ...PHONE_KEYS])
  })

  it('adds up the signed-in phones of a provider: the sum of what waits, the oldest time, the latest upload, the two totals, and the phones that run another build', async () => {
    const a = await agentProvider(world.a.id)
    expect({ active: a.active_devices, waiting: a.waiting, outdated: a.outdated_devices, notAccepted: a.not_accepted_total, overflow: a.overflow_total }).toEqual({
      active: 2, waiting: 7, outdated: 1, notAccepted: 7, overflow: 1,
    })
    expect(a.oldest_waiting_at).toBe(world.t2) // the oldest of the phones that have something waiting
    expect(a.last_sync_at).toBe(world.sync2) // the latest upload of any of them
  })

  it('counts the phone that was signed out for nothing in any of the seven (its numbers are large on purpose)', async () => {
    const a = await agentProvider(world.a.id)
    expect(a.waiting).toBeLessThan(99)
    expect(a.not_accepted_total).toBeLessThan(50)
    expect(a.overflow_total).toBeLessThan(40)
    expect(new Date(a.last_sync_at).getTime()).toBeLessThan(Date.now() - 30 * 60_000)
  })

  it('is nothing for a provider with no phone, and for one whose phones the committee signed out: zeros and nulls', async () => {
    for (const id of [world.c.id, world.d.id]) {
      const p = await agentProvider(id)
      expect({ ...p }).toMatchObject({
        active_devices: 0, waiting: 0, oldest_waiting_at: null, outdated_devices: 0, last_sync_at: null, not_accepted_total: 0, overflow_total: 0,
      })
    }
  })

  it('is the phone that never reported for a provider whose phone is signed in: connected, and nothing else', async () => {
    const b = await agentProvider(world.b.id)
    expect(b).toMatchObject({
      active_devices: 1, waiting: 0, oldest_waiting_at: null, outdated_devices: 0, last_sync_at: null, not_accepted_total: 0, overflow_total: 0,
    })
  })

  it('writes whole numbers and ISO times (a number, not the text that a database gives for a sum)', async () => {
    const a = await agentProvider(world.a.id)
    for (const key of ['active_devices', 'waiting', 'outdated_devices', 'not_accepted_total', 'overflow_total']) expect(Number.isInteger(a[key]), key).toBe(true)
    for (const key of ['oldest_waiting_at', 'last_sync_at', 'created_at', 'last_scan_at']) expect(a[key], key).toMatch(ISO)
  })

  it('shows the same numbers as the committee for the same data: the four that the committee has are equal for every provider', async () => {
    const mine = (await agent('/providers')).json.providers
    const theirs = await committeeProviders()
    expect(theirs.length).toBe(mine.length)
    for (const p of mine) {
      const t = theirs.find((x) => x.id === p.id)
      expect({ active_devices: p.active_devices, waiting: p.waiting, oldest_waiting_at: p.oldest_waiting_at, outdated_devices: p.outdated_devices }, p.company).toEqual({
        active_devices: t.active_devices, waiting: t.waiting, oldest_waiting_at: t.oldest_waiting_at, outdated_devices: t.outdated_devices,
      })
      expect(p.last_scan_at, p.company).toBe(t.last_scan_at)
    }
  })

  it('has the other three where the committee screen reads them: the phones of the committee app (GET /admin/providers/:id/devices) add up to the same', async () => {
    const devices = (await call('GET', `/api/admin/providers/${world.a.id}/devices`, { cookie })).json.devices
    expect(devices.length).toBe(2)
    const a = await agentProvider(world.a.id)
    expect(a.not_accepted_total).toBe(devices.reduce((sum, d) => sum + d.not_accepted_total, 0))
    expect(a.overflow_total).toBe(devices.reduce((sum, d) => sum + d.overflow_total, 0))
    expect(a.last_sync_at).toBe(devices.map((d) => d.last_sync_at).sort().at(-1))
  })

  it('is one aggregate for each provider: no row per phone, no id of a phone, no label, no build of one phone', async () => {
    const r = await agent('/providers')
    const phones = (await db.pool.query('select id, label, app_build, token_hash from provider_devices')).rows
    expect(phones.length).toBeGreaterThanOrEqual(5)
    for (const phone of phones) {
      expect(r.text, 'the id of a phone').not.toContain(phone.id)
      expect(r.text, 'the token hash of a phone').not.toContain(phone.token_hash)
      if (phone.label) expect(r.text, 'the label of a phone').not.toContain(phone.label)
      if (phone.app_build) expect(r.text, 'the build of a phone').not.toContain(phone.app_build)
    }
    expect(Object.keys(r.json)).toEqual(['providers'])
    expect(r.json.providers.some((p) => Array.isArray(p.devices) || Array.isArray(p.phones))).toBe(false)
  })

  it('does not count a phone that was signed out by the provider itself afterwards, and counts the one that signs in', async () => {
    const before = await agentProvider(world.a.id)
    const extra = await signIn(world.a, world.pwA)
    await setStatus(extra.deviceId, { waiting_count: 10, not_accepted_total: 4, overflow_total: 2, last_sync_at: agoIso(60_000) })
    const during = await agentProvider(world.a.id)
    expect(during).toMatchObject({ active_devices: before.active_devices + 1, waiting: before.waiting + 10, not_accepted_total: before.not_accepted_total + 4, overflow_total: before.overflow_total + 2 })
    expect(new Date(during.last_sync_at).getTime()).toBeGreaterThan(new Date(before.last_sync_at).getTime())
    expect((await call('DELETE', '/api/session', { token: extra.token })).status).toBe(200)
    expect(await agentProvider(world.a.id)).toEqual(before)
  })

  it('stops the two totals at the largest int instead of failing the whole list when many phones add up past it', async () => {
    const phones = (await db.pool.query('select id, not_accepted_total, overflow_total from provider_devices where provider_id = $1 and revoked_at is null', [world.a.id])).rows
    expect(phones.length).toBe(2) // two signed-in phones: 2 x 2,000,000,000 is past 2,147,483,647
    try {
      for (const phone of phones) await setStatus(phone.id, { not_accepted_total: 2_000_000_000, overflow_total: 2_000_000_000 })
      const a = await agentProvider(world.a.id)
      expect([a.not_accepted_total, a.overflow_total]).toEqual([2147483647, 2147483647])
      const committee = await call('GET', '/api/admin/providers', { cookie })
      expect(committee.status).toBe(200) // the committee's list uses the same fragment and still answers
    } finally {
      for (const phone of phones) await setStatus(phone.id, { not_accepted_total: phone.not_accepted_total, overflow_total: phone.overflow_total })
    }
  })
})

// ======================================================================================================================
// 2. Who voided a scan, and when
// ======================================================================================================================

describe('GET /api/agent/v1/scans: voided_at and voided_by', () => {
  it('keeps the sixteen fields of a scan in their order and adds the four after them', async () => {
    const scans = await agentScans()
    expect(scans.length).toBeGreaterThanOrEqual(6)
    for (const s of scans) expect(Object.keys(s)).toEqual([...SCAN_KEYS, ...AGENT_ONLY_SCAN_KEYS])
  })

  it('names the member who voided a scan, and when (the time that the scan row holds)', async () => {
    const one = await agentScan(world.s1)
    expect(one).toMatchObject({ voided: true, void_reason: 'duplicate visit', voided_by: 'Test Admin' })
    expect(one.voided_at).toBe(new Date((await dbScan(world.s1)).voided_at).toISOString())
    expect(one.voided_at).toMatch(ISO)
    expect(await agentScan(world.s2)).toMatchObject({ voided: true, void_reason: 'wrong point', voided_by: 'Second Member' })
  })

  it('is null in both for a scan that was never voided', async () => {
    for (const id of [world.s3, world.s4]) expect(await agentScan(id)).toMatchObject({ voided: false, void_reason: null, voided_at: null, voided_by: null })
  })

  it('is null in both for a scan that was voided and then restored, though the log still has the entry of the void', async () => {
    const entries = await db.pool.query("select count(*)::int n from audit_log where entity = 'scan' and entity_id = $1 and action = 'scan.void'", [world.s5])
    expect(entries.rows[0].n).toBe(1)
    expect(await agentScan(world.s5)).toMatchObject({ voided: false, voided_at: null, voided_by: null })
  })

  it('names the member of the LATEST void when a scan was voided, restored and voided again by someone else', async () => {
    const entries = await db.pool.query("select count(*)::int n from audit_log where entity = 'scan' and entity_id = $1 and action = 'scan.void'", [world.s6])
    expect(entries.rows[0].n).toBe(2)
    expect(await agentScan(world.s6)).toMatchObject({ voided: true, void_reason: 'second void', voided_by: 'Second Member' })
  })

  it('keeps the name as it was when the member did it: a rename and the removal of the member change nothing', async () => {
    const temp = (await post('/api/admin/admins', { email: 'temp@test.local', name: 'Temp Member' })).admin
    const tempCookie = await adminCookie('temp@test.local')
    const id = await scanOnline(world.a1, world.points[5])
    await voidScan(id, 'by a member who leaves', tempCookie)
    expect((await agentScan(id)).voided_by).toBe('Temp Member')
    await db.pool.query("update admins set name = 'Renamed Later' where id = $1", [temp.id])
    expect((await agentScan(id)).voided_by).toBe('Temp Member')
    expect((await call('DELETE', `/api/admin/admins/${temp.id}`, { cookie })).status).toBe(200)
    expect((await agentScan(id)).voided_by).toBe('Temp Member')
  })

  it('gives the e-mail when the member had no name (as the audit entry does)', async () => {
    const nameless = (await post('/api/admin/admins', { email: 'nameless@test.local', name: 'Soon Nameless' })).admin
    const namelessCookie = await adminCookie('nameless@test.local')
    await db.pool.query("update admins set name = '' where id = $1", [nameless.id])
    const id = await scanOnline(world.b1, world.points[5])
    await voidScan(id, 'by a member with no name', namelessCookie)
    expect((await agentScan(id)).voided_by).toBe('nameless@test.local')
  })

  it('falls back to the current name of the member for an old entry with no name on it, and to null when no entry names who', async () => {
    const third = (await db.pool.query("insert into admins (email, name) values ('third@test.local', 'Third Member') returning id")).rows[0].id
    const insertVoided = async (id) =>
      db.pool.query(
        `insert into scans (id, point_id, provider_id, point_name, provider_name, checked_in_at, local_date, source, outcome, flags, voided_at, void_reason)
         values ($1, $2, $3, 'Fake Point 1', 'Fake Cleaning', '2026-01-05T08:00:00Z', '2026-01-05', 'online', 'accepted', '{legacy_import}', now(), 'voided long ago')`,
        [id, world.points[0].id, world.a.id],
      )
    const withEntry = randomUUID()
    const withoutEntry = randomUUID()
    await insertVoided(withEntry)
    await insertVoided(withoutEntry)
    await db.pool.query(
      "insert into audit_log (actor_type, actor_id, actor_name, action, entity, entity_id, detail) values ('admin', $1, null, 'scan.void', 'scan', $2, '{\"reason\":\"voided long ago\"}')",
      [third, withEntry],
    )
    expect(await agentScan(withEntry)).toMatchObject({ voided: true, voided_by: 'Third Member', device_id: null })
    expect(await agentScan(withoutEntry)).toMatchObject({ voided: true, voided_by: null, device_id: null })
    expect((await agentScan(withoutEntry)).voided_at).toMatch(ISO)
  })

  it('pages like the committee does: the same scans in the same order in both directions, with voided_by on every voided one', async () => {
    for (const order of ['desc', 'asc']) {
      const seen = []
      let cursor = ''
      for (let page = 0; page < 40; page++) {
        const r = (await agent(`/scans?${FILTER_ALL.replace('limit=500', 'limit=2')}&order=${order}${cursor}`)).json
        seen.push(...r.scans)
        if (!r.next_cursor) break
        cursor = `&cursor=${r.next_cursor}`
      }
      const committee = (await call('GET', `/api/admin/scans?${FILTER_ALL}&order=${order}`, { cookie })).json.scans
      expect(seen.map((s) => s.id), order).toEqual(committee.map((s) => s.id))
      for (const s of seen) {
        expect(s.voided, s.id).toBe(s.voided_at !== null) // voided and voided_at say the same
        if (s.voided_by !== null) expect(s.voided, s.id).toBe(true) // nobody voided a scan that is not voided
      }
      expect(seen.filter((s) => s.voided_by !== null).length, order).toBeGreaterThanOrEqual(4)
    }
  })

  it('filters like the committee does, and leaves the voided out unless asked (the default of both)', async () => {
    const hidden = (await agentScans('outcome=all&include_demo=true&limit=500')).map((s) => s.id)
    expect(hidden).not.toContain(world.s1)
    expect(hidden).toContain(world.s3)
    const committee = (await call('GET', '/api/admin/scans?outcome=all&include_demo=true&limit=500', { cookie })).json.scans.map((s) => s.id)
    expect(hidden).toEqual(committee)
  })

  it('reads the same filters from the query as the committee list, because both are one set of conditions (scanPageParts)', async () => {
    const reads = (fn) => async () => {
      const read = new Set()
      const q = new Proxy(
        { from: '2026-01-01', to: '2100-01-01', point_id: randomUUID(), provider_id: randomUUID(), service_type: 'x', flag: 'demo', outcome: 'all', include_voided: '1', include_demo: '1', order: 'asc', limit: '3' },
        { get: (target, prop) => (typeof prop === 'string' ? (read.add(prop), target[prop]) : target[prop]) },
      )
      await fn(q)
      return [...read].sort()
    }
    expect(await reads(listAgentScans)()).toEqual(await reads(listScans)())
  })

  it('looks the name up for the page only, through audit_log_entity_idx, and only for the voided scans of that page', async () => {
    // The log is filled with other entries and analysed, and the sequential scan is switched off for the one transaction of the
    // explain: what is asked is whether the index CAN serve the lookup, and how many times it is asked (once for each voided scan of the
    // page), not what the planner would prefer on a table of a few rows.
    await db.pool.query(
      `insert into audit_log (at, actor_type, actor_id, actor_name, action, entity, entity_id, detail)
       select timestamptz '2026-01-01 00:00:00+00' + (g * interval '17 minutes'), 'admin', $1, 'Bulk Member',
              case g % 3 when 0 then 'point.update' when 1 then 'scan.void' else 'provider.update' end,
              case g % 3 when 0 then 'point' when 1 then 'scan' else 'provider' end, 'bulk-' || (g % 300), '{"n":1}'
         from generate_series(1, 3000) g`,
      [world.firstId],
    )
    await db.pool.query('analyze audit_log')
    const { sql, params } = agentScanQuery({ outcome: 'all', include_voided: 'true', include_demo: 'true', order: 'asc', limit: '4' })
    const plan = await tx(async (c) => {
      await c.query('set local enable_seqscan = off')
      const { rows } = await c.query(`explain (analyze, costs off, timing off, summary off) ${sql}`, params)
      return rows.map((r) => r['QUERY PLAN']).join('\n')
    })
    expect(plan, plan).toContain('audit_log_entity_idx')
    // The statement reads one row more than the page (to know that there is a next page), and looks the name up for the voided ones
    // among those rows and for no other: the same first five scans, as a page of five.
    const read = (await listAgentScans({ outcome: 'all', include_voided: 'true', include_demo: 'true', order: 'asc', limit: '5' })).scans
    const voidedRead = read.filter((s) => s.voided).length
    expect(voidedRead).toBeGreaterThan(0)
    expect(voidedRead).toBeLessThan(read.length) // a row that is not voided is among them: it must look nothing up
    const loops = Number(/audit_log_entity_idx[^\n]*loops=(\d+)/.exec(plan)?.[1])
    expect(loops, plan).toBe(voidedRead)
  })
})

// ======================================================================================================================
// 3. When the server received a scan, and which phone sent it
// ======================================================================================================================

describe('GET /api/agent/v1/scans: received_at and device_id', () => {
  it('has the time that the server received the scan, in ISO, for every scan', async () => {
    for (const s of await agentScans()) expect(s.received_at, s.id).toMatch(ISO)
    const row = await dbScan(world.s3)
    expect((await agentScan(world.s3)).received_at).toBe(new Date(row.received_at).toISOString())
  })

  it('is the time of the upload for a scan that came without signal, while checked_in_at is the time on the phone', async () => {
    const s = await agentScan(world.s4)
    expect(s.source).toBe('offline_sync')
    expect(s.checked_in_at).toBe(new Date((await dbScan(world.s4)).client_time).toISOString())
    expect(new Date(s.received_at).getTime() - new Date(s.checked_in_at).getTime()).toBeGreaterThan(2 * HOUR)
  })

  it('is the id of the phone sign-in that sent the scan, the same for two scans of one phone and different for two phones', async () => {
    const byId = Object.fromEntries((await agentScans()).map((s) => [s.id, s]))
    expect(byId[world.s1].device_id).toBe(world.a1.deviceId)
    expect(byId[world.s5].device_id).toBe(world.a1.deviceId) // the same phone
    expect(byId[world.s3].device_id).toBe(world.a2.deviceId)
    expect(byId[world.s4].device_id).toBe(world.a2.deviceId) // an upload from a phone is that phone's scan
    expect(byId[world.s2].device_id).toBe(world.b1.deviceId)
    expect(byId[world.s1].device_id).not.toBe(byId[world.s3].device_id) // two phones of the same provider
  })

  it('never shares a device_id between two providers: a sign-in belongs to one provider', async () => {
    const providersOf = new Map()
    for (const s of await agentScans()) {
      if (!s.device_id) continue
      providersOf.set(s.device_id, new Set([...(providersOf.get(s.device_id) ?? []), s.provider_id]))
    }
    expect(providersOf.size).toBeGreaterThanOrEqual(3)
    for (const [device, providers] of providersOf) expect(providers.size, device).toBe(1)
  })

  it('is a uuid, and is null for a scan whose phone is not known', async () => {
    const scans = await agentScans()
    for (const s of scans.filter((x) => x.device_id !== null)) expect(s.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(scans.some((s) => s.device_id === null)).toBe(true)
  })

  it('writes the four fields at the end of the CSV, after the sixteen columns that were always there, with an empty cell for a null', async () => {
    expect(AGENT_SCAN_CSV_COLUMNS).toEqual([...SCAN_CSV_COLUMNS, ...AGENT_ONLY_SCAN_KEYS])
    const r = await agent(`/scans?${FILTER_ALL}&format=csv`)
    expect(r.status).toBe(200)
    const lines = r.text.split('\r\n')
    expect(lines[0]).toBe([...SCAN_KEYS, ...AGENT_ONLY_SCAN_KEYS].join(','))
    const columnsOf = (id) => {
      const cells = lines.find((l) => l.startsWith(`${id},`)).split(',')
      return Object.fromEntries(AGENT_SCAN_CSV_COLUMNS.map((c, i) => [c, cells[i]]))
    }
    const voided = columnsOf(world.s1)
    expect(voided).toMatchObject({ voided: 'true', voided_by: 'Test Admin', device_id: world.a1.deviceId })
    expect(voided.voided_at).toBe((await agentScan(world.s1)).voided_at)
    expect(voided.received_at).toBe((await agentScan(world.s1)).received_at)
    expect(columnsOf(world.s3)).toMatchObject({ voided: 'false', voided_at: '', voided_by: '', device_id: world.a2.deviceId })
    expect(lines.at(-2).split(',').length).toBe(AGENT_SCAN_CSV_COLUMNS.length) // no cell shifted a row (a name has no comma here)
  })

  it('is a CSV of the same scans in the same order as the JSON', async () => {
    const json = (await agentScans()).map((s) => s.id)
    const csv = (await agent(`/scans?${FILTER_ALL}&format=csv`)).text.split('\r\n').slice(1).filter(Boolean).map((l) => l.split(',')[0])
    expect(csv).toEqual(json)
  })

  it('defuses a name that a spreadsheet would run as a formula, like every other text cell of the CSV', async () => {
    const formula = (await post('/api/admin/admins', { email: 'formula@test.local', name: '=HYPERLINK("http://evil.example")' })).admin
    const formulaCookie = await adminCookie('formula@test.local')
    expect(formula.id).toBeTruthy()
    const id = await scanOnline(world.b1, world.points[4])
    await voidScan(id, 'by a member whose name is a formula', formulaCookie)
    const r = await agent(`/scans?${FILTER_ALL}&format=csv`)
    const line = r.text.split('\r\n').find((l) => l.startsWith(`${id},`))
    expect(line).toContain(`"'=HYPERLINK(""http://evil.example"")"`)
    expect((await agentScan(id)).voided_by).toBe('=HYPERLINK("http://evil.example")') // the JSON has the name as it is
  })
})

// ======================================================================================================================
// 4. What the committee and the phones get did not change
// ======================================================================================================================

describe('the shape of a scan for the committee and for the provider phones is what it was', () => {
  it('scanJson has the sixteen fields in their order, and the agent projection only adds four after them', async () => {
    const row = await dbScan(world.s1)
    expect(Object.keys(scanJson(row))).toEqual(SCAN_KEYS)
    expect(Object.keys(agentScanJson({ ...row, voided_by: 'x' }))).toEqual([...SCAN_KEYS, ...AGENT_ONLY_SCAN_KEYS])
    expect({ ...agentScanJson({ ...row, voided_by: 'x' }) }).toMatchObject(scanJson(row))
  })

  it('the committee history list, the answers of void and restore, and the provider phones get the sixteen fields and no more', async () => {
    const history = (await call('GET', `/api/admin/scans?${FILTER_ALL}`, { cookie })).json
    expect(history.scans.length).toBeGreaterThanOrEqual(6)
    for (const s of history.scans) expect(Object.keys(s), s.id).toEqual(SCAN_KEYS)
    expect(Object.keys(history)).toEqual(['scans', 'next_cursor'])

    const id = await scanOnline(world.b1, world.points[3])
    const voided = await call('POST', `/api/admin/scans/${id}/void`, { cookie, body: { reason: 'shape' } })
    expect(Object.keys(voided.json.scan)).toEqual(SCAN_KEYS)
    const restored = await call('POST', `/api/admin/scans/${id}/unvoid`, { cookie, body: {} })
    expect(Object.keys(restored.json.scan)).toEqual(SCAN_KEYS)

    const fresh = randomUUID()
    const scanned = await call('POST', '/api/scan', { token: world.b1.token, body: { id: fresh, code: world.points[2].qr_token }, ip: IP })
    expect(Object.keys(scanned.json.scan)).toEqual(SCAN_KEYS)
    expect(Object.keys(scanned.json)).toEqual(['scan', 'duplicate'])
    const replay = await call('POST', '/api/scan', { token: world.b1.token, body: { id: fresh, code: world.points[2].qr_token }, ip: IP })
    expect(Object.keys(replay.json.scan)).toEqual(SCAN_KEYS)
    const sync = await call('POST', '/api/scans/sync', { token: world.b1.token, body: { scans: [{ id: randomUUID(), code: world.points[1].qr_token, client_time: agoIso(HOUR) }] }, ip: IP })
    expect(Object.keys(sync.json.results[0].scan)).toEqual(SCAN_KEYS)
    const mine = await call('GET', '/api/my/scans', { token: world.b1.token })
    expect(mine.json.scans.length).toBeGreaterThan(0)
    for (const s of mine.json.scans) expect(Object.keys(s)).toEqual(SCAN_KEYS)
  })

  it("the committee's CSV has its sixteen columns as before and none of the agent's four", async () => {
    expect(COMMITTEE_CSV_COLUMNS).toEqual(SCAN_CSV_COLUMNS.map((c) => (c === 'checked_in_at' ? 'checked_in_utc' : c)))
    const r = await call('GET', `/api/admin/scans?${FILTER_ALL}&format=csv`, { cookie })
    expect(r.status).toBe(200)
    expect(r.text.replace('﻿', '').split('\r\n')[0]).toBe(COMMITTEE_CSV_COLUMNS.join(','))
    for (const column of AGENT_ONLY_SCAN_KEYS) expect(r.text.split('\r\n')[0], column).not.toContain(column)
  })
})

// ======================================================================================================================
// 5. No secret in the new or changed answers
// ======================================================================================================================

describe('no secret reaches /building, /providers or /scans (JSON and CSV)', () => {
  it('has none of the secrets of the seed in the raw text of any of the four answers', async () => {
    // Secrets of every kind that AGENTS.md ("Safety") lists, put where the server keeps them. A point's code and legacy id, a phone's
    // label (the browser string), a provider's password and its hash, a key and its fingerprint, the tokens of the phones and their
    // hashes, a Google id, the address of the request.
    await db.pool.query("update points set legacy_id = 'legacy-marker-5521' where id = $1", [world.points[0].id])
    expect((await call('PUT', '/api/admin/building', { cookie, body: { address: 'Fake Street 7, Fake City', name: 'Fake Building' } })).status).toBe(200)

    const points = (await db.pool.query('select qr_token, legacy_id from points')).rows
    const providers = (await db.pool.query('select password_hash from providers')).rows
    const phones = (await db.pool.query('select token_hash, label from provider_devices')).rows
    const members = (await db.pool.query('select google_sub from admins where google_sub is not null')).rows
    const keys = (await db.pool.query('select key_prefix, key_hash from api_keys')).rows
    const key = await currentKey()
    const secrets = {
      'a QR token': points.map((p) => p.qr_token),
      'a legacy id': points.map((p) => p.legacy_id).filter(Boolean),
      "a provider's password": [world.pwA, 'pw-fake-secret-B-7310', 'pw-fake-secret-C-2093', 'pw-fake-secret-D-5566'],
      "the hash of a provider's password": providers.map((p) => p.password_hash),
      'the token of a phone': [world.a1.token, world.a2.token, world.a3.token, world.b1.token, world.d1.token],
      'the hash of the token of a phone': phones.map((p) => p.token_hash),
      "a phone's label": [LABEL, 'Phone-Marker-7731'],
      "a phone's own build": [BUILD, OLD_BUILD],
      'a Google id': members.map((m) => m.google_sub),
      'a key, its fingerprint and its prefix': [key, sha256(key), key.slice(0, 8), ...keys.map((k) => k.key_hash), ...keys.map((k) => k.key_prefix)],
      'the address of the request': [IP],
      'the table of the building': ['building_settings', 'updated_by'],
    }
    // The control: each kind of secret is really in the database, so that a test which finds none in the answers proves something.
    expect(points.length).toBeGreaterThanOrEqual(6)
    expect(points.some((p) => p.legacy_id === 'legacy-marker-5521')).toBe(true)
    expect(providers.every((p) => typeof p.password_hash === 'string' && p.password_hash.length > 20)).toBe(true)
    expect(phones.some((p) => p.label === LABEL)).toBe(true)
    expect(members.length).toBeGreaterThan(0)
    expect(keys.length).toBeGreaterThan(0)
    const stored = (await db.pool.query('select key from auth_attempts')).rows.map((r) => r.key)
    expect(stored.some((k) => k.includes(IP)), 'the address of a sign-in is kept by auth_attempts').toBe(true)

    const answers = {
      '/building': await agent('/building'),
      '/providers': await agent('/providers'),
      '/scans (JSON)': await agent(`/scans?${FILTER_ALL}`),
      '/scans (CSV)': await agent(`/scans?${FILTER_ALL}&format=csv`),
    }
    for (const [name, r] of Object.entries(answers)) expect(r.status, name).toBe(200)
    expect(answers['/building'].json.building).toEqual({ name: 'Fake Building', address: 'Fake Street 7, Fake City' })
    for (const [name, r] of Object.entries(answers)) {
      for (const [kind, values] of Object.entries(secrets)) {
        for (const value of values) {
          expect(typeof value === 'string' && value.length >= 4, `a secret of the kind "${kind}" is a real value`).toBe(true)
          expect(r.text, `${name} carries ${kind}`).not.toContain(value)
        }
      }
    }
  })

  it('the answers are built from named fields: a column added to a table later does not reach them', async () => {
    // A column that the agent must not see is added to the three tables the answers read, and filled; none of it comes out.
    await db.pool.query("alter table scans add column fake_secret text")
    await db.pool.query("alter table providers add column fake_secret text default 'fake-secret-marker-9921'")
    await db.pool.query("alter table provider_devices add column fake_secret text default 'fake-secret-marker-9921'")
    await db.pool.query("alter table building_settings add column fake_secret text default 'fake-secret-marker-9921'")
    await db.pool.query("alter table audit_log add column fake_secret text default 'fake-secret-marker-9921'")
    for (const path of ['/building', '/providers', `/scans?${FILTER_ALL}`, `/scans?${FILTER_ALL}&format=csv`]) {
      const r = await agent(path)
      expect(r.status, path).toBe(200)
      expect(r.text, path).not.toContain('fake_secret')
      expect(r.text, path).not.toContain('fake-secret-marker-9921')
    }
  })
})
