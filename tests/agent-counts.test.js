// GET /api/agent/v1/counts: how many visits there are per day, provider, point or service, for the committee's analyst, the agent (owner
// decision of 08/10/2026, AGENTS.md "Safety"). The app records facts and does not analyse: a count of those facts is a fact too, and
// what it means is the agent's. The rule that holds the endpoint together is that THE COUNTS ADD UP TO THE SCANS LIST: for the same
// filters, the sum of the counts is the number of rows that GET /scans returns when it is paged to the end, and each group is the
// number of those rows that fall in it. This file proves that, and what the endpoint adds to it.
// What this file proves:
//   1. the route needs an agent key (the key is judged before the rest of the request), reads nothing else as a credential, and
//      writes nothing (the bookkeeping of the key apart);
//   2. the answer is { group_by, counts, total } with the seven fields of a row in their order, a dimension that was not grouped by is
//      null, the grouping is written in the fixed order whatever the order of the request, and the rows are ordered by it;
//   3. for a matrix of filters (the defaults, outcome=all and rejected, voided and demo shown, a provider, a point, a service, a flag,
//      a day range, a range of moments, an empty range, a deleted point, an early range in which a name has not changed yet) and of
//      groupings (none, each one alone, pairs, three, all four, in the request's reverse order) the sum of the counts is the number of
//      scans of GET /scans, every group is exactly the scans of that day, provider, point and service, and no group is missing or extra;
//   4. the name of a provider or a point is the name on its newest counted visit, one name for all its rows, also for a provider that
//      was renamed inside the range and a point that was deleted;
//   5. the day is the day in the building's time zone: a visit at 23:30 and one at 00:30 local time are on different days, in summer
//      time, in winter time and on the two days of the year that are 23 and 25 hours long, recorded through the real recording code;
//   6. the validation: from and to are required (the error names the missing one), at most COUNTS_MAX_DAYS days apart (the edge, for days
//      and for moments), group_by is a comma list of the four values, each once (anything else is refused and names group_by), every
//      other filter is refused exactly as GET /scans refuses it, and the order, limit, cursor and format of the scans list are not read;
//   7. the row cap: an answer of COUNTS_MAX_ROWS rows is given and one of one row more is refused (and names group_by), never cut;
//   8. the statement can use the date index and the moment index (asked of the database with explain), is built from scanWhere (the very
//      conditions of the scans list) and reads named columns, never `*`;
//   9. nothing secret is in the raw text of any answer (no QR code, legacy id, password, hash, key, phone, address), and a column that
//      is added to `scans` later does not reach the answer.
// The data is fake.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie, mintAgentKey, revokeAgentKey } from './helpers.js'
import { tx } from '../server/db.js'
import { sha256 } from '../server/crypto.js'
import { recordScan, scanWhere, SCAN_WHERE_FILTERS } from '../server/scans.js'
import { COUNT_FILTERS, COUNT_FIELDS, COUNT_GROUPS, countsQuery, parseGroupBy } from '../server/scanCounts.js'
import { AGENT_KEY_MAX_PER_MINUTE, API_KEY_PREFIX, COUNTS_MAX_DAYS, COUNTS_MAX_ROWS } from '../server/config.js'
import { SOURCE_OFFLINE_SYNC, QR_TOKEN_PREFIX } from '../shared/contract.js'

const DASH = '–' // the separator of "company - contact" in the name of a provider that a scan keeps
const ROW_KEYS = ['day', 'provider_id', 'provider_name', 'point_id', 'point_name', 'service_type', 'count']
const DAY = /^\d{4}-\d{2}-\d{2}$/
const IP = '10.44.55.66'
const LABEL = 'Mozilla/5.0 (Fake; Phone-Marker-6612) FakeBrowser/1.0'

/**
 * A world of its own: a throwaway schema, a committee member, and a way to call the agent API with a key that is replaced before it
 * reaches the limit of requests per minute (AGENT_KEY_MAX_PER_MINUTE), as tests/agent-docs.test.js does. Every describe below has one,
 * one after the other (the pool of the server is a single global).
 */
function useWorld() {
  const w = { keyUses: 0, key: null }
  const KEY_USES = Math.floor((AGENT_KEY_MAX_PER_MINUTE * 2) / 3)
  w.currentKey = async () => {
    if (!w.key || w.keyUses >= KEY_USES) {
      w.key = (await mintAgentKey(w.cookie, 'agent counts')).key
      w.keyUses = 0
    }
    w.keyUses += 1
    return w.key
  }
  w.agent = async (path, opts = {}) => call('GET', `/api/agent/v1${path}`, { token: await w.currentKey(), ...opts })
  w.counts = (qs = '') => w.agent(`/counts${qs ? '?' + qs : ''}`)
  w.post = async (path, body) => {
    const r = await call('POST', path, { cookie: w.cookie, body })
    if (r.status !== 200 && r.status !== 201) throw new Error(`seed ${path}: ${r.status} ${r.text}`)
    return r.json
  }
  w.makeProvider = async (extra) => (await w.post('/api/admin/providers', { password: 'pw-fake-secret-4821', ...extra })).provider
  w.makePoint = async (extra) => (await w.post('/api/admin/points', { gps_mode: 'none', ...extra })).point
  /** Every scan that GET /scans returns for a query string, paged to the end. */
  w.allScans = async (qs) => {
    const scans = []
    let cursor
    for (let page = 0; page < 100; page++) {
      const r = await w.agent(`/scans?${qs}&limit=500${cursor ? `&cursor=${cursor}` : ''}`)
      if (r.status !== 200) throw new Error(`GET /scans?${qs}: ${r.status} ${r.text}`)
      scans.push(...r.json.scans)
      cursor = r.json.next_cursor
      if (!cursor) return scans
    }
    throw new Error('GET /scans did not end')
  }
  w.start = async () => {
    w.db = await setupDb()
    await seedAdmin(w.db.pool)
    w.cookie = await adminCookie()
  }
  w.stop = async () => w.db?.teardown()
  return w
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What the counts must be, worked out from the rows of GET /scans (never from the database, never from the SQL of the endpoint).
// ---------------------------------------------------------------------------------------------------------------------------------

/** a < b as the database orders these texts (the names in this file differ at the first letter, all in one case), null last. */
const cmp = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1)

/**
 * The answer that the scans list implies for a grouping: one row for each group of scans, with the name of its provider and point as
 * the NEWEST scan of that provider (or point) among these scans has it, ordered by day, provider name, provider id, point name,
 * point id and service type.
 */
