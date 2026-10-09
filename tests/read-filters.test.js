// The pieces that were taken out of the listings so that a later endpoint can use the very same code, and that nothing else proves:
//   - scanWhere (server/scans.js): the conditions of the scan filters, which listScans uses and a later counting endpoint will;
//   - REFUSAL_FILTERS (server/scanRefusals.js): the list of what listRefusals and the agent's listAgentRefusals read from their query
//     (the audit log has AUDIT_FILTERS, proved in tests/audit-read.test.js, and the scans have SCAN_FILTERS, proved in
//     tests/agent-docs.test.js);
//   - PHONE_HEALTH_LATERAL (server/deviceStatus.js): the phone-health part of the providers list of the committee and of the agent
//     (the committee's numbers are proved in tests/providers-phone-health.test.js, the agent's in
//     tests/agent-phones-building-voids.test.js);
//   - looksSecret (shared/secretLike.js).
// None of them changed what any route answers: the answers themselves are proved by the tests of the routes. No database is
// needed: the statements are read from a pool that records them.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setPool } from '../server/db.js'
import { scanWhere, listScans, SCAN_WHERE_FILTERS, SCAN_FILTERS } from '../server/scans.js'
import { listRefusals, listAgentRefusals, REFUSAL_FILTERS, AGENT_REFUSAL_COLUMNS } from '../server/scanRefusals.js'
import { PHONE_HEALTH_LATERAL } from '../server/deviceStatus.js'
import { looksSecret } from '../shared/secretLike.js'
import { FILTER_TEXT_MAX_LENGTH } from '../server/config.js'

/** A pool that records the statements it is asked to run and answers with no rows. */
function recordingPool() {
  const statements = []
  setPool({
    query: async (sql, params) => {
      statements.push({ sql, params })
      return { rows: [] }
    },
  })
  return statements
}
afterEach(() => setPool(undefined))

/** A query whose reads are written down: `reads` holds every property name that was looked at. */
function watched(base) {
  const reads = new Set()
  const q = new Proxy(base, { get: (target, prop) => (typeof prop === 'string' ? (reads.add(prop), target[prop]) : target[prop]) })
  return { q, reads }
}

const P = randomUUID()
const V = randomUUID()
const EVERYTHING = {
  from: '2026-03-01', to: '2026-03-31T10:00:00Z', point_id: P.toUpperCase(), provider_id: V, service_type: 'cleaning', flag: 'demo',
  outcome: 'rejected', include_voided: '1', include_demo: 'true',
}

