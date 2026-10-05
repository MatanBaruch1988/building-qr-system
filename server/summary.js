// The daily summary of the last 24 hours (docs/adr/0007-observability-in-our-own-postgres.md, step 2). GET /api/cron/daily-summary
// builds it once a day, called by Vercel Cron, and pings the owner's check on healthchecks.io with a short plain-text body
// (server/routes/cron.js, server/heartbeat.js): at the base address when the hours were fine, at /fail when they held a technical
// problem. healthchecks.io alerts on a change of state, and a day with no ping at all is an alert too, so the daily ping also
// proves that the server and its cron are alive.
//
// buildSummary reads the database and decides the verdict. summaryText writes the body from the result, and is pure.
//
// What it reads, all in ONE read-only transaction (`set transaction read only` first, so that it cannot write by a mistake), over
// the SUMMARY_PERIOD_HOURS (24) hours before `now`. An event of app_errors belongs to the period by its last event (`last_at`),
// so a row whose hour straddles the start is counted by the summary that follows the event and never lost (it can be counted
// by two summaries, which at worst repeats a /fail).
//   (a) server errors: app_errors from the server with kind `error`, added up by route and code. A failure.
//   (b) the apps' errors: app_errors from the provider's app and the committee app that are not refusals or slow requests, by app,
//       kind, screen, code and build. A `crash` or an `unhandled` event is a failure; the others are information. The apps start
//       to report in a later pull request, so today this is empty.
//   (c) refusals and slow requests: app_errors of kind `refusal` or `slow`, from any source, by source, kind, place and code.
//       Information only. Recorded by a later pull request.
//   (d) the retention job: its newest audit_log row (`retention.run`). It ran when that row is younger than
//       SUMMARY_RETENTION_MAX_AGE_HOURS (26); when it did not, that is a failure.
//   (e) visits not counted: scan_refusals of the period, by code. Information only (a refusal that the rules intend, such as a
//       provider who is not assigned to the point, is not a technical problem).
//   (f) phones: active phones (not revoked) that are stuck (waiting visits whose oldest is more than SUMMARY_STUCK_PHONE_HOURS
//       old; a failure), how many of those uploaded in the period and are still stuck (they upload but do not drain), and how
//       many report another build than the server's own (information only).
//   (g) sign-ins: new provider phones (provider_devices.created_at) and committee sign-ins (audit_log `session.sign_in`), each
//       against the median per day of the SUMMARY_SIGNIN_BASELINE_DAYS days before the period. A spike (a count of at least
//       SUMMARY_SIGNIN_SPIKE_MIN that is more than SUMMARY_SIGNIN_SPIKE_FACTOR times the median) is a failure. Nothing writes
//       `session.sign_in` yet (the audit screen reserves the group for a later change), so the committee's count is 0 until then.
//
// What the body may hold (AGENTS.md, Safety): numbers, route patterns as they are written in the code, codes, screen keys,
// builds and times written by shared/datetime.js. Never a name, an e-mail, a QR code, the label of a phone, the name of a provider
// or a point, an id or a message. The queries never select such a column; and as a last line of defence a place, a code or a
// build is printed only when it is made of the characters that those values are made of (see `safe` below).
import { tx } from './db.js'
import { commit } from './health.js'
import {
  SUMMARY_PERIOD_HOURS,
  SUMMARY_TOP,
  SUMMARY_RETENTION_MAX_AGE_HOURS,
  SUMMARY_STUCK_PHONE_HOURS,
  SUMMARY_SIGNIN_BASELINE_DAYS,
  SUMMARY_SIGNIN_SPIKE_MIN,
  SUMMARY_SIGNIN_SPIKE_FACTOR,
} from './config.js'
import { formatDateTime } from '../shared/datetime.js'

const HOUR_MS = 60 * 60 * 1000

/**
 * @typedef {object} Ranked
 * @property {number} total  how many events, all kinds together
 * @property {number} kinds  how many different kinds there are (the list below holds at most SUMMARY_TOP of them)
 * @property {Array<{ source: string, kind: string, place: string, code: string, build: string, n: number }>} top  the most
 *   frequent first; a field that does not apply to the list is an empty string
 */

