// GET /api/agent/v1/audit: the audit log for the committee's analyst, the agent (owner decision of 08/10/2026, AGENTS.md "Safety": the
// agent sees what the committee app shows, the audit log with the names and e-mail addresses of the committee included, and never a
// secret). The committee reads the same log at GET /api/admin/audit (tests/audit-read.test.js); this file proves the agent's. The change
// is the owner's: tests/audit-read.test.js used to pin that the agent has no route to the log, and no longer does.
// What this file proves:
//   1. the route needs an agent key (the key is judged first, then the rest), reads nothing else as a credential, writes no row of the
//      log, and is limited like every route of the agent API;
//   2. the answer is { entries, count, next_cursor } with the eleven fields of an entry in their order, ISO times, newest first, and the
//      names of the actor and of the thing the entry is about as the committee's screen has them;
//   3. the detail goes out only through the allow-list of its action. The allow-list is PINNED here, key by key, so that a key added to it
//      is a visible change of this file; every action that the code writes has an entry in it; an entry whose action is not in it shows
//      no detail; every value is rebuilt as its kind says, and a text that looks like a secret (a key, a hash, a token, an id, or a
//      sentence with a word like that) is null;
//   4. nothing secret is in the raw text of any page: the full value and the prefix of a key, a QR code, the label of a phone, a
//      network address, a password and its hash, a token hash, a Google account id; a column added to the table later does not reach it;
//   5. it is the committee's log: the same entries in the same order with the same fields, and for the entries that the real routes wrote
//      the same detail except for the one key that the allow-list leaves out, and the same filters, cursor, page size and 400 errors;
//   6. a new action that the code writes without an entry in the allow-list fails here (the sources of server/ and scripts/ are read),
//      and so does an action in the table at the top of server/audit.js or in the documents that the allow-list does not have;
//   7. the documents fit: every real detail validates against the schema of its action in the OpenAPI document, closed.
// The data is fake.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { setupDb, call, seedAdmin, putKeyAtMinuteLimit } from './helpers.js'
import '../server/index.js' // importing it registers every route file with the router
import { routeTable } from '../server/router.js'
import { tx } from '../server/db.js'
import { audit, AUDIT_DETAIL_ALLOW, AUDIT_ACTOR_TYPES, AUDIT_SIGN_IN_METHODS } from '../server/audit.js'
import { AUDIT_GROUPS, AUDIT_FILTERS, AGENT_AUDIT_FIELDS, agentAuditDetail, auditQuery, checkAuditAllowList } from '../server/auditRead.js'
import { runRetention } from '../server/retention.js'
import { randomToken, sha256 } from '../server/crypto.js'
import { addCommitteeMember } from '../scripts/create-admin.mjs'
import { openApiDocument, auditDetailSchemaName } from '../server/agentOpenApi.js'
import { schemaDoc } from '../server/schemaDoc.js'
import { API_KEY_PREFIX, AGENT_KEY_MAX_PER_MINUTE, DEFAULT_PAGE_SIZE, MAX_AUDIT_PAGE_SIZE } from '../server/config.js'
import { GPS_MODES, SCAN_OUTCOMES } from '../shared/contract.js'
import { looksSecret } from '../shared/secretLike.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const IP = '203.0.113.77' // the address of the sign-ins below: it is kept in auth_attempts and must never come out
const LABEL = 'Mozilla/5.0 (Fake; Phone-Marker-4471) FakeBrowser/1.0' // the browser string of a phone
const PASSWORD = 'pw-fake-secret-audit-5530'
const NEW_PASSWORD = 'pw-fake-secret-audit-8841'
const SECRET_LOOKING_NAME = 'qrk_AbCdEf0123456789xyz' // a name that is shaped like a key
const HEX64 = 'a3f5c2d1e4b6978a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6' // shaped like a hash
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// ---------- the allow-list, pinned ----------

const POINT_FIELDS = ['name', 'description', 'service_type', 'gps_mode', 'lat', 'lng', 'radius_m', 'is_active']
const PROVIDER_FIELDS = ['company', 'contact_name', 'service_type', 'is_active', 'is_demo']
/** For each action, the keys of its detail that the agent may be shown. Widening a list is a decision: it is made here, in review. */
const PINNED = {
  'admin.add': ['email'],
  'admin.enable': ['email', 'changes'],
  'admin.disable': ['changes'],
  'admin.delete': ['email', 'name'],
  'session.sign_in': ['method'],
  'session.sign_out': [],
  'building.update': ['changes'],
  'point.create': [...POINT_FIELDS, 'provider_ids'],
  'point.update': [...POINT_FIELDS, 'changes', 'provider_ids'],
  'point.delete': ['name', 'scans_kept'],
  'point.regenerate_qr': [],
  'provider.create': ['company'],
  'provider.update': [...PROVIDER_FIELDS, 'changes', 'password_changed'],
  'provider.delete': ['company', 'contact_name', 'scans_kept'],
  'provider.revoke_devices': ['devices'],
  'scan.void': ['reason'],
  'scan.unvoid': ['previous_reason'],
  'scan.delete': ['point_name', 'provider_name', 'checked_in_at', 'outcome', 'voided'],
  'api_key.create': ['name'],
  'api_key.revoke': [],
  'api_key.delete': ['name', 'was_revoked'],
  'retention.run': ['sessions', 'login_attempts', 'device_labels', 'app_errors', 'alert_pings', 'api_key_usage'],
}
/** The fields of `changes`, where an action has it. */
const PINNED_CHANGES = {
  'admin.enable': ['is_active'],
  'admin.disable': ['is_active'],
  'building.update': ['address', 'name'],
  'point.update': POINT_FIELDS,
  'provider.update': PROVIDER_FIELDS,
}
/** Keys that a detail of the log may hold today or tomorrow and that must never go out, under any action. */
const NEVER_KEYS = ['key_prefix', 'key_hash', 'token', 'token_hash', 'password', 'password_hash', 'qr_token', 'legacy_id', 'label', 'device_label', 'user_agent', 'ip', 'google_sub', 'key']

let db, cookie, cookie2
let adminId
const world = {} // ids and values of the seed, by name
const secrets = {} // kind -> the values that must never be in the raw text of an answer
const usedKeys = [] // every agent key this file made: none of them may come out either

// One key may make AGENT_KEY_MAX_PER_MINUTE requests in a minute; this file works through keys, as tests/agent-docs.test.js does. The
// keys are written straight into the table, so that the rotation adds no row to the audit log that the tests below count and compare.
const KEY_USES = Math.floor((AGENT_KEY_MAX_PER_MINUTE * 2) / 3)
let agentKey
let keyUses = 0
async function newKey(name = 'Fake direct agent key') {
  const key = randomToken(API_KEY_PREFIX)
  const { rows } = await db.pool.query('insert into api_keys (name, key_prefix, key_hash) values ($1, $2, $3) returning id', [name, key.slice(0, 8), sha256(key)])
  usedKeys.push(key)
  return { key, id: rows[0].id }
}
async function currentKey() {
  if (!agentKey || keyUses >= KEY_USES) {
    agentKey = (await newKey()).key
    keyUses = 0
  }
  keyUses += 1
  return agentKey
}
const agent = async (qs = '', opts = {}) => call('GET', `/api/agent/v1/audit${qs ? `?${qs}` : ''}`, { token: await currentKey(), ...opts })
const committee = (qs = '') => call('GET', `/api/admin/audit${qs ? `?${qs}` : ''}`, { cookie })

/** Every page of a listing with its cursor: the entries, the size of each page and the raw text of each page. */
async function walk(read, qs, limit) {
  const entries = []
  const sizes = []
  const texts = []
  let cursor = ''
  for (let i = 0; i < 400; i++) {
    const r = await read(`${qs ? `${qs}&` : ''}limit=${limit}${cursor}`)
    expect(r.status, r.text).toBe(200)
    entries.push(...r.json.entries)
    sizes.push(r.json.entries.length)
    texts.push(r.text)
    if (!r.json.next_cursor) return { entries, sizes, texts }
    cursor = `&cursor=${r.json.next_cursor}`
  }
  throw new Error('the cursor never ended')
}

const send = async (method, p, body, asCookie = cookie) => call(method, p, { cookie: asCookie, body })
async function must(method, p, body, asCookie = cookie) {
  const r = await send(method, p, body, asCookie)
  if (r.status !== 200 && r.status !== 201) throw new Error(`seed ${method} ${p}: ${r.status} ${r.text}`)
  return r.json
}

