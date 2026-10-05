// The retention job (server/retention.js) and the route that Vercel Cron calls (GET /api/cron/retention, guarded by the
// CRON_SECRET of the deployment). docs/privacy.md says what is kept and for how long; this file proves that the job does
// exactly that and nothing more:
//   - it deletes the committee sessions that expired or were revoked more than 30 days ago, the login attempts older than
//     1 day, the recorded errors (app_errors) whose last event is older than 90 days, and the days of the alert throttle
//     (alert_pings, migration 011) that are more than 30 days back, and it clears the label of a phone
//     that was revoked more than 90 days ago TOGETHER WITH everything that the phone reported about itself (migration 010:
//     build, time of the report, what waited and since when, the two totals, the last upload), also when the label of that
//     phone is empty;
//   - it never touches a scan, the audit log, an active session or phone (label and reported status alike), or anything that is
//     not yet due (every table that the job may not change is compared row for row before and after);
//   - it writes one audit row, with the five counts and nothing else, and a second run finds nothing more;
//   - the route refuses every request without the secret, and every request at all when CRON_SECRET is not set, before any
//     database statement.
// It runs against the throwaway schema like the other API tests. The data is fake: names like "Fake Browser A" stand in for
// the browser string that a phone sends at sign-in.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin } from './helpers.js'
import { runRetention } from '../server/retention.js'
import { getPool, setPool } from '../server/db.js'
import {
  RETENTION_SESSION_DAYS,
  RETENTION_LOGIN_ATTEMPT_DAYS,
  RETENTION_DEVICE_LABEL_DAYS,
  RETENTION_APP_ERROR_DAYS,
  RETENTION_ALERT_PING_DAYS,
} from '../server/config.js'

let db
let providerId
let adminId
let CRON_SECRET_BEFORE
const SECRET = `retention-test-${randomBytes(24).toString('hex')}`

