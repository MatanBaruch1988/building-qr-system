// The guard of an agent key counts every request of the key and limits it (requireApiKey in server/auth.js, the table
// api_key_usage of migration 013, the constants in server/config.js). AGENTS.md (Safety, "The committee's agent is its analyst")
// allows the agent API two writes and no others: last_used_at of the key, at most every 5 minutes, and this count, which also
// limits the key with 429 `rate_limited`. This file proves, against the throwaway schema:
//   - the numbers: 60 requests a minute and 2000 a building day, and 90 days of retention (owner decision of 08/10/2026);
//   - the limit: a key at the limit of the minute, or of the building's day, is refused with 429, the Retry-After header and the
//     window in the body; one request under the limit is let through; a key's limit is its own; a window that has passed does
//     not limit; the day is the building's day (midnight in BUILDING_TZ), not the day of the database or of UTC;
//   - the counters: `requests` counts what was let through and `refused` what was turned away, once per request, however many
//     times a handler asks the guard; a refused request never counts towards the limit;
//   - last_used_at: written on the first request, then not again within 5 minutes, and again after;
//   - an unknown and a revoked key write nothing; a deleted key takes its usage with it; a key deleted while requests are in
//     flight gives those requests a 401, never a 409 or a 500; parallel requests of one key are all counted and none deadlocks;
//   - the numbers of the Agent screen (GET /api/admin/api-keys): per key, the requests of the building's day, of the last 7
//     building days and the refused requests of the last 30, from the same day boundary as the guard; zeros for a key with no usage.
// A usage row is put in place with SQL instead of sending that many requests. A test that reads "the row of the current minute"
// first waits out the end of a minute (settleMinute), so that the turn of a minute cannot move its request to another row.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie, mintAgentKey, revokeAgentKey, putKeyAtMinuteLimit } from './helpers.js'
import {
  AGENT_KEY_MAX_PER_DAY,
  AGENT_KEY_MAX_PER_MINUTE,
  API_KEY_PREFIX,
  RETENTION_API_KEY_USAGE_DAYS,
  TIMEZONE,
} from '../server/config.js'

let db
let cookie

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
})
afterAll(async () => db?.teardown())

const get = (key, path = '/points') => call('GET', `/api/agent/v1${path}`, { token: key })
const q = (text, params) => db.pool.query(text, params)
const rowsOf = async (text, params) => (await q(text, params)).rows

/** Every usage row of a key, oldest minute first. */
const usageOf = (id) => rowsOf('select minute, requests, refused from api_key_usage where key_id = $1 order by minute', [id])
/** The counts of a key over all its minutes. */
const totalsOf = async (id) =>
  (
    await rowsOf(
      `select coalesce(sum(requests), 0)::int as requests, coalesce(sum(refused), 0)::int as refused, count(*)::int as rows
         from api_key_usage where key_id = $1`,
      [id],
    )
  )[0]
const lastUsedOf = async (id) => (await rowsOf('select last_used_at from api_keys where id = $1', [id]))[0].last_used_at
/** The start of the building's day, as a Date (the midnight of BUILDING_TZ that the day began at). */
const dayStart = async () =>
  (await rowsOf(`select date_trunc('day', now() at time zone $1) at time zone $1 as t`, [TIMEZONE]))[0].t
const minuteOf = async (offsetMinutes = 0) =>
  (await rowsOf(`select date_trunc('minute', now()) + make_interval(mins => $1::int) as t`, [offsetMinutes]))[0].t
const putUsage = (id, minute, requests, refused = 0) =>
  q('insert into api_key_usage (key_id, minute, requests, refused) values ($1, $2, $3, $4)', [id, minute, requests, refused])

/** A new key, made the way the committee makes one. */
const newKey = (name = 'limits test') => mintAgentKey(cookie, name)

/**
 * Waits for the next minute when fewer than `seconds` seconds are left of this one, so that the request of a test and the row
 * that it reads are in the same minute. (The turn of a building day is the turn of a minute too, so this covers the day.)
 */
async function settleMinute(seconds = 6) {
  const left = 60 - (await rowsOf('select extract(second from now())::float as s'))[0].s
  if (left < seconds) await new Promise((resolve) => setTimeout(resolve, left * 1000 + 300))
}

