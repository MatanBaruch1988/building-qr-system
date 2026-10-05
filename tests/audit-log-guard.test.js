// The audit log is append-only (migration 007), like the scans (002, 004): the database refuses to change a row, to delete
// one and to empty the table. The one way out is a delete inside a transaction that says so with the setting
// app.audit_retention, which nothing sets today (a legal retention period for the log would, after a change of the project's
// rules). The migration also adds actor_name (the name of the committee member as it was at the time of the action) and the
// two indexes of the coming audit screen. The data is fake.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import { AUDIT_ACTOR_NAME_MAX_LENGTH } from '../server/config.js'

let db, cookie, adminId

/** Adds one audit row the way the code does (the new shape), and returns its id. `at` and `actorName` are optional. */
async function addRow({ at, actorName = 'Fake Person' } = {}) {
  const { rows } = await db.pool.query(
    `insert into audit_log (at, actor_type, actor_id, actor_name, action, entity, entity_id, detail)
     values (coalesce($1::timestamptz, now()), 'admin', 'fake-actor', $2, 'test.guard', 'point', $3, '{"name":"Fake point"}')
     returning id`,
    [at ?? null, actorName, randomUUID()],
  )
  return rows[0].id
}
const stored = async (id) => (await db.pool.query('select * from audit_log where id = $1', [id])).rows
const flag = async (c) => (await c.query("select coalesce(current_setting('app.audit_retention', true), '') as v")).rows[0].v
const addMember = async (email, name) =>
  (await call('POST', '/api/admin/admins', { cookie, body: { email, name } })).json.admin
const lastAuditRow = async (action, actorId) =>
  (await db.pool.query('select * from audit_log where action = $1 and actor_id = $2 order by id desc limit 1', [action, actorId])).rows[0]
const saveAddress = (address, asCookie = cookie) => call('PUT', '/api/admin/building', { cookie: asCookie, body: { address } })

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  adminId = (await db.pool.query("select id from admins where email = 'admin@test.local'")).rows[0].id
})
afterAll(async () => db?.teardown())

describe('the database refuses to change the audit log', () => {
  it('refuses an update of any column, and the row stays as it was', async () => {
    const id = await addRow()
    const before = (await stored(id))[0]
    await expect(db.pool.query("update audit_log set action = 'changed' where id = $1", [id])).rejects.toThrow(
      /audit_log is append-only: update is not allowed/,
    )
    await expect(db.pool.query("update audit_log set actor_name = 'Someone Else' where id = $1", [id])).rejects.toThrow(/append-only/)
    await expect(db.pool.query("update audit_log set detail = '{}'")).rejects.toThrow(/append-only/)
    expect((await stored(id))[0]).toEqual(before)
  })

  it('refuses a delete, of one row or of all of them, and the row stays', async () => {
    const id = await addRow()
    await expect(db.pool.query('delete from audit_log where id = $1', [id])).rejects.toThrow(
      /audit_log is append-only: delete is not allowed/,
    )
    await expect(db.pool.query('delete from audit_log')).rejects.toThrow(/append-only/)
    expect(await stored(id)).toHaveLength(1)
  })

  it('refuses a truncate, with and without the retention setting, and the row stays', async () => {
    const id = await addRow()
    await expect(db.pool.query('truncate audit_log')).rejects.toThrow(/audit_log is append-only: truncate is not allowed/)
    await expect(db.pool.query('truncate audit_log restart identity cascade')).rejects.toThrow(/append-only/)
    // The retention exception is for a delete of the rows that are due: it never lets the table be emptied.
    const c = await db.pool.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.audit_retention', 'on', true)")
      await expect(c.query('truncate audit_log')).rejects.toThrow(/append-only/)
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
    expect(await stored(id)).toHaveLength(1)
  })
})

