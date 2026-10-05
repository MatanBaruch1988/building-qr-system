// The committee reads the audit log: GET /api/admin/audit (server/routes/audit.js, ADR 0007 decision 4). Read only.
//   - order and paging: newest first, ties on the time broken by the row's number, a cursor on (at, id) that walks every
//     row exactly once (also rows that differ only in the microseconds that the database keeps);
//   - the filters: from and to (building days, in the building's time zone, on the borders and across a daylight-saving
//     change), group (an exact list), actor_id, entity with entity_id;
//   - bad parameters are 400 with the codes of the scans list (compared with it, not copied from it);
//   - the name of the actor: the snapshot on the row, else the member's current name, a deleted member, the system actor;
//   - privacy: an entry has the listed fields and nothing else, the detail is as stored, and the agent API has no audit;
//   - the SQL can use the two indexes of migration 007 (asked of the database with explain).
// Who may call it is proved for every route at once by tests/route-auth.test.js (the router's guard of /admin/). The data is fake.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import '../server/index.js' // importing it registers every route file with the router
import { routeTable } from '../server/router.js'
import { providerSnapshotName } from '../server/scans.js'
import { tx } from '../server/db.js'
import { auditQuery, AUDIT_GROUPS, AUDIT_FILTERS } from '../server/routes/audit.js'
import { schemaDoc } from '../server/schemaDoc.js'
import { API_KEY_PREFIX, DEFAULT_PAGE_SIZE, MAX_AUDIT_PAGE_SIZE } from '../server/config.js'

let db, cookie, adminId, secondId, noNameId, goneId
const ids = {} // the ids of the things that the real actions are about (a point, a provider), and of the live ones
const idOf = {} // label -> the row's number, as the API writes it (text)
const labelOf = {} // the other way round

const get = (qs = '', asCookie = cookie) => call('GET', `/api/admin/audit${qs ? `?${qs}` : ''}`, { cookie: asCookie })
const labels = (entries) => entries.map((e) => labelOf[e.id])
const ids_ = (entries) => entries.map((e) => String(e.id)) // the ids as text, to compare with what the database says

/** Walks every page of a listing with the cursor, and says how many pages it took. */
async function walk(qs, limit) {
  const entries = []
  const sizes = []
  let cursor = ''
  for (let i = 0; i < 200; i++) {
    const r = await get(`${qs ? `${qs}&` : ''}limit=${limit}${cursor}`)
    expect(r.status, r.text).toBe(200)
    entries.push(...r.json.entries)
    sizes.push(r.json.entries.length)
    if (!r.json.next_cursor) return { entries, sizes }
    cursor = `&cursor=${r.json.next_cursor}`
  }
  throw new Error('the cursor never ended')
}

/** Adds rows with plain inserts, in this order (so the numbers rise in this order), and remembers their labels. */
async function addRows(rows) {
  const { rows: inserted } = await db.pool.query(
    `insert into audit_log (at, actor_type, actor_id, actor_name, action, entity, entity_id, detail)
     select (e->>'at')::timestamptz, e->>'actor_type', e->>'actor_id', e->>'actor_name', e->>'action', e->>'entity',
            e->>'entity_id', e->'detail'
       from jsonb_array_elements($1::jsonb) with ordinality as t(e, n)
      order by n
     returning id::text`,
    [JSON.stringify(rows)], // the label is an extra key of each element, which the statement does not read
  )
  rows.forEach((row, i) => {
    idOf[row.label] = inserted[i].id
    labelOf[inserted[i].id] = row.label
  })
}

// Every request is a few round trips to the database (the guard, the page), so a test that walks pages gets time.
const SLOW = 120_000