describe('the numbers are decisions', () => {
  it('are 60 requests a minute, 2000 a building day, and 90 days of kept usage (owner decision of 08/10/2026)', () => {
    // A change here changes what docs/agent-api.md promises to an agent (tests/agent-docs.test.js compares them) and, for the
    // period, what docs/privacy.md promises to the committee: it needs the owner's decision.
    expect([AGENT_KEY_MAX_PER_MINUTE, AGENT_KEY_MAX_PER_DAY, RETENTION_API_KEY_USAGE_DAYS]).toEqual([60, 2000, 90])
  })
})

describe('the table api_key_usage (migration 013)', () => {
  it('holds a key, a minute and two counts, keyed by the key and the minute, with a cascade from the key', async () => {
    const columns = await rowsOf(
      `select column_name as name, data_type as type, is_nullable as nullable, column_default as def
         from information_schema.columns where table_schema = current_schema() and table_name = 'api_key_usage' order by ordinal_position`,
    )
    expect(columns).toEqual([
      { name: 'key_id', type: 'uuid', nullable: 'NO', def: null },
      { name: 'minute', type: 'timestamp with time zone', nullable: 'NO', def: null },
      { name: 'requests', type: 'integer', nullable: 'NO', def: '0' },
      { name: 'refused', type: 'integer', nullable: 'NO', def: '0' },
    ])
    const constraints = await rowsOf(
      `select contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'api_key_usage'::regclass order by contype, def`,
    )
    expect(constraints.find((c) => c.contype === 'p').def).toBe('PRIMARY KEY (key_id, minute)')
    expect(constraints.find((c) => c.contype === 'f').def).toMatch(/FOREIGN KEY \(key_id\) REFERENCES api_keys\(id\) ON DELETE CASCADE/)
    // The retention job deletes by the minute across all keys, so the minute has an index of its own.
    const indexes = await rowsOf(`select indexdef from pg_indexes where schemaname = current_schema() and tablename = 'api_key_usage'`)
    expect(indexes.some((i) => /\(minute\)$/.test(i.indexdef))).toBe(true)
  })

  it('refuses a negative count', async () => {
    const { id } = await newKey()
    await expect(putUsage(id, await minuteOf(), -1)).rejects.toMatchObject({ code: '23514' })
    await expect(putUsage(id, await minuteOf(), 0, -1)).rejects.toMatchObject({ code: '23514' })
  })
})

describe('the count', () => {
  it('writes one row for a key and a minute: the first request makes it, the next ones add to it', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    expect(await usageOf(id)).toEqual([])
    expect((await get(key)).status).toBe(200)
    const first = await usageOf(id)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ requests: 1, refused: 0 })
    expect(first[0].minute.getTime()).toBe((await minuteOf()).getTime())
    for (let i = 0; i < 3; i++) expect((await get(key)).status).toBe(200)
    const after = await usageOf(id)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ requests: 4, refused: 0 })
  })

  it('counts a request once, however many times its handler asks the guard, and for every endpoint, health/db included', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    // Every agent handler calls requireApiKey again after the router did: the guard answers once per request.
    const paths = ['/health', '/schema', '/points', '/providers', '/scans']
    for (const [i, path] of paths.entries()) {
      expect((await get(key, path)).status, path).toBe(200)
      expect((await totalsOf(id)).requests, `after ${path}`).toBe(i + 1)
    }
    expect((await call('GET', '/api/health/db', { token: key })).status).toBe(200)
    expect(await totalsOf(id)).toEqual({ requests: paths.length + 1, refused: 0, rows: 1 })
  })

  it('counts nothing for a request that never reaches the guard: an unknown path, a method the path has no route for', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    expect((await get(key, '/nope')).status).toBe(404)
    expect((await call('POST', '/api/agent/v1/points', { token: key, body: {} })).status).toBe(405)
    expect(await usageOf(id)).toEqual([])
  })

  it('counts a request in the minute that it arrives in: the next minute is another row', async () => {
    const { id, key } = await newKey()
    await putUsage(id, await minuteOf(-1), 7, 2)
    expect((await get(key)).status).toBe(200)
    const rows = await usageOf(id)
    expect(rows.map((r) => [r.requests, r.refused])).toEqual([[7, 2], [1, 0]])
  })

  it('keeps the counters of one key apart from those of another', async () => {
    await settleMinute()
    const a = await newKey('a')
    const b = await newKey('b')
    await get(a.key)
    await get(a.key)
    await get(b.key)
    expect((await totalsOf(a.id)).requests).toBe(2)
    expect((await totalsOf(b.id)).requests).toBe(1)
  })

  it('counts parallel requests of one key, all of them, with no deadlock and no error', async () => {
    await settleMinute(8)
    const { id, key } = await newKey()
    const answers = await Promise.all(Array.from({ length: 12 }, () => get(key)))
    expect(answers.map((r) => r.status)).toEqual(Array(12).fill(200))
    expect(await totalsOf(id)).toEqual({ requests: 12, refused: 0, rows: 1 })
    expect(await lastUsedOf(id)).toBeInstanceOf(Date)
  })
})