/** Rows written straight into the log, the way the committee's routes would have: the poisoned ones, and the rows of a given time. */
async function addRows(rows) {
  for (const row of rows) {
    await db.pool.query(
      `insert into audit_log (at, actor_type, actor_id, actor_name, action, entity, entity_id, detail)
       values (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.at ?? null, row.actor_type ?? 'admin', 'actor_id' in row ? row.actor_id : adminId, 'actor_name' in row ? row.actor_name : 'Poison Writer',
        row.action, row.entity ?? null, row.entity_id ?? null, row.detail === undefined ? null : JSON.stringify(row.detail),
      ],
    )
  }
}

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool) // admin@test.local, "Test Admin"
  const first = await call('POST', '/api/admin/google', { body: { credential: 'admin@test.local' }, ip: IP })
  cookie = String(first.headers['set-cookie']).split(';')[0]
  adminId = (await db.pool.query("select id from admins where email = 'admin@test.local'")).rows[0].id

  // The committee list: a second member who acts too, a third who is switched off and on and deleted, a fourth with no name.
  world.m2 = (await must('POST', '/api/admin/admins', { email: 'second@test.local', name: 'Second Member' })).admin.id
  cookie2 = String((await call('POST', '/api/admin/google', { body: { credential: 'second@test.local' } })).headers['set-cookie']).split(';')[0]
  world.m3 = (await must('POST', '/api/admin/admins', { email: 'third@test.local', name: 'Third Member' })).admin.id
  await must('PATCH', `/api/admin/admins/${world.m3}`, { is_active: false }) // admin.disable
  await must('POST', '/api/admin/admins', { email: 'third@test.local', name: 'ignored' }) // admin.enable, with the e-mail
  await must('PATCH', `/api/admin/admins/${world.m3}`, { is_active: false })
  await must('PATCH', `/api/admin/admins/${world.m3}`, { is_active: true }) // admin.enable, without it
  await must('DELETE', `/api/admin/admins/${world.m3}`) // admin.delete: the entries about the third member now name a member who is gone
  world.m4 = (await must('POST', '/api/admin/admins', { email: 'noname@test.local', name: '' })).admin.id
  await addCommitteeMember(tx, 'script-added@test.local', 'Script Added') // admin.add by the script actor
  world.m5 = (await db.pool.query("select id from admins where email = 'script-added@test.local'")).rows[0].id
  await must('PATCH', `/api/admin/admins/${world.m5}`, { is_active: false })
  await addCommitteeMember(tx, 'script-added@test.local') // admin.enable by the script actor, with the e-mail

  await must('PUT', '/api/admin/building', { address: 'Fake street 1', name: 'Fake Building' })
  await must('PUT', '/api/admin/building', { address: 'Fake street 2', name: 'Fake Building' }, cookie2) // by the second member

  // Providers: one that is changed and scans, one that is deleted, one with no contact.
  const provider = async (body) => (await must('POST', '/api/admin/providers', { password: PASSWORD, ...body })).provider
  world.v1 = await provider({ company: 'Fake Cleaning Ltd', contact_name: 'Fake Person', service_type: 'cleaning' })
  world.v2 = await provider({ company: 'Doomed Ltd', contact_name: 'Gone Person' })
  world.v3 = await provider({ company: 'Fake Gardens Ltd' })
  await must('PATCH', `/api/admin/providers/${world.v1.id}`, { contact_name: 'Fake Person Two' }) // changes
  await must('PATCH', `/api/admin/providers/${world.v1.id}`, { password: NEW_PASSWORD }) // password_changed
  await must('PATCH', `/api/admin/providers/${world.v3.id}`, { service_type: 'gardening', is_demo: false, is_active: true })
  const signIn = async (p, password) => {
    const r = await call('POST', '/api/session', { body: { provider_id: p.id, password, device_label: LABEL }, ip: IP })
    if (r.status !== 200) throw new Error(`sign-in: ${r.status} ${r.text}`)
    return r.json.token
  }
  await signIn(world.v1, NEW_PASSWORD)
  await must('POST', `/api/admin/providers/${world.v1.id}/revoke-devices`) // provider.revoke_devices, one phone
  world.v1Token = await signIn(world.v1, NEW_PASSWORD)
  await must('DELETE', `/api/admin/providers/${world.v2.id}`)

  // Points.
  const point = async (body) => (await must('POST', '/api/admin/points', body)).point
  world.p1 = await point({ name: 'Lobby', description: 'Main entrance', service_type: 'cleaning', gps_mode: 'none', lat: 31.5, lng: 34.8, radius_m: 60, provider_ids: [world.v1.id] })
  world.p2 = await point({ name: 'Roof', gps_mode: 'none' })
  world.p3 = await point({ name: 'Basement', gps_mode: 'none' })
  world.p4 = await point({ name: 'Garage', gps_mode: 'none' })
  await must('PATCH', `/api/admin/points/${world.p1.id}`, { name: 'Lobby renamed', description: 'Renamed', gps_mode: 'optional', provider_ids: [world.v1.id, world.v3.id] })
  await must('PATCH', `/api/admin/points/${world.p1.id}`, { is_active: false })
  await must('PATCH', `/api/admin/points/${world.p1.id}`, { is_active: true })
  world.p1OldCode = world.p1.qr_token
  world.p1NewCode = (await must('POST', `/api/admin/points/${world.p1.id}/regenerate-qr`)).point.qr_token
  await must('DELETE', `/api/admin/points/${world.p2.id}`)

  // Scans: one that is voided, restored and voided again, one that is deleted.
  const scan = async (code) => (await call('POST', '/api/scan', { token: world.v1Token, body: { id: randomUUID(), code }, ip: IP }))
  const s1 = await scan(world.p3.qr_token)
  const s2 = await scan(world.p4.qr_token)
  if (s1.status !== 200 || s2.status !== 200) throw new Error(`a seed scan was refused: ${s1.status} ${s2.status}`)
  world.s1 = s1.json.scan.id
  world.s2 = s2.json.scan.id
  await must('POST', `/api/admin/scans/${world.s1}/void`, { reason: 'a fake reason' })
  await must('POST', `/api/admin/scans/${world.s1}/unvoid`)
  await must('POST', `/api/admin/scans/${world.s1}/void`, { reason: 'a second fake reason' })
  await must('DELETE', `/api/admin/scans/${world.s2}`)

  // Agent keys: one that is revoked and deleted (its prefix is in the log), one that stays, one whose name is shaped like a key.
  const key = async (name) => (await must('POST', '/api/admin/api-keys', { name }))
  const k1 = await key('Fake agent K1')
  await must('POST', `/api/admin/api-keys/${k1.api_key.id}/revoke`)
  await must('DELETE', `/api/admin/api-keys/${k1.api_key.id}`)
  world.k1 = { id: k1.api_key.id, key: k1.key, prefix: k1.api_key.key_prefix }
  const k2 = await key('Fake agent K2')
  world.k2 = { id: k2.api_key.id, key: k2.key }
  const k3 = await key(SECRET_LOOKING_NAME)
  world.k3 = { id: k3.api_key.id, key: k3.key }

  // The actors that the routes of this file cannot be: the system, and the development shortcut of the sign-in.
  await tx((c) => audit(c, { type: 'system', id: null, name: null }, 'admin.add', { entity: 'admin', entityId: randomUUID(), detail: { email: 'first@test.local' } }))
  await tx((c) => audit(c, { type: 'admin', id: adminId, name: 'Test Admin' }, 'session.sign_in', { entity: 'admin', entityId: adminId, detail: { method: 'dev' } }))
  await runRetention() // retention.run
  await send('POST', '/api/admin/logout', {}, cookie2) // session.sign_out

  // What must never come out, read from the database after everything was written.
  const column = async (sql) => (await db.pool.query(sql)).rows.map((r) => String(Object.values(r)[0]))
  Object.assign(secrets, {
    'a QR code': [world.p1OldCode, world.p1NewCode, world.p2.qr_token, world.p3.qr_token, world.p4.qr_token, ...(await column('select qr_token from points'))],
    'a name that is shaped like a key': [SECRET_LOOKING_NAME],
    'a password': [PASSWORD, NEW_PASSWORD],
    'a hash of a password': await column('select password_hash from providers'),
    'a hash of a token': [...(await column('select token_hash from provider_devices')), ...(await column('select token_hash from admin_sessions'))],
    'a hash of a key': await column('select key_hash from api_keys'),
    'a key': [world.k1.key, world.k2.key, world.k3.key],
    'the prefix of a key': [world.k1.prefix, world.k1.key.slice(0, 8), world.k2.key.slice(0, 8), world.k3.key.slice(0, 8)],
    'the label of a phone': [LABEL, 'Phone-Marker-4471'],
    'a network address': [IP, ...(await column("select key from auth_attempts where key like 'ip:%'"))],
    'a Google account': await column('select google_sub from admins where google_sub is not null'),
  })
  for (const [kind, values] of Object.entries(secrets)) {
    expect(values.length, `the seed has a value of the kind "${kind}"`).toBeGreaterThan(0)
    for (const value of values) expect(value.length, `a value of the kind "${kind}" is long enough to be found`).toBeGreaterThanOrEqual(4)
  }
}, 120_000)

afterAll(async () => db?.teardown())

/** The raw text of every page of the whole log: nothing of `secrets` (and no key of this file) may be in it. */
const noSecretIn = (text, where) => {
  for (const [kind, values] of Object.entries(secrets)) for (const value of values) expect(text, `${where} carries ${kind}`).not.toContain(value)
  for (const key of usedKeys) expect(text, `${where} carries an agent key of this file`).not.toContain(key)
}

// ======================================================================================================================
// 1. the route and its key
// ======================================================================================================================

describe('the route needs an agent key and writes nothing', () => {
  it('is registered once, as GET /api/agent/v1/audit', () => {
    expect(routeTable().filter((r) => r.path === '/agent/v1/audit').map((r) => r.method)).toEqual(['GET'])
  })

  it('answers 401 api_key_required without a key, and with the cookie of a committee member (the cookie is no key)', async () => {
    for (const opts of [{}, { cookie }, { headers: { authorization: 'Basic abc' } }, { token: 'not-a-key' }]) {
      const r = await call('GET', '/api/agent/v1/audit', opts)
      expect(r.status).toBe(401)
      expect(r.json.error.code).toBe('api_key_required')
      expect(r.text).not.toContain('entries')
    }
  })

  it('answers 401 api_key_invalid to an unknown key and to a revoked one', async () => {
    const revoked = await newKey('Fake revoked key')
    await db.pool.query('update api_keys set revoked_at = now() where id = $1', [revoked.id])
    for (const token of [`${API_KEY_PREFIX}unknown`, revoked.key]) {
      const r = await call('GET', '/api/agent/v1/audit', { token })
      expect(r.status).toBe(401)
      expect(r.json.error.code).toBe('api_key_invalid')
      expect(r.text).not.toContain('entries')
    }
  })

  it('judges the key first: a bad parameter and a body that is not JSON get the 401 until the key is valid, then the 400', async () => {
    for (const qs of ['limit=abc', 'cursor=zzz', 'group=nope', 'actor_id=abc', 'from=yesterday']) {
      expect((await call('GET', `/api/agent/v1/audit?${qs}`, {})).json.error.code, qs).toBe('api_key_required')
      expect((await call('GET', `/api/agent/v1/audit?${qs}`, { token: `${API_KEY_PREFIX}unknown` })).json.error.code, qs).toBe('api_key_invalid')
      expect((await agent(qs)).status, qs).toBe(400)
    }
    const json = await agent('', { badJsonBody: true })
    expect(json.status).toBe(400)
    expect(json.json.error.code).toBe('invalid_json')
  })

  it('is read only: the other methods are 405, and a request writes no row of the audit log, the scans or the refusals', async () => {
    const count = async () => (await db.pool.query('select (select count(*) from audit_log) as a, (select count(*) from scans) as s, (select count(*) from scan_refusals) as r')).rows[0]
    const key = await currentKey() // a key that exists already: using it changes api_keys and api_key_usage, which are not the log
    const before = await count()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(method, '/api/agent/v1/audit', { token: key, body: {} })
      expect(r.status, method).toBe(405)
      expect(r.json.error.code).toBe('method_not_allowed')
    }
    expect((await agent('limit=200')).status).toBe(200)
    expect(await count()).toEqual(before)
  })

  it('is limited like every route of the agent API: a key over its limit for the minute gets 429 before the rest is looked at', async () => {
    const spent = await newKey('Fake key over its limit')
    await putKeyAtMinuteLimit(db.pool, spent.id)
    const r = await call('GET', '/api/agent/v1/audit?limit=abc', { token: spent.key })
    expect(r.status).toBe(429)
    expect(r.json.error.code).toBe('rate_limited')
    expect(r.text).not.toContain('entries')
  })
})

// ======================================================================================================================
// 2. the entry
// ======================================================================================================================

describe('the entry: fields, types, names', () => {
  it('answers { entries, count, next_cursor } with count the size of the page', async () => {
    const r = await agent('limit=5')
    expect(r.status, r.text).toBe(200)
    expect(Object.keys(r.json)).toEqual(['entries', 'count', 'next_cursor'])
    expect(r.json.entries).toHaveLength(5)
    expect(r.json.count).toBe(5)
    expect(typeof r.json.next_cursor).toBe('string')
    const all = await agent('limit=200')
    expect(all.json.count).toBe(all.json.entries.length)
  })

  it('gives every entry the eleven fields in order, with the types of the documents', async () => {
    const { entries } = (await agent('limit=200')).json
    expect(entries.length).toBeGreaterThan(30)
    expect(AGENT_AUDIT_FIELDS).toEqual(['id', 'at', 'action', 'entity', 'entity_id', 'entity_name', 'actor_type', 'actor_id', 'actor_name', 'actor_deleted', 'detail'])
    expect(Object.keys(schemaDoc.audit_fields)).toEqual([...AGENT_AUDIT_FIELDS])
    for (const e of entries) {
      expect(Object.keys(e), e.action).toEqual([...AGENT_AUDIT_FIELDS])
      expect(Number.isSafeInteger(e.id) && e.id > 0).toBe(true)
      expect(e.at).toMatch(ISO)
      expect(typeof e.action).toBe('string')
      for (const field of ['entity', 'entity_id', 'entity_name', 'actor_id', 'actor_name']) expect(['string', 'object'], field).toContain(typeof e[field])
      expect(AUDIT_ACTOR_TYPES).toContain(e.actor_type)
      expect(typeof e.actor_deleted).toBe('boolean')
      expect(['object']).toContain(typeof e.detail)
    }
    for (let i = 1; i < entries.length; i++) expect(Date.parse(entries[i - 1].at)).toBeGreaterThanOrEqual(Date.parse(entries[i].at))
  })

  it('names the actor as the snapshot on the row; the current name or the e-mail for an older row; the system and a command have none', async () => {
    const { entries } = (await agent('limit=200')).json
    const by = (action, who) => entries.find((e) => e.action === action && e.actor_type === who)
    expect(by('point.create', 'admin')).toMatchObject({ actor_id: adminId, actor_name: 'Test Admin', actor_deleted: false })
    expect(by('session.sign_out', 'admin')).toMatchObject({ actor_id: world.m2, actor_name: 'Second Member', actor_deleted: false })
    expect(by('retention.run', 'system')).toMatchObject({ actor_id: null, actor_name: null, actor_deleted: false, entity: null, entity_id: null, entity_name: null })
    expect(by('admin.add', 'system')).toMatchObject({ actor_id: null, actor_name: null, actor_deleted: false })
    expect(by('admin.add', 'script')).toMatchObject({ actor_id: null, actor_name: null, actor_deleted: false, detail: { email: 'script-added@test.local' } })
    // An older row without a snapshot: the member's current name, else the e-mail (as the committee's screen has it).
    await addRows([
      { action: 'test.actor', entity: 'actor', entity_id: 'poison-no-snapshot', actor_id: world.m2, actor_name: null },
      { action: 'test.actor', entity: 'actor', entity_id: 'poison-no-name', actor_id: world.m4, actor_name: null },
    ])
    const named = (await agent('entity=actor&limit=10')).json.entries
    expect(named.find((e) => e.entity_id === 'poison-no-snapshot')).toMatchObject({ actor_name: 'Second Member' })
    expect(named.find((e) => e.entity_id === 'poison-no-name')).toMatchObject({ actor_name: 'noname@test.local' })
  })

  it('says that a deleted member is deleted, and keeps the name that was on the row', async () => {
    const { entries } = (await agent('limit=200')).json
    const about = entries.filter((e) => e.entity === 'admin' && e.entity_id === world.m3)
    expect(about.length).toBeGreaterThan(3)
    for (const e of about) expect(e.entity_name, e.action).toBeNull() // gone: no current name
    expect(about.find((e) => e.action === 'admin.delete').detail).toEqual({ email: 'third@test.local', name: 'Third Member' })
    // A member who acted and is deleted afterwards: the row keeps the snapshot and says so.
    await addRows([{ action: 'test.actor', entity: 'actor', entity_id: 'poison-gone', actor_id: world.m3, actor_name: 'Third Member' }])
    expect((await agent('entity=actor&limit=10')).json.entries.find((e) => e.entity_id === 'poison-gone')).toMatchObject({ actor_name: 'Third Member', actor_deleted: true })
  })

  it('gives the current name of what the entry is about, and null when it is gone or has no name', async () => {
    const { entries } = (await agent('limit=200')).json
    const of = (entity, id) => entries.filter((e) => e.entity === entity && e.entity_id === id)
    for (const e of of('point', world.p1.id)) expect(e.entity_name, e.action).toBe('Lobby renamed')
    for (const e of of('provider', world.v1.id)) expect(e.entity_name, e.action).toBe('Fake Cleaning Ltd – Fake Person Two')
    for (const e of of('provider', world.v3.id)) expect(e.entity_name, e.action).toBe('Fake Gardens Ltd')
    for (const e of of('admin', world.m2)) expect(e.entity_name, e.action).toBe('Second Member')
    for (const e of of('admin', world.m4)) expect(e.entity_name, e.action).toBe('noname@test.local')
    for (const e of of('api_key', world.k2.id)) expect(e.entity_name, e.action).toBe('Fake agent K2')
    // Gone: the point, the provider and the key that were deleted, and the scans.
    for (const [entity, id] of [['point', world.p2.id], ['provider', world.v2.id], ['api_key', world.k1.id], ['scan', world.s1], ['scan', world.s2]]) {
      const rows = of(entity, id)
      expect(rows.length, `${entity} ${id}`).toBeGreaterThan(0)
      for (const e of rows) expect(e.entity_name, `${e.action} ${entity}`).toBeNull()
    }
    // The building has no name here either, and a sign-in is about the member who signed in.
    expect(entries.find((e) => e.action === 'building.update')).toMatchObject({ entity: 'building', entity_id: null, entity_name: null })
    expect(entries.find((e) => e.action === 'session.sign_in' && e.actor_id === world.m2)).toMatchObject({ entity: 'admin', entity_id: world.m2, entity_name: 'Second Member' })
  })

  it('shows null for a name that looks like a key: the name of a key that is shaped like one, and an actor called so', async () => {
    const { entries } = (await agent('limit=200')).json
    for (const e of entries.filter((x) => x.entity === 'api_key' && x.entity_id === world.k3.id)) expect(e.entity_name, e.action).toBeNull()
    const create = entries.find((e) => e.action === 'api_key.create' && e.entity_id === world.k3.id)
    expect(create.detail).toEqual({ name: null }) // the name in the detail is a text like any other
    // The committee's own answer has the name, as it was typed.
    expect((await committee('limit=200')).json.entries.find((e) => e.action === 'api_key.create' && e.entity_id === world.k3.id).detail).toEqual({ name: SECRET_LOOKING_NAME })
    await addRows([{ action: 'test.actor', entity: 'actor', entity_id: 'poison-secret-actor', actor_id: 'fake-actor', actor_name: SECRET_LOOKING_NAME }])
    const found = (await agent('entity=actor&limit=20')).json.entries.find((e) => e.entity_id === 'poison-secret-actor')
    expect(found.actor_name).toBeNull()
    expect((await committee('entity=actor&limit=20')).json.entries.find((e) => e.entity_id === 'poison-secret-actor').actor_name).toBe(SECRET_LOOKING_NAME)
  })
})

// ======================================================================================================================
// 3. the detail
// ======================================================================================================================

describe('the detail goes out only through the allow-list of its action', () => {
  it('the allow-list is the pinned one, action by action and key by key', () => {
    expect(Object.keys(AUDIT_DETAIL_ALLOW).sort()).toEqual(Object.keys(PINNED).sort())
    for (const [action, keys] of Object.entries(PINNED)) {
      expect(Object.keys(AUDIT_DETAIL_ALLOW[action]).sort(), action).toEqual([...keys].sort())
      const changes = AUDIT_DETAIL_ALLOW[action].changes
      if (PINNED_CHANGES[action]) expect(Object.keys(changes.fields).sort(), `${action} changes`).toEqual([...PINNED_CHANGES[action]].sort())
      else expect(changes, `${action} has no changes`).toBeUndefined()
    }
    // No key that must never go out, under any action (not at the top of a detail, not inside changes).
    for (const [action, allow] of Object.entries(AUDIT_DETAIL_ALLOW)) {
      for (const key of Object.keys(allow)) expect(NEVER_KEYS, `${action}.${key}`).not.toContain(key)
      for (const key of Object.keys(allow.changes?.fields ?? {})) expect(NEVER_KEYS, `${action}.changes.${key}`).not.toContain(key)
    }
    expect(Object.isFrozen(AUDIT_DETAIL_ALLOW)).toBe(true)
    for (const allow of Object.values(AUDIT_DETAIL_ALLOW)) expect(Object.isFrozen(allow)).toBe(true)
  })

  it('has the words that its enums take from the constants of the code', () => {
    expect(AUDIT_DETAIL_ALLOW['point.create'].gps_mode.values).toEqual([...GPS_MODES])
    expect(AUDIT_DETAIL_ALLOW['point.update'].changes.fields.gps_mode.values).toEqual([...GPS_MODES])
    expect(AUDIT_DETAIL_ALLOW['scan.delete'].outcome.values).toEqual([...SCAN_OUTCOMES])
    expect(AUDIT_DETAIL_ALLOW['session.sign_in'].method.values).toEqual([...AUDIT_SIGN_IN_METHODS])
    expect([...AUDIT_SIGN_IN_METHODS]).toEqual(['google', 'dev'])
  })

  it('the log of the seed has an entry for every action of the allow-list, written by the real routes (or the real job and command)', async () => {
    const { rows } = await db.pool.query('select distinct action from audit_log')
    const written = rows.map((r) => r.action)
    for (const action of Object.keys(AUDIT_DETAIL_ALLOW)) expect(written, action).toContain(action)
    // Both sign-in methods, both ways of enabling a member, all three kinds of actor.
    const details = (await db.pool.query("select detail from audit_log where action = 'session.sign_in'")).rows.map((r) => r.detail.method)
    expect(new Set(details)).toEqual(new Set(AUDIT_SIGN_IN_METHODS))
    expect((await db.pool.query('select distinct actor_type from audit_log order by 1')).rows.map((r) => r.actor_type)).toEqual([...AUDIT_ACTOR_TYPES].sort())
  })

  it('every entry that a real route wrote has only the allowed keys: the keys of the allow-list, and the fields of changes', async () => {
    const { entries } = await walk(agent, '', 200)
    const real = entries.filter((e) => !e.entity_id?.startsWith('poison-') && Object.hasOwn(PINNED, e.action))
    expect(real.length).toBeGreaterThan(40)
    for (const e of real) {
      if (e.detail === null) continue
      for (const key of Object.keys(e.detail)) expect(PINNED[e.action], `${e.action}.${key}`).toContain(key)
      for (const key of Object.keys(e.detail.changes ?? {})) expect(PINNED_CHANGES[e.action], `${e.action}.changes.${key}`).toContain(key)
    }
    // And each action showed something at least once, so the check above is not vacuous (the actions with no keys never do).
    for (const [action, keys] of Object.entries(PINNED)) {
      const shown = real.filter((e) => e.action === action && e.detail !== null)
      if (keys.length) expect(shown.length, `${action} shows a detail`).toBeGreaterThan(0)
      else expect(shown, `${action} never shows one`).toEqual([])
    }
  })

  it('shows what the real routes wrote, key by key (an example of each kind of detail)', async () => {
    const { entries } = (await agent('limit=200')).json
    const one = (action, id) => entries.find((e) => e.action === action && (id === undefined || e.entity_id === id))
    expect(one('admin.add', world.m2).detail).toEqual({ email: 'second@test.local' })
    expect(one('admin.disable', world.m3).detail).toEqual({ changes: { is_active: { from: true, to: false } } })
    expect(entries.filter((e) => e.action === 'admin.enable' && e.entity_id === world.m3).map((e) => e.detail).sort((a, b) => Object.keys(a).length - Object.keys(b).length)).toEqual([
      { changes: { is_active: { from: false, to: true } } },
      { email: 'third@test.local', changes: { is_active: { from: false, to: true } } },
    ])
    expect(entries.find((e) => e.action === 'admin.enable' && e.actor_type === 'script').detail).toEqual({ email: 'script-added@test.local', changes: { is_active: { from: false, to: true } } })
    expect(entries.filter((e) => e.action === 'session.sign_in').map((e) => e.detail.method).sort()).toContain('google')
    expect(one('building.update').detail).toEqual({ changes: { address: { from: 'Fake street 1', to: 'Fake street 2' } } })
    expect(one('point.create', world.p1.id).detail).toEqual({
      name: 'Lobby', description: 'Main entrance', service_type: 'cleaning', gps_mode: 'none', lat: 31.5, lng: 34.8, radius_m: 60, provider_ids: [world.v1.id],
    })
    const updates = entries.filter((e) => e.action === 'point.update' && e.entity_id === world.p1.id).map((e) => e.detail)
    expect(updates).toContainEqual({
      changes: { name: { from: 'Lobby', to: 'Lobby renamed' }, description: { from: 'Main entrance', to: 'Renamed' }, gps_mode: { from: 'none', to: 'optional' } },
      provider_ids: { added: [world.v3.id], removed: [] },
    })
    expect(updates).toContainEqual({ changes: { is_active: { from: true, to: false } } })
    expect(one('point.delete', world.p2.id).detail).toEqual({ name: 'Roof', scans_kept: 0 })
    expect(one('point.regenerate_qr')).toMatchObject({ detail: null })
    expect(one('provider.create', world.v1.id).detail).toEqual({ company: 'Fake Cleaning Ltd' })
    const providerUpdates = entries.filter((e) => e.action === 'provider.update' && e.entity_id === world.v1.id).map((e) => e.detail)
    expect(providerUpdates).toContainEqual({ changes: { contact_name: { from: 'Fake Person', to: 'Fake Person Two' } } })
    expect(providerUpdates).toContainEqual({ password_changed: true })
    expect(one('provider.revoke_devices', world.v1.id).detail).toEqual({ devices: 1 })
    expect(one('provider.delete', world.v2.id).detail).toEqual({ company: 'Doomed Ltd', contact_name: 'Gone Person', scans_kept: 0 })
    expect(entries.filter((e) => e.action === 'scan.void' && e.entity_id === world.s1).map((e) => e.detail.reason).sort()).toEqual(['a fake reason', 'a second fake reason'])
    expect(one('scan.unvoid', world.s1).detail).toEqual({ previous_reason: 'a fake reason' })
    expect(one('scan.delete', world.s2).detail).toMatchObject({ point_name: 'Garage', provider_name: 'Fake Cleaning Ltd – Fake Person Two', outcome: 'accepted', voided: false })
    expect(one('scan.delete', world.s2).detail.checked_in_at).toMatch(ISO)
    expect(one('api_key.create', world.k2.id).detail).toEqual({ name: 'Fake agent K2' })
    expect(one('api_key.revoke', world.k1.id).detail).toBeNull()
    expect(one('api_key.delete', world.k1.id).detail).toEqual({ name: 'Fake agent K1', was_revoked: true }) // and no key_prefix
    expect(Object.keys(one('retention.run').detail).sort()).toEqual([...PINNED['retention.run']].sort())
    for (const value of Object.values(one('retention.run').detail)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true)
  })

  // ---- the values: each kind, rebuilt ----

  const cases = [
    // [what, action, stored, shown]
    ['a text that is a key', 'point.delete', { name: 'qrk_abcdef0123456789', scans_kept: 3 }, { name: null, scans_kept: 3 }],
    ['a text that is a hash', 'api_key.create', { name: HEX64 }, { name: null }],
    ['a text that is a token', 'provider.create', { company: 'qrp_AbCdEfGhIjKlMn' }, { company: null }],
    ['a text that is an id', 'provider.create', { company: randomUUID() }, { company: null }],
    ['a sentence with a key in it', 'scan.void', { reason: `pasted ${SECRET_LOOKING_NAME} by mistake` }, { reason: null }],
    ['a sentence with a long run of letters and digits in it', 'scan.void', { reason: `see ${'a1'.repeat(14)} please` }, { reason: null }],
    ['a plain sentence', 'scan.void', { reason: 'the cleaner was sick that day, 3 visits were missed' }, { reason: 'the cleaner was sick that day, 3 visits were missed' }],
    ['a name with digits and spaces', 'point.delete', { name: 'Building 4 - Entrance 2', scans_kept: 0 }, { name: 'Building 4 - Entrance 2', scans_kept: 0 }],
    ['a name in Hebrew', 'point.delete', { name: 'לובי ראשי', scans_kept: 0 }, { name: 'לובי ראשי', scans_kept: 0 }],
    ['an e-mail address', 'admin.delete', { email: 'someone.with.a.long.local.part1234567@example.com', name: '' }, { email: 'someone.with.a.long.local.part1234567@example.com', name: '' }],
    ['a null reason', 'scan.void', { reason: null }, { reason: null }],
    ['a text where a number should be', 'point.delete', { name: 'Fake', scans_kept: 'many' }, { name: 'Fake', scans_kept: null }],
    ['a number where a text should be', 'point.delete', { name: 5, scans_kept: 1 }, { name: null, scans_kept: 1 }],
    ['a negative count', 'provider.revoke_devices', { devices: -1 }, { devices: null }],
    ['a count that is not a whole number', 'provider.revoke_devices', { devices: 1.5 }, { devices: null }],
    ['a count that is too large to be exact', 'provider.revoke_devices', { devices: 2 ** 60 }, { devices: null }],
    ['a boolean as text', 'scan.delete', { point_name: 'Fake', provider_name: 'Fake', voided: 'yes' }, { point_name: 'Fake', provider_name: 'Fake', voided: null }],
    ['a time that is not a time', 'scan.delete', { checked_in_at: 'not a time' }, { checked_in_at: null }],
    ['a time with an offset', 'scan.delete', { checked_in_at: '2026-04-30T10:00:00+03:00' }, { checked_in_at: '2026-04-30T07:00:00.000Z' }],
    ['an outcome that is not one', 'scan.delete', { outcome: 'accepted_ish' }, { outcome: null }],
    ['a sign-in method that is not one', 'session.sign_in', { method: 'password' }, { method: null }],
    ['a sign-in method that is one', 'session.sign_in', { method: 'dev' }, { method: 'dev' }],
    ['a gps_mode that is not one', 'point.create', { name: 'Fake', gps_mode: 'sometimes' }, { name: 'Fake', gps_mode: null }],
    ['a coordinate as text', 'point.create', { lat: '31.5', lng: 34.8, radius_m: 60.5 }, { lat: null, lng: 34.8, radius_m: null }],
    ['a list of ids with something else in it', 'point.create', { provider_ids: ['b7a3f0c1-0d2e-4a5b-8c9d-0e1f2a3b4c5d', 'not-an-id', 'qrk_abcdef123456', 7] }, { provider_ids: ['b7a3f0c1-0d2e-4a5b-8c9d-0e1f2a3b4c5d'] }],
    ['a list of ids in upper case', 'point.create', { provider_ids: ['B7A3F0C1-0D2E-4A5B-8C9D-0E1F2A3B4C5D'] }, { provider_ids: ['b7a3f0c1-0d2e-4a5b-8c9d-0e1f2a3b4c5d'] }],
    ['provider_ids that is not a list', 'point.create', { provider_ids: 'b7a3f0c1-0d2e-4a5b-8c9d-0e1f2a3b4c5d' }, { provider_ids: null }],
    ['the older whole list of ids on an update', 'point.update', { provider_ids: ['b7a3f0c1-0d2e-4a5b-8c9d-0e1f2a3b4c5d'] }, { provider_ids: ['b7a3f0c1-0d2e-4a5b-8c9d-0e1f2a3b4c5d'] }],
    ['added and removed ids', 'point.update', { provider_ids: { added: ['b7a3f0c1-0d2e-4a5b-8c9d-0e1f2a3b4c5d', 'x'], removed: 'x' } }, { provider_ids: { added: ['b7a3f0c1-0d2e-4a5b-8c9d-0e1f2a3b4c5d'], removed: [] } }],
    ['an update of the older, flat shape', 'point.update', { name: 'Old name', is_active: false, lat: null }, { name: 'Old name', lat: null, is_active: false }],
    ['a provider update of the older, flat shape', 'provider.update', { company: 'Old Ltd', password_changed: false }, { company: 'Old Ltd', password_changed: false }],
    ['changes with a text that is a key on one side', 'point.update', { changes: { name: { from: 'qrk_abcdefghij1234', to: 'Fine name' } } }, { changes: { name: { from: null, to: 'Fine name' } } }],
    ['changes with a field that is not listed', 'point.update', { changes: { name: { from: 'a', to: 'b' }, qr_token: { from: 'BQR-aaaa', to: 'BQR-bbbb' }, password_hash: { from: 'x', to: 'y' } } }, { changes: { name: { from: 'a', to: 'b' } } }],
    ['changes with a field that is not an object', 'point.update', { changes: { name: 'b', lat: { from: 31.5, to: 'north' } } }, { changes: { lat: { from: 31.5, to: null } } }],
    ['changes that hold no listed field', 'point.update', { changes: { qr_token: { from: 'a', to: 'b' } } }, { changes: null }],
    ['changes that is not an object', 'point.update', { changes: 'name' }, { changes: null }],
    ['an enum inside changes', 'point.update', { changes: { gps_mode: { from: 'none', to: 'sometimes' } } }, { changes: { gps_mode: { from: 'none', to: null } } }],
    ['a count that is a text in retention.run', 'retention.run', { sessions: 1, login_attempts: 'many', device_labels: -3, extra: 9 }, { sessions: 1, login_attempts: null, device_labels: null }],
    ['an older retention.run with three counts', 'retention.run', { sessions: 0, login_attempts: 3, device_labels: 0 }, { sessions: 0, login_attempts: 3, device_labels: 0 }],
    ['the keys that an action does not list', 'api_key.delete', { name: 'Fake key', key_prefix: 'qrk_abcd', was_revoked: true, key_hash: HEX64 }, { name: 'Fake key', was_revoked: true }],
    ['a detail with only keys that are not listed', 'api_key.delete', { key_prefix: 'qrk_abcd' }, null],
    ['a detail on an action that keeps none', 'point.regenerate_qr', { qr_token: 'BQR-abcdef123456', note: 'anything' }, null],
    ['a detail on an action that keeps none (a sign-out)', 'session.sign_out', { ip: '203.0.113.9' }, null],
    ['an empty object', 'point.delete', {}, null],
    ['a null detail', 'point.delete', null, null],
    ['an action that is not listed', 'widget.frobnicate', { name: 'Fake', count: 1 }, null],
    ['an action of another group', 'point.nope', { name: 'Fake' }, null],
    ['an action that is a name of the prototype', 'constructor', { name: 'Fake' }, null],
    ['an action that is __proto__', '__proto__', { name: 'Fake' }, null],
    ['an action that is toString', 'toString', { name: 'Fake' }, null],
    ['no action', undefined, { name: 'Fake' }, null],
    ['a detail that is a text', 'point.delete', 'just a text', null],
    ['a detail that is a number', 'point.delete', 5, null],
    ['a detail that is a list', 'point.delete', [{ name: 'Fake' }], null],
  ]
  it.each(cases)('rebuilds the value: %s', (_what, action, stored, shown) => {
    expect(agentAuditDetail(action, stored)).toEqual(shown)
  })

  it('writes the keys in the order of the allow-list, not in the order they were stored, and does not change what it was given', () => {
    const stored = { was_revoked: true, name: 'Fake', key_prefix: 'qrk_abcd' }
    const copy = JSON.parse(JSON.stringify(stored))
    expect(Object.keys(agentAuditDetail('api_key.delete', stored))).toEqual(['name', 'was_revoked'])
    expect(stored).toEqual(copy)
  })

  it('shows poisoned rows of the log (every kind of stored detail) through the route as the cases above say', async () => {
    const poison = [
      ['point.delete', { name: 'qrk_abcdef0123456789', scans_kept: 3, key_prefix: 'qrk_abcd', token: 'qra_tokentokentoken1', qr_token: 'BQR-0123456789abcdef', ip: '198.51.100.9', password: 'hunter2hunter2' }],
      ['api_key.delete', { name: 'Fake key', key_prefix: 'qrk_wxyz', was_revoked: true, key_hash: HEX64, key: 'qrk_FullKeyValueFullKeyValue123' }],
      ['scan.void', { reason: `pasted ${SECRET_LOOKING_NAME} by mistake`, label: LABEL }],
      ['provider.update', { password: 'hunter2hunter2', password_hash: 'scrypt$16384$8$1$AAAA$BBBB', password_changed: true, changes: { company: { from: 'A Ltd', to: 'B Ltd' }, password_hash: { from: 'x', to: 'y' } } }],
      ['session.sign_in', { method: 'google', ip: '198.51.100.9', user_agent: LABEL, google_sub: 'sub-poison-0001', token: 'qra_tokentokentoken1' }],
      ['widget.frobnicate', { name: 'Fake', token: 'qra_tokentokentoken1' }],
      ['scan.void', 'a text, not an object'],
      ['scan.void', 5],
      ['scan.void', [1, 2]],
      ['scan.void', null],
    ]
    await addRows(poison.map(([action, detail], i) => ({ action, entity: 'poison', entity_id: `poison-${i}`, detail })))
    const shown = (await agent('entity=poison&limit=50')).json.entries
    expect(shown).toHaveLength(poison.length)
    const byId = Object.fromEntries(shown.map((e) => [e.entity_id, e.detail]))
    expect(byId).toEqual({
      'poison-0': { name: null, scans_kept: 3 },
      'poison-1': { name: 'Fake key', was_revoked: true },
      'poison-2': { reason: null },
      'poison-3': { changes: { company: { from: 'A Ltd', to: 'B Ltd' } }, password_changed: true },
      'poison-4': { method: 'google' },
      'poison-5': null,
      'poison-6': null,
      'poison-7': null,
      'poison-8': null,
      'poison-9': null,
    })
    // None of what the poisoned rows held comes out, in any form.
    const forbidden = [
      'qrk_abcdef0123456789', 'qrk_abcd', 'qrk_wxyz', 'qra_tokentokentoken1', 'BQR-0123456789abcdef', '198.51.100.9', 'hunter2hunter2', HEX64,
      'qrk_FullKeyValueFullKeyValue123', LABEL, 'sub-poison-0001', 'scrypt$16384', 'a text, not an object',
    ]
    secrets['what the poisoned rows held'] = forbidden
    for (const value of forbidden) expect(JSON.stringify(shown), value).not.toContain(value)
    // The committee's answer still has everything, as it was stored (the log itself is not changed).
    const stored = (await committee('entity=poison&limit=50')).json.entries
    expect(stored.find((e) => e.entity_id === 'poison-1').detail.key_prefix).toBe('qrk_wxyz')
  })
})

// ======================================================================================================================
// 4. secrets
// ======================================================================================================================

describe('nothing secret is in the raw text of any page', () => {
  it('has none of the seeded secrets in any page of the whole log, whatever the page size', async () => {
    for (const limit of [200, 7]) {
      const { texts, entries } = await walk(agent, '', limit)
      expect(entries.length).toBeGreaterThan(40)
      texts.forEach((text, i) => noSecretIn(text, `page ${i + 1} of limit ${limit}`))
    }
  })

  it('has none of them in the pages of the filtered listings either (a group, a thing, a member)', async () => {
    for (const qs of ['group=api_key', 'group=provider', 'group=point', 'group=session', 'group=scan', `entity=api_key&entity_id=${world.k1.id}`, `actor_id=${adminId}`, 'group=retention', 'group=admin']) {
      const { texts } = await walk(agent, qs, 3)
      texts.forEach((text, i) => noSecretIn(text, `${qs} page ${i + 1}`))
    }
  })

  it('the committee can see what the agent cannot: the prefix of the deleted key is in the log, and not in the agent answer', async () => {
    expect(world.k1.prefix).toMatch(/^qrk_/)
    const mine = (await committee('group=api_key&limit=50')).text
    expect(mine).toContain(world.k1.prefix) // the log really holds it: the test above is not vacuous
    expect(mine).toContain('key_prefix')
    const theirs = (await agent('group=api_key&limit=50')).text
    expect(theirs).not.toContain(world.k1.prefix)
    expect(theirs).not.toContain('key_prefix')
  })

  it('the secrets that the seed made are real and are in the database (so that not finding them in an answer says something)', async () => {
    const stored = JSON.stringify((await db.pool.query('select * from audit_log')).rows)
    // The only secret that the log itself holds is the prefix of a deleted key; the others live in the other tables.
    expect(stored).toContain(world.k1.prefix)
    expect((await db.pool.query('select count(*)::int as n from points where qr_token = $1', [world.p1NewCode])).rows[0].n).toBe(1)
    expect((await db.pool.query("select count(*)::int as n from auth_attempts where key = $1", [`ip:${IP}`])).rows[0].n).toBeGreaterThan(0)
    expect((await db.pool.query('select count(*)::int as n from provider_devices where label = $1', [LABEL])).rows[0].n).toBeGreaterThan(0)
    expect((await db.pool.query('select count(*)::int as n from providers where password_hash is not null')).rows[0].n).toBeGreaterThan(0)
  })

  it('reads named columns of the log, never * (a column added later is not shown until someone adds it)', () => {
    const { sql } = auditQuery({})
    expect(sql).not.toMatch(/select\s+\*/i)
    expect(sql).not.toMatch(/\b\w+\.\*/)
    expect(sql).not.toMatch(/audit_log\.\*/)
  })
})

// ======================================================================================================================
// 5. the committee's log
// ======================================================================================================================

describe('it is the committee\'s log', () => {
  it('has the same entries in the same order with the same fields; the detail differs only by what the allow-list leaves out', async () => {
    const mine = (await walk(committee, '', 200)).entries
    const theirs = (await walk(agent, '', 200)).entries
    expect(theirs.length).toBeGreaterThan(40)
    expect(theirs.map((e) => e.id)).toEqual(mine.map((e) => e.id))
    for (const [i, e] of theirs.entries()) {
      const { detail, entity_name, actor_name, ...rest } = e
      const { detail: committeeDetail, entity_name: committeeEntity, actor_name: committeeActor, ...committeeRest } = mine[i]
      expect(rest, `${e.action} ${e.id}`).toEqual(committeeRest)
      // The two names are the committee's, or null when they look like a key.
      expect(entity_name === committeeEntity || (entity_name === null && looksSecret(committeeEntity)), `entity_name of ${e.id}`).toBe(true)
      expect(actor_name === committeeActor || (actor_name === null && looksSecret(committeeActor)), `actor_name of ${e.id}`).toBe(true)
      if (e.entity_id?.startsWith('poison-')) continue // the rows written to be cut: proved one by one above
      // A real entry: the same detail, except for the key that the allow-list leaves out (the prefix of a deleted key), and a name that
      // is shaped like a key.
      const expected = committeeDetail && typeof committeeDetail === 'object' ? { ...committeeDetail } : null
      if (expected) delete expected.key_prefix
      if (e.entity_id === world.k3.id && expected) expected.name = null
      const empty = expected === null || Object.keys(expected).length === 0
      expect(detail, `${e.action} ${e.id}`).toEqual(Object.hasOwn(PINNED, e.action) && !empty ? expected : null)
    }
  })

  it('walks the same pages with the same cursor: the cursor of the committee works on the agent and the other way round', async () => {
    const page = await committee('limit=5')
    const asAgent = await agent(`limit=5&cursor=${page.json.next_cursor}`)
    const asCommittee = await committee(`limit=5&cursor=${page.json.next_cursor}`)
    expect(asAgent.status).toBe(200)
    expect(asAgent.json.entries.map((e) => e.id)).toEqual(asCommittee.json.entries.map((e) => e.id))
    const back = await agent('limit=5')
    expect(back.json.next_cursor).toBe(page.json.next_cursor)
    expect((await committee(`limit=5&cursor=${back.json.next_cursor}`)).status).toBe(200)
  })

  it('answers the same entries for the same filters', async () => {
    const queries = [
      '', 'group=point', 'group=api_key', 'group=session', 'group=retention', 'group=admin', 'group=building', 'group=scan', 'group=provider',
      `actor_id=${adminId}`, `actor_id=${world.m2}`, `actor_id=${adminId.toUpperCase()}`, `entity=point&entity_id=${world.p1.id}`, `entity=provider&entity_id=${world.v1.id}`,
      `entity_id=${world.m3}`, 'entity=api_key', 'entity=nothing', `group=point&actor_id=${adminId}&entity=point`,
      `from=${new Date().toISOString().slice(0, 10)}`, `to=${new Date().toISOString().slice(0, 10)}`, 'from=2000-01-02&to=2000-01-03', 'from=2100-01-01', 'from=2026-12-11&to=2026-12-10',
      'from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z', 'group=&actor_id=&entity=&entity_id=&from=&to=&cursor=&unknown=1&format=csv',
    ]
    for (const qs of queries) {
      const a = await agent(`${qs}${qs ? '&' : ''}limit=200`)
      const c = await committee(`${qs}${qs ? '&' : ''}limit=200`)
      expect(a.status, qs).toBe(200)
      expect(c.status, qs).toBe(200)
      expect(a.json.entries.map((e) => e.id), qs).toEqual(c.json.entries.map((e) => e.id))
      expect(a.json.next_cursor, qs).toBe(c.json.next_cursor)
    }
  })

  it('ignores a format parameter: the answer is always JSON (there is no CSV of the log)', async () => {
    const r = await agent('format=csv&limit=2')
    expect(r.headers['content-type']).toMatch(/^application\/json/)
    expect(r.json.entries).toHaveLength(2)
  })
})

// ======================================================================================================================
// filters, paging, validation
// ======================================================================================================================

describe('filters, paging and validation', () => {
  beforeAll(async () => {
    // Rows of known times (the borders of building days in Asia/Jerusalem, UTC+3 in October), and a few hundred more so that the page
    // size can be seen. They are about nothing and have an action that is in no list: their detail is null.
    await addRows(
      [
        ['a', '2026-10-04T20:59:59.999Z'], // 04/10 in the building, 23:59:59.999
        ['b', '2026-10-04T21:00:00Z'], // 05/10 in the building, the first moment
        ['c', '2026-10-05T20:59:59.999999Z'], // 05/10, the last moment
        ['d', '2026-10-05T21:00:00Z'], // 06/10
      ].map(([n, at]) => ({ at, action: 'test.border', entity: 'border', entity_id: n })),
    )
    await db.pool.query(
      `insert into audit_log (at, actor_type, actor_id, actor_name, action, entity, entity_id, detail)
       select timestamptz '2026-01-01 00:00:00+00' + (g * interval '1 minute'), 'admin', $1, 'Bulk Member', 'test.bulk', 'bulk', 'bulk-' || g, '{"n":1}'
         from generate_series(1, 250) g`,
      [adminId],
    )
  })

  it('filters by day in the building time zone, on the borders, as the committee does', async () => {
    const ids = async (qs) => (await agent(`entity=border&${qs}`)).json.entries.map((e) => e.entity_id)
    expect(await ids('from=2026-10-05&to=2026-10-05')).toEqual(['c', 'b'])
    expect(await ids('from=2026-10-04&to=2026-10-04')).toEqual(['a'])
    expect(await ids('from=2026-10-06&to=2026-10-06')).toEqual(['d'])
    expect(await ids('from=2026-10-05')).toEqual(['d', 'c', 'b'])
    expect(await ids('to=2026-10-05')).toEqual(['c', 'b', 'a'])
    expect(await ids('from=2026-10-04T21:00:00Z&to=2026-10-04T21:00:00Z')).toEqual(['b'])
    expect(await ids('from=2026-10-05T00:00:00%2B03:00&to=2026-10-05T00:00:00%2B03:00')).toEqual(['b'])
    expect(await ids('from=2026-10-06&to=2026-10-05')).toEqual([])
  })

  it('filters by group (each group of the list), by actor, and by a thing', async () => {
    for (const group of AUDIT_GROUPS) {
      const { entries } = (await agent(`group=${group}&limit=200`)).json
      expect(entries.length, group).toBeGreaterThan(0)
      for (const e of entries) expect(e.action.startsWith(`${group}.`), `${group}: ${e.action}`).toBe(true)
    }
    const mine = (await agent(`actor_id=${world.m2}&limit=200`)).json.entries
    expect(mine.length).toBeGreaterThan(0)
    for (const e of mine) expect(e.actor_id).toBe(world.m2)
    const thing = (await agent(`entity=point&entity_id=${world.p1.id}&limit=200`)).json.entries
    expect(thing.map((e) => e.action).reverse()).toEqual(['point.create', 'point.update', 'point.update', 'point.update', 'point.regenerate_qr'])
    // `_` is not a wildcard: api_key is a group, and apiXkey would not be.
    await addRows([{ action: 'apiXkey.create', entity: 'api_key', entity_id: 'poison-trap' }])
    expect((await agent('group=api_key&limit=200')).json.entries.some((e) => e.action === 'apiXkey.create')).toBe(false)
  })

  it('uses the default page size, cuts a larger limit to the maximum, and ends with a null cursor', async () => {
    expect(DEFAULT_PAGE_SIZE).toBe(100)
    expect(MAX_AUDIT_PAGE_SIZE).toBe(200)
    const normal = await agent('')
    expect(normal.json.entries).toHaveLength(DEFAULT_PAGE_SIZE)
    expect(normal.json.count).toBe(DEFAULT_PAGE_SIZE)
    expect(typeof normal.json.next_cursor).toBe('string')
    for (const limit of [MAX_AUDIT_PAGE_SIZE, MAX_AUDIT_PAGE_SIZE + 1, 100_000]) {
      const r = await agent(`limit=${limit}`)
      expect(r.status).toBe(200)
      expect(r.json.entries).toHaveLength(MAX_AUDIT_PAGE_SIZE)
    }
    expect((await agent('entity=border&limit=200')).json.next_cursor).toBeNull()
  })

  it('walks the whole log to the end exactly once, in the order of the database, whatever the page size', async () => {
    const { rows } = await db.pool.query('select id::text as id_text from audit_log order by at desc, id desc')
    const expected = rows.map((r) => r.id_text)
    expect(expected.length).toBeGreaterThan(300)
    for (const limit of [MAX_AUDIT_PAGE_SIZE, 97]) {
      const { entries, sizes } = await walk(agent, '', limit)
      expect(entries.map((e) => String(e.id)), `limit ${limit}`).toEqual(expected)
      expect(Math.max(...sizes)).toBeLessThanOrEqual(limit)
      expect(sizes.slice(0, -1).every((n) => n === limit), 'every page but the last is full').toBe(true)
      expect(sizes.at(-1)).toBeGreaterThan(0)
    }
  }, 120_000)

  it('refuses a bad parameter with the status, the code and the field of the committee\'s route', async () => {
    const bad = [
      'from=2026-02-30', 'to=2026-13-01', 'from=yesterday', 'from=2026-06-01T10:00:00', 'to=1999-01-01T00:00:00Z', 'group=nope', 'group=POINT', 'group=point.update',
      'actor_id=abc', 'actor_id=123', 'limit=0', 'limit=-3', 'limit=1.5', 'limit=abc', 'cursor=zzz', `cursor=${Buffer.from('not json').toString('base64url')}`,
      `cursor=${Buffer.from(JSON.stringify({ t: '2026-05-01T08:00:00.000Z', id: randomUUID() })).toString('base64url')}`, // a cursor of the scans list
      `cursor=${Buffer.from(JSON.stringify({ t: '2026-05-01T08:00:00.000000Z', id: '0' })).toString('base64url')}`,
    ]
    for (const qs of bad) {
      const a = await agent(qs)
      const c = await committee(qs)
      expect(a.status, qs).toBe(400)
      expect(a.status, qs).toBe(c.status)
      expect(a.json.error.code, qs).toBe(c.json.error.code)
      expect(a.json.error.field, qs).toBe(c.json.error.field)
    }
    expect((await agent('group=nope')).json.error).toMatchObject({ code: 'invalid_filter', field: 'group' })
    expect((await agent('actor_id=abc')).json.error).toMatchObject({ code: 'invalid_filter', field: 'actor_id' })
    expect((await agent('cursor=zzz')).json.error.code).toBe('invalid_cursor')
    expect(JSON.stringify(schemaDoc.errors.invalid_filter)).toMatch(/group.*actor_id/)
  })

  it('reads exactly the filters of AUDIT_FILTERS, and the registry lists them', () => {
    const reads = new Set()
    const base = {
      from: '2026-01-01', to: '2100-01-01', group: 'point', actor_id: randomUUID(), entity: 'point', entity_id: randomUUID(), limit: '5',
      cursor: Buffer.from(JSON.stringify({ t: '2026-05-01T08:00:00.000000Z', id: '5' })).toString('base64url'),
    }
    auditQuery(new Proxy(base, { get: (target, prop) => (typeof prop === 'string' ? (reads.add(prop), target[prop]) : target[prop]) }))
    expect([...reads].sort()).toEqual([...AUDIT_FILTERS].sort())
    expect(openApiDocument.paths['/audit'].get.parameters.map((p) => p.name)).toEqual([...AUDIT_FILTERS])
  })
})

// ======================================================================================================================
// 6. a new action without an entry is caught
// ======================================================================================================================

/** The text of the arguments of every call `audit(...)` in a source, comments left out: a list of lists of argument texts. */
function auditCalls(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const calls = []
  const re = /(?<![\w.])audit\(/g
  let m
  while ((m = re.exec(text))) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue // the declaration, not a call
    const args = []
    let depth = 0
    let start = m.index + m[0].length
    let quote = null
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) {
        if (depth === 0) {
          args.push(text.slice(start, i).trim())
          break
        }
        depth--
      } else if (ch === ',' && depth === 0) {
        args.push(text.slice(start, i).trim())
        start = i + 1
      }
    }
    calls.push(args)
  }
  return calls
}

/** The actions that a source writes: the string literals of the third argument of each call (a ternary has two). */
function actionsWritten(source, where) {
  const found = new Set()
  const problems = []
  for (const args of auditCalls(source)) {
    if (args.length < 3) continue // not a call of ours: the word "audit()" in a text
    const literals = [...(args[2] ?? '').matchAll(/(['"`])([a-z_]+\.[a-z_]+)\1/g)].map((x) => x[2])
    if (!literals.length) problems.push(`${where}: a call of audit() whose action is not a string literal ("${args[2]}"): the allow-list cannot know it.`)
    for (const action of literals) found.add(action)
  }
  return { found, problems }
}

