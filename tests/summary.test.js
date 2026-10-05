// The daily summary of the last 24 hours (server/summary.js, GET /api/cron/daily-summary, docs/adr/0007, step 2): it reads
// the recorded errors, the retention job, the refused visits, the phones and the sign-ins, decides a verdict, and the route
// pings the owner's check on healthchecks.io with a short plain-text body. This file proves:
//   - each section (a) to (g) counts what is inside the 24 hours and nothing just outside them, cuts its list to the top 5,
//     and reads from the right source;
//   - each cause of a failure alone makes the verdict `fail` with its own reason, a day with only information (refusals, slow
//     requests, visits not counted, outdated phones) is `ok`, and the thresholds are the ones that the owner decided;
//   - the retention row counts as fresh at 25 hours and not at 27, and a sign-in spike is a count of at least 5 that is more than
//     3 times the median, with a median of 0 handled as the task says;
//   - the body: the first line, DD/MM/YYYY HH:MM in the building's time, one line for each section that has something, the top 5
//     cut, far below 8 kB, and never a name, an e-mail, a QR code, the label of a phone, an id or a message (they are seeded on purpose);
//   - everything is read in one read-only transaction;
//   - through the route (with the cron secret and a fetch that is replaced by a fake: nothing reaches the network): a failure goes
//     to /fail and a good day to the base address, nothing is sent without HEALTH_HEARTBEAT_URL, a database that cannot be read
//     is a 503 with one /fail ping and no app_errors row, and the answer and the log line hold counts only;
//   - vercel.json has both cron jobs, once a day each, and each names a route that exists.
// It runs against the throwaway schema like the other API tests. The data is fake. audit_log and scan_refusals are append-only
// (their rows cannot be deleted), so each test works at a moment of its own, far from the others (freshNow), and the rows that it
// seeds are placed relative to that moment: the summary of one test never sees the rows of another.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setupDb, call } from './helpers.js'
import { getPool, setPool } from '../server/db.js'
import { routeTable } from '../server/router.js'
import { buildSummary, summaryText, summaryCounts, REASONS } from '../server/summary.js'
import {
  SUMMARY_PERIOD_HOURS,
  SUMMARY_TOP,
  SUMMARY_RETENTION_MAX_AGE_HOURS,
  SUMMARY_STUCK_PHONE_HOURS,
  SUMMARY_SIGNIN_BASELINE_DAYS,
  SUMMARY_SIGNIN_SPIKE_MIN,
  SUMMARY_SIGNIN_SPIKE_FACTOR,
  HEARTBEAT_BODY_MAX_BYTES,
} from '../server/config.js'
import { formatDateTime } from '../shared/datetime.js'

const H = 60 * 60 * 1000
const D = 24 * H

// Fake on purpose: the host ends in .test, and the "uuid" is made up. A real address is a secret and never goes in a file.
const ADDRESS = 'https://hc.example.test/ping/00000000-0000-4000-8000-0000000000cc'
const SECRET = 'summary-test-cron-secret-0123456789abcdefghijklmnop'

// Everything personal that the database of this file holds. None of it may ever be in a body, a log line or an answer.
const PERSON = {
  company: 'Fake Cleaning Company Ltd',
  contact: 'Fake Contact Person',
  email: 'fake.member@example.test',
  committee: 'Fake Committee Member',
  label: 'Fake Phone Label Samsung Browser',
  point: 'Fake Point Lobby',
  qr: 'BQR-FAKE-QR-TOKEN-0123456789',
  requestId: 'fra1::iad1::fakereq-1700000000000-0123456789ab',
}
let deviceId
let pointId
let providerId

let db
const q = (text, params) => db.pool.query(text, params)

beforeAll(async () => {
  db = await setupDb()
  providerId = (
    await q('insert into providers (company, contact_name) values ($1, $2) returning id', [PERSON.company, PERSON.contact])
  ).rows[0].id
  pointId = (await q('insert into points (name, qr_token) values ($1, $2) returning id', [PERSON.point, PERSON.qr])).rows[0].id
  await q('insert into admins (email, name) values ($1, $2)', [PERSON.email, PERSON.committee])
  deviceId = randomUUID()
})
afterAll(async () => db?.teardown())

let savedEnv
beforeEach(async () => {
  savedEnv = {
    HEALTH_HEARTBEAT_URL: process.env.HEALTH_HEARTBEAT_URL,
    CRON_SECRET: process.env.CRON_SECRET,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  }
  delete process.env.VERCEL_GIT_COMMIT_SHA
  // The two tables that a test may empty. (audit_log and scan_refusals are append-only: see the header.)
  await q('with a as (delete from app_errors), b as (delete from provider_devices) select 1')
})
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setPool(db.pool)
})

// ---- time ------------------------------------------------------------------------------------------------------------

// A moment of its own for each test: 04:00 UTC, every 45 days from 01/01/2021. The summary looks 24 hours back for the period and
// 14 more days for the median, so two such moments never see each other's rows.
let tick = 0
const freshNow = () => new Date(Date.UTC(2021, 0, 1, 4, 0, 0) + 45 * D * ++tick)
const periodStart = (now) => new Date(now.getTime() - SUMMARY_PERIOD_HOURS * H)
const back = (now, ms) => new Date(now.getTime() - ms)

// ---- seeding ---------------------------------------------------------------------------------------------------------

/** Recorded events (app_errors). One row each: two with the same key in the same hour would collide, as in the real table. */
async function seedEvents(events) {
  const rows = events.map((e) => ({
    source: 'server', kind: 'error', code: '', build: '', method: '', status: 0, n: 1, rid: null, ...e, at: e.at.toISOString(),
  }))
  await q(
    `insert into app_errors (bucket, source, kind, place, method, status, code, app_build, count, first_at, last_at, last_request_id)
     select date_trunc('hour', t.at), t.source, t.kind, t.place, t.method, t.status, t.code, t.build, t.n, t.at, t.at, t.rid
       from jsonb_to_recordset($1::jsonb) as t(at timestamptz, source text, kind text, place text, method text, status int,
                                                code text, build text, n int, rid text)`,
    [JSON.stringify(rows)],
  )
}

/** Rows of audit_log. `detail` is an object or null. */
async function seedAudit(rows) {
  await q(
    `insert into audit_log (at, actor_type, actor_id, actor_name, action, detail)
     select t.at, t.actor_type, t.actor_id, t.actor_name, t.action, t.detail
       from jsonb_to_recordset($1::jsonb) as t(at timestamptz, actor_type text, actor_id text, actor_name text, action text, detail jsonb)`,
    [JSON.stringify(rows.map((r) => ({ actor_id: null, actor_name: null, detail: null, ...r, at: r.at.toISOString() })))],
  )
}

const COUNTS = { sessions: 0, login_attempts: 0, device_labels: 0, app_errors: 0, alert_pings: 0 }
const retentionRow = (at, counts = COUNTS) => ({ at, actor_type: 'system', action: 'retention.run', detail: counts })
const signInRow = (at) => ({
  at, actor_type: 'admin', actor_id: randomUUID(), actor_name: PERSON.committee, action: 'session.sign_in', detail: { email: PERSON.email },
})
/** The retention job ran 2 hours before `now`: the summary of a day that has nothing else to say is then `ok`. */
const retentionRan = (now) => seedAudit([retentionRow(back(now, 2 * H))])