/**
 * @typedef {object} Series
 * @property {number} n  the count in the period
 * @property {number} median  the median per day of the days before the period (a half is possible)
 * @property {boolean} spike  at least SUMMARY_SIGNIN_SPIKE_MIN, and more than SUMMARY_SIGNIN_SPIKE_FACTOR times the median
 */

/**
 * @typedef {object} Summary
 * @property {{ from: Date, to: Date }} period
 * @property {'ok' | 'fail'} verdict
 * @property {string[]} reasons  why it failed, in a fixed order, from a fixed list of words (REASONS); empty when it is ok
 * @property {Ranked} server  (a) the errors of the server
 * @property {Ranked & { crashes: number }} apps  (b) the errors of the apps; `crashes` counts the `crash` and `unhandled` events
 * @property {Ranked} noted  (c) refusals and slow requests
 * @property {{ ran: boolean, at: Date | null, counts: Record<string, number> | null }} retention  (d)
 * @property {{ total: number, kinds: number, top: Array<{ code: string, n: number }> }} refusals  (e) visits not counted, by code
 * @property {{ stuck: number, stuckUploading: number, outdated: number, build: string | null }} phones  (f)
 * @property {{ phones: Series, committee: Series }} signIns  (g)
 */

/** The words of `Summary.reasons`: what makes a summary fail, one word each. The log line and the answer of the route use them. */
export const REASONS = Object.freeze(['server_error', 'app_crash', 'retention_missing', 'stuck_phone', 'signin_spike'])

// How the body says each reason.
const REASON_TEXT = Object.freeze({
  server_error: 'server error',
  app_crash: 'app crash or unhandled error',
  retention_missing: 'retention job did not run',
  stuck_phone: 'stuck phone',
  signin_spike: 'sign-in spike',
})

// The five numbers that the retention job writes in its audit row (server/retention.js), and how the body says them.
const RETENTION_COUNTS = Object.freeze([
  ['sessions', 'sessions'],
  ['login_attempts', 'login attempts'],
  ['device_labels', 'device labels'],
  ['app_errors', 'app errors'],
  ['alert_pings', 'alert pings'],
])

// The events of app_errors, ranked within three lists. A row belongs to one list: the server's own errors (a), a refusal or a slow
// request of any source (c), and what is left of the two apps (b); anything else (a `crash` that the server records, say) is in none.
// The columns that do not apply to a list are blanked before the rows are added up, so that the list is "by place and code" (a),
// "by app, kind, place, code and build" (b) and "by source, kind, place and code" (c). `crashes` counts the events that fail the
// summary, over the whole list and not only over the rows that are returned. The order is made total with the C collation, so that
// two kinds with the same count always come out in the same order, whatever the collation of the database.
const EVENTS_SQL = `
  with base as (
    select case
             when source = 'server' and kind = 'error' then 'server'
             when kind in ('refusal', 'slow') then 'noted'
             when source in ('provider_app', 'committee_app') then 'apps'
           end as section,
           source, kind, place, code, app_build, count as n
      from app_errors
     where last_at >= $1 and last_at <= $2
  ), grouped as (
    select section,
           case when section = 'server' then '' else source end as source,
           case when section = 'server' then 'error' else kind end as kind,
           place, code,
           case when section = 'apps' then app_build else '' end as build,
           sum(n)::int as n,
           coalesce(sum(n) filter (where kind in ('crash', 'unhandled')), 0)::int as crashes
      from base
     where section is not null
     group by 1, 2, 3, 4, 5, 6
  ), ranked as (
    select section, source, kind, place, code, build, n,
           row_number() over (partition by section order by n desc, place collate "C", code collate "C", source collate "C",
                                                        kind collate "C", build collate "C") as pos,
           sum(n) over (partition by section)::int as total,
           count(*) over (partition by section)::int as kinds,
           sum(crashes) over (partition by section)::int as crashes
      from grouped
  )
  select section, source, kind, place, code, build, n, total, kinds, crashes
    from ranked
   where pos <= $3
   order by section, pos`

// The newest run of the retention job that is not in the future of `now`.
const RETENTION_SQL = `
  select at, detail
    from audit_log
   where action = 'retention.run' and at <= $1
   order by at desc, id desc
   limit 1`

