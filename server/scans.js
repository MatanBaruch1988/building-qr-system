import { query, tx } from './db.js'
import { formatDateTime, formatDateTimeUtc, formatDay } from '../shared/datetime.js'
import { ApiError, bad, forbidden, notFound, requireUuid, isUuid } from './http.js'
import { evaluateGps, resolveClock } from './scanLogic.js'
import { parseQrToken } from '../shared/qrToken.js'
import {
  SCAN_COOLDOWN_MINUTES,
  TIMEZONE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  FILTER_TEXT_MAX_LENGTH,
} from './config.js'
import { FLAG_DEMO } from '../shared/flags.js'
import {
  OUTCOME_ACCEPTED,
  SCAN_ERROR_INVALID_SCAN_ID,
  SCAN_ERROR_INVALID_CODE,
  SCAN_ERROR_UNKNOWN_CODE,
  SCAN_ERROR_POINT_INACTIVE,
  SCAN_ERROR_NOT_ASSIGNED,
  SCAN_ERROR_SCAN_ID_CONFLICT,
} from '../shared/contract.js'

/** @import { Gps, Scan } from '../shared/types.js' */

const localFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
/** '2026-09-30 08:12:00' in Israel time: handy for humans and agents reading the raw JSON. */
export const toLocal = (d) => (d ? localFmt.format(new Date(d)).replace('T', ' ') : null)

/**
 * One consistent JSON shape for a scan, used by every endpoint.
 * @param {Record<string, any>} r  a row of the `scans` table
 * @returns {Scan}
 */
export function scanJson(r) {
  return {
    id: r.id,
    checked_in_at: new Date(r.checked_in_at).toISOString(),
    checked_in_local: toLocal(r.checked_in_at),
    local_date: r.local_date,
    point_id: r.point_id,
    point_name: r.point_name,
    provider_id: r.provider_id,
    provider_name: r.provider_name,
    service_type: r.service_type,
    source: r.source,
    outcome: r.outcome,
    distance_m: r.distance_m,
    gps_accuracy_m: r.gps_accuracy_m,
    flags: r.flags,
    voided: r.voided_at !== null && r.voided_at !== undefined,
    void_reason: r.void_reason ?? null,
  }
}

// Only real numbers count. (Number(null), Number('') and Number([]) are all 0: a phone sending an
// empty form would otherwise be judged as standing at latitude 0, longitude 0.)
const realNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

/**
 * The position of a request as the server uses it, or null when there is no usable `lat` and `lng` in it.
 * @param {any} gps  whatever the client sent: it is JSON that nobody has checked yet
 * @returns {Gps | null}
 */
export function normalizeGps(gps) {
  if (!gps || typeof gps !== 'object' || Array.isArray(gps)) return null
  const lat = realNumber(gps.lat)
  const lng = realNumber(gps.lng)
  if (lat === null || lng === null) return null
  const accuracy = realNumber(gps.accuracy)
  // How old the reading was when the phone took it (a remembered position). Optional, clamped, never trusted blindly.
  const age = realNumber(gps.age_s)
  // Clamp: gps_accuracy_m is a 32-bit integer column.
  return {
    lat,
    lng,
    accuracy: accuracy === null ? null : Math.min(Math.max(accuracy, 0), 1_000_000),
    age_s: age === null ? null : Math.min(Math.max(Math.round(age), 0), 86_400),
  }
}

/**
 * The name of a provider as a record keeps it (scans.provider_name, scan_refusals.provider_name): a snapshot made when the
 * record is written, so that it stays readable after the provider is renamed or deleted. "Company – contact" (an en dash),
 * or just the company when there is no contact name.
 * @param {{ company: string, contact_name?: string | null }} provider
 */
export const providerSnapshotName = (provider) =>
  provider.contact_name ? `${provider.company} – ${provider.contact_name}` : provider.company

