// What a phone reports about itself, and what the committee reads of it (ADR 0007, decision 4, "Phone health"; migration 009).
//
// Two writers, one reader:
//   - the phone: POST /api/my/device-status carries a DeviceStatusReport (shared/types.js). parseDeviceStatusReport reads it and
//     reportDeviceStatus stores it on the row of the phone that is signed in, in ONE statement that also throttles it;
//   - the server itself: touchLastSync stamps the end of POST /api/scans/sync, so the time of the last upload is right for every
//     phone, also one that runs an old version of the app and reports nothing;
//   - the committee: listProviderDevices and deviceJson (GET /api/admin/providers/:id/devices). They never select the label (the
//     browser string, which docs/privacy.md says the committee app does not show) or the token hash.
//
// A report never fails: a field that is not valid is ignored (never a 400), a field that is not known is ignored, and the answer
// is always the same, so an installed phone of any version can send it. The limits are in section 8 of shared/contract.js.
//
// The two counts (`not_accepted_total`, `overflowed_total`) are CUMULATIVE and only grow: the phone counts them since it signed in
// and never resets them after a report, and the server keeps the larger of what it holds and what a report says. So a report that
// the phone sends again (the update committed but the answer was lost), a late duplicate and a report that arrives out of order
// change nothing, where adding "since the last report" would count the same visits twice. The earlier fields `not_accepted` and
// `overflowed` (counts since the last report) are ignored like any unknown field. That is safe for the installed apps because no
// released phone ever sent them: the phone side of this report was not released when they were replaced.
import { query } from './db.js'
import { failureLabel } from './logSafe.js'
import { CLOCK_MAX_FUTURE_MS } from './config.js'
import {
  APP_BUILD_RE,
  SYNC_QUEUE_MAX_ITEMS,
  DEVICE_STATUS_MIN_INTERVAL_S,
  DEVICE_STATUS_MAX_TOTAL,
  DEVICE_STATUS_MAX_AGE_DAYS,
} from '../shared/contract.js'

/** @import { DeviceStatusReport } from '../shared/types.js' */

const DAY_MS = 24 * 60 * 60 * 1000

// An ISO 8601 date and time WITH a zone (`2026-10-05T08:30:00.000Z`, what Date.prototype.toISOString writes). Anything that
// `new Date()` would still make a date of (`'1'`, `'2026'`, `'Oct 5'`, a time without a zone, which is read in the server's own
// zone) is not an ISO time and is ignored.
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * The phone's clock for its oldest waiting visit, or null when it is not believable: not a text, not an ISO time, older than
 * DEVICE_STATUS_MAX_AGE_DAYS, or more than CLOCK_MAX_FUTURE_MS ahead of the server's clock (the allowance that a scan's own
 * time gets, server/config.js).
 */
function believableTime(value, now) {
  if (typeof value !== 'string' || !ISO_TIME_RE.test(value)) return null
  const at = new Date(value)
  const ms = at.getTime()
  if (Number.isNaN(ms)) return null
  if (ms < now - DEVICE_STATUS_MAX_AGE_DAYS * DAY_MS || ms > now + CLOCK_MAX_FUTURE_MS) return null
  return at
}

/**
 * A cumulative count that the phone sends: a whole number from 0 is cut to DEVICE_STATUS_MAX_TOTAL, anything else (a negative
 * number, a fraction, a text, null, a missing field) is null: ignored, so the stored value stays.
 */
const totalOf = (value) => (Number.isInteger(value) && value >= 0 ? Math.min(value, DEVICE_STATUS_MAX_TOTAL) : null)

/**
 * What the server takes from a report. Pure: it reads only `body` and the clock, and it never throws, for any body.
 *  - `build`, `waiting`: the value, or null when it is not valid or not sent (the column then keeps what it had);
 *  - `oldest`: undefined when the field is not sent (the column keeps what it had), null when it is sent but not believable or
 *    when nothing waits (`waiting` is 0: nothing waits since any time), else the time as a Date;
 *  - `notAcceptedTotal`, `overflowedTotal`: the cumulative count (0..DEVICE_STATUS_MAX_TOTAL), or null when it is not valid or not
 *    sent (the column then keeps what it had). The column keeps the larger of the two, so this is never a number to add.
 * The fields `not_accepted` and `overflowed` of an earlier shape are not read.
 * @param {unknown} body  the parsed JSON of the request: nobody has checked it yet
 * @param {number} [now]  the server's clock, in ms
 * @returns {{ build: string | null, waiting: number | null, oldest: Date | null | undefined, notAcceptedTotal: number | null, overflowedTotal: number | null }}
 */
export function parseDeviceStatusReport(body, now = Date.now()) {
  // Nobody has checked the body: it is read as a DeviceStatusReport only so that the names of its fields are known to the type
  // checker. Every field is looked at with a check of its own below, and any other field of it is never looked at.
  /** @type {DeviceStatusReport} */
  const report = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const build = typeof report.build === 'string' && APP_BUILD_RE.test(report.build) ? report.build : null
  const waiting =
    Number.isInteger(report.waiting) && report.waiting >= 0 && report.waiting <= SYNC_QUEUE_MAX_ITEMS ? report.waiting : null
  let oldest
  if (waiting === 0) oldest = null
  else if (Object.hasOwn(report, 'oldest_waiting_at')) oldest = believableTime(report.oldest_waiting_at, now)
  return {
    build,
    waiting,
    oldest,
    notAcceptedTotal: totalOf(report.not_accepted_total),
    overflowedTotal: totalOf(report.overflowed_total),
  }
}