describe('the limit of the minute', () => {
  it('lets the 60th request of a minute through and refuses the 61st: the counters, the body and the Retry-After header', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    await putUsage(id, await minuteOf(), AGENT_KEY_MAX_PER_MINUTE - 1)
    const last = await get(key)
    expect(last.status).toBe(200)
    expect(await totalsOf(id)).toEqual({ requests: AGENT_KEY_MAX_PER_MINUTE, refused: 0, rows: 1 })

    const over = await get(key)
    expect(over.status).toBe(429)
    expect(over.json.error).toMatchObject({ code: 'rate_limited', window: 'minute' })
    expect(over.json.error.message).toContain(`${AGENT_KEY_MAX_PER_MINUTE} requests per minute`)
    const retry = over.json.error.retry_after_s
    expect(Number.isInteger(retry)).toBe(true)
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(60)
    expect(over.headers['retry-after']).toBe(String(retry))
    expect(over.headers['cache-control']).toBe('no-store')
    expect(Object.keys(over.json.error).sort()).toEqual(['code', 'message', 'retry_after_s', 'window'])
    // A refused request is counted as refused, never as a request: the limit does not move.
    expect(await totalsOf(id)).toEqual({ requests: AGENT_KEY_MAX_PER_MINUTE, refused: 1, rows: 1 })
    expect((await get(key, '/scans')).status).toBe(429)
    expect((await call('GET', '/api/health/db', { token: key })).status).toBe(429)
    expect(await totalsOf(id)).toEqual({ requests: AGENT_KEY_MAX_PER_MINUTE, refused: 3, rows: 1 })
  })

  it('refuses every endpoint of the agent API, with the same answer, before the rest of the request is looked at', async () => {
    const { id, key } = await newKey()
    await putKeyAtMinuteLimit(db.pool, id)
    for (const path of ['/health', '/schema', '/points', '/providers', '/scans', '/scans?limit=abc', '/scans?cursor=zzz']) {
      const r = await get(key, path)
      expect([r.status, r.json.error.code, r.json.error.window], path).toEqual([429, 'rate_limited', 'minute'])
    }
    // An unknown path and a wrong method need no key, so they are not counted and not limited.
    expect((await get(key, '/nope')).status).toBe(404)
    expect((await call('POST', '/api/agent/v1/points', { token: key, body: {} })).status).toBe(405)
  })

  it('does not limit a key for the minutes before this one, and does not count refused requests as requests', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    await putUsage(id, await minuteOf(-1), AGENT_KEY_MAX_PER_MINUTE) // a full minute, but not this one
    await putUsage(id, await minuteOf(), 3, 5000) // many refusals in this minute: they are not requests
    expect((await get(key)).status).toBe(200)
    expect(await usageOf(id).then((rows) => rows.map((r) => [r.requests, r.refused]))).toEqual([[AGENT_KEY_MAX_PER_MINUTE, 0], [4, 5000]])
  })

  it('is free again when the minute is over: the key is let through, and counts from a new row', async () => {
    const { id, key } = await newKey()
    await putKeyAtMinuteLimit(db.pool, id)
    expect((await get(key)).status).toBe(429)
    // The two minutes of the usage move one minute back each (the window passes): the minute of the request has no usage any more.
    await q(`update api_key_usage set minute = minute - interval '2 minutes' where key_id = $1`, [id])
    expect((await get(key)).status).toBe(200)
    const rows = await usageOf(id)
    expect(rows.reduce((n, r) => n + r.requests, 0)).toBe(AGENT_KEY_MAX_PER_MINUTE * 2 + 1)
  })

  it('limits the key that is over, and not the others', async () => {
    const spent = await newKey('spent')
    const fresh = await newKey('fresh')
    await putKeyAtMinuteLimit(db.pool, spent.id)
    expect((await get(spent.key)).status).toBe(429)
    expect((await get(fresh.key)).status).toBe(200)
  })

  it('keeps refusing a key that is over its limit for as long as the minute lasts, and never lets one through by asking again', async () => {
    const { id, key } = await newKey()
    await putKeyAtMinuteLimit(db.pool, id)
    for (let i = 0; i < 5; i++) expect((await get(key)).status).toBe(429)
    const rows = await usageOf(id)
    expect(rows.map((r) => r.requests)).toEqual([AGENT_KEY_MAX_PER_MINUTE, AGENT_KEY_MAX_PER_MINUTE]) // untouched
    expect(rows.reduce((n, r) => n + r.refused, 0)).toBe(5)
  })
})