const REFUSALS_SQL = `
  select code, count(*)::int as n, sum(count(*)) over ()::int as total, count(*) over ()::int as kinds
    from scan_refusals
   where at >= $1 and at <= $2
   group by code
   order by n desc, code collate "C"
   limit $3`

// Active phones only (not revoked). A phone is stuck when visits wait on it and the oldest of them is older than the limit;
// `$4` is the build that the server runs, and null (a deployment that is not from Git) says that no phone can be called outdated.
const PHONES_SQL = `
  select count(*) filter (where waiting_count > 0 and oldest_waiting_at < $2::timestamptz - make_interval(hours => $3::int))::int as stuck,
         count(*) filter (where waiting_count > 0 and oldest_waiting_at < $2::timestamptz - make_interval(hours => $3::int)
                            and last_sync_at >= $1 and last_sync_at <= $2)::int as stuck_uploading,
         count(*) filter (where $4::text is not null and app_build is not null and app_build <> $4::text)::int as outdated
    from provider_devices
   where revoked_at is null`

// New phones and committee sign-ins, counted by period: bucket 0 and up is the period itself, -1 is the day before it, -2 the one
// before that, and so on (`$4` is the length of a period in seconds; each baseline day is one period long, so a day is exactly
// as long as the period, whatever the clock changes of the building do). `$1` is the start of the baseline, `$2` the start of the
// period and `$3` now.
const SIGNINS_SQL = `
  select series, bucket, count(*)::int as n
    from (
      select 'phones' as series,
             floor((extract(epoch from created_at) - extract(epoch from $2::timestamptz)) / $4::numeric)::int as bucket
        from provider_devices
       where created_at >= $1 and created_at <= $3
      union all
      select 'committee' as series,
             floor((extract(epoch from at) - extract(epoch from $2::timestamptz)) / $4::numeric)::int as bucket
        from audit_log
       where action = 'session.sign_in' and at >= $1 and at <= $3
    ) s
   group by series, bucket`

/** The median of a list of numbers (the mean of the two middle ones for an even count, so it can end in .5). */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * The count of the period, and the median of the baseline days, from the rows of SIGNINS_SQL for one series.
 * @param {Array<{ bucket: number, n: number }>} rows
 * @returns {Series}
 */
function seriesOf(rows) {
  let n = 0
  const days = new Array(SUMMARY_SIGNIN_BASELINE_DAYS).fill(0) // a day with no sign-in is a 0, and counts in the median
  for (const row of rows) {
    if (row.bucket >= 0) n += row.n
    else if (row.bucket >= -SUMMARY_SIGNIN_BASELINE_DAYS) days[-row.bucket - 1] += row.n
  }
  const middle = median(days)
  return { n, median: middle, spike: n >= SUMMARY_SIGNIN_SPIKE_MIN && n > SUMMARY_SIGNIN_SPIKE_FACTOR * middle }
}

/** @returns {Ranked & { crashes: number }} */
function rankedOf(rows, section) {
  const mine = rows.filter((r) => r.section === section)
  return {
    total: mine[0]?.total ?? 0,
    kinds: mine[0]?.kinds ?? 0,
    crashes: mine[0]?.crashes ?? 0,
    top: mine.map(({ source, kind, place, code, build, n }) => ({ source, kind, place, code, build, n })),
  }
}

/**
 * Whether the summary is a failure, and why. Pure. The causes are a server error, an app crash or unhandled error, a retention
 * job that did not run, a stuck phone and a sign-in spike. Visits not counted, refusals, slow requests and outdated phones are
 * information: they are in the body and never fail it.
 * @param {Omit<Summary, 'verdict' | 'reasons'>} parts
 * @returns {{ verdict: 'ok' | 'fail', reasons: string[] }}
 */
export function judge({ server, apps, retention, phones, signIns }) {
  const found = {
    server_error: server.total > 0,
    app_crash: apps.crashes > 0,
    retention_missing: !retention.ran,
    stuck_phone: phones.stuck > 0,
    signin_spike: signIns.phones.spike || signIns.committee.spike,
  }
  const reasons = REASONS.filter((reason) => found[reason])
  return { verdict: reasons.length ? 'fail' : 'ok', reasons }
}