const minutes = (start, n) => new Date(Date.parse(start) + n * 60_000).toISOString()

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool) // admin@test.local, called "Test Admin"
  cookie = await adminCookie()
  const member = async (email, name) =>
    (await db.pool.query('insert into admins (email, name) values ($1, $2) returning id', [email, name])).rows[0].id
  adminId = (await db.pool.query("select id from admins where email = 'admin@test.local'")).rows[0].id
  secondId = await member('second@test.local', 'Second Member')
  noNameId = await member('noname@test.local', '')
  goneId = await member('gone@test.local', 'Gone Member')

  const second = { actor_type: 'admin', actor_id: secondId, actor_name: 'Second Member' }

  // 1) Six rows with the same time: only the row's number tells them apart.
  const tie = [1, 2, 3, 4, 5, 6].map((n) => ({
    label: `tie-${n}`, ...second, at: '2026-03-10T10:00:00Z', action: 'test.order', entity: 'order', entity_id: `tie-${n}`, detail: { n },
  }))
  // 2) Rows that differ only after the third decimal: a JavaScript Date cannot tell them apart, the database can. They are
  //    inserted out of order on purpose, and two of them have the very same time.
  const micro = [
    ['500a', '.123500'], ['401', '.123401'], ['600', '.123600'], ['402', '.123402'], ['499', '.123499'], ['500b', '.123500'],
  ].map(([n, fraction]) => ({
    label: `micro-${n}`, ...second, at: `2026-03-10T09:00:00${fraction}Z`, action: 'test.micro', entity: 'micro', entity_id: `micro-${n}`, detail: null,
  }))
  // 3) The borders of a building day (Asia/Jerusalem): UTC+2 in winter, UTC+3 in summer, and the two days of the year with
  //    another length. The label is what the row's local time is (written by hand, not worked out here).
  const border = [
    ['m', '2026-03-26T21:59:59Z'], // 26/03 23:59:59 (UTC+2)
    ['n', '2026-03-26T22:00:00Z'], // 27/03 00:00:00: the first moment of the 23-hour day the clocks go forward
    ['o', '2026-03-27T20:59:59Z'], // 27/03 23:59:59 (UTC+3)
    ['p', '2026-03-27T21:00:00Z'], // 28/03 00:00:00
    ['a', '2026-10-04T20:59:59.999Z'], // 04/10 23:59:59.999 (UTC+3); still 04/10 in UTC
    ['b', '2026-10-04T21:00:00Z'], // 05/10 00:00:00; the UTC day is still 04/10
    ['c', '2026-10-05T20:59:59.999999Z'], // 05/10 23:59:59.999999
    ['d', '2026-10-05T21:00:00Z'], // 06/10 00:00:00
    ['i', '2026-10-24T20:59:59Z'], // 24/10 23:59:59 (UTC+3)
    ['j', '2026-10-24T21:00:00Z'], // 25/10 00:00:00: the first moment of the 25-hour day the clocks go back
    ['x', '2026-10-24T23:30:00Z'], // 25/10 01:30 (the hour that is repeated)
    ['k', '2026-10-25T21:59:59Z'], // 25/10 23:59:59 (UTC+2): the last moment of that day
    ['l', '2026-10-25T22:00:00Z'], // 26/10 00:00:00
    ['e', '2026-12-09T21:59:59Z'], // 09/12 23:59:59 (UTC+2)
    ['f', '2026-12-09T22:00:00Z'], // 10/12 00:00:00
    ['g', '2026-12-10T21:59:59Z'], // 10/12 23:59:59
    ['h', '2026-12-10T22:00:00Z'], // 11/12 00:00:00
  ].map(([n, at]) => ({
    label: `border-${n}`, ...second, at, action: 'test.border', entity: 'border', entity_id: n, detail: null,
  }))

  // 4) One row for every action that the committee app writes today, with the details that the code writes. One minute apart.
  const P1 = randomUUID(), P2 = randomUUID(), V1 = randomUUID(), S1 = randomUUID(), K1 = randomUUID(), A1 = randomUUID()
  const real = [
    ['admin.add', 'admin', A1, { email: 'new@test.local' }],
    ['admin.enable', 'admin', A1, null],
    ['admin.disable', 'admin', A1, null],
    ['admin.delete', 'admin', A1, { email: 'new@test.local', name: 'New Member' }],
    ['building.update', 'building', null, { address: 'Fake street 1' }],
    ['point.create', 'point', P1, { name: 'Fake lobby', gps_mode: 'optional', lat: 31.5, lng: 34.8 }],
    ['point.update', 'point', P1, { name: 'Fake lobby 2', provider_ids: [V1] }, 'point.update P1'],
    ['point.regenerate_qr', 'point', P1, null],
    ['point.update', 'point', P2, { is_active: false }, 'point.update P2'],
    ['point.delete', 'point', P2, { name: 'Fake roof', scans_kept: 2 }],
    ['provider.create', 'provider', V1, { company: 'Fake Cleaning Ltd' }],
    ['provider.update', 'provider', V1, { contact_name: 'Fake Person', password_changed: true }],
    ['provider.revoke_devices', 'provider', V1, { devices: 1 }],
    ['provider.delete', 'provider', V1, { company: 'Fake Cleaning Ltd', contact_name: 'Fake Person', scans_kept: 3 }],
    ['scan.void', 'scan', S1, { reason: 'a fake reason' }],
    ['scan.unvoid', 'scan', S1, { reason: null }],
    ['scan.delete', 'scan', S1, { point_name: 'Fake lobby', provider_name: 'Fake Cleaning Ltd', checked_in_at: '2026-04-30T07:00:00.000Z', outcome: 'accepted', voided: false }],
    ['api_key.create', 'api_key', K1, { name: 'Fake agent' }],
    ['api_key.revoke', 'api_key', K1, null],
    ['api_key.delete', 'api_key', K1, { name: 'Fake agent', key_prefix: `${API_KEY_PREFIX}abcd`, was_revoked: true }],
  ].map(([action, entity, entity_id, detail, label], i) => ({
    label: label ?? action, ...second, at: minutes('2026-05-01T08:00:00Z', i), action, entity, entity_id, detail,
  }))
  ids.P1 = P1
  ids.P2 = P2
  ids.V1 = V1
  const retention = {
    label: 'retention.run', at: minutes('2026-05-01T08:00:00Z', 20), actor_type: 'system', actor_id: null, actor_name: null,
    action: 'retention.run', entity: null, entity_id: null, detail: { sessions: 0, login_attempts: 3, device_labels: 0 },
  }
  // A name that a `like 'api_key.%'` would match because `_` is a wildcard there. It is in no group.
  const trap = { label: 'trap', ...second, at: minutes('2026-05-01T08:00:00Z', 21), action: 'apiXkey.create', entity: 'api_key', entity_id: randomUUID(), detail: null }

  // 5) The names: the snapshot, an older row without one, a member with no name, a deleted member, a text that is no id.
  const actor = (label, extra) => ({
    label, actor_type: 'admin', action: 'test.actor', entity: 'actor', entity_id: label, detail: null, ...extra,
  })
  const named = [
    actor('actor-snapshot', { actor_id: adminId, actor_name: 'Snapshot Name' }),
    actor('actor-old-row', { actor_id: adminId, actor_name: null }),
    actor('actor-no-name', { actor_id: noNameId, actor_name: null }),
    actor('actor-gone', { actor_id: goneId, actor_name: 'Gone Member' }),
    actor('actor-gone-old', { actor_id: goneId, actor_name: null }),
    actor('actor-not-an-id', { actor_id: 'fake-actor', actor_name: 'Fake Name' }),
    actor('actor-system', { actor_type: 'system', actor_id: null, actor_name: null }),
    // The third actor type that server/audit.js allows: a command run on the owner's machine. It is not looked up in `admins`.
    actor('actor-script', { actor_type: 'script', actor_id: 'a-script', actor_name: null }),
    // A system row never takes the name of an admin, even when its actor_id happens to be an admin's.
    actor('actor-system-with-id', { actor_type: 'system', actor_id: adminId, actor_name: null }),
  ]

  // 6) What an entry is about: things that exist now (with a name that is not the one in any detail), things that are gone,
  //    and entities that have no name here. The rows of the other datasets are about ids that exist nowhere.
  const live = { point: randomUUID(), provider: randomUUID(), providerAlone: randomUUID(), key: randomUUID() }
  Object.assign(ids, { live })
  await db.pool.query("insert into points (id, name, qr_token) values ($1, 'Current lobby', 'fake-qr-live')", [live.point])
  await db.pool.query("insert into providers (id, company, contact_name) values ($1, 'Fake Cleaning Ltd', 'Fake Person')", [live.provider])
  await db.pool.query("insert into providers (id, company, contact_name) values ($1, 'Fake Gardens Ltd', '')", [live.providerAlone])
  await db.pool.query("insert into api_keys (id, name, key_prefix, key_hash) values ($1, 'Current agent', 'fake', 'fake-hash-live')", [live.key])
  const about = (label, entity, entity_id) => ({
    label, ...second, at: minutes('2026-07-01T08:00:00Z', 0), action: 'test.name', entity, entity_id, detail: { old_name: 'Name in the detail' },
  })
  const names = [
    about('name-point-live', 'point', live.point),
    about('name-point-gone', 'point', randomUUID()),
    about('name-point-not-an-id', 'point', 'not-a-uuid'),
    about('name-provider-live', 'provider', live.provider),
    about('name-provider-no-contact', 'provider', live.providerAlone),
    about('name-provider-gone', 'provider', randomUUID()),
    about('name-admin-named', 'admin', secondId),
    about('name-admin-no-name', 'admin', noNameId),
    about('name-admin-gone', 'admin', goneId),
    about('name-key-live', 'api_key', live.key),
    about('name-key-gone', 'api_key', randomUUID()),
    // No name here, even when the id is the id of a live point, a live provider or a live member.
    about('name-scan', 'scan', live.point),
    about('name-widget', 'widget', live.provider),
    about('name-building', 'building', null),
    about('name-no-entity', null, null),
    about('name-wrong-entity', 'provider', live.point), // a point's id under the entity provider: no provider has it
  ]

  await addRows([...tie, ...micro, ...border, ...real, retention, trap])
  await addRows(names.map((row, i) => ({ ...row, at: minutes('2026-07-01T08:00:00Z', i) })))
  await addRows(named.map((row, i) => ({ ...row, at: minutes('2026-06-01T08:00:00Z', i) })))
  await db.pool.query('delete from admins where id = $1', [goneId]) // after its rows were written
})
afterAll(async () => db?.teardown())