describe('the limit of the building day', () => {
  it('refuses the request after the 2000th of the day, with the window "day" and the time to the next midnight of the building', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    await putUsage(id, await dayStart(), AGENT_KEY_MAX_PER_DAY - 1) // the first minute of the building's day
    expect((await get(key)).status).toBe(200) // the 2000th
    const over = await get(key)
    expect(over.status).toBe(429)
    expect(over.json.error).toMatchObject({ code: 'rate_limited', window: 'day' })
    expect(over.json.error.message).toContain(`${AGENT_KEY_MAX_PER_DAY} requests per building day`)
    expect(over.headers['retry-after']).toBe(String(over.json.error.retry_after_s))
    // Time left until the next midnight of the building, worked out here from the time of day (the guard counts to the next
    // midnight): within a few seconds, or an hour off on the two days of the year when the clocks change.
    const left = (await rowsOf(`select 86400 - extract(epoch from (now() at time zone $1)::time)::float as s`, [TIMEZONE]))[0].s
    const retry = over.json.error.retry_after_s
    const off = Math.min(Math.abs(retry - left), Math.abs(retry - left - 3600), Math.abs(retry - left + 3600))
    expect(off, `retry_after_s ${retry}, time left in the day ${left}`).toBeLessThanOrEqual(5)
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(25 * 3600)
    // The refusal is counted as refused; the day's requests did not move.
    expect(await totalsOf(id)).toMatchObject({ requests: AGENT_KEY_MAX_PER_DAY, refused: 1 })
  })

  it('adds up the minutes of the day: a key that spread its requests over the day is limited by the sum', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    const start = await dayStart()
    const spread = [0, 1, 2, 3].map((n) => new Date(start.getTime() + n * 60_000))
    for (const minute of spread) await putUsage(id, minute, AGENT_KEY_MAX_PER_DAY / 4) // none of them near the limit of a minute
    const over = await get(key)
    expect([over.status, over.json.error.window]).toEqual([429, 'day'])
  })

  it('names the day when a key is over both limits (it is the longer wait)', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    await putUsage(id, await dayStart(), AGENT_KEY_MAX_PER_DAY)
    await putUsage(id, await minuteOf(), AGENT_KEY_MAX_PER_MINUTE)
    const over = await get(key)
    expect([over.status, over.json.error.window]).toEqual([429, 'day'])
  })

  it('counts the day in the building\'s time zone: the last minute of yesterday is not today, the first minute of today is', async () => {
    await settleMinute()
    const start = await dayStart()
    const yesterday = await newKey('yesterday')
    await putUsage(yesterday.id, new Date(start.getTime() - 60_000), AGENT_KEY_MAX_PER_DAY)
    expect((await get(yesterday.key)).status, 'a full day, but the day before').toBe(200)
    const today = await newKey('today')
    await putUsage(today.id, start, AGENT_KEY_MAX_PER_DAY)
    expect((await get(today.key)).status, 'a full day, and it is today').toBe(429)
  })

  it('does not count the refused requests of the day as requests', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    await putUsage(id, await dayStart(), AGENT_KEY_MAX_PER_DAY - 1, 100_000)
    expect((await get(key)).status).toBe(200)
  })

  it('lets the key through again on the next day: the usage of earlier days is not summed', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    const start = await dayStart()
    for (const days of [1, 2, 30]) await putUsage(id, new Date(start.getTime() - days * 86_400_000 - 3_600_000), AGENT_KEY_MAX_PER_DAY)
    expect((await get(key)).status).toBe(200)
  })
})

