// Reading the audit log (ADR 0007, decision 4): the statement for one page, its filters, its cursor and the shape of an entry.
// Read only: nothing here writes a row (the one writer is server/audit.js). It lives apart from the route so that the committee's
// route (server/routes/audit.js: GET /api/admin/audit) and any other reader use the same query, filters and cursor.
//
// Every filter is optional and is checked like the scans list checks its own (server/scans.js): the same helper for `from`
// and `to` (a building day, or an ISO time with a zone), the same page size, the same 400 codes (`invalid_filter` with
// `field`, `invalid_cursor`). Newest first, `at desc, id desc`, which is the order of the index audit_log_at_idx, and a
// filter on one thing (`entity` with `entity_id`) is what audit_log_entity_idx is for (db/migrations/007). The page is cut
// from the log first and joined with the names (`admins`, and the point, provider, member or key that the entry is about)
// after that, so the joins cost a few rows, not the table.
//
// Two readers use the one statement: the committee's (listAudit, the entry as it was stored) and the committee's agent (listAgentAudit,
// GET /api/agent/v1/audit). The agent's entry is written field by field, and its detail goes through the allow-list of its action
// (AUDIT_DETAIL_ALLOW in server/audit.js) with any text that looks like a secret turned into null: see agentAuditDetail below.
import { query } from './db.js'
import { bad, isUuid } from './http.js'
import { pageLimit, parseBound, providerSnapshotName } from './scans.js'
import { AUDIT_DETAIL_ALLOW } from './audit.js'
import { TIMEZONE, FILTER_TEXT_MAX_LENGTH, MAX_AUDIT_PAGE_SIZE } from './config.js'
import { looksSecret } from '../shared/secretLike.js'

/** @import { AuditEntry, AuditPage } from '../shared/types.js' */

/**
 * The values of `group`: the part of an action before the dot (`point.update` is in `point`). An exact list, so that no
 * text of the request ever reaches the SQL. `session` is the sign-in and sign-out of a committee member.
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
  // e-mail is the fallback of an older row. A system actor (the daily job) has neither.
  //
  // The name of what the entry is about (`entity_name`) is the CURRENT name of that row, found by `entity_id` (text on the log,
  // a uuid in the four tables, so the join compares text; an entity_id that is not an id matches nothing and cannot fail). Only
  // the four kinds that the committee app names are looked up, each join is for its own `entity`, and a thing that is gone, or
  // any other entity, has no name here (the screen then falls back to the names that the details of a delete hold). A provider
  // is named as the committee's history names one (providerSnapshotName), so the company and the contact are read apart.
  // Nothing else of these five tables is read: the name, the company, the contact name and the e-mail of a member.
  const sql = `
    select l.id, l.at, l.at_exact, l.action, l.entity, l.entity_id,
           case l.entity
             when 'point' then ep.name
             when 'provider' then ev.company
             when 'admin' then coalesce(nullif(ea.name, ''), ea.email)
             when 'api_key' then ek.name
           end as entity_name,
           case when l.entity = 'provider' then ev.contact_name end as entity_contact,
           l.actor_type, l.actor_id,
           coalesce(nullif(l.actor_name, ''), case when l.actor_type = 'admin' then coalesce(nullif(a.name, ''), a.email) end) as actor_name,
           (l.actor_type = 'admin' and l.actor_id is not null and a.id is null) as actor_deleted,
           l.detail
      from (select id, at, ${CURSOR_TIME_SQL} as at_exact, action, entity, entity_id, actor_type, actor_id, actor_name, detail
              from audit_log
             ${where.length ? `where ${where.join(' and ')}` : ''}
             order by at desc, id desc
             limit ${limit + 1}) l
      left join admins a on l.actor_type = 'admin' and a.id::text = l.actor_id
      left join points ep on l.entity = 'point' and ep.id::text = l.entity_id
      left join providers ev on l.entity = 'provider' and ev.id::text = l.entity_id
      left join admins ea on l.entity = 'admin' and ea.id::text = l.entity_id
      left join api_keys ek on l.entity = 'api_key' and ek.id::text = l.entity_id
     order by l.at desc, l.id desc`
  return { sql, params, limit }
}

/** The current name of the thing that an entry is about, or null (it is gone, or it is not a thing that has a name here). */
const entityName = (r) => {
  if (r.entity_name === null || r.entity_name === undefined) return null
  return r.entity === 'provider' ? providerSnapshotName({ company: r.entity_name, contact_name: r.entity_contact }) : r.entity_name
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
    entity_name: entityName(r),
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    actor_name: r.actor_name ?? null,
    actor_deleted: r.actor_deleted === true,
    detail: r.detail ?? null, // as stored
  }
}

