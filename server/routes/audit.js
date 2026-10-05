// The committee reads the audit log: GET /api/admin/audit (ADR 0007, decision 4). Read only: nothing here writes a row.
//
// The router guards it before this handler runs (server/access.js: every /admin/ route is the committee's), so no one
// without a committee session reaches the query. The agent API has no route to it, on purpose (docs/privacy.md).
//
// Every filter is optional and is checked like the scans list checks its own (server/scans.js): the same helper for `from`
// and `to` (a building day, or an ISO time with a zone), the same page size, the same 400 codes (`invalid_filter` with
// `field`, `invalid_cursor`). Newest first, `at desc, id desc`, which is the order of the index audit_log_at_idx, and a
// filter on one thing (`entity` with `entity_id`) is what audit_log_entity_idx is for (db/migrations/007). The page is cut
// from the log first and joined with `admins` after that, so the join costs a few rows, not the table.
import { route } from '../router.js'
import { query } from '../db.js'
import { bad, isUuid } from '../http.js'
import { pageLimit, parseBound } from '../scans.js'
import { TIMEZONE, FILTER_TEXT_MAX_LENGTH, MAX_AUDIT_PAGE_SIZE } from '../config.js'

/** @import { AuditEntry, AuditPage } from '../../shared/types.js' */

/**
 * The values of `group`: the part of an action before the dot (`point.update` is in `point`). An exact list, so that no
 * text of the request ever reaches the SQL. `session` is reserved for the sign-in rows that a later change writes, so
 * today it answers an empty page.
 */
export const AUDIT_GROUPS = Object.freeze(['admin', 'building', 'point', 'provider', 'scan', 'api_key', 'retention', 'session'])

/**
 * Every query parameter that the audit read uses, in one list (the same idea as SCAN_FILTERS in server/scans.js).
 * tests/audit-read.test.js proves that auditQuery reads exactly these.
 */
export const AUDIT_FILTERS = Object.freeze(['from', 'to', 'group', 'actor_id', 'entity', 'entity_id', 'limit', 'cursor'])