describe('order and paging', () => {
  it('answers { entries, next_cursor }, newest first, and breaks a tie on the time by the row number', async () => {
    const r = await get('entity=order&limit=100')
    expect(r.status).toBe(200)
    expect(Object.keys(r.json).sort()).toEqual(['entries', 'next_cursor'])
    expect(r.json.next_cursor).toBeNull()
    expect(labels(r.json.entries)).toEqual(['tie-6', 'tie-5', 'tie-4', 'tie-3', 'tie-2', 'tie-1'])
    // Newest first in general, and `at` is ISO.
    const all = (await get('limit=500')).json.entries
    for (const e of all) expect(e.at).toBe(new Date(e.at).toISOString())
    for (let i = 1; i < all.length; i++) expect(Date.parse(all[i - 1].at)).toBeGreaterThanOrEqual(Date.parse(all[i].at))
  })

  it('walks the rows that tie on the time exactly once with a small page, and the last page has no cursor', async () => {
    const { entries, sizes } = await walk('entity=order', 2)
    expect(labels(entries)).toEqual(['tie-6', 'tie-5', 'tie-4', 'tie-3', 'tie-2', 'tie-1'])
    expect(sizes).toEqual([2, 2, 2]) // 6 rows in pages of 2: the third page is the last, and it says so
    const odd = await walk('entity=order', 4)
    expect(odd.sizes).toEqual([4, 2])
    expect(labels(odd.entries)).toEqual(['tie-6', 'tie-5', 'tie-4', 'tie-3', 'tie-2', 'tie-1'])
  }, SLOW)

  it('keeps the microseconds in the cursor: rows within one millisecond are neither skipped nor repeated', async () => {
    // Newest first by the stored time (.123600, .123500 twice, .123499, .123402, .123401), the two equal ones by number.
    const expected = ['micro-600', 'micro-500b', 'micro-500a', 'micro-499', 'micro-402', 'micro-401']
    for (const limit of [1, 2, 3, 4, 5, 6]) {
      const { entries } = await walk('entity=micro', limit)
      expect(labels(entries), `limit ${limit}`).toEqual(expected)
    }
  }, SLOW)

  it('walks every row of the log exactly once, in the order of at desc, id desc, whatever the page size', async () => {
    // `id::text as id_text`, not `id::text`: an output column that is called `id` would be what `order by id` sorts by, as text.
    const { rows } = await db.pool.query('select id::text as id_text from audit_log order by at desc, id desc')
    const expected = rows.map((r) => r.id_text)
    expect(expected.length).toBeGreaterThan(50)
    for (const limit of [8, 25, expected.length - 1, expected.length, expected.length + 1]) {
      const { entries } = await walk('', limit)
      expect(ids_(entries), `limit ${limit}`).toEqual(expected)
    }
  }, SLOW)

  it('combines a cursor with a filter', async () => {
    const first = await get('entity=border&limit=5')
    expect(labels(first.json.entries)).toEqual(['border-h', 'border-g', 'border-f', 'border-e', 'border-l'])
    const second = await get(`entity=border&limit=5&cursor=${first.json.next_cursor}`)
    expect(labels(second.json.entries)).toEqual(['border-k', 'border-x', 'border-j', 'border-i', 'border-d'])
    const { entries } = await walk('entity=border&from=2026-10-01&to=2026-10-31', 4)
    expect(labels(entries)).toEqual(['border-l', 'border-k', 'border-x', 'border-j', 'border-i', 'border-d', 'border-c', 'border-b', 'border-a'])
  }, SLOW)

  it('uses the default page size and cuts a larger one to the maximum, the way the scans list does', async () => {
    expect(DEFAULT_PAGE_SIZE).toBe(100)
    expect(MAX_AUDIT_PAGE_SIZE).toBe(200) // the same page as the list of refused visits
    expect(auditQuery({}).limit).toBe(DEFAULT_PAGE_SIZE)
    expect(auditQuery({ limit: '' }).limit).toBe(DEFAULT_PAGE_SIZE)
    expect(auditQuery({ limit: '3' }).limit).toBe(3)
    expect(auditQuery({ limit: String(MAX_AUDIT_PAGE_SIZE) }).limit).toBe(MAX_AUDIT_PAGE_SIZE)
    expect(auditQuery({ limit: String(MAX_AUDIT_PAGE_SIZE + 1) }).limit).toBe(MAX_AUDIT_PAGE_SIZE) // cut, not refused
    expect(auditQuery({ limit: '1000000' }).limit).toBe(MAX_AUDIT_PAGE_SIZE)
    expect(auditQuery({ limit: '2' }).sql).toMatch(/limit 3\b/) // one more than the page, to know there is a next one
    for (const limit of [MAX_AUDIT_PAGE_SIZE + 1, 1_000_000]) {
      const r = await get(`limit=${limit}`)
      expect(r.status).toBe(200)
      expect(r.json.entries.length).toBeLessThanOrEqual(MAX_AUDIT_PAGE_SIZE)
    }
  })
})