// ---------- the agent's reading ----------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * A text that may be shown to the agent, or null. A word of it that looks like a key, a hash, a token or an id (shared/secretLike.js)
 * makes the whole text null, so a sentence that holds a pasted key does not get through, and neither does a text that is one. (The
 * test is made word by word because looksSecret judges a whole text, and a key inside a sentence has spaces around it.)
 * @param {unknown} value
 * @returns {string | null}
 */
const safeText = (value) => (typeof value === 'string' && !value.split(/\s+/).some(looksSecret) ? value : null)

/** A moment as an ISO 8601 text in UTC, or null. */
function momentText(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  const when = new Date(value)
  return Number.isNaN(when.getTime()) ? null : when.toISOString()
}

/** A list of ids, in lower case: what is not an id is left out. Null when the value is not a list. */
const idList = (value) => (Array.isArray(value) ? value.filter(isUuid).map((id) => id.toLowerCase()) : null)

/** `{ added, removed }`: two lists of ids. Null when the value is not an object. */
const idsChange = (value) => (isObject(value) ? { added: idList(value.added) ?? [], removed: idList(value.removed) ?? [] } : null)

/** What an update changed: the listed fields, each as `{ from, to }`, each value of its kind. Null when none of them is there. */
function changedFields(fields, value) {
  if (!isObject(value)) return null
  const out = {}
  for (const [field, kind] of Object.entries(fields)) {
    const pair = value[field]
    if (!Object.hasOwn(value, field) || !isObject(pair)) continue
    out[field] = { from: kindValue(kind, pair.from), to: kindValue(kind, pair.to) }
  }
  return Object.keys(out).length ? out : null
}

/**
 * One value of a detail, as its kind says (the kinds are explained in server/audit.js, AUDIT_DETAIL_ALLOW): the value, or null when
 * it is not of that kind or when it is a text that looks like a secret. Nothing that is not rebuilt here goes out.
 * @param {any} kind
 * @param {any} value
 * @returns {unknown}
 */
function kindValue(kind, value) {
  if (value === null || value === undefined) return null
  switch (typeof kind === 'string' ? kind : kind.kind) {
    case 'text': return safeText(value)
    case 'count': return Number.isSafeInteger(value) && value >= 0 ? value : null
    case 'integer': return Number.isSafeInteger(value) ? value : null
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? value : null
    case 'boolean': return typeof value === 'boolean' ? value : null
    case 'timestamp': return momentText(value)
    case 'uuids': return idList(value)
    case 'ids_change': return idsChange(value)
    case 'ids_or_change': return Array.isArray(value) ? idList(value) : idsChange(value)
    case 'enum': return typeof value === 'string' && kind.values.includes(value) ? value : null
    case 'changes': return changedFields(kind.fields, value)
    default: return null
  }
}

/** The kinds that kindValue knows: the allow-list is checked against them when the server starts. */
const KINDS = ['text', 'count', 'integer', 'number', 'boolean', 'timestamp', 'uuids', 'ids_change', 'ids_or_change', 'enum', 'changes']

/** Throws when the keys of one entry of the allow-list name a kind that kindValue does not know (a typo would otherwise show as a null for ever). */
function checkKinds(allow, where) {
  for (const [key, kind] of Object.entries(allow)) {
    const name = typeof kind === 'string' ? kind : kind?.kind
    if (!KINDS.includes(name)) throw new Error(`server/audit.js: ${where}.${key} has the kind "${name}", which server/auditRead.js does not know.`)
    if (name === 'enum' && !(Array.isArray(kind.values) && kind.values.length)) throw new Error(`server/audit.js: ${where}.${key} is an enum with no values.`)
    if (name === 'changes') checkKinds(kind.fields, `${where}.${key}`)
  }
}

