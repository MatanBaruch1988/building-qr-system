// GET /api/agent/v1/refusals: the visits that the server turned away, for the committee's analyst, the agent (owner decision of
// 08/10/2026, AGENTS.md "Safety": the agent sees what the committee app shows and never a secret; server/scanRefusals.js keeps the
// record, migration 008 is the table). The committee already reads the same list (GET /api/admin/scan-refusals, tested in
// tests/scan-refusals.test.js); this file proves the agent's.
// What this file proves:
//   1. the route needs an agent key (the key is judged first, then the rest), reads nothing else as a credential, and writes nothing;
//   2. the answer is { refusals, count, next_cursor } with the ten fields of a refusal in their order, ISO times, newest first, and
//      it is the committee's list: the same refusals, the same fields, the same order, and a cursor that works on both;
//   3. a refused visit of every code of the sync contract (the real ones through the API, the one that only the database can make
//      written into the table) is there with the provider and the point as they were, from both sources;
//   4. the filters (day, ISO time, point, provider), the paging through the cursor to the end (also across equal times), the page
//      size (the default, and the largest, which is the committee's own constant) and the validation (the same status, code and
//      field as the committee route and as the scans list);
//   5. a refusal is not attendance: /scans and /providers do not change when one is added, and no refusal is a scan;
//   6. nothing secret is in the raw text of the answer: no QR code (the one scanned, nor the one of a point), no position, no phone
//      (its id, its label, its token), no password or key or hash, no address of a request; a column added to the table later does
//      not reach the answer, and the statement reads named columns, never `*`.
// The data is fake.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie, mintAgentKey, revokeAgentKey, putKeyAtMinuteLimit } from './helpers.js'
import { sha256 } from '../server/crypto.js'
import { AGENT_REFUSAL_COLUMNS, agentRefusalJson, refusalJson, REFUSAL_FILTERS } from '../server/scanRefusals.js'
import { schemaDoc } from '../server/schemaDoc.js'
import { openApiDocument } from '../server/agentOpenApi.js'
import { AGENT_KEY_MAX_PER_MINUTE, DEFAULT_PAGE_SIZE, MAX_REFUSAL_PAGE_SIZE } from '../server/config.js'
import {
  SOURCE_ONLINE,
  SOURCE_OFFLINE_SYNC,
  SCAN_SOURCES,
  SYNC_PERMANENT_ERROR_CODES,
  SCAN_ERROR_INVALID_SCAN_ID,
  SCAN_ERROR_INVALID_CODE,
  SCAN_ERROR_UNKNOWN_CODE,
  SCAN_ERROR_POINT_INACTIVE,
  SCAN_ERROR_NOT_ASSIGNED,
  SCAN_ERROR_SCAN_ID_CONFLICT,
  SCAN_ERROR_INVALID_ITEM,
  QR_TOKEN_PREFIX,
} from '../shared/contract.js'

const KEYS = ['id', 'at', 'scan_id', 'source', 'code', 'provider_id', 'provider_name', 'point_id', 'point_name', 'client_time']
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DASH = '–' // the separator of "company - contact" in a snapshot of a provider's name
const HOUR = 3600 * 1000
const IP = '10.77.88.99'
const LABEL = 'Mozilla/5.0 (Fake; Phone-Marker-9314) FakeBrowser/1.0'
// Fake positions with digits that nothing else in the data has: a position stored or shown anywhere would be found in the raw text.
const GPS = { lat: 31.2468013, lng: 34.7918013, accuracy: 5 }
const UNKNOWN_CODE = QR_TOKEN_PREFIX + randomBytes(10).toString('hex') // a code that is ours in shape and names no point
const NONSENSE_CODE = 'nonsense-marker-4471' // text that is not a code of ours at all
const T = new Date(Date.now() - 2 * HOUR).toISOString() // the phone's clock in the queued items below

let db, cookie
let agentKey, keyUses = 0
const world = {} // ids and values of the seed, by name

// One key may make AGENT_KEY_MAX_PER_MINUTE requests in a minute; this file stays under that by working through keys, as
// tests/agent-docs.test.js does.
const KEY_USES = Math.floor((AGENT_KEY_MAX_PER_MINUTE * 2) / 3)
async function currentKey() {
  if (!agentKey || keyUses >= KEY_USES) {
    agentKey = (await mintAgentKey(cookie, 'agent refusals')).key
    keyUses = 0
  }
  keyUses += 1
  return agentKey
}
const agent = async (path, opts = {}) => call('GET', `/api/agent/v1${path}`, { token: await currentKey(), ...opts })
const refusals = async (qs = '') => agent(`/refusals${qs ? '?' + qs : ''}`)
const committee = (qs = '') => call('GET', `/api/admin/scan-refusals${qs ? '?' + qs : ''}`, { cookie })
const idsOf = (res) => res.json.refusals.map((r) => r.id)
/** The ids of the rows in the database, newest first, as the list must give them. */
const dbIds = async (where = 'true', params = []) =>
  (await db.pool.query(`select id from scan_refusals where ${where} order by at desc, id desc`, params)).rows.map((r) => Number(r.id))