/**
 * Stores a report on the row of the phone that sent it (the id that the guard found for its token, never one from the body). ONE
 * statement does everything, so there is no read before the write to race with:
 *  - the throttle is its `where`: a phone that reported less than DEVICE_STATUS_MIN_INTERVAL_S seconds ago matches no row, and
 *    nothing changes;
 *  - each of the two totals becomes the larger of the stored value and the reported one (`greatest`, which skips a null, so a total
 *    that was not sent or not valid leaves the column as it is). A total only grows, so a report that is sent again, a late
 *    duplicate or one that arrives out of order changes nothing. A reported value is at most DEVICE_STATUS_MAX_TOTAL, far under
 *    what an `integer` holds, so there is no sum that could overflow the column;
 *  - a revoked phone is not touched (the guard refused it already; this only closes the gap between the guard and the write).
 * Returns whether a report was stored. A failure of the database is thrown as it is (the router answers 500 and logs its code).
 * @param {string} deviceId
 * @param {ReturnType<typeof parseDeviceStatusReport>} report
 * @returns {Promise<boolean>}
 */
export async function reportDeviceStatus(deviceId, report) {
  const { rowCount } = await query(
    `update provider_devices
        set app_build = coalesce($2::text, app_build),
            waiting_count = coalesce($3::integer, waiting_count),
            oldest_waiting_at = case when $4::boolean then $5::timestamptz else oldest_waiting_at end,
            not_accepted_total = greatest(not_accepted_total, $6::integer),
            overflow_total = greatest(overflow_total, $7::integer),
            status_at = now()
      where id = $1
        and revoked_at is null
        and (status_at is null or status_at <= now() - make_interval(secs => $8::integer))`,
    [
      deviceId,
      report.build,
      report.waiting,
      report.oldest !== undefined,
      report.oldest ?? null,
      report.notAcceptedTotal,
      report.overflowedTotal,
      DEVICE_STATUS_MIN_INTERVAL_S,
    ],
  )
  return rowCount === 1
}

/**
 * Stamps the end of an upload on the phone's row. Called after the items of POST /api/scans/sync are all recorded, so a failure
 * here changes nothing that the phone is told: the visits are committed and the answer is the same. It is swallowed and one line
 * is logged with the failure's code or name and never its message (server/logSafe.js).
 * @param {string} deviceId
 */
export async function touchLastSync(deviceId) {
  try {
    await query('update provider_devices set last_sync_at = now() where id = $1', [deviceId])
  } catch (err) {
    console.error(`last upload time not stored: ${failureLabel(err)}`)
  }
}

/**
 * The health of a provider's ACTIVE phones, as a SQL fragment for a list of providers: `cross join lateral (...) phones`, to be
 * written after `from providers p` (the alias `p` is what it joins on). It gives each provider three columns, which the caller
 * selects as `phones.waiting`, `phones.oldest_waiting_at` and `phones.outdated_devices`:
 *  - `waiting`: the sum of what the phones say waits in their queues (0 when none reported);
 *  - `oldest_waiting_at`: the oldest of the phones that have something waiting (null when none);
 *  - `outdated_devices`: how many phones reported a build that is not the server's own (0 when the server does not know its build).
 * $1 is the server's build (`commit()` in server/health.js), so the caller's own values start at $2. The committee's providers
 * list uses it (PROVIDER_SELECT in server/routes/admin.js).
 */
export const PHONE_HEALTH_LATERAL = `cross join lateral (
      select coalesce(sum(d.waiting_count), 0)::int as waiting,
             min(d.oldest_waiting_at) filter (where d.waiting_count > 0) as oldest_waiting_at,
             (count(*) filter (where d.app_build is not null and d.app_build <> $1::text))::int as outdated_devices
        from provider_devices d
       where d.provider_id = p.id and d.revoked_at is null
    ) phones`

/**
 * The active phones of a provider (not revoked), the one that was used last first, or null when there is no such provider (the
 * caller answers 404). One statement: a provider with no active phone comes back as one row with no phone in it, which tells
 * "no phones" from "no provider" without a second query that could disagree. Only the columns that the committee may see.
 * @param {string} providerId
 */
export async function listProviderDevices(providerId) {
  const { rows } = await query(
    `select d.id, d.created_at, d.last_seen_at, d.status_at, d.last_sync_at, d.app_build, d.waiting_count,
            d.oldest_waiting_at, d.not_accepted_total, d.overflow_total
       from providers p
       left join provider_devices d on d.provider_id = p.id and d.revoked_at is null
      where p.id = $1
      order by d.last_seen_at desc nulls last, d.id`,
    [providerId],
  )
  if (!rows.length) return null
  return rows.filter((row) => row.id !== null)
}

const iso = (time) => (time === null || time === undefined ? null : new Date(time).toISOString())

/**
 * One phone as the committee's API shows it. ISO times, as everywhere in the API (a machine must not guess day-month or
 * month-day). `outdated` is true when the phone reported a build, the server knows its own (`serverBuild`, from commit() in
 * server/health.js) and the two differ: a phone that has not been updated since an earlier release.
 * @param {any} row  a row of listProviderDevices
 * @param {string | null} serverBuild
 */
export const deviceJson = (row, serverBuild) => ({
  id: row.id,
  created_at: iso(row.created_at),
  last_seen_at: iso(row.last_seen_at),
  status_at: iso(row.status_at),
  last_sync_at: iso(row.last_sync_at),
  app_build: row.app_build,
  waiting_count: row.waiting_count,
  oldest_waiting_at: iso(row.oldest_waiting_at),
  not_accepted_total: row.not_accepted_total,
  overflow_total: row.overflow_total,
  outdated: row.app_build !== null && serverBuild !== null && row.app_build !== serverBuild,
})