/** Provider phones. `now` fixes the defaults: a phone made 200 days ago (so it is not "new"), holding nothing, active. */
async function seedPhones(now, list) {
  const rows = list.map((p) => ({
    token: `token-${randomUUID()}`, label: PERSON.label, created: back(now, 200 * D), revoked: null, build: null, waiting: null,
    oldest: null, sync: null, ...p,
  }))
  await q(
    `insert into provider_devices (provider_id, token_hash, label, created_at, revoked_at, app_build, waiting_count, oldest_waiting_at, last_sync_at)
     select $1, t.token, t.label, t.created, t.revoked, t.build, t.waiting, t.oldest, t.sync
       from jsonb_to_recordset($2::jsonb) as t(token text, label text, created timestamptz, revoked timestamptz, build text,
                                               waiting int, oldest timestamptz, sync timestamptz)`,
    [providerId, JSON.stringify(rows)],
  )
}

/** Refused visits (scan_refusals), one for each `{ at, code }`, with the names and ids of fake people. */
async function seedRefusals(rows) {
  await q(
    `insert into scan_refusals (at, source, code, provider_id, provider_name, device_id, point_id, point_name)
     select t.at, 'online', t.code, $1, $2, $3, $4, $5 from jsonb_to_recordset($6::jsonb) as t(at timestamptz, code text)`,
    [providerId, `${PERSON.company} / ${PERSON.contact}`, deviceId, pointId, PERSON.point, JSON.stringify(rows.map((r) => ({ ...r, at: r.at.toISOString() })))],
  )
}

/** `n` moments inside the period, a minute apart, starting one hour after its start. */
const within = (now, n) => Array.from({ length: n }, (_, i) => new Date(periodStart(now).getTime() + H + i * 60_000))
/** The moments of the baseline: `perDay[j]` of them in the middle of the (j+1)-th day before the period. */
const baseline = (now, perDay) =>
  perDay.flatMap((count, j) =>
    Array.from({ length: count }, (_, i) => new Date(periodStart(now).getTime() - (j + 1) * D + 12 * H + i * 1000)),
  )
const times = (...lists) => lists.flat()
const newPhones = (now, moments) => seedPhones(now, moments.map((created) => ({ created })))
const committeeSignIns = (moments) => seedAudit(moments.map(signInRow))

// ---- the thresholds are the owner's decision ---------------------------------------------------------------------------------

describe('the thresholds that decide a failure', () => {
  it('are 24 hours, the top 5, 26 hours for the retention job, 24 hours for a stuck phone, and a spike of 5 and 3 times the median of 14 days', () => {
    // A change here changes when the owner is told: it needs the owner's decision (server/config.js).
    expect([
      SUMMARY_PERIOD_HOURS,
      SUMMARY_TOP,
      SUMMARY_RETENTION_MAX_AGE_HOURS,
      SUMMARY_STUCK_PHONE_HOURS,
      SUMMARY_SIGNIN_BASELINE_DAYS,
      SUMMARY_SIGNIN_SPIKE_MIN,
      SUMMARY_SIGNIN_SPIKE_FACTOR,
    ]).toEqual([24, 5, 26, 24, 14, 5, 3])
  })

  it('the reasons are a fixed list of words', () => {
    expect(REASONS).toEqual(['server_error', 'app_crash', 'retention_missing', 'stuck_phone', 'signin_spike'])
  })
})

// ---- (a) server errors -----------------------------------------------------------------------------------------------------

describe('(a) server errors', () => {
  it('adds up the count by route and code over the period, and nothing from just outside it', async () => {
    const now = freshNow()
    const from = periodStart(now)
    await seedEvents([
      { place: '/scans/sync', code: '57014', n: 3, at: back(now, 2 * H), method: 'POST', status: 500, build: 'abc1234' },
      // The same route and code in another hour, with another method, status and build: one kind, the counts added up.
      { place: '/scans/sync', code: '57014', n: 4, at: back(now, 9 * H), method: 'GET', status: 503, build: 'def5678' },
      { place: '/admin/points/:id', code: 'XX000', n: 2, at: back(now, 5 * H) },
      // The edges: the start of the period is in, a second before it is out, and so is anything after `now`.
      { place: '/edge/in', code: 'E1', n: 10, at: from },
      { place: '/edge/out', code: 'E2', n: 100, at: new Date(from.getTime() - 1000) },
      { place: '/edge/future', code: 'E3', n: 1000, at: new Date(now.getTime() + 1000) },
    ])
    const { server } = await buildSummary({ now })
    expect(server.total).toBe(3 + 4 + 2 + 10)
    expect(server.kinds).toBe(3)
    expect(server.top.map(({ place, code, n }) => ({ place, code, n }))).toEqual([
      { place: '/edge/in', code: 'E1', n: 10 },
      { place: '/scans/sync', code: '57014', n: 7 },
      { place: '/admin/points/:id', code: 'XX000', n: 2 },
    ])
  })

  it('counts only the errors of the server in (a): a refusal, a slow request and a crash of the server are not server errors', async () => {
    const now = freshNow()
    await seedEvents([
      { place: '/a', code: 'X1', n: 1, at: back(now, H) },
      { place: '/b', kind: 'slow', code: '', n: 50, at: back(now, H) },
      { place: '/c', kind: 'refusal', code: 'not_assigned', n: 60, at: back(now, H) },
      { place: '/d', kind: 'crash', code: 'X', n: 70, at: back(now, H) },
      { place: 'scan', source: 'provider_app', kind: 'error', code: 'X', n: 80, at: back(now, H) },
    ])
    const { server, apps, noted } = await buildSummary({ now })
    expect(server.total).toBe(1)
    expect(apps.total).toBe(80) // an app's `error` is in (b)
    expect(noted.total).toBe(110)
  })

  it('lists the top 5 and says how many kinds there are, the most frequent first, and ties by route', async () => {
    const now = freshNow()
    await seedEvents(
      ['/g', '/f', '/e', '/d', '/c', '/b', '/a'].map((place, i) => ({ place, code: 'X1', n: i < 2 ? 5 : 1, at: back(now, H) })),
    )
    const { server } = await buildSummary({ now })
    expect(server.total).toBe(5 + 5 + 5 * 1)
    expect(server.kinds).toBe(7)
    // /g and /f have 5 each (alphabetical), then the five of 1 each: /a, /b, /c ... of which only three fit.
    expect(server.top.map((r) => r.place)).toEqual(['/f', '/g', '/a', '/b', '/c'])
    expect(server.top).toHaveLength(SUMMARY_TOP)
  })
})

// ---- (b) the apps' errors ---------------------------------------------------------------------------------------------------

