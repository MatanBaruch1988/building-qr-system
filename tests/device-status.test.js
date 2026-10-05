// What a phone reports about itself, and what the committee reads of it (ADR 0007, decision 4, "Phone health"; migration 010,
// server/deviceStatus.js, server/routes/devices.js).
//
// What this file proves:
//   - POST /api/my/device-status stores a full report on the phone that is signed in, ignores each field that is not valid (and
//     keeps the valid ones), takes an empty body and unknown fields, and always answers `{ ok: true, build }`;
//   - the throttle is one statement (a `where`, no read before the write), so a second report within DEVICE_STATUS_MIN_INTERVAL_S
//     changes nothing, also when two arrive together, and one after that period is stored;
//   - the totals add up, are cut to DEVICE_STATUS_MAX_COUNT per report, and never overflow the column; `oldest_waiting_at` is kept
//     only inside its window;
//   - nobody can update another phone: the row comes from the token, never from the body; a revoked phone is refused by the guard;
//   - the sync stamps `last_sync_at` for a phone of any version, a failure of that stamp changes nothing that the phone is told, and
//     the answer of POST /api/scans/sync is byte for byte what it was;
//   - the committee's list shows the active phones only, never the label or the token hash, and `outdated` follows the server's build.
// The data is fake. The retention of the status is proved in tests/retention.test.js.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { getPool, setPool } from '../server/db.js'
import { sha256 } from '../server/crypto.js'
import { scanJson } from '../server/scans.js'
import { parseDeviceStatusReport, reportDeviceStatus } from '../server/deviceStatus.js'
import {
  APP_BUILD_RE,
  SYNC_QUEUE_MAX_ITEMS,
  DEVICE_STATUS_MIN_INTERVAL_S,
  DEVICE_STATUS_MAX_COUNT,
  DEVICE_STATUS_MAX_AGE_DAYS,
  SCAN_ERROR_POINT_INACTIVE,
} from '../shared/contract.js'

const HOME = { lat: 32.0853, lng: 34.7818 }
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const INTEGER_MAX = 2147483647
const SHA = 'abcdef1234567890abcdef1234567890abcdef12' // a commit: the server's build is its first 7 characters
const BUILD = 'abcdef1'

let db, cookie
const ids = {}

const agoIso = (ms) => new Date(Date.now() - ms).toISOString()
const aheadIso = (ms) => new Date(Date.now() + ms).toISOString()

const makePoint = async (extra = {}) =>
  (await call('POST', '/api/admin/points', { cookie, body: { name: 'Fake point ' + randomUUID().slice(0, 6), ...HOME, gps_mode: 'none', ...extra } })).json.point
const makeProvider = async (company) => {
  const password = 'fake-pass-' + randomUUID().slice(0, 6)
  const provider = (await call('POST', '/api/admin/providers', { cookie, body: { company, contact_name: 'Fake Person', password } })).json.provider
  return { ...provider, password }
}
/** Signs the provider in on a new phone, with the label that the app would send, and returns its token and the id of its row. */
const signIn = async (provider, label = '') => {
  const res = await call('POST', '/api/session', { body: { provider_id: provider.id, password: provider.password, device_label: label } })
  expect(res.status).toBe(200)
  const { rows } = await db.pool.query('select id from provider_devices where token_hash = $1', [sha256(res.json.token)])
  return { token: res.json.token, deviceId: rows[0].id }
}

const report = (body, token) => call('POST', '/api/my/device-status', { token, body })
const sync = (scans, token) => call('POST', '/api/scans/sync', { token, body: { scans } })

/** The whole row of a phone, as JSON: two of these are equal exactly when nothing in the row changed. */
const wholeRow = async (deviceId) => (await db.pool.query('select to_jsonb(d) as row from provider_devices d where id = $1', [deviceId])).rows[0].row
/** A row of wholeRow() without `last_seen_at`: the guard touches it when it is over 5 minutes old, so it can move during a request that passes the guard. */
const steady = (row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'last_seen_at'))
/** The reported columns of a phone, as the database holds them. */
const reported = async (deviceId) =>
  (
    await db.pool.query(
      `select app_build, status_at, waiting_count, oldest_waiting_at, not_accepted_total, overflow_total, last_sync_at
         from provider_devices where id = $1`,
      [deviceId],
    )
  ).rows[0]
const dbNow = async () => (await db.pool.query('select now() as t')).rows[0].t
const NOTHING = { app_build: null, status_at: null, waiting_count: null, oldest_waiting_at: null, not_accepted_total: 0, overflow_total: 0, last_sync_at: null }

/** Puts the reported columns back to what a phone that never reported has (the label and the rest stay). */
const blank = (deviceId) =>
  db.pool.query(
    `update provider_devices set app_build = null, status_at = null, waiting_count = null, oldest_waiting_at = null,
            not_accepted_total = 0, overflow_total = 0, last_sync_at = null where id = $1`,
    [deviceId],
  )
/** Makes the last report of a phone `seconds` old, so that the next one is (or is not) past the throttle. */
const reportedAgo = (deviceId, seconds) =>
  db.pool.query('update provider_devices set status_at = now() - make_interval(secs => $2) where id = $1', [deviceId, seconds])

/** Runs `fn` with a pool that writes down every statement that is asked of it (a connection for a transaction counts too). */
async function withStatements(fn) {
  const real = getPool()
  const seen = []
  const note = (text) => seen.push(String(typeof text === 'string' ? text : text?.text).replace(/\s+/g, ' ').trim())
  setPool({
    query: (text, params) => (note(text), real.query(text, params)),
    connect: async () => {
      note('(a connection for a transaction)')
      const client = await real.connect()
      return { query: (text, params) => (note(text), client.query(text, params)), release: (err) => client.release(err) }
    },
  })
  try {
    return { result: await fn(), statements: seen }
  } finally {
    setPool(real)
  }
}

/** Makes the statement that stamps `last_sync_at` fail as `error`, and lets everything else through (a read of the column included). */
function lastSyncUpdateFails(error) {
  const real = db.pool.query.bind(db.pool)
  return vi.spyOn(db.pool, 'query').mockImplementation((text, params) =>
    typeof text === 'string' && text.startsWith('update provider_devices set last_sync_at') ? Promise.reject(error) : real(text, params),
  )
}