function expected(scans, groupBy) {
  const newest = { provider: new Map(), point: new Map() }
  for (const s of scans) {
    for (const [dimension, id, name] of [['provider', s.provider_id, s.provider_name], ['point', s.point_id, s.point_name]]) {
      const known = newest[dimension].get(id)
      if (!known || s.checked_in_at > known.at || (s.checked_in_at === known.at && name > known.name)) {
        newest[dimension].set(id, { name, at: s.checked_in_at })
      }
    }
  }
  const has = (g) => groupBy.includes(g)
  const groups = new Map()
  for (const s of scans) {
    const row = {
      day: has('day') ? s.local_date : null,
      provider_id: has('provider') ? s.provider_id : null,
      provider_name: has('provider') ? newest.provider.get(s.provider_id).name : null,
      point_id: has('point') ? s.point_id : null,
      point_name: has('point') ? newest.point.get(s.point_id).name : null,
      service_type: has('service_type') ? s.service_type : null,
      count: 0,
    }
    const key = JSON.stringify([row.day, row.provider_id, row.point_id, row.service_type])
    if (!groups.has(key)) groups.set(key, row)
    groups.get(key).count += 1
  }
  const rows = [...groups.values()]
  if (!groupBy.length && !rows.length) rows.push({ day: null, provider_id: null, provider_name: null, point_id: null, point_name: null, service_type: null, count: 0 })
  rows.sort((a, b) => cmp(a.day, b.day) || cmp(a.provider_name, b.provider_name) || cmp(a.provider_id, b.provider_id) || cmp(a.point_name, b.point_name) || cmp(a.point_id, b.point_id) || cmp(a.service_type, b.service_type))
  return { group_by: COUNT_GROUPS.filter(has), counts: rows, total: scans.length }
}

// ===============================================================================================================================
// The main world: three months of visits of four providers at five points, with every kind of scan that the filters can tell apart.
// ===============================================================================================================================

