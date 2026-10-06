// The first committee member of a deployment signs in through FIRST_ADMIN_EMAIL (server/firstAdmin.js, called by POST
// /admin/google; the rules are in AGENTS.md, Safety and Code Review Rules). Proved here:
//   - the success: an empty committee list and the matching verified e-mail give 200, the cookie, the member (with the Google
//     account and name) and exactly two audit rows in order: `admin.add` by the `system` actor, then `session.sign_in` by the member;
//   - the refusals (403 `not_an_admin`, nothing written: the whole schema is as it was, apart from the throttle's `auth_attempts`,
//     which counts whatever happens): another e-mail, a variable that is unset, empty or not an e-mail, a list that holds one
//     member who is switched off, a list that holds another active member; and an e-mail that Google did not verify, with the real
//     verifier, is refused as it always was (401);
//   - case and spaces around the variable and around the Google e-mail do not matter;
//   - the lock: two first sign-ins that both passed the lookup wait for each other (one member, one `admin.add`, both succeed), a
//     `create-admin` that is writing at the same moment makes the sign-in wait and then refuse, and a sign-in that is in the middle
//     of its transaction makes a `create-admin` wait;
//   - one transaction: when `admin.add` or `session.sign_in` is refused by the database the answer is 500 and no member exists, and
//     a retry works;
//   - once the list has a member the variable adds nobody (a new address in it, or the same one);
//   - the value of the variable is never in a log line or in a refusal.
// The data is fake.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import { setupDb, call } from './helpers.js'
import '../server/index.js' // registers every route
import { createGoogleVerifier, setGoogleVerifier } from '../server/google.js'
import { tx } from '../server/db.js'
import { addCommitteeMember } from '../scripts/create-admin.mjs'
import { EMAIL_MAX_LENGTH } from '../shared/contract.js'

const FIRST = 'first.admin@test.local'
const OTHER = 'someone.else@test.local'

let db, helper, savedVariable

// The test's own statements run on one connection of their own, outside a transaction (each is one round trip instead of three).
const q = (text, params) => helper.query(text, params)
const one = async (text, params) => (await q(text, params)).rows[0]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The verifier of tests/helpers.js: the credential is the e-mail, the name is 'Test Admin' and the Google account 'sub-<e-mail>'.
const defaultGoogle = async (credential) => ({
  email: String(credential).toLowerCase(), name: 'Test Admin', sub: 'sub-' + String(credential).toLowerCase(),
})
/** Google answers with exactly this, whatever the credential (so that an e-mail can have spaces or capitals, as the stub of helpers cannot). */
const googleIs = (google) => setGoogleVerifier(async () => google)
const googleOf = (email, over = {}) => ({ email, name: 'First Admin', sub: 'google-sub-first', ...over })

const variableIs = (value) => {
  if (value === undefined) delete process.env.FIRST_ADMIN_EMAIL
  else process.env.FIRST_ADMIN_EMAIL = value
}

const signIn = (email = FIRST, options = {}) => call('POST', '/api/admin/google', { body: { credential: email }, ...options })
const cookieOf = (answer) => String(answer.headers['set-cookie']).split(';')[0]
const meStatus = async (cookie) => (await call('GET', '/api/admin/me', { cookie })).status

const admins = async () => (await q('select * from admins order by created_at, email')).rows
const lastAuditId = async () => (await one('select coalesce(max(id), 0)::int as n from audit_log')).n
const rowsAfter = async (after) => (await q('select * from audit_log where id > $1 order by id', [after])).rows

// ---------- the state of the whole schema ----------

let TABLES
/** Every row of every table of the schema, as JSON, by table name: the state of the whole database, in one round trip. */
async function snapshot() {
  TABLES ??= (
    await q(
      `select table_name as name from information_schema.tables
        where table_schema = current_schema() and table_type = 'BASE TABLE' order by 1`,
    )
  ).rows.map((r) => r.name)
  const parts = TABLES.map(
    (name) => `'${name}', (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) from "${name}" t)`,
  )
  return (await q(`select jsonb_build_object(${parts.join(', ')}) as state`)).rows[0].state
}
/** The snapshot without the tables that a request writes whatever its answer is (the login throttle). */
async function snapshotWithout(...skipped) {
  return Object.fromEntries(Object.entries(await snapshot()).filter(([name]) => !skipped.includes(name)))
}