const listenToConsole = () => ({
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
})

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  ids.a = await makeProvider('Fake Cleaners')
  ids.b = await makeProvider('Fake Gardeners')
  Object.assign(ids.a, await signIn(ids.a, 'Fake Browser A'))
  Object.assign(ids.b, await signIn(ids.b, 'Fake Browser B'))
  ids.point = await makePoint()
  ids.inactive = await makePoint()
  await call('PATCH', `/api/admin/points/${ids.inactive.id}`, { cookie, body: { is_active: false } })
})
afterAll(async () => db?.teardown())
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ======================================================================================================================
// 1. How a report is read (the pure part: no database)
// ======================================================================================================================

describe('parseDeviceStatusReport', () => {
  const NOW = Date.parse('2026-10-05T12:00:00.000Z')
  const parse = (body) => parseDeviceStatusReport(body, NOW)
  const NO_REPORT = { build: null, waiting: null, oldest: undefined, notAccepted: 0, overflowed: 0 }

  it('reads a full report', () => {
    const oldest = '2026-10-05T09:30:00.000Z'
    expect(parse({ build: BUILD, waiting: 7, oldest_waiting_at: oldest, not_accepted: 2, overflowed: 3 })).toEqual({
      build: BUILD,
      waiting: 7,
      oldest: new Date(oldest),
      notAccepted: 2,
      overflowed: 3,
    })
  })

  it('reads nothing from a body that is not an object, and never throws', () => {
    for (const body of [undefined, null, 'text', 42, true, [], [{ build: BUILD }], () => ({}), Symbol('x')]) {
      expect(parse(body), String(typeof body)).toEqual(NO_REPORT)
    }
  })

  it('takes the build only when it has the shape of a build id (the shape of the contract, as a text)', () => {
    for (const build of [BUILD, '0123456', 'dev']) expect(parse({ build }).build, build).toBe(build)
    for (const build of ['abcdef', 'abcdef12', 'ABCDEF1', 'ghijklm', '', ' abcdef1', 'abcdef1\n', 'dev ', 'DEV', 'development', 7, null, true, [BUILD], { build: BUILD }]) {
      expect(parse({ build }).build, JSON.stringify(build)).toBeNull()
      expect(APP_BUILD_RE.test(String(build)) && typeof build === 'string', JSON.stringify(build)).toBe(false)
    }
  })

  it('takes `waiting` only as a whole number from 0 to SYNC_QUEUE_MAX_ITEMS', () => {
    for (const waiting of [0, 1, 250, SYNC_QUEUE_MAX_ITEMS]) expect(parse({ waiting }).waiting, String(waiting)).toBe(waiting)
    for (const waiting of [-1, SYNC_QUEUE_MAX_ITEMS + 1, 1e9, 1.5, 0.1, '7', '', null, true, [], [3], {}, undefined]) {
      expect(parse({ waiting }).waiting, JSON.stringify(waiting)).toBeNull()
    }
  })

  it('keeps `oldest_waiting_at` only inside its window: a real ISO time, not older than 60 days, not more than 5 minutes ahead', () => {
    const inside = [
      new Date(NOW - 2 * HOUR).toISOString(),
      new Date(NOW - (DEVICE_STATUS_MAX_AGE_DAYS * DAY - HOUR)).toISOString(), // just inside the age limit
      new Date(NOW + 4 * 60 * 1000).toISOString(), // a phone clock a little ahead
      '2026-10-05T14:00:00+02:00', // the same moment as 12:00 UTC, with an offset
      '2026-10-05T11:00Z', // no seconds
    ]
    for (const value of inside) expect(parse({ oldest_waiting_at: value }).oldest, value).toEqual(new Date(value))
    expect(parse({ oldest_waiting_at: '2026-10-05T14:00:00+02:00' }).oldest.toISOString()).toBe('2026-10-05T12:00:00.000Z')

    const outside = [
      new Date(NOW - (DEVICE_STATUS_MAX_AGE_DAYS * DAY + HOUR)).toISOString(), // too old
      new Date(NOW + 6 * 60 * 1000).toISOString(), // too far ahead
      '1970-01-01T00:00:00.000Z',
      '9999-12-31T23:59:59.999Z',
    ]
    for (const value of outside) expect(parse({ oldest_waiting_at: value }).oldest, value).toBeNull()
  })

  it('is not fooled by something that `new Date()` would still turn into a date', () => {
    for (const value of ['2026-10-05', '2026', '1', 'Oct 5 2026 10:00 UTC', '2026-10-05 10:00:00Z', '2026-10-05T10:00:00', '2026-10-05T10:00', 'not a date', '', ' ', '2026-13-45T10:00:00Z', 1788600000000, true, [], {}, ['2026-10-05T10:00:00Z']]) {
      expect(parse({ oldest_waiting_at: value }).oldest, JSON.stringify(value)).toBeNull()
    }
  })

  it('tells "not sent" (the column keeps its value) from "sent and not believable" (null), and a queue that is empty has no oldest', () => {
    expect(parse({}).oldest).toBeUndefined()
    expect(parse({ waiting: 5 }).oldest).toBeUndefined()
    expect(parse({ oldest_waiting_at: null }).oldest).toBeNull()
    expect(parse({ waiting: 0 }).oldest).toBeNull()
    expect(parse({ waiting: 0, oldest_waiting_at: new Date(NOW - HOUR).toISOString() }).oldest).toBeNull()
    expect(parse({ waiting: 3, oldest_waiting_at: new Date(NOW - HOUR).toISOString() }).oldest).toEqual(new Date(NOW - HOUR))
    // An invalid `waiting` is ignored, so it says nothing about the queue being empty.
    expect(parse({ waiting: -1 }).oldest).toBeUndefined()
  })

  it('cuts a count to 0..DEVICE_STATUS_MAX_COUNT and counts anything that is not a whole number as 0', () => {
    for (const [sent, kept] of [[0, 0], [1, 1], [999, 999], [DEVICE_STATUS_MAX_COUNT, DEVICE_STATUS_MAX_COUNT], [DEVICE_STATUS_MAX_COUNT + 1, DEVICE_STATUS_MAX_COUNT], [5000, DEVICE_STATUS_MAX_COUNT], [1e30, DEVICE_STATUS_MAX_COUNT], [-1, 0], [-5000, 0]]) {
      expect(parse({ not_accepted: sent }).notAccepted, String(sent)).toBe(kept)
      expect(parse({ overflowed: sent }).overflowed, String(sent)).toBe(kept)
    }
    for (const sent of [1.5, 0.5, '3', '', null, true, [], [2], {}, undefined]) {
      expect(parse({ not_accepted: sent }).notAccepted, JSON.stringify(sent)).toBe(0)
      expect(parse({ overflowed: sent }).overflowed, JSON.stringify(sent)).toBe(0)
    }
  })

  it('reads only the five fields: unknown fields, and a prototype that the body brings, change nothing', () => {
    const body = JSON.parse('{"build":"abcdef1","foo":1,"id":"x","__proto__":{"waiting":9},"constructor":{"waiting":9}}')
    expect(parse(body)).toEqual({ ...NO_REPORT, build: BUILD })
  })
})

