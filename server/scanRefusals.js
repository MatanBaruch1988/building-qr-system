// A visit that the server refused leaves a trace (ADR 0007, "Visits not counted"; the table is scan_refusals, migration 008).
//
// Why it exists: a phone drops a queued check-in when the server refuses it with a permanent code (SYNC_PERMANENT_ERROR_CODES
// in shared/contract.js: point_inactive, not_assigned, unknown_code, ...), and the same refusals happen online. Before this,
// the server kept nothing, so the committee never learned that a visit was not counted. What is recorded is only what a
// scan keeps (the provider's name as it was, the point, the time of the server and of the phone, which phone) and the code.
// Not the position and not the QR code that was scanned.
//
// What it is NOT: not a scan and not an outcome. SCAN_OUTCOMES and the agent API do not change, the answer of an item and the
// answer of POST /api/scan are exactly what they were, and a refusal never blocks a later scan with the same id. Distance and
// a missing position (rejected_far, rejected_no_location) are not refusals of this kind: they are stored as scans.
//
// Failure policy, written down because it decides what a phone keeps:
//   - an infrastructure failure of the insert (a connection, a timeout) is thrown on: the batch of a sync answers 500, the
//     phone keeps its items and sends them again, and the items that were already recorded replay by id. So a refusal always
//     leaves either a record or a retry;
//   - a failure that is the data's fault (SQLSTATE class 22 or 23, for example a check constraint) never breaks the answer:
//     the refusal is not recorded and one line says so, with the code of the failure and never its message.
import { query } from './db.js'
import { bad, isUuid } from './http.js'
import { failureLabel } from './logSafe.js'
import { parseBound, providerSnapshotName } from './scans.js'
import { parseClientTime } from './scanLogic.js'
import {
  DEFAULT_PAGE_SIZE,
  MAX_REFUSAL_PAGE_SIZE,
  REFUSAL_POINT_NAME_MAX_LENGTH,
  REFUSAL_PROVIDER_NAME_MAX_LENGTH,
  TIMEZONE,
} from './config.js'
import { SYNC_PERMANENT_ERROR_CODES } from '../shared/contract.js'

/** True when the database refused one item's data (out of range, malformed, a constraint): retrying can never help. */
export const isDataError = (err) => typeof err?.code === 'string' && /^2[23]/.test(err.code)

/** The first `max` characters of `text` (by characters, so a name is never cut through the middle of one). */
const cutChars = (text, max) => Array.from(String(text)).slice(0, max).join('')

/**
 * Writes one refusal. One statement, run by the module's `query()` and not inside the transaction of the item, because that
 * transaction was rolled back by the refusal. A visit that is sent again (same `scanId`) is not counted twice: the second
 * insert does nothing. A refusal with no `scanId` (the phone sent none that is valid) cannot be matched, so it is a row of its own.
 * Throws what the database throws: the caller decides (see recordRefusedVisit).
 * @param {object} refusal
 * @param {string | null} [refusal.scanId]  the phone's id of the check-in, when it is a valid one
 * @param {string} refusal.source  SOURCE_ONLINE or SOURCE_OFFLINE_SYNC
 * @param {string} refusal.code  the SCAN_ERROR_* code that the phone is told
 * @param {string} refusal.providerId
 * @param {string} refusal.providerName  the snapshot, as providerSnapshotName writes it
 * @param {string | null} [refusal.deviceId]
 * @param {string | null} [refusal.pointId]  null when the code named no point
 * @param {string | null} [refusal.pointName]
 * @param {Date | null} [refusal.clientTime]  the phone's clock, when it can be believed (parseClientTime)
 */
export async function recordRefusal({ scanId = null, source, code, providerId, providerName, deviceId = null, pointId = null, pointName = null, clientTime = null }) {
  await query(
    `insert into scan_refusals (scan_id, source, code, provider_id, provider_name, device_id, point_id, point_name, client_time)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (scan_id) where scan_id is not null do nothing`,
    [
      scanId,
      source,
      code,
      providerId,
      cutChars(providerName, REFUSAL_PROVIDER_NAME_MAX_LENGTH),
      deviceId,
      pointId,
      pointName === null ? null : cutChars(pointName, REFUSAL_POINT_NAME_MAX_LENGTH),
      clientTime,
    ],
  )
}

/**
 * Records a refused visit, when the refusal is one that the phone treats as final (a code of SYNC_PERMANENT_ERROR_CODES: the
 * visit will never be counted). The callers are the sync handler (per item) and POST /api/scan.
 * @param {object} args
 * @param {string} args.code  the code that the phone is told (for a database refusal of an item: SCAN_ERROR_INVALID_ITEM)
 * @param {string} args.source  SOURCE_ONLINE or SOURCE_OFFLINE_SYNC
 * @param {{ id: string, company: string, contact_name?: string | null }} args.provider  who scanned
 * @param {string | null} [args.deviceId]  which phone
 * @param {{ id?: unknown, clientTime?: unknown }} args.input  what the phone sent (the scan id and its clock)
 * @param {any} [args.err]  what recordScan threw: when it carries `refusal`, that is the point that the code named
 */
