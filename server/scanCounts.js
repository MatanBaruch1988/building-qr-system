// Counting the visits for the committee's analyst, the agent (GET /api/agent/v1/counts; owner decision of 08/10/2026, AGENTS.md "Safety").
// The app records facts and does not analyse: a count of those facts (how many visits per day, provider, point or service) is a fact
// too, and what it means is the agent's to say. The reason it is here and not left to the agent is that an agent that counts rows
// itself reads them a page of 500 at a time (a year of visits is dozens of requests of a key that may make 60 a minute), and a
// language model that adds up thousands of rows makes mistakes that a database does not.
//
// The rule that holds the endpoint together: the counts add up to the visits that GET /api/agent/v1/scans lists for the same filters.
// So the filters are not copied: scanWhere (server/scans.js) is the one function that turns the filters of the scans list into a
// WHERE clause, and this module calls it with the query as it is, so what a `from`, a `to`, a `point_id`, an `outcome`, `include_voided`
// and the rest mean cannot differ between the list and the counts, nor can the defaults (accepted visits only, voided and demo hidden)
// or the errors (400 invalid_filter with the field). `from` and `to` are required here and bounded (COUNTS_MAX_DAYS), and the answer
// is bounded (COUNTS_MAX_ROWS): a count is never silently cut, it is refused with the words that say what to narrow.
//
// One statement, read only. It groups the visits by the dimensions that were asked for, in a fixed order (day, provider, point,
// service_type), whatever the order of the request. The columns it reads are the ones the scans list shows (`local_date`, `provider_id`,
// `point_id`, `service_type` and the two names); a column added to `scans` later does not reach the answer, which is built field by field.
// The index it uses depends on the range: `scans_local_date_idx` for a `from` and `to` that are days, `scans_checked_in_idx` for moments.
import { query } from './db.js'
import { bad } from './http.js'
import { parseBound, scanWhere, SCAN_WHERE_FILTERS } from './scans.js'
import { COUNTS_MAX_DAYS, COUNTS_MAX_ROWS } from './config.js'

/**
 * The values of `group_by`, in the order in which the answer writes its rows (the order of the request does not matter). An exact
 * list, so that no text of the request ever reaches the SQL.
 */
export const COUNT_GROUPS = Object.freeze(['day', 'provider', 'point', 'service_type'])

/**
 * Every query parameter that the counts read: the filters of the scans list (the very list that scanWhere reads) and `group_by`.
 * tests/agent-docs.test.js proves that listAgentCounts reads exactly these.
 */
export const COUNT_FILTERS = Object.freeze([...SCAN_WHERE_FILTERS, 'group_by'])

/** The fields of a row of the answer, in order. A dimension that the request did not group by is null. `count` is last. */
export const COUNT_FIELDS = Object.freeze(['day', 'provider_id', 'provider_name', 'point_id', 'point_name', 'service_type', 'count'])

/**
 * The dimensions of `group_by` as a list in the fixed order, or a 400 `invalid_filter` (field `group_by`). A comma list: no
 * empty item, no value that is not in COUNT_GROUPS, no repeat. Empty or absent is no grouping (one row, the total).
 * @param {unknown} value  the `group_by` of the query: text, or missing
 * @returns {string[]}
 */
export function parseGroupBy(value) {
  if (value === undefined || value === null || value === '') return []
  const asked = String(value).split(',')
  const refuse = (why) => bad('invalid_filter', `group_by must be a comma list of ${COUNT_GROUPS.join(', ')}, each at most once: ${why}`, { field: 'group_by' })
  for (const item of asked) {
    if (!COUNT_GROUPS.includes(item)) throw refuse(item === '' ? 'there is an empty item' : `"${item.slice(0, 20)}" is not one of them`)
  }
  if (new Set(asked).size !== asked.length) throw refuse('one of them is repeated')
  return COUNT_GROUPS.filter((group) => asked.includes(group))
}

const DAY_MS = 86_400_000

/**
 * Checks that `from` and `to` are there and are at most COUNTS_MAX_DAYS days apart, or throws a 400 `invalid_filter` that names the
 * field. A calendar day counts as the whole day (so 2026-01-01 to 2026-12-31 is 365 days), a moment as the moment. The range may be
 * empty (a `to` before the `from` matches no visit, as in the scans list); it is only too long that is refused.
 * @param {Record<string, any>} q
 */
function checkRange(q) {
  if (!q.from) throw bad('invalid_filter', 'from is required: the counts are of a range of at most ' + COUNTS_MAX_DAYS + ' days', { field: 'from' })
  if (!q.to) throw bad('invalid_filter', 'to is required: the counts are of a range of at most ' + COUNTS_MAX_DAYS + ' days', { field: 'to' })
  const from = parseBound('from', String(q.from))
  const to = parseBound('to', String(q.to))
  const start = from.date ? Date.parse(`${from.date}T00:00:00Z`) : Date.parse(from.time)
  const end = to.date ? Date.parse(`${to.date}T00:00:00Z`) + DAY_MS : Date.parse(to.time)
  if (end - start > COUNTS_MAX_DAYS * DAY_MS) {
    throw bad('invalid_filter', `to must be at most ${COUNTS_MAX_DAYS} days after from: ask for a shorter range, or for several`, { field: 'to' })
  }
}