describe("(b) the apps' errors", () => {
  it('groups the provider app and the committee app by app, kind, screen, code and build, and fails only for a crash or an unhandled error', async () => {
    const now = freshNow()
    await seedEvents([
      { source: 'provider_app', kind: 'crash', place: 'scan', code: 'TypeError', build: 'abc1234', n: 2, at: back(now, 3 * H) },
      { source: 'provider_app', kind: 'crash', place: 'scan', code: 'TypeError', build: 'def5678', n: 1, at: back(now, 4 * H) }, // another build
      { source: 'committee_app', kind: 'unhandled', place: 'providers', code: 'Error', build: 'abc1234', n: 3, at: back(now, 5 * H) },
      { source: 'provider_app', kind: 'signed_out', place: 'scan', code: '', build: 'abc1234', n: 9, at: back(now, 6 * H) },
      { source: 'committee_app', kind: 'error', place: 'points', code: 'network', build: '', n: 4, at: back(now, 7 * H) },
      { source: 'provider_app', kind: 'crash', place: 'old', code: 'X', n: 100, at: back(now, 25 * H) }, // outside the period
    ])
    const { apps } = await buildSummary({ now })
    expect(apps.total).toBe(2 + 1 + 3 + 9 + 4)
    expect(apps.crashes).toBe(2 + 1 + 3)
    expect(apps.kinds).toBe(5)
    expect(apps.top.map(({ source, kind, place, code, build, n }) => [source, kind, place, code, build, n])).toEqual([
      ['provider_app', 'signed_out', 'scan', '', 'abc1234', 9],
      ['committee_app', 'error', 'points', 'network', '', 4],
      ['committee_app', 'unhandled', 'providers', 'Error', 'abc1234', 3],
      ['provider_app', 'crash', 'scan', 'TypeError', 'abc1234', 2],
      ['provider_app', 'crash', 'scan', 'TypeError', 'def5678', 1],
    ])
  })

  it('counts the crashes of the whole list, also when the crash is not among the top 5', async () => {
    const now = freshNow()
    await seedEvents([
      ...['a', 'b', 'c', 'd', 'e'].map((place) => ({ source: 'provider_app', kind: 'signed_out', place, n: 10, at: back(now, H) })),
      { source: 'committee_app', kind: 'crash', place: 'z', code: 'Error', n: 1, at: back(now, H) },
    ])
    await retentionRan(now)
    const summary = await buildSummary({ now })
    expect(summary.apps.top.map((r) => r.kind)).not.toContain('crash')
    expect(summary.apps.crashes).toBe(1)
    expect(summary.verdict).toBe('fail')
    expect(summary.reasons).toEqual(['app_crash'])
  })
})

// ---- (c) refusals and slow requests -----------------------------------------------------------------------------------------

describe('(c) refusals and slow requests', () => {
  it('lists the refusals and the slow requests of any source by source, kind, place and code, inside the period only', async () => {
    const now = freshNow()
    await seedEvents([
      { source: 'server', kind: 'slow', place: '/admin/scans', code: '', n: 4, at: back(now, H), build: 'abc1234' },
      { source: 'server', kind: 'slow', place: '/admin/scans', code: '', n: 2, at: back(now, 7 * H), build: 'def5678' }, // another build: the same kind
      { source: 'provider_app', kind: 'refusal', place: 'scan', code: 'not_assigned', n: 7, at: back(now, 2 * H) },
      { source: 'committee_app', kind: 'refusal', place: 'points', code: 'forbidden', n: 1, at: back(now, 3 * H) },
      { source: 'server', kind: 'refusal', place: '/scan', code: 'point_inactive', n: 50, at: back(now, 30 * H) }, // outside
    ])
    const { noted, apps, server } = await buildSummary({ now })
    expect(noted.total).toBe(7 + 6 + 1)
    expect(noted.kinds).toBe(3)
    expect(noted.top.map(({ source, kind, place, code, n }) => [source, kind, place, code, n])).toEqual([
      ['provider_app', 'refusal', 'scan', 'not_assigned', 7],
      ['server', 'slow', '/admin/scans', '', 6],
      ['committee_app', 'refusal', 'points', 'forbidden', 1],
    ])
    // They are in no other list.
    expect(apps.total).toBe(0)
    expect(server.total).toBe(0)
  })
})

// ---- (d) the retention job --------------------------------------------------------------------------------------------------

describe('(d) the retention job', () => {
  it('ran when its row is 25 hours old, and shows its counts', async () => {
    const now = freshNow()
    await seedAudit([retentionRow(back(now, 25 * H), { sessions: 3, login_attempts: 1, device_labels: 0, app_errors: 7, alert_pings: 2 })])
    const { retention, verdict } = await buildSummary({ now })
    expect(retention.ran).toBe(true)
    expect(retention.at).toEqual(back(now, 25 * H))
    expect(retention.counts).toEqual({ sessions: 3, login_attempts: 1, device_labels: 0, app_errors: 7, alert_pings: 2 })
    expect(verdict).toBe('ok')
  })

  it('did not run when its row is 27 hours old: a failure, with the time of the last run', async () => {
    const now = freshNow()
    await seedAudit([retentionRow(back(now, 27 * H))])
    const summary = await buildSummary({ now })
    expect(summary.retention.ran).toBe(false)
    expect(summary.retention.at).toEqual(back(now, 27 * H))
    expect(summary.verdict).toBe('fail')
    expect(summary.reasons).toEqual(['retention_missing'])
    expect(summaryText(summary)).toContain(`Retention job: DID NOT RUN, no run in the last 26 hours (the last one was ${formatDateTime(back(now, 27 * H))})`)
  })

  it('is exactly 26 hours the limit: 25 hours 59 minutes ran, 26 hours did not', async () => {
    const edge = freshNow()
    await seedAudit([retentionRow(back(edge, 26 * H - 60_000))])
    expect((await buildSummary({ now: edge })).retention.ran).toBe(true)
    const over = freshNow()
    await seedAudit([retentionRow(back(over, 26 * H))])
    expect((await buildSummary({ now: over })).retention.ran).toBe(false)
  })

  it('did not run when no row at all is recorded, and says so', async () => {
    // Before every moment that the other tests use, so that no row of theirs is older than this one (the table keeps them).
    const now = new Date('2019-06-01T04:00:00Z')
    const summary = await buildSummary({ now })
    expect(summary.retention).toEqual({ ran: false, at: null, counts: null })
    expect(summary.reasons).toEqual(['retention_missing'])
    expect(summaryText(summary)).toContain('Retention job: DID NOT RUN, no run in the last 26 hours (no run is recorded)')
  })

  it('reads the newest row, and ignores one that is in the future and the rows of other actions', async () => {
    const now = freshNow()
    await seedAudit([
      retentionRow(back(now, 40 * H), { ...COUNTS, sessions: 1 }),
      retentionRow(back(now, 3 * H), { ...COUNTS, sessions: 2 }),
      retentionRow(new Date(now.getTime() + H), { ...COUNTS, sessions: 3 }), // from the future of this moment
      { at: back(now, H), actor_type: 'admin', action: 'point.update', detail: { name: PERSON.point } },
    ])
    const { retention } = await buildSummary({ now })
    expect(retention.ran).toBe(true)
    expect(retention.at).toEqual(back(now, 3 * H))
    expect(retention.counts.sessions).toBe(2)
  })

  it('shows only the whole numbers that the job writes, and nothing else of its row', async () => {
    const now = freshNow()
    await seedAudit([retentionRow(back(now, H), { sessions: 4, login_attempts: 'many', device_labels: 1.5, extra: 9, app_errors: 0 })])
    const { retention } = await buildSummary({ now })
    expect(retention.counts).toEqual({ sessions: 4, app_errors: 0 })
    expect(summaryText(await buildSummary({ now }))).toContain(`ran ${formatDateTime(back(now, H))} (sessions 4, app errors 0)`)
  })
})

// ---- (e) visits not counted -------------------------------------------------------------------------------------------------