describe('the filters', () => {
  // [from, to, what is inside, in the order of the answer]: the days are the building's days (Asia/Jerusalem).
  const days = [
    ['2026-10-05', '2026-10-05', ['c', 'b']], // 05/10: from 21:00 UTC the day before to 20:59:59.999999 UTC
    ['2026-10-04', '2026-10-04', ['a']],
    ['2026-10-06', '2026-10-06', ['d']],
    ['2026-12-10', '2026-12-10', ['g', 'f']], // winter, UTC+2: from 22:00 UTC the day before
    ['2026-12-09', '2026-12-09', ['e']],
    ['2026-12-11', '2026-12-11', ['h']],
    ['2026-03-27', '2026-03-27', ['o', 'n']], // the 23-hour day: the clocks go forward at 02:00
    ['2026-03-26', '2026-03-26', ['m']],
    ['2026-03-28', '2026-03-28', ['p']],
    ['2026-10-25', '2026-10-25', ['k', 'x', 'j']], // the 25-hour day: the clocks go back at 02:00
    ['2026-10-24', '2026-10-24', ['i']],
    ['2026-10-26', '2026-10-26', ['l']],
    ['2026-03-27', '2026-03-28', ['p', 'o', 'n']], // a range of days
    ['2026-10-05', '2026-10-06', ['d', 'c', 'b']],
  ]

  it.each(days)('from=%s to=%s keeps the rows of those building days, on the exact borders', async (from, to, inside) => {
    const r = await get(`entity=border&from=${from}&to=${to}`)
    expect(r.status, r.text).toBe(200)
    expect(labels(r.json.entries)).toEqual(inside.map((n) => `border-${n}`))
  })

  it('reads from alone as "that day and later", and to alone as "that day and earlier"', async () => {
    const from = await get('entity=border&from=2026-12-10')
    expect(labels(from.json.entries)).toEqual(['border-h', 'border-g', 'border-f'])
    const to = await get('entity=border&to=2026-03-27')
    expect(labels(to.json.entries)).toEqual(['border-o', 'border-n', 'border-m'])
    // from after to is a valid question with an empty answer, as in the scans list.
    const none = await get('entity=border&from=2026-12-11&to=2026-12-10')
    expect(none.json.entries).toEqual([])
  })

  it('takes the building day, not the UTC day', async () => {
    // 05/10 00:00 in the building is 04/10 21:00 in UTC: the row is of 05/10.
    const r = await get('entity=border&from=2026-10-05&to=2026-10-05')
    expect(r.json.entries.map((e) => e.at)).toContain('2026-10-04T21:00:00.000Z')
    expect(r.json.entries.map((e) => e.at)).not.toContain('2026-10-04T20:59:59.999Z')
  })

  it('also takes an ISO time with a zone, as the scans list does', async () => {
    const r = await get('entity=border&from=2026-10-04T21:00:00Z&to=2026-10-04T21:00:00Z')
    expect(labels(r.json.entries)).toEqual(['border-b'])
    const offset = await get('entity=border&from=2026-10-05T00:00:00%2B03:00&to=2026-10-05T00:00:00%2B03:00')
    expect(labels(offset.json.entries)).toEqual(['border-b'])
  })

  it('filters by group: the part of the action before the dot, an exact list', async () => {
    expect(AUDIT_GROUPS).toEqual(['admin', 'building', 'point', 'provider', 'scan', 'api_key', 'retention', 'session'])
    const only = async (group) => labels((await get(`group=${group}`)).json.entries).reverse()
    expect(await only('admin')).toEqual(['admin.add', 'admin.enable', 'admin.disable', 'admin.delete'])
    expect(await only('building')).toEqual(['building.update'])
    expect(await only('point')).toEqual(['point.create', 'point.update P1', 'point.regenerate_qr', 'point.update P2', 'point.delete'])
    expect(await only('provider')).toEqual(['provider.create', 'provider.update', 'provider.revoke_devices', 'provider.delete'])
    expect(await only('scan')).toEqual(['scan.void', 'scan.unvoid', 'scan.delete'])
    // `_` is not a wildcard: the row 'apiXkey.create' is not in api_key.
    expect(await only('api_key')).toEqual(['api_key.create', 'api_key.revoke', 'api_key.delete'])
    expect(await only('retention')).toEqual(['retention.run'])
    // Reserved for the sign-in rows that a later change writes: accepted, and nothing today.
    const session = await get('group=session')
    expect(session.status).toBe(200)
    expect(session.json).toEqual({ entries: [], next_cursor: null })
  })

  it('has a group for every action that the code writes today', () => {
    const written = [
      'admin.add', 'admin.enable', 'admin.disable', 'admin.delete', 'building.update', 'point.create', 'point.update',
      'point.delete', 'point.regenerate_qr', 'provider.create', 'provider.update', 'provider.delete', 'provider.revoke_devices',
      'scan.void', 'scan.unvoid', 'scan.delete', 'api_key.create', 'api_key.revoke', 'api_key.delete', 'retention.run',
    ]
    for (const action of written) expect(AUDIT_GROUPS, action).toContain(action.split('.')[0])
  })

  it('never puts the text of a group into the SQL: it is a parameter, and only from the list', () => {
    const { sql, params } = auditQuery({ group: 'point' })
    // The text of the statement is the same for every group: the group is only in the parameter.
    for (const group of AUDIT_GROUPS) expect(auditQuery({ group }).sql, group).toBe(sql)
    expect(sql).toContain('starts_with(action, $1)')
    expect(params).toEqual(['point.'])
    expect(auditQuery({ group: 'api_key' }).params).toEqual(['api_key.'])
    expect(() => auditQuery({ group: "point' or '1'='1" })).toThrow(/group must be one of/)
  })

  it('filters by the committee member (actor_id), in any letter case', async () => {
    const mine = await get(`actor_id=${adminId}`)
    expect(labels(mine.json.entries)).toEqual(['actor-system-with-id', 'actor-old-row', 'actor-snapshot'])
    const upper = await get(`actor_id=${adminId.toUpperCase()}`)
    expect(labels(upper.json.entries)).toEqual(labels(mine.json.entries))
    const nobody = await get(`actor_id=${randomUUID()}`)
    expect(nobody.json.entries).toEqual([])
  })

  it('filters by entity and entity_id: the history of one point or one provider, newest first', async () => {
    const point = await get(`entity=point&entity_id=${ids.P1}`)
    expect(labels(point.json.entries)).toEqual(['point.regenerate_qr', 'point.update P1', 'point.create'])
    const other = await get(`entity=point&entity_id=${ids.P2}`)
    expect(labels(other.json.entries)).toEqual(['point.delete', 'point.update P2'])
    const provider = await get(`entity=provider&entity_id=${ids.V1}`)
    expect(labels(provider.json.entries)).toEqual(['provider.delete', 'provider.revoke_devices', 'provider.update', 'provider.create'])
    // entity alone is every row about points; entity_id alone is every row about that id.
    expect(labels((await get('group=point&entity=point')).json.entries)).toHaveLength(5)
    expect(labels((await get(`entity_id=${ids.P1}`)).json.entries)).toEqual(labels(point.json.entries))
    // The entity of the building row, and an entity that has no rows.
    expect(labels((await get('group=building&entity=building')).json.entries)).toEqual(['building.update'])
    expect((await get('entity=nothing')).json.entries).toEqual([])
  })

  it('combines every filter (they all have to hold) and ignores empty ones and parameters it does not know', async () => {
    const r = await get(`group=point&entity=point&entity_id=${ids.P1}&actor_id=${secondId}&from=2026-05-01&to=2026-05-01&limit=10`)
    expect(labels(r.json.entries)).toEqual(['point.regenerate_qr', 'point.update P1', 'point.create'])
    const wrongDay = await get(`group=point&entity_id=${ids.P1}&from=2026-05-02`)
    expect(wrongDay.json.entries).toEqual([])
    const wrongGroup = await get(`group=scan&entity_id=${ids.P1}`)
    expect(wrongGroup.json.entries).toEqual([])
    const empty = await get('group=&from=&to=&actor_id=&entity=&entity_id=&limit=&cursor=&unknown=1&format=csv')
    expect(empty.status).toBe(200)
    expect(empty.json.entries.length).toBeGreaterThan(50)
  })

  it('reads exactly the filters that AUDIT_FILTERS lists', () => {
    const reads = new Set()
    const base = {
      from: '2026-01-01', to: '2100-01-01', group: 'point', actor_id: randomUUID(), entity: 'point', entity_id: randomUUID(), limit: '5',
      cursor: Buffer.from(JSON.stringify({ t: '2026-05-01T08:00:00.000000Z', id: '5' })).toString('base64url'),
    }
    const q = new Proxy(base, { get: (target, prop) => (typeof prop === 'string' ? (reads.add(prop), target[prop]) : target[prop]) })
    auditQuery(q)
    expect([...reads].sort()).toEqual([...AUDIT_FILTERS].sort())
  })
})