/**
 * Reads the last SUMMARY_PERIOD_HOURS hours before `now` and returns the summary (see the header). Read-only, one transaction,
 * so the numbers are one picture. A failure of the database is thrown as it is: the caller decides what to say.
 * @param {{ now?: Date }} [options]  the moment that the period ends at (default: now)
 * @returns {Promise<Summary>}
 */
export async function buildSummary({ now = new Date() } = {}) {
  const to = now
  const from = new Date(to.getTime() - SUMMARY_PERIOD_HOURS * HOUR_MS)
  const baselineFrom = new Date(from.getTime() - SUMMARY_SIGNIN_BASELINE_DAYS * SUMMARY_PERIOD_HOURS * HOUR_MS)
  const build = commit()

  const read = await tx(async (c) => {
    await c.query('set transaction read only')
    const events = await c.query(EVENTS_SQL, [from, to, SUMMARY_TOP])
    const retention = await c.query(RETENTION_SQL, [to])
    const refusals = await c.query(REFUSALS_SQL, [from, to, SUMMARY_TOP])
    const phones = await c.query(PHONES_SQL, [from, to, SUMMARY_STUCK_PHONE_HOURS, build])
    const signIns = await c.query(SIGNINS_SQL, [baselineFrom, from, to, SUMMARY_PERIOD_HOURS * 3600])
    return { events: events.rows, retention: retention.rows[0], refusals: refusals.rows, phones: phones.rows[0], signIns: signIns.rows }
  })

  const last = read.retention
  const lastAt = last ? new Date(last.at) : null
  // The counts are read from the row by the names the job writes; anything else in it is not looked at, and only a whole number counts.
  const detail = last?.detail && typeof last.detail === 'object' ? last.detail : null
  const counts = detail
    ? Object.fromEntries(RETENTION_COUNTS.filter(([key]) => Number.isInteger(detail[key])).map(([key]) => [key, detail[key]]))
    : null

  const parts = {
    period: { from, to },
    server: rankedOf(read.events, 'server'),
    apps: rankedOf(read.events, 'apps'),
    noted: rankedOf(read.events, 'noted'),
    retention: {
      ran: lastAt !== null && to.getTime() - lastAt.getTime() < SUMMARY_RETENTION_MAX_AGE_HOURS * HOUR_MS,
      at: lastAt,
      counts,
    },
    refusals: {
      total: read.refusals[0]?.total ?? 0,
      kinds: read.refusals[0]?.kinds ?? 0,
      top: read.refusals.map(({ code, n }) => ({ code, n })),
    },
    phones: { stuck: read.phones.stuck, stuckUploading: read.phones.stuck_uploading, outdated: read.phones.outdated, build },
    signIns: {
      phones: seriesOf(read.signIns.filter((r) => r.series === 'phones')),
      committee: seriesOf(read.signIns.filter((r) => r.series === 'committee')),
    },
  }
  return { ...parts, ...judge(parts) }
}

/**
 * The counts of a summary, by name, for the answer of the route and its log line: numbers and one boolean, nothing else.
 * @param {Summary} summary
 */
export function summaryCounts(summary) {
  const { server, apps, noted, retention, refusals, phones, signIns } = summary
  return {
    server_errors: server.total,
    app_errors: apps.total,
    app_crashes: apps.crashes,
    refusals_and_slow: noted.total,
    retention_ran: retention.ran,
    visits_not_counted: refusals.total,
    stuck_phones: phones.stuck,
    stuck_phones_uploading: phones.stuckUploading,
    outdated_phones: phones.outdated,
    new_phones: signIns.phones.n,
    committee_sign_ins: signIns.committee.n,
  }
}

// What a place, a code or a build is made of: letters, digits and the few marks of a route pattern (`/admin/points/:id`), a screen
// key, an error code or name (`57014`, `ECONNREFUSED`, `TypeError`) and `(unknown)`. A value with any other character (a space, an @,
// a comma) cannot be one of those, so it is not printed: it is a sign that something that is not a safe field got in, and the
// body says `(other)` and nothing about it. (Nothing is known to write such a value; this is the last line of defence.)
const SAFE_VALUE = /^[A-Za-z0-9_:/.()-]+$/