describe('last_used_at', () => {
  it('is written by the first request, and not again within 5 minutes', async () => {
    const { id, key } = await newKey()
    expect(await lastUsedOf(id)).toBeNull()
    expect((await get(key)).status).toBe(200)
    const first = await lastUsedOf(id)
    expect(first).toBeInstanceOf(Date)
    expect(Math.abs(Date.now() - first.getTime())).toBeLessThan(30_000)
    // A second request, and a third: the time of the first stays (the row of the key is not written for every request).
    expect((await get(key)).status).toBe(200)
    expect((await get(key, '/scans')).status).toBe(200)
    expect((await lastUsedOf(id)).getTime()).toBe(first.getTime())
  })

  it('is written again once it is more than 5 minutes old, and not while it is 4 minutes old', async () => {
    const { id, key } = await newKey()
    await get(key)
    const set = (ago) => q(`update api_keys set last_used_at = now() - $2::interval where id = $1`, [id, ago])
    const stored = async () => (await lastUsedOf(id)).getTime()

    await set('4 minutes')
    const fourMinutesAgo = await stored()
    await get(key)
    expect(await stored(), 'a use 4 minutes ago is fresh enough').toBe(fourMinutesAgo)

    await set('6 minutes')
    const sixMinutesAgo = await stored()
    await get(key)
    expect(await stored(), 'a use 6 minutes ago is stale').toBeGreaterThan(sixMinutesAgo)
    expect(Date.now() - (await stored())).toBeLessThan(30_000)
  })

  it('is written for a request that is refused with 429 too (the key was presented), and is not touched for an unknown key', async () => {
    const { id, key } = await newKey()
    await putKeyAtMinuteLimit(db.pool, id)
    expect(await lastUsedOf(id)).toBeNull()
    expect((await get(key)).status).toBe(429)
    expect(await lastUsedOf(id)).toBeInstanceOf(Date)
  })
})

describe('a key that does not work writes nothing', () => {
  /** Both tables as they are, so that a request that must write nothing can be compared before and after. */
  const state = async () => ({
    usage: await rowsOf('select * from api_key_usage order by key_id, minute'),
    keys: await rowsOf('select id, last_used_at, revoked_at from api_keys order by id'),
  })

  it('answers api_key_invalid for an unknown key, with no usage row and no change to any key', async () => {
    await newKey() // so that the tables are not empty
    const before = await state()
    const unknown = API_KEY_PREFIX + randomBytes(32).toString('base64url')
    for (const path of ['/points', '/scans', '/schema']) {
      const r = await get(unknown, path)
      expect([r.status, r.json.error.code], path).toEqual([401, 'api_key_invalid'])
    }
    const health = await call('GET', '/api/health/db', { token: unknown })
    expect([health.status, health.json.error.code]).toEqual([401, 'api_key_invalid'])
    expect(await state()).toEqual(before)
  })

  it('answers api_key_invalid for a revoked key, with no usage row for it and its last use unchanged', async () => {
    const { id, key } = await newKey()
    expect((await get(key)).status).toBe(200)
    const lastUsed = await lastUsedOf(id)
    await revokeAgentKey(cookie, id)
    // Even a key that was at its limit when it was revoked is a 401, not a 429, and counts nothing.
    await putKeyAtMinuteLimit(db.pool, id)
    const before = await state()
    for (const path of ['/points', '/scans', '/health']) {
      const r = await get(key, path)
      expect([r.status, r.json.error.code], path).toEqual([401, 'api_key_invalid'])
    }
    expect((await call('GET', '/api/health/db', { token: key })).status).toBe(401)
    expect(await state()).toEqual(before)
    expect((await lastUsedOf(id)).getTime()).toBe(lastUsed.getTime())
  })

  it('answers without a key (api_key_required) or with one of the wrong shape without a database statement, so nothing is written', async () => {
    const before = await state()
    for (const token of [undefined, 'not-a-key', 'qrk_' + 'a'.repeat(200)]) {
      const r = await call('GET', '/api/agent/v1/points', token ? { token } : {})
      expect(r.status).toBe(401)
    }
    expect(await state()).toEqual(before)
  })

  it('keeps the usage of a revoked key (revoking is not deleting) and drops it when the key is deleted', async () => {
    await settleMinute()
    const { id, key } = await newKey()
    await get(key)
    await get(key)
    expect((await totalsOf(id)).requests).toBe(2)

    await revokeAgentKey(cookie, id)
    expect((await totalsOf(id)).requests, 'revoked: the rows stay').toBe(2)

    const deleted = await call('DELETE', `/api/admin/api-keys/${id}`, { cookie })
    expect(deleted.status).toBe(200)
    expect(await usageOf(id), 'deleted: its usage goes with it').toEqual([])
  })

  it('takes the usage of a deleted key with it even when the key was never revoked, and the key then gets a 401', async () => {
    const { id, key } = await newKey()
    await get(key)
    expect((await totalsOf(id)).requests).toBe(1)
    expect((await call('DELETE', `/api/admin/api-keys/${id}`, { cookie })).status).toBe(200)
    expect(await usageOf(id)).toEqual([])
    const r = await get(key)
    expect([r.status, r.json.error.code]).toEqual([401, 'api_key_invalid'])
    expect(await usageOf(id)).toEqual([])
  })

  it('answers every request of a key that is deleted while they are in flight with 200 or 401, never with a conflict or a server error', async () => {
    for (let round = 0; round < 4; round++) {
      const { id, key } = await newKey(`deleted while in use ${round}`)
      const requests = Array.from({ length: 6 }, () => get(key))
      const deletion = call('DELETE', `/api/admin/api-keys/${id}`, { cookie })
      const answers = await Promise.all(requests)
      expect((await deletion).status).toBe(200)
      for (const r of answers) {
        expect([200, 401], `${r.status} ${r.text}`).toContain(r.status)
        if (r.status === 401) expect(r.json.error.code).toBe('api_key_invalid')
      }
      expect(await usageOf(id), 'nothing of the deleted key is left').toEqual([])
    }
  })
})