describe('bad parameters are 400, with the codes of the scans list', () => {
  const asCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const goodTime = '2026-05-01T08:00:00.000000Z'

  // [what is wrong, query, the code, the field, and true when the scans list refuses the same query in the same way]
  const refused = [
    ['a day that does not exist', 'from=2026-02-30', 'invalid_filter', 'from'],
    ['a month that does not exist', 'to=2026-13-01', 'invalid_filter', 'to'],
    ['a word', 'from=yesterday', 'invalid_filter', 'from'],
    ['an ISO time without a zone', 'from=2026-06-01T10:00:00', 'invalid_filter', 'from'],
    ['an ISO time before 2000', 'to=1999-01-01T00:00:00Z', 'invalid_filter', 'to'],
    // Both lists let it through to the database, which has no year 0 (SQLSTATE 22008, a 400 `invalid_input` from the router).
    ['a day of the year 0', 'from=0000-01-01', 'invalid_input'],
    ['a group that is not in the list', 'group=nope', 'invalid_filter', 'group'],
    ['a group in capitals', 'group=POINT', 'invalid_filter', 'group'],
    ['a whole action as the group', 'group=point.update', 'invalid_filter', 'group'],
    ['an actor that is not an id', 'actor_id=abc', 'invalid_filter', 'actor_id'],
    ['a limit of zero', 'limit=0', 'invalid_filter', 'limit'],
    ['a negative limit', 'limit=-3', 'invalid_filter', 'limit'],
    ['a limit with a fraction', 'limit=1.5', 'invalid_filter', 'limit'],
    ['a limit that is a word', 'limit=abc', 'invalid_filter', 'limit'],
    ['a cursor that is not ours', 'cursor=zzz', 'invalid_cursor', undefined, true],
    ['a cursor of the scans list (a uuid for an id)', `cursor=${asCursor({ t: '2026-05-01T08:00:00.000Z', id: randomUUID() })}`, 'invalid_cursor'],
    ['a cursor with a time that is a number', `cursor=${asCursor({ t: 12345, id: '1' })}`, 'invalid_cursor', undefined, true],
    ['a cursor with a time that is not a time', `cursor=${asCursor({ t: '2026', id: 'nope' })}`, 'invalid_cursor', undefined, true],
    ['a cursor with no decimals in the time', `cursor=${asCursor({ t: '2026-05-01T08:00:00Z', id: '5' })}`, 'invalid_cursor'],
    ['a cursor with a day that does not exist', `cursor=${asCursor({ t: '2026-02-30T08:00:00.000000Z', id: '5' })}`, 'invalid_cursor'],
    ['a cursor with a month that does not exist', `cursor=${asCursor({ t: '2026-13-01T08:00:00.000000Z', id: '5' })}`, 'invalid_cursor'],
    ['a cursor from before 2000', `cursor=${asCursor({ t: '1999-01-01T00:00:00.000000Z', id: '5' })}`, 'invalid_cursor'],
    ['a cursor with an id of zero', `cursor=${asCursor({ t: goodTime, id: '0' })}`, 'invalid_cursor'],
    ['a cursor with a negative id', `cursor=${asCursor({ t: goodTime, id: '-1' })}`, 'invalid_cursor'],
    ['a cursor with an id that is too large for a bigint', `cursor=${asCursor({ t: goodTime, id: '99999999999999999999' })}`, 'invalid_cursor'],
    ['a cursor with an id that is a number, not text', `cursor=${asCursor({ t: goodTime, id: 5 })}`, 'invalid_cursor'],
    ['a cursor with SQL in the id', `cursor=${asCursor({ t: goodTime, id: "1); drop table audit_log; --" })}`, 'invalid_cursor'],
    ['a cursor that is not JSON', `cursor=${Buffer.from('not json').toString('base64url')}`, 'invalid_cursor', undefined, true],
  ]

  it.each(refused)('%s', async (_what, qs, code, field) => {
    const r = await get(qs)
    expect(r.status, r.text).toBe(400)
    expect(r.json.error.code).toBe(code)
    if (field) expect(r.json.error.field).toBe(field)
  })

  it('answers the shared parameters exactly as the scans list does: the same status, code and field', async () => {
    for (const [what, qs] of refused.filter(([, qs, , , shared]) => shared || /^(from|to|limit)=/.test(qs))) {
      const scans = await call('GET', `/api/admin/scans?${qs}`, { cookie })
      const audit = await get(qs)
      expect(audit.status, what).toBe(scans.status)
      expect(audit.json.error.code, what).toBe(scans.json.error.code)
      expect(audit.json.error.field, what).toBe(scans.json.error.field)
    }
    // And what the scans list accepts, the audit log accepts: a day, an ISO time with a zone, a limit over the maximum.
    for (const qs of ['from=2026-01-01', 'to=2100-01-01', 'from=2026-01-01T00:00:00%2B02:00', `limit=${MAX_AUDIT_PAGE_SIZE + 1}`, 'limit=1']) {
      expect((await call('GET', `/api/admin/scans?${qs}`, { cookie })).status, qs).toBe(200)
      expect((await get(qs)).status, qs).toBe(200)
    }
  }, SLOW)

  it('a cursor that the API gave out is accepted, also with a very large id', async () => {
    const page = await get('limit=1')
    expect((await get(`limit=1&cursor=${page.json.next_cursor}`)).status).toBe(200)
    const big = await get(`cursor=${asCursor({ t: goodTime, id: '999999999999999999' })}`)
    expect(big.status).toBe(200)
  })
})