/**
 * The statement for the counts, and what it needs: `{ sql, params, groupBy }`. Everything in the SQL text is fixed here (the
 * dimensions come from COUNT_GROUPS, the numbers from the constants); the request's values are only parameters. A bad filter, or
 * a `from` or `to` that is missing or too far apart, is a 400 here, before any statement is run. Exported so that a test can ask
 * the database how it runs this text.
 *
 * It reads the visits that the filters select (scanWhere) once, counts them by the dimensions that were asked for, and only then looks
 * up the names, for the few groups that came out and not for every visit:
 *  - `day` is the visit's `local_date`, the day in the building's time zone that was written when the visit was recorded;
 *  - `provider` and `point` group by the id, and carry the name that the NEWEST visit of that provider (or point) among the selected
 *    ones carries, so that a provider that was renamed inside the range is one row with one name and not two rows (two names on
 *    visits at the very same moment: the one that sorts last);
 *  - `service_type` is the visit's own, the one the scans list shows and filters by (null when the visit has none).
 * The rows come out ordered by the dimensions in the order day, provider (by name, then id), point (by name, then id), service_type.
 * One row more than the limit is asked for, to know whether the answer is too long.
 * @param {Record<string, any>} [q]  the query of the request: every value is text, or missing
 */
export function countsQuery(q = {}) {
  const groupBy = parseGroupBy(q.group_by)
  const { where, params } = scanWhere(q)
  checkRange(q)
  const has = (name) => groupBy.includes(name)

  // The columns of the selected visits that make a group, in the order of the answer.
  const keys = [
    ...(has('day') ? ['local_date'] : []),
    ...(has('provider') ? ['provider_id'] : []),
    ...(has('point') ? ['point_id'] : []),
    ...(has('service_type') ? ['service_type'] : []),
  ]
  const ctes = [
    `s as (
      select checked_in_at, local_date, provider_id, provider_name, point_id, point_name, service_type
        from scans where ${where.join(' and ')}
    )`,
    `g as (
      select ${[...keys, 'count(*)::int as count'].join(', ')} from s${keys.length ? ` group by ${keys.join(', ')}` : ''}
    )`,
  ]

  const columns = [has('day') ? 'g.local_date as day' : 'null::date as day'] // the select list, in the order of COUNT_FIELDS
  const joins = []
  const order = has('day') ? ['g.local_date'] : []
  for (const [dimension, idColumn, nameColumn] of [['provider', 'provider_id', 'provider_name'], ['point', 'point_id', 'point_name']]) {
    if (has(dimension)) {
      const lookup = `${dimension}_names`
      // Few rows come out of the inner select (one for each name that an id was recorded with), and the newest of them is picked.
      ctes.push(`${lookup} as (
      select distinct on (${idColumn}) ${idColumn}, ${nameColumn}
        from (select ${idColumn}, ${nameColumn}, max(checked_in_at) as last_at from s group by ${idColumn}, ${nameColumn}) names
       order by ${idColumn}, last_at desc, ${nameColumn} desc
    )`)
      joins.push(`join ${lookup} on ${lookup}.${idColumn} = g.${idColumn}`)
      columns.push(`g.${idColumn}`, `${lookup}.${nameColumn}`)
      order.push(`${lookup}.${nameColumn}`, `g.${idColumn}`)
    } else columns.push(`null::uuid as ${idColumn}`, `null::text as ${nameColumn}`)
  }
  if (has('service_type')) {
    columns.push('g.service_type')
    order.push('g.service_type')
  } else columns.push('null::text as service_type')
  columns.push('g.count')

  const sql = `
    with ${ctes.join(',\n    ')}
    select ${columns.join(', ')}
      from g ${joins.join(' ')}
      ${order.length ? `order by ${order.join(', ')}` : ''}
     limit ${COUNTS_MAX_ROWS + 1}`
  return { sql, params, groupBy }
}

/**
 * One row of the answer, written field by field from the row of the statement (never the whole row).
 * @param {Record<string, any>} r
 */
export function agentCountJson(r) {
  return {
    day: r.day ?? null,
    provider_id: r.provider_id ?? null,
    provider_name: r.provider_name ?? null,
    point_id: r.point_id ?? null,
    point_name: r.point_name ?? null,
    service_type: r.service_type ?? null,
    count: r.count,
  }
}

/**
 * The counts for the agent API: `{ group_by, counts, total }`. `group_by` is the grouping in the fixed order (empty for the total),
 * `counts` the rows, `total` their sum, which is the number of visits that the scans list returns for the same filters.
 * @param {Record<string, any>} [q]
 */
export async function listAgentCounts(q = {}) {
  const { sql, params, groupBy } = countsQuery(q)
  const { rows } = await query(sql, params)
  if (rows.length > COUNTS_MAX_ROWS) {
    throw bad('invalid_filter', `The answer would have more than ${COUNTS_MAX_ROWS} rows: ask for a shorter range, or group by fewer things`, { field: 'group_by' })
  }
  const counts = rows.map(agentCountJson)
  return { group_by: groupBy, counts, total: counts.reduce((sum, row) => sum + row.count, 0) }
}
