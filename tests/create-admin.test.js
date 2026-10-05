// `npm run db:create-admin` (scripts/create-admin.mjs): the owner's command that adds a committee member. The member and the audit
// row that records it are ONE transaction (actor `script`, the same actions and details as POST /admin/admins), and a member who
// is on the list already writes nothing. The core function runs against the throwaway schema of this file; the command line is
// run for real, in a child process, against the same schema (DB_SCHEMA, the scratch-schema switch of server/db.js), from a
// temporary folder so that it finds no env file of its own and uses the database of this run. The data is fake.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { setupDb } from './helpers.js'
import { addCommitteeMember } from '../scripts/create-admin.mjs'
import { tx } from '../server/db.js'

const SCRIPT = fileURLToPath(new URL('../scripts/create-admin.mjs', import.meta.url))

let db, scratch
const q = (text, params) => db.pool.query(text, params)
const one = async (text, params) => (await q(text, params)).rows[0]
const uniq = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`
const newEmail = () => `${uniq('member')}@test.local`

const lastAuditId = async () => (await one('select coalesce(max(id), 0)::int as n from audit_log')).n
const auditAfter = async (after) => (await q('select * from audit_log where id > $1 order by id', [after])).rows
const memberByEmail = (email) => one('select * from admins where email = $1', [email])

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

beforeAll(async () => {
  db = await setupDb()
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'create-admin-'))
})
afterAll(async () => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
  await db?.teardown()
})

describe('addCommitteeMember', () => {
  it('adds a new member and records it as admin.add, with the script actor, in the same step', async () => {
    const email = newEmail()
    const after = await lastAuditId()
    // Any case and spaces around the address: it is stored in lower case, as the committee route stores it.
    const { outcome, member } = await addCommitteeMember(tx, `  ${email.toUpperCase()} `, 'New Member')
    expect(outcome).toBe('added')
    expect(member).toMatchObject({ email, name: 'New Member', is_active: true })
    expect(await memberByEmail(email)).toMatchObject({ id: member.id, name: 'New Member', is_active: true, google_sub: null })

    const rows = await auditAfter(after)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_type: 'script',
      actor_id: null,
      actor_name: null,
      action: 'admin.add',
      entity: 'admin',
      entity_id: member.id,
    })
    expect(rows[0].detail).toEqual({ email })
  })

  it('adds a member who has no name', async () => {
    const email = newEmail()
    const { member } = await addCommitteeMember(tx, email)
    expect(member.name).toBe('')
    expect((await memberByEmail(email)).name).toBe('')
  })

  it('switches a member who was switched off back on and records it as admin.enable, with what changed', async () => {
    const email = newEmail()
    const { id } = await one('insert into admins (email, name, is_active) values ($1, $2, false) returning id', [email, 'Returning Member'])
    const after = await lastAuditId()
    const { outcome, member } = await addCommitteeMember(tx, email, 'A Name That Is Ignored')
    expect(outcome).toBe('enabled')
    expect(member).toMatchObject({ id, email, name: 'Returning Member', is_active: true })
    expect(await memberByEmail(email)).toMatchObject({ is_active: true, name: 'Returning Member' })

    const rows = await auditAfter(after)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_type: 'script', actor_id: null, actor_name: null, action: 'admin.enable', entity: 'admin', entity_id: id })
    expect(rows[0].detail).toEqual({ email, changes: { is_active: { from: false, to: true } } })
  })

  it('leaves a member who is on the list and active as they are, and writes no row', async () => {
    const email = newEmail()
    await q("insert into admins (email, name, google_sub, last_login_at) values ($1, 'Listed Member', 'sub-fake', now())", [email])
    const before = await memberByEmail(email)
    const after = await lastAuditId()
    const { outcome, member } = await addCommitteeMember(tx, email, 'Another Name')
    expect(outcome).toBe('unchanged')
    expect(member).toMatchObject({ id: before.id, email, name: 'Listed Member', is_active: true })
    expect(await memberByEmail(email)).toEqual(before)
    expect(await auditAfter(after)).toEqual([])
  })

  it('records the e-mail of the member and nothing else about them: not the name', async () => {
    const email = newEmail()
    const after = await lastAuditId()
    await addCommitteeMember(tx, email, 'Fake Person Name')
    const [row] = await auditAfter(after)
    expect(Object.keys(row.detail)).toEqual(['email'])
    expect(JSON.stringify(row)).not.toContain('Fake Person Name')
  })

  it('is one transaction with its row: when admin.add is refused no member is added, and a retry works', async () => {
    const email = newEmail()
    const before = (await one('select count(*)::int as n from admins')).n
    await expect(refusingAudit('admin.add', () => addCommitteeMember(tx, email, 'Refused Member'))).rejects.toThrow(/violates check constraint/)
    expect(await memberByEmail(email)).toBeUndefined()
    expect((await one('select count(*)::int as n from admins')).n).toBe(before)
    expect((await addCommitteeMember(tx, email, 'Refused Member')).outcome).toBe('added')
  })

  it('is one transaction with its row: when admin.enable is refused the member stays switched off, and a retry works', async () => {
    const email = newEmail()
    await q('insert into admins (email, name, is_active) values ($1, $2, false)', [email, 'Off Member'])
    const before = await memberByEmail(email)
    await expect(refusingAudit('admin.enable', () => addCommitteeMember(tx, email))).rejects.toThrow(/violates check constraint/)
    expect(await memberByEmail(email)).toEqual(before)
    expect((await addCommitteeMember(tx, email)).outcome).toBe('enabled')
    expect((await memberByEmail(email)).is_active).toBe(true)
  })
})

describe('the command line', () => {
  // The child runs in a temporary folder (so loadEnv finds no .env.local there) with the database of this run in its
  // environment and DB_SCHEMA pointing at the throwaway schema: it writes to that schema and nowhere else.
  const run = (...args) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: scratch,
      env: { ...process.env, DB_SCHEMA: db.schema },
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('prints the usage and exits with 1 for a missing or malformed e-mail, before it touches the database', () => {
    for (const args of [[], ['not-an-email'], ['two words@test.local'], ['']]) {
      const result = run(...args)
      expect(result.code, JSON.stringify(args)).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr.trim()).toBe('Usage: npm run db:create-admin -- <google-email> [name]')
    }
  })

  it('says where it writes, adds the member and the audit row, and names the database again when it is done', async () => {
    const email = newEmail()
    const after = await lastAuditId()
    const result = run(email.toUpperCase(), 'Command Line Member')
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split(/\r?\n/)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^Writing to (the nonprod database at \S+|the database at \S+ \(not marked\))$/)
    const where = lines[0].replace(/^Writing to /, '')
    expect(lines[1]).toBe(`Committee member ready: ${email} (signs in with Google) in ${where}`)

    const member = await memberByEmail(email)
    expect(member).toMatchObject({ name: 'Command Line Member', is_active: true })
    const rows = await auditAfter(after)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_type: 'script', actor_id: null, actor_name: null, action: 'admin.add', entity_id: member.id })
    expect(rows[0].detail).toEqual({ email })
  })

  it('says the same for a member who is on the list already, and adds no second row', async () => {
    const email = newEmail()
    expect(run(email).code).toBe(0)
    const after = await lastAuditId()
    const again = run(email, 'Ignored')
    expect(again.code).toBe(0)
    expect(again.stdout).toContain(`Committee member ready: ${email} (signs in with Google) in `)
    expect(await auditAfter(after)).toEqual([])
    expect(await memberByEmail(email)).toMatchObject({ name: '', is_active: true })
  })
})