/**
 * What a failed call leaves behind: nothing, except the record of its own 500 (server/errorLog.js): the whole schema is as it was
 * in `before` (taken with snapshotWithout('auth_attempts')), apart from app_errors, where exactly one event was added for
 * `POST /admin/google` with the status 500 and nothing else.
 */
async function expectOnlyTheRecordOfTheFailure(before) {
  const { app_errors: errorsBefore, ...restBefore } = before
  const { app_errors: errorsAfter, ...restAfter } = await snapshotWithout('auth_attempts')
  expect(restAfter, 'a failed sign-in changed the database').toEqual(restBefore)
  const events = (rows) => rows.reduce((sum, r) => sum + r.count, 0)
  expect(events(errorsAfter), 'one event recorded for the failed call').toBe(events(errorsBefore) + 1)
  const changed = errorsAfter.filter((r) => errorsBefore.find((b) => b.id === r.id)?.count !== r.count)
  expect(changed).toHaveLength(1)
  expect(changed[0]).toMatchObject({ source: 'server', kind: 'error', place: '/admin/google', method: 'POST', status: 500 })
}

// ---------- what the test needs from the database ----------

/** Runs `fn` while every new row of audit_log with this action is refused by the database. The constraint is dropped after. */
async function refusingAudit(action, fn) {
  const name = `refuse_${action.replace(/\W/g, '_')}`
  await q(`alter table audit_log add constraint ${name} check (action <> '${action}') not valid`)
  try {
    return await fn()
  } finally {
    await q(`alter table audit_log drop constraint ${name}`)
  }
}