/**
 * Throws when the allow-list is not one that agentAuditDetail can read: an action that is not `<group>.<verb>` with a group of
 * AUDIT_GROUPS, or a key of a kind that kindValue does not know. It runs when this file is loaded, so a mistake in the list stops the
 * server from starting, and it is exported so that tests/agent-audit.test.js can prove that it does.
 * @param {Record<string, Record<string, any>>} list
 */
export function checkAuditAllowList(list) {
  for (const [action, allow] of Object.entries(list)) {
    if (!/^[a-z_]+\.[a-z_]+$/.test(action) || !AUDIT_GROUPS.includes(/** @type {any} */ (action.split('.')[0]))) {
      throw new Error(`server/audit.js: the action "${action}" of AUDIT_DETAIL_ALLOW is not "<group>.<verb>" with a group of AUDIT_GROUPS.`)
    }
    checkKinds(allow, action)
  }
}
checkAuditAllowList(AUDIT_DETAIL_ALLOW)

/**
 * The detail of an entry as the agent may read it: only the keys that AUDIT_DETAIL_ALLOW lists for the action, in the order of that
 * list, each rebuilt as its kind says (a text that looks like a secret, or a value of the wrong kind, is null). Null when the
 * action is not in the list (nothing of its detail goes out), when the stored detail is not an object, and when none of the listed
 * keys is in it. The first characters of a key, a token, a hash and any other key that is not listed never get here.
 * @param {string} action
 * @param {unknown} detail  as it was stored
 * @returns {Record<string, unknown> | null}
 */
export function agentAuditDetail(action, detail) {
  const allow = Object.hasOwn(AUDIT_DETAIL_ALLOW, action) ? AUDIT_DETAIL_ALLOW[/** @type {keyof typeof AUDIT_DETAIL_ALLOW} */ (action)] : null
  if (!allow || !isObject(detail)) return null
  const stored = /** @type {Record<string, unknown>} */ (detail)
  const out = {}
  for (const [key, kind] of Object.entries(allow)) {
    if (Object.hasOwn(stored, key)) out[key] = kindValue(kind, stored[key])
  }
  return Object.keys(out).length ? out : null
}

/** The fields of an entry of the agent's audit log, in the order the answer writes them. */
export const AGENT_AUDIT_FIELDS = Object.freeze([
  'id', 'at', 'action', 'entity', 'entity_id', 'entity_name', 'actor_type', 'actor_id', 'actor_name', 'actor_deleted', 'detail',
])

/**
 * One entry as the committee's agent reads it (GET /api/agent/v1/audit): the fields of the committee's entry (auditEntry), written one
 * by one from the row, with the two names filtered like a text of a detail and the detail through the allow-list of its action.
 * @param {Record<string, any>} r  a row of the statement of auditQuery
 */
export function agentAuditEntry(r) {
  return {
    id: Number(r.id),
    at: new Date(r.at).toISOString(),
    action: r.action,
    entity: r.entity ?? null,
    entity_id: r.entity_id ?? null,
    entity_name: safeText(entityName(r)),
    actor_type: r.actor_type,
    actor_id: r.actor_id ?? null,
    actor_name: safeText(r.actor_name ?? null),
    actor_deleted: r.actor_deleted === true,
    detail: agentAuditDetail(r.action, r.detail),
  }
}

/**
 * One page of the log, newest first, with each row turned into an entry by `toEntry`.
 * @param {Record<string, unknown>} q
 * @param {(row: Record<string, any>) => any} toEntry
 */
async function auditPage(q, toEntry) {
  const { sql, params, limit } = auditQuery(q)
  const { rows } = await query(sql, params)
  const page = rows.slice(0, limit)
  return {
    entries: page.map(toEntry),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  }
}

/**
 * One page of the audit log.
 * @param {Record<string, unknown>} [q]
 * @returns {Promise<AuditPage>}
 */
export async function listAudit(q = {}) {
  return auditPage(q, auditEntry)
}

/**
 * One page of the audit log for the agent API (GET /api/agent/v1/audit): the filters, the validation, the order, the paging and the
 * cursor of listAudit (one statement, auditQuery), the entries of agentAuditEntry.
 * @param {Record<string, unknown>} [q]
 */
export async function listAgentAudit(q = {}) {
  return auditPage(q, agentAuditEntry)
}