describe('the name of the actor', () => {
  const byLabel = async (label) => (await get(`entity=actor&entity_id=${label}`)).json.entries[0]

  it('is the snapshot on the row, also when the member has another name now', async () => {
    expect(await byLabel('actor-snapshot')).toMatchObject({ actor_type: 'admin', actor_id: adminId, actor_name: 'Snapshot Name', actor_deleted: false })
  })

  it('is the current name of the member for an older row without a snapshot', async () => {
    expect(await byLabel('actor-old-row')).toMatchObject({ actor_id: adminId, actor_name: 'Test Admin', actor_deleted: false })
  })

  it('is the current e-mail for an older row when the member has no name', async () => {
    expect(await byLabel('actor-no-name')).toMatchObject({ actor_id: noNameId, actor_name: 'noname@test.local', actor_deleted: false })
  })

  it('keeps the snapshot of a deleted member and says that the member is deleted', async () => {
    expect((await db.pool.query('select 1 from admins where id = $1', [goneId])).rows).toEqual([])
    expect(await byLabel('actor-gone')).toMatchObject({ actor_id: goneId, actor_name: 'Gone Member', actor_deleted: true })
  })

  it('has no name for an older row of a deleted member, and says that the member is deleted', async () => {
    expect(await byLabel('actor-gone-old')).toMatchObject({ actor_id: goneId, actor_name: null, actor_deleted: true })
  })

  it('does not fail on an actor_id that is not an id (the old shape), and keeps its snapshot', async () => {
    expect(await byLabel('actor-not-an-id')).toMatchObject({ actor_id: 'fake-actor', actor_name: 'Fake Name', actor_deleted: true })
  })

  it('has no name for the system actor (the daily job), which is not a deleted member', async () => {
    const r = (await get('group=retention')).json.entries
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ action: 'retention.run', actor_type: 'system', actor_id: null, actor_name: null, actor_deleted: false, entity: null, entity_id: null, entity_name: null })
    expect(r[0].detail).toEqual({ sessions: 0, login_attempts: 3, device_labels: 0 })
    expect(await byLabel('actor-system')).toMatchObject({ actor_type: 'system', actor_name: null, actor_deleted: false })
  })

  it('has no name for a script (a command run on a computer of the owner), which is not a deleted member', async () => {
    expect(await byLabel('actor-script')).toMatchObject({ actor_type: 'script', actor_id: 'a-script', actor_name: null, actor_deleted: false })
  })

  it('never gives a system row the name of an admin, even when its actor_id is an admin\'s', async () => {
    expect(await byLabel('actor-system-with-id')).toMatchObject({ actor_type: 'system', actor_id: adminId, actor_name: null, actor_deleted: false })
  })

  it('follows a member who is renamed, for an older row, and not for a row with a snapshot', async () => {
    await db.pool.query("update admins set name = 'Renamed Admin' where id = $1", [adminId])
    try {
      expect((await byLabel('actor-old-row')).actor_name).toBe('Renamed Admin')
      expect((await byLabel('actor-snapshot')).actor_name).toBe('Snapshot Name')
    } finally {
      await db.pool.query("update admins set name = 'Test Admin' where id = $1", [adminId])
    }
  })
})