/**
 * Attaches to a refusal the point that the code named, for the record that server/scanRefusals.js keeps of it. It is a
 * property that cannot be enumerated, so it is never serialized: not by JSON.stringify, not by a spread, not by a log of the
 * error. The answer that a client gets is built from `code`, `message` and `extra` only (server/router.js, the sync handler
 * in server/routes/provider.js), so nothing about the refusal's record reaches a phone.
 */
function attachRefusedPoint(err, point) {
  if (point && err && typeof err === 'object') {
    Object.defineProperty(err, 'refusal', { value: point, enumerable: false, configurable: true, writable: true })
  }
  return err
}

/**
 * Records one scan on behalf of an authenticated provider.
 * Safe to call again with the same `input.id` (offline retries): the stored row is returned.
 * Returns { scan, duplicate }, where `duplicate` means an equal visit was already recorded within the cooldown.
 * Every refusal is an ApiError whose code is one of the SCAN_ERROR_* constants of shared/contract.js: as the item of a
 * sync batch it reaches the phone, which decides from the code what to do with the queued scan. A new refusal is a new
 * constant there, and tests/contract.test.js fails until the phone classifies it. An error thrown after the point was found
 * carries `refusal` ({ pointId, pointName }, not enumerable): the callers record the refused visit with it
 * (server/scanRefusals.js).
 */
export async function recordScan({ provider, deviceId, input, source, now = new Date() }) {
  const id = requireUuid(input?.id, SCAN_ERROR_INVALID_SCAN_ID)
  const token = parseQrToken(input?.code)
  if (!token) throw bad(SCAN_ERROR_INVALID_CODE, 'This is not a QR code of this system')
  const gps = normalizeGps(input.gps)

  // Same id seen before (a retry): return the stored row. Someone else's id is a conflict.
  const replay = (row) => {
    if (row.provider_id !== provider.id) throw new ApiError(409, SCAN_ERROR_SCAN_ID_CONFLICT, 'Scan id already used')
    return { scan: scanJson(row), duplicate: false, replay: true }
  }

  let named = null // the point that the code named, once it is known: only for the record of a refusal
  return tx(async (c) => {
    const existing = await c.query('select * from scans where id = $1', [id])
    if (existing.rows.length) return replay(existing.rows[0])

    const found = await c.query('select * from points where qr_token = $1', [token])
    if (!found.rows.length) throw notFound(SCAN_ERROR_UNKNOWN_CODE, 'QR code not found in the system')
    const point = found.rows[0]
    named = { pointId: point.id, pointName: point.name }
    if (!point.is_active) throw new ApiError(409, SCAN_ERROR_POINT_INACTIVE, 'This point is not active')

    // The demo account may scan every point (it exists to try the whole system, and its scans are tagged 'demo'
    // and kept out of reports). Everyone else only where the committee assigned them (no assignment = anyone).
    if (!provider.is_demo) {
      const assigned = await c.query('select provider_id from point_providers where point_id = $1', [point.id])
      if (assigned.rows.length && !assigned.rows.some((r) => r.provider_id === provider.id)) {
        throw forbidden(SCAN_ERROR_NOT_ASSIGNED, 'This point is not assigned to this provider')
      }
    }

    // Serialise concurrent scans of the same provider at the same point (double taps, two phones).
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [provider.id + point.id])

    const clock = resolveClock({ source, clientTime: input.clientTime, now })

    const near = await c.query(
      `select * from scans
        where provider_id = $1 and point_id = $2 and outcome = 'accepted' and voided_at is null
          and checked_in_at between $3::timestamptz - ($4 || ' minutes')::interval
                                and $3::timestamptz + ($4 || ' minutes')::interval
        order by checked_in_at desc limit 1`,
      [provider.id, point.id, clock.checkedInAt, String(SCAN_COOLDOWN_MINUTES)],
    )
    if (near.rows.length) return { scan: scanJson(near.rows[0]), duplicate: true }

    const geo = evaluateGps({ mode: point.gps_mode, point, gps })
    const flags = [...geo.flags, ...clock.flags, ...(provider.is_demo ? [FLAG_DEMO] : [])]

    const inserted = await c.query(
      `insert into scans
         (id, point_id, provider_id, point_name, provider_name, service_type,
          checked_in_at, client_time, local_date, source, outcome,
          distance_m, gps_accuracy_m, device_id, flags)
       values ($1,$2,$3,$4,$5,$6,$7,$8,(($7::timestamptz) at time zone $9)::date,$10,$11,$12,$13,$14,$15)
       on conflict (id) do nothing
       returning *`,
      [
        id,
        point.id,
        provider.id,
        point.name,
        providerSnapshotName(provider),
        point.service_type ?? provider.service_type ?? null,
        clock.checkedInAt,
        clock.clientTime,
        TIMEZONE,
        source,
        geo.outcome,
        geo.distance_m,
        geo.gps_accuracy_m,
        deviceId ?? null,
        flags,
      ],
    )
    if (!inserted.rows.length) {
      // A parallel request with the same id won the race: answer exactly as a later retry would.
      const winner = await c.query('select * from scans where id = $1', [id])
      return replay(winner.rows[0])
    }
    return { scan: scanJson(inserted.rows[0]), duplicate: false }
  }).catch((err) => {
    throw attachRefusedPoint(err, named)
  })
}