describe('GET /counts: the counts add up to the scans list', () => {
  const w = useWorld()
  const ids = {}
  const FIRST_DAY = '2026-08-03'
  const LAST_DAY = '2026-10-30'

  beforeAll(async () => {
    await w.start()
    const A = await w.makeProvider({ company: 'Acme Cleaners', contact_name: 'Dana', service_type: 'cleaning' })
    const B = await w.makeProvider({ company: 'Bright Gardeners', service_type: 'gardening' })
    const C = await w.makeProvider({ company: 'Cobalt Painters' }) // no service type; renamed to "Cobalt Painters Ltd" in the seed below
    const D = await w.makeProvider({ company: 'Demo Account', is_demo: true })
    const atrium = await w.makePoint({ name: 'Atrium', service_type: 'cleaning' }) // renamed to "Atrium North" in the seed below
    const basement = await w.makePoint({ name: 'Basement' }) // no service type: the visit takes its provider's
    const courtyard = await w.makePoint({ name: 'Courtyard', service_type: 'gardening' }) // deleted below, its scans stay
    const door = await w.makePoint({ name: 'Door', service_type: 'cleaning' })
    Object.assign(ids, { A: A.id, B: B.id, C: C.id, D: D.id, atrium: atrium.id, basement: basement.id, courtyard: courtyard.id, door: door.id })

    // The visits are written straight into the table: a day, a time of day in the building's time zone, and the snapshot that a scan keeps
    // of the names. (The day boundaries are proved through the real recording code in a later describe.)
    const ACME = 'Acme Cleaners ' + DASH + ' Dana'
    const PAIRS = [
      { p: A, pt: atrium, service: 'cleaning', names: [ACME, 'Atrium'] },
      { p: A, pt: door, service: 'cleaning', names: [ACME, 'Door'] },
      { p: A, pt: basement, service: 'cleaning', names: [ACME, 'Basement'] }, // the point has no service: the visit takes the provider's
      { p: B, pt: courtyard, service: 'gardening', names: ['Bright Gardeners', 'Courtyard'] },
      { p: B, pt: basement, service: 'gardening', names: ['Bright Gardeners', 'Basement'] },
      { p: C, pt: basement, service: null, names: ['Cobalt Painters', 'Basement'] }, // neither has a service type
      { p: C, pt: door, service: 'cleaning', names: ['Cobalt Painters', 'Door'] },
      { p: D, pt: atrium, service: 'cleaning', demo: true, names: ['Demo Account', 'Atrium'] },
    ]
    const days = []
    for (let d = new Date(`${FIRST_DAY}T00:00:00Z`); d <= new Date(`${LAST_DAY}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) days.push(d.toISOString().slice(0, 10))
    const rows = []
    days.forEach((day, i) => {
      PAIRS.forEach((pair, j) => {
        const n = [0, 1, 1, 2][(i * 5 + j * 3) % 4]
        const times = []
        if (n >= 1) times.push('07:10')
        if (n >= 2) times.push('12:40')
        if ((i + j) % 11 === 0) times.push('23:40')
        if ((i + j) % 13 === 0) times.push('00:20')
        for (const time of times) {
          const k = rows.length
          rows.push({
            id: randomUUID(),
            point_id: pair.pt.id,
            provider_id: pair.p.id,
            // The names the committee changed over the three months: a provider after the 40th day, a point after the 30th.
            provider_name: pair.p.id === C.id && i >= 40 ? 'Cobalt Painters Ltd' : pair.names[0],
            point_name: pair.pt.id === atrium.id && i >= 30 ? 'Atrium North' : pair.names[1],
            service_type: pair.service,
            day,
            clock: `${time.slice(0, 3)}${String(Number(time.slice(3)) + (k % 7)).padStart(2, '0')}`, // distinct minutes, so that few visits tie
            outcome: k % 9 === 4 ? 'rejected_far' : k % 14 === 6 ? 'rejected_no_location' : 'accepted',
            flags: [...(pair.demo ? ['demo'] : []), ...(k % 8 === 3 ? ['location_unverified'] : []), ...(k % 21 === 5 ? ['offline_sync'] : [])],
            voided: k % 10 === 7,
          })
        }
      })
    })
    await w.db.pool.query(
      `insert into scans (id, point_id, provider_id, point_name, provider_name, service_type, checked_in_at, local_date, source, outcome, flags, voided_at, void_reason)
       select r.id, r.point_id, r.provider_id, r.point_name, r.provider_name, r.service_type,
              ((r.day + r.clock) at time zone 'Asia/Jerusalem'), r.day, 'online', r.outcome,
              array(select jsonb_array_elements_text(r.flags)), case when r.voided then now() end, case when r.voided then 'fake reason' end
         from jsonb_to_recordset($1::jsonb)
           as r(id uuid, point_id uuid, provider_id uuid, point_name text, provider_name text, service_type text, day date, clock time, outcome text, flags jsonb, voided boolean)`,
      [JSON.stringify(rows)],
    )
    ids.seeded = rows.length
    // The committee deletes the courtyard: its scans stay and keep the id and the name.
    expect((await call('DELETE', `/api/admin/points/${courtyard.id}`, { cookie: w.cookie })).status).toBe(200)
  }, 120_000)

  afterAll(() => w.stop())

  const ALL = 'outcome=all&include_voided=1&include_demo=1'
  const RANGE = `from=${FIRST_DAY}&to=${LAST_DAY}`

  it('the seed has every kind of scan that the filters tell apart, so the matrix below is not vacuous', async () => {
    const every = await w.allScans(`${RANGE}&${ALL}`)
    expect(every.length).toBe(ids.seeded)
    expect(every.length).toBeGreaterThan(300)
    const default_ = await w.allScans(RANGE)
    expect(default_.length).toBeGreaterThan(100)
    expect(default_.length).toBeLessThan(every.length)
    const seen = (list, field) => new Set(list.map((s) => s[field]))
    expect([...seen(every, 'outcome')].sort()).toEqual(['accepted', 'rejected_far', 'rejected_no_location'])
    expect(every.some((s) => s.voided)).toBe(true)
    expect(every.some((s) => s.flags.includes('demo'))).toBe(true)
    expect(every.some((s) => s.flags.includes('location_unverified'))).toBe(true)
    expect([...seen(every, 'service_type')].sort((a, b) => cmp(a, b))).toEqual(['cleaning', 'gardening', null])
    expect([...seen(every, 'provider_name')].filter((n) => n.startsWith('Cobalt')).sort()).toEqual(['Cobalt Painters', 'Cobalt Painters Ltd'])
    expect([...seen(every, 'point_name')].filter((n) => n.startsWith('Atrium')).sort()).toEqual(['Atrium', 'Atrium North'])
    expect(every.some((s) => s.point_id === ids.courtyard)).toBe(true) // the point is deleted
    expect((await w.agent('/points')).json.points.some((p) => p.id === ids.courtyard)).toBe(false)
    // Visits just before and just after midnight, which is where a day is decided.
    expect(every.some((s) => s.checked_in_local.slice(11, 13) === '23')).toBe(true)
    expect(every.some((s) => s.checked_in_local.slice(11, 13) === '00')).toBe(true)
  })

  const FILTER_SETS = [
    ['the defaults (accepted, no voided, no demo)', RANGE],
    ['outcome=all', `${RANGE}&outcome=all`],
    ['outcome=rejected', `${RANGE}&outcome=rejected`],
    ['include_voided=1', `${RANGE}&include_voided=1`],
    ['include_demo=true', `${RANGE}&include_demo=true`],
    ['voided, demo and every outcome', `${RANGE}&${ALL}`],
    ['one provider', `from=2026-09-01&to=2026-09-30&provider_id=@A`],
    ['one point', `${RANGE}&point_id=@basement`],
    ['a point that was deleted', `${RANGE}&${ALL}&point_id=@courtyard`],
    ['one service', `${RANGE}&service_type=cleaning`],
    ['one flag', `${RANGE}&flag=location_unverified`],
    ['the demo flag with the demo account shown', `${RANGE}&outcome=all&flag=demo&include_demo=1`],
    ['a day range inside the data', 'from=2026-09-10&to=2026-09-20&outcome=all'],
    ['a range of moments with offsets', 'from=2026-09-01T00:00:00%2B03:00&to=2026-09-30T23:59:59%2B03:00'],
    ['a range of moments in UTC, one end a day', 'from=2026-09-14T20:00:00Z&to=2026-09-21&outcome=all'],
    ['an early range, before the provider and the point were renamed', 'from=2026-08-03&to=2026-08-31&outcome=all'],
    ['a range that ends before it starts', 'from=2026-09-30&to=2026-09-01'],
    ['a range with no data', 'from=2001-01-01&to=2001-01-31'],
  ]
  const GROUPINGS = [
    [],
    ['day'],
    ['provider'],
    ['point'],
    ['service_type'],
    ['day', 'provider'],
    ['provider', 'point'],
    ['point', 'service_type'],
    ['day', 'point', 'service_type'],
    ['day', 'provider', 'point', 'service_type'],
  ]

  for (const [what, template] of FILTER_SETS) {
    it(`for ${what}: the sum of the counts is the number of rows of /scans, and every group is its scans, for every grouping`, async () => {
      const qs = template.replace(/@(\w+)/g, (_, name) => ids[name])
      const scans = await w.allScans(qs)
      const problems = []
      for (const groupBy of GROUPINGS) {
        const r = await w.counts(`${qs}${groupBy.length ? `&group_by=${groupBy.join(',')}` : ''}`)
        if (r.status !== 200) {
          problems.push(`${groupBy.join(',') || 'no grouping'}: ${r.status} ${r.text}`)
          continue
        }
        const want = expected(scans, groupBy)
        try {
          expect(r.json).toEqual(want)
        } catch (err) {
          problems.push(`${groupBy.join(',') || 'no grouping'}: ${err.message.split('\n').slice(0, 25).join('\n')}`)
        }
        expect(r.json.counts.reduce((sum, row) => sum + row.count, 0)).toBe(scans.length)
        expect(r.json.total).toBe(scans.length)
      }
      expect(problems, problems.join('\n\n')).toEqual([])
    }, 60_000)
  }

  it('also with the groupings written in the reverse of the fixed order, and for the empty range of a grouped answer', async () => {
    const scans = await w.allScans(`${RANGE}&${ALL}`)
    const r = await w.counts(`${RANGE}&${ALL}&group_by=service_type,point,provider,day`)
    expect(r.json.group_by).toEqual(['day', 'provider', 'point', 'service_type'])
    expect(r.json).toEqual(expected(scans, ['day', 'provider', 'point', 'service_type']))
    // A grouped answer with no visit has no row; the total of an ungrouped one is its one row.
    const none = await w.counts('from=2001-01-01&to=2001-01-31&group_by=day,provider')
    expect(none.json).toEqual({ group_by: ['day', 'provider'], counts: [], total: 0 })
    const zero = await w.counts('from=2001-01-01&to=2001-01-31')
    expect(zero.json).toEqual({ group_by: [], counts: [{ day: null, provider_id: null, provider_name: null, point_id: null, point_name: null, service_type: null, count: 0 }], total: 0 })
    expect((await w.counts(`${RANGE}&group_by=`)).json.group_by).toEqual([]) // an empty group_by is no grouping
  })

  it('the shape: seven fields in order, ISO day, ids, a whole count, and null for what was not grouped by', async () => {
    const day = (await w.counts(`${RANGE}&group_by=day`)).json
    expect(Object.keys(day)).toEqual(['group_by', 'counts', 'total'])
    expect(ROW_KEYS).toEqual([...COUNT_FIELDS])
    for (const row of day.counts) {
      expect(Object.keys(row)).toEqual(ROW_KEYS)
      expect(row.day).toMatch(DAY)
      expect(Number.isInteger(row.count) && row.count > 0).toBe(true)
      expect([row.provider_id, row.provider_name, row.point_id, row.point_name, row.service_type]).toEqual([null, null, null, null, null])
    }
    const all = (await w.counts(`${RANGE}&${ALL}&group_by=day,provider,point,service_type`)).json
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const row of all.counts) {
      expect(row.day).toMatch(DAY)
      expect(row.provider_id).toMatch(UUID)
      expect(row.point_id).toMatch(UUID)
      expect(typeof row.provider_name).toBe('string')
      expect(typeof row.point_name).toBe('string')
    }
    expect(all.counts.some((row) => row.service_type === null)).toBe(true) // the visits that have no service type are one group
    const total = (await w.counts(RANGE)).json
    expect(total.group_by).toEqual([])
    expect(total.counts).toHaveLength(1)
    expect(total.counts[0].count).toBe(total.total)
  })

  it('the name of a provider or a point is the name on its newest counted visit, one name for all its rows', async () => {
    // Over the whole range the provider and the point carry their new names, in every row, whatever the day.
    const r = (await w.counts(`${RANGE}&${ALL}&group_by=day,provider,point`)).json
    const names = (id, field) => new Set(r.counts.filter((row) => row[field.replace('_name', '_id')] === id).map((row) => row[field]))
    expect(names(ids.C, 'provider_name')).toEqual(new Set(['Cobalt Painters Ltd']))
    expect(names(ids.atrium, 'point_name')).toEqual(new Set(['Atrium North']))
    expect(names(ids.A, 'provider_name')).toEqual(new Set(['Acme Cleaners ' + DASH + ' Dana']))
    // Only the early visits selected: the newest of THEM has the old name.
    const early = (await w.counts('from=2026-08-03&to=2026-08-31&outcome=all&group_by=day,provider,point')).json
    expect(new Set(early.counts.filter((row) => row.provider_id === ids.C).map((row) => row.provider_name))).toEqual(new Set(['Cobalt Painters']))
    expect(new Set(early.counts.filter((row) => row.point_id === ids.atrium).map((row) => row.point_name))).toEqual(new Set(['Atrium']))
    // A deleted point is counted under the name its visits recorded, with its id.
    const gone = (await w.counts(`${RANGE}&${ALL}&group_by=point`)).json.counts.find((row) => row.point_id === ids.courtyard)
    expect(gone.point_name).toBe('Courtyard')
    expect(gone.count).toBeGreaterThan(0)
    // One provider is one group however many names it had: two rows would be two groups.
    const providers = (await w.counts(`${RANGE}&${ALL}&group_by=provider`)).json.counts
    expect(providers.map((row) => row.provider_name)).toEqual(['Acme Cleaners ' + DASH + ' Dana', 'Bright Gardeners', 'Cobalt Painters Ltd', 'Demo Account'])
    expect(providers.map((row) => row.provider_id)).toEqual([ids.A, ids.B, ids.C, ids.D])
  })

  it('the defaults of /scans hold here: accepted only, voided and demo hidden, and each switch brings them back', async () => {
    const total = async (qs) => (await w.counts(`${RANGE}&${qs}`)).json.total
    const base = await total('')
    expect(await total('include_voided=1')).toBeGreaterThan(base)
    expect(await total('include_demo=1')).toBeGreaterThan(base)
    expect(await total('outcome=all')).toBeGreaterThan(base)
    expect(await total('outcome=all&include_voided=1&include_demo=1')).toBeGreaterThan(await total('outcome=all'))
    // Only true or 1 mean yes, exactly as in /scans.
    expect(await total('include_voided=yes')).toBe(base)
    expect(await total('include_demo=0')).toBe(base)
    expect(await total('include_voided=true')).toBe(await total('include_voided=1'))
    // The default is "accepted": a refused attempt is not a visit.
    const rejected = (await w.counts(`${RANGE}&outcome=rejected&group_by=day`)).json
    expect(rejected.total).toBeGreaterThan(0)
    expect(await total('outcome=accepted')).toBe(base)
  })

  it('is built from scanWhere, the very conditions of the scans list: the same parameters, in the statement, for every filter', () => {
    expect([...COUNT_FILTERS]).toEqual([...SCAN_WHERE_FILTERS, 'group_by'])
    const q = {
      from: '2026-09-01', to: '2026-09-30T10:00:00Z', point_id: ids.basement.toUpperCase(), provider_id: ids.A, service_type: 'cleaning', flag: 'demo',
      outcome: 'rejected', include_voided: '1', include_demo: 'true', group_by: 'day',
    }
    const counted = countsQuery(q)
    const listed = scanWhere(q)
    expect(counted.params).toEqual(listed.params)
    for (const condition of listed.where) expect(counted.sql, condition).toContain(condition)
    expect(countsQuery({ ...q, group_by: undefined }).params).toEqual(listed.params) // and the grouping does not touch the parameters
    // Named columns, never `select *`: a column that is added to `scans` later is not read.
    expect(counted.sql).not.toMatch(/select\s+\*/i)
    expect(counted.sql).not.toMatch(/\bs\.\*/)
  })
})

// ===============================================================================================================================
// The guard, the validation, the secrets
// ===============================================================================================================================

describe('GET /counts: the key, the validation and what must not come out', () => {
  const w = useWorld()
  const secrets = {}
  const RANGE = 'from=2026-09-01&to=2026-09-30'

  beforeAll(async () => {
    await w.start()
    const cleaners = await w.makeProvider({ company: 'Acme Cleaners', contact_name: 'Dana', service_type: 'cleaning' })
    const point = await w.makePoint({ name: 'Atrium', service_type: 'cleaning' })
    secrets.qr = point.qr_token
    secrets.legacy = 'legacy-marker-5521'
    await w.db.pool.query('update points set legacy_id = $1 where id = $2', [secrets.legacy, point.id])
    secrets.password = 'pw-fake-secret-4821'
    const session = await call('POST', '/api/session', { body: { provider_id: cleaners.id, password: secrets.password, device_label: LABEL }, ip: IP })
    secrets.token = session.json.token
    secrets.tokenHash = sha256(session.json.token)
    const { rows } = await w.db.pool.query('select id from provider_devices where token_hash = $1', [secrets.tokenHash])
    secrets.deviceId = rows[0].id
    // A few visits through the real route, so that the answer has data and a phone has made them.
    for (let i = 0; i < 3; i++) {
      const point2 = await w.makePoint({ name: `Fake point ${i}` })
      const r = await call('POST', '/api/scan', { token: secrets.token, body: { id: randomUUID(), code: point2.qr_token }, ip: IP })
      if (r.status !== 200) throw new Error(`seed scan: ${r.status} ${r.text}`)
    }
    const spare = await mintAgentKey(w.cookie, 'agent counts, revoked')
    secrets.revoked = spare.key
    await revokeAgentKey(w.cookie, spare.id)
  }, 60_000)

  afterAll(() => w.stop())

  it('needs an agent key: none, a key that is not one, an unknown and a revoked key are a 401, whatever else is wrong with the request', async () => {
    const path = '/api/agent/v1/counts'
    for (const [what, opts, code] of [
      ['no key', {}, 'api_key_required'],
      ['a header that is not a Bearer key', { headers: { authorization: 'Basic abc' } }, 'api_key_required'],
      ['a Bearer token that is not a key', { token: 'not-a-key' }, 'api_key_required'],
      ['an unknown key', { token: `${API_KEY_PREFIX}unknown` }, 'api_key_invalid'],
      ['a revoked key', { token: secrets.revoked }, 'api_key_invalid'],
      ['the token of a provider\'s phone', { token: secrets.token }, 'api_key_required'],
    ]) {
      for (const qs of ['', `?${RANGE}`, '?group_by=zzz', '?from=zzz']) {
        const r = await call('GET', `${path}${qs}`, opts)
        expect([what, qs, r.status, r.json?.error?.code]).toEqual([what, qs, 401, code])
      }
    }
    const asAdmin = await call('GET', `${path}?${RANGE}`, { cookie: w.cookie })
    expect(asAdmin.status).toBe(401) // the committee's session is not a key
    expect((await call('POST', path, { token: await w.currentKey(), body: {} })).status).toBe(405)
    expect((await call('GET', `${path}?${RANGE}`, { token: await w.currentKey(), badJsonBody: true })).json.error.code).toBe('invalid_json')
    expect((await w.counts(RANGE)).status).toBe(200)
  })

  it('writes nothing: the rows of every table of the data are as they were after a run of requests', async () => {
    const tables = ['scans', 'scan_refusals', 'audit_log', 'points', 'providers', 'provider_devices', 'point_providers']
    const size = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await w.db.pool.query(`select count(*)::int as n from ${t}`)).rows[0].n])))
    const before = await size()
    for (const qs of [RANGE, `${RANGE}&group_by=day,provider,point,service_type`, `${RANGE}&outcome=all&include_voided=1&include_demo=1&group_by=point`, 'from=zzz', '']) await w.counts(qs)
    expect(await size()).toEqual(before)
  })

  it('refuses a missing from or to, and names the missing one', async () => {
    for (const [qs, field] of [
      ['', 'from'],
      ['group_by=day', 'from'],
      ['to=2026-09-30', 'from'],
      ['from=2026-09-01', 'to'],
      ['from=', 'from'],
      ['from=2026-09-01&to=', 'to'],
      ['from=&to=2026-09-30', 'from'],
      ['point_id=' + randomUUID(), 'from'],
    ]) {
      const r = await w.counts(qs)
      expect([qs, r.status, r.json.error.code, r.json.error.field]).toEqual([qs, 400, 'invalid_filter', field])
    }
  })

  it('refuses a from or to that /scans refuses, the same way, naming the field', async () => {
    for (const [name, value] of [
      ['from', '2026-02-30'], ['from', '2026-06-01T10:00:00'], ['from', 'yesterday'], ['from', '0'],
      ['to', '2026-02-30'], ['to', '2026-06-01T10:00:00'], ['to', 'yesterday'], ['to', '0'],
      ['point_id', 'zzz'], ['point_id', '123'], ['provider_id', 'zzz'], ['provider_id', '123'], ['outcome', 'zzz'], ['outcome', 'ACCEPTED'],
    ]) {
      const other = name === 'from' ? 'to=2026-09-30' : name === 'to' ? 'from=2026-09-01' : RANGE
      const counted = await w.counts(`${other}&${name}=${encodeURIComponent(value)}`)
      const listed = await w.agent(`/scans?${other}&${name}=${encodeURIComponent(value)}`)
      expect([name, value, counted.status, counted.json.error]).toEqual([name, value, listed.status, listed.json.error])
      expect(counted.json.error.field).toBe(name)
    }
    // A value that the database itself refuses (a null byte) is refused as it is in /scans.
    const counted = await w.counts(`${RANGE}&service_type=a%00b`)
    const listed = await w.agent(`/scans?${RANGE}&service_type=a%00b`)
    expect(counted.status).toBe(400)
    expect([counted.status, counted.json.error.code]).toEqual([listed.status, listed.json.error.code])
  })

  it(`refuses a range of more than ${COUNTS_MAX_DAYS} days, naming to, and allows one of exactly ${COUNTS_MAX_DAYS}`, async () => {
    const refused = async (qs) => {
      const r = await w.counts(qs)
      expect([qs, r.status, r.json?.error?.code, r.json?.error?.field]).toEqual([qs, 400, 'invalid_filter', 'to'])
    }
    const allowed = async (qs) => {
      const r = await w.counts(qs)
      expect([qs, r.status]).toEqual([qs, 200])
    }
    // Days: both ends count, so a leap year is 366 days and a year of 365 days with one more day is 366 too.
    await allowed('from=2024-01-01&to=2024-12-31')
    await allowed('from=2025-01-01&to=2025-12-31')
    await allowed('from=2025-01-01&to=2026-01-01')
    await refused('from=2024-01-01&to=2025-01-01')
    await refused('from=2025-01-01&to=2026-01-02')
    await refused('from=2000-01-01&to=2100-01-01')
    // Moments: exactly 366 days is allowed, a second more is not.
    await allowed('from=2026-01-01T00:00:00Z&to=2027-01-02T00:00:00Z')
    await refused('from=2026-01-01T00:00:00Z&to=2027-01-02T00:00:01Z')
    await allowed('from=2026-01-01T00:00:00%2B02:00&to=2027-01-01T22:00:00Z')
    await refused('from=2026-01-01T00:00:00%2B02:00&to=2027-01-02T02:00:00Z')
    // A day and a moment: a day from starts at its midnight, a day to ends at the end of the day.
    await allowed('from=2026-01-01&to=2027-01-02T00:00:00Z')
    await refused('from=2026-01-01&to=2027-01-02T00:00:01Z')
    await allowed('from=2026-01-01T12:00:00Z&to=2027-01-01')
    await refused('from=2026-01-01T12:00:00Z&to=2027-01-02')
    // The same cut is applied whatever is grouped, and with every other filter.
    await refused('from=2024-01-01&to=2025-01-01&group_by=day&outcome=all')
    // A range that ends before it starts is not too long, it is empty (as in /scans).
    const backwards = await w.counts('from=2026-09-30&to=2026-09-01&group_by=day')
    expect(backwards.json).toEqual({ group_by: ['day'], counts: [], total: 0 })
    const far = await w.counts('from=2100-01-01&to=2000-01-01')
    expect(far.status).toBe(200)
  })

  it('refuses a group_by that is not a comma list of the four values, each once, and names group_by', async () => {
    expect(parseGroupBy(undefined)).toEqual([])
    expect(parseGroupBy('')).toEqual([])
    expect(parseGroupBy('service_type,day')).toEqual(['day', 'service_type'])
    for (const value of [
      'zzz', 'DAY', 'Day', 'days', 'provider_id', 'point,zzz', 'day,day', 'day,provider,day', 'day,', ',day', 'day,,provider', ',', ' ',
      'day, provider', ' day', 'day;provider', 'day|provider', 'day/provider', 'day%20', '*', 'constructor', '__proto__', 'day\u0000', 'a'.repeat(5000),
    ]) {
      const r = await w.counts(`${RANGE}&group_by=${encodeURIComponent(value)}`)
      expect([value.slice(0, 30), r.status, r.json?.error?.code, r.json?.error?.field]).toEqual([value.slice(0, 30), 400, 'invalid_filter', 'group_by'])
      expect(JSON.stringify(r.json).length).toBeLessThan(600) // the message does not echo the whole value
    }
    // Each of the four alone, and all of them, in every order of a pair.
    for (const value of ['day', 'provider', 'point', 'service_type', 'day,provider,point,service_type', 'point,day', 'service_type,provider']) {
      expect((await w.counts(`${RANGE}&group_by=${value}`)).status, value).toBe(200)
    }
  })

  it('does not read the order, limit, cursor or format of the scans list: the answer is the same JSON whatever they say', async () => {
    const plain = await w.counts(`${RANGE}&group_by=day`)
    for (const extra of ['limit=abc', 'limit=1', 'order=up', 'cursor=zzz', 'format=csv', 'format=xml', 'unknown=1']) {
      const r = await w.counts(`${RANGE}&group_by=day&${extra}`)
      expect([extra, r.status, r.headers['content-type']?.includes('json')]).toEqual([extra, 200, true])
      expect(r.json).toEqual(plain.json)
    }
  })

  it('shows nothing secret: no QR code, legacy id, password, hash, key, phone, address or label, in any grouping', async () => {
    const marker = 'secret-marker-9921'
    // A column that is added to `scans` later does not reach the answer: it is added now, with a value on every row.
    await w.db.pool.query(`alter table scans add column later_column text not null default '${marker}'`)
    // The three visits of the seed were recorded just now: a range around today holds them.
    const dayOf = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
    const around = `from=${dayOf(-30)}&to=${dayOf(2)}`
    const raw = []
    for (const group of ['', 'day', 'provider', 'point', 'service_type', 'day,provider,point,service_type']) {
      for (const filters of ['', '&outcome=all&include_voided=1&include_demo=1']) {
        const r = await w.counts(`${around}${group ? `&group_by=${group}` : ''}${filters}`)
        expect(r.status).toBe(200)
        raw.push(r.text)
      }
    }
    const real = await w.counts(`${around}&group_by=day,provider,point,service_type&outcome=all&include_voided=1&include_demo=1`)
    expect(real.json.total).toBe(3) // the three visits of the seed
    raw.push(real.text)
    const text = raw.join('\n')
    const key = await w.currentKey()
    for (const secret of [
      secrets.qr, QR_TOKEN_PREFIX, secrets.legacy, secrets.password, secrets.token, secrets.tokenHash, secrets.deviceId, LABEL, 'Phone-Marker-6612',
      IP, key, sha256(key), key.slice(0, 8), marker, 'later_column', 'device_id', 'client_time', 'received_at', 'checked_in', 'qr_token', 'legacy_id',
    ]) {
      expect(text, String(secret).slice(0, 20)).not.toContain(secret)
    }
    // The only keys in the whole answer are the envelope and the seven fields.
    for (const body of raw) {
      const answer = JSON.parse(body)
      expect(Object.keys(answer)).toEqual(['group_by', 'counts', 'total'])
      for (const row of answer.counts) expect(Object.keys(row)).toEqual(ROW_KEYS)
    }
  })
})

// ===============================================================================================================================
// The day is the day in the building's time zone
// ===============================================================================================================================

describe('GET /counts: a day is a day in the building time zone, through the real recording code', () => {
  const w = useWorld()
  const world = {}

  // The visits: the moment (UTC), and the day in Israel that it must fall on. Israel is UTC+2 in winter and UTC+3 in summer. The clocks
  // go forward on Friday 27/03/2026 at 02:00 (a day of 23 hours) and back on Sunday 25/10/2026 at 02:00 (a day of 25 hours). Every expected
  // day is worked out by hand from those, never by the code under test.
  const VISITS = [
    ['2026-09-14T20:30:00Z', '2026-09-14', '23:30 in summer time'],
    ['2026-09-14T21:30:00Z', '2026-09-15', '00:30 in summer time'],
    ['2026-12-14T21:30:00Z', '2026-12-14', '23:30 in winter time'],
    ['2026-12-14T22:30:00Z', '2026-12-15', '00:30 in winter time'],
    ['2026-03-26T21:30:00Z', '2026-03-26', '23:30 in winter time, the day before the clocks go forward'],
    ['2026-03-26T22:30:00Z', '2026-03-27', '00:30 in winter time, on the day the clocks go forward'],
    ['2026-03-27T20:30:00Z', '2026-03-27', '23:30 in summer time on that day (a day of 23 hours)'],
    ['2026-03-27T21:30:00Z', '2026-03-28', '00:30 in summer time after it'],
    ['2026-10-24T20:30:00Z', '2026-10-24', '23:30 in summer time, the day before the clocks go back'],
    ['2026-10-24T21:30:00Z', '2026-10-25', '00:30 in summer time, on the day the clocks go back'],
    ['2026-10-25T21:30:00Z', '2026-10-25', '23:30 in winter time on that day (a day of 25 hours): adding 3 hours would make it the 26th'],
    ['2026-10-25T22:30:00Z', '2026-10-26', '00:30 in winter time after it'],
  ]

  beforeAll(async () => {
    await w.start()
    const provider = await w.makeProvider({ company: 'Acme Cleaners', contact_name: 'Dana', service_type: 'cleaning' })
    const point = await w.makePoint({ name: 'Atrium', service_type: 'cleaning' })
    const { rows } = await w.db.pool.query('select * from providers where id = $1', [provider.id])
    world.provider = rows[0]
    world.point = point
    // Recorded the way a phone that had no signal does it, with its own clock one minute before the server's: the visit is at the
    // moment that the phone says, and the day is written by the code that records it (server/scans.js), not by this test.
    for (const [at] of VISITS) {
      const result = await recordScan({
        provider: world.provider,
        deviceId: null,
        input: { id: randomUUID(), code: point.qr_token, clientTime: at },
        source: SOURCE_OFFLINE_SYNC,
        now: new Date(Date.parse(at) + 60_000),
      })
      expect(result.scan.checked_in_at).toBe(at.replace('Z', '.000Z'))
    }
  }, 60_000)

  afterAll(() => w.stop())

  it('writes the day of each visit as the building lived it', async () => {
    const scans = await w.allScans('from=2026-01-01&to=2026-12-31&outcome=all')
    expect(scans).toHaveLength(VISITS.length)
    for (const [at, day, why] of VISITS) {
      const scan = scans.find((s) => s.checked_in_at === at.replace('Z', '.000Z'))
      expect([at, why, scan.local_date]).toEqual([at, why, day])
    }
  })

  it('counts the visits on the days they fall on, a visit at 23:30 and one at 00:30 on different days', async () => {
    const r = (await w.counts('from=2026-01-01&to=2026-12-31&group_by=day')).json
    const days = {}
    for (const [, day] of VISITS) days[day] = (days[day] ?? 0) + 1
    expect(r.counts.map((row) => [row.day, row.count])).toEqual(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)))
    expect(r.total).toBe(VISITS.length)
    // The two days of the clock change hold what the clock showed on them.
    expect(days['2026-10-25']).toBe(2)
    expect(days['2026-03-27']).toBe(2)
  })

  it('a day range and a range of moments that name the same hours count the same visits, also on the long and the short day', async () => {
    const same = async (dayRange, momentRange, want) => {
      const byDay = (await w.counts(`${dayRange}`)).json.total
      const byMoment = (await w.counts(`${momentRange}`)).json.total
      const listed = (await w.allScans(`${dayRange}&outcome=all`)).length
      expect([dayRange, byDay, byMoment, listed]).toEqual([dayRange, want, want, want])
    }
    // 25/10/2026 lasts from 24/10 21:00 UTC (00:00 summer time) to 25/10 22:00 UTC (00:00 winter time), 25 hours.
    await same('from=2026-10-25&to=2026-10-25', 'from=2026-10-24T21:00:00Z&to=2026-10-25T21:59:59Z', 2)
    // 27/03/2026 lasts from 26/03 22:00 UTC (00:00 winter time) to 27/03 21:00 UTC (00:00 summer time), 23 hours.
    await same('from=2026-03-27&to=2026-03-27', 'from=2026-03-26T22:00:00Z&to=2026-03-27T20:59:59Z', 2)
    // One second outside the day is another day.
    await same('from=2026-10-26&to=2026-10-26', 'from=2026-10-25T22:00:00Z&to=2026-10-26T21:59:59Z', 1)
    await same('from=2026-09-14&to=2026-09-14', 'from=2026-09-13T21:00:00Z&to=2026-09-14T20:59:59Z', 1)
    // A range of days across the change, grouped by day, is /scans day by day.
    const across = (await w.counts('from=2026-10-24&to=2026-10-26&group_by=day')).json
    expect(across.counts).toEqual([
      { day: '2026-10-24', provider_id: null, provider_name: null, point_id: null, point_name: null, service_type: null, count: 1 },
      { day: '2026-10-25', provider_id: null, provider_name: null, point_id: null, point_name: null, service_type: null, count: 2 },
      { day: '2026-10-26', provider_id: null, provider_name: null, point_id: null, point_name: null, service_type: null, count: 1 },
    ])
  })

  // Last, because it adds visits of another year.
  it('two names of one provider on visits at the very same moment: the one that sorts last, and one group', async () => {
    for (const name of ['Acme Cleaners', 'Zed Cleaners']) {
      await w.db.pool.query(
        `insert into scans (id, point_id, provider_id, point_name, provider_name, service_type, checked_in_at, local_date, source, outcome, flags)
         values ($1, $2, $3, 'Atrium', $4, 'cleaning', timestamptz '2030-01-01 10:00:00+00', '2030-01-01', 'online', 'accepted', '{}')`,
        [randomUUID(), world.point.id, world.provider.id, name],
      )
    }
    const r = (await w.counts('from=2030-01-01&to=2030-01-01&group_by=provider')).json
    expect(r.counts).toHaveLength(1)
    expect(r.counts[0]).toMatchObject({ provider_id: world.provider.id, provider_name: 'Zed Cleaners', count: 2 })
  })
})

// ===============================================================================================================================
// The row cap, and the index
// ===============================================================================================================================

describe(`GET /counts: an answer of ${COUNTS_MAX_ROWS} rows is given, one more is refused`, () => {
  const w = useWorld()
  const world = {}
  // 366 days of 2024 and 25 points make 9150 groups of (day, point) for one provider; a second provider at the first 850 of those makes
  // the groups of (day, provider, point) exactly COUNTS_MAX_ROWS, and one more visit makes one group too many.
  const POINTS = 25
  const EXTRA = COUNTS_MAX_ROWS - POINTS * 366
  const RANGE = 'from=2024-01-01&to=2024-12-31'

  beforeAll(async () => {
    await w.start()
    world.a = await w.makeProvider({ company: 'Acme Cleaners', service_type: 'cleaning' })
    world.b = await w.makeProvider({ company: 'Bright Gardeners', service_type: 'gardening' })
    for (let i = 0; i < POINTS; i++) await w.makePoint({ name: `Fake point ${String(i).padStart(2, '0')}`, service_type: 'cleaning' })
    const insert = (providerId, providerName, limit) =>
      w.db.pool.query(
        `insert into scans (id, point_id, provider_id, point_name, provider_name, service_type, checked_in_at, local_date, source, outcome, flags)
         select gen_random_uuid(), x.point_id, $1, x.name, $2, 'cleaning', ((x.day + time '09:00') at time zone 'Asia/Jerusalem'), x.day, 'online', 'accepted', '{}'
           from (select d.day::date as day, p.id as point_id, p.name, row_number() over (order by d.day, p.id) as n
                   from generate_series(date '2024-01-01', date '2024-12-31', interval '1 day') as d(day) cross join points p) x
          where x.n <= $3`,
        [providerId, providerName, limit],
      )
    await insert(world.a.id, 'Acme Cleaners', 1_000_000)
    await insert(world.b.id, 'Bright Gardeners', EXTRA)
    await w.db.pool.query('analyze scans')
  }, 120_000)

  afterAll(() => w.stop())

  it('the seed is exactly the size the test needs', async () => {
    const { rows } = await w.db.pool.query('select count(*)::int as n, count(distinct (local_date, point_id, provider_id))::int as groups from scans')
    expect(rows[0].groups).toBe(COUNTS_MAX_ROWS)
    expect(rows[0].n).toBe(COUNTS_MAX_ROWS)
  })

  it(`gives an answer of exactly ${COUNTS_MAX_ROWS} rows, whole, and the total adds up`, async () => {
    const r = await w.counts(`${RANGE}&group_by=day,provider,point`)
    expect(r.status).toBe(200)
    expect(r.json.counts).toHaveLength(COUNTS_MAX_ROWS)
    expect(r.json.total).toBe(COUNTS_MAX_ROWS)
    expect(r.json.counts.every((row) => row.count === 1)).toBe(true)
  })

  it(`refuses an answer of ${COUNTS_MAX_ROWS + 1} rows, names group_by and says what to narrow, and does not cut it`, async () => {
    const point = (await w.db.pool.query('select id, name from points order by name limit 1')).rows[0]
    // One more group: another service type on a day and a point that the second provider has not visited.
    await w.db.pool.query(
      `insert into scans (id, point_id, provider_id, point_name, provider_name, service_type, checked_in_at, local_date, source, outcome, flags)
       values ($1, $2, $3, $4, 'Bright Gardeners', 'gardening', timestamptz '2024-06-01 10:00+03', '2024-06-01', 'online', 'accepted', '{}')`,
      [randomUUID(), point.id, world.b.id, point.name],
    )
    const r = await w.counts(`${RANGE}&group_by=day,provider,point,service_type`)
    expect([r.status, r.json.error.code, r.json.error.field]).toEqual([400, 'invalid_filter', 'group_by'])
    expect(r.json.error.message).toContain(String(COUNTS_MAX_ROWS))
    expect(r.json.error.message).toMatch(/shorter range|fewer things/)
    // A narrower range, or a grouping with fewer things, gives the whole answer.
    const narrower = await w.counts('from=2024-01-01&to=2024-06-30&group_by=day,provider,point,service_type')
    expect(narrower.status).toBe(200)
    expect(narrower.json.total).toBe(narrower.json.counts.reduce((sum, row) => sum + row.count, 0))
    const fewer = await w.counts(`${RANGE}&group_by=day,point`)
    expect(fewer.status).toBe(200)
    expect(fewer.json.counts).toHaveLength(POINTS * 366)
    expect(fewer.json.total).toBe(COUNTS_MAX_ROWS + 1)
    // And the scans list agrees on the number of visits.
    expect((await w.allScans(RANGE)).length).toBe(COUNTS_MAX_ROWS + 1)
  }, 60_000)

  describe('the statement can use the indexes of the scans table', () => {
    // The planner reads the whole table of a table of a few thousand rows, so the sequential scan is switched off for the one
    // transaction of the explain: what is asked is whether an index CAN serve the range, not what the planner prefers on this data.
    const planOf = async (q) => {
      const { sql, params } = countsQuery(q)
      return tx(async (c) => {
        await c.query('set local enable_seqscan = off')
        const { rows } = await c.query(`explain ${sql}`, params)
        return rows.map((r) => r['QUERY PLAN']).join('\n')
      })
    }

    it('reads a range of days from scans_local_date_idx, with or without a grouping', async () => {
      for (const group_by of [undefined, 'day', 'provider,point', 'day,provider,point,service_type']) {
        const plan = await planOf({ from: '2024-03-01', to: '2024-03-31', group_by })
        expect(plan, `${group_by}:\n${plan}`).toContain('scans_local_date_idx')
        expect(plan, `${group_by}:\n${plan}`).toMatch(/Index Cond: .*local_date/s)
      }
    })

    it('reads a range of moments through an index on checked_in_at (scans_checked_in_idx, or a skip scan of the index of the provider on PostgreSQL 18), never the whole table', async () => {
      const plan = await planOf({ from: '2024-03-01T00:00:00Z', to: '2024-03-31T23:59:59Z', group_by: 'day,provider' })
      expect(plan, plan).toMatch(/Index Cond: .*checked_in_at/s)
      expect(plan, plan).toMatch(/scans_checked_in_idx|scans_provider_idx|scans_point_idx/)
      expect(plan, plan).not.toMatch(/Seq Scan on scans/)
    })

    it('groups in the database in one statement: the plan holds the aggregate, and the text is one statement', async () => {
      const q = { from: '2024-03-01', to: '2024-03-31', group_by: 'day,provider,point,service_type' }
      expect(countsQuery(q).sql.match(/;/g) ?? []).toHaveLength(0)
      expect(await planOf(q)).toMatch(/Aggregate/)
    })
  })
})