/** Runs `fn` with every console method recorded and silenced (a 500 logs a line by design); returns the result and the lines. */
async function recordingTheConsole(fn) {
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
  try {
    const result = await fn()
    const lines = spies.flatMap((spy) => spy.mock.calls).map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    return { result, lines }
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

/** How many statements that start with `text` are waiting for a lock right now (any connection of this database). */
const waitingFor = async (text) =>
  (await one(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query ilike $1`,
    [`${text}%`],
  )).n

async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await sleep(25)
  }
  throw new Error(`gave up waiting for ${what}`)
}

/** A connection of its own with a transaction open, for a test that holds a lock or a write while a request runs. */
async function openTransaction() {
  const client = await db.pool.connect()
  await client.query('begin')
  let done = false
  return {
    client,
    async end(how = 'commit') {
      if (done) return
      done = true
      try {
        await client.query(how)
      } finally {
        client.release()
      }
    },
  }
}

beforeAll(async () => {
  db = await setupDb()
  helper = await db.pool.connect()
  savedVariable = process.env.FIRST_ADMIN_EMAIL
})
afterAll(async () => {
  variableIs(savedVariable)
  helper?.release()
  await db?.teardown()
})
beforeEach(async () => {
  await q('delete from admins') // an empty committee list (the sessions go with their members); the audit log is append-only and stays
  variableIs(FIRST)
  setGoogleVerifier(defaultGoogle)
})
afterEach(() => {
  variableIs(undefined)
  setGoogleVerifier(defaultGoogle)
})

describe('the first sign-in adds the member named in FIRST_ADMIN_EMAIL', () => {
  it('answers 200 with the cookie, and writes the member, a session and exactly two audit rows, in order', async () => {
    const after = await lastAuditId()
    const answer = await signIn(FIRST)
    expect(answer.status, answer.text).toBe(200)
    expect(String(answer.headers['set-cookie'])).toMatch(/^qr_admin=qra_/)

    const [member, ...others] = await admins()
    expect(others).toEqual([])
    expect(member).toMatchObject({ email: FIRST, name: 'Test Admin', google_sub: `sub-${FIRST}`, is_active: true })
    expect(member.last_login_at).not.toBeNull()
    expect(answer.json).toEqual({ admin: { id: member.id, email: FIRST, name: 'Test Admin' } })
    expect((await one('select count(*)::int as n from admin_sessions where admin_id = $1', [member.id])).n).toBe(1)
    expect(await meStatus(cookieOf(answer))).toBe(200)

    const rows = await rowsAfter(after)
    expect(rows.map((r) => r.action)).toEqual(['admin.add', 'session.sign_in'])
    expect(rows[0]).toMatchObject({ actor_type: 'system', actor_id: null, actor_name: null, entity: 'admin', entity_id: member.id })
    expect(rows[0].detail).toEqual({ email: FIRST })
    expect(rows[1]).toMatchObject({
      actor_type: 'admin', actor_id: member.id, actor_name: 'Test Admin', entity: 'admin', entity_id: member.id,
    })
    expect(rows[1].detail).toEqual({ method: 'google' })
  })

  it('goes on as for any member the next time: one session.sign_in, no second admin.add, the same member', async () => {
    const first = await signIn(FIRST)
    const [member] = await admins()
    const after = await lastAuditId()
    const again = await signIn(FIRST)
    expect(again.status, again.text).toBe(200)
    expect(await admins()).toHaveLength(1)
    expect((await rowsAfter(after)).map((r) => [r.action, r.actor_type])).toEqual([['session.sign_in', 'admin']])
    expect(again.json.admin.id).toBe(member.id)
    expect(await meStatus(cookieOf(first))).toBe(200)
  })

  it('names the member by the Google name, which can be empty, and keeps the audit entry readable', async () => {
    googleIs(googleOf(FIRST, { name: '' }))
    const after = await lastAuditId()
    const answer = await signIn()
    expect(answer.status, answer.text).toBe(200)
    expect(answer.json.admin.name).toBe('')
    expect((await admins())[0]).toMatchObject({ email: FIRST, name: '', google_sub: 'google-sub-first' })
    expect((await rowsAfter(after)).map((r) => r.action)).toEqual(['admin.add', 'session.sign_in'])
  })

  it.each([
    ['the variable', '  First.Admin@TEST.local \t', FIRST],
    ['the Google e-mail', FIRST, '\tFIRST.ADMIN@test.Local  '],
    ['both', ' \tFIRST.admin@Test.LOCAL ', '  First.Admin@test.local\t '],
  ])('does not mind capitals or spaces around %s: the member is stored trimmed and in lower case', async (_who, variable, google) => {
    variableIs(variable)
    googleIs(googleOf(google))
    const after = await lastAuditId()
    const answer = await signIn()
    expect(answer.status, answer.text).toBe(200)
    expect(answer.json.admin.email).toBe(FIRST)
    expect((await admins()).map((m) => m.email)).toEqual([FIRST])
    const rows = await rowsAfter(after)
    expect(rows.map((r) => r.action)).toEqual(['admin.add', 'session.sign_in'])
    expect(rows[0].detail).toEqual({ email: FIRST })
  })

  it('works end to end with the real verifier: a token that Google signed, with the e-mail verified', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] })
    setGoogleVerifier(createGoogleVerifier({ clientId: 'first-admin-test.apps.googleusercontent.com', keys }))
    const token = (claims) =>
      new SignJWT({ email: 'First.Admin@Test.Local', email_verified: true, name: 'The First Admin', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com').setAudience('first-admin-test.apps.googleusercontent.com')
        .setSubject('google-sub-real').setIssuedAt().setExpirationTime('10m')
        .sign(privateKey)

    // An e-mail that Google did not verify (false, the text "true", or no claim at all) is refused as it always was, before the
    // list is looked at: 401, and nothing is written.
    for (const verified of [false, 'true', undefined]) {
      const before = await snapshotWithout('auth_attempts')
      const refused = await signIn(await token({ email_verified: verified }))
      expect([refused.status, refused.json.error.code], String(verified)).toEqual([401, 'google_email_unverified'])
      expect(refused.headers['set-cookie']).toBeUndefined()
      expect(await snapshotWithout('auth_attempts')).toEqual(before)
    }
    expect(await admins()).toEqual([])

    const answer = await signIn(await token())
    expect(answer.status, answer.text).toBe(200)
    expect(await admins()).toMatchObject([{ email: FIRST, name: 'The First Admin', google_sub: 'google-sub-real' }])
  })
})

describe('a refusal is the one that every stranger gets, and writes nothing', () => {
  const REFUSALS = [
    ['another e-mail than the variable', FIRST, OTHER],
    ['an e-mail that only differs by a plus tag', FIRST, 'first.admin+1@test.local'],
    ['an e-mail that only starts or ends like the variable', FIRST, `x${FIRST}`],
    ['the variable unset', undefined, FIRST],
    ['the variable empty', '', FIRST],
    ['the variable of spaces only', '  \t ', FIRST],
    ['a variable that is not an e-mail (no @)', 'not-an-email', 'not-an-email'],
    ['a variable with no dot after the @', 'first@localhost', 'first@localhost'],
    ['a variable with a space inside', 'first admin@test.local', 'first admin@test.local'],
    ['a variable with two @', 'first@@test.local', 'first@@test.local'],
    ['a variable longer than an e-mail of the committee may be', `${'a'.repeat(EMAIL_MAX_LENGTH)}@test.local`, `${'a'.repeat(EMAIL_MAX_LENGTH)}@test.local`],
  ]

  it.each(REFUSALS)('%s', async (_name, variable, google) => {
    variableIs(variable)
    googleIs(googleOf(google))
    const before = await snapshotWithout('auth_attempts')
    const answer = await signIn()
    expect([answer.status, answer.json.error.code]).toEqual([403, 'not_an_admin'])
    expect(answer.headers['set-cookie']).toBeUndefined()
    expect(await snapshotWithout('auth_attempts')).toEqual(before)
    expect(await admins()).toEqual([])
  })

  it('refuses when the list holds one member who is switched off (the variable never brings anybody back)', async () => {
    await q("insert into admins (email, name, is_active) values ('old.member@test.local', 'Old Member', false)")
    const before = await snapshotWithout('auth_attempts')
    const answer = await signIn(FIRST)
    expect([answer.status, answer.json.error.code]).toEqual([403, 'not_an_admin'])
    expect(await snapshotWithout('auth_attempts')).toEqual(before)
    expect((await admins()).map((m) => [m.email, m.is_active])).toEqual([['old.member@test.local', false]])
  })

  it('refuses when the one member who is switched off has the very e-mail of the variable (it is not switched on)', async () => {
    await q('insert into admins (email, name, is_active) values ($1, $2, false)', [FIRST, 'Switched Off'])
    const before = await snapshotWithout('auth_attempts')
    const answer = await signIn(FIRST)
    expect([answer.status, answer.json.error.code]).toEqual([403, 'not_an_admin'])
    expect(answer.headers['set-cookie']).toBeUndefined()
    expect(await snapshotWithout('auth_attempts')).toEqual(before)
    expect((await admins()).map((m) => [m.email, m.is_active, m.google_sub])).toEqual([[FIRST, false, null]])
  })

  it('refuses when the list holds another active member', async () => {
    await q("insert into admins (email, name) values ('active.member@test.local', 'Active Member')")
    const before = await snapshotWithout('auth_attempts')
    const answer = await signIn(FIRST)
    expect([answer.status, answer.json.error.code]).toEqual([403, 'not_an_admin'])
    expect(answer.headers['set-cookie']).toBeUndefined()
    expect(await snapshotWithout('auth_attempts')).toEqual(before)
    expect((await admins()).map((m) => m.email)).toEqual(['active.member@test.local'])
  })

  it('refuses when the list holds several members, and when all of them are switched off', async () => {
    await q("insert into admins (email, name, is_active) values ('a@test.local', '', false), ('b@test.local', '', false)")
    const before = await snapshotWithout('auth_attempts')
    expect((await signIn(FIRST)).json.error.code).toBe('not_an_admin')
    expect(await snapshotWithout('auth_attempts')).toEqual(before)
  })

  it('does not add the e-mail of the variable to a list that has a member: a new address in the variable creates nobody', async () => {
    expect((await signIn(FIRST)).status).toBe(200) // the first sign-in makes the first member
    const NEW = 'new.address@test.local'
    variableIs(NEW)
    const before = await snapshotWithout('auth_attempts')
    const answer = await signIn(NEW)
    expect([answer.status, answer.json.error.code]).toEqual([403, 'not_an_admin'])
    expect(await snapshotWithout('auth_attempts')).toEqual(before)
    expect((await admins()).map((m) => m.email)).toEqual([FIRST])
  })

  it('leaves a member who is on the list alone: they sign in as always (session.sign_in only), whatever the variable says', async () => {
    await q("insert into admins (email, name) values ('member@test.local', 'Listed Member')")
    for (const value of ['member@test.local', FIRST, undefined, 'not an e-mail']) {
      variableIs(value)
      const after = await lastAuditId()
      const answer = await signIn('member@test.local')
      expect(answer.status, answer.text).toBe(200)
      expect((await rowsAfter(after)).map((r) => [r.action, r.actor_type])).toEqual([['session.sign_in', 'admin']])
    }
    expect((await admins()).map((m) => m.email)).toEqual(['member@test.local'])
  })

  it('does not take the e-mail from anywhere but the environment: not from the request', async () => {
    variableIs(undefined)
    const before = await snapshotWithout('auth_attempts')
    const answer = await call('POST', '/api/admin/google', {
      body: { credential: FIRST, email: FIRST, first_admin_email: FIRST, FIRST_ADMIN_EMAIL: FIRST },
      headers: { 'x-first-admin-email': FIRST },
    })
    expect([answer.status, answer.json.error.code]).toEqual([403, 'not_an_admin'])
    expect(await snapshotWithout('auth_attempts')).toEqual(before)
  })
})

describe('the lock that makes the sign-ins wait for each other', () => {
  it('two first sign-ins that both passed the lookup: one member, one admin.add, and both are signed in', async () => {
    // A transaction of the test holds the very lock of step (c) (server/firstAdmin.js). Each sign-in does its lookup (which takes
    // only the lock ROW SHARE of its `for update`, and so does not wait), finds nobody and then waits at `lock table`: both have
    // seen an empty list before either has written. Then the lock is let go and they run one after the other.
    const holder = await openTransaction()
    const after = await lastAuditId()
    let answers
    try {
      await holder.client.query('lock table admins in share row exclusive mode')
      const pending = [signIn(FIRST), signIn(FIRST)]
      await until(async () => (await waitingFor('lock table admins')) === 2, 'both sign-ins to wait for the lock')
      expect(await admins(), 'nothing is written while they wait').toEqual([])
      await holder.end('rollback')
      answers = await Promise.all(pending)
    } finally {
      await holder.end('rollback')
    }
    expect(answers.map((a) => a.status), answers.map((a) => a.text).join(' ')).toEqual([200, 200])
    const members = await admins()
    expect(members).toHaveLength(1)
    const rows = await rowsAfter(after)
    expect(rows.map((r) => r.action)).toEqual(['admin.add', 'session.sign_in', 'session.sign_in']) // the second waited for the first to commit
    expect(rows.filter((r) => r.action === 'admin.add')).toHaveLength(1)
    expect(rows.every((r) => r.entity_id === members[0].id)).toBe(true)
    for (const answer of answers) expect(await meStatus(cookieOf(answer))).toBe(200)
    expect((await one('select count(*)::int as n from admin_sessions where admin_id = $1', [members[0].id])).n).toBe(2)
  })

  it('two sign-ins at the same moment, with nothing to hold them: the same result', async () => {
    const after = await lastAuditId()
    const answers = await Promise.all([signIn(FIRST), signIn(FIRST)])
    expect(answers.map((a) => a.status), answers.map((a) => a.text).join(' ')).toEqual([200, 200])
    expect(await admins()).toHaveLength(1)
    expect((await rowsAfter(after)).filter((r) => r.action === 'admin.add')).toHaveLength(1)
  })

  it('waits for a create-admin that is writing at the same moment, and then refuses: the list has a row', async () => {
    // The owner's command (scripts/create-admin.mjs) is in the middle of its transaction: the member and its audit row are
    // written, not committed. The sign-in does not see them, and its `lock table` has to wait for that transaction.
    const owner = await openTransaction()
    const after = await lastAuditId()
    let answer
    try {
      const { outcome } = await addCommitteeMember((fn) => fn(owner.client), 'added.by.the.owner@test.local', 'Added By The Owner')
      expect(outcome).toBe('added')
      const pending = signIn(FIRST)
      await until(async () => (await waitingFor('lock table admins')) === 1, 'the sign-in to wait for the lock')
      await owner.end('commit')
      answer = await pending
    } finally {
      await owner.end('rollback')
    }
    expect([answer.status, answer.json.error.code]).toEqual([403, 'not_an_admin'])
    expect(answer.headers['set-cookie']).toBeUndefined()
    expect((await admins()).map((m) => m.email)).toEqual(['added.by.the.owner@test.local'])
    expect((await rowsAfter(after)).map((r) => [r.action, r.actor_type])).toEqual([['admin.add', 'script']])
    expect((await one('select count(*)::int as n from admin_sessions')).n).toBe(0)
  })

  it('makes a create-admin wait while a first sign-in is in the middle of its transaction, and then both are written', async () => {
    // A lock of the test on admin_sessions stops the sign-in at the insert of its session, after it has added the member and
    // written `admin.add`: it holds the lock of `admins` and has not committed.
    const stopper = await openTransaction()
    const after = await lastAuditId()
    let answer
    let added
    try {
      await stopper.client.query('lock table admin_sessions in access exclusive mode')
      const signing = signIn(FIRST)
      await until(async () => (await waitingFor('insert into admin_sessions')) === 1, 'the sign-in to stop at its session')
      const adding = addCommitteeMember(tx, 'late.member@test.local', 'Late Member')
      await until(async () => (await waitingFor('insert into admins')) === 1, 'the create-admin to wait for the sign-in')
      expect(await admins(), 'nothing is visible until the sign-in commits').toEqual([])
      await stopper.end('rollback')
      answer = await signing
      added = await adding
    } finally {
      await stopper.end('rollback')
    }
    expect(answer.status, answer.text).toBe(200)
    expect(added.outcome).toBe('added')
    expect((await admins()).map((m) => m.email).sort()).toEqual([FIRST, 'late.member@test.local'])
    expect((await rowsAfter(after)).map((r) => [r.action, r.actor_type])).toEqual([
      ['admin.add', 'system'], ['session.sign_in', 'admin'], ['admin.add', 'script'],
    ])
  })
})

describe('one transaction: the member, its session and its audit rows are written all together or not at all', () => {
  it('when admin.add is refused by the database: 500, no member, no session, and a retry works', async () => {
    const before = await snapshotWithout('auth_attempts')
    const { result: refused, lines } = await recordingTheConsole(() => refusingAudit('admin.add', () => signIn(FIRST)))
    expect(refused.status, refused.text).toBe(500)
    expect(refused.json.error.code).toBe('server_error')
    expect(refused.headers['set-cookie']).toBeUndefined()
    await expectOnlyTheRecordOfTheFailure(before) // no member, no session, no audit row: the whole schema as it was
    expect(await admins()).toEqual([])
    expect(lines.join('\n')).not.toContain(FIRST) // the failure of the database quotes the row, and the log must not

    const after = await lastAuditId()
    const retry = await signIn(FIRST)
    expect(retry.status, retry.text).toBe(200)
    expect(await meStatus(cookieOf(retry))).toBe(200)
    expect((await rowsAfter(after)).map((r) => r.action)).toEqual(['admin.add', 'session.sign_in'])
  })

  it('when session.sign_in is refused by the database: 500 and the member that was just added is gone too, and a retry works', async () => {
    const before = await snapshotWithout('auth_attempts')
    const { result: refused } = await recordingTheConsole(() => refusingAudit('session.sign_in', () => signIn(FIRST)))
    expect(refused.status, refused.text).toBe(500)
    await expectOnlyTheRecordOfTheFailure(before) // the member and its `admin.add` were rolled back with the session
    expect(await admins()).toEqual([])

    const after = await lastAuditId()
    const retry = await signIn(FIRST)
    expect(retry.status, retry.text).toBe(200)
    expect((await rowsAfter(after)).map((r) => r.action)).toEqual(['admin.add', 'session.sign_in'])
  })

  it('when the session cannot be opened: 500 and no member', async () => {
    await q('alter table admin_sessions add constraint refuse_session check (false) not valid')
    let answer
    try {
      answer = (await recordingTheConsole(() => signIn(FIRST))).result
    } finally {
      await q('alter table admin_sessions drop constraint refuse_session')
    }
    expect(answer.status).toBe(500)
    expect(await admins()).toEqual([])
    expect((await signIn(FIRST)).status).toBe(200)
  })
})

describe('the value of the variable is not logged, and a refusal does not return it', () => {
  it('writes no log line that holds it, for a sign-in that adds the member and for refusals', async () => {
    const SECRETISH = 'only.in.the.variable@test.local'
    variableIs(SECRETISH)
    googleIs(googleOf(OTHER))
    const refused = await recordingTheConsole(() => signIn())
    expect([refused.result.status, refused.result.json.error.code]).toEqual([403, 'not_an_admin'])
    expect(JSON.stringify(refused.result)).not.toContain(SECRETISH)
    expect(refused.lines.join('\n')).not.toContain(SECRETISH)

    googleIs(googleOf(SECRETISH))
    const accepted = await recordingTheConsole(() => signIn())
    expect(accepted.result.status, accepted.result.text).toBe(200)
    expect(accepted.lines.join('\n')).not.toContain(SECRETISH)

    // The only places that hold the address are the member's own row and the detail of `admin.add` (where the e-mail of an added
    // member always is), never the entry of the sign-in.
    const holders = (await q('select action from audit_log where detail::text like $1 order by id', [`%${SECRETISH}%`])).rows
    expect(holders.map((r) => r.action)).toEqual(['admin.add'])
  })

  it('gives a refusal no field, header or code that is new', async () => {
    googleIs(googleOf(OTHER))
    const answer = await signIn()
    expect(answer.status).toBe(403)
    expect(answer.json).toEqual({ error: { code: 'not_an_admin', message: 'This Google account is not on the committee list' } })
    expect(Object.keys(answer.headers)).not.toContain('set-cookie')
  })
})

describe('the committee can read what the first sign-in wrote', () => {
  it('lists admin.add by the system and session.sign_in by the member, in the audit log, with the cookie of that sign-in', async () => {
    const answer = await signIn(FIRST)
    expect(answer.status, answer.text).toBe(200)
    const log = await call('GET', '/api/admin/audit?limit=2', { cookie: cookieOf(answer) })
    expect(log.status, log.text).toBe(200)
    const [signedIn, added] = log.json.entries
    expect(signedIn).toMatchObject({ action: 'session.sign_in', actor_type: 'admin', actor_name: 'Test Admin' })
    expect(added).toMatchObject({ action: 'admin.add', actor_type: 'system', actor_id: null, actor_name: null, actor_deleted: false, entity: 'admin' })
    expect(added.detail).toEqual({ email: FIRST })
  })
})