export async function recordRefusedVisit({ code, source, provider, deviceId = null, input, err }) {
  if (!SYNC_PERMANENT_ERROR_CODES.includes(code)) return
  try {
    await recordRefusal({
      scanId: isUuid(input?.id) ? String(input.id).toLowerCase() : null,
      source,
      code,
      providerId: provider.id,
      providerName: providerSnapshotName(provider),
      deviceId,
      pointId: err?.refusal?.pointId ?? null,
      pointName: err?.refusal?.pointName ?? null,
      clientTime: parseClientTime(input?.clientTime),
    })
  } catch (failure) {
    if (!isDataError(failure)) throw failure
    console.error(`scan refusal not recorded: ${failureLabel(failure)}`)
  }
}

// ---------- reading (the committee's list) ----------

// The cursor is built in JavaScript, so it carries the time in milliseconds: the column has that precision (migration 008).
const encodeCursor = (row) => Buffer.from(JSON.stringify({ t: new Date(row.at).toISOString(), id: Number(row.id) })).toString('base64url')

function decodeCursor(cursor) {
  try {
    const { t, id } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    if (typeof t !== 'string' || !Number.isSafeInteger(id) || id < 1) throw new Error('bad')
    const when = new Date(t)
    if (Number.isNaN(when.getTime())) throw new Error('bad')
    return { t: when.toISOString(), id } // re-emit a clean value: the database only ever sees ours
  } catch {
    throw bad('invalid_cursor', 'Invalid cursor')
  }
}

/** One refusal as the API shows it. ISO times, as everywhere in the API (a machine must not guess day-month or month-day). */
export const refusalJson = (r) => ({
  id: Number(r.id),
  at: new Date(r.at).toISOString(),
  scan_id: r.scan_id,
  source: r.source,
  code: r.code,
  provider_id: r.provider_id,
  provider_name: r.provider_name,
  point_id: r.point_id,
  point_name: r.point_name,
  client_time: r.client_time === null ? null : new Date(r.client_time).toISOString(),
})

/**
 * The refused visits, newest first, one page at a time: `{ refusals, next_cursor }`, for the committee only (GET
 * /api/admin/scan-refusals; it is not part of the agent API). The filters are `from`, `to`, `point_id`, `provider_id`, `limit`
 * (at most MAX_REFUSAL_PAGE_SIZE) and `cursor`, and fail with the same codes as the scans list (`invalid_filter`,
 * `invalid_cursor`). `from` and `to` are a building day (YYYY-MM-DD, in the building's time zone, both ends included) or a
 * full ISO time that says which zone it means.
 * @param {Record<string, any>} [q]  the query string of the request
 */
export async function listRefusals(q = {}) {
  const where = []
  const params = []
  /** Adds a value to the parameters of the statement and returns its placeholder. */
  const push = (value) => {
    params.push(value)
    return `$${params.length}`
  }

  if (q.from) {
    const b = parseBound('from', q.from)
    // A day is the stretch of time from its midnight to the next one in the building's zone (a day of 23 or 25 hours when the
    // clocks change), so the comparison stays on the index of `at`.
    where.push(b.date ? `at >= (${push(b.date)}::date::timestamp at time zone ${push(TIMEZONE)}::text)` : `at >= ${push(b.time)}::timestamptz`)
  }
  if (q.to) {
    const b = parseBound('to', q.to)
    where.push(b.date ? `at < ((${push(b.date)}::date + 1)::timestamp at time zone ${push(TIMEZONE)}::text)` : `at <= ${push(b.time)}::timestamptz`)
  }
  for (const name of ['point_id', 'provider_id']) {
    if (!q[name]) continue
    if (!isUuid(q[name])) throw bad('invalid_filter', `${name} must be an id`, { field: name })
    where.push(`${name} = ${push(q[name].toLowerCase())}`)
  }

  if (q.cursor) {
    const { t, id } = decodeCursor(q.cursor)
    where.push(`(at, id) < (${push(t)}::timestamptz, ${push(id)}::bigint)`)
  }

  let limit = q.limit === undefined || q.limit === '' ? DEFAULT_PAGE_SIZE : Number(q.limit)
  if (!Number.isInteger(limit) || limit < 1) throw bad('invalid_filter', 'limit must be a positive integer', { field: 'limit' })
  limit = Math.min(limit, MAX_REFUSAL_PAGE_SIZE)

  const { rows } = await query(
    `select * from scan_refusals ${where.length ? 'where ' + where.join(' and ') : ''}
      order by at desc, id desc limit ${limit + 1}`,
    params,
  )
  const page = rows.slice(0, limit)
  return {
    refusals: page.map(refusalJson),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  }
}