// The cursor is the `(at, id)` of the last row of a page, in the format of the scans list (base64url of `{ t, id }`). `t`
// keeps all six decimals of the time that the database stores (a JavaScript Date holds only three, and a cursor that
// rounded the time down would skip rows that share the same millisecond), so it is written by the database itself.
const CURSOR_TIME_SQL = `to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const CURSOR_ID_RE = /^[1-9]\d{0,17}$/ // audit_log.id is a bigint

const encodeCursor = (row) => Buffer.from(JSON.stringify({ t: row.at_exact, id: String(row.id) })).toString('base64url')

function decodeCursor(cursor) {
  try {
    const { t, id } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'))
    if (typeof t !== 'string' || !CURSOR_TIME_RE.test(t) || typeof id !== 'string' || !CURSOR_ID_RE.test(id)) throw new Error('bad')
    // A real moment (2026-02-30 is not one), in the years the database can hold and this app has ever seen.
    const when = new Date(`${t.slice(0, 23)}Z`)
    const year = when.getUTCFullYear()
    if (Number.isNaN(when.getTime()) || when.toISOString().slice(0, 19) !== t.slice(0, 19) || year < 2000 || year > 2100) throw new Error('bad')
    return { t, id } // both match a strict shape: the database only ever sees a value of ours
  } catch {
    throw bad('invalid_cursor', 'Invalid cursor')
  }
}

/**
 * The statement for one page of the log, and what it needs: `{ sql, params, limit }`. It reads one more row than the page
 * holds, to know whether there is a next page. Exported so that a test can ask the database how it runs exactly this text.
 * @param {Record<string, unknown>} [q]  the query of the request: every value is text, or missing
 */
export function auditQuery(q = {}) {
  const where = []
  const params = []
  const push = (value) => params.push(value) // the number of the parameter that holds it
  const add = (sql, value) => where.push(sql.replace('?', `$${push(value)}`))

  // A building day is read in the building's time zone, as the scans list reads it: `from` is the first moment of that
  // day and `to` is up to the last moment of it (before the first moment of the next day), so a daylight-saving day of 23
  // or 25 hours is whole. The borders are moments, not a calculation on the column, so the index on `at` is used.
  let zone
  const timeZone = () => (zone ??= `$${push(TIMEZONE)}::text`)
  const from = q.from ? parseBound('from', String(q.from)) : null
  if (from?.date) {
    const day = push(from.date)
    where.push(`at >= ($${day}::date)::timestamp at time zone ${timeZone()}`)
  } else if (from) add('at >= ?::timestamptz', from.time)
  const to = q.to ? parseBound('to', String(q.to)) : null
  if (to?.date) {
    const day = push(to.date)
    where.push(`at < (($${day}::date + 1)::timestamp at time zone ${timeZone()})`)
  } else if (to) add('at <= ?::timestamptz', to.time)

  if (q.group) {
    if (!AUDIT_GROUPS.includes(/** @type {any} */ (q.group))) {
      throw bad('invalid_filter', `group must be one of ${AUDIT_GROUPS.join(', ')}`, { field: 'group' })
    }
    // starts_with, not like: `_` in `api_key` is a wildcard of like.
    add('starts_with(action, ?)', `${q.group}.`)
  }
  if (q.actor_id) {
    if (!isUuid(q.actor_id)) throw bad('invalid_filter', 'actor_id must be an id', { field: 'actor_id' })
    add('actor_id = ?', String(q.actor_id).toLowerCase())
  }
  if (q.entity) add('entity = ?', String(q.entity).slice(0, FILTER_TEXT_MAX_LENGTH))
  if (q.entity_id) add('entity_id = ?', String(q.entity_id).slice(0, FILTER_TEXT_MAX_LENGTH))

  if (q.cursor) {
    const { t, id } = decodeCursor(q.cursor)
    const at = push(t)
    where.push(`(at, id) < ($${at}::timestamptz, $${push(id)}::bigint)`)
  }

  const limit = pageLimit(q.limit, MAX_AUDIT_PAGE_SIZE)

  // The `admins` row is only for the name of a member who was on the committee when the row was written. The snapshot of
  // the name on the row wins (it is what the member was called then, and it outlives the member); the current name or
  // e-mail is the fallback of an older row. A system actor (the daily job) has neither. Nothing else of `admins` is read.
  const sql = `
    select l.id, l.at, l.at_exact, l.action, l.entity, l.entity_id, l.actor_type, l.actor_id,
           coalesce(nullif(l.actor_name, ''), case when l.actor_type = 'admin' then coalesce(nullif(a.name, ''), a.email) end) as actor_name,
           (l.actor_type = 'admin' and l.actor_id is not null and a.id is null) as actor_deleted,
           l.detail
      from (select id, at, ${CURSOR_TIME_SQL} as at_exact, action, entity, entity_id, actor_type, actor_id, actor_name, detail
              from audit_log
             ${where.length ? `where ${where.join(' and ')}` : ''}
             order by at desc, id desc
             limit ${limit + 1}) l
      left join admins a on l.actor_type = 'admin' and a.id::text = l.actor_id
     order by l.at desc, l.id desc`
  return { sql, params, limit }
}

/**
 * One entry as the API shows it. Written field by field: a column that is added to the table later is not shown until it
 * is added here, after someone has decided that the committee may read it.
 * @param {Record<string, any>} r  a row of the statement of auditQuery
 * @returns {AuditEntry}
 */
function auditEntry(r) {
  return {
    id: Number(r.id), // a bigint column, as the id of a refused visit is (the cursor keeps the exact text)
    at: new Date(r.at).toISOString(),
    action: r.action,
    entity: r.entity,
    entity_id: r.entity_id,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    actor_name: r.actor_name ?? null,
    actor_deleted: r.actor_deleted === true,
    detail: r.detail ?? null, // as stored
  }
}

/**
 * One page of the audit log.
 * @param {Record<string, unknown>} [q]
 * @returns {Promise<AuditPage>}
 */
export async function listAudit(q = {}) {
  const { sql, params, limit } = auditQuery(q)
  const { rows } = await query(sql, params)
  const page = rows.slice(0, limit)
  return {
    entries: page.map(auditEntry),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  }
}

route('GET', '/admin/audit', ({ query: q }) => listAudit(q))