describe('the Agent screen: how much each key is used (GET /api/admin/api-keys)', () => {
  const list = async () => (await call('GET', '/api/admin/api-keys', { cookie })).json
  const listed = async (id) => (await list()).api_keys.find((k) => k.id === id)
  const usageNumbers = (k) => ({ requests_today: k.requests_today, requests_7d: k.requests_7d, refused_30d: k.refused_30d })
  /** The midnight that began the building's day `days` days ago, as a Date (0 is the start of today). Whole local days, so a change of summer time does not move it. */
  const midnight = async (days) =>
    (
      await rowsOf(
        `select (date_trunc('day', now() at time zone $1) - make_interval(days => $2::int)) at time zone $1 as t`,
        [TIMEZONE, days],
      )
    )[0].t
  const before = (date, minutes = 1) => new Date(date.getTime() - minutes * 60_000)

  it('adds to each key its requests of today and of the last 7 days and its refused requests of the last 30 days, as numbers, and the limits to the answer', async () => {
    const { id } = await newKey('screen numbers')
    const { api_keys: keys, limits } = await list()
    expect(limits).toEqual({ per_minute: AGENT_KEY_MAX_PER_MINUTE, per_day: AGENT_KEY_MAX_PER_DAY })
    const k = keys.find((x) => x.id === id)
    // The fields that were there stay, and nothing else comes with the new ones (never the hash of the key).
    expect(Object.keys(k).sort()).toEqual(
      ['created_at', 'id', 'key_prefix', 'last_used_at', 'name', 'refused_30d', 'requests_7d', 'requests_today', 'revoked_at'],
    )
    for (const field of ['requests_today', 'requests_7d', 'refused_30d']) expect(typeof k[field], field).toBe('number')
  })

  it('shows zeros for a key that was never used, and for a key whose usage is all older than the windows', async () => {
    const fresh = await newKey('never used')
    expect(usageNumbers(await listed(fresh.id))).toEqual({ requests_today: 0, requests_7d: 0, refused_30d: 0 })
    const old = await newKey('used long ago')
    await putUsage(old.id, before(await midnight(29)), 40, 9) // the last minute before the 30-day window: outside every window
    await putUsage(old.id, await midnight(60), 40, 9)
    await putUsage(old.id, await midnight(89), 40, 9)
    expect(usageNumbers(await listed(old.id))).toEqual({ requests_today: 0, requests_7d: 0, refused_30d: 0 })
  })

  it("counts the building's day from its midnight: the first minute of today is today, the last minute of yesterday is not (but is in the 7 days)", async () => {
    await settleMinute()
    const { id } = await newKey('day boundary')
    const start = await midnight(0)
    await putUsage(id, before(start), 11) // yesterday, 23:59 in the building
    await putUsage(id, start, 5) // today, 00:00
    await putUsage(id, new Date(start.getTime() + 60_000), 7) // today, 00:01
    expect(usageNumbers(await listed(id))).toEqual({ requests_today: 12, requests_7d: 23, refused_30d: 0 })
  })

  it('counts the last 7 building days with today as the first of them: the midnight 6 days back is in, the minute before it is out', async () => {
    await settleMinute()
    const { id } = await newKey('7 days')
    const edge = await midnight(6)
    await putUsage(id, before(edge), 100) // the last minute before the 7-day window: outside
    await putUsage(id, edge, 13) // 6 days back, 00:00: the first minute of the window
    await putUsage(id, await midnight(3), 4)
    await putUsage(id, await midnight(0), 2)
    expect(usageNumbers(await listed(id))).toEqual({ requests_today: 2, requests_7d: 19, refused_30d: 0 })
  })

  it('counts refused requests over the last 30 building days: the midnight 29 days back is in, the minute before it is out, and they are not requests', async () => {
    await settleMinute()
    const { id } = await newKey('30 days')
    const edge = await midnight(29)
    await putUsage(id, before(edge), 50, 5) // the last minute before the 30-day window: outside
    await putUsage(id, edge, 3, 3) // 29 days back, 00:00: the first minute of the window
    await putUsage(id, await midnight(10), 1, 4)
    await putUsage(id, await midnight(0), 2, 1)
    await putUsage(id, await midnight(45), 9, 8)
    expect(usageNumbers(await listed(id))).toEqual({ requests_today: 2, requests_7d: 2, refused_30d: 8 })
  })

  it("keeps one key's numbers apart from another's, and shows them for a revoked key too", async () => {
    await settleMinute()
    const a = await newKey('key a')
    const b = await newKey('key b')
    const start = await midnight(0)
    await putUsage(a.id, start, 10, 1)
    await putUsage(b.id, start, 3, 0)
    await revokeAgentKey(cookie, b.id)
    expect(usageNumbers(await listed(a.id))).toEqual({ requests_today: 10, requests_7d: 10, refused_30d: 1 })
    const revoked = await listed(b.id)
    expect(revoked.revoked_at).not.toBeNull()
    expect(usageNumbers(revoked)).toEqual({ requests_today: 3, requests_7d: 3, refused_30d: 0 })
  })

  it('agrees with the guard: the requests that the daily limit counts are the requests of today, and a refusal shows as refused, never as a request', async () => {
    await settleMinute()
    const { id, key } = await newKey('agrees with the guard')
    await putUsage(id, await midnight(0), AGENT_KEY_MAX_PER_DAY - 2)
    expect(usageNumbers(await listed(id))).toEqual({
      requests_today: AGENT_KEY_MAX_PER_DAY - 2, requests_7d: AGENT_KEY_MAX_PER_DAY - 2, refused_30d: 0,
    })
    expect((await get(key)).status).toBe(200) // the 1999th
    expect((await get(key)).status).toBe(200) // the 2000th
    expect((await get(key)).status, 'over the daily limit').toBe(429)
    expect((await get(key)).status).toBe(429)
    expect(usageNumbers(await listed(id))).toEqual({
      requests_today: AGENT_KEY_MAX_PER_DAY, requests_7d: AGENT_KEY_MAX_PER_DAY, refused_30d: 2,
    })
  })

  it('counts the requests that a key really makes', async () => {
    await settleMinute()
    const { id, key } = await newKey('real requests')
    for (let i = 0; i < 3; i++) expect((await get(key)).status).toBe(200)
    expect(usageNumbers(await listed(id))).toEqual({ requests_today: 3, requests_7d: 3, refused_30d: 0 })
  })

  it('keeps the order of the list (the newest key first) and answers a committee member only', async () => {
    const first = await newKey('order first')
    const second = await newKey('order second')
    const ids = (await list()).api_keys.map((k) => k.id)
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id))
    expect((await call('GET', '/api/admin/api-keys')).status).toBe(401)
    expect((await call('GET', '/api/admin/api-keys', { token: first.key })).status).toBe(401)
  })
})