// ======================================================================================================================
// 2. POST /api/my/device-status
// ======================================================================================================================

describe('POST /api/my/device-status', () => {
  it('stores a full report on the phone that sent it', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    await blank(ids.a.deviceId)
    const labelBefore = (await wholeRow(ids.a.deviceId)).label
    const oldest = agoIso(3 * HOUR)

    const res = await report({ build: BUILD, waiting: 7, oldest_waiting_at: oldest, not_accepted: 2, overflowed: 3 }, ids.a.token)
    expect(res.status).toBe(200)
    expect(res.text).toBe(JSON.stringify({ ok: true, build: BUILD }))

    const row = await reported(ids.a.deviceId)
    expect(row).toEqual({
      app_build: BUILD,
      status_at: expect.any(Date),
      waiting_count: 7,
      oldest_waiting_at: new Date(oldest),
      not_accepted_total: 2,
      overflow_total: 3,
      last_sync_at: null, // the sync writes that one, never a report
    })
    expect(Math.abs((await dbNow()).getTime() - row.status_at.getTime())).toBeLessThan(60_000)
    expect((await wholeRow(ids.a.deviceId)).label).toBe(labelBefore)
  })

  it('answers the same whatever it was sent: ok, and the server build (null when the server has none)', { timeout: 120_000 }, async () => {
    await blank(ids.a.deviceId)
    const bodies = [
      { build: BUILD, waiting: 1, oldest_waiting_at: agoIso(HOUR), not_accepted: 1, overflowed: 1 },
      {},
      { build: 'nonsense', waiting: -3, oldest_waiting_at: 'x', not_accepted: 'y', overflowed: null },
      { future: 'field' },
    ]
    for (const [sha, build] of [[SHA, BUILD], [undefined, null], ['', null]]) {
      vi.stubEnv('VERCEL_GIT_COMMIT_SHA', sha)
      for (const body of bodies) {
        await reportedAgo(ids.a.deviceId, 60) // past the throttle, so that every body is really stored
        const res = await report(body, ids.a.token)
        expect(res.status).toBe(200)
        expect(res.text, JSON.stringify(body)).toBe(JSON.stringify({ ok: true, build }))
      }
      // A report that is throttled is answered the same way.
      const throttled = await report({ waiting: 2 }, ids.a.token)
      expect(throttled.text).toBe(JSON.stringify({ ok: true, build }))
    }
  })

  describe('a field that is not valid is ignored (never a 400), and the valid ones are kept', () => {
    // [field, a value that is not valid, what the column holds then (the three other fields are valid)]
    const GOOD = { build: BUILD, waiting: 4, oldest_waiting_at: null, not_accepted: 1, overflowed: 1 }
    const EXPECTED_GOOD = { app_build: BUILD, waiting_count: 4, oldest_waiting_at: null, not_accepted_total: 1, overflow_total: 1 }
    const CASES = [
      ['build', 'not a build', { app_build: null }],
      ['build', 12, { app_build: null }],
      ['waiting', SYNC_QUEUE_MAX_ITEMS + 1, { waiting_count: null }],
      ['waiting', -1, { waiting_count: null }],
      ['waiting', '4', { waiting_count: null }],
      ['oldest_waiting_at', 'yesterday', { oldest_waiting_at: null }],
      ['oldest_waiting_at', agoIso((DEVICE_STATUS_MAX_AGE_DAYS + 1) * DAY), { oldest_waiting_at: null }],
      ['not_accepted', 'many', { not_accepted_total: 0 }],
      ['not_accepted', 2.5, { not_accepted_total: 0 }],
      ['overflowed', null, { overflow_total: 0 }],
      ['overflowed', {}, { overflow_total: 0 }],
    ]
    for (const [field, bad, instead] of CASES) {
      it(`${field} = ${JSON.stringify(bad)}`, async () => {
        const good = { ...GOOD, oldest_waiting_at: agoIso(2 * HOUR) }
        const kept = { ...EXPECTED_GOOD, oldest_waiting_at: new Date(good.oldest_waiting_at) }
        await blank(ids.a.deviceId)
        const res = await report({ ...good, [field]: bad }, ids.a.token)
        expect(res.status).toBe(200)
        expect(res.json.ok).toBe(true)
        expect(await reported(ids.a.deviceId)).toEqual({ ...NOTHING, ...kept, ...instead, status_at: expect.any(Date) })
      })
    }

    it('every field at once', async () => {
      await blank(ids.a.deviceId)
      const res = await report({ build: [], waiting: 'x', oldest_waiting_at: 5, not_accepted: -1, overflowed: '1' }, ids.a.token)
      expect(res.status).toBe(200)
      expect(res.json.ok).toBe(true)
      expect(await reported(ids.a.deviceId)).toEqual({ ...NOTHING, status_at: expect.any(Date), oldest_waiting_at: null })
    })

    it('does not change the value that the column already has when its field is not valid (it is only not taken)', async () => {
      await blank(ids.a.deviceId)
      expect((await report({ build: BUILD, waiting: 9, oldest_waiting_at: agoIso(HOUR) }, ids.a.token)).status).toBe(200)
      const first = await reported(ids.a.deviceId)
      await reportedAgo(ids.a.deviceId, 60)
      expect((await report({ build: 'nope', waiting: 'nope' }, ids.a.token)).status).toBe(200)
      const second = await reported(ids.a.deviceId)
      expect(second).toEqual({ ...first, status_at: expect.any(Date) })
      expect(second.status_at.getTime()).toBeGreaterThan(first.status_at.getTime())
    })
  })

  it('takes an empty body, no body, and a body that is not an object: it stores that the phone reported, and nothing else', { timeout: 120_000 }, async () => {
    for (const body of [{}, undefined, null, [], 'text', 42]) {
      await blank(ids.a.deviceId)
      const res = await report(body, ids.a.token)
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(res.json.ok).toBe(true)
      expect(await reported(ids.a.deviceId), JSON.stringify(body)).toEqual({ ...NOTHING, status_at: expect.any(Date) })
    }
  })

  it('ignores a field that it does not know, and never lets the body reach a column that is not a report', async () => {
    await blank(ids.a.deviceId)
    const before = await wholeRow(ids.a.deviceId)
    const body = {
      build: BUILD,
      waiting: 2,
      // Fields of a newer phone, and fields that name columns or rows that a report must never change.
      battery: 0.4,
      app_version: '9.9.9',
      id: ids.b.deviceId,
      device_id: ids.b.deviceId,
      provider_id: ids.b.id,
      label: 'Changed label',
      token_hash: 'x',
      revoked_at: new Date().toISOString(),
      last_sync_at: agoIso(HOUR),
      last_seen_at: agoIso(HOUR),
      created_at: agoIso(DAY),
      not_accepted_total: 500,
      overflow_total: 500,
    }
    const res = await report(body, ids.a.token)
    expect(res.status).toBe(200)
    const after = await wholeRow(ids.a.deviceId)
    expect(steady(after)).toEqual({ ...steady(before), app_build: BUILD, waiting_count: 2, status_at: expect.any(String) })
    expect(after.label).toBe('Fake Browser A')
    expect(after.revoked_at).toBeNull()
  })

  describe('the throttle: one statement, and a report within DEVICE_STATUS_MIN_INTERVAL_S of the last one changes nothing', () => {
    it('is 10 seconds today', () => {
      expect(DEVICE_STATUS_MIN_INTERVAL_S).toBe(10)
    })

    it('stores the first report, ignores the next ones within the period, and stores one after it', async () => {
      await blank(ids.a.deviceId)
      expect((await report({ build: BUILD, waiting: 3, not_accepted: 1, overflowed: 1 }, ids.a.token)).status).toBe(200)
      const first = await wholeRow(ids.a.deviceId)
      expect(first.waiting_count).toBe(3)

      // Right away, and 5 seconds after the first one: answered as usual, and not one column changes (status_at included).
      for (const seconds of [null, 5]) {
        if (seconds !== null) {
          await reportedAgo(ids.a.deviceId, seconds)
          first.status_at = (await wholeRow(ids.a.deviceId)).status_at
        }
        const throttled = await report({ build: 'dev', waiting: 99, oldest_waiting_at: agoIso(HOUR), not_accepted: 50, overflowed: 50 }, ids.a.token)
        expect(throttled.status).toBe(200)
        expect(throttled.json.ok).toBe(true)
        expect(steady(await wholeRow(ids.a.deviceId)), `${seconds ?? 0} seconds after the last one`).toEqual(steady(first))
      }

      // After the period it is stored, and the totals go on from what they were.
      await reportedAgo(ids.a.deviceId, DEVICE_STATUS_MIN_INTERVAL_S + 1)
      const later = await report({ build: 'dev', waiting: 99, not_accepted: 50, overflowed: 40 }, ids.a.token)
      expect(later.status).toBe(200)
      expect(await reported(ids.a.deviceId)).toMatchObject({ app_build: 'dev', waiting_count: 99, not_accepted_total: 51, overflow_total: 41 })
    })

    it('is a single UPDATE: no statement reads the phone\'s row to decide, so there is no read-then-write to race', async () => {
      await blank(ids.a.deviceId)
      const { result, statements } = await withStatements(() => report({ build: BUILD, waiting: 1 }, ids.a.token))
      expect(result.status).toBe(200)
      const about = statements.filter((text) => /status_at/.test(text))
      expect(about).toHaveLength(1)
      expect(about[0]).toMatch(/^update provider_devices set app_build/)
      expect(about[0]).toMatch(/where id = \$1 and revoked_at is null and \(status_at is null or status_at <= now\(\) - make_interval/)
      // A throttled report makes the very same statements.
      const again = await withStatements(() => report({ build: BUILD, waiting: 2 }, ids.a.token))
      expect(again.statements.filter((text) => /status_at/.test(text))).toEqual(about)
    })

    it('holds when two reports arrive together: one is stored, the other is not', async () => {
      await blank(ids.a.deviceId)
      const [one, two] = await Promise.all([
        report({ waiting: 1, not_accepted: 1, overflowed: 1 }, ids.a.token),
        report({ waiting: 2, not_accepted: 1, overflowed: 1 }, ids.a.token),
      ])
      expect([one.status, two.status]).toEqual([200, 200])
      const row = await reported(ids.a.deviceId)
      // Counted once, not twice: the second statement waited for the first, saw its status_at, and matched no row.
      expect([row.not_accepted_total, row.overflow_total]).toEqual([1, 1])
      expect([1, 2]).toContain(row.waiting_count)
    })
  })

  describe('the running totals', () => {
    it('add up from report to report, and a report adds at most DEVICE_STATUS_MAX_COUNT', { timeout: 120_000 }, async () => {
      await blank(ids.a.deviceId)
      const total = async () => {
        const { not_accepted_total, overflow_total } = await reported(ids.a.deviceId)
        return [not_accepted_total, overflow_total]
      }
      const next = async (body) => {
        await reportedAgo(ids.a.deviceId, 60)
        expect((await report(body, ids.a.token)).status).toBe(200)
        return total()
      }
      expect(await next({ not_accepted: 3, overflowed: 4 })).toEqual([3, 4])
      expect(await next({ not_accepted: 2, overflowed: 1 })).toEqual([5, 5])
      expect(await next({ not_accepted: 0 })).toEqual([5, 5])
      expect(await next({})).toEqual([5, 5])
      expect(await next({ not_accepted: DEVICE_STATUS_MAX_COUNT + 1, overflowed: 5000 })).toEqual([5 + DEVICE_STATUS_MAX_COUNT, 5 + DEVICE_STATUS_MAX_COUNT])
      expect(await next({ not_accepted: -7, overflowed: -1 })).toEqual([5 + DEVICE_STATUS_MAX_COUNT, 5 + DEVICE_STATUS_MAX_COUNT]) // a negative count takes nothing away
      expect(await next({ not_accepted: 'x', overflowed: 1.5 })).toEqual([5 + DEVICE_STATUS_MAX_COUNT, 5 + DEVICE_STATUS_MAX_COUNT])
    })

    it('never overflow the column: the sum is cut to the largest integer, and the report is still stored', async () => {
      await blank(ids.a.deviceId)
      await db.pool.query('update provider_devices set not_accepted_total = $2, overflow_total = $3 where id = $1', [ids.a.deviceId, INTEGER_MAX - 5, INTEGER_MAX])
      const res = await report({ build: BUILD, waiting: 8, not_accepted: DEVICE_STATUS_MAX_COUNT, overflowed: DEVICE_STATUS_MAX_COUNT }, ids.a.token)
      expect(res.status).toBe(200)
      expect(res.json.ok).toBe(true)
      expect(await reported(ids.a.deviceId)).toMatchObject({ app_build: BUILD, waiting_count: 8, not_accepted_total: INTEGER_MAX, overflow_total: INTEGER_MAX })
      await reportedAgo(ids.a.deviceId, 60)
      expect((await report({ not_accepted: 1, overflowed: 1 }, ids.a.token)).status).toBe(200)
      expect(await reported(ids.a.deviceId)).toMatchObject({ not_accepted_total: INTEGER_MAX, overflow_total: INTEGER_MAX })
    })
  })

  describe('oldest_waiting_at', () => {
    const oldestAfter = async (body) => {
      await reportedAgo(ids.a.deviceId, 60)
      const res = await report(body, ids.a.token)
      expect(res.status).toBe(200)
      return (await reported(ids.a.deviceId)).oldest_waiting_at
    }

    // Every edge of the window is proved on the reader above (no database); here one case on each side of each edge shows that the
    // database gets what the reader decided. Each report is several round trips to a remote database, hence the longer limit.
    it('is stored inside its window, and becomes null outside it', { timeout: 120_000 }, async () => {
      await blank(ids.a.deviceId)
      for (const [label, value, stored] of [
        ['2 hours ago', agoIso(2 * HOUR), true],
        ['4 minutes ahead (a phone clock that runs a little fast)', aheadIso(4 * 60 * 1000), true],
        ['61 days ago', agoIso(61 * DAY), false],
        ['6 minutes ahead', aheadIso(6 * 60 * 1000), false],
        ['not a time', 'soon', false],
      ]) {
        // Something is stored first, so that "becomes null" is a change and not the starting value.
        expect(await oldestAfter({ waiting: 5, oldest_waiting_at: agoIso(HOUR) }), label).not.toBeNull()
        const kept = await oldestAfter({ waiting: 5, oldest_waiting_at: value })
        if (stored) expect(kept, label).toEqual(new Date(value))
        else expect(kept, label).toBeNull()
      }
    })

    it('keeps its value when a report does not send it, is cleared when a report sends null or says that nothing waits', { timeout: 120_000 }, async () => {
      await blank(ids.a.deviceId)
      const when = agoIso(5 * HOUR)
      expect(await oldestAfter({ waiting: 6, oldest_waiting_at: when })).toEqual(new Date(when))
      expect(await oldestAfter({ build: BUILD, not_accepted: 1 })).toEqual(new Date(when)) // a report about something else
      expect(await oldestAfter({ waiting: 5 })).toEqual(new Date(when))
      expect(await oldestAfter({ waiting: 'x' })).toEqual(new Date(when))
      expect(await oldestAfter({ oldest_waiting_at: null })).toBeNull()
      expect(await oldestAfter({ waiting: 6, oldest_waiting_at: when })).toEqual(new Date(when))
      expect(await oldestAfter({ waiting: 0 })).toBeNull()
      expect((await reported(ids.a.deviceId)).waiting_count).toBe(0)
      expect(await oldestAfter({ waiting: 6, oldest_waiting_at: when })).toEqual(new Date(when))
      expect(await oldestAfter({ waiting: 0, oldest_waiting_at: when })).toBeNull() // nothing waits, so nothing waits since a time
    })

    it('reads a time with an offset as the moment that it is', async () => {
      await blank(ids.a.deviceId)
      const moment = new Date(Date.now() - 3 * HOUR)
      const local = new Date(moment.getTime() + 2 * HOUR).toISOString().replace(/\.\d+Z$/, '+02:00')
      expect((await oldestAfter({ waiting: 1, oldest_waiting_at: local })).getTime()).toBe(Math.floor(moment.getTime() / 1000) * 1000)
    })
  })

  describe('whose phone it updates', () => {
    it('is the phone of the token, and no other: a body that names another phone, or another provider, changes nothing there', async () => {
      await blank(ids.a.deviceId)
      await blank(ids.b.deviceId)
      const bBefore = await wholeRow(ids.b.deviceId)
      const sibling = await signIn(ids.a, 'Fake Browser A2') // a second phone of the same provider
      const siblingBefore = await wholeRow(sibling.deviceId)

      const res = await report(
        { build: BUILD, waiting: 9, not_accepted: 5, id: ids.b.deviceId, device_id: ids.b.deviceId, deviceId: ids.b.deviceId, provider_id: ids.b.id, token_hash: sha256(ids.b.token) },
        ids.a.token,
      )
      expect(res.status).toBe(200)
      expect(await reported(ids.a.deviceId)).toMatchObject({ app_build: BUILD, waiting_count: 9, not_accepted_total: 5 })
      expect(await wholeRow(ids.b.deviceId)).toEqual(bBefore)
      expect(await wholeRow(sibling.deviceId)).toEqual(siblingBefore)
    })

    it('is refused for a phone that was signed out: 401 from the guard, and nothing is stored', async () => {
      const phone = await signIn(ids.b, 'Fake Browser B2')
      expect((await report({ build: BUILD, waiting: 1 }, phone.token)).status).toBe(200)
      const stored = await wholeRow(phone.deviceId)
      expect((await call('DELETE', '/api/session', { token: phone.token })).status).toBe(200)
      const revoked = await wholeRow(phone.deviceId)

      const res = await report({ build: 'dev', waiting: 50, not_accepted: 9 }, phone.token)
      expect(res.status).toBe(401)
      expect(res.json).toEqual({ error: { code: 'invalid_session', message: 'Session expired' } })
      expect(steady(await wholeRow(phone.deviceId))).toEqual(steady(revoked))
      expect(steady(revoked)).toEqual({ ...steady(stored), revoked_at: expect.any(String) })
    })

    it('is refused without a token, and with the token of a phone that does not exist', async () => {
      const none = await report({ waiting: 1 })
      expect([none.status, none.json.error.code]).toEqual([401, 'invalid_session'])
      const unknown = await report({ waiting: 1 }, 'qrp_' + 'a'.repeat(43))
      expect([unknown.status, unknown.json.error.code]).toEqual([401, 'invalid_session'])
    })

    it('does not touch the row of a revoked phone even when the guard has just let it in (the write checks revoked_at itself)', async () => {
      const phone = await signIn(ids.b, 'Fake Browser B3')
      // The guard finds the phone, then the phone is revoked before the report is written.
      await db.pool.query('update provider_devices set revoked_at = now() where id = $1', [phone.deviceId])
      const before = await wholeRow(phone.deviceId)
      expect(await reportDeviceStatus(phone.deviceId, parseDeviceStatusReport({ build: BUILD, waiting: 3 }))).toBe(false)
      expect(await wholeRow(phone.deviceId)).toEqual(before)
    })
  })
})

