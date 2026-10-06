// The building's address and name: the two settings that the committee saves in the committee app and the provider app reads
// (migrations 006 and 012, GET /api/public/building, GET and PUT /api/admin/building). Both start empty, and neither is in the
// agent API. The name is optional in a save: a committee screen that sends the address only leaves the saved name alone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'

let db, cookie, adminId

const save = (address, extra = {}) => call('PUT', '/api/admin/building', { cookie, body: { address }, ...extra })
const put = (body, extra = {}) => call('PUT', '/api/admin/building', { cookie, body, ...extra })
const publicAddress = async () => (await call('GET', '/api/public/building')).json.building.address
const publicName = async () => (await call('GET', '/api/public/building')).json.building.name
const auditCount = async () => (await db.pool.query("select count(*)::int n from audit_log where action = 'building.update'")).rows[0].n
const lastAudit = async () => (await db.pool.query("select detail from audit_log where action = 'building.update' order by id desc limit 1")).rows[0].detail
const stored = async () => (await db.pool.query('select * from building_settings')).rows

beforeAll(async () => {
  db = await setupDb()
  await seedAdmin(db.pool)
  cookie = await adminCookie()
  adminId = (await db.pool.query("select id from admins where email = 'admin@test.local'")).rows[0].id
})
afterAll(async () => db?.teardown())

describe('the table', () => {
  it('has the one row after the migration, empty, and nobody has saved it yet', async () => {
    // Read before any test saves: the answer of a fresh database.
    expect(await stored()).toEqual([expect.objectContaining({ id: 1, address: '', name: '', updated_by: null })])
  })

  it('cannot hold a second row, an address over 200 characters, a name over 80 characters, or a missing value', async () => {
    await expect(db.pool.query('insert into building_settings (id) values (2)')).rejects.toThrow(/check constraint/)
    await expect(db.pool.query('insert into building_settings (id) values (1)')).rejects.toThrow(/duplicate key/)
    await expect(db.pool.query("update building_settings set address = repeat('x', 201)")).rejects.toThrow(/check constraint/)
    await expect(db.pool.query('update building_settings set address = null')).rejects.toThrow(/not-null/)
    await expect(db.pool.query("update building_settings set name = repeat('x', 81)")).rejects.toThrow(/check constraint/)
    await expect(db.pool.query('update building_settings set name = null')).rejects.toThrow(/not-null/)
    await db.pool.query("update building_settings set name = repeat('x', 80)") // exactly the limit is stored
    await db.pool.query("update building_settings set name = ''")
    expect(await stored()).toHaveLength(1)
  })

  it('is described in the database: the table and every column carry a comment', async () => {
    const { rows } = await db.pool.query(
      `select a.attname, d.description
         from pg_attribute a
         left join pg_description d on d.objoid = a.attrelid and d.objsubid = a.attnum
        where a.attrelid = 'building_settings'::regclass and a.attnum > 0 and not a.attisdropped`,
    )
    expect(rows.map((r) => r.attname).sort()).toEqual(['address', 'id', 'name', 'updated_at', 'updated_by'])
    for (const row of rows) expect(row.description, row.attname).toBeTruthy()
    const table = await db.pool.query("select obj_description('building_settings'::regclass, 'pg_class') as description")
    expect(table.rows[0].description).toBeTruthy()
  })
})

describe('GET /api/public/building', () => {
  it('answers with the empty address and the empty name and nothing else, with no sign-in', async () => {
    const r = await call('GET', '/api/public/building')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ building: { address: '', name: '' } })
  })

  it('may be kept by the CDN for a short while, and never by the browser without asking', async () => {
    const r = await call('GET', '/api/public/building')
    expect(r.headers['cache-control']).toBe('public, max-age=0, s-maxage=60')
    // the other public answers stay uncached
    expect((await call('GET', '/api/public/providers')).headers['cache-control']).toBe('no-store')
  })

  it('is read-only: a write is refused', async () => {
    expect((await call('PUT', '/api/public/building', { body: { address: 'x' } })).status).toBe(405)
    expect((await call('POST', '/api/public/building', { body: { address: 'x' } })).status).toBe(405)
  })
})