describe('scanWhere: the conditions of the scan filters', () => {
  it('reads exactly the filters that SCAN_WHERE_FILTERS lists, and SCAN_FILTERS is those and the three that page the list', () => {
    const { q, reads } = watched({ ...EVERYTHING })
    scanWhere(q)
    expect([...reads].sort()).toEqual([...SCAN_WHERE_FILTERS].sort())
    expect([...SCAN_FILTERS]).toEqual([
      'from', 'to', 'point_id', 'provider_id', 'service_type', 'flag', 'outcome', 'include_voided', 'include_demo', 'order', 'limit', 'cursor',
    ])
    expect([...SCAN_FILTERS]).toEqual([...SCAN_WHERE_FILTERS, 'order', 'limit', 'cursor'])
    expect(Object.isFrozen(SCAN_WHERE_FILTERS)).toBe(true)
    expect(Object.isFrozen(SCAN_FILTERS)).toBe(true)
  })

  it('with no filter it keeps the accepted scans that are not voided and not the demo account: three conditions, one parameter', () => {
    expect(scanWhere({})).toEqual({
      where: ["outcome = 'accepted'", 'voided_at is null', 'not ($1 = any(flags))'],
      params: ['demo'],
    })
    expect(scanWhere()).toEqual(scanWhere({})) // the query may be left out
  })

  it('numbers the placeholders in the order of the filters, and writes ids in lower case', () => {
    expect(scanWhere(EVERYTHING)).toEqual({
      where: [
        'local_date >= $1::date',
        'checked_in_at <= $2::timestamptz',
        'point_id = $3',
        'provider_id = $4',
        'service_type = $5',
        '$6 = any(flags)',
        "outcome <> 'accepted'",
      ],
      params: ['2026-03-01', '2026-03-31T10:00:00.000Z', P, V, 'cleaning', 'demo'],
    })
  })

  it('compares a whole day by its date and a moment by the time, on both ends', () => {
    expect(scanWhere({ from: '2026-03-01T10:00:00+02:00', to: '2026-03-02' })).toEqual({
      where: [
        'checked_in_at >= $1::timestamptz',
        'local_date <= $2::date',
        "outcome = 'accepted'",
        'voided_at is null',
        'not ($3 = any(flags))',
      ],
      params: ['2026-03-01T08:00:00.000Z', '2026-03-02', 'demo'],
    })
  })

  it('cuts the two text filters to FILTER_TEXT_MAX_LENGTH characters', () => {
    const { params } = scanWhere({ service_type: 'x'.repeat(FILTER_TEXT_MAX_LENGTH + 40), flag: 'y'.repeat(FILTER_TEXT_MAX_LENGTH + 40) })
    expect(params.slice(0, 2)).toEqual(['x'.repeat(FILTER_TEXT_MAX_LENGTH), 'y'.repeat(FILTER_TEXT_MAX_LENGTH)])
  })

  it('shows the voided scans and the demo account only for true or 1 (the booleans of the scans list)', () => {
    const conditions = (q) => scanWhere(q).where
    for (const yes of [true, 'true', '1']) {
      expect(conditions({ include_voided: yes }), String(yes)).not.toContain('voided_at is null')
      expect(scanWhere({ include_demo: yes }).params, String(yes)).toEqual([])
    }
    for (const no of [false, 'false', '0', 'yes', '', undefined]) {
      expect(conditions({ include_voided: no }), String(no)).toContain('voided_at is null')
      expect(scanWhere({ include_demo: no }).params, String(no)).toEqual(['demo'])
    }
  })

  it.each([
    ['from', { from: 'zzz' }],
    ['from', { from: '2026-06-01T10:00:00' }], // a time with no zone
    ['to', { to: '2026-02-30' }],
    ['point_id', { point_id: 'zzz' }],
    ['provider_id', { provider_id: 'zzz' }],
    ['outcome', { outcome: 'zzz' }],
  ])('refuses a bad %s with a 400 invalid_filter that names it, as listScans does', async (field, q) => {
    const expected = { status: 400, code: 'invalid_filter', extra: { field } }
    expect(() => scanWhere(q)).toThrow(expect.objectContaining(expected))
    await expect(listScans(q)).rejects.toMatchObject(expected)
  })

  it('judges the filters in the order they are listed: the first bad one is the one that is named', () => {
    expect(() => scanWhere({ outcome: 'zzz', from: 'zzz', point_id: 'zzz' })).toThrow(expect.objectContaining({ extra: { field: 'from' } }))
    expect(() => scanWhere({ outcome: 'zzz', point_id: 'zzz' })).toThrow(expect.objectContaining({ extra: { field: 'point_id' } }))
  })
})