// ======================================================================================================================
// 3. POST /api/scans/sync: last_sync_at
// ======================================================================================================================

describe('POST /api/scans/sync stamps last_sync_at', () => {
  const lastSync = async (deviceId) => (await reported(deviceId)).last_sync_at
  const accepted = () => ({ id: randomUUID(), code: ids.point.qr_token, client_time: agoIso(2 * HOUR) })
  const refused = () => ({ id: randomUUID(), code: ids.inactive.qr_token, client_time: agoIso(2 * HOUR) })

  it('sets it after a sync, on the phone that synced and on no other', { timeout: 120_000 }, async () => {
    await blank(ids.a.deviceId)
    await blank(ids.b.deviceId)
    const sibling = await signIn(ids.a, 'Fake Browser A3')
    const aBefore = await wholeRow(ids.a.deviceId)
    const bBefore = await wholeRow(ids.b.deviceId)
    const siblingBefore = await wholeRow(sibling.deviceId)
    expect(aBefore.last_sync_at).toBeNull()

    const point = await makePoint()
    const res = await sync([{ id: randomUUID(), code: point.qr_token, client_time: agoIso(2 * HOUR) }], ids.a.token)
    expect(res.status).toBe(200)
    expect(res.json.results).toHaveLength(1)
    expect(res.json.results[0]).toMatchObject({ ok: true, duplicate: false })

    const after = await wholeRow(ids.a.deviceId)
    expect(after.last_sync_at).not.toBeNull()
    expect(Math.abs((await dbNow()).getTime() - Date.parse(after.last_sync_at))).toBeLessThan(60_000)
    // It is the only column of the phone that the sync changed (the guard may also have touched last_seen_at, which is not shown).
    const without = (row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'last_sync_at' && column !== 'last_seen_at'))
    expect(without(after)).toEqual(without(aBefore))
    expect(await wholeRow(ids.b.deviceId)).toEqual(bBefore)
    expect(await wholeRow(sibling.deviceId)).toEqual(siblingBefore)
  })

  it('moves forward with every sync', async () => {
    await blank(ids.a.deviceId)
    expect((await sync([accepted()], ids.a.token)).status).toBe(200)
    const first = await lastSync(ids.a.deviceId)
    await db.pool.query(`update provider_devices set last_sync_at = now() - interval '1 hour' where id = $1`, [ids.a.deviceId])
    expect((await sync([accepted()], ids.a.token)).status).toBe(200)
    expect((await lastSync(ids.a.deviceId)).getTime()).toBeGreaterThanOrEqual(first.getTime() - 5000)
    expect(Date.now() - (await lastSync(ids.a.deviceId)).getTime()).toBeLessThan(60_000)
  })

  it('is set for an old phone too, whose body is only { scans: [{ id, code, client_time, gps }] } and which reports nothing', async () => {
    await blank(ids.a.deviceId)
    const item = { ...accepted(), gps: null }
    const res = await call('POST', '/api/scans/sync', { token: ids.a.token, body: { scans: [item] } })
    expect(res.status).toBe(200)
    expect(Object.keys(res.json)).toEqual(['results'])
    expect(await reported(ids.a.deviceId)).toEqual({ ...NOTHING, last_sync_at: expect.any(Date) }) // no report, and a stamp
  })

  it('is set when every item was refused (the upload reached the server), and not when the request itself is refused', async () => {
    await blank(ids.a.deviceId)
    const refusedOnly = await sync([refused()], ids.a.token)
    expect(refusedOnly.status).toBe(200)
    expect(refusedOnly.json.results[0]).toMatchObject({ ok: false, error: { code: SCAN_ERROR_POINT_INACTIVE } })
    expect(await lastSync(ids.a.deviceId)).toBeInstanceOf(Date)

    await blank(ids.a.deviceId)
    const notAList = await call('POST', '/api/scans/sync', { token: ids.a.token, body: { scans: 'x' } })
    expect([notAList.status, notAList.json.error.code]).toEqual([400, 'invalid_field'])
    const tooMany = await sync(Array.from({ length: 21 }, () => accepted()), ids.a.token)
    expect([tooMany.status, tooMany.json.error.code]).toEqual([400, 'batch_too_large'])
    expect(await lastSync(ids.a.deviceId)).toBeNull()
  })

  it('is not a report: it leaves everything that a phone reports as it was', async () => {
    await blank(ids.a.deviceId)
    expect((await report({ build: BUILD, waiting: 4, oldest_waiting_at: agoIso(HOUR), not_accepted: 2, overflowed: 1 }, ids.a.token)).status).toBe(200)
    const before = await reported(ids.a.deviceId)
    expect((await sync([accepted()], ids.a.token)).status).toBe(200)
    expect(await reported(ids.a.deviceId)).toEqual({ ...before, last_sync_at: expect.any(Date) })
  })

  describe('the answer of the sync is byte for byte what it was', () => {
    it('for refused items, whose answer does not depend on the clock', async () => {
      const items = [refused(), { id: 'not-a-uuid', code: ids.point.qr_token, client_time: agoIso(HOUR) }]
      const res = await sync(items, ids.a.token)
      expect(res.status).toBe(200)
      expect(res.text).toBe(
        JSON.stringify({
          results: [
            // The items are answered in the order of the phone's clock, which is the same for both here: the order that they came in.
            { id: items[0].id, ok: false, error: { code: SCAN_ERROR_POINT_INACTIVE, message: 'This point is not active' } },
            { id: 'not-a-uuid', ok: false, error: { code: 'invalid_scan_id', message: 'Invalid id' } },
          ],
        }),
      )
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(res.headers['cache-control']).toBe('no-store')
    })

    it('for an accepted item: the same members in the same order, and nothing added', async () => {
      const point = await makePoint()
      const item = { id: randomUUID(), code: point.qr_token, client_time: agoIso(2 * HOUR) }
      const res = await sync([item], ids.a.token)
      expect(res.status).toBe(200)
      const { rows } = await db.pool.query('select * from scans where id = $1', [item.id])
      expect(res.text).toBe(JSON.stringify({ results: [{ id: item.id, ok: true, scan: scanJson(rows[0]), duplicate: false }] }))
      expect(Object.keys(res.json)).toEqual(['results'])
      expect(Object.keys(res.json.results[0])).toEqual(['id', 'ok', 'scan', 'duplicate'])
    })

    it('when the stamp cannot be written: the same answer, one log line with the code of the failure, and the visits are kept', async () => {
      await blank(ids.a.deviceId)
      const point = await makePoint()
      const good = { id: randomUUID(), code: point.qr_token, client_time: agoIso(2 * HOUR) }
      const bad = refused()
      const log = listenToConsole()
      lastSyncUpdateFails(Object.assign(new Error('Connection terminated unexpectedly: Fake Person'), { code: 'ECONNRESET' }))

      const res = await sync([good, bad], ids.a.token)
      expect(res.status).toBe(200)
      const { rows } = await db.pool.query('select * from scans where id = $1', [good.id])
      expect(res.text).toBe(
        JSON.stringify({
          results: [
            { id: good.id, ok: true, scan: scanJson(rows[0]), duplicate: false },
            { id: bad.id, ok: false, error: { code: SCAN_ERROR_POINT_INACTIVE, message: 'This point is not active' } },
          ],
        }),
      )
      expect(log.error).toHaveBeenCalledTimes(1)
      expect(log.error.mock.calls[0]).toEqual(['last upload time not stored: ECONNRESET'])
      for (const text of ['Fake Person', 'Connection terminated']) expect(String(log.error.mock.calls[0])).not.toContain(text)
      expect(log.warn).not.toHaveBeenCalled()
      expect(log.log).not.toHaveBeenCalled()
      // The visit was committed before the stamp, and the stamp is not there.
      expect(rows).toHaveLength(1)
      expect(await lastSync(ids.a.deviceId)).toBeNull()

      // The phone sends the batch again (it saw a good answer, so it would not, but a retry must be safe): replayed by id, and stamped.
      vi.restoreAllMocks()
      const again = await sync([good, bad], ids.a.token)
      expect(again.status).toBe(200)
      expect(again.json.results.map((r) => [r.id, r.ok])).toEqual([[good.id, true], [bad.id, false]])
      expect(await lastSync(ids.a.deviceId)).toBeInstanceOf(Date)
    })

    it('a failure that is not about the stamp still fails the request as it always did, and stamps nothing', async () => {
      await blank(ids.a.deviceId)
      const log = listenToConsole()
      const real = db.pool.query.bind(db.pool)
      // The guard's own lookup of the phone is the first statement of the request: if it fails, the request fails (500) and no stamp is made.
      vi.spyOn(db.pool, 'query').mockImplementation((text, params) =>
        typeof text === 'string' && text.includes('from provider_devices d') ? Promise.reject(Object.assign(new Error('boom'), { code: 'ECONNRESET' })) : real(text, params),
      )
      const res = await sync([accepted()], ids.a.token)
      vi.restoreAllMocks()
      expect(res.status).toBe(500)
      expect(res.text).toBe('{"error":{"code":"server_error","message":"Something went wrong"}}')
      expect(log.error).toHaveBeenCalledTimes(1)
      expect(await lastSync(ids.a.deviceId)).toBeNull()
    })
  })
})