// ---------- reading ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ t: new Date(row.checked_in_at).toISOString(), id: row.id })).toString('base64url')

function decodeCursor(cursor) {
  try {
    const { t, id } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    if (typeof t !== 'string' || !isUuid(id)) throw new Error('bad')
    const when = new Date(t)
    if (Number.isNaN(when.getTime())) throw new Error('bad')
    return { t: when.toISOString(), id: id.toLowerCase() } // re-emit a clean value: the database only ever sees ours
  } catch {
    throw bad('invalid_cursor', 'Invalid cursor')
  }
}

// A real calendar day (2026-02-30 is not one) / a full ISO time that says which time zone it means.
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/
export function parseBound(name, value) {
  if (DATE_RE.test(value)) {
    const d = new Date(`${value}T00:00:00Z`)
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value) return { date: value }
  } else if (ISO_TIME_RE.test(value)) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100) return { time: d.toISOString() }
  }
  throw bad('invalid_filter', `${name} must be a real date YYYY-MM-DD, or an ISO date-time with Z or an offset`, { field: name })
}

/**
 * Every query parameter that listScans reads: the one list of the filters of GET /api/agent/v1/scans (which also reads
 * `format`, in server/routes/agent.js). tests/agent-docs.test.js proves that listScans reads exactly these (a read of
 * another name, or a name here that is not read, fails) and that server/schemaDoc.js and docs/agent-api.md name
 * exactly these. A new filter goes here, in listScans, and in both documents.
 */
export const SCAN_FILTERS = Object.freeze([
  'from', 'to', 'point_id', 'provider_id', 'service_type', 'flag', 'outcome',
  'include_voided', 'include_demo', 'order', 'limit', 'cursor',
])

/**
 * Shared by the admin history screen and the agent API.
 * Filters: see SCAN_FILTERS. from/to are YYYY-MM-DD (Israel calendar day) or a full ISO time, outcome is
 * accepted | rejected | all.
 */