const post = async (path, body) => {
  const r = await call('POST', path, { cookie, body })
  if (r.status !== 200 && r.status !== 201) throw new Error(`seed ${path}: ${r.status} ${r.text}`)
  return r.json
}
const makePoint = async (extra = {}) => (await post('/api/admin/points', { name: 'Fake point ' + randomUUID().slice(0, 6), gps_mode: 'none', ...extra })).point
const makeProvider = async (company, contact, password) => (await post('/api/admin/providers', { company, contact_name: contact, password })).provider
/** Signs a provider in on a new phone: its token and the id of its row. */
const signIn = async (provider, password, label = 'Fake Browser') => {
  const res = await call('POST', '/api/session', { body: { provider_id: provider.id, password, device_label: label }, ip: IP })
  if (res.status !== 200) throw new Error(`sign-in: ${res.status} ${res.text}`)
  const { rows } = await db.pool.query('select id from provider_devices where token_hash = $1', [sha256(res.json.token)])
  return { token: res.json.token, deviceId: rows[0].id }
}
const sync = (token, scans) => call('POST', '/api/scans/sync', { token, body: { scans }, ip: IP })
const scanOnline = (token, body) => call('POST', '/api/scan', { token, body, ip: IP })

/** Adds one row the way the code does, with an explicit time when a test needs one. */
async function addRow({ at, scanId = null, source = SOURCE_ONLINE, code = SCAN_ERROR_POINT_INACTIVE, providerId, providerName = 'Fake Person', pointId = null, pointName = null, clientTime = null, deviceId = null }) {
  const { rows } = await db.pool.query(
    `insert into scan_refusals (at, scan_id, source, code, provider_id, provider_name, device_id, point_id, point_name, client_time)
     values (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [at ?? null, scanId, source, code, providerId, providerName, deviceId, pointId, pointName, clientTime],
  )
  return Number(rows[0].id)
}

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()

  world.pwA = 'pw-fake-secret-A-4821'
  world.pwB = 'pw-fake-secret-B-7310'
  world.a = await makeProvider('Fake Cleaners', 'Fake Person', world.pwA)
  world.b = await makeProvider('Fake Gardeners', '', world.pwB)
  world.phoneA = await signIn(world.a, world.pwA, LABEL)
  world.phoneB = await signIn(world.b, world.pwB)

  world.open = await makePoint()
  world.inactive = await makePoint({ is_active: false })
  world.onlyB = await makePoint({ provider_ids: [world.b.id] })
  await db.pool.query("update points set legacy_id = 'legacy-marker-5521' where id = $1", [world.open.id])

  // The refused visits that the server records itself, one of every kind that a request can cause. Each one carries a position (the
  // server must not keep it) and the code that was scanned (the same).
  const id = () => randomUUID()
  world.real = {}
  const note = (code, source, scanId, point, extra = {}) => (world.real[code] = { code, source, scan_id: scanId, point, ...extra })
  const expectRefused = (res, code, source) => {
    const error = source === SOURCE_ONLINE ? res.json?.error : res.json?.results?.[0]?.error
    if (error?.code !== code) throw new Error(`the seed visit was not refused with ${code}: ${res.status} ${res.text}`)
  }

  let scanId = id()
  expectRefused(await scanOnline(world.phoneA.token, { id: scanId, code: world.inactive.qr_token, gps: GPS }), SCAN_ERROR_POINT_INACTIVE, SOURCE_ONLINE)
  note(SCAN_ERROR_POINT_INACTIVE, SOURCE_ONLINE, scanId, world.inactive)

  scanId = id()
  expectRefused(await sync(world.phoneA.token, [{ id: scanId, code: world.onlyB.qr_token, client_time: T, gps: GPS }]), SCAN_ERROR_NOT_ASSIGNED, SOURCE_OFFLINE_SYNC)
  note(SCAN_ERROR_NOT_ASSIGNED, SOURCE_OFFLINE_SYNC, scanId, world.onlyB, { client_time: T })

  scanId = id()
  expectRefused(await sync(world.phoneA.token, [{ id: scanId, code: UNKNOWN_CODE, client_time: T, gps: GPS }]), SCAN_ERROR_UNKNOWN_CODE, SOURCE_OFFLINE_SYNC)
  note(SCAN_ERROR_UNKNOWN_CODE, SOURCE_OFFLINE_SYNC, scanId, null, { client_time: T })

  scanId = id()
  expectRefused(await scanOnline(world.phoneA.token, { id: scanId, code: NONSENSE_CODE, gps: GPS }), SCAN_ERROR_INVALID_CODE, SOURCE_ONLINE)
  note(SCAN_ERROR_INVALID_CODE, SOURCE_ONLINE, scanId, null)

  expectRefused(await sync(world.phoneA.token, [{ id: 'not-a-uuid', code: world.open.qr_token, client_time: T, gps: GPS }]), SCAN_ERROR_INVALID_SCAN_ID, SOURCE_OFFLINE_SYNC)
  note(SCAN_ERROR_INVALID_SCAN_ID, SOURCE_OFFLINE_SYNC, null, null, { client_time: T })

  // B records a scan under this id (at a point of its own), then A sends the same id.
  scanId = id()
  expect((await scanOnline(world.phoneB.token, { id: scanId, code: world.onlyB.qr_token })).status).toBe(200)
  world.conflictScan = scanId
  expectRefused(await scanOnline(world.phoneA.token, { id: scanId, code: world.open.qr_token, gps: GPS }), SCAN_ERROR_SCAN_ID_CONFLICT, SOURCE_ONLINE)
  note(SCAN_ERROR_SCAN_ID_CONFLICT, SOURCE_ONLINE, scanId, null)

  // The one that only the database can cause: it refused the data of an item that came from a queue. Written the way the code writes it.
  world.itemId = id()
  world.itemDevice = world.phoneA.deviceId
  await addRow({
    scanId: world.itemId, source: SOURCE_OFFLINE_SYNC, code: SCAN_ERROR_INVALID_ITEM, providerId: world.a.id,
    providerName: `Fake Cleaners ${DASH} Fake Person`, deviceId: world.itemDevice, pointId: world.open.id, pointName: world.open.name, clientTime: T,
  })
  note(SCAN_ERROR_INVALID_ITEM, SOURCE_OFFLINE_SYNC, world.itemId, world.open, { client_time: T })
}, 120_000)

afterAll(async () => db?.teardown())

// ======================================================================================================================
// 1. The key, and nothing written
// ======================================================================================================================

describe('GET /api/agent/v1/refusals: the key', () => {
  it('needs an agent key: nobody, an unknown key and a revoked key are refused, and the key is judged before the rest of the request', async () => {
    const spare = await mintAgentKey(cookie, 'agent refusals, revoked')
    await revokeAgentKey(cookie, spare.id)
    for (const [who, opts, code] of [
      ['no key', {}, 'api_key_required'],
      ['an unknown key', { token: 'qrk_unknown' }, 'api_key_invalid'],
      ['a revoked key', { token: spare.key }, 'api_key_invalid'],
      ['a header that is not a Bearer key', { headers: { authorization: 'Basic abc' } }, 'api_key_required'],
    ]) {
      for (const qs of ['', '?limit=abc', '?cursor=zzz', '?point_id=x']) {
        const r = await call('GET', `/api/agent/v1/refusals${qs}`, opts)
        expect([r.status, r.json.error.code], `${who} ${qs}`).toEqual([401, code])
        expect(r.json.refusals, `${who} ${qs}`).toBeUndefined()
      }
    }
  })

  it('does not take a committee session or a provider phone as a credential', async () => {
    const asCookie = await call('GET', '/api/agent/v1/refusals', { cookie })
    expect([asCookie.status, asCookie.json.error.code]).toEqual([401, 'api_key_required'])
    const asProvider = await call('GET', '/api/agent/v1/refusals', { token: world.phoneA.token })
    expect([asProvider.status, asProvider.json.error.code]).toEqual([401, 'api_key_required'])
  })

  it('answers a key that is over its limit with the 429 before it looks at the query', async () => {
    const spent = await mintAgentKey(cookie, 'agent refusals, over the limit')
    await putKeyAtMinuteLimit(db.pool, spent.id)
    const r = await call('GET', '/api/agent/v1/refusals?limit=abc', { token: spent.key })
    expect([r.status, r.json.error.code]).toEqual([429, 'rate_limited'])
  })

  it('reads and writes nothing else: other methods are 405, and no row of the table, the audit log or the scans changes', async () => {
    const count = async () => (await db.pool.query('select (select count(*) from scan_refusals) as r, (select count(*) from audit_log) as a, (select count(*) from scans) as s')).rows[0]
    const { key } = await mintAgentKey(cookie, 'agent refusals, read only') // minting a key is a committee action, and it is audited: do it first
    const before = await count()
    for (const qs of ['', '?limit=1', '?provider_id=x']) await call('GET', `/api/agent/v1/refusals${qs}`, { token: key })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(method, '/api/agent/v1/refusals', { token: key, body: {} })
      expect([r.status, r.json.error.code], method).toEqual([405, 'method_not_allowed'])
    }
    expect(await count()).toEqual(before)
  })
})

// ======================================================================================================================
// 2. The answer
// ======================================================================================================================

describe('GET /api/agent/v1/refusals: the answer', () => {
  it('is { refusals, count, next_cursor }, newest first, with the ten fields of a refusal in their order and ISO times', async () => {
    const res = await refusals()
    expect(res.status).toBe(200)
    expect(Object.keys(res.json)).toEqual(['refusals', 'count', 'next_cursor'])
    expect(res.json.count).toBe(res.json.refusals.length)
    expect(res.json.next_cursor).toBeNull()
    expect(res.json.refusals.length).toBeGreaterThanOrEqual(SYNC_PERMANENT_ERROR_CODES.length)
    expect(idsOf(res)).toEqual(await dbIds())
    for (const r of res.json.refusals) {
      expect(Object.keys(r)).toEqual(KEYS)
      expect(typeof r.id).toBe('number')
      expect(r.at).toMatch(ISO)
      expect(r.client_time === null || ISO.test(r.client_time)).toBe(true)
      expect(SCAN_SOURCES).toContain(r.source)
      expect(SYNC_PERMANENT_ERROR_CODES).toContain(r.code)
    }
    expect(AGENT_REFUSAL_COLUMNS.slice().sort()).toEqual(KEYS.slice().sort())
  })

  it('has a refusal of every code of the sync contract, as the server recorded it: the provider and the point as they were, the id and the clock of the phone', async () => {
    const list = (await refusals()).json.refusals
    expect(Object.keys(world.real).sort()).toEqual([...SYNC_PERMANENT_ERROR_CODES].sort())
    for (const code of SYNC_PERMANENT_ERROR_CODES) {
      const want = world.real[code]
      const mine = list.filter((r) => r.code === code)
      expect(mine, code).toHaveLength(1)
      expect(mine[0], code).toEqual({
        id: expect.any(Number),
        at: expect.stringMatching(ISO),
        scan_id: want.scan_id,
        source: want.source,
        code,
        provider_id: world.a.id,
        provider_name: `Fake Cleaners ${DASH} Fake Person`,
        point_id: want.point ? want.point.id : null,
        point_name: want.point ? want.point.name : null,
        client_time: want.client_time ?? null,
      })
      expect(schemaDoc.refusal_codes[code], `the meaning of ${code} in /schema`).toEqual(expect.any(String))
    }
    // Both sources, with a point and without one, with a clock and without one.
    expect(new Set(list.map((r) => r.source))).toEqual(new Set(SCAN_SOURCES))
    expect(list.some((r) => r.point_id === null)).toBe(true)
    expect(list.some((r) => r.point_id !== null)).toBe(true)
    expect(list.some((r) => r.client_time === null)).toBe(true)
    expect(list.some((r) => r.scan_id === null)).toBe(true)
  })

  it("is the committee's list: the same refusals with the same fields in the same order, for the same filters, and a cursor of one works on the other", async () => {
    for (const qs of ['', 'limit=3', `provider_id=${world.a.id}`, `point_id=${world.inactive.id}`, `provider_id=${world.a.id.toUpperCase()}&limit=2`, 'from=2020-01-01&to=2100-01-01']) {
      const [theirs, ours] = [await committee(qs), await refusals(qs)]
      expect(ours.status, qs).toBe(200)
      expect(ours.json.refusals, qs).toEqual(theirs.json.refusals)
      expect(ours.json.next_cursor, qs).toBe(theirs.json.next_cursor)
    }
    const first = await committee('limit=2')
    expect(first.json.next_cursor).not.toBeNull()
    const [theirs, ours] = [await committee(`limit=2&cursor=${first.json.next_cursor}`), await refusals(`limit=2&cursor=${first.json.next_cursor}`)]
    expect(ours.json.refusals).toEqual(theirs.json.refusals)
    expect(ours.json.next_cursor).toBe(theirs.json.next_cursor)
    const second = await refusals('limit=2')
    expect(second.json.next_cursor).toBe(first.json.next_cursor)
    expect((await committee(`limit=2&cursor=${second.json.next_cursor}`)).json.refusals).toEqual(ours.json.refusals)
  })

  it('shows nothing that the committee does not: the agent row is the committee row, and neither names the phone', async () => {
    const rows = (await db.pool.query('select * from scan_refusals order by id')).rows
    expect(rows.some((r) => r.device_id !== null)).toBe(true) // the phone is in the table...
    for (const row of rows) {
      expect(agentRefusalJson(row)).toEqual(refusalJson(row)) // ...and in neither answer
      expect(Object.keys(agentRefusalJson(row))).toEqual(KEYS)
    }
  })

  it('keeps a refusal after its provider and its point are deleted, with the names as they were', async () => {
    const gone = await makeProvider('Fake Temp Co', '', 'pw-fake-secret-G-6602')
    const phone = await signIn(gone, 'pw-fake-secret-G-6602')
    const doomed = await makePoint({ is_active: false })
    const scanId = randomUUID()
    expect((await sync(phone.token, [{ id: scanId, code: doomed.qr_token, client_time: T }])).json.results[0].error.code).toBe(SCAN_ERROR_POINT_INACTIVE)
    expect((await call('DELETE', `/api/admin/points/${doomed.id}`, { cookie })).status).toBe(200)
    expect((await call('DELETE', `/api/admin/providers/${gone.id}`, { cookie })).status).toBe(200)
    expect((await db.pool.query('select 1 from points where id = $1', [doomed.id])).rows).toEqual([])
    expect((await db.pool.query('select 1 from providers where id = $1', [gone.id])).rows).toEqual([])

    const byProvider = await refusals(`provider_id=${gone.id}`)
    expect(byProvider.json.refusals).toHaveLength(1)
    expect(byProvider.json.refusals[0]).toMatchObject({ provider_id: gone.id, provider_name: 'Fake Temp Co', point_id: doomed.id, point_name: doomed.name, scan_id: scanId, code: SCAN_ERROR_POINT_INACTIVE })
    expect(idsOf(await refusals(`point_id=${doomed.id}`))).toEqual(idsOf(byProvider))
    // Nothing in /providers or /points lists them any more: the ids in the refusal are all that is left, as the documents say.
    expect((await agent('/providers')).json.providers.some((p) => p.id === gone.id)).toBe(false)
    expect((await agent('/points')).json.points.some((p) => p.id === doomed.id)).toBe(false)
  })
})

// ======================================================================================================================
// 3. Filters, paging, the page size and the validation
// ======================================================================================================================

describe('GET /api/agent/v1/refusals: the filters', () => {
  it('reads exactly the filters of REFUSAL_FILTERS (the committee has the same six), and the registry, /schema and the OpenAPI document name them', () => {
    expect([...REFUSAL_FILTERS]).toEqual(['from', 'to', 'point_id', 'provider_id', 'limit', 'cursor'])
    const operation = openApiDocument.paths['/refusals'].get
    expect(operation.parameters.map((p) => p.name)).toEqual([...REFUSAL_FILTERS])
    expect(operation.operationId).toBe('listRefusals')
    expect(Object.keys(schemaDoc.endpoints)).toContain('GET /api/agent/v1/refusals')
  })

  it('filters by provider and by point (an id in capitals is the same id), alone and together', async () => {
    const [p1, p2, q1, q2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const rows = [
      await addRow({ providerId: p1, pointId: q1 }),
      await addRow({ providerId: p1, pointId: q2 }),
      await addRow({ providerId: p2, pointId: q1 }),
      await addRow({ providerId: p2 }),
    ]
    expect(idsOf(await refusals(`provider_id=${p1}`))).toEqual([rows[1], rows[0]])
    expect(idsOf(await refusals(`point_id=${q1}`))).toEqual([rows[2], rows[0]])
    expect(idsOf(await refusals(`provider_id=${p2}&point_id=${q1}`))).toEqual([rows[2]])
    expect(idsOf(await refusals(`provider_id=${p1.toUpperCase()}`))).toEqual([rows[1], rows[0]])
    expect(idsOf(await refusals(`provider_id=${randomUUID()}`))).toEqual([])
    // A refusal whose code named no point is matched by no point_id: it is found without the filter.
    expect(idsOf(await refusals(`provider_id=${p2}`))).toEqual([rows[3], rows[2]])
    expect((await refusals(`provider_id=${randomUUID()}`)).json).toEqual({ refusals: [], count: 0, next_cursor: null })
  })

  it("filters by building day (in the building's time zone, both days included) and by ISO time, also across the change to summer time", async () => {
    // Israel's clocks go forward at 02:00 on Friday 27/03/2026: before that it is UTC+2, after it UTC+3. So the 27th starts at
    // 22:00 UTC on the 26th and ends at 21:00 UTC on the 27th (a day of 23 hours).
    const providerId = randomUUID()
    const at = {
      endOf26: '2026-03-26T21:59:59Z', // 23:59:59 on the 26th
      startOf27: '2026-03-26T22:00:00Z', // 00:00:00 on the 27th
      endOf27: '2026-03-27T20:59:59Z', // 23:59:59 on the 27th
      startOf28: '2026-03-27T21:00:00Z', // 00:00:00 on the 28th
    }
    const row = Object.fromEntries(await Promise.all(Object.entries(at).map(async ([name, when]) => [name, await addRow({ at: when, providerId })])))
    const filter = (qs) => refusals(`provider_id=${providerId}&${qs}`)
    expect(idsOf(await filter('from=2026-03-27&to=2026-03-27')).sort()).toEqual([row.startOf27, row.endOf27].sort())
    expect(idsOf(await filter('from=2026-03-27'))).toEqual([row.startOf28, row.endOf27, row.startOf27])
    expect(idsOf(await filter('to=2026-03-26'))).toEqual([row.endOf26])
    expect(idsOf(await filter('to=2026-03-27'))).toEqual([row.endOf27, row.startOf27, row.endOf26])
    expect(idsOf(await filter('from=2026-03-28&to=2026-03-26'))).toEqual([])
    // An ISO time says which moment it means: both ends included.
    expect(idsOf(await filter('from=2026-03-26T22:00:00Z'))).toEqual([row.startOf28, row.endOf27, row.startOf27])
    expect(idsOf(await filter('to=2026-03-26T22:00:00Z'))).toEqual([row.startOf27, row.endOf26])
    expect(idsOf(await filter('from=2026-03-27T00:00:00%2B02:00&to=2026-03-27T23:59:59%2B03:00'))).toEqual([row.endOf27, row.startOf27])
  })

  it('ignores a parameter that it does not read (outcome, order, format and include_voided belong to /scans): the answer is the same JSON', async () => {
    const plain = await refusals('limit=5')
    for (const extra of ['outcome=rejected', 'order=asc', 'format=csv', 'include_voided=true', 'include_demo=true', 'service_type=cleaning', 'flag=demo', 'whatever=1']) {
      const r = await refusals(`limit=5&${extra}`)
      expect(r.status, extra).toBe(200)
      expect(r.json, extra).toEqual(plain.json)
    }
  })

  it('pages with a cursor on (at, id): every refusal once and in order to the end, also for equal times and a fraction of a millisecond', async () => {
    const providerId = randomUUID()
    const same = '2026-06-01T12:00:00.500Z'
    await addRow({ at: '2026-06-01T12:00:00.123456Z', providerId })
    await addRow({ at: same, providerId })
    await addRow({ at: same, providerId })
    await addRow({ at: same, providerId })
    await addRow({ at: '2026-06-01T12:00:00.123999Z', providerId })
    await addRow({ at: '2026-06-01T11:59:59.999Z', providerId })
    await addRow({ at: '2026-06-01T12:00:01Z', providerId })
    const expected = await dbIds('provider_id = $1', [providerId])
    expect(expected).toHaveLength(7)

    for (const size of [1, 2, 3, 7, 8]) {
      const seen = []
      let cursor = null
      let pages = 0
      do {
        const res = await refusals(`provider_id=${providerId}&limit=${size}${cursor ? `&cursor=${cursor}` : ''}`)
        expect(res.status).toBe(200)
        expect(res.json.refusals.length).toBeLessThanOrEqual(size)
        expect(res.json.count).toBe(res.json.refusals.length)
        seen.push(...idsOf(res))
        cursor = res.json.next_cursor
        pages++
      } while (cursor && pages < 20)
      expect(seen, `pages of ${size}`).toEqual(expected)
      expect(pages, `pages of ${size}`).toBe(Math.ceil(7 / size))
    }
    // The last page has no cursor, and a page that is exactly full of the last rows has none either.
    expect((await refusals(`provider_id=${providerId}&limit=7`)).json.next_cursor).toBeNull()
    expect((await refusals(`provider_id=${providerId}&limit=6`)).json.next_cursor).not.toBeNull()
  })
})

describe('GET /api/agent/v1/refusals: the validation', () => {
  const BAD = [
    'from=yesterday', 'from=2026-13-01', 'from=2026-06-01T10:00:00', 'to=2026-02-30', 'to=zzz', 'point_id=x', 'provider_id=x', 'point_id=123',
    'limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'cursor=garbage', `cursor=${Buffer.from('{"t":"nope","id":1}').toString('base64url')}`,
  ]

  it('refuses a bad value with the same status, code and field as the committee route and the scans list, and names the field', async () => {
    for (const qs of BAD) {
      const [theirs, scans, ours] = [await committee(qs), await agent(`/scans?${qs}`), await refusals(qs)]
      expect(ours.status, qs).toBe(400)
      expect([ours.status, ours.json.error.code, ours.json.error.field], qs).toEqual([theirs.status, theirs.json.error.code, theirs.json.error.field])
      expect([ours.status, ours.json.error.code, ours.json.error.field], qs).toEqual([scans.status, scans.json.error.code, scans.json.error.field])
      if (ours.json.error.code === 'invalid_filter') expect(REFUSAL_FILTERS, qs).toContain(ours.json.error.field)
    }
  })

  it('judges the filters in the order they are listed: the first bad one is the one that is named', async () => {
    expect((await refusals('limit=0&to=zzz&from=zzz')).json.error.field).toBe('from')
    expect((await refusals('limit=0&provider_id=x')).json.error.field).toBe('provider_id')
    expect((await refusals('cursor=garbage&limit=0')).json.error.code).toBe('invalid_cursor')
  })

  it('refuses the cursor of the scans list, a cursor with an id that is not a row, and a cursor of a time that is not one', async () => {
    const ofScans = Buffer.from(JSON.stringify({ t: new Date().toISOString(), id: randomUUID() })).toString('base64url')
    expect((await refusals(`cursor=${ofScans}`)).json.error.code).toBe('invalid_cursor')
    for (const id of ['"abc"', '1.5', '0', '-4', 'null']) {
      const r = await refusals(`cursor=${Buffer.from(`{"t":"2026-01-01T00:00:00.000Z","id":${id}}`).toString('base64url')}`)
      expect([r.status, r.json.error.code], id).toEqual([400, 'invalid_cursor'])
    }
  })
})

// ======================================================================================================================
// 4. Not attendance
// ======================================================================================================================

describe('a refusal is not attendance', () => {
  const FULL = 'outcome=all&include_voided=true&include_demo=true&limit=500'

  it('is in no list of scans: adding one changes neither /scans nor /providers, and no refusal is a scan (but the id of a conflict)', async () => {
    const [scansBefore, providersBefore, pointsBefore] = [await agent(`/scans?${FULL}`), await agent('/providers'), await agent('/points')]
    expect(scansBefore.json.scans.length).toBeGreaterThan(0)
    await addRow({ providerId: world.a.id, providerName: `Fake Cleaners ${DASH} Fake Person`, pointId: world.open.id, pointName: world.open.name, scanId: randomUUID() })
    expect((await agent(`/scans?${FULL}`)).json).toEqual(scansBefore.json)
    expect((await agent('/providers')).json).toEqual(providersBefore.json)
    expect((await agent('/points')).json).toEqual(pointsBefore.json)

    const scanIds = new Set(scansBefore.json.scans.map((s) => s.id))
    for (const r of (await refusals('limit=200')).json.refusals) {
      if (r.scan_id && r.code !== SCAN_ERROR_SCAN_ID_CONFLICT) expect(scanIds.has(r.scan_id), `refusal ${r.id} (${r.code}) is a scan`).toBe(false)
    }
    // The conflict names the id of a scan of the other provider, as the documents say.
    const conflict = (await refusals('limit=200')).json.refusals.find((r) => r.code === SCAN_ERROR_SCAN_ID_CONFLICT)
    expect(conflict.scan_id).toBe(world.conflictScan)
    expect(scansBefore.json.scans.find((s) => s.id === world.conflictScan)?.provider_id).toBe(world.b.id)
  })

  it('does not become an outcome of a scan: the outcomes of /scans are the ones it always had', async () => {
    const outcomes = new Set((await agent(`/scans?${FULL}`)).json.scans.map((s) => s.outcome))
    for (const code of SYNC_PERMANENT_ERROR_CODES) expect(outcomes.has(code)).toBe(false)
    expect(schemaDoc.endpoints['GET /api/agent/v1/refusals']).toMatch(/is not a scan and never counts as attendance/)
  })
})

// ======================================================================================================================
// 5. Nothing secret
// ======================================================================================================================

describe('no secret reaches /refusals', () => {
  it('has none of the secrets of the seed in the raw text of the answer, whole or in pages', async () => {
    const points = (await db.pool.query('select qr_token, legacy_id from points')).rows
    const providers = (await db.pool.query('select password_hash from providers')).rows
    const phones = (await db.pool.query('select id, token_hash, label from provider_devices')).rows
    const refusedDevices = (await db.pool.query('select distinct device_id from scan_refusals where device_id is not null')).rows.map((r) => r.device_id)
    const members = (await db.pool.query('select google_sub from admins where google_sub is not null')).rows
    const keys = (await db.pool.query('select key_prefix, key_hash from api_keys')).rows
    const key = await currentKey()
    const secrets = {
      'a QR token': points.map((p) => p.qr_token),
      'the code that was scanned': [UNKNOWN_CODE, NONSENSE_CODE],
      'a legacy id': points.map((p) => p.legacy_id).filter(Boolean),
      'a position': [String(GPS.lat), String(GPS.lng), '31.2468', '34.7918'],
      "a provider's password": [world.pwA, world.pwB],
      "the hash of a provider's password": providers.map((p) => p.password_hash),
      'the id of a phone': phones.map((p) => p.id),
      'the id of the phone of a refusal': refusedDevices,
      'the token of a phone': [world.phoneA.token, world.phoneB.token],
      'the hash of the token of a phone': phones.map((p) => p.token_hash),
      "a phone's label": [LABEL, 'Phone-Marker-9314'],
      'a Google id': members.map((m) => m.google_sub),
      'a key, its fingerprint and its prefix': [key, sha256(key), key.slice(0, 8), ...keys.map((k) => k.key_hash), ...keys.map((k) => k.key_prefix)],
      'the address of the request': [IP],
    }
    // The control: each kind of secret is really in the database, so that a test which finds none in the answer proves something.
    expect(points.length).toBeGreaterThanOrEqual(3)
    expect(points.some((p) => p.legacy_id === 'legacy-marker-5521')).toBe(true)
    expect(providers.every((p) => typeof p.password_hash === 'string' && p.password_hash.length > 20)).toBe(true)
    expect(phones.some((p) => p.label === LABEL)).toBe(true)
    expect(refusedDevices).toContain(world.phoneA.deviceId)
    expect(members.length).toBeGreaterThan(0)
    expect(keys.length).toBeGreaterThan(0)
    const stored = (await db.pool.query('select key from auth_attempts')).rows.map((r) => r.key)
    expect(stored.some((k) => k.includes(IP)), 'the address of a sign-in is kept by auth_attempts').toBe(true)
    // The server does not keep the scanned code or the position in the refusal at all.
    const table = JSON.stringify((await db.pool.query('select * from scan_refusals')).rows)
    for (const value of [UNKNOWN_CODE, NONSENSE_CODE, String(GPS.lat), String(GPS.lng), world.inactive.qr_token]) expect(table, value).not.toContain(value)

    const answers = {
      '/refusals': await refusals(),
      '/refusals (every page of 2)': { text: '' },
      '/refusals (a day)': await refusals('from=2020-01-01&to=2100-12-31'),
    }
    for (let cursor = null, pages = 0; pages < 30; pages++) {
      const page = await refusals(`limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      answers['/refusals (every page of 2)'].text += page.text
      cursor = page.json.next_cursor
      if (!cursor) break
    }
    for (const [name, r] of Object.entries(answers)) {
      expect(r.text.length, name).toBeGreaterThan(200)
      expect(r.text, name).not.toContain('device_id')
      for (const [kind, values] of Object.entries(secrets)) {
        for (const value of values) {
          expect(typeof value === 'string' && value.length >= 4, `a secret of the kind "${kind}" is a real value`).toBe(true)
          expect(r.text, `${name} carries ${kind}`).not.toContain(value)
        }
      }
    }
  })

  it('reads named columns of the table and never a whole row: the statement lists AGENT_REFUSAL_COLUMNS, without the phone', async () => {
    expect(AGENT_REFUSAL_COLUMNS).not.toContain('device_id')
    expect(Object.isFrozen(AGENT_REFUSAL_COLUMNS)).toBe(true)
    const token = await currentKey()
    const spy = vi.spyOn(db.pool, 'query')
    try {
      expect((await call('GET', '/api/agent/v1/refusals?limit=3', { token })).status).toBe(200)
      const statements = spy.mock.calls.map(([text]) => String(text?.text ?? text).replace(/\s+/g, ' ')).filter((text) => text.includes('scan_refusals'))
      expect(statements).toHaveLength(1)
      expect(statements[0]).toMatch(new RegExp(`^select ${AGENT_REFUSAL_COLUMNS.join(', ')} from scan_refusals `))
      expect(statements[0]).not.toContain('*')
      expect(statements[0]).not.toContain('device_id')
    } finally {
      spy.mockRestore()
    }
  })
})