// ======================================================================================================================
// 4. GET /api/admin/providers/:id/devices
// ======================================================================================================================

describe('GET /api/admin/providers/:id/devices', () => {
  const list = (id, extra = { cookie }) => call('GET', `/api/admin/providers/${id}/devices`, extra)
  const KEYS = ['id', 'created_at', 'last_seen_at', 'status_at', 'last_sync_at', 'app_build', 'waiting_count', 'oldest_waiting_at', 'not_accepted_total', 'overflow_total', 'outdated']
  const LABEL = 'Fake Browser Label For The Committee'
  let c // a provider of its own, with three phones: two active (one reported, one never did) and one that was signed out
  let reportedPhone, silentPhone, signedOutPhone

  beforeAll(async () => {
    c = await makeProvider('Fake Painters')
    reportedPhone = await signIn(c, LABEL)
    silentPhone = await signIn(c, LABEL + ' 2')
    signedOutPhone = await signIn(c, LABEL + ' 3')
    expect((await report({ build: BUILD, waiting: 12, oldest_waiting_at: agoIso(6 * HOUR), not_accepted: 3, overflowed: 1 }, reportedPhone.token)).status).toBe(200)
    expect((await report({ build: BUILD, waiting: 1 }, signedOutPhone.token)).status).toBe(200)
    expect((await call('DELETE', '/api/session', { token: signedOutPhone.token })).status).toBe(200)
    // The silent phone synced once (an old app does that and reports nothing), and was used most recently.
    expect((await sync([{ id: randomUUID(), code: ids.point.qr_token, client_time: agoIso(HOUR) }], silentPhone.token)).status).toBe(200)
    await db.pool.query(`update provider_devices set last_seen_at = now() - interval '1 day' where id = $1`, [reportedPhone.deviceId])
  })

  it('lists the active phones of the provider, the one used last first, and not the phone that was signed out', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const res = await list(c.id)
    expect(res.status).toBe(200)
    expect(Object.keys(res.json)).toEqual(['devices'])
    expect(res.json.devices.map((d) => d.id)).toEqual([silentPhone.deviceId, reportedPhone.deviceId])
    for (const device of res.json.devices) expect(Object.keys(device)).toEqual(KEYS)
    expect(res.headers['cache-control']).toBe('no-store')

    const [silent, full] = res.json.devices
    expect(full).toEqual({
      id: reportedPhone.deviceId,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      last_seen_at: expect.stringMatching(/Z$/),
      status_at: expect.stringMatching(/Z$/),
      last_sync_at: null,
      app_build: BUILD,
      waiting_count: 12,
      oldest_waiting_at: expect.stringMatching(/Z$/),
      not_accepted_total: 3,
      overflow_total: 1,
      outdated: false,
    })
    expect(Math.abs(Date.now() - Date.parse(full.oldest_waiting_at) - 6 * HOUR)).toBeLessThan(60_000)
    // A phone that never reported: nothing reported, zero totals, and a time of the last upload that the server wrote.
    expect(silent).toEqual({
      id: silentPhone.deviceId,
      created_at: expect.any(String),
      last_seen_at: expect.any(String),
      status_at: null,
      last_sync_at: expect.stringMatching(/Z$/),
      app_build: null,
      waiting_count: null,
      oldest_waiting_at: null,
      not_accepted_total: 0,
      overflow_total: 0,
      outdated: false,
    })
  })

  it('shows no label and no token hash, anywhere in the answer', async () => {
    const res = await list(c.id)
    expect(res.status).toBe(200)
    const text = res.text
    for (const secret of [LABEL, 'Fake Browser', ...[reportedPhone, silentPhone, signedOutPhone].flatMap((p) => [p.token, sha256(p.token)])]) {
      expect(text, secret).not.toContain(secret)
    }
    for (const word of ['label', 'token', 'hash', 'revoked']) expect(text.toLowerCase(), word).not.toContain(word)
    // The two phones really have a label, and a hash, in the table (so the check above is not an empty one).
    const { rows } = await db.pool.query('select label, token_hash from provider_devices where id = any($1)', [[reportedPhone.deviceId, silentPhone.deviceId]])
    expect(rows.map((r) => r.label).sort()).toEqual([LABEL, LABEL + ' 2'])
    expect(rows.every((r) => r.token_hash.length === 64)).toBe(true)
  })

  it('lists the phones of that provider only', async () => {
    const mine = (await list(c.id)).json.devices.map((d) => d.id)
    const theirs = (await list(ids.a.id)).json.devices.map((d) => d.id)
    expect(theirs).toContain(ids.a.deviceId)
    expect(theirs).not.toContain(reportedPhone.deviceId)
    expect(mine).not.toContain(ids.a.deviceId)
    expect(mine.filter((id) => theirs.includes(id))).toEqual([])
  })

  it('answers an empty list for a provider whose phones are all signed out, or that never signed in', async () => {
    const fresh = await makeProvider('Fake Plumbers')
    expect((await list(fresh.id)).json).toEqual({ devices: [] })
    await signIn(fresh, LABEL)
    expect((await list(fresh.id)).json.devices).toHaveLength(1)
    expect((await call('POST', `/api/admin/providers/${fresh.id}/revoke-devices`, { cookie, body: {} })).status).toBe(200)
    expect((await list(fresh.id)).json).toEqual({ devices: [] })
  })

  describe('outdated: the phone reported a build, the server knows its own, and they differ', () => {
    const outdatedOf = async () => Object.fromEntries((await list(c.id)).json.devices.map((d) => [d.id, d.outdated]))

    it('is false for the same build, true for another, and false for a phone that reported none', async () => {
      vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
      expect(await outdatedOf()).toEqual({ [reportedPhone.deviceId]: false, [silentPhone.deviceId]: false })

      await db.pool.query(`update provider_devices set app_build = '1234567' where id = $1`, [reportedPhone.deviceId])
      expect(await outdatedOf()).toEqual({ [reportedPhone.deviceId]: true, [silentPhone.deviceId]: false })
      await db.pool.query(`update provider_devices set app_build = 'dev' where id = $1`, [reportedPhone.deviceId])
      expect((await outdatedOf())[reportedPhone.deviceId]).toBe(true) // a development build is not the server's build
      await db.pool.query(`update provider_devices set app_build = $2 where id = $1`, [reportedPhone.deviceId, BUILD])
      expect((await outdatedOf())[reportedPhone.deviceId]).toBe(false)
    })

    it('follows the build of the server, which is read for each request', async () => {
      vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '7654321fedcba0987654321fedcba0987654321f')
      expect((await outdatedOf())[reportedPhone.deviceId]).toBe(true)
      vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
      expect((await outdatedOf())[reportedPhone.deviceId]).toBe(false)
    })

    it('is false for every phone when the server does not know its build (a local server)', async () => {
      await db.pool.query(`update provider_devices set app_build = '1234567' where id = $1`, [reportedPhone.deviceId])
      for (const sha of [undefined, '']) {
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', sha)
        expect(await outdatedOf(), String(sha)).toEqual({ [reportedPhone.deviceId]: false, [silentPhone.deviceId]: false })
      }
      await db.pool.query('update provider_devices set app_build = $2 where id = $1', [reportedPhone.deviceId, BUILD])
    })
  })

  it('answers 404 provider_not_found for a provider that does not exist, as the other provider routes do', async () => {
    const unknown = randomUUID()
    const res = await list(unknown)
    expect(res.status).toBe(404)
    expect(res.json).toEqual({ error: { code: 'provider_not_found', message: 'Provider not found' } })
    const other = await call('PATCH', `/api/admin/providers/${unknown}`, { cookie, body: { company: 'Fake' } })
    expect([other.status, other.json]).toEqual([404, res.json])
    // An id in capitals is the same id.
    expect((await list(c.id.toUpperCase())).status).toBe(200)
  })

  it('answers 400 invalid_id for an id that is not an id, as the other provider routes do', async () => {
    for (const id of ['not-an-id', '123', 'x'.repeat(40), '00000000-0000-0000-0000-00000000000g']) {
      const res = await list(id)
      expect(res.status, id).toBe(400)
      expect(res.json, id).toEqual({ error: { code: 'invalid_id', message: 'Invalid id' } })
    }
    const other = await call('PATCH', '/api/admin/providers/not-an-id', { cookie, body: { company: 'Fake' } })
    expect([other.status, other.json]).toEqual([400, { error: { code: 'invalid_id', message: 'Invalid id' } }])
  })

  it('needs a committee session (the router guards it, tests/route-auth.test.js walks it): not a provider token, not nothing', async () => {
    expect((await list(c.id, {})).status).toBe(401)
    const withProviderToken = await list(c.id, { token: ids.a.token })
    expect([withProviderToken.status, withProviderToken.json.error.code]).toEqual([401, 'admin_required'])
  })
})