describe('(e) visits not counted', () => {
  it('counts the refused visits of the period by code, and not those just outside it', async () => {
    const now = freshNow()
    const from = periodStart(now)
    await seedRefusals([
      { at: back(now, H), code: 'not_assigned' },
      { at: back(now, 2 * H), code: 'not_assigned' },
      { at: back(now, 3 * H), code: 'point_inactive' },
      { at: from, code: 'edge_in' }, // the start of the period is in
      { at: new Date(from.getTime() - 1000), code: 'edge_out' },
      { at: new Date(now.getTime() + 1000), code: 'edge_future' },
    ])
    const { refusals } = await buildSummary({ now })
    expect(refusals.total).toBe(4)
    expect(refusals.kinds).toBe(3)
    expect(refusals.top).toEqual([
      { code: 'not_assigned', n: 2 },
      { code: 'edge_in', n: 1 },
      { code: 'point_inactive', n: 1 },
    ])
  })

  it('cuts the list to the top 5 and says how many codes there are', async () => {
    const now = freshNow()
    await seedRefusals(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'].map((code, i) => ({ at: back(now, H + i * 1000), code })))
    const { refusals } = await buildSummary({ now })
    expect(refusals.total).toBe(7)
    expect(refusals.kinds).toBe(7)
    expect(refusals.top.map((r) => r.code)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })
})

// ---- (f) phones -------------------------------------------------------------------------------------------------------------

describe('(f) phones', () => {
  it('a phone is stuck when it is active, visits wait on it, and the oldest is more than 24 hours old', async () => {
    const now = freshNow()
    await seedPhones(now, [
      { waiting: 3, oldest: back(now, 25 * H) }, // stuck
      { waiting: 1, oldest: new Date(now.getTime() - 24 * H - 1000) }, // stuck, by a second
      { waiting: 1, oldest: back(now, 24 * H) }, // exactly 24 hours: not more than
      { waiting: 1, oldest: back(now, 23 * H) },
      { waiting: 0, oldest: back(now, 100 * H) }, // nothing waits
      { waiting: null, oldest: back(now, 100 * H) }, // never reported
      { waiting: 5, oldest: null }, // no time for the oldest
      { waiting: 5, oldest: back(now, 100 * H), revoked: back(now, 3 * D) }, // revoked
    ])
    const { phones, verdict, reasons } = await buildSummary({ now })
    expect(phones.stuck).toBe(2)
    expect(phones.stuckUploading).toBe(0)
    expect(verdict).toBe('fail')
    expect(reasons).toContain('stuck_phone')
  })

  it('counts how many stuck phones uploaded in the period and are still stuck (they upload but do not drain)', async () => {
    const now = freshNow()
    const from = periodStart(now)
    await seedPhones(now, [
      { waiting: 2, oldest: back(now, 50 * H), sync: back(now, H) }, // uploaded in the period
      { waiting: 2, oldest: back(now, 50 * H), sync: from }, // the start of the period is in
      { waiting: 2, oldest: back(now, 50 * H), sync: new Date(from.getTime() - 1000) }, // a second before
      { waiting: 2, oldest: back(now, 50 * H), sync: null }, // never uploaded
      { waiting: 0, oldest: null, sync: back(now, H) }, // uploaded and drained: not stuck at all
    ])
    const { phones } = await buildSummary({ now })
    expect(phones.stuck).toBe(4)
    expect(phones.stuckUploading).toBe(2)
  })

  it("counts the active phones that report another build than the server's, and none when the server does not know its own", async () => {
    const now = freshNow()
    await seedPhones(now, [
      { build: 'abcdef1' }, // the server's
      { build: 'abcdef1' },
      { build: '1111111' }, // outdated
      { build: 'dev' }, // outdated
      { build: null }, // never reported: not counted
      { build: '2222222', revoked: back(now, D) }, // revoked: not counted
    ])
    await retentionRan(now)
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
    const known = await buildSummary({ now })
    expect(known.phones.outdated).toBe(2)
    expect(known.phones.build).toBe('abcdef1')
    expect(known.verdict).toBe('ok') // an outdated phone is information

    delete process.env.VERCEL_GIT_COMMIT_SHA
    const unknown = await buildSummary({ now })
    expect(unknown.phones.outdated).toBe(0)
    expect(unknown.phones.build).toBeNull()
  })
})

// ---- (g) sign-ins -----------------------------------------------------------------------------------------------------------

describe('(g) sign-ins', () => {
  it('counts the new phones and the committee sign-ins of the period, from its start to now, and not a second outside', async () => {
    const now = freshNow()
    const from = periodStart(now)
    await newPhones(now, [from, back(now, H), now, new Date(from.getTime() - 1000), new Date(now.getTime() + 1000)])
    await seedPhones(now, [{ created: back(now, 2 * H), revoked: back(now, H) }]) // revoked after it signed in: still a new phone
    await committeeSignIns([from, now, new Date(from.getTime() - 1000), new Date(now.getTime() + 1000)])
    const { signIns } = await buildSummary({ now })
    expect(signIns.phones.n).toBe(4)
    expect(signIns.committee.n).toBe(2)
  })

  it('a median of 0 with 4 sign-ins is not a spike, and with 5 it is', async () => {
    const four = freshNow()
    await newPhones(four, within(four, 4))
    await committeeSignIns(within(four, 4))
    const quiet = await buildSummary({ now: four })
    expect(quiet.signIns.phones).toEqual({ n: 4, median: 0, spike: false })
    expect(quiet.signIns.committee).toEqual({ n: 4, median: 0, spike: false })

    const five = freshNow()
    await newPhones(five, within(five, 5))
    await committeeSignIns(within(five, 5))
    const spike = await buildSummary({ now: five })
    expect(spike.signIns.phones).toEqual({ n: 5, median: 0, spike: true })
    expect(spike.signIns.committee).toEqual({ n: 5, median: 0, spike: true })
    expect(spike.reasons).toContain('signin_spike')
  })

  it('is a spike only when it is more than 3 times the median: 6 is not and 7 is, for a median of 2', async () => {
    const six = freshNow()
    await newPhones(six, times(baseline(six, new Array(14).fill(2)), within(six, 6)))
    await committeeSignIns(times(baseline(six, new Array(14).fill(2)), within(six, 6)))
    const at = await buildSummary({ now: six })
    expect(at.signIns.phones).toEqual({ n: 6, median: 2, spike: false })
    expect(at.signIns.committee).toEqual({ n: 6, median: 2, spike: false })

    const seven = freshNow()
    await newPhones(seven, times(baseline(seven, new Array(14).fill(2)), within(seven, 7)))
    await committeeSignIns(times(baseline(seven, new Array(14).fill(2)), within(seven, 7)))
    const over = await buildSummary({ now: seven })
    expect(over.signIns.phones).toEqual({ n: 7, median: 2, spike: true })
    expect(over.signIns.committee).toEqual({ n: 7, median: 2, spike: true })
  })

  it('a count of at least 5 is needed even when it is more than 3 times the median: 4 against a median of 1 is not a spike', async () => {
    const now = freshNow()
    await newPhones(now, times(baseline(now, new Array(14).fill(1)), within(now, 4)))
    const { signIns } = await buildSummary({ now })
    expect(signIns.phones).toEqual({ n: 4, median: 1, spike: false })
  })

  it('counts the days with no sign-in in the median, and takes the mean of the two middle days of the 14', async () => {
    const now = freshNow()
    // Seven days of 0 and seven days of 10: the middle two are 0 and 10, so the median is 5, and 15 is not more than 3 times it.
    const perDay = [0, 10, 0, 10, 0, 10, 0, 10, 0, 10, 0, 10, 0, 10]
    await newPhones(now, times(baseline(now, perDay), within(now, 15)))
    const { signIns } = await buildSummary({ now })
    expect(signIns.phones).toEqual({ n: 15, median: 5, spike: false })

    const more = freshNow()
    await newPhones(more, times(baseline(more, perDay), within(more, 16)))
    expect((await buildSummary({ now: more })).signIns.phones).toEqual({ n: 16, median: 5, spike: true })
  })

  it('uses the 14 days before the period, to the second, and the period is not part of its own median', async () => {
    const now = freshNow()
    const from = periodStart(now)
    // Seven days of 4 and seven days of 0 (the oldest of the 14 is 0): the median is 2. Then the edges, in both series:
    //  - from - 14 days is the first instant of the oldest day: in, so that day is 1 (the median becomes 2.5);
    //  - one second earlier is out (in the oldest day it would make 2, and the median 3);
    //  - one second before the start of the period is the day before it, and the start itself is the period (n is 4, not 5).
    const perDay = [4, 4, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0]
    const moments = [
      ...baseline(now, perDay),
      new Date(from.getTime() - 14 * D),
      new Date(from.getTime() - 14 * D - 1000),
      new Date(from.getTime() - 1000),
      from,
      ...within(now, 3),
    ]
    await newPhones(now, moments)
    await committeeSignIns(moments)
    const { signIns } = await buildSummary({ now })
    expect(signIns.phones).toEqual({ n: 4, median: 2.5, spike: false })
    expect(signIns.committee).toEqual({ n: 4, median: 2.5, spike: false })
  })

  it('judges the two counts on their own: a spike of new phones does not need one of the committee, and the reverse', async () => {
    const now = freshNow()
    await newPhones(now, within(now, 6))
    await committeeSignIns(within(now, 2))
    const { signIns } = await buildSummary({ now })
    expect(signIns.phones.spike).toBe(true)
    expect(signIns.committee.spike).toBe(false)
  })
})

// ---- the verdict ------------------------------------------------------------------------------------------------------------

describe('the verdict', () => {
  it('is ok when only information is there: refusals, slow requests, visits not counted, outdated phones and a few sign-ins', async () => {
    const now = freshNow()
    await retentionRan(now)
    await seedEvents([
      { source: 'server', kind: 'slow', place: '/admin/scans', n: 9, at: back(now, H) },
      { source: 'server', kind: 'refusal', place: '/scan', code: 'not_assigned', n: 9, at: back(now, H) },
      { source: 'provider_app', kind: 'refusal', place: 'scan', code: 'point_inactive', n: 9, at: back(now, H) },
      { source: 'provider_app', kind: 'signed_out', place: 'scan', n: 9, at: back(now, H) },
      { source: 'committee_app', kind: 'error', place: 'points', code: 'network', n: 9, at: back(now, H) },
    ])
    await seedRefusals([{ at: back(now, H), code: 'not_assigned' }, { at: back(now, H), code: 'unknown_code' }])
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567'
    await seedPhones(now, [{ build: '1111111' }, { build: 'dev', waiting: 2, oldest: back(now, 5 * H) }])
    await newPhones(now, within(now, 4))
    await committeeSignIns(within(now, 4))
    const summary = await buildSummary({ now })
    expect(summary.verdict).toBe('ok')
    expect(summary.reasons).toEqual([])
    expect(summary.noted.total).toBe(27)
    expect(summary.refusals.total).toBe(2)
    expect(summary.phones.outdated).toBe(2)
    expect(summaryText(summary).split('\n')[0]).toMatch(/^Daily summary OK: /)
  })

  // One cause at a time, each on top of a day that is otherwise good (the retention job ran).
  const CAUSES = [
    [
      'a server error',
      'server_error',
      (now) => seedEvents([{ place: '/scans/sync', code: '57014', at: back(now, H) }]),
    ],
    [
      'an app crash',
      'app_crash',
      (now) => seedEvents([{ source: 'provider_app', kind: 'crash', place: 'scan', code: 'TypeError', at: back(now, H) }]),
    ],
    [
      'an unhandled error of an app',
      'app_crash',
      (now) => seedEvents([{ source: 'committee_app', kind: 'unhandled', place: 'providers', code: 'Error', at: back(now, H) }]),
    ],
    ['a stuck phone', 'stuck_phone', (now) => seedPhones(now, [{ waiting: 4, oldest: back(now, 30 * H) }])],
    ['a sign-in spike of new phones', 'signin_spike', (now) => newPhones(now, within(now, 5))],
    ['a sign-in spike of the committee', 'signin_spike', (now) => committeeSignIns(within(now, 5))],
  ]
  for (const [name, reason, seed] of CAUSES) {
    it(`fails for ${name}, alone, with the reason ${reason}`, async () => {
      const now = freshNow()
      await retentionRan(now)
      const good = await buildSummary({ now })
      expect(good.verdict).toBe('ok')
      await seed(now)
      const summary = await buildSummary({ now })
      expect(summary.verdict).toBe('fail')
      expect(summary.reasons).toEqual([reason])
      expect(summaryText(summary).split('\n')[0]).toMatch(/^Daily summary FAIL: /)
    })
  }

  it('fails when the retention job did not run, alone, with the reason retention_missing', async () => {
    const now = freshNow()
    await seedAudit([retentionRow(back(now, 27 * H))])
    const summary = await buildSummary({ now })
    expect(summary.verdict).toBe('fail')
    expect(summary.reasons).toEqual(['retention_missing'])
  })

  it('gives every reason that holds, in the fixed order', async () => {
    const now = freshNow()
    await seedEvents([
      { place: '/scans/sync', code: '57014', at: back(now, H) },
      { source: 'provider_app', kind: 'crash', place: 'scan', code: 'TypeError', at: back(now, H) },
    ])
    await seedPhones(now, [{ waiting: 4, oldest: back(now, 30 * H) }])
    await newPhones(now, within(now, 5))
    const { verdict, reasons } = await buildSummary({ now })
    expect(verdict).toBe('fail')
    expect(reasons).toEqual(['server_error', 'app_crash', 'retention_missing', 'stuck_phone', 'signin_spike'])
  })

  it('has counts for the answer of the route: numbers and one boolean', async () => {
    const now = freshNow()
    await retentionRan(now)
    await seedEvents([{ place: '/a', code: 'X', n: 2, at: back(now, H) }])
    expect(summaryCounts(await buildSummary({ now }))).toEqual({
      server_errors: 2,
      app_errors: 0,
      app_crashes: 0,
      refusals_and_slow: 0,
      retention_ran: true,
      visits_not_counted: 0,
      stuck_phones: 0,
      stuck_phones_uploading: 0,
      outdated_phones: 0,
      new_phones: 0,
      committee_sign_ins: 0,
    })
  })
})

// ---- the text ---------------------------------------------------------------------------------------------------------------

describe('the text', () => {
  it('is the example of the pull request: the first line with the period, then a line for each section that has something', async () => {
    // 01/06/2030 04:00 UTC is 07:00 in the building (UTC+3 in summer), and the moment is far from every other test.
    const now = new Date('2030-06-01T04:00:00Z')
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
    await seedEvents([
      { place: '/scans/sync', code: '57014', n: 2, at: back(now, 2 * H), method: 'POST', status: 500 },
      { place: '/scans/sync', code: '57014', n: 1, at: back(now, 6 * H), method: 'POST', status: 500 },
      { place: '/admin/points/:id', code: 'XX000', n: 2, at: back(now, 3 * H), method: 'PATCH', status: 500 },
      { source: 'provider_app', kind: 'crash', place: 'scan', code: 'TypeError', build: 'abc1234', n: 2, at: back(now, 4 * H) },
      { source: 'committee_app', kind: 'unhandled', place: 'providers', code: 'Error', build: 'abc1234', n: 1, at: back(now, 5 * H) },
      { source: 'provider_app', kind: 'refusal', place: 'scan', code: 'not_assigned', n: 6, at: back(now, 4 * H) },
      { source: 'server', kind: 'slow', place: '/admin/scans', code: '', n: 4, at: back(now, 4 * H) },
    ])
    await seedAudit([
      retentionRow(back(now, 2 * H), { sessions: 1, login_attempts: 0, device_labels: 0, app_errors: 2, alert_pings: 0 }),
      ...[1, 2].map((h) => signInRow(back(now, h * H))),
    ])
    await seedRefusals([
      ...[1, 2, 3].map((h) => ({ at: back(now, h * H), code: 'not_assigned' })),
      { at: back(now, 4 * H), code: 'point_inactive' },
    ])
    await seedPhones(now, [
      { build: '1111111', waiting: 3, oldest: back(now, 40 * H), sync: back(now, H) }, // stuck, uploading, outdated
      { build: 'abcdef1', waiting: 1, oldest: back(now, 30 * H) }, // stuck
    ])
    await newPhones(now, within(now, 6))

    const summary = await buildSummary({ now })
    expect(summaryText(summary)).toBe(
      [
        'Daily summary FAIL: 31/05/2030 07:00 to 01/06/2030 07:00',
        'Why: server error, app crash or unhandled error, stuck phone, sign-in spike',
        'Server errors: 5 in 2 kinds: /scans/sync 57014 x3; /admin/points/:id XX000 x2',
        'App errors: 3 in 2 kinds: provider_app crash scan TypeError build abc1234 x2; committee_app unhandled providers Error build abc1234 x1',
        'Refusals and slow requests: 10 in 2 kinds: provider_app refusal scan not_assigned x6; server slow /admin/scans x4',
        'Retention job: ran 01/06/2030 05:00 (sessions 1, login attempts 0, device labels 0, app errors 2, alert pings 0)',
        'Visits not counted: 4 in 2 kinds: not_assigned x3; point_inactive x1',
        'Phones: 2 stuck (visits waiting for more than 24 hours); 1 of them uploaded in the period and are still stuck; 1 outdated (the server is on build abcdef1)',
        'New provider phones: 6 (median per day before: 0), SPIKE',
        'Committee sign-ins: 2 (median per day before: 0)',
      ].join('\n'),
    )
  })

  it('is the first line and the retention line for a quiet day, and has no "Why" line when it is ok', async () => {
    const now = new Date('2031-06-01T04:00:00Z')
    await retentionRan(now)
    const text = summaryText(await buildSummary({ now }))
    expect(text).toBe(
      ['Daily summary OK: 31/05/2031 07:00 to 01/06/2031 07:00', 'Retention job: ran 01/06/2031 05:00 (sessions 0, login attempts 0, device labels 0, app errors 0, alert pings 0)'].join('\n'),
    )
  })

  it('writes the period in the building time, DD/MM/YYYY HH:MM, also across the change to winter time', () => {
    // The clocks of the building go back on the night of 24/10/2026 to 25/10/2026: the 24 hours are 25 hours of the clock.
    const summary = quietSummary({ from: new Date('2026-10-24T20:30:00Z'), to: new Date('2026-10-25T20:30:00Z') })
    expect(summaryText(summary).split('\n')[0]).toBe('Daily summary OK: 24/10/2026 23:30 to 25/10/2026 22:30')
  })

  it('names at most 5 kinds in a list, says how many more there are, and names a single one in the singular', async () => {
    const now = freshNow()
    await retentionRan(now)
    await seedEvents(['/a', '/b', '/c', '/d', '/e', '/f', '/g'].map((place, i) => ({ place, code: 'X1', n: 7 - i, at: back(now, H) })))
    const line = summaryText(await buildSummary({ now })).split('\n').find((l) => l.startsWith('Server errors'))
    expect(line).toBe('Server errors: 28 in 7 kinds: /a X1 x7; /b X1 x6; /c X1 x5; /d X1 x4; /e X1 x3 (+2 more kinds)')

    const one = freshNow()
    await retentionRan(one)
    await seedEvents(['/a', '/b', '/c', '/d', '/e', '/f'].map((place, i) => ({ place, code: 'X1', n: 6 - i, at: back(one, H) })))
    const single = summaryText(await buildSummary({ now: one })).split('\n').find((l) => l.startsWith('Server errors'))
    expect(single).toBe('Server errors: 21 in 6 kinds: /a X1 x6; /b X1 x5; /c X1 x4; /d X1 x3; /e X1 x2 (+1 more kind)')
  })

  it('never holds a name, an e-mail, a QR code, the label of a phone, an id or a message, whatever the database holds', async () => {
    const now = freshNow()
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567'
    // Every column of every table that the summary reads, or could read, holds a personal value on purpose.
    await seedEvents([
      { place: '/scans/sync', code: '57014', n: 2, at: back(now, H), rid: PERSON.requestId },
      { source: 'provider_app', kind: 'crash', place: 'scan', code: 'TypeError', build: 'abc1234', at: back(now, H), rid: PERSON.requestId },
      { source: 'provider_app', kind: 'refusal', place: 'scan', code: 'not_assigned', at: back(now, H), rid: PERSON.requestId },
    ])
    await seedAudit([
      retentionRow(back(now, H)),
      ...within(now, 6).map(signInRow), // names and e-mails in the actor and the detail
      { at: back(now, H), actor_type: 'admin', actor_id: randomUUID(), actor_name: PERSON.committee, action: 'point.update', detail: { name: PERSON.point, email: PERSON.email } },
    ])
    await seedRefusals([{ at: back(now, H), code: 'not_assigned' }])
    await seedPhones(now, [
      { waiting: 5, oldest: back(now, 50 * H), build: '1111111', sync: back(now, H) },
      ...within(now, 6).map((created) => ({ created })),
    ])
    const summary = await buildSummary({ now })
    expect(summary.verdict).toBe('fail')
    const body = summaryText(summary)
    const everything = JSON.stringify(summary) + body + JSON.stringify(summaryCounts(summary))
    for (const [name, value] of Object.entries(PERSON)) expect(everything, name).not.toContain(value)
    expect(everything).not.toContain(deviceId)
    expect(everything).not.toContain(pointId)
    expect(everything).not.toContain(providerId)
    expect(everything).not.toMatch(/@/)
  })

  it('says (other) for a place, a code or a build that is not made of the characters of those values, and nothing of it', () => {
    const summary = quietSummary({
      server: { total: 3, kinds: 2, top: [
        { source: '', kind: 'error', place: PERSON.email, code: 'X1', build: '', n: 2 },
        { source: '', kind: 'error', place: '/ok/:id', code: `bad ${PERSON.company}`, build: '', n: 1 },
      ] },
      apps: { total: 1, kinds: 1, crashes: 1, top: [{ source: 'provider_app', kind: 'crash', place: 'scan', code: 'E', build: PERSON.contact, n: 1 }] },
    })
    const text = summaryText(summary)
    expect(text).toContain('Server errors: 3 in 2 kinds: (other) X1 x2; /ok/:id (other) x1')
    expect(text).toContain('provider_app crash scan E build (other) x1')
    for (const value of Object.values(PERSON)) expect(text).not.toContain(value)
  })

  it('stays far below the 8 kB that the heartbeat cuts to, even when every value is as long as the table allows', () => {
    const long = (n, ch = 'a') => `/${ch.repeat(n - 1)}`
    const top = (extra) =>
      Array.from({ length: SUMMARY_TOP }, (_, i) => ({ source: 'committee_app', kind: 'unhandled', place: long(120, 'p'), code: 'c'.repeat(60), build: 'b'.repeat(40), n: 99999 - i, ...extra }))
    const summary = quietSummary({
      verdict: 'fail',
      reasons: [...REASONS],
      server: { total: 999999, kinds: 900, top: top({ source: '' }) },
      apps: { total: 999999, kinds: 900, crashes: 5, top: top({}) },
      noted: { total: 999999, kinds: 900, top: top({ build: '' }) },
      retention: { ran: false, at: new Date('2026-10-01T04:00:00Z'), counts: null },
      refusals: { total: 999999, kinds: 900, top: Array.from({ length: SUMMARY_TOP }, () => ({ code: 'x'.repeat(40), n: 99999 })) },
      phones: { stuck: 99999, stuckUploading: 99999, outdated: 99999, build: 'abcdef1' },
      signIns: { phones: { n: 99999, median: 12.5, spike: true }, committee: { n: 99999, median: 12.5, spike: true } },
    })
    const bytes = new TextEncoder().encode(summaryText(summary)).length
    expect(bytes).toBeLessThan(HEARTBEAT_BODY_MAX_BYTES / 1.5)
  })
})

/** A summary that is made by hand (no database): quiet, and `over` replaces any of its parts. */
function quietSummary(over = {}) {
  const none = { total: 0, kinds: 0, top: [] }
  const from = over.from ?? new Date('2026-10-04T04:00:00Z')
  const to = over.to ?? new Date('2026-10-05T04:00:00Z')
  const rest = { ...over }
  delete rest.from
  delete rest.to
  return {
    period: { from, to },
    verdict: 'ok',
    reasons: [],
    server: none,
    apps: { ...none, crashes: 0 },
    noted: none,
    retention: { ran: true, at: back(to, 2 * H), counts: COUNTS },
    refusals: none,
    phones: { stuck: 0, stuckUploading: 0, outdated: 0, build: null },
    signIns: { phones: { n: 0, median: 0, spike: false }, committee: { n: 0, median: 0, spike: false } },
    ...rest,
  }
}

// ---- one read-only transaction ----------------------------------------------------------------------------------------------

describe('what it reads', () => {
  it('uses one connection and one transaction, read-only from its first statement, and only selects', async () => {
    const now = freshNow()
    const real = getPool()
    const statements = []
    let connections = 0
    const note = (text) => statements.push(String(typeof text === 'string' ? text : text?.text).replace(/\s+/g, ' ').trim())
    setPool({
      limits: real.limits,
      query: (text, params, options) => (note(text), real.query(text, params, options)),
      connect: async () => {
        connections += 1
        const client = await real.connect()
        return { query: (text, params) => (note(text), client.query(text, params)), release: (broken) => client.release(broken) }
      },
    })
    await buildSummary({ now })
    expect(connections).toBe(1)
    expect(statements[0]).toMatch(/^begin; set local statement_timeout/)
    expect(statements[1]).toBe('set transaction read only')
    expect(statements.at(-1)).toBe('commit')
    const middle = statements.slice(2, -1)
    expect(middle.length).toBeGreaterThanOrEqual(5)
    for (const text of middle) {
      expect(text, text).toMatch(/^(select|with) /i)
      expect(text, text).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create)\b/i)
    }
  })

  it('is read-only in the database itself: after that statement, in a transaction of the app, an insert is refused', async () => {
    const { tx } = await import('../server/db.js')
    const code = await tx(async (c) => {
      await c.query('set transaction read only')
      return c.query('insert into alert_pings (day) values (current_date)').then(
        () => 'written',
        (err) => err.code,
      )
    })
    expect(code).toBe('25006') // read_only_sql_transaction
  })
})

