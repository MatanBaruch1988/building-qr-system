// A visit that the server refuses leaves a trace (migration 008, server/scanRefusals.js, ADR 0007 "Visits not counted").
//
// What this file proves:
//   - every permanent code of the sync contract writes one row, from the sync handler and from POST /api/scan, with the
//     provider and the point as they were, and a visit that is sent again is not counted twice;
//   - nothing that a phone sees changes: the answers are compared byte for byte with what they were before the table existed,
//     an accepted visit and a refusal for distance (which is a scan, not a refusal) write nothing, and an old phone's body works;
//   - a failure of the insert is handled as the policy says: the database being down fails the request (so the phone keeps the
//     items and retries), a refusal of the data never breaks the answer and logs one line with no message in it;
//   - the table is append-only (update, delete and truncate are refused, with one setting that nothing sets), it has no
//     foreign key, and the retention job does not touch it;
//   - the committee's list: the filters, the cursor, the limit, the errors, a provider or a point that is deleted later.
// The data is fake.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { recordScan, providerSnapshotName } from '../server/scans.js'
import { recordRefusal, recordRefusedVisit, isDataError } from '../server/scanRefusals.js'
import { runRetention } from '../server/retention.js'
import { DEFAULT_PAGE_SIZE, MAX_REFUSAL_PAGE_SIZE, REFUSAL_PROVIDER_NAME_MAX_LENGTH, REFUSAL_POINT_NAME_MAX_LENGTH } from '../server/config.js'
import {
  SOURCE_ONLINE,
  SOURCE_OFFLINE_SYNC,
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

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOME = { lat: 32.0853, lng: 34.7818 }
const T = '2026-09-01T10:00:00.000Z' // the phone's clock in the items below
const DASH = '–' // the separator of "company - contact" in a snapshot of a provider's name
const COLUMNS = ['at', 'client_time', 'code', 'device_id', 'id', 'point_id', 'point_name', 'provider_id', 'provider_name', 'scan_id', 'source']

let db, cookie
const A = { company: 'Fake Cleaners', contact: 'Fake Person', password: 'fake-pass-a1' }
const B = { company: 'Fake Gardeners', contact: '', password: 'fake-pass-b1' }
const ids = {}

const makePoint = async (extra = {}) =>
  (await call('POST', '/api/admin/points', { cookie, body: { name: 'Fake point ' + randomUUID().slice(0, 6), ...HOME, gps_mode: 'none', ...extra } })).json.point
const makeInactivePoint = async () => {
  const point = await makePoint()
  await call('PATCH', `/api/admin/points/${point.id}`, { cookie, body: { is_active: false } })
  return point
}
const makeProvider = async ({ company, contact, password }) => {
  const provider = (await call('POST', '/api/admin/providers', { cookie, body: { company, contact_name: contact, password } })).json.provider
  const token = (await call('POST', '/api/session', { body: { provider_id: provider.id, password } })).json.token
  const { rows } = await db.pool.query('select id from provider_devices where provider_id = $1', [provider.id])
  return { ...provider, token, deviceId: rows[0].id }
}

const sync = (scans, token = A.token) => call('POST', '/api/scans/sync', { token, body: { scans } })
const scan = (body, token = A.token) => call('POST', '/api/scan', { token, body })
const SEND = { [SOURCE_OFFLINE_SYNC]: (item, token) => sync([item], token), [SOURCE_ONLINE]: (item, token) => scan(item, token) }

/** Every refusal row, oldest first. */
const allRows = async () => (await db.pool.query('select * from scan_refusals order by id')).rows
/** The highest id now: rows written after this call are the ones with a higher id. */
const mark = async () => (await db.pool.query('select coalesce(max(id), 0)::int as n from scan_refusals')).rows[0].n
const rowsAfter = async (m) => (await db.pool.query('select * from scan_refusals where id > $1 order by id', [m])).rows

/** Adds one row the way the code does, with an explicit time when a test needs one. */
async function addRow({ at, scanId = null, source = SOURCE_ONLINE, code = SCAN_ERROR_POINT_INACTIVE, providerId = randomUUID(), providerName = 'Fake Person', pointId = null, pointName = null } = {}) {
  const { rows } = await db.pool.query(
    `insert into scan_refusals (at, scan_id, source, code, provider_id, provider_name, point_id, point_name)
     values (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8) returning id`,
    [at ?? null, scanId, source, code, providerId, providerName, pointId, pointName],
  )
  return Number(rows[0].id)
}

/** The messages that the server answers a refusal with today: a test below pins the whole answer byte for byte. */
const MESSAGES = {
  [SCAN_ERROR_INVALID_SCAN_ID]: [400, 'Invalid id'],
  [SCAN_ERROR_INVALID_CODE]: [400, 'This is not a QR code of this system'],
  [SCAN_ERROR_UNKNOWN_CODE]: [404, 'QR code not found in the system'],
  [SCAN_ERROR_POINT_INACTIVE]: [409, 'This point is not active'],
  [SCAN_ERROR_NOT_ASSIGNED]: [403, 'This point is not assigned to this provider'],
  [SCAN_ERROR_SCAN_ID_CONFLICT]: [409, 'Scan id already used'],
}

/**
 * One refused visit of each kind, made fresh: `item` is what the phone sends, `scanId` the id that the row must keep (null when
 * the phone's id was not a valid one) and `point` the point that the code named (null when it named none).
 */
const REFUSED = {
  [SCAN_ERROR_INVALID_SCAN_ID]: async () => ({ item: { id: 'not-a-uuid', code: ids.open.qr_token, client_time: T }, scanId: null, point: null }),
  [SCAN_ERROR_INVALID_CODE]: async () => {
    const id = randomUUID()
    return { item: { id, code: 'nonsense', client_time: T }, scanId: id, point: null }
  },
  [SCAN_ERROR_UNKNOWN_CODE]: async () => {
    const id = randomUUID()
    return { item: { id, code: QR_TOKEN_PREFIX + randomBytes(10).toString('hex'), client_time: T }, scanId: id, point: null }
  },
  [SCAN_ERROR_POINT_INACTIVE]: async () => {
    const id = randomUUID()
    return { item: { id, code: ids.inactive.qr_token, client_time: T }, scanId: id, point: ids.inactive }
  },
  [SCAN_ERROR_NOT_ASSIGNED]: async () => {
    const id = randomUUID()
    return { item: { id, code: ids.onlyB.qr_token, client_time: T }, scanId: id, point: ids.onlyB }
  },
  [SCAN_ERROR_SCAN_ID_CONFLICT]: async () => {
    // B records a scan under this id (at a point of its own, so that the cooldown cannot turn it into a duplicate), then A sends it.
    const id = randomUUID()
    const point = await makePoint()
    expect((await scan({ id, code: point.qr_token, client_time: T }, B.token)).status).toBe(200)
    return { item: { id, code: point.qr_token, client_time: T }, scanId: id, point: null }
  },
}

// The statement that a patched connection refuses, or null. A connection that was patched stays in the pool, so the patch asks
// this each time: after a test it is null (afterEach below) and the patch lets everything through.
let refusedStatement = null

/** Makes the database refuse the data of a statement of the scan, the way it refuses an out-of-range value (SQLSTATE 22003). */
function databaseRefusesTheItem(statement) {
  refusedStatement = statement
  const realConnect = db.pool.connect.bind(db.pool)
  vi.spyOn(db.pool, 'connect').mockImplementation(async () => {
    const client = await realConnect()
    if (!client.refusalsPatched) {
      const realQuery = client.query.bind(client)
      client.query = (text, ...rest) =>
        refusedStatement && typeof text === 'string' && text.includes(refusedStatement)
          ? Promise.reject(Object.assign(new Error('value out of range'), { code: '22003' }))
          : realQuery(text, ...rest)
      client.refusalsPatched = true
    }
    return client
  })
}

/** Makes every insert into scan_refusals fail as `error` (a failure of the connection, say), and lets everything else through. */
function refusalInsertFails(error) {
  const real = db.pool.query.bind(db.pool)
  return vi.spyOn(db.pool, 'query').mockImplementation((text, params) =>
    typeof text === 'string' && text.includes('insert into scan_refusals') ? Promise.reject(error) : real(text, params),
  )
}

/** Silences and records the console, so that a test can say exactly what was logged. */
function listenToConsole() {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  }
}

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  Object.assign(A, await makeProvider(A))
  Object.assign(B, await makeProvider(B))
  ids.open = await makePoint()
  ids.inactive = await makeInactivePoint()
  ids.onlyB = await makePoint({ provider_ids: [B.id] })
})
afterAll(async () => db?.teardown())
afterEach(() => {
  refusedStatement = null
  vi.restoreAllMocks()
})