describe('listScans: filters with scanWhere, then pages', () => {
  it('runs the conditions of scanWhere with its parameters first, and adds the cursor after them', async () => {
    const statements = recordingPool()
    const cursor = Buffer.from(JSON.stringify({ t: '2026-04-01T06:00:00.000Z', id: randomUUID() })).toString('base64url')
    const { id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const { where, params } = scanWhere(EVERYTHING)
    await listScans({ ...EVERYTHING, order: 'asc', limit: '7', cursor })
    expect(statements).toHaveLength(1)
    expect(statements[0].params).toEqual([...params, '2026-04-01T06:00:00.000Z', id])
    const sql = statements[0].sql.replace(/\s+/g, ' ')
    expect(sql).toBe(
      `select * from scans where ${where.join(' and ')} and (checked_in_at, id) > ($${params.length + 1}::timestamptz, $${params.length + 2}::uuid) ` +
        'order by checked_in_at asc, id asc limit 8',
    )
  })

  it('refuses a bad order or limit after the filters, and before any statement is run', async () => {
    const statements = recordingPool()
    await expect(listScans({ order: 'zzz' })).rejects.toMatchObject({ code: 'invalid_filter', extra: { field: 'order' } })
    await expect(listScans({ limit: '0' })).rejects.toMatchObject({ code: 'invalid_filter', extra: { field: 'limit' } })
    await expect(listScans({ outcome: 'zzz', order: 'zzz' })).rejects.toMatchObject({ extra: { field: 'outcome' } })
    await expect(listScans({ cursor: 'zzz' })).rejects.toMatchObject({ code: 'invalid_cursor' })
    expect(statements).toEqual([])
  })
})

describe('REFUSAL_FILTERS', () => {
  it('lists exactly what listRefusals reads from its query', async () => {
    recordingPool()
    const { q, reads } = watched({
      from: '2026-01-01', to: '2100-01-01', point_id: randomUUID(), provider_id: randomUUID(), limit: '5',
      cursor: Buffer.from(JSON.stringify({ t: '2026-05-01T08:00:00.000Z', id: 5 })).toString('base64url'),
    })
    await listRefusals(q)
    expect([...reads].sort()).toEqual([...REFUSAL_FILTERS].sort())
    expect([...REFUSAL_FILTERS]).toEqual(['from', 'to', 'point_id', 'provider_id', 'limit', 'cursor'])
    expect(Object.isFrozen(REFUSAL_FILTERS)).toBe(true)
  })

  it("lists exactly what listAgentRefusals reads from its query, and the agent's statement is the committee's with named columns", async () => {
    const everything = {
      from: '2026-01-01', to: '2100-01-01T10:00:00Z', point_id: randomUUID().toUpperCase(), provider_id: randomUUID(), limit: '5',
      cursor: Buffer.from(JSON.stringify({ t: '2026-05-01T08:00:00.000Z', id: 5 })).toString('base64url'),
    }
    const statements = recordingPool()
    const { q, reads } = watched({ ...everything })
    await listAgentRefusals(q)
    expect([...reads].sort()).toEqual([...REFUSAL_FILTERS].sort())
    await listRefusals({ ...everything })
    expect(statements).toHaveLength(2)
    const [agent, committee] = statements
    expect(agent.params).toEqual(committee.params) // the same values for the same filters
    const text = (statement) => statement.sql.replace(/\s+/g, ' ')
    expect(text(agent)).toBe(text(committee).replace('select * from', `select ${AGENT_REFUSAL_COLUMNS.join(', ')} from`)) // the same conditions, order and page
    expect(text(agent)).not.toContain('*')
  })

  it('refuses a bad value with the same code and field in both lists, before any statement is run', async () => {
    const statements = recordingPool()
    for (const q of [{ from: 'zzz' }, { to: '2026-02-30' }, { point_id: 'x' }, { provider_id: 'x' }, { limit: '0' }, { limit: 'abc' }, { cursor: 'garbage' }]) {
      await expect(listAgentRefusals(q), JSON.stringify(q)).rejects.toMatchObject({ status: 400, code: expect.stringMatching(/^invalid_(filter|cursor)$/) })
      await expect(listAgentRefusals(q), JSON.stringify(q)).rejects.toEqual(await listRefusals(q).catch((err) => err))
    }
    expect(statements).toEqual([])
  })
})

describe('PHONE_HEALTH_LATERAL', () => {
  it('is the lateral join that gives a provider its phone-health columns, with $1 as the server build', () => {
    expect(PHONE_HEALTH_LATERAL).toMatch(/^cross join lateral \(/)
    expect(PHONE_HEALTH_LATERAL).toMatch(/\) phones$/)
    // The committee's providers list selects the first three, the agent's providers all seven (tests/agent-phones-building-voids.test.js).
    for (const column of ['waiting', 'oldest_waiting_at', 'outdated_devices', 'active_devices', 'last_sync_at', 'not_accepted_total', 'overflow_total']) {
      expect(PHONE_HEALTH_LATERAL, column).toMatch(new RegExp(`\\bas ${column}\\b`))
    }
    expect(PHONE_HEALTH_LATERAL).toContain('d.app_build <> $1::text')
    expect(PHONE_HEALTH_LATERAL).toContain('d.provider_id = p.id and d.revoked_at is null') // the active phones of the provider `p`
    expect(PHONE_HEALTH_LATERAL).not.toMatch(/\$[2-9]/) // the build is its only parameter: the caller's own values start at $2
  })

  it('reads no column that identifies or describes one phone: no label, no token hash, no id, and no row per phone (it is one aggregate)', () => {
    const sql = PHONE_HEALTH_LATERAL.replace(/\s+/g, ' ')
    for (const column of ['label', 'token_hash', 'd.id', 'user_agent']) expect(sql, column).not.toContain(column)
    expect(sql).not.toMatch(/\bgroup by\b/) // an aggregate over all the phones of the provider: exactly one row for each provider
  })
})

describe('looksSecret (shared/secretLike.js)', () => {
  it('knows a key, a hash, a token and an id, and lets names and plain words through', () => {
    for (const yes of ['qrk_abcdef123456', 'qra_ABCDEFGHIJ', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', '3f2a9c1e-7b4d-4e8a-9c3f-1a2b3c4d5e6f', 'eyJhbGciOiJIUzI1NiJ9.abc123DEF456ghi789', '  qrk_abcdef123456  ']) {
      expect(looksSecret(yes), yes).toBe(true)
    }
    for (const no of ['Lobby 2', 'dana@example.test', 'point_name', 'Parking', 'ab_cd', '', '   ', null, 12, undefined, {}]) {
      expect(looksSecret(no), String(no)).toBe(false)
    }
  })
})