const sourceFiles = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(relative)
    return /\.(js|mjs)$/.test(entry.name) ? [relative] : []
  })

describe('a new action without an entry in the allow-list is caught', () => {
  it('every action that server/ and scripts/ write with audit() has an entry in the allow-list, and every entry is written by something', () => {
    const written = new Set()
    const problems = []
    for (const file of [...sourceFiles('server'), ...sourceFiles('scripts')]) {
      const { found, problems: more } = actionsWritten(fs.readFileSync(path.join(ROOT, file), 'utf8'), file)
      problems.push(...more)
      for (const action of found) {
        written.add(action)
        if (!Object.hasOwn(AUDIT_DETAIL_ALLOW, action)) problems.push(`${file} writes the action "${action}", which has no entry in AUDIT_DETAIL_ALLOW (server/audit.js): add one, with the keys of its detail that the agent may be shown (an empty entry if none).`)
      }
    }
    for (const action of Object.keys(AUDIT_DETAIL_ALLOW)) {
      if (!written.has(action)) problems.push(`AUDIT_DETAIL_ALLOW has the action "${action}", which nothing in server/ or scripts/ writes with audit(): remove it, or write it.`)
    }
    expect(written.size).toBeGreaterThanOrEqual(22)
    expect(problems.join('\n')).toBe('')
  })

  it('the reader of the sources is not vacuous: it finds a new action, a ternary, and a computed one', () => {
    const source = `
      // audit(c, actor, 'in.a_comment', {})
      export async function audit(c, actor, action) {}
      await audit(c, adminActor(admin), 'widget.frobnicate', { entity: 'widget', detail: { a: 1, b: [1, 2] } })
      await audit(c, { type: 'system', id: null, name: null }, flag ? 'widget.on' : 'widget.off', { detail: { text: 'a, b)' } })
      await audit(c, actor, name, {})
    `
    const { found, problems } = actionsWritten(source, 'sample')
    expect([...found].sort()).toEqual(['widget.frobnicate', 'widget.off', 'widget.on'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('not a string literal')
    expect([...found].filter((a) => !Object.hasOwn(AUDIT_DETAIL_ALLOW, a)).sort()).toEqual(['widget.frobnicate', 'widget.off', 'widget.on'])
  })

  it('the table at the top of server/audit.js, the allow-list, the groups and the documents name the same actions', () => {
    const header = fs.readFileSync(path.join(ROOT, 'server/audit.js'), 'utf8').split("import pg from 'pg'")[0]
    const inTable = [...header.matchAll(/^\/\/ {3}([a-z_]+\.[a-z_]+)\s/gm)].map((m) => m[1])
    expect(inTable.sort()).toEqual(Object.keys(AUDIT_DETAIL_ALLOW).sort())
    expect(Object.keys(schemaDoc.audit_actions).sort()).toEqual(Object.keys(AUDIT_DETAIL_ALLOW).sort())
    for (const action of Object.keys(AUDIT_DETAIL_ALLOW)) expect(AUDIT_GROUPS, action).toContain(action.split('.')[0])
    for (const group of AUDIT_GROUPS) expect(Object.keys(AUDIT_DETAIL_ALLOW).some((a) => a.startsWith(`${group}.`)), `a group with no action: ${group}`).toBe(true)
    // Each action says which entity it is about, and the real entries agree.
    for (const [action, row] of Object.entries(schemaDoc.audit_actions)) {
      expect(Object.keys(row.detail).sort(), `${action} detail keys`).toEqual(Object.keys(AUDIT_DETAIL_ALLOW[action]).sort())
    }
  })

  it('an entry whose action is not in the allow-list shows no detail, whatever its detail holds (it fails closed)', async () => {
    await addRows([
      { action: 'widget.frobnicate', entity: 'widget', entity_id: 'poison-new-action', detail: { name: 'Fake', password: 'hunter2hunter2', key_prefix: 'qrk_abcd', count: 3 } },
      { action: 'point.frobnicate', entity: 'point', entity_id: 'poison-new-verb', detail: { name: 'Fake' } },
    ])
    const found = (await agent('limit=20&entity_id=poison-new-action')).json.entries
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ action: 'widget.frobnicate', entity: 'widget', detail: null })
    const verb = (await agent('limit=20&entity_id=poison-new-verb')).json.entries
    expect(verb[0]).toMatchObject({ action: 'point.frobnicate', detail: null })
    expect(JSON.stringify(found) + JSON.stringify(verb)).not.toContain('hunter2')
  })

  it('refuses at start an allow-list that the reader cannot read: an unknown kind, an enum with no words, a bad action, an unknown group', () => {
    const fine = { 'point.delete': { name: 'text', scans_kept: 'count' } }
    expect(() => checkAuditAllowList(fine)).not.toThrow()
    expect(() => checkAuditAllowList(AUDIT_DETAIL_ALLOW)).not.toThrow() // the list that the server loaded
    expect(() => checkAuditAllowList({ 'point.delete': { name: 'texts' } })).toThrow(/point\.delete\.name has the kind "texts"/)
    expect(() => checkAuditAllowList({ 'point.delete': { name: { kind: 'enum', values: [] } } })).toThrow(/enum with no values/)
    expect(() => checkAuditAllowList({ 'point.update': { changes: { kind: 'changes', fields: { name: 'texts' } } } })).toThrow(/point\.update\.changes\.name has the kind "texts"/)
    expect(() => checkAuditAllowList({ pointdelete: { name: 'text' } })).toThrow(/is not "<group>\.<verb>"/)
    expect(() => checkAuditAllowList({ 'widget.frobnicate': { name: 'text' } })).toThrow(/with a group of AUDIT_GROUPS/)
    expect(() => checkAuditAllowList({ 'point.Delete': { name: 'text' } })).toThrow(/is not "<group>\.<verb>"/)
  })
})