describe('every permanent code of the sync contract is recorded', () => {
  it('has a case here for each code of SYNC_PERMANENT_ERROR_CODES (a code that is added needs its case)', () => {
    expect([...Object.keys(REFUSED), SCAN_ERROR_INVALID_ITEM].sort()).toEqual([...SYNC_PERMANENT_ERROR_CODES].sort())
  })

  for (const source of [SOURCE_OFFLINE_SYNC, SOURCE_ONLINE]) {
    describe(`from ${source}`, () => {
      for (const code of Object.keys(REFUSED)) {
        it(`${code}: one row with the code, the source, the provider and the point as they were, the id, the clock and the phone`, async () => {
          const { item, scanId, point } = await REFUSED[code]()
          const m = await mark()
          const log = listenToConsole()
          const res = await SEND[source](item)
          const rows = await rowsAfter(m)

          // The answer is the refusal, as it always was (the next block pins it byte for byte).
          expect(res.status).toBe(source === SOURCE_ONLINE ? MESSAGES[code][0] : 200)
          expect(JSON.stringify(res.json)).toContain(code)

          expect(rows).toHaveLength(1)
          expect(rows[0]).toEqual({
            id: expect.anything(),
            at: expect.any(Date),
            scan_id: scanId,
            source,
            code,
            provider_id: A.id,
            provider_name: `Fake Cleaners ${DASH} Fake Person`,
            device_id: A.deviceId,
            point_id: point?.id ?? null,
            point_name: point?.name ?? null,
            client_time: new Date(T),
          })
          expect(Object.keys(rows[0]).sort()).toEqual(COLUMNS)
          // Nothing is logged when a refusal is recorded.
          for (const method of Object.values(log)) expect(method).not.toHaveBeenCalled()
        })
      }
    })
  }

  it('invalid_item (the database refused the data of an item, sync only) is recorded with the point that the code named', async () => {
    const id = randomUUID()
    const point = await makePoint()
    const m = await mark()
    databaseRefusesTheItem('insert into scans')
    const res = await sync([{ id, code: point.qr_token, client_time: T }])
    vi.restoreAllMocks()
    expect(res.status).toBe(200)
    expect(res.json.results[0]).toEqual({ id, ok: false, error: { code: SCAN_ERROR_INVALID_ITEM, message: 'Item could not be stored' } })
    const rows = await rowsAfter(m)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scan_id: id, source: SOURCE_OFFLINE_SYNC, code: SCAN_ERROR_INVALID_ITEM, provider_id: A.id, device_id: A.deviceId,
      point_id: point.id, point_name: point.name, client_time: new Date(T),
    })
    expect((await db.pool.query('select 1 from scans where id = $1', [id])).rows).toEqual([])
  })

  it('invalid_item with a code that named no point leaves the point empty', async () => {
    const id = randomUUID()
    const m = await mark()
    databaseRefusesTheItem('from points where qr_token')
    const res = await sync([{ id, code: ids.open.qr_token, client_time: T }])
    vi.restoreAllMocks()
    expect(res.json.results[0].error.code).toBe(SCAN_ERROR_INVALID_ITEM)
    const rows = await rowsAfter(m)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code: SCAN_ERROR_INVALID_ITEM, scan_id: id, point_id: null, point_name: null })
  })

  it('online, a database refusal of the data stays what it was (400 invalid_input) and records nothing: it is not a code of the contract', async () => {
    const m = await mark()
    databaseRefusesTheItem('insert into scans')
    const res = await scan({ id: randomUUID(), code: ids.open.qr_token, client_time: T })
    vi.restoreAllMocks()
    expect(res.status).toBe(400)
    expect(res.json).toEqual({ error: { code: 'invalid_input', message: 'A value is out of range or malformed' } })
    expect(await rowsAfter(m)).toEqual([])
  })

  it('a null item (not even an object) is recorded with no id and no clock', async () => {
    const m = await mark()
    const res = await sync([null])
    expect(res.json.results).toEqual([{ ok: false, error: { code: SCAN_ERROR_INVALID_SCAN_ID, message: 'Invalid id' } }])
    const rows = await rowsAfter(m)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ scan_id: null, code: SCAN_ERROR_INVALID_SCAN_ID, point_id: null, client_time: null, provider_id: A.id })
  })

  it('keeps the clock only when it can be believed (the reading of scanLogic): a time it cannot read, or a year outside 2000 to 2100, is empty', async () => {
    const m = await mark()
    const items = [
      { id: randomUUID(), code: 'nonsense', client_time: 'not a time' },
      { id: randomUUID(), code: 'nonsense', client_time: '1999-12-31T23:59:59Z' },
      { id: randomUUID(), code: 'nonsense', client_time: '2101-01-01T00:00:00Z' },
      { id: randomUUID(), code: 'nonsense' },
      { id: randomUUID(), code: 'nonsense', client_time: '2000-01-01T00:00:00Z' },
    ]
    expect((await sync(items)).status).toBe(200)
    const byId = Object.fromEntries((await rowsAfter(m)).map((r) => [r.scan_id, r.client_time]))
    expect(items.map((i) => byId[i.id])).toEqual([null, null, null, null, new Date('2000-01-01T00:00:00Z')])
  })

  it('an upper-case id is kept in the lower case that the database and the scans use', async () => {
    const id = randomUUID()
    const m = await mark()
    await sync([{ id: id.toUpperCase(), code: 'nonsense', client_time: T }])
    expect((await rowsAfter(m))[0].scan_id).toBe(id)
  })

  it('stores nothing beyond the columns of the table: no position, no QR code, no message', async () => {
    const { rows } = await db.pool.query(
      "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'scan_refusals' order by 1",
    )
    expect(rows.map((r) => r.column_name).sort()).toEqual(COLUMNS)
  })
})