beforeAll(async () => {
  db = await setupDb()
  CRON_SECRET_BEFORE = process.env.CRON_SECRET
  process.env.CRON_SECRET = SECRET
  await seedAdmin(db.pool)
  adminId = (await db.pool.query('select id from admins limit 1')).rows[0].id
  providerId = (
    await db.pool.query(`insert into providers (company, contact_name) values ('Retention test company', 'Fake Person') returning id`)
  ).rows[0].id
})
afterAll(async () => {
  if (CRON_SECRET_BEFORE === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = CRON_SECRET_BEFORE
  await db?.teardown()
})

// What the job must delete or clear, and what it must leave, by the name that each fixture row is given.
const SESSIONS_GONE = ['expired-31d', 'revoked-31d', 'expired-40d-revoked-1d']
const SESSIONS_KEPT = ['expired-29d', 'revoked-29d', 'active']
const ATTEMPTS_GONE = ['attempt-48h-a', 'attempt-48h-b']
const ATTEMPTS_KEPT = ['attempt-1h', 'attempt-23h']
const LABELS_CLEARED = ['revoked-91d', 'revoked-400d-with-scan']
const LABELS_KEPT = { 'revoked-89d': 'Fake Browser B', active: 'Fake Browser C' }
// The recorded errors (app_errors) are named by their `place`. The age that counts is the last event: a row whose first event
// is old but whose last one is recent is still in use.
const ERRORS_GONE = ['due-91d', 'due-400d']
const ERRORS_KEPT = ['kept-89d', 'kept-now', 'kept-first-old-last-recent']
// The days of the alert throttle (alert_pings: a date, no name) are named by how many days back they are (a negative number is a
// day ahead: the building's day can be a day ahead of the database's date for a few hours). The period is 30: a day is due once it
// is MORE than 30 days back, and the fixture keeps clear of the exact boundary so that the turn of the date during a run cannot
// change what is due.
const PINGS_GONE = [31, 400]
const PINGS_KEPT = [29, 1, 0, -1]
// A phone that has no label but still holds what it reported is due too: a status must not outlive the period because the label was empty.
const STATUS_ONLY_CLEARED = ['revoked-91d-no-label']
const PHONES_CLEARED = [...LABELS_CLEARED, ...STATUS_ONLY_CLEARED]
// A phone that is revoked and due but holds nothing to clear (no label, no status) is not touched and not counted.
const NOTHING_TO_CLEAR = 'revoked-91d-nothing'
const COUNTS = { sessions: 3, loginAttempts: 2, deviceLabels: 3, appErrors: 2, alertPings: 2 }
// What a phone reports about itself (migration 010): every phone of the fixture but NOTHING_TO_CLEAR has this, and a cleared phone has CLEARED.
const REPORTED = { app_build: 'abcdef1', waiting_count: 12, not_accepted_total: 4, overflow_total: 2 }
const CLEARED = { label: '', app_build: null, status_at: null, waiting_count: null, oldest_waiting_at: null, last_sync_at: null, not_accepted_total: 0, overflow_total: 0 }

/**
 * Replaces the sessions, login attempts, phones and recorded errors of the schema with the fixture above, and adds two scans (one from a
 * phone whose label is due to be cleared, one from an active phone) and two audit rows (one old). The scans, the audit
 * log and the other tables are only ever added to: a test compares them before and after a run.
 */
async function seed() {
  const q = (text, params) => db.pool.query(text, params)
  // One statement for each kind of row (a statement is several round trips to the database, and the schema is remote).
  await q(
    `with a as (delete from admin_sessions), b as (delete from auth_attempts), c as (delete from provider_devices),
          d as (delete from app_errors), e as (delete from alert_pings)
     select 1`,
  )

  // expires: in how many days it expires (negative = in the past), revoked: how many days ago it was revoked (null = never).
  const sessions = [
    { name: 'expired-31d', expires: -31, revoked: null },
    { name: 'expired-29d', expires: -29, revoked: null },
    { name: 'revoked-31d', expires: 10, revoked: 31 }, // not expired yet: only the revocation is old
    { name: 'revoked-29d', expires: 10, revoked: 29 },
    { name: 'active', expires: 5, revoked: null }, // created 200 days ago: its age alone is no reason to delete it
    { name: 'expired-40d-revoked-1d', expires: -40, revoked: 1 }, // revoked yesterday, but it expired over 30 days ago
  ]
  await q(
    `insert into admin_sessions (admin_id, token_hash, created_at, expires_at, revoked_at)
     select $1, name, now() - interval '200 days', now() + make_interval(days => expires),
            case when revoked is null then null else now() - make_interval(days => revoked) end
       from jsonb_to_recordset($2::jsonb) as t(name text, expires int, revoked int)`,
    [adminId, JSON.stringify(sessions)],
  )

  const attempts = [
    { name: 'attempt-48h-a', hours: 48 },
    { name: 'attempt-48h-b', hours: 48 },
    { name: 'attempt-1h', hours: 1 },
    { name: 'attempt-23h', hours: 23 },
  ]
  await q(
    `insert into auth_attempts (scope, key, at)
     select 'admin', name, now() - make_interval(hours => hours) from jsonb_to_recordset($1::jsonb) as t(name text, hours int)`,
    [JSON.stringify(attempts)],
  )

  // Safe fields only, like the real rows: the route, the method, the status and a code. Days are counted back from now.
  const events = [
    { name: 'due-91d', first_days: 91, last_days: 91 },
    { name: 'due-400d', first_days: 400, last_days: 400 },
    { name: 'kept-89d', first_days: 89, last_days: 89 },
    { name: 'kept-now', first_days: 0, last_days: 0 },
    { name: 'kept-first-old-last-recent', first_days: 200, last_days: 1 },
  ]
  await q(
    `insert into app_errors (bucket, source, kind, place, method, status, code, count, first_at, last_at)
     select date_trunc('hour', now() - make_interval(days => last_days)), 'server', 'error', name, 'GET', 500, 'XX000', 3,
            now() - make_interval(days => first_days), now() - make_interval(days => last_days)
       from jsonb_to_recordset($1::jsonb) as t(name text, first_days int, last_days int)`,
    [JSON.stringify(events)],
  )

  // One row for each day of the lists above, counted back from the date of the database.
  await q(
    `insert into alert_pings (day, sent_at)
     select current_date - ago, now() - make_interval(days => ago) from unnest($1::int[]) as t(ago)`,
    [[...PINGS_GONE, ...PINGS_KEPT]],
  )

  const fixtures = [
    { name: 'revoked-91d', label: 'Fake Browser A', revoked: 91 },
    { name: 'revoked-89d', label: 'Fake Browser B', revoked: 89 },
    { name: 'active', label: 'Fake Browser C', revoked: null },
    { name: 'revoked-400d-with-scan', label: 'Fake Browser D', revoked: 400 },
    { name: 'revoked-91d-no-label', label: '', revoked: 91 }, // holds a status
    { name: NOTHING_TO_CLEAR, label: '', revoked: 91 },
  ].map((d) => ({ ...d, id: randomUUID(), token: `token-${d.name}-${randomUUID()}` }))
  const devices = Object.fromEntries(fixtures.map((d) => [d.name, d.id]))
  await q(
    `insert into provider_devices (id, provider_id, token_hash, label, created_at, last_seen_at, revoked_at)
     select id, $1, token, label, now() - interval '500 days', now() - interval '450 days',
            case when revoked is null then null else now() - make_interval(days => revoked) end
       from jsonb_to_recordset($2::jsonb) as t(id uuid, token text, label text, revoked int)`,
    [providerId, JSON.stringify(fixtures)],
  )
  // What the phones reported about themselves (migration 010), on every phone but the one that has nothing to clear: the active one,
  // the one revoked 89 days ago and the ones that are due all hold a status, and the status is the same on each, so that a
  // difference after a run can only come from the job.
  await q(
    `update provider_devices
        set app_build = $2, status_at = now() - interval '2 days', waiting_count = $3,
            oldest_waiting_at = now() - interval '3 days', not_accepted_total = $4, overflow_total = $5,
            last_sync_at = now() - interval '2 days'
      where id <> $1`,
    [devices[NOTHING_TO_CLEAR], REPORTED.app_build, REPORTED.waiting_count, REPORTED.not_accepted_total, REPORTED.overflow_total],
  )

  // Two scans, one from a phone whose label is due to be cleared and one from an active phone. (A scan holds the id of the
  // phone as a plain reference, so the phone's row can be changed without touching the scan.)
  await q(
    `insert into scans (id, point_id, provider_id, point_name, provider_name, checked_in_at, local_date, source, outcome, device_id)
     select gen_random_uuid(), gen_random_uuid(), $1, 'Fake point', 'Fake Person', now() - interval '450 days',
            (now() - interval '450 days')::date, 'online', 'accepted', d
       from unnest($2::uuid[]) as d`,
    [providerId, [devices['revoked-400d-with-scan'], devices.active]],
  )

  await q(
    `insert into audit_log (at, actor_type, actor_id, action, entity, entity_id, detail)
     values (now() - interval '400 days', 'admin', $1, 'point.update', 'point', $2, '{"name":"Fake point"}'),
            (now() - interval '40 days', 'system', null, 'retention.run', null, null, '{"sessions":0,"login_attempts":0,"device_labels":0}')`,
    [adminId, randomUUID()],
  )
  return { devices }
}

// The tables of the schema, read once (the schema does not change while the file runs).
let TABLES

/** Every row of every table of the schema, as JSON, by table name: the state of the whole database, in one round trip. */
async function snapshot() {
  TABLES ??= (
    await db.pool.query(
      `select table_name as name from information_schema.tables
        where table_schema = current_schema() and table_type = 'BASE TABLE' order by 1`,
    )
  ).rows.map((r) => r.name)
  const parts = TABLES.map(
    (name) => `'${name}', (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) from "${name}" t)`,
  )
  return (await db.pool.query(`select jsonb_build_object(${parts.join(', ')}) as state`)).rows[0].state
}

// Sorted here, not by the database: its collation may order punctuation differently from the list that a test compares with.
// The rows of app_errors that are named, as JSON, in the order of their place (the whole row, so a changed column shows).
const errorRows = async (places) =>
  (await db.pool.query('select to_jsonb(e) as row from app_errors e where place = any($1) order by place', [places])).rows
const errorPlaces = async () => (await db.pool.query('select place from app_errors')).rows.map((r) => r.place).sort()
// The days of alert_pings that are there, as how many days back each is, the farthest first; and the whole rows of some of them.
const pingAges = async () => (await db.pool.query('select (current_date - day)::int as ago from alert_pings order by day')).rows.map((r) => r.ago)
const pingRows = async (ages) =>
  (await db.pool.query('select to_jsonb(p) as row from alert_pings p where current_date - day = any($1) order by day', [ages])).rows
const hashes = async (table, column) => (await db.pool.query(`select ${column} as name from ${table}`)).rows.map((r) => r.name).sort()
/** One phone as JSON: its label and everything that it reported, with the other columns. */
const phoneRow = async (id) => (await db.pool.query('select to_jsonb(d) as row from provider_devices d where id = $1', [id])).rows[0].row
const labelsByName = async (devices) => {
  const { rows } = await db.pool.query('select id, label from provider_devices')
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.label]))
  return Object.fromEntries(Object.entries(devices).map(([name, id]) => [name, byId[id]]))
}

