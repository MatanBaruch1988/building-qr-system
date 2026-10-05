// What a phone reports about itself, and what the committee reads of it (ADR 0007, decision 4, "Phone health"; migration 010).
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
import { query } from './db.js'
import { failureLabel } from './logSafe.js'
import { CLOCK_MAX_FUTURE_MS } from './config.js'
import {
  APP_BUILD_RE,
  SYNC_QUEUE_MAX_ITEMS,
  DEVICE_STATUS_MIN_INTERVAL_S,
  DEVICE_STATUS_MAX_COUNT,
  DEVICE_STATUS_MAX_AGE_DAYS,
} from '../shared/contract.js'

/** @import { DeviceStatusReport } from '../shared/types.js' */

const DAY_MS = 24 * 60 * 60 * 1000

// The largest value of a Postgres `integer`. A running total is cut to it instead of failing the report with an overflow.
const INTEGER_MAX = 2147483647

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

/** A count that the phone sends: a whole number is cut to 0..DEVICE_STATUS_MAX_COUNT, anything else counts as 0 (ignored). */
const countOf = (value) => (Number.isInteger(value) ? Math.min(Math.max(value, 0), DEVICE_STATUS_MAX_COUNT) : 0)

/**
 * What the server takes from a report. Pure: it reads only `body` and the clock, and it never throws, for any body.
 *  - `build`, `waiting`: the value, or null when it is not valid or not sent (the column then keeps what it had);
 *  - `oldest`: undefined when the field is not sent (the column keeps what it had), null when it is sent but not believable or
 *    when nothing waits (`waiting` is 0: nothing waits since any time), else the time as a Date;
 *  - `notAccepted`, `overflowed`: what to add to the running totals, 0 for a field that is not valid or not sent.
 * @param {unknown} body  the parsed JSON of the request: nobody has checked it yet
 * @param {number} [now]  the server's clock, in ms
 * @returns {{ build: string | null, waiting: number | null, oldest: Date | null | undefined, notAccepted: number, overflowed: number }}
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
  return { build, waiting, oldest, notAccepted: countOf(report.not_accepted), overflowed: countOf(report.overflowed) }
}

/**
 * Stores a report on the row of the phone that sent it (the id that the guard found for its token, never one from the body). ONE
 * statement does everything, so there is no read before the write to race with:
 *  - the throttle is its `where`: a phone that reported less than DEVICE_STATUS_MIN_INTERVAL_S seconds ago matches no row, and
 *    nothing changes;
 *  - the two totals are added in `bigint` and cut to INTEGER_MAX, so they can never overflow the column;
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
            not_accepted_total = least(not_accepted_total::bigint + $6::integer, ${INTEGER_MAX})::integer,
            overflow_total = least(overflow_total::bigint + $7::integer, ${INTEGER_MAX})::integer,
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
      report.notAccepted,
      report.overflowed,
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