describe('the name of what an entry is about (entity_name)', () => {
  // The rows of the names dataset, by label.
  const byLabel = async () => {
    const all = (await get('limit=200')).json.entries
    return Object.fromEntries(all.filter((e) => e.action === 'test.name').map((e) => [labelOf[e.id], e]))
  }

  it('is the current name of a live point, and not the name in the detail', async () => {
    const e = (await byLabel())['name-point-live']
    expect(e).toMatchObject({ entity: 'point', entity_id: ids.live.point, entity_name: 'Current lobby' })
    expect(e.detail).toEqual({ old_name: 'Name in the detail' })
  })

  it('is the company and the contact of a live provider, as the history names a provider, or the company alone', async () => {
    const rows = await byLabel()
    expect(rows['name-provider-live'].entity_name).toBe(providerSnapshotName({ company: 'Fake Cleaning Ltd', contact_name: 'Fake Person' }))
    expect(rows['name-provider-live'].entity_name).toContain('Fake Cleaning Ltd')
    expect(rows['name-provider-live'].entity_name).toContain('Fake Person')
    expect(rows['name-provider-no-contact'].entity_name).toBe('Fake Gardens Ltd')
  })

  it('is the name of a live member, else the e-mail, and the name of a live agent key', async () => {
    const rows = await byLabel()
    expect(rows['name-admin-named'].entity_name).toBe('Second Member')
    expect(rows['name-admin-no-name'].entity_name).toBe('noname@test.local')
    expect(rows['name-key-live'].entity_name).toBe('Current agent')
  })

  it('is null when the thing is gone: a point, a provider, a member and a key that no longer exist', async () => {
    const rows = await byLabel()
    for (const label of ['name-point-gone', 'name-provider-gone', 'name-admin-gone', 'name-key-gone']) {
      expect(rows[label].entity_name, label).toBeNull()
      expect(rows[label].detail, label).toEqual({ old_name: 'Name in the detail' }) // what the screen falls back to
    }
    expect((await db.pool.query('select 1 from admins where id = $1', [goneId])).rows).toEqual([])
  })

  it('is null for an entity that has no name here, even when its id is the id of a live thing', async () => {
    const rows = await byLabel()
    for (const label of ['name-scan', 'name-widget', 'name-building', 'name-no-entity']) expect(rows[label].entity_name, label).toBeNull()
    // The id of a point under the entity "provider" finds no provider (each join is for its own entity).
    expect(rows['name-wrong-entity'].entity_name).toBeNull()
  })

  it('is null, and does not fail, for an entity_id that is not an id', async () => {
    const rows = await byLabel()
    expect(rows['name-point-not-an-id']).toMatchObject({ entity: 'point', entity_id: 'not-a-uuid', entity_name: null })
  })

  it('is null for the daily job (retention.run has no entity) and for the rows of ids that exist nowhere', async () => {
    const r = (await get('group=retention')).json.entries
    expect(r[0]).toMatchObject({ action: 'retention.run', entity: null, entity_id: null, entity_name: null })
    const rows = (await walk('', 100)).entries
    // The other datasets are about things that were never in the tables: no name is made up for them.
    for (const e of rows.filter((x) => x.action !== 'test.name')) expect(e.entity_name, e.action + ' ' + e.entity).toBeNull()
  })

  it('follows a rename of the live thing at once (it is the current name, not a copy)', async () => {
    await db.pool.query("update points set name = 'Renamed lobby' where id = $1", [ids.live.point])
    try {
      expect((await byLabel())['name-point-live'].entity_name).toBe('Renamed lobby')
    } finally {
      await db.pool.query("update points set name = 'Current lobby' where id = $1", [ids.live.point])
    }
  })

  it('reads only the name: nothing else of a point, a provider or a key is in the answer', async () => {
    const text = JSON.stringify(await byLabel())
    for (const secret of ['fake-qr-live', 'fake-hash-live', 'qr_token', 'key_hash', 'service_type', 'is_demo']) expect(text).not.toContain(secret)
  })
})