describe('a visit that is sent again is not counted twice', () => {
  it('through sync: the same item twice is one row, and the answer is the same both times', async () => {
    const { item } = await REFUSED[SCAN_ERROR_POINT_INACTIVE]()
    const m = await mark()
    const first = await sync([item])
    const again = await sync([item])
    expect(again.text).toBe(first.text)
    expect(await rowsAfter(m)).toHaveLength(1)
  })

  it('online: the same scan twice is one row, and the answer is the same both times', async () => {
    const { item } = await REFUSED[SCAN_ERROR_NOT_ASSIGNED]()
    const m = await mark()
    const first = await scan(item)
    const again = await scan(item)
    expect([again.status, again.text]).toEqual([first.status, first.text])
    expect(await rowsAfter(m)).toHaveLength(1)
  })

  it('refused online and then sent by sync (the answer was lost): still one row, the first one', async () => {
    const { item } = await REFUSED[SCAN_ERROR_POINT_INACTIVE]()
    const m = await mark()
    await scan(item)
    await sync([item])
    const rows = await rowsAfter(m)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe(SOURCE_ONLINE)
  })

  it('one batch with the same id twice is one row', async () => {
    const { item } = await REFUSED[SCAN_ERROR_POINT_INACTIVE]()
    const m = await mark()
    const res = await sync([item, { ...item }])
    expect(res.json.results.map((r) => r.ok)).toEqual([false, false])
    expect(await rowsAfter(m)).toHaveLength(1)
  })

  it('an item with no valid id cannot be told from another one, so each upload of it is a row (the phone drops it after the first answer)', async () => {
    const item = { id: 'not-a-uuid', code: ids.open.qr_token, client_time: T }
    const m = await mark()
    await sync([item])
    await sync([item])
    expect(await rowsAfter(m)).toHaveLength(2)
  })

  it('the unique index covers only rows that have an id: the second insert of an id does nothing, and rows without one are all kept', async () => {
    const m = await mark()
    const row = { source: SOURCE_ONLINE, code: SCAN_ERROR_UNKNOWN_CODE, providerId: randomUUID(), providerName: 'Fake Person' }
    const scanId = randomUUID()
    await recordRefusal({ ...row, scanId })
    await recordRefusal({ ...row, scanId, code: SCAN_ERROR_POINT_INACTIVE })
    await recordRefusal({ ...row, scanId: null })
    await recordRefusal({ ...row, scanId: null })
    const rows = await rowsAfter(m)
    expect(rows.map((r) => [r.scan_id, r.code])).toEqual([[scanId, SCAN_ERROR_UNKNOWN_CODE], [null, SCAN_ERROR_UNKNOWN_CODE], [null, SCAN_ERROR_UNKNOWN_CODE]])
    await expect(
      db.pool.query(
        `insert into scan_refusals (scan_id, source, code, provider_id, provider_name) values ($1, 'online', 'unknown_code', $2, 'Fake Person')`,
        [scanId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('what a phone sees does not change', () => {
  it('the answer to a refusal is byte for byte what it was, from sync and from /scan', async () => {
    for (const code of Object.keys(REFUSED)) {
      const [status, message] = MESSAGES[code]
      const synced = await REFUSED[code]()
      const res = await sync([synced.item])
      expect(res.status, code).toBe(200)
      expect(res.text, `sync, ${code}`).toBe(JSON.stringify({ results: [{ id: synced.item.id, ok: false, error: { code, message } }] }))

      const online = await REFUSED[code]()
      const direct = await scan(online.item)
      expect(direct.status, code).toBe(status)
      expect(direct.text, `/scan, ${code}`).toBe(JSON.stringify({ error: { code, message } }))
    }
  })

  it('the point of the record is on the error and nowhere in what is serialized: not enumerable, not in JSON, not in a spread', async () => {
    const point = ids.inactive
    const input = { id: randomUUID(), code: point.qr_token, clientTime: T }
    const err = await recordScan({ provider: A, deviceId: A.deviceId, input, source: SOURCE_ONLINE }).catch((e) => e)
    expect(err.code).toBe(SCAN_ERROR_POINT_INACTIVE)
    expect(err.refusal).toEqual({ pointId: point.id, pointName: point.name })
    expect(Object.keys(err).sort()).toEqual(['code', 'extra', 'status'])
    expect(JSON.stringify(err)).toBe('{"status":409,"code":"point_inactive"}')
    expect(JSON.stringify({ ...err })).not.toContain(point.name)
    expect(Object.getOwnPropertyDescriptor(err, 'refusal').enumerable).toBe(false)
    // A refusal before the point is known has nothing to attach.
    const unknown = await recordScan({ provider: A, deviceId: A.deviceId, input: { id: randomUUID(), code: QR_TOKEN_PREFIX + randomBytes(10).toString('hex') }, source: SOURCE_ONLINE }).catch((e) => e)
    expect(unknown.code).toBe(SCAN_ERROR_UNKNOWN_CODE)
    expect(unknown.refusal).toBeUndefined()
  })

  it('an accepted visit writes no refusal, and its answer is what it was', async () => {
    const point = await makePoint()
    const id = randomUUID()
    const m = await mark()
    const log = listenToConsole()
    const res = await sync([{ id, code: point.qr_token, client_time: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }])
    expect(res.status).toBe(200)
    expect(Object.keys(res.json)).toEqual(['results'])
    expect(res.json.results).toEqual([{ id, ok: true, duplicate: false, scan: expect.objectContaining({ id, point_id: point.id, source: SOURCE_OFFLINE_SYNC, outcome: 'accepted', provider_id: A.id }) }])
    // The same visit again (a retry) and an equal visit within the cooldown (another id): both are answered as before.
    const again = await sync([{ id, code: point.qr_token, client_time: T }])
    expect(again.json.results[0]).toMatchObject({ id, ok: true, duplicate: false })
    const first = await scan({ id: randomUUID(), code: point.qr_token })
    expect(first.json).toMatchObject({ duplicate: false })
    const cooldown = await scan({ id: randomUUID(), code: point.qr_token })
    expect(cooldown.status).toBe(200)
    expect(cooldown.json).toMatchObject({ duplicate: true })
    expect(await rowsAfter(m)).toEqual([])
    for (const method of Object.values(log)) expect(method).not.toHaveBeenCalled()
  })

  it('a refusal for distance or for a missing position is a scan with an outcome, as before, and writes no refusal', async () => {
    const point = await makePoint({ gps_mode: 'required' })
    const m = await mark()
    const noFix = await sync([{ id: randomUUID(), code: point.qr_token, client_time: T }])
    expect(noFix.json.results[0]).toMatchObject({ ok: true, scan: { outcome: 'rejected_no_location' } })
    const far = await scan({ id: randomUUID(), code: point.qr_token, gps: { lat: HOME.lat + 0.05, lng: HOME.lng, accuracy: 10 } })
    expect(far.status).toBe(200)
    expect(far.json.scan.outcome).toBe('rejected_far')
    expect(await rowsAfter(m)).toEqual([])
  })

  it('an old phone, whose body is only { scans: [{ id, code, client_time, gps }] }, is answered exactly as before', async () => {
    const point = await makePoint()
    const good = { id: randomUUID(), code: point.qr_token, client_time: T, gps: null }
    const refused = { id: randomUUID(), code: ids.inactive.qr_token, client_time: T, gps: null }
    const m = await mark()
    const res = await call('POST', '/api/scans/sync', { token: A.token, body: { scans: [good, refused] } })
    expect(res.status).toBe(200)
    expect(Object.keys(res.json)).toEqual(['results'])
    expect(res.json.results).toHaveLength(2)
    expect(res.json.results[0]).toMatchObject({ id: good.id, ok: true, duplicate: false })
    expect(res.json.results[1]).toEqual({ id: refused.id, ok: false, error: { code: SCAN_ERROR_POINT_INACTIVE, message: 'This point is not active' } })
    expect((await rowsAfter(m)).map((r) => r.scan_id)).toEqual([refused.id])
    // A newer phone may send fields that this server does not know: they are ignored.
    const newer = { id: randomUUID(), code: ids.inactive.qr_token, client_time: T, gps: null, battery: 0.4, app_version: '9.9.9' }
    expect((await sync([newer])).json.results[0].error.code).toBe(SCAN_ERROR_POINT_INACTIVE)
  })
})

describe('when the record cannot be written', () => {
  it('the database being down fails the whole request (500), and the phone, which keeps its items, can send them again', async () => {
    const point = await makePoint()
    const early = { id: randomUUID(), code: point.qr_token, client_time: '2026-09-01T09:00:00Z' }
    const refused = { id: randomUUID(), code: ids.inactive.qr_token, client_time: '2026-09-01T09:30:00Z' }
    const latePoint = await makePoint()
    const late = { id: randomUUID(), code: latePoint.qr_token, client_time: '2026-09-01T10:00:00Z' }
    const m = await mark()
    const log = listenToConsole()
    refusalInsertFails(Object.assign(new Error('Connection terminated unexpectedly: Fake Person'), { code: 'ECONNRESET' }))

    const down = await sync([late, refused, early])
    expect(down.status).toBe(500)
    expect(down.text).toBe('{"error":{"code":"server_error","message":"Something went wrong"}}')
    // The failure is logged by the router as any unhandled one: with the code, never the message of the error.
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(String(log.error.mock.calls[0][0])).toMatch(/^unhandled API error: POST \/api\/scans\/sync Error code=ECONNRESET/)
    expect(String(log.error.mock.calls[0][0])).not.toContain('Fake Person')
    expect(await rowsAfter(m)).toEqual([])
    // The items before the failing one (in the order of the phone's clock) were recorded, and the ones after were not reached.
    expect((await db.pool.query('select 1 from scans where id = $1', [early.id])).rows).toHaveLength(1)
    expect((await db.pool.query('select 1 from scans where id = $1', [late.id])).rows).toHaveLength(0)

    // The phone sends the same batch again: what was recorded replays by id, the refusal is recorded now.
    vi.restoreAllMocks()
    const retry = await sync([late, refused, early])
    expect(retry.status).toBe(200)
    expect(retry.json.results.map((r) => [r.id, r.ok])).toEqual([[early.id, true], [refused.id, false], [late.id, true]])
    const rows = await rowsAfter(m)
    expect(rows.map((r) => r.scan_id)).toEqual([refused.id])
    expect((await db.pool.query('select count(*)::int as n from scans where id = any($1)', [[early.id, late.id]])).rows[0].n).toBe(2)
  })

  it('the database being down fails POST /api/scan too (500, which the phone keeps the visit for), and a failure that is not the data is never swallowed', async () => {
    for (const code of ['ECONNRESET', '57014', '08006']) {
      const m = await mark()
      const log = listenToConsole()
      refusalInsertFails(Object.assign(new Error('boom'), { code }))
      const res = await scan((await REFUSED[SCAN_ERROR_NOT_ASSIGNED]()).item)
      vi.restoreAllMocks()
      expect(res.status, code).toBe(500)
      expect(res.json.error.code).toBe('server_error')
      expect(log.error).toHaveBeenCalledTimes(1)
      expect(await rowsAfter(m)).toEqual([])
    }
  })

  describe('a refusal of the data by the database', () => {
    beforeAll(async () => {
      await db.pool.query(`alter table scan_refusals add constraint test_no_inactive check (code <> 'point_inactive') not valid`)
    })
    afterAll(async () => {
      await db.pool.query('alter table scan_refusals drop constraint test_no_inactive')
    })

    it('never breaks the answer of a sync: the batch is answered as usual, nothing is recorded, and one line says so with the code only', async () => {
      const { item } = await REFUSED[SCAN_ERROR_POINT_INACTIVE]()
      const good = { id: randomUUID(), code: ids.open.qr_token, client_time: T }
      const other = await REFUSED[SCAN_ERROR_NOT_ASSIGNED]()
      const m = await mark()
      const log = listenToConsole()
      const res = await sync([item, good, other.item])
      expect(res.status).toBe(200)
      expect(res.json.results.map((r) => [r.ok, r.error?.code])).toEqual([[false, SCAN_ERROR_POINT_INACTIVE], [true, undefined], [false, SCAN_ERROR_NOT_ASSIGNED]])
      expect(res.json.results[0]).toEqual({ id: item.id, ok: false, error: { code: SCAN_ERROR_POINT_INACTIVE, message: 'This point is not active' } })
      // Only the refusal that the table refused is missing; the next one is recorded.
      expect((await rowsAfter(m)).map((r) => r.code)).toEqual([SCAN_ERROR_NOT_ASSIGNED])
      // One line, the code of the failure (23514, a check constraint): no message, no constraint name, no row, no name.
      expect(log.error.mock.calls).toEqual([['scan refusal not recorded: 23514']])
      expect(log.warn).not.toHaveBeenCalled()
      expect(log.log).not.toHaveBeenCalled()
    })

    it('never breaks the answer of POST /api/scan: the refusal that the person sees is the same', async () => {
      const { item } = await REFUSED[SCAN_ERROR_POINT_INACTIVE]()
      const m = await mark()
      const log = listenToConsole()
      const res = await scan(item)
      expect(res.status).toBe(409)
      expect(res.text).toBe('{"error":{"code":"point_inactive","message":"This point is not active"}}')
      expect(await rowsAfter(m)).toEqual([])
      expect(log.error.mock.calls).toEqual([['scan refusal not recorded: 23514']])
    })
  })

  it('tells a failure of the data from any other: the SQLSTATE class 22 (data) and 23 (constraint), and nothing else', () => {
    for (const code of ['22003', '22P02', '23514', '23505', '23503']) expect(isDataError({ code }), code).toBe(true)
    for (const code of ['57014', '08006', '40001', '53300', 'ECONNRESET', '', undefined, 22003]) expect(isDataError({ code }), String(code)).toBe(false)
    expect(isDataError(null)).toBe(false)
    expect(isDataError(undefined)).toBe(false)
  })

  it('records only the codes that a phone treats as final: any other code is left alone', async () => {
    const m = await mark()
    const provider = { id: randomUUID(), company: 'Fake Co', contact_name: '' }
    await recordRefusedVisit({ code: 'some_future_retryable_code', source: SOURCE_ONLINE, provider, input: { id: randomUUID() } })
    await recordRefusedVisit({ code: 'invalid_input', source: SOURCE_ONLINE, provider, input: { id: randomUUID() } })
    expect(await rowsAfter(m)).toEqual([])
  })
})

describe('the snapshots', () => {
  it('writes the name of the provider as a scan does: the company, a dash and the contact, or the company alone', async () => {
    expect(providerSnapshotName({ company: 'Fake Co', contact_name: 'Fake Person' })).toBe(`Fake Co ${DASH} Fake Person`)
    expect(providerSnapshotName({ company: 'Fake Co', contact_name: '' })).toBe('Fake Co')
    expect(providerSnapshotName({ company: 'Fake Co', contact_name: null })).toBe('Fake Co')
    // The same string that the scan of the same provider carries.
    const point = await makePoint()
    const scanned = await scan({ id: randomUUID(), code: point.qr_token }, B.token)
    expect(scanned.json.scan.provider_name).toBe('Fake Gardeners')
    const { item } = await REFUSED[SCAN_ERROR_NOT_ASSIGNED]()
    const m = await mark()
    await scan(item, A.token)
    const aScan = await scan({ id: randomUUID(), code: point.qr_token }, A.token)
    expect((await rowsAfter(m))[0].provider_name).toBe(aScan.json.scan.provider_name)
  })

  it('cuts a name that is longer than the columns allow, by characters, instead of losing the record', async () => {
    expect(REFUSAL_PROVIDER_NAME_MAX_LENGTH).toBe(243)
    expect(REFUSAL_POINT_NAME_MAX_LENGTH).toBe(120)
    const m = await mark()
    // Two UTF-16 units per character: a cut by units would keep half as many and could split one in two.
    await recordRefusal({
      source: SOURCE_ONLINE,
      code: SCAN_ERROR_POINT_INACTIVE,
      providerId: randomUUID(),
      providerName: '😀'.repeat(400),
      pointId: randomUUID(),
      pointName: '😀'.repeat(400),
    })
    const [row] = await rowsAfter(m)
    expect(Array.from(row.provider_name)).toHaveLength(243)
    expect(Array.from(row.point_name)).toHaveLength(120)
    expect(row.provider_name).toBe('😀'.repeat(243))
  })

  it('records the refusal of a provider whose stored name is longer than the form allows (an imported one can be)', async () => {
    const long = await makeProvider({ company: 'Fake Long Co', contact: 'Fake Person', password: 'fake-pass-long1' })
    await db.pool.query('update providers set company = $2, contact_name = $3 where id = $1', [long.id, 'א'.repeat(500), 'ב'.repeat(500)])
    const m = await mark()
    const res = await sync([(await REFUSED[SCAN_ERROR_POINT_INACTIVE]()).item], long.token)
    expect(res.json.results[0].error.code).toBe(SCAN_ERROR_POINT_INACTIVE)
    const [row] = await rowsAfter(m)
    expect(Array.from(row.provider_name)).toHaveLength(243)
    expect(row.provider_name.startsWith('א'.repeat(200))).toBe(true)
  })

  it('the checks of the table: the code (1 to 40 characters), the names (243 and 120), and the source', async () => {
    const base = { source: SOURCE_ONLINE, code: 'unknown_code', provider_id: randomUUID(), provider_name: 'Fake Person' }
    const insert = (over) => {
      const row = { ...base, ...over }
      return db.pool.query(
        'insert into scan_refusals (source, code, provider_id, provider_name, point_name) values ($1, $2, $3, $4, $5)',
        [row.source, row.code, row.provider_id, row.provider_name, row.point_name ?? null],
      )
    }
    await insert({ code: 'x' })
    await insert({ code: 'x'.repeat(40) })
    await insert({ provider_name: 'x'.repeat(243) })
    await insert({ provider_name: '', point_name: 'x'.repeat(120) })
    for (const over of [{ code: '' }, { code: 'x'.repeat(41) }, { provider_name: 'x'.repeat(244) }, { point_name: 'x'.repeat(121) }, { source: 'phone' }]) {
      await expect(insert(over), JSON.stringify(Object.keys(over))).rejects.toMatchObject({ code: '23514' })
    }
  })
})

describe('the table is append-only', () => {
  const stored = async (id) => (await db.pool.query('select * from scan_refusals where id = $1', [id])).rows
  const flag = async (c, name = 'app.refusal_retention') => (await c.query("select coalesce(current_setting($1, true), '') as v", [name])).rows[0].v

  it('refuses an update of any column, and the row stays as it was', async () => {
    const id = await addRow()
    const before = (await stored(id))[0]
    await expect(db.pool.query("update scan_refusals set code = 'changed' where id = $1", [id])).rejects.toThrow(/scan_refusals is append-only: update is not allowed/)
    await expect(db.pool.query("update scan_refusals set provider_name = 'Someone Else' where id = $1", [id])).rejects.toThrow(/append-only/)
    await expect(db.pool.query("update scan_refusals set point_name = 'x'")).rejects.toThrow(/append-only/)
    expect((await stored(id))[0]).toEqual(before)
  })

  it('refuses a delete, of one row or of all of them, and the row stays', async () => {
    const id = await addRow()
    await expect(db.pool.query('delete from scan_refusals where id = $1', [id])).rejects.toThrow(/scan_refusals is append-only: delete is not allowed/)
    await expect(db.pool.query('delete from scan_refusals')).rejects.toThrow(/append-only/)
    expect(await stored(id)).toHaveLength(1)
  })

  it('refuses a truncate, with and without the retention setting, and the row stays', async () => {
    const id = await addRow()
    await expect(db.pool.query('truncate scan_refusals')).rejects.toThrow(/scan_refusals is append-only: truncate is not allowed/)
    await expect(db.pool.query('truncate scan_refusals restart identity cascade')).rejects.toThrow(/append-only/)
    const c = await db.pool.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.refusal_retention', 'on', true)")
      await expect(c.query('truncate scan_refusals')).rejects.toThrow(/append-only/)
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
    expect(await stored(id)).toHaveLength(1)
  })

  it('lets a delete through only inside a transaction that says so, and the setting does not leak to the next transaction', async () => {
    const [due, kept] = [await addRow(), await addRow()]
    const c = await db.pool.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.refusal_retention', 'on', true)")
      expect(await flag(c)).toBe('on')
      // Inside that transaction an edit and a truncate are still refused (a savepoint keeps the transaction usable).
      await c.query('savepoint a')
      await expect(c.query("update scan_refusals set code = 'changed' where id = $1", [kept])).rejects.toThrow(/append-only/)
      await c.query('rollback to savepoint a')
      await c.query('savepoint b')
      await expect(c.query('truncate scan_refusals')).rejects.toThrow(/append-only/)
      await c.query('rollback to savepoint b')
      expect((await c.query('delete from scan_refusals where id = $1', [due])).rowCount).toBe(1)
      await c.query('commit')

      expect(await stored(due)).toHaveLength(0)
      expect(await stored(kept)).toHaveLength(1)

      // The next transaction on the same connection is refused again: the setting lived and died with the one before.
      expect(await flag(c)).not.toBe('on')
      await expect(c.query('delete from scan_refusals where id = $1', [kept])).rejects.toThrow(/append-only/)
      // Also a transaction that sets it and rolls back leaves nothing behind.
      await c.query('begin')
      await c.query("select set_config('app.refusal_retention', 'on', true)")
      await c.query('rollback')
      expect(await flag(c)).not.toBe('on')
      await expect(c.query('delete from scan_refusals where id = $1', [kept])).rejects.toThrow(/append-only/)
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
    expect(await stored(kept)).toHaveLength(1)
  })

  it('is not opened by anything else: another value, or the setting of the audit log or of the scans, does not count', async () => {
    const id = await addRow()
    const c = await db.pool.connect()
    try {
      for (const [name, value] of [['app.refusal_retention', 'off'], ['app.refusal_retention', 'ON '], ['app.refusal_retention', 'true'], ['app.refusal_retention', '1'], ['app.audit_retention', 'on'], ['app.allow_scan_delete', 'on']]) {
        await c.query('begin')
        await c.query('select set_config($1, $2, true)', [name, value])
        await expect(c.query('delete from scan_refusals where id = $1', [id]), `${name} = ${value}`).rejects.toThrow(/append-only/)
        await c.query('rollback')
      }
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
    expect(await stored(id)).toHaveLength(1)
  })

  it('has both triggers on the table, and no code of the project sets the setting (it needs a legal decision and a rules change first)', async () => {
    const { rows } = await db.pool.query(
      `select tgname from pg_trigger where tgrelid = 'scan_refusals'::regclass and not tgisinternal order by tgname`,
    )
    expect(rows.map((r) => r.tgname)).toEqual(['scan_refusals_guard_trg', 'scan_refusals_no_truncate'])

    const setters = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|jsx|mjs)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('refusal_retention')) setters.push(path.relative(ROOT, full))
      }
    }
    for (const dir of ['api', 'server', 'shared', 'src', 'scripts']) walk(path.join(ROOT, dir))
    expect(setters, 'code that mentions app.refusal_retention').toEqual([])
  })
})

describe('what the table is, in the database', () => {
  it('has no foreign key in or out, so deleting a provider, a phone or a point never reaches it', async () => {
    const { rows } = await db.pool.query(
      `select conname from pg_constraint
        where contype = 'f' and (conrelid = 'scan_refusals'::regclass or confrelid = 'scan_refusals'::regclass)`,
    )
    expect(rows).toEqual([])
  })

  it('has the indexes of the committee list', async () => {
    const { rows } = await db.pool.query(
      "select indexname, indexdef from pg_indexes where schemaname = current_schema() and tablename = 'scan_refusals' order by indexname",
    )
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]))
    expect(Object.keys(byName).sort()).toEqual(['scan_refusals_at_idx', 'scan_refusals_pkey', 'scan_refusals_point_idx', 'scan_refusals_provider_idx', 'scan_refusals_scan_id_key'])
    expect(byName.scan_refusals_at_idx).toMatch(/\(at DESC, id DESC\)$/)
    expect(byName.scan_refusals_provider_idx).toMatch(/\(provider_id, at DESC\)$/)
    expect(byName.scan_refusals_point_idx).toMatch(/\(point_id, at DESC\)$/)
    expect(byName.scan_refusals_scan_id_key).toMatch(/^CREATE UNIQUE INDEX .*\(scan_id\) WHERE \(scan_id IS NOT NULL\)$/)
  })

  it('keeps the time to the millisecond, like scans.checked_in_at, so that the cursor of the list (built in JavaScript) is exact', async () => {
    const id = await addRow({ at: '2026-01-02T03:04:05.123456Z' })
    const { rows } = await db.pool.query("select to_char(at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') as t from scan_refusals where id = $1", [id])
    expect(rows[0].t).toBe('2026-01-02T03:04:05.123000')
  })
})

describe('the retention job', () => {
  it('never touches a refused visit, however old', async () => {
    await addRow({ at: '2020-01-02T03:04:05Z' })
    await addRow({ at: new Date(Date.now() - 400 * 86_400_000).toISOString() })
    const before = await allRows()
    await runRetention()
    expect(await allRows()).toEqual(before)
  })
})

describe('GET /api/admin/scan-refusals', () => {
  const list = (qs = '', as = cookie) => call('GET', `/api/admin/scan-refusals${qs ? '?' + qs : ''}`, { cookie: as })
  const idsOf = (res) => res.json.refusals.map((r) => r.id)

  it('needs a committee session: nobody, a provider and a bad cookie are refused', async () => {
    expect((await call('GET', '/api/admin/scan-refusals')).json.error.code).toBe('admin_required')
    expect((await call('GET', '/api/admin/scan-refusals', { token: A.token })).status).toBe(401)
    expect((await list('', 'qr_admin=%')).status).toBe(401)
  })

  it('answers { refusals, next_cursor } with the fields of a refusal and no more, ISO times, newest first', async () => {
    const providerId = randomUUID()
    const pointId = randomUUID()
    const scanId = randomUUID()
    await db.pool.query(
      `insert into scan_refusals (at, scan_id, source, code, provider_id, provider_name, device_id, point_id, point_name, client_time)
       values ('2026-05-01T08:00:00.250Z', $1, 'offline_sync', 'not_assigned', $2, 'Fake Co - Fake Person', $3, $4, 'Fake point', '2026-05-01T07:59:00Z')`,
      [scanId, providerId, randomUUID(), pointId],
    )
    const id = (await db.pool.query('select id from scan_refusals where scan_id = $1', [scanId])).rows[0].id
    await addRow({ at: '2026-05-01T09:00:00Z', providerId })
    const res = await list(`provider_id=${providerId}`)
    expect(res.status).toBe(200)
    expect(Object.keys(res.json)).toEqual(['refusals', 'next_cursor'])
    expect(res.json.next_cursor).toBeNull()
    expect(res.json.refusals).toHaveLength(2)
    expect(res.json.refusals[0].at).toBe('2026-05-01T09:00:00.000Z')
    expect(res.json.refusals[1]).toEqual({
      id: Number(id),
      at: '2026-05-01T08:00:00.250Z',
      scan_id: scanId,
      source: 'offline_sync',
      code: 'not_assigned',
      provider_id: providerId,
      provider_name: 'Fake Co - Fake Person',
      point_id: pointId,
      point_name: 'Fake point',
      client_time: '2026-05-01T07:59:00.000Z',
    })
    expect(typeof res.json.refusals[1].id).toBe('number')
    expect(res.json.refusals[0]).toMatchObject({ client_time: null, point_id: null, point_name: null, scan_id: null })
  })

  it('filters by provider and by point', async () => {
    const [p1, p2, q1, q2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const rows = [
      await addRow({ providerId: p1, pointId: q1 }),
      await addRow({ providerId: p1, pointId: q2 }),
      await addRow({ providerId: p2, pointId: q1 }),
      await addRow({ providerId: p2 }),
    ]
    expect(idsOf(await list(`provider_id=${p1}`))).toEqual([rows[1], rows[0]])
    expect(idsOf(await list(`point_id=${q1}`))).toEqual([rows[2], rows[0]])
    expect(idsOf(await list(`provider_id=${p2}&point_id=${q1}`))).toEqual([rows[2]])
    expect(idsOf(await list(`provider_id=${p1.toUpperCase()}`))).toEqual([rows[1], rows[0]]) // an id in capitals is the same id
    expect(idsOf(await list(`provider_id=${randomUUID()}`))).toEqual([])
  })

  it('filters by building day (in the building\'s time zone, both days included) and by ISO time, also across the change to summer time', async () => {
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
    const filter = (qs) => list(`provider_id=${providerId}&${qs}`)
    expect(idsOf(await filter('from=2026-03-27&to=2026-03-27')).sort()).toEqual([row.startOf27, row.endOf27].sort())
    expect(idsOf(await filter('from=2026-03-27'))).toEqual([row.startOf28, row.endOf27, row.startOf27])
    expect(idsOf(await filter('to=2026-03-26'))).toEqual([row.endOf26])
    expect(idsOf(await filter('to=2026-03-27'))).toEqual([row.endOf27, row.startOf27, row.endOf26])
    expect(idsOf(await filter('from=2026-03-28'))).toEqual([row.startOf28])
    expect(idsOf(await filter('from=2026-03-28&to=2026-03-26'))).toEqual([])
    // An ISO time says which moment it means: both ends included.
    expect(idsOf(await filter('from=2026-03-26T22:00:00Z'))).toEqual([row.startOf28, row.endOf27, row.startOf27])
    expect(idsOf(await filter('to=2026-03-26T22:00:00Z'))).toEqual([row.startOf27, row.endOf26])
    expect(idsOf(await filter('from=2026-03-27T00:00:00%2B02:00&to=2026-03-27T23:59:59%2B03:00'))).toEqual([row.endOf27, row.startOf27])
  })

  it('pages with a cursor on (at, id): every row once, in order, also for rows with the same time and for a time that has a fraction of a millisecond', async () => {
    const providerId = randomUUID()
    const same = '2026-06-01T12:00:00.500Z'
    await addRow({ at: '2026-06-01T12:00:00.123456Z', providerId })
    await addRow({ at: same, providerId })
    await addRow({ at: same, providerId })
    await addRow({ at: same, providerId })
    await addRow({ at: '2026-06-01T12:00:00.123999Z', providerId })
    await addRow({ at: '2026-06-01T11:59:59.999Z', providerId })
    await addRow({ at: '2026-06-01T12:00:01Z', providerId })
    const expected = (await db.pool.query('select id from scan_refusals where provider_id = $1 order by at desc, id desc', [providerId])).rows.map((r) => Number(r.id))
    expect(expected).toHaveLength(7)

    for (const size of [1, 2, 3, 7, 8]) {
      const seen = []
      let cursor = null
      let pages = 0
      do {
        const res = await list(`provider_id=${providerId}&limit=${size}${cursor ? `&cursor=${cursor}` : ''}`)
        expect(res.status).toBe(200)
        expect(res.json.refusals.length).toBeLessThanOrEqual(size)
        seen.push(...idsOf(res))
        cursor = res.json.next_cursor
        pages++
      } while (cursor && pages < 20)
      expect(seen, `pages of ${size}`).toEqual(expected)
      expect(pages, `pages of ${size}`).toBe(Math.ceil(7 / size))
    }
  })

  it('has a default page of DEFAULT_PAGE_SIZE and never more than MAX_REFUSAL_PAGE_SIZE (200)', async () => {
    expect(MAX_REFUSAL_PAGE_SIZE).toBe(200)
    const providerId = randomUUID()
    await db.pool.query(
      `insert into scan_refusals (source, code, provider_id, provider_name)
       select 'online', 'unknown_code', $1::uuid, 'Fake Person' from generate_series(1, 205)`,
      [providerId],
    )
    const first = await list(`provider_id=${providerId}`)
    expect(first.json.refusals).toHaveLength(DEFAULT_PAGE_SIZE)
    expect(first.json.next_cursor).not.toBeNull()
    const big = await list(`provider_id=${providerId}&limit=1000`)
    expect(big.json.refusals).toHaveLength(200)
    const rest = await list(`provider_id=${providerId}&limit=1000&cursor=${big.json.next_cursor}`)
    expect(rest.json.refusals).toHaveLength(5)
    expect(rest.json.next_cursor).toBeNull()
    expect(new Set([...idsOf(big), ...idsOf(rest)]).size).toBe(205)
    expect((await list(`provider_id=${providerId}&limit=`)).json.refusals).toHaveLength(DEFAULT_PAGE_SIZE) // an empty limit is the default, as for scans
  })

  it('refuses bad values with the same status and the same codes as the scans list', async () => {
    const queries = ['from=yesterday', 'to=2026-02-30', 'from=2026-13-01', 'point_id=x', 'provider_id=x', 'limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'cursor=garbage', `cursor=${Buffer.from('{"t":"nope","id":1}').toString('base64url')}`]
    for (const qs of queries) {
      const scans = await call('GET', `/api/admin/scans?${qs}`, { cookie })
      const refusals = await list(qs)
      expect(scans.status, qs).toBe(400)
      expect([refusals.status, refusals.json.error.code, refusals.json.error.field], qs).toEqual([scans.status, scans.json.error.code, scans.json.error.field])
    }
    // The ids of a cursor are numbers here: a uuid, a fraction and zero are not ids of a row.
    for (const id of ['"abc"', '1.5', '0', '-4', 'null']) {
      const res = await list(`cursor=${Buffer.from(`{"t":"2026-01-01T00:00:00.000Z","id":${id}}`).toString('base64url')}`)
      expect([res.status, res.json.error.code], id).toEqual([400, 'invalid_cursor'])
    }
  })

  it('keeps a refusal after the provider is deleted, with the name as it was', async () => {
    const gone = await makeProvider({ company: 'Fake Temp Co', contact: '', password: 'fake-pass-gone1' })
    const { item } = await REFUSED[SCAN_ERROR_POINT_INACTIVE]()
    expect((await sync([item], gone.token)).json.results[0].error.code).toBe(SCAN_ERROR_POINT_INACTIVE)
    expect((await call('DELETE', `/api/admin/providers/${gone.id}`, { cookie })).status).toBe(200)
    expect((await db.pool.query('select 1 from providers where id = $1', [gone.id])).rows).toEqual([])
    expect((await db.pool.query('select 1 from provider_devices where id = $1', [gone.deviceId])).rows).toEqual([])

    const res = await list(`provider_id=${gone.id}`)
    expect(res.json.refusals).toHaveLength(1)
    expect(res.json.refusals[0]).toMatchObject({ provider_id: gone.id, provider_name: 'Fake Temp Co', scan_id: item.id, code: SCAN_ERROR_POINT_INACTIVE })
  })

  it('keeps a refusal after the refused point is deleted, with the name and the id as they were', async () => {
    const doomed = await makeInactivePoint()
    const id = randomUUID()
    expect((await sync([{ id, code: doomed.qr_token, client_time: T }])).json.results[0].error.code).toBe(SCAN_ERROR_POINT_INACTIVE)
    expect((await call('DELETE', `/api/admin/points/${doomed.id}`, { cookie })).status).toBe(200)
    expect((await db.pool.query('select 1 from points where id = $1', [doomed.id])).rows).toEqual([])

    const res = await list(`point_id=${doomed.id}`)
    expect(res.json.refusals).toHaveLength(1)
    expect(res.json.refusals[0]).toMatchObject({ point_id: doomed.id, point_name: doomed.name, scan_id: id, provider_id: A.id })
    // The code of the deleted point now names no point, so the same visit is an unknown code from here on (and a new row).
    const after = await sync([{ id: randomUUID(), code: doomed.qr_token, client_time: T }])
    expect(after.json.results[0].error.code).toBe(SCAN_ERROR_UNKNOWN_CODE)
  })
})