export async function listScans(q = {}) {
  const where = []
  const params = []
  const add = (sql, value) => {
    params.push(value)
    where.push(sql.replace('?', `$${params.length}`))
  }

  const bound = (name, value, op) => {
    if (!value) return
    const b = parseBound(name, value)
    if (b.date) add(`local_date ${op} ?::date`, b.date)
    else add(`checked_in_at ${op} ?::timestamptz`, b.time)
  }
  bound('from', q.from, '>=')
  bound('to', q.to, '<=')

  for (const [name, col] of [
    ['point_id', 'point_id'],
    ['provider_id', 'provider_id'],
  ]) {
    if (q[name]) {
      if (!isUuid(q[name])) throw bad('invalid_filter', `${name} must be an id`, { field: name })
      add(`${col} = ?`, q[name].toLowerCase())
    }
  }
  if (q.service_type) add('service_type = ?', String(q.service_type).slice(0, FILTER_TEXT_MAX_LENGTH))
  if (q.flag) add('? = any(flags)', String(q.flag).slice(0, FILTER_TEXT_MAX_LENGTH))

  const outcome = q.outcome || OUTCOME_ACCEPTED
  if (outcome === OUTCOME_ACCEPTED) where.push(`outcome = 'accepted'`)
  else if (outcome === 'rejected') where.push(`outcome <> 'accepted'`)
  else if (outcome !== 'all') throw bad('invalid_filter', 'outcome must be accepted, rejected or all', { field: 'outcome' })

  const truthy = (v) => v === true || v === 'true' || v === '1'
  if (!truthy(q.include_voided)) where.push('voided_at is null')
  // Demo-account scans are test data: hidden unless asked for.
  if (!truthy(q.include_demo)) add('not (? = any(flags))', FLAG_DEMO)

  const order = q.order === 'asc' ? 'asc' : 'desc'
  if (q.order && !['asc', 'desc'].includes(q.order)) throw bad('invalid_filter', 'order must be asc or desc', { field: 'order' })

  if (q.cursor) {
    const { t, id } = decodeCursor(q.cursor)
    params.push(t, id)
    where.push(`(checked_in_at, id) ${order === 'asc' ? '>' : '<'} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`)
  }

  let limit = q.limit === undefined || q.limit === '' ? DEFAULT_PAGE_SIZE : Number(q.limit)
  if (!Number.isInteger(limit) || limit < 1) throw bad('invalid_filter', 'limit must be a positive integer', { field: 'limit' })
  limit = Math.min(limit, MAX_PAGE_SIZE)

  const sql = `select * from scans ${where.length ? 'where ' + where.join(' and ') : ''}
                order by checked_in_at ${order}, id ${order} limit ${limit + 1}`
  const { rows } = await query(sql, params)
  const page = rows.slice(0, limit)
  return {
    scans: page.map(scanJson),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  }
}

/** Every page of a filtered listing (for the committee's CSV export). Stops at maxRows and says so. */
export async function listAllScans(q = {}, { maxRows = 100_000 } = {}) {
  const scans = []
  let cursor
  do {
    const page = await listScans({ ...q, limit: MAX_PAGE_SIZE, cursor })
    scans.push(...page.scans)
    cursor = page.next_cursor
  } while (cursor && scans.length < maxRows)
  return { scans, truncated: Boolean(cursor) }
}

export const SCAN_CSV_COLUMNS = [
  'id', 'checked_in_at', 'checked_in_local', 'local_date', 'point_id', 'point_name',
  'provider_id', 'provider_name', 'service_type', 'source', 'outcome',
  'distance_m', 'gps_accuracy_m', 'flags', 'voided', 'void_reason',
]

// The committee's file is read by people (in Excel): dates are DD/MM/YYYY and times HH:MM. checked_in_local is the
// building's time and checked_in_utc is the same moment in UTC: it is what tells apart the two 01:30 of the night the
// clocks go back, so the file never loses a moment. The agent's CSV keeps SCAN_CSV_COLUMNS as they are: a machine reads
// ISO dates and must not have to guess day-month or month-day.
export const COMMITTEE_CSV_COLUMNS = SCAN_CSV_COLUMNS.map((column) => (column === 'checked_in_at' ? 'checked_in_utc' : column))
export const committeeCsvRow = (scan) => ({
  ...scan,
  checked_in_utc: formatDateTimeUtc(scan.checked_in_at),
  checked_in_local: formatDateTime(scan.checked_in_at),
  local_date: formatDay(scan.local_date),
})