// The tables that the job is allowed to change. Everything else must come out of a run exactly as it went in.
const MAY_CHANGE = new Set(['admin_sessions', 'auth_attempts', 'provider_devices', 'audit_log', 'app_errors', 'alert_pings'])
const sameExceptWhatMayChange = (before, after) => {
  const keep = (state) => Object.fromEntries(Object.entries(state).filter(([name]) => !MAY_CHANGE.has(name)))
  expect(keep(after)).toEqual(keep(before))
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
}

/** Runs `fn` with a pool that writes down every statement and connection that is asked of it. */
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

describe('the periods are the owner\'s decision of 04/10/2026 and 05/10/2026', () => {
  it('are 30 days for a session, 1 day for a login attempt, 90 days for the label of a revoked phone, 90 days for a recorded error and 30 days for an alert day', () => {
    // A change here is a change of what the committee promised in docs/privacy.md: it needs the owner's decision.
    expect([
      RETENTION_SESSION_DAYS,
      RETENTION_LOGIN_ATTEMPT_DAYS,
      RETENTION_DEVICE_LABEL_DAYS,
      RETENTION_APP_ERROR_DAYS,
      RETENTION_ALERT_PING_DAYS,
    ]).toEqual([30, 1, 90, 90, 30])
  })
})

describe('runRetention', () => {
  it('deletes what is due and clears what is due, and touches nothing else', async () => {
    const { devices } = await seed()
    const before = await snapshot()
    const auditBefore = before.audit_log
    const keptSessions = (await db.pool.query(`select to_jsonb(s) as row from admin_sessions s where token_hash = any($1) order by token_hash`, [SESSIONS_KEPT])).rows
    const keptAttempts = (await db.pool.query(`select to_jsonb(a) as row from auth_attempts a where key = any($1) order by key`, [ATTEMPTS_KEPT])).rows
    const keptErrors = await errorRows(ERRORS_KEPT)
    const keptPings = await pingRows(PINGS_KEPT)

    // The fixture is what the lists say: the due rows and the rest are all there before the run.
    expect(await hashes('admin_sessions', 'token_hash')).toEqual([...SESSIONS_GONE, ...SESSIONS_KEPT].sort())
    expect(await hashes('auth_attempts', 'key')).toEqual([...ATTEMPTS_GONE, ...ATTEMPTS_KEPT].sort())
    expect(await errorPlaces()).toEqual([...ERRORS_GONE, ...ERRORS_KEPT].sort())
    expect(await pingAges()).toEqual([...PINGS_GONE, ...PINGS_KEPT].sort((a, b) => b - a))
    expect([SESSIONS_GONE.length, ATTEMPTS_GONE.length, PHONES_CLEARED.length, ERRORS_GONE.length, PINGS_GONE.length]).toEqual([
      COUNTS.sessions,
      COUNTS.loginAttempts,
      COUNTS.deviceLabels,
      COUNTS.appErrors,
      COUNTS.alertPings,
    ])
    // The phones of the fixture hold what the lists say (a fixture without a status would make the check below an empty one).
    const phonesBefore = Object.fromEntries(before.provider_devices.map((d) => [d.id, d]))
    for (const [name, id] of Object.entries(devices)) {
      if (name === NOTHING_TO_CLEAR) expect(phonesBefore[id], name).toMatchObject(CLEARED)
      else expect(phonesBefore[id], name).toMatchObject({ ...REPORTED, status_at: expect.any(String), oldest_waiting_at: expect.any(String), last_sync_at: expect.any(String) })
    }

    expect(await runRetention()).toEqual(COUNTS)

    // Sessions: exactly the due ones are gone, and the rest are the very same rows.
    expect(await hashes('admin_sessions', 'token_hash')).toEqual([...SESSIONS_KEPT].sort())
    const afterSessions = (await db.pool.query(`select to_jsonb(s) as row from admin_sessions s where token_hash = any($1) order by token_hash`, [SESSIONS_KEPT])).rows
    expect(afterSessions).toEqual(keptSessions)
    // Login attempts, the same way.
    expect(await hashes('auth_attempts', 'key')).toEqual([...ATTEMPTS_KEPT].sort())
    const afterAttempts = (await db.pool.query(`select to_jsonb(a) as row from auth_attempts a where key = any($1) order by key`, [ATTEMPTS_KEPT])).rows
    expect(afterAttempts).toEqual(keptAttempts)
    // Recorded errors, the same way: the two whose last event is over 90 days old are gone (one of them by its first event as
    // well), and the others are the very same rows, also the one whose first event is old but whose last one is recent.
    expect(await errorPlaces()).toEqual([...ERRORS_KEPT].sort())
    expect(await errorRows(ERRORS_KEPT)).toEqual(keptErrors)
    // Alert days, the same way: the two that are more than 30 days back are gone, and the others (29 days, yesterday, today and the
    // building's day when it is a day ahead of the database's date) are the very same rows.
    expect(await pingAges()).toEqual([...PINGS_KEPT].sort((a, b) => b - a))
    expect(await pingRows(PINGS_KEPT)).toEqual(keptPings)
    // Phones: every row is still there. A phone that is due has its label AND everything that it reported cleared, and no other
    // column changed. A phone that is not due (an active one, one revoked 89 days ago) is the very same row, status included, and a
    // due phone that holds nothing is the same row too.
    const labels = await labelsByName(devices)
    for (const name of LABELS_CLEARED) expect(labels[name], name).toBe('')
    for (const [name, label] of Object.entries(LABELS_KEPT)) expect(labels[name], name).toBe(label)
    expect(labels['revoked-91d-no-label']).toBe('')
    const after = await snapshot()
    const phonesAfter = Object.fromEntries(after.provider_devices.map((d) => [d.id, d]))
    expect(Object.keys(phonesAfter).sort()).toEqual(Object.keys(phonesBefore).sort())
    for (const [name, id] of Object.entries(devices)) {
      expect(phonesAfter[id], name).toEqual(PHONES_CLEARED.includes(name) ? { ...phonesBefore[id], ...CLEARED } : phonesBefore[id])
    }
    expect(after.provider_devices.filter((d) => d.label !== '').length).toBe(Object.keys(LABELS_KEPT).length)
    // What is left of a reported status is on the phones that are not due, and nowhere else.
    expect(after.provider_devices.filter((d) => d.app_build !== null).map((d) => d.id).sort()).toEqual(
      [devices['revoked-89d'], devices.active].sort(),
    )
    // Scans, committee members, providers, points, keys, settings: all of it, row for row.
    sameExceptWhatMayChange(before, after)
    expect(after.scans.length).toBeGreaterThanOrEqual(2)
    // The scan of the phone that lost its label is still there and still points at that phone's row.
    const scanned = after.scans.find((s) => s.device_id === devices['revoked-400d-with-scan'])
    expect(scanned).toBeDefined()
    expect(after.provider_devices.some((d) => d.id === scanned.device_id)).toBe(true)

    // The audit log: every row that was there is unchanged (the old ones included), and one row was added.
    expect(after.audit_log.filter((r) => auditBefore.some((b) => b.id === r.id))).toEqual(auditBefore)
    const added = after.audit_log.filter((r) => !auditBefore.some((b) => b.id === r.id))
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      actor_type: 'system',
      actor_id: null,
      actor_name: null, // the system actor is named by actor_type; the name column is the snapshot of a person's name
      action: 'retention.run',
      entity: null,
      entity_id: null,
      detail: { sessions: 3, login_attempts: 2, device_labels: 3, app_errors: 2, alert_pings: 2 },
    })
  })

  it('writes counts and nothing else in the audit row: no id, no name, no label, no token', async () => {
    await seed()
    const { rows: max } = await db.pool.query('select coalesce(max(id), 0)::int as n from audit_log')
    await runRetention()
    const { rows } = await db.pool.query('select * from audit_log where id > $1', [max[0].n])
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0].detail).sort()).toEqual(['alert_pings', 'app_errors', 'device_labels', 'login_attempts', 'sessions'])
    for (const value of Object.values(rows[0].detail)) expect(Number.isInteger(value)).toBe(true)
    const text = JSON.stringify(rows[0])
    for (const secret of ['Fake Browser', 'Fake Person', 'token-', 'expired-', 'revoked-', 'attempt-', 'due-', 'kept-', 'admin@test.local', adminId, providerId]) {
      expect(text, secret).not.toContain(secret)
    }
  })

  it('finds nothing more on a second run, changes no row, and still records that it ran', async () => {
    await seed()
    expect(await runRetention()).toEqual(COUNTS)
    const first = await snapshot()
    expect(await runRetention()).toEqual({ sessions: 0, loginAttempts: 0, deviceLabels: 0, appErrors: 0, alertPings: 0 })
    const second = await snapshot()
    sameExceptWhatMayChange(first, second)
    expect(second.admin_sessions).toEqual(first.admin_sessions)
    expect(second.auth_attempts).toEqual(first.auth_attempts)
    expect(second.provider_devices).toEqual(first.provider_devices)
    expect(second.app_errors).toEqual(first.app_errors)
    expect(second.alert_pings).toEqual(first.alert_pings)
    // The second run adds only its own audit row, with zeros.
    expect(second.audit_log.filter((r) => first.audit_log.some((b) => b.id === r.id))).toEqual(first.audit_log)
    const added = second.audit_log.filter((r) => !first.audit_log.some((b) => b.id === r.id))
    expect(added).toHaveLength(1)
    expect(added[0].detail).toEqual({ sessions: 0, login_attempts: 0, device_labels: 0, app_errors: 0, alert_pings: 0 })
  })

  it('does nothing to a database where nothing is due', async () => {
    await db.pool.query('delete from admin_sessions')
    await db.pool.query('delete from auth_attempts')
    await db.pool.query('delete from provider_devices')
    await db.pool.query('delete from app_errors')
    await db.pool.query('delete from alert_pings')
    expect(await runRetention()).toEqual({ sessions: 0, loginAttempts: 0, deviceLabels: 0, appErrors: 0, alertPings: 0 })
  })

  it('deletes an alert day more than 30 days back, by its day, and touches no other row', async () => {
    await db.pool.query('delete from alert_pings')
    // The day is what counts, not the moment the row was made: a recent row for an old day is due, and an old row for a recent day is kept.
    await db.pool.query(
      `insert into alert_pings (day, sent_at)
       values (current_date - 31, now()), (current_date - 29, now() - interval '400 days'), (current_date, now() - interval '400 days')`,
    )
    const keptBefore = await pingRows([29, 0])
    expect((await runRetention()).alertPings).toBe(1)
    expect(await pingAges()).toEqual([29, 0])
    expect(await pingRows([29, 0])).toEqual(keptBefore)
    expect((await runRetention()).alertPings).toBe(0)
  })

  it('deletes a recorded error 90 days after its last event, by last_at and not by first_at, and touches no other row', async () => {
    await db.pool.query('delete from app_errors')
    // Two rows that differ only by their last event: just over 90 days ago (due) and just under (kept). A third row has a
    // first event that is over a year old but a last event from an hour ago (kept).
    await db.pool.query(
      `insert into app_errors (bucket, source, kind, place, status, count, first_at, last_at)
       values (date_trunc('hour', now() - interval '91 days'), 'server', 'error', 'over-90d', 500, 1, now() - interval '91 days', now() - interval '90 days 1 hour'),
              (date_trunc('hour', now() - interval '90 days'), 'server', 'error', 'under-90d', 500, 1, now() - interval '91 days', now() - interval '89 days 23 hours'),
              (date_trunc('hour', now() - interval '400 days'), 'server', 'error', 'busy-old-row', 500, 9, now() - interval '400 days', now() - interval '1 hour')`,
    )
    const keptBefore = await errorRows(['under-90d', 'busy-old-row'])
    expect((await runRetention()).appErrors).toBe(1)
    expect(await errorPlaces()).toEqual(['busy-old-row', 'under-90d'])
    expect(await errorRows(['under-90d', 'busy-old-row'])).toEqual(keptBefore)
    expect((await runRetention()).appErrors).toBe(0)
  })

  it('never touches an active phone: its label and everything it reported stay, however old its last report is', async () => {
    const { devices } = await seed()
    await db.pool.query(
      `update provider_devices set status_at = now() - interval '1000 days', oldest_waiting_at = now() - interval '1000 days',
              last_sync_at = now() - interval '1000 days' where id = $1`,
      [devices.active],
    )
    const activeBefore = await phoneRow(devices.active)
    const notDueBefore = await phoneRow(devices['revoked-89d'])
    expect(activeBefore).toMatchObject({ label: 'Fake Browser C', ...REPORTED })
    expect(notDueBefore).toMatchObject({ label: 'Fake Browser B', ...REPORTED })
    await runRetention()
    expect(await phoneRow(devices.active)).toEqual(activeBefore)
    expect(await phoneRow(devices['revoked-89d'])).toEqual(notDueBefore)
  })

  it('finds a due phone by any one thing that it reported, also when its label is empty, and counts it once', async () => {
    const { devices } = await seed()
    await runRetention() // clears what the fixture has that is due, so that only the phone below is left to find
    const id = devices[NOTHING_TO_CLEAR]
    expect(await phoneRow(id)).toMatchObject(CLEARED)
    for (const set of [
      `app_build = 'abcdef1'`,
      'status_at = now()',
      'waiting_count = 0',
      'oldest_waiting_at = now()',
      'last_sync_at = now()',
      'not_accepted_total = 1',
      'overflow_total = 1',
    ]) {
      await db.pool.query(`update provider_devices set ${set} where id = $1`, [id])
      expect(await runRetention(), set).toEqual({ sessions: 0, loginAttempts: 0, deviceLabels: 1, appErrors: 0, alertPings: 0 })
      expect(await phoneRow(id), set).toMatchObject(CLEARED)
    }
  })

  it('is all or nothing: when its audit row cannot be written, no session, attempt or label is touched', async () => {
    const { devices } = await seed()
    const before = await snapshot()
    await db.pool.query(`alter table audit_log add constraint no_retention_row check (action <> 'retention.run' or id < 0) not valid`)
    try {
      // NOT VALID: the 'retention.run' rows that are already there are left alone, and every new one is refused.
      await expect(runRetention()).rejects.toMatchObject({ code: '23514' })
    } finally {
      await db.pool.query('alter table audit_log drop constraint no_retention_row')
    }
    const after = await snapshot()
    expect(after).toEqual(before)
    expect((await labelsByName(devices))['revoked-91d']).toBe('Fake Browser A')
  })
})