describe('the committee routes', () => {
  it('need a committee session: no cookie, a provider token and a bad cookie are all 401', async () => {
    const provider = (await call('POST', '/api/admin/providers', { cookie, body: { company: 'ניקיון', contact_name: 'פלוני', password: 'ploni-1234' } })).json.provider
    const token = (await call('POST', '/api/session', { body: { provider_id: provider.id, password: 'ploni-1234' } })).json.token
    for (const options of [{}, { token }, { cookie: 'qr_admin=qra_nope' }]) {
      const read = await call('GET', '/api/admin/building', options)
      expect(read.status).toBe(401)
      expect(read.json.error.code).toBe('admin_required')
      const write = await call('PUT', '/api/admin/building', { ...options, body: { address: 'Nobody Street 1' } })
      expect(write.status).toBe(401)
      expect(write.json.error.code).toBe('admin_required')
    }
    expect(await publicAddress()).toBe('') // none of those wrote anything
  })

  it('refuse a write that is not JSON, like every other write', async () => {
    const r = await save('x', { headers: { 'content-type': 'text/plain' } })
    expect(r.status).toBe(400)
    expect(r.json.error.code).toBe('json_required')
  })

  it('show the empty address and the empty name first', async () => {
    const r = await call('GET', '/api/admin/building', { cookie })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ building: { address: '', name: '' } })
  })

  it('save the address, and the public route and the committee read it back', async () => {
    const r = await save('רחוב הבדיקה 7, עיר לדוגמה')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ building: { address: 'רחוב הבדיקה 7, עיר לדוגמה', name: '' } })
    expect(await publicAddress()).toBe('רחוב הבדיקה 7, עיר לדוגמה')
    expect((await call('GET', '/api/admin/building', { cookie })).json.building.address).toBe('רחוב הבדיקה 7, עיר לדוגמה')
    // still one row: a save is an update
    expect(await stored()).toHaveLength(1)
  })

  it('save the address as typed in any language, with a number and punctuation, and the invisible direction marks', async () => {
    for (const address of [
      'Example Street 5, Sample Town',
      'Пример улица 3, Образцовый город',
      'شارع المثال 4، مدينة تجريبية',
      'רחוב Example 12/3, עיר',
      'רחוב ‏הדוגמה‏ 9', // right-to-left marks around a word: mixed text sometimes needs them
    ]) {
      expect((await save(address)).json.building.address, address).toBe(address)
      expect(await publicAddress(), address).toBe(address)
    }
  })

  it('trim the address', async () => {
    const r = await save('   רחוב הרווחים 2  \n')
    expect(r.status).toBe(200)
    expect(r.json.building.address).toBe('רחוב הרווחים 2')
    expect(await publicAddress()).toBe('רחוב הרווחים 2')
  })

  it('accept an empty address (it means show nothing), and a blank one is empty too', async () => {
    await save('רחוב לפני הניקוי 1')
    expect((await save('')).json).toEqual({ building: { address: '', name: '' } })
    expect(await publicAddress()).toBe('')
    await save('רחוב לפני הניקוי 2')
    expect((await save('   ')).json).toEqual({ building: { address: '', name: '' } })
    expect(await publicAddress()).toBe('')
  })

  it('accept exactly 200 characters and refuse 201, and a refusal changes nothing', async () => {
    const longest = 'א'.repeat(200)
    expect((await save(longest)).json.building.address).toBe(longest)
    const tooLong = await save('א'.repeat(201))
    expect(tooLong.status).toBe(400)
    expect(tooLong.json.error).toMatchObject({ code: 'invalid_field', field: 'address' })
    expect(await publicAddress()).toBe(longest)
  })

  it('refuse control characters: a line break, a tab, a NUL, the line separator and a stray escape', async () => {
    await save('רחוב שלא ישתנה 1')
    for (const bad of ['רחוב\nהדוגמה 1', 'רחוב\r\nהדוגמה', 'רחוב\tהדוגמה', 'רחוב\u0000הדוגמה', 'רחוב הדוגמה', 'רחוב הדוגמה', 'רחוב\u001bהדוגמה', 'רחוב\u0085הדוגמה']) {
      const r = await save(bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(r.json.error, JSON.stringify(bad)).toMatchObject({ code: 'invalid_field', field: 'address' })
    }
    expect(await publicAddress()).toBe('רחוב שלא ישתנה 1')
  })

  it('refuse a missing address and one that is not text', async () => {
    const missing = await call('PUT', '/api/admin/building', { cookie, body: {} })
    expect(missing.status).toBe(400)
    expect(missing.json.error).toMatchObject({ code: 'missing_field', field: 'address' })
    expect((await call('PUT', '/api/admin/building', { cookie, body: { address: null } })).json.error.code).toBe('missing_field')
    for (const address of [12, true, ['רחוב'], { street: 'x' }]) {
      const r = await save(address)
      expect(r.status, JSON.stringify(address)).toBe(400)
      expect(r.json.error.code, JSON.stringify(address)).toBe('invalid_field')
    }
    expect(await publicAddress()).toBe('רחוב שלא ישתנה 1')
  })

  it('ignore fields they do not know, and refuse other methods', async () => {
    const r = await call('PUT', '/api/admin/building', { cookie, body: { address: 'רחוב עם תוספת 3', updated_by: 'someone', id: 2, future_field: true } })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ building: { address: 'רחוב עם תוספת 3', name: '' } })
    expect((await stored())[0]).toMatchObject({ id: 1, updated_by: adminId })
    expect((await call('DELETE', '/api/admin/building', { cookie, body: {} })).status).toBe(405)
    expect((await call('POST', '/api/admin/building', { cookie, body: { address: 'x' } })).status).toBe(405)
  })

  it('save a missing row again (an upsert), so a save never fails because the row was removed', async () => {
    await db.pool.query('delete from building_settings')
    expect(await publicAddress()).toBe('')
    expect((await call('GET', '/api/admin/building', { cookie })).json.building.address).toBe('')
    expect((await save('רחוב אחרי מחיקת השורה 4')).status).toBe(200)
    expect(await publicAddress()).toBe('רחוב אחרי מחיקת השורה 4')
    expect(await stored()).toHaveLength(1)
  })
})