/** `value` when it is safe to print (see SAFE_VALUE), `(other)` when it is not, and '' for nothing. */
const safe = (value) => (value === '' || value === null || value === undefined ? '' : SAFE_VALUE.test(String(value)) ? String(value) : '(other)')

/** `3 kinds`, `1 kind`. */
const kindsOf = (n) => `${n} kind${n === 1 ? '' : 's'}`

/** The line of a list: `<label>: <total> in <k kinds>: <entry> x<n>; ...`, and `(+2 more kinds)` when the list is cut. */
function listLine(label, { total, kinds, top }, entryOf) {
  const left = kinds - top.length
  const more = left > 0 ? ` (+${left} more ${left === 1 ? 'kind' : 'kinds'})` : ''
  return `${label}: ${total} in ${kindsOf(kinds)}: ${top.map((row) => `${entryOf(row)} x${row.n}`).join('; ')}${more}`
}

/**
 * The body that goes to healthchecks.io: plain text, one first line with the verdict and the period (DD/MM/YYYY HH:MM, the
 * building's time, written by shared/datetime.js), then a line for each section that has something. Pure. See the header for
 * what it may hold. It is far below HEARTBEAT_BODY_MAX_BYTES: each list names at most SUMMARY_TOP kinds, and each value is short.
 * @param {Summary} summary
 * @returns {string}
 */
export function summaryText(summary) {
  const { period, verdict, reasons, server, apps, noted, retention, refusals, phones, signIns } = summary
  const lines = [`Daily summary ${verdict === 'fail' ? 'FAIL' : 'OK'}: ${formatDateTime(period.from)} to ${formatDateTime(period.to)}`]
  if (reasons.length) lines.push(`Why: ${reasons.map((reason) => REASON_TEXT[reason] ?? reason).join(', ')}`)

  if (server.total > 0) {
    lines.push(listLine('Server errors', server, (row) => [safe(row.place), safe(row.code)].filter(Boolean).join(' ')))
  }
  if (apps.total > 0) {
    lines.push(
      listLine('App errors', apps, (row) =>
        [safe(row.source), safe(row.kind), safe(row.place), safe(row.code), row.build ? `build ${safe(row.build)}` : ''].filter(Boolean).join(' '),
      ),
    )
  }
  if (noted.total > 0) {
    lines.push(
      listLine('Refusals and slow requests', noted, (row) =>
        [safe(row.source), safe(row.kind), safe(row.place), safe(row.code)].filter(Boolean).join(' '),
      ),
    )
  }

  if (retention.ran) {
    const counts = RETENTION_COUNTS.filter(([key]) => retention.counts && key in retention.counts).map(
      ([key, name]) => `${name} ${retention.counts[key]}`,
    )
    lines.push(`Retention job: ran ${formatDateTime(retention.at)}${counts.length ? ` (${counts.join(', ')})` : ''}`)
  } else {
    lines.push(
      `Retention job: DID NOT RUN, no run in the last ${SUMMARY_RETENTION_MAX_AGE_HOURS} hours` +
        (retention.at ? ` (the last one was ${formatDateTime(retention.at)})` : ' (no run is recorded)'),
    )
  }

  if (refusals.total > 0) {
    lines.push(listLine('Visits not counted', refusals, (row) => safe(row.code) || '(none)'))
  }

  const phoneParts = []
  if (phones.stuck > 0) {
    phoneParts.push(`${phones.stuck} stuck (visits waiting for more than ${SUMMARY_STUCK_PHONE_HOURS} hours)`)
    if (phones.stuckUploading > 0) phoneParts.push(`${phones.stuckUploading} of them uploaded in the period and are still stuck`)
  }
  if (phones.outdated > 0) phoneParts.push(`${phones.outdated} outdated (the server is on build ${safe(phones.build)})`)
  if (phoneParts.length) lines.push(`Phones: ${phoneParts.join('; ')}`)

  /** @type {Array<{ label: string, series: Series }>} */
  const counted = [
    { label: 'New provider phones', series: signIns.phones },
    { label: 'Committee sign-ins', series: signIns.committee },
  ]
  for (const { label, series } of counted) {
    if (series.n > 0 || series.spike) {
      lines.push(`${label}: ${series.n} (median per day before: ${series.median})${series.spike ? ', SPIKE' : ''}`)
    }
  }

  return lines.join('\n')
}