describe('GET /api/cron/retention', () => {
  const get = (extra = {}) => call('GET', '/api/cron/retention', extra)
  const bearer = (value) => ({ headers: { authorization: `Bearer ${value}` } })

  /** The request must be refused with the one code of the cron guard, and before any database statement. */
  async function expectRefused(label, extra) {
    const { result: res, statements } = await withStatements(() => get(extra))
    expect(res.status, label).toBe(401)
    expect(res.json, label).toEqual({ error: { code: 'cron_required', message: 'Cron secret required' } })
    expect(res.headers['set-cookie'], label).toBeUndefined()
    expect(statements, `${label}: no database statement before the refusal`).toEqual([])
  }

  /** Runs a group of refused requests and checks that, together, they changed nothing in the database. */
  async function expectNothingChanged(group) {
    await seed()
    const before = await snapshot()
    await group()
    expect(await snapshot(), 'a refused request changed the database').toEqual(before)
  }

  it('refuses a request without the secret, a wrong one, and one of another length', async () => {
    const flipped = SECRET.slice(0, -1) + (SECRET.endsWith('0') ? '1' : '0')
    const attempts = [
      ['no header at all', {}],
      ['an empty bearer header', { headers: { authorization: 'Bearer' } }],
      ['a wrong secret of the same length', bearer(flipped)],
      ['a shorter one (the secret without its last character)', bearer(SECRET.slice(0, -1))],
      ['a longer one (the secret and one more character)', bearer(`${SECRET}x`)],
      ['a much shorter one', bearer('x')],
      ['a very long one', bearer('a'.repeat(8000))],
      ['the secret twice', bearer(SECRET + SECRET)],
      ['the secret as a Basic credential', { headers: { authorization: `Basic ${SECRET}` } }],
      ['the secret as the raw header, without a scheme', { headers: { authorization: SECRET } }],
      ['the secret in the admin cookie', { cookie: `qr_admin=${SECRET}` }],
      ['the secret in another header', { headers: { 'x-cron-secret': SECRET } }],
      ['the schedule header that Vercel Cron adds, without the secret', { headers: { 'x-vercel-cron-schedule': '0 1 * * *', 'user-agent': 'vercel-cron/1.0' } }],
    ]
    await expectNothingChanged(async () => {
      for (const [label, extra] of attempts) await expectRefused(label, extra)
    })
  })

  it('refuses every request when CRON_SECRET is not set, whatever the header says', async () => {
    await expectNothingChanged(async () => {
      delete process.env.CRON_SECRET
      try {
        for (const [label, extra] of [
          ['no header', {}],
          ['the usual secret', bearer(SECRET)],
          ['the word undefined', bearer('undefined')],
          ['the word null', bearer('null')],
          ['an empty bearer header', { headers: { authorization: 'Bearer' } }],
          ['a bearer header with only spaces', { headers: { authorization: 'Bearer    ' } }],
          ['a made-up secret', bearer(randomBytes(16).toString('hex'))],
        ]) {
          await expectRefused(`CRON_SECRET unset, ${label}`, extra)
        }
      } finally {
        process.env.CRON_SECRET = SECRET
      }
    })
  })

  it('refuses every request when CRON_SECRET is empty or only spaces', async () => {
    await expectNothingChanged(async () => {
      try {
        for (const value of ['', '   ']) {
          process.env.CRON_SECRET = value
          for (const [label, extra] of [
            ['no header', {}],
            ['an empty bearer header', { headers: { authorization: 'Bearer' } }],
            ['a bearer header with only spaces', { headers: { authorization: 'Bearer    ' } }],
            ['a made-up secret', bearer('x')],
            [`the value itself (${JSON.stringify(value)})`, bearer(value)],
          ]) {
            await expectRefused(`CRON_SECRET ${JSON.stringify(value)}, ${label}`, extra)
          }
        }
      } finally {
        process.env.CRON_SECRET = SECRET
      }
    })
  })

  it('refuses the credentials of the other roles: a committee session, a provider device token and an agent key', async () => {
    // Values shaped like each kind of secret that the server mints; the guard does not look them up, it never accepts them.
    const shaped = ['qra_', 'qrp_', 'qrk_'].map((prefix) => prefix + randomBytes(32).toString('base64url'))
    await expectNothingChanged(async () => {
      for (const value of shaped) {
        await expectRefused(`a bearer token ${value.slice(0, 4)}...`, bearer(value))
        await expectRefused(`a cookie ${value.slice(0, 4)}...`, { cookie: `qr_admin=${value}` })
      }
    })
  })

  it('runs the job for the right secret, answers with the counts only, and logs the counts only', async () => {
    const { devices } = await seed()
    const before = await snapshot()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let res
    let logged
    try {
      res = await get({ token: SECRET })
    } finally {
      logged = [...log.mock.calls]
      log.mockRestore()
    }
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, sessions: 3, login_attempts: 2, device_labels: 3, app_errors: 2, alert_pings: 2 })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(logged).toEqual([['retention: sessions=3 login_attempts=2 device_labels=3 app_errors=2 alert_pings=2']])
    // The job really ran: the due rows are gone, the labels are cleared, nothing else moved.
    expect(await hashes('admin_sessions', 'token_hash')).toEqual([...SESSIONS_KEPT].sort())
    expect(await hashes('auth_attempts', 'key')).toEqual([...ATTEMPTS_KEPT].sort())
    expect(await errorPlaces()).toEqual([...ERRORS_KEPT].sort())
    expect(await pingAges()).toEqual([...PINGS_KEPT].sort((a, b) => b - a))
    const labels = await labelsByName(devices)
    for (const name of LABELS_CLEARED) expect(labels[name], name).toBe('')
    for (const [name, label] of Object.entries(LABELS_KEPT)) expect(labels[name], name).toBe(label)
    for (const name of PHONES_CLEARED) expect(await phoneRow(devices[name]), name).toMatchObject(CLEARED) // what they reported goes with the label
    for (const name of Object.keys(LABELS_KEPT)) expect(await phoneRow(devices[name]), name).toMatchObject(REPORTED)
    sameExceptWhatMayChange(before, await snapshot())
    // Called again (Vercel Cron can deliver twice), it finds nothing more.
    const again = await get({ token: SECRET })
    expect(again.status).toBe(200)
    expect(again.json).toEqual({ ok: true, sessions: 0, login_attempts: 0, device_labels: 0, app_errors: 0, alert_pings: 0 })
  })

  it('answers a method other than GET with 405 and runs nothing, even with the secret', async () => {
    await seed()
    const before = await snapshot()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await call(method, '/api/cron/retention', { token: SECRET, body: {} })
      expect([res.status, res.json?.error?.code], method).toEqual([405, 'method_not_allowed'])
    }
    expect(await snapshot()).toEqual(before)
  })

  it('answers 500 without detail and changes nothing but the one record of the error when the job fails, and logs no row value', async () => {
    const { devices } = await seed()
    const before = await snapshot()
    await db.pool.query(`alter table audit_log add constraint no_retention_row check (action <> 'retention.run' or id < 0) not valid`)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let res
    let logged
    try {
      res = await get({ token: SECRET })
    } finally {
      logged = [...error.mock.calls]
      error.mockRestore()
      await db.pool.query('alter table audit_log drop constraint no_retention_row')
    }
    expect(res.status).toBe(500)
    expect(res.json).toEqual({ error: { code: 'server_error', message: 'Something went wrong' } })
    expect(logged).toHaveLength(1)
    const line = String(logged[0].join(' '))
    expect(line).toContain('GET /api/cron/retention')
    for (const text of ['no_retention_row', 'Fake Browser', 'Fake Person', 'retention.run', SECRET]) expect(line, text).not.toContain(text)
    // The failed job changed nothing: every table is as it was, except app_errors, where the 500 itself is recorded
    // (server/errorLog.js). That is exactly one new row, with safe fields only, and the rows that were there are untouched
    // (the due ones are still there too: the job was rolled back).
    const after = await snapshot()
    const { app_errors: errorsBefore, ...restBefore } = before
    const { app_errors: errorsAfter, ...restAfter } = after
    expect(restAfter).toEqual(restBefore)
    expect(errorsAfter.filter((r) => errorsBefore.some((b) => b.id === r.id))).toEqual(errorsBefore)
    const recorded = errorsAfter.filter((r) => !errorsBefore.some((b) => b.id === r.id))
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      source: 'server',
      kind: 'error',
      place: '/cron/retention', // the route as written in the code
      method: 'GET',
      status: 500,
      code: '23514', // the SQLSTATE of the failed audit row, never its message
      count: 1,
    })
    for (const text of ['no_retention_row', 'Fake Browser', 'Fake Person', 'retention.run', SECRET]) {
      expect(JSON.stringify(recorded[0]), text).not.toContain(text)
    }
    expect((await labelsByName(devices))['revoked-91d']).toBe('Fake Browser A')
  })
})