describe('privacy: what an entry holds', () => {
  const FIELDS = ['action', 'actor_deleted', 'actor_id', 'actor_name', 'actor_type', 'at', 'detail', 'entity', 'entity_id', 'entity_name', 'id']

  it('has exactly the listed fields, on every row of the log, and nothing from the admins row or a session', async () => {
    const all = await walk('', 40)
    expect(all.entries.length).toBeGreaterThan(50)
    for (const e of all.entries) expect(Object.keys(e).sort(), e.action).toEqual(FIELDS)
    // Nothing of the columns of the tables that the log is joined with, or that hold a secret.
    const text = JSON.stringify(all.entries)
    for (const secret of ['password_hash', 'token_hash', 'key_hash', 'google_sub', 'session_id', 'last_login_at', 'created_at']) {
      expect(text).not.toContain(secret)
    }
  })

  it('has the types of the shared shape (AuditEntry)', async () => {
    for (const e of (await get('limit=100')).json.entries) {
      expect(Number.isSafeInteger(e.id)).toBe(true)
      expect(e.id).toBeGreaterThan(0)
      expect(typeof e.at).toBe('string')
      expect(typeof e.action).toBe('string')
      expect(['string', 'object']).toContain(typeof e.entity) // text or null
      expect(['string', 'object']).toContain(typeof e.entity_name) // text or null
      expect(typeof e.actor_deleted).toBe('boolean')
      expect(['admin', 'system', 'script']).toContain(e.actor_type)
    }
  })

  it('returns the detail as it was stored, nested values and nulls included', async () => {
    const stored = new Map((await db.pool.query('select id::text, detail from audit_log')).rows.map((r) => [r.id, r.detail]))
    const all = await walk('', 100)
    for (const e of all.entries) expect(e.detail, e.action).toEqual(stored.get(String(e.id)))
    const find = (label) => all.entries.find((e) => String(e.id) === idOf[label])
    expect(find('point.update P1').detail).toEqual({ name: 'Fake lobby 2', provider_ids: [ids.V1] })
    expect(find('scan.void').detail).toEqual({ reason: 'a fake reason' })
    expect(find('building.update').detail).toEqual({ address: 'Fake street 1' })
    expect(find('admin.enable').detail).toBeNull()
    expect(find('api_key.create').detail).toEqual({ name: 'Fake agent' })
  })

  it('is read only: the route has no other method, and a read writes nothing', async () => {
    const before = (await db.pool.query('select count(*)::int n from audit_log')).rows[0].n
    await get('limit=500')
    await get(`entity=point&entity_id=${ids.P1}`)
    expect((await db.pool.query('select count(*)::int n from audit_log')).rows[0].n).toBe(before)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(method, '/api/admin/audit', { cookie, body: {} })
      expect(r.status, method).toBe(405)
    }
    expect((await db.pool.query('select count(*)::int n from audit_log')).rows[0].n).toBe(before)
  })

  it('needs a committee session', async () => {
    const r = await call('GET', '/api/admin/audit')
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe('admin_required')
    expect(r.text).not.toContain('entries')
    expect((await get('', 'qr_admin=nonsense')).status).toBe(401)
  })

  it('is not in the agent API: no route, and no word of it in the schema that the agent reads', () => {
    expect(routeTable().filter((r) => r.path.startsWith('/agent/v1/') && /audit/i.test(r.path))).toEqual([])
    expect(JSON.stringify(schemaDoc)).not.toMatch(/audit/i)
  })
})

describe('the SQL can use the indexes of migration 007', () => {
  // The planner picks a scan of the whole table for a table of a few rows, so the table is filled and analysed first, and the
  // sequential scan is switched off for the one transaction of the explain: what is asked is whether the index CAN serve the
  // statement (an index condition or the order), not what the planner would prefer on this data.
  beforeAll(async () => {
    await db.pool.query(
      `insert into audit_log (at, actor_type, actor_id, actor_name, action, entity, entity_id, detail)
       select timestamptz '2026-01-01 00:00:00+00' + (g * interval '17 minutes') + (g * interval '1 microsecond'),
              'admin', $1, 'Bulk Member', case g % 3 when 0 then 'point.update' when 1 then 'scan.void' else 'provider.update' end,
              case g % 3 when 0 then 'point' when 1 then 'scan' else 'provider' end, 'bulk-' || (g % 300), '{"n":1}'
         from generate_series(1, 3000) g`,
      [secondId],
    )
    await db.pool.query('analyze audit_log')
  })

  const planOf = async (q) => {
    const { sql, params } = auditQuery(q)
    return tx(async (c) => {
      await c.query('set local enable_seqscan = off')
      const { rows } = await c.query(`explain ${sql}`, params)
      return rows.map((r) => r['QUERY PLAN']).join('\n')
    })
  }
  const cursor = Buffer.from(JSON.stringify({ t: '2026-02-01T00:00:00.000500Z', id: '1500' })).toString('base64url')

  it('reads the newest first from audit_log_at_idx, with no filter, a day range, a group, an actor, a cursor', async () => {
    for (const [what, q] of [
      ['no filter', {}],
      ['a day range', { from: '2026-02-01', to: '2026-02-28' }],
      ['an ISO time', { from: '2026-02-01T00:00:00Z' }],
      ['a group', { group: 'point' }],
      ['an actor', { actor_id: secondId }],
      ['a cursor', { cursor }],
      ['a cursor and a day', { cursor, from: '2026-01-15' }],
    ]) {
      const plan = await planOf(q)
      expect(plan, `${what}:\n${plan}`).toContain('audit_log_at_idx')
      expect(plan, `${what}:\n${plan}`).toMatch(/Index Scan/)
    }
  })

  it('uses the time of a day range and of a cursor as an index condition, not as a filter on every row', async () => {
    const range = await planOf({ from: '2026-02-01', to: '2026-02-28' })
    expect(range).toMatch(/Index Cond: .*\bat\b.*>=/s)
    const paged = await planOf({ cursor })
    expect(paged).toMatch(/Index Cond: .*ROW\(at, id\)|Index Cond: .*\(at, id\)/s)
  })

  it('reads the history of one thing from audit_log_entity_idx', async () => {
    const plan = await planOf({ entity: 'point', entity_id: 'bulk-9' })
    expect(plan, plan).toContain('audit_log_entity_idx')
    const withCursor = await planOf({ entity: 'point', entity_id: 'bulk-9', cursor })
    expect(withCursor, withCursor).toContain('audit_log_entity_idx')
  })

  it('answers the same rows through the API as a direct query of the table, on the larger table', async () => {
    const { rows } = await db.pool.query(
      "select id::text as id_text from audit_log where entity = 'point' and entity_id = 'bulk-9' order by at desc, id desc",
    )
    const { entries } = await walk('entity=point&entity_id=bulk-9', 3)
    expect(ids_(entries)).toEqual(rows.map((r) => r.id_text))
    expect(rows.length).toBeGreaterThan(5)
  }, SLOW)
})