describe("the building's name", () => {
  const ADDRESS = 'רחוב השם 1'
  // The tests below leave the name as they found it (empty), which the rest of the file expects.
  afterAll(async () => db.pool.query("update building_settings set name = ''"))

  it('is saved with the address, and the public route and the committee read both back', async () => {
    const r = await put({ address: ADDRESS, name: 'בניין הדוגמה' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ building: { address: ADDRESS, name: 'בניין הדוגמה' } })
    expect((await call('GET', '/api/public/building')).json).toEqual({ building: { address: ADDRESS, name: 'בניין הדוגמה' } })
    expect((await call('GET', '/api/admin/building', { cookie })).json).toEqual({ building: { address: ADDRESS, name: 'בניין הדוגמה' } })
    expect(await stored()).toHaveLength(1) // a save is an update
  })

  it('is answered by the public route with the address and nothing else about the building', async () => {
    await put({ address: ADDRESS, name: 'בניין פתוח' })
    const r = await call('GET', '/api/public/building') // no cookie, no token
    expect(r.status).toBe(200)
    expect(Object.keys(r.json)).toEqual(['building'])
    expect(Object.keys(r.json.building)).toEqual(['address', 'name'])
    expect(r.json.building.name).toBe('בניין פתוח')
    expect(r.headers['cache-control']).toBe('public, max-age=0, s-maxage=60')
  })

  it('is saved as typed in any language, with a number and punctuation, and the invisible direction marks', async () => {
    for (const name of ['Example House', 'Дом Пример', 'بيت المثال', 'בית Example 12/3', 'בית ‏הדוגמה‏ 9', "Rachel's Tower (B)"]) {
      expect((await put({ address: ADDRESS, name })).json.building.name, name).toBe(name)
      expect(await publicName(), name).toBe(name)
    }
  })

  it('is kept by a save that has no name: a committee screen from before the name existed sends the address only', async () => {
    await put({ address: ADDRESS, name: 'שם שנשמר' })
    const r = await put({ address: 'רחוב חדש מהמסך הישן 2' }) // exactly what that screen sends
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ building: { address: 'רחוב חדש מהמסך הישן 2', name: 'שם שנשמר' } })
    expect(await publicAddress()).toBe('רחוב חדש מהמסך הישן 2')
    expect(await publicName()).toBe('שם שנשמר')
    expect((await stored())[0]).toMatchObject({ address: 'רחוב חדש מהמסך הישן 2', name: 'שם שנשמר', updated_by: adminId })
  })

  it('is optional but not nullable: a body with no name keeps it, a null name is refused', async () => {
    await put({ address: ADDRESS, name: 'שם שלא נמחק' })
    const r = await put({ address: ADDRESS, name: null })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatchObject({ code: 'invalid_field', field: 'name' })
    expect(await publicName()).toBe('שם שלא נמחק')
  })

  it('is trimmed', async () => {
    const r = await put({ address: ADDRESS, name: '   בניין הרווחים  \n' })
    expect(r.status).toBe(200)
    expect(r.json.building.name).toBe('בניין הרווחים')
    expect(await publicName()).toBe('בניין הרווחים')
  })

  it('can be cleared: an empty name means no name, and a blank one is empty too', async () => {
    await put({ address: ADDRESS, name: 'שם לפני הניקוי 1' })
    expect((await put({ address: ADDRESS, name: '' })).json.building.name).toBe('')
    expect(await publicName()).toBe('')
    await put({ address: ADDRESS, name: 'שם לפני הניקוי 2' })
    expect((await put({ address: ADDRESS, name: '   ' })).json.building.name).toBe('')
    expect(await publicName()).toBe('')
  })

  it('accepts exactly 80 characters and refuses 81, and a refusal changes nothing, not even the address of the same save', async () => {
    const longest = 'א'.repeat(80)
    expect((await put({ address: ADDRESS, name: longest })).json.building.name).toBe(longest)
    const tooLong = await put({ address: 'רחוב שלא יישמר 3', name: 'א'.repeat(81) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.json.error).toMatchObject({ code: 'invalid_field', field: 'name' })
    expect(await publicName()).toBe(longest)
    expect(await publicAddress()).toBe(ADDRESS)
  })

  it('refuses control characters: a line break, a tab, a NUL, the line separator and a stray escape', async () => {
    await put({ address: ADDRESS, name: 'שם שלא ישתנה' })
    for (const name of ['בניין\nהדוגמה', 'בניין\r\nהדוגמה', 'בניין\tהדוגמה', 'בניין\u0000הדוגמה', 'בניין הדוגמה', 'בניין הדוגמה', 'בניין\u001bהדוגמה', 'בניין\u0085הדוגמה']) {
      const r = await put({ address: ADDRESS, name })
      expect(r.status, JSON.stringify(name)).toBe(400)
      expect(r.json.error, JSON.stringify(name)).toMatchObject({ code: 'invalid_field', field: 'name' })
    }
    expect(await publicName()).toBe('שם שלא ישתנה')
  })

  it('refuses a name that is not text', async () => {
    await put({ address: ADDRESS, name: 'שם שנשאר' })
    for (const name of [12, true, ['בניין'], { name: 'x' }]) {
      const r = await put({ address: ADDRESS, name })
      expect(r.status, JSON.stringify(name)).toBe(400)
      expect(r.json.error, JSON.stringify(name)).toMatchObject({ code: 'invalid_field', field: 'name' })
    }
    expect(await publicName()).toBe('שם שנשאר')
  })

  it('does not make the address optional: a save with a name and no address is refused', async () => {
    const r = await put({ name: 'שם בלי כתובת' })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatchObject({ code: 'missing_field', field: 'address' })
    expect(await publicName()).not.toBe('שם בלי כתובת')
  })

  it('is refused for a bad address too, as one save: the name is not kept either', async () => {
    await put({ address: ADDRESS, name: 'שם לפני כתובת פסולה' })
    const r = await put({ address: 'רחוב\nפסול', name: 'שם אחרי כתובת פסולה' })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatchObject({ code: 'invalid_field', field: 'address' })
    expect(await publicName()).toBe('שם לפני כתובת פסולה')
  })

  it('is read as an empty name when the row is gone, and a save of the name makes the row again', async () => {
    await db.pool.query('delete from building_settings')
    expect((await call('GET', '/api/public/building')).json).toEqual({ building: { address: '', name: '' } })
    expect((await call('GET', '/api/admin/building', { cookie })).json).toEqual({ building: { address: '', name: '' } })
    expect((await put({ address: ADDRESS, name: 'שם אחרי מחיקת השורה' })).status).toBe(200)
    expect(await publicName()).toBe('שם אחרי מחיקת השורה')
    expect(await stored()).toHaveLength(1)
  })

  it('is left alone by the save of the deployment before the name existed (migration 012 is an expand step)', async () => {
    // The statement of the previous release (saveAddress), word for word: it names no `name` column.
    const oldSave = (address) => db.pool.query(
      `insert into building_settings (id, address, updated_at, updated_by) values (1, $1, now(), $2)
       on conflict (id) do update
         set address = excluded.address, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [address, adminId],
    )
    await put({ address: ADDRESS, name: 'שם שהקוד הישן לא מכיר' })
    await oldSave('רחוב מהקוד הישן 4')
    expect((await stored())[0]).toMatchObject({ address: 'רחוב מהקוד הישן 4', name: 'שם שהקוד הישן לא מכיר' })
    // and when the row is missing, the old insert gets the default
    await db.pool.query('delete from building_settings')
    await oldSave('רחוב מהקוד הישן 5')
    expect((await stored())[0]).toMatchObject({ address: 'רחוב מהקוד הישן 5', name: '' })
  })
})

describe('who changed it, and when', () => {
  it('records the committee member and the time on the row, and an entry in the audit log', async () => {
    const before = (await stored())[0].updated_at
    const previousAddress = (await stored())[0].address
    await new Promise((resolve) => setTimeout(resolve, 20))
    const r = await save('רחוב הביקורת 8')
    expect(r.status).toBe(200)
    const row = (await stored())[0]
    expect(row.updated_by).toBe(adminId)
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime())

    const { rows } = await db.pool.query(
      "select actor_type, actor_id, entity, entity_id, detail from audit_log where action = 'building.update' order by id desc limit 1",
    )
    expect(rows[0]).toMatchObject({ actor_type: 'admin', actor_id: adminId, entity: 'building', entity_id: null })
    // the address that was replaced and the new one, and nothing else: no e-mail, no name, no session
    expect(rows[0].detail).toEqual({ changes: { address: { from: previousAddress, to: 'רחוב הביקורת 8' } } })
  })

  it('writes no audit entry, and does not touch the time or the member, when the address is the one that is saved', async () => {
    const count = async () => (await db.pool.query("select count(*)::int n from audit_log where action = 'building.update'")).rows[0].n
    expect((await save('רחוב שלא משתנה 5')).status).toBe(200)
    const row = (await stored())[0]
    const before = await count()
    const again = await save('  רחוב שלא משתנה 5 ')
    expect(again.status).toBe(200)
    expect(again.json).toEqual({ building: { address: 'רחוב שלא משתנה 5', name: '' } })
    expect(await count()).toBe(before)
    expect((await stored())[0]).toEqual(row)
  })

  it('records the name that a save replaced and the new one, next to the address when both changed, and only what changed', async () => {
    await put({ address: 'רחוב לפני השם 1' })
    const before = await auditCount()
    expect((await put({ address: 'רחוב עם שם 2', name: 'שם ראשון' })).status).toBe(200)
    expect(await auditCount()).toBe(before + 1)
    expect(await lastAudit()).toEqual({
      changes: { address: { from: 'רחוב לפני השם 1', to: 'רחוב עם שם 2' }, name: { from: '', to: 'שם ראשון' } },
    })

    // only the name changed: the address is not a key of the entry
    expect((await put({ address: 'רחוב עם שם 2', name: 'שם שני' })).status).toBe(200)
    expect(await auditCount()).toBe(before + 2)
    expect(await lastAudit()).toEqual({ changes: { name: { from: 'שם ראשון', to: 'שם שני' } } })
    expect((await stored())[0]).toMatchObject({ name: 'שם שני', updated_by: adminId })

    // clearing it is recorded as an empty text
    expect((await put({ address: 'רחוב עם שם 2', name: '' })).status).toBe(200)
    expect(await lastAudit()).toEqual({ changes: { name: { from: 'שם שני', to: '' } } })
  })

  it('writes the entry of an address save without a name key, also when a name is saved (a screen from before the name existed)', async () => {
    await put({ address: 'רחוב המסך הישן 1', name: 'שם שנשאר ביומן' })
    const before = await auditCount()
    expect((await put({ address: 'רחוב המסך הישן 2' })).status).toBe(200)
    expect(await auditCount()).toBe(before + 1)
    expect(await lastAudit()).toEqual({ changes: { address: { from: 'רחוב המסך הישן 1', to: 'רחוב המסך הישן 2' } } })
    await db.pool.query("update building_settings set name = ''")
  })

  it('writes no audit entry, and does not touch the time or the member, when address and name are those that are saved', async () => {
    expect((await put({ address: 'רחוב שלא משתנה 6', name: 'שם שלא משתנה' })).status).toBe(200)
    const row = (await stored())[0]
    const before = await auditCount()
    for (const body of [
      { address: 'רחוב שלא משתנה 6', name: 'שם שלא משתנה' },
      { address: '  רחוב שלא משתנה 6 ', name: ' שם שלא משתנה  ' }, // only the spaces around them differ
      { address: 'רחוב שלא משתנה 6' }, // a screen from before the name existed
    ]) {
      const again = await put(body)
      expect(again.status).toBe(200)
      expect(again.json).toEqual({ building: { address: 'רחוב שלא משתנה 6', name: 'שם שלא משתנה' } })
    }
    expect(await auditCount()).toBe(before)
    expect((await stored())[0]).toEqual(row)
    await db.pool.query("update building_settings set name = ''")
  })

  it('writes no audit entry for a refused name', async () => {
    const before = await auditCount()
    expect((await put({ address: 'רחוב שלא נשמר 7', name: 'א'.repeat(81) })).status).toBe(400)
    expect((await put({ address: 'רחוב שלא נשמר 7', name: 'שם\nפסול' })).status).toBe(400)
    expect((await put({ address: 'רחוב שלא נשמר 7', name: 'שם' }, { cookie: undefined })).status).toBe(401)
    expect(await auditCount()).toBe(before)
  })

  it('writes no audit entry for a refused save', async () => {
    const count = async () => (await db.pool.query("select count(*)::int n from audit_log where action = 'building.update'")).rows[0].n
    const before = await count()
    expect((await save('א'.repeat(201))).status).toBe(400)
    expect((await call('PUT', '/api/admin/building', { body: { address: 'x' } })).status).toBe(401)
    expect(await count()).toBe(before)
  })

  it('does not stop a committee member from being deleted: the row forgets who they were', async () => {
    const other = (await call('POST', '/api/admin/admins', { cookie, body: { email: 'second@test.local', name: 'חבר שני' } })).json.admin
    const otherCookie = await adminCookie('second@test.local')
    expect((await call('PUT', '/api/admin/building', { cookie: otherCookie, body: { address: 'רחוב של החבר השני 2' } })).status).toBe(200)
    expect((await stored())[0].updated_by).toBe(other.id)

    expect((await call('DELETE', `/api/admin/admins/${other.id}`, { cookie })).status).toBe(200)
    const row = (await stored())[0]
    expect(row.updated_by).toBeNull()
    expect(row.address).toBe('רחוב של החבר השני 2') // the address itself stays
    expect(await publicAddress()).toBe('רחוב של החבר השני 2')
  })
})

describe('the agent API', () => {
  it('does not carry the address: it is not attendance data', async () => {
    await save('רחוב שלא לסוכן 5')
    const key = (await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'בדיקה' } })).json.key
    for (const path of ['/api/agent/v1/schema', '/api/agent/v1/points', '/api/agent/v1/providers', '/api/agent/v1/scans']) {
      const r = await call('GET', path, { token: key })
      expect(r.status, path).toBe(200)
      expect(r.text, path).not.toContain('שלא לסוכן')
    }
    expect((await call('GET', '/api/agent/v1/building', { token: key })).status).toBe(404)
  })

  it('does not carry the name either, in any answer', async () => {
    await put({ address: 'רחוב שלא לסוכן 6', name: 'שם שלא לסוכן' })
    const key = (await call('POST', '/api/admin/api-keys', { cookie, body: { name: 'בדיקת שם' } })).json.key
    for (const path of ['/api/agent/v1/schema', '/api/agent/v1/points', '/api/agent/v1/providers', '/api/agent/v1/scans', '/api/agent/v1/health']) {
      const r = await call('GET', path, { token: key })
      expect(r.status, path).toBe(200)
      expect(r.text, path).not.toContain('שם שלא לסוכן')
      expect(r.text, path).not.toContain('building_settings')
    }
    await db.pool.query("update building_settings set name = ''")
  })
})