// ======================================================================================================================
// 6. The size of a page, and a column added later
// ======================================================================================================================

describe('GET /api/agent/v1/refusals: the size of a page', () => {
  it('has a default page of DEFAULT_PAGE_SIZE and never more than MAX_REFUSAL_PAGE_SIZE, the committee list\'s own constant, with a cursor to the rest', async () => {
    expect(MAX_REFUSAL_PAGE_SIZE).toBe(200)
    const providerId = randomUUID()
    await db.pool.query(
      `insert into scan_refusals (at, source, code, provider_id, provider_name)
       select '2020-01-01T00:00:00Z'::timestamptz + (n || ' seconds')::interval, 'online', 'unknown_code', $1::uuid, 'Fake Person' from generate_series(1, 205) as n`,
      [providerId],
    )
    const first = await refusals(`provider_id=${providerId}`)
    expect(first.json.refusals).toHaveLength(DEFAULT_PAGE_SIZE)
    expect(first.json.count).toBe(DEFAULT_PAGE_SIZE)
    expect(first.json.next_cursor).not.toBeNull()
    const big = await refusals(`provider_id=${providerId}&limit=1000`)
    expect(big.status).toBe(200) // a larger number is cut, not refused
    expect(big.json.refusals).toHaveLength(MAX_REFUSAL_PAGE_SIZE)
    expect(big.json.count).toBe(MAX_REFUSAL_PAGE_SIZE)
    const rest = await refusals(`provider_id=${providerId}&limit=1000&cursor=${big.json.next_cursor}`)
    expect(rest.json.refusals).toHaveLength(5)
    expect(rest.json.next_cursor).toBeNull()
    expect(new Set([...idsOf(big), ...idsOf(rest)]).size).toBe(205)
    expect(idsOf(await refusals(`provider_id=${providerId}&limit=`))).toEqual(idsOf(first)) // an empty limit is the default, as for scans
    expect(idsOf(big)).toEqual((await dbIds('provider_id = $1', [providerId])).slice(0, MAX_REFUSAL_PAGE_SIZE))
    // The committee's list cuts at the same size, and the documents of the agent API say the same number.
    expect((await committee(`provider_id=${providerId}&limit=1000`)).json.refusals).toHaveLength(MAX_REFUSAL_PAGE_SIZE)
    expect(openApiDocument.paths['/refusals'].get.parameters.find((p) => p.name === 'limit').schema.maximum).toBe(MAX_REFUSAL_PAGE_SIZE)
    expect(schemaDoc.endpoints['GET /api/agent/v1/refusals']).toContain(`at most ${MAX_REFUSAL_PAGE_SIZE}`)
    // A smaller page than the default is honoured.
    expect((await refusals(`provider_id=${providerId}&limit=1`)).json.refusals).toHaveLength(1)
  })

  it('does not let a column added to the table later reach the answer', async () => {
    await db.pool.query("alter table scan_refusals add column fake_secret text default 'fake-secret-marker-9921'")
    const r = await refusals('limit=5')
    expect(r.status).toBe(200)
    expect(r.json.refusals.length).toBeGreaterThan(0)
    expect(r.text).not.toContain('fake_secret')
    expect(r.text).not.toContain('fake-secret-marker-9921')
    for (const refusal of r.json.refusals) expect(Object.keys(refusal)).toEqual(KEYS)
  })
})