// ---- through the route --------------------------------------------------------------------------------------------------------

describe('GET /api/cron/daily-summary', () => {
  const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace']
  let consoles
  let pings
  let faked

  /** Replaces the fetch of the process by a fake that writes down what it was asked and answers `answer`. Nothing leaves the process. */
  function stubFetch(answer = async () => ({ status: 200, body: { cancel: async () => {} } })) {
    pings = []
    vi.stubGlobal('fetch', (url, init) => {
      pings.push({ url: String(url), method: init?.method, body: init?.body, init })
      return answer(url, init)
    })
  }

  /** Freezes the clock of the process (only the date: timers stay real) at `when`, and returns it as a Date. */
  function freeze(when) {
    if (!faked) {
      vi.useFakeTimers({ toFake: ['Date'] })
      faked = true
    }
    vi.setSystemTime(new Date(when))
    return new Date(when)
  }

  beforeEach(() => {
    faked = false
    process.env.CRON_SECRET = SECRET
    process.env.HEALTH_HEARTBEAT_URL = ADDRESS
    stubFetch()
    consoles = Object.fromEntries(CONSOLE_METHODS.map((method) => [method, vi.spyOn(console, method).mockImplementation(() => {})]))
    for (const spy of Object.values(consoles)) spy.mockClear()
  })

  const logged = () => CONSOLE_METHODS.flatMap((method) => consoles[method].mock.calls.map((args) => `${method}: ${args.join(' ')}`))
  const run = (options) => call('GET', '/api/cron/daily-summary', { token: SECRET, ...options })

  it('sends a good day to the base address, as a POST of plain text, and answers with the counts', async () => {
    const now = freeze('2032-06-01T04:03:20Z')
    await retentionRan(now)
    const r = await run()
    expect(r.status).toBe(200)
    expect(r.json).toEqual({
      ok: true,
      verdict: 'ok',
      reasons: [],
      server_errors: 0,
      app_errors: 0,
      app_crashes: 0,
      refusals_and_slow: 0,
      retention_ran: true,
      visits_not_counted: 0,
      stuck_phones: 0,
      stuck_phones_uploading: 0,
      outdated_phones: 0,
      new_phones: 0,
      committee_sign_ins: 0,
      heartbeat: 'sent',
    })
    expect(pings).toHaveLength(1)
    expect(pings[0].url).toBe(ADDRESS)
    expect(pings[0].method).toBe('POST')
    expect(pings[0].init.redirect).toBe('error')
    expect(pings[0].body.split('\n')[0]).toBe('Daily summary OK: 31/05/2032 07:03 to 01/06/2032 07:03')
    expect(pings[0].body).toBe(summaryText(await buildSummary({ now })))
  })

  it('sends a failing day to /fail with the lines that explain it', async () => {
    const now = freeze('2033-06-01T04:03:20Z')
    await retentionRan(now)
    await seedEvents([{ place: '/admin/points/:id', code: 'XX000', n: 2, at: back(now, H), method: 'PATCH', status: 500 }])
    const r = await run()
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, verdict: 'fail', reasons: ['server_error'], server_errors: 2, heartbeat: 'sent' })
    expect(pings).toHaveLength(1)
    expect(pings[0].url).toBe(`${ADDRESS}/fail`)
    expect(pings[0].body.split('\n')).toEqual([
      'Daily summary FAIL: 31/05/2033 07:03 to 01/06/2033 07:03',
      'Why: server error',
      'Server errors: 2 in 1 kind: /admin/points/:id XX000 x2',
      expect.stringMatching(/^Retention job: ran 01\/06\/2033 05:03 /),
    ])
  })

  it('logs one line with the verdict, the reasons and the counts, and nothing else', async () => {
    const now = freeze('2034-06-01T04:03:20Z')
    await retentionRan(now)
    await seedEvents([{ place: '/a', code: 'X', n: 3, at: back(now, H), rid: PERSON.requestId }])
    await seedPhones(now, [{ waiting: 1, oldest: back(now, 40 * H) }])
    await run()
    expect(logged()).toEqual([
      'log: daily-summary: verdict=fail reasons=server_error,stuck_phone server_errors=3 app_errors=0 app_crashes=0 refusals_and_slow=0 ' +
        'retention_ran=true visits_not_counted=0 stuck_phones=1 stuck_phones_uploading=0 outdated_phones=0 new_phones=0 committee_sign_ins=0 heartbeat=sent',
    ])
  })

  it('sends nothing without HEALTH_HEARTBEAT_URL, and the answer and the log line are the same but for the word heartbeat', async () => {
    const now = freeze('2035-06-01T04:03:20Z')
    await retentionRan(now)
    await seedEvents([{ place: '/a', code: 'X', n: 1, at: back(now, H) }])
    const sent = await run()
    const sentLog = logged()
    expect(pings).toHaveLength(1)

    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.HEALTH_HEARTBEAT_URL
      else process.env.HEALTH_HEARTBEAT_URL = value
      stubFetch()
      for (const spy of Object.values(consoles)) spy.mockClear()
      const r = await run()
      expect(r.status).toBe(200)
      expect(r.json).toEqual({ ...sent.json, heartbeat: 'not_configured' })
      expect(pings).toEqual([]) // the fetch was never called
      expect(logged()).toEqual([sentLog[0].replace('heartbeat=sent', 'heartbeat=not_configured')])
    }
  })

  it('still answers 200 when healthchecks.io refuses or does not answer, and says so with a fixed word', async () => {
    const now = freeze('2036-06-01T04:03:20Z')
    await retentionRan(now)
    stubFetch(async () => ({ status: 500, body: { cancel: async () => {} } }))
    expect((await run()).json).toMatchObject({ ok: true, verdict: 'ok', heartbeat: 'rejected' })
    stubFetch(async () => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND hc.example.test ${PERSON.email}`), { code: 'ENOTFOUND' })
    })
    const r = await run()
    expect(r.json).toMatchObject({ ok: true, verdict: 'ok', heartbeat: 'failed' })
    expect(JSON.stringify(r.json) + logged().join('\n')).not.toMatch(/hc\.example\.test|ENOTFOUND|@/)
  })

  it('answers 503, pings /fail once and records no error when the database cannot be read', async () => {
    freeze('2037-06-01T04:03:20Z')
    const before = Number((await q('select count(*) as n from app_errors')).rows[0].n)
    const down = () =>
      Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:5432 for ${PERSON.email} password=hunter2`), {
        code: 'ECONNREFUSED',
        detail: PERSON.email,
      })
    setPool({ connect: async () => { throw down() }, query: async () => { throw down() } })
    const r = await run()
    setPool(db.pool)
    expect(r.status).toBe(503)
    expect(r.json).toEqual({ ok: false, heartbeat: 'sent' })
    expect(pings).toHaveLength(1)
    expect(pings[0].url).toBe(`${ADDRESS}/fail`)
    expect(pings[0].body).toBe('Daily summary could not read the database, 01/06/2037 07:03: ECONNREFUSED')
    // One line of the log: the failure's code, never its message. And the router did not record or alert on it as a 500.
    expect(logged()).toEqual(['error: daily-summary failed: ECONNREFUSED'])
    expect(Number((await q('select count(*) as n from app_errors')).rows[0].n)).toBe(before)
    expect(JSON.stringify(r.json) + pings[0].body + logged().join('\n')).not.toMatch(/@|hunter2|127\.0\.0\.1/)
  })

  it('says the failure by its name when it is not a database error with a code, and still never by its message', async () => {
    freeze('2038-06-01T04:03:20Z')
    setPool({ connect: async () => { throw new TypeError(`cannot read ${PERSON.email}`) }, query: async () => { throw new TypeError('x') } })
    const r = await run()
    setPool(db.pool)
    expect(r.status).toBe(503)
    expect(pings[0].body).toBe('Daily summary could not read the database, 01/06/2038 07:03: TypeError')
  })

  it('does not run without the cron secret: a 401 and no ping', async () => {
    const r = await call('GET', '/api/cron/daily-summary')
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('cron_required')
    expect(pings).toEqual([])
    const wrong = await call('GET', '/api/cron/daily-summary', { token: 'not-the-secret' })
    expect(wrong.status).toBe(401)
    expect(pings).toEqual([])
  })

  it('does not run on a deployment that has no CRON_SECRET', async () => {
    delete process.env.CRON_SECRET
    const r = await call('GET', '/api/cron/daily-summary', { token: SECRET })
    expect(r.status).toBe(401)
    expect(pings).toEqual([])
  })

  it('holds nothing personal in the answer, the log or the body, whatever the database holds', async () => {
    const now = freeze('2039-06-01T04:03:20Z')
    await seedEvents([{ place: '/a', code: 'X', n: 1, at: back(now, H), rid: PERSON.requestId }])
    await seedAudit([retentionRow(back(now, H)), ...within(now, 6).map(signInRow)])
    await seedRefusals([{ at: back(now, H), code: 'not_assigned' }])
    await seedPhones(now, [{ waiting: 5, oldest: back(now, 50 * H), sync: back(now, H) }, ...within(now, 6).map((created) => ({ created }))])
    const r = await run()
    expect(r.status).toBe(200)
    const everything = JSON.stringify(r.json) + pings.map((p) => p.body).join('\n') + logged().join('\n')
    for (const [name, value] of Object.entries(PERSON)) expect(everything, name).not.toContain(value)
    expect(everything).not.toContain(ADDRESS)
    expect(everything).not.toContain('hc.example.test')
  })
})

// ---- vercel.json ----------------------------------------------------------------------------------------------------------------

describe('vercel.json', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))

  it('has both cron jobs: the retention job at 01:00 UTC and the daily summary at 04:00 UTC', () => {
    expect(config.crons).toEqual([
      { path: '/api/cron/retention', schedule: '0 1 * * *' },
      { path: '/api/cron/daily-summary', schedule: '0 4 * * *' },
    ])
  })

  it('runs each job once a day (Vercel Hobby allows no more), and the summary three hours after the retention job', () => {
    for (const { schedule } of config.crons) expect(schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/)
    const [retention, summary] = config.crons.map(({ schedule }) => schedule.split(' ').map(Number))
    expect(summary[1] - retention[1]).toBeGreaterThanOrEqual(2) // the summary reads the row that the job writes
  })

  it('names, for each job, a GET route that the server has', async () => {
    await import('../server/index.js')
    const table = routeTable().map((r) => `${r.method} ${r.path}`)
    for (const { path } of config.crons) expect(table).toContain(`GET ${path.replace(/^\/api/, '')}`)
  })
})