describe('the one exception: a delete inside a transaction that says so', () => {
  it('lets that delete through, and nothing else, and the setting does not leak to the next transaction', async () => {
    const [due, kept] = [await addRow(), await addRow()]
    const c = await db.pool.connect()
    try {
      await c.query('begin')
      await c.query("select set_config('app.audit_retention', 'on', true)")
      expect(await flag(c)).toBe('on')
      // Inside that transaction an edit and a truncate are still refused (a savepoint keeps the transaction usable).
      await c.query('savepoint a')
      await expect(c.query("update audit_log set action = 'changed' where id = $1", [kept])).rejects.toThrow(/append-only/)
      await c.query('rollback to savepoint a')
      await c.query('savepoint b')
      await expect(c.query('truncate audit_log')).rejects.toThrow(/append-only/)
      await c.query('rollback to savepoint b')
      // The delete itself is allowed.
      const deleted = await c.query('delete from audit_log where id = $1', [due])
      expect(deleted.rowCount).toBe(1)
      await c.query('commit')

      expect(await stored(due)).toHaveLength(0)
      expect(await stored(kept)).toHaveLength(1)

      // The next transaction on the same connection is refused again: the setting lived and died with the one before.
      expect(await flag(c)).not.toBe('on')
      await expect(c.query('delete from audit_log where id = $1', [kept])).rejects.toThrow(/append-only/)
      // Also a transaction that sets it and rolls back leaves nothing behind.
      await c.query('begin')
      await c.query("select set_config('app.audit_retention', 'on', true)")
      await c.query('rollback')
      expect(await flag(c)).not.toBe('on')
      await expect(c.query('delete from audit_log where id = $1', [kept])).rejects.toThrow(/append-only/)
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
    expect(await stored(kept)).toHaveLength(1)
  })

  it('is not opened by anything else: a value other than "on" does not count', async () => {
    const id = await addRow()
    const c = await db.pool.connect()
    try {
      for (const value of ['off', 'ON ', 'true', '1']) {
        await c.query('begin')
        await c.query("select set_config('app.audit_retention', $1, true)", [value])
        await expect(c.query('delete from audit_log where id = $1', [id]), value).rejects.toThrow(/append-only/)
        await c.query('rollback')
      }
    } finally {
      await c.query('rollback').catch(() => {})
      c.release()
    }
    expect(await stored(id)).toHaveLength(1)
  })
})

describe('what the code that is already running does keeps working (expand only)', () => {
  it('inserts a row with an explicit old time, and the time is kept', async () => {
    const id = await addRow({ at: '2020-01-02T03:04:05Z' })
    expect(new Date((await stored(id))[0].at).toISOString()).toBe('2020-01-02T03:04:05.000Z')
  })

  it('inserts a row in the old shape, with no actor_name: the name is empty', async () => {
    const { rows } = await db.pool.query(
      `insert into audit_log (actor_type, actor_id, action, entity, entity_id, detail)
       values ('admin', 'fake-actor', 'test.old_shape', 'point', 'p-1', null) returning *`,
    )
    expect(rows[0]).toMatchObject({ actor_type: 'admin', actor_id: 'fake-actor', actor_name: null, action: 'test.old_shape' })
  })

  it('has no foreign key in or out, so deleting a committee member never reaches the log', async () => {
    const { rows } = await db.pool.query(
      `select conname from pg_constraint
        where contype = 'f' and (conrelid = 'audit_log'::regclass or confrelid = 'audit_log'::regclass)`,
    )
    expect(rows).toEqual([])
  })
})

describe('actor_name', () => {
  it('accepts a name of 200 characters and refuses one of 201', async () => {
    expect(AUDIT_ACTOR_NAME_MAX_LENGTH).toBe(200)
    const id = await addRow({ actorName: 'א'.repeat(200) })
    expect((await stored(id))[0].actor_name).toHaveLength(200)
    await expect(addRow({ actorName: 'א'.repeat(201) })).rejects.toMatchObject({ code: '23514' })
  })

  it('is written by a committee action: the member\'s name as it was at the time', async () => {
    const r = await saveAddress('Fake street 1')
    expect(r.status).toBe(200)
    expect(await lastAuditRow('building.update', adminId)).toMatchObject({
      actor_type: 'admin',
      actor_id: adminId,
      actor_name: 'Test Admin',
      entity: 'building',
    })
  })

  it('is the e-mail when the member has no name', async () => {
    const member = await addMember('no-name@test.local', '')
    const memberCookie = await adminCookie('no-name@test.local')
    await db.pool.query("update admins set name = '' where id = $1", [member.id])
    expect((await saveAddress('Fake street 2', memberCookie)).status).toBe(200)
    expect(await lastAuditRow('building.update', member.id)).toMatchObject({ actor_name: 'no-name@test.local' })
  })

  it('stays on the row after the member is deleted, and the log is not touched by the delete', async () => {
    const member = await addMember('second@test.local', 'Second Member')
    const memberCookie = await adminCookie('second@test.local')
    expect((await saveAddress('Fake street 3', memberCookie)).status).toBe(200)
    const row = await lastAuditRow('building.update', member.id)
    expect(row.actor_name).toBe('Second Member')

    const gone = await call('DELETE', `/api/admin/admins/${member.id}`, { cookie })
    expect(gone.status).toBe(200)
    expect((await db.pool.query('select 1 from admins where id = $1', [member.id])).rows).toEqual([])
    // The row is exactly as it was, and still says who did it. The delete itself was recorded under the other member.
    expect((await stored(row.id))[0]).toEqual(row)
    expect(await lastAuditRow('admin.delete', adminId)).toMatchObject({ actor_name: 'Test Admin', entity_id: member.id })
  })

  it('is cut to the limit, by characters, when a name is longer: the action is not refused', async () => {
    const member = await addMember('long-name@test.local', 'Long Name')
    const memberCookie = await adminCookie('long-name@test.local')
    // Two UTF-16 units per character: a cut by units would keep 100 of them and could split one in two.
    const name = '😀'.repeat(AUDIT_ACTOR_NAME_MAX_LENGTH + 50)
    await db.pool.query('update admins set name = $2 where id = $1', [member.id, name])
    expect((await saveAddress('Fake street 4', memberCookie)).status).toBe(200)
    const { actor_name } = await lastAuditRow('building.update', member.id)
    expect(Array.from(actor_name)).toHaveLength(AUDIT_ACTOR_NAME_MAX_LENGTH)
    expect(actor_name).toBe('😀'.repeat(AUDIT_ACTOR_NAME_MAX_LENGTH))
  })
})

describe('the indexes of the audit screen', () => {
  it('has one on (at desc, id desc) and one on (entity, entity_id, at desc)', async () => {
    const { rows } = await db.pool.query(
      "select indexname, indexdef from pg_indexes where schemaname = current_schema() and tablename = 'audit_log' order by indexname",
    )
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]))
    expect(byName.audit_log_at_idx).toMatch(/\(at DESC, id DESC\)$/)
    expect(byName.audit_log_entity_idx).toMatch(/\(entity, entity_id, at DESC\)$/)
  })
})