// ======================================================================================================================
// 7. the documents fit
// ======================================================================================================================

const plain = (value) => JSON.parse(JSON.stringify(value))
const doc = plain(openApiDocument)
const rewrite = (value) => JSON.parse(JSON.stringify(value).replaceAll('#/components/schemas/', '#/$defs/'))
/** A copy in which every object that lists properties is closed: a key that the schema does not list is a failure. */
function closed(value) {
  if (Array.isArray(value)) return value.map(closed)
  if (!value || typeof value !== 'object') return value
  const copy = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, closed(inner)]))
  if (copy.properties && typeof copy.properties === 'object' && copy.additionalProperties === undefined) copy.additionalProperties = false
  return copy
}
const validatorOf = (name) =>
  addFormats(new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true })).compile({ $ref: `#/$defs/${name}`, $defs: closed(rewrite(doc.components.schemas)) })
const errorsOf = (validate) => (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)

describe('the documents fit the real answers', () => {
  it('every page of the whole log validates against AuditList, closed', async () => {
    const validate = validatorOf('AuditList')
    const { texts } = await walk(agent, '', 50)
    expect(texts.length).toBeGreaterThan(5)
    texts.forEach((text, i) => expect(validate(JSON.parse(text)), `page ${i + 1}: ${errorsOf(validate).slice(0, 3).join('; ')}`).toBe(true))
  })

  it('the detail of every entry validates against the schema of ITS OWN action, closed', async () => {
    const { entries } = await walk(agent, '', 200)
    const validators = {}
    let checked = 0
    for (const e of entries) {
      if (e.detail === null) continue
      expect(Object.hasOwn(PINNED, e.action), `a detail on the unlisted action ${e.action}`).toBe(true)
      const name = auditDetailSchemaName(e.action)
      expect(doc.components.schemas[name], `the schema ${name}`).toBeTruthy()
      const validate = (validators[name] ??= validatorOf(name))
      expect(validate(e.detail), `${e.action} ${e.id}: ${errorsOf(validate).slice(0, 3).join('; ')}`).toBe(true)
      checked++
    }
    expect(checked).toBeGreaterThan(30)
    // Every action that has keys was checked at least once (the seed has every one).
    const seen = new Set(entries.filter((e) => e.detail !== null).map((e) => e.action))
    for (const [action, keys] of Object.entries(PINNED)) if (keys.length) expect(seen.has(action), action).toBe(true)
  })

  it('the check is not vacuous: a key that is not allowed, a value of the wrong kind and a missing pair all fail', () => {
    const point = validatorOf(auditDetailSchemaName('point.update'))
    expect(point({ changes: { name: { from: 'a', to: 'b' } }, provider_ids: { added: [], removed: [] } })).toBe(true)
    expect(point({ qr_token: 'BQR-abcdef123456' })).toBe(false)
    expect(point({ changes: { qr_token: { from: 'a', to: 'b' } } })).toBe(false)
    expect(point({ changes: { name: { from: 'a' } } })).toBe(false)
    expect(point({ changes: { gps_mode: { from: 'sometimes', to: null } } })).toBe(false)
    expect(point({ provider_ids: { added: ['not-an-id'], removed: [] } })).toBe(false)
    expect(point({ lat: '31.5' })).toBe(false)
    const del = validatorOf(auditDetailSchemaName('api_key.delete'))
    expect(del({ name: 'Fake', was_revoked: true })).toBe(true)
    expect(del({ name: 'Fake', key_prefix: 'qrk_abcd' })).toBe(false)
    const list = validatorOf('AuditList')
    const entry = { id: 1, at: new Date().toISOString(), action: 'api_key.delete', entity: 'api_key', entity_id: null, entity_name: null, actor_type: 'admin', actor_id: null, actor_name: null, actor_deleted: false, detail: { name: 'Fake', was_revoked: true } }
    const page = (changes) => ({ entries: [{ ...entry, ...changes }], count: 1, next_cursor: null })
    expect(list(page({}))).toBe(true)
    expect(list(page({ detail: { name: 'Fake', key_prefix: 'qrk_abcd' } }))).toBe(false)
    expect(list(page({ detail: { name: 5 } }))).toBe(false)
    expect(list(page({ actor_type: 'robot' }))).toBe(false)
    expect(list(page({ extra: 1 }))).toBe(false)
  })

  it('the schemas of the pairs and lists inside a detail require all their keys', () => {
    const problems = []
    const walkSchema = (schema, where) => {
      if (!schema || typeof schema !== 'object') return
      if (Array.isArray(schema)) return schema.forEach((s, i) => walkSchema(s, `${where}[${i}]`))
      if (schema.properties && schema.required) {
        if ([...schema.required].sort().join() !== Object.keys(schema.properties).sort().join()) problems.push(`${where} does not require all its properties`)
      }
      for (const [key, inner] of Object.entries(schema)) walkSchema(inner, `${where}.${key}`)
    }
    for (const [name, schema] of Object.entries(doc.components.schemas)) if (name.startsWith('AuditDetail')) walkSchema(schema, name)
    // The pairs: every { from, to } and { added, removed } object is all-required, and the other objects have no required list.
    const pair = doc.components.schemas.AuditDetailPointUpdate.properties.changes.properties.name
    expect(pair.required).toEqual(['from', 'to'])
    expect(doc.components.schemas.AuditDetailPointUpdate.properties.provider_ids.anyOf[1].required).toEqual(['added', 'removed'])
    expect(problems).toEqual([])
  })

  it('/schema describes the endpoint, its fields, groups, actions and what a detail may hold, and says that no secret is shown', async () => {
    const served = (await call('GET', '/api/agent/v1/schema', { token: await currentKey() })).json
    expect(served.endpoints['GET /api/agent/v1/audit']).toContain('Returns { entries, count, next_cursor }')
    expect(Object.keys(served.audit_fields)).toEqual([...AGENT_AUDIT_FIELDS])
    expect(Object.keys(served.audit_groups).sort()).toEqual([...AUDIT_GROUPS].sort())
    expect(Object.keys(served.audit_actions).sort()).toEqual(Object.keys(PINNED).sort())
    expect(served.audit_detail).toMatch(/never holds a key \(not even its first characters\), a token, a hash, a password/)
    expect(served.audit_detail).toMatch(/append-only/)
  })
})

// ======================================================================================================================
// 8. a column added to the table later
// ======================================================================================================================

describe('a column added to the table later does not reach the agent', () => {
  it('stays out of every page, and the statement does not change', async () => {
    await db.pool.query("alter table audit_log add column fake_secret text default 'fake-secret-marker-9921'")
    const { texts } = await walk(agent, '', 200)
    for (const text of texts) {
      expect(text).not.toContain('fake_secret')
      expect(text).not.toContain('fake-secret-marker-9921')
    }
    const { entries } = await walk(agent, '', 200)
    for (const e of entries) expect(Object.keys(e)).toEqual([...AGENT_AUDIT_FIELDS])
  })
})
