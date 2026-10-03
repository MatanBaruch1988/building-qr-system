// Creates a scratch schema with sample data for manual UI testing. Never touches the real tables.
// Usage: node scripts/dev-seed.mjs [schema=dev_ui]          create + seed (if empty)
//        node scripts/dev-seed.mjs [schema=dev_ui] --drop   remove the scratch schema
// The credentials below are DEV-ONLY sample values that exist only inside the scratch schema.
import pg from 'pg'
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const schema = process.argv.find((a) => /^[a-z_][a-z0-9_]*$/.test(a) && !a.endsWith('.mjs') && !a.startsWith('node')) || 'dev_ui'
const drop = process.argv.includes('--drop')
if (schema === 'public') throw new Error('Refusing to seed the public schema')

const { normalizeConnectionString } = await import('../server/db.js')
const raw = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
const control = new pg.Pool({ connectionString: normalizeConnectionString(raw), max: 1 })

// Before any write (also the drop): the seed never runs against a database that is marked as production.
const { assertNotProduction } = await import('../server/dbGuard.js')
try {
  await assertNotProduction(control)
} catch (err) {
  console.error(err.message)
  await control.end()
  process.exit(1)
}

if (drop) {
  await control.query(`drop schema if exists ${schema} cascade`)
  console.log(`Dropped schema ${schema}`)
  await control.end()
  process.exit(0)
}

await control.query(`create schema if not exists ${schema}`)
await control.end()

process.env.DB_SCHEMA = schema
const { getPool, query } = await import('../server/db.js')
const { migrate } = await import('../server/migrate.js')
const { hashPassword } = await import('../server/crypto.js')

await migrate(getPool())
const { rows } = await query('select count(*)::int n from providers')
if (rows[0].n === 0) {
  // Committee members sign in with Google; locally the API's dev-only shortcut accepts this e-mail.
  await query('insert into admins (email, name) values ($1,$2)', ['dev@example.test', 'Dev Admin'])
  const provider = async (company, contact, service, pw, demo = false) =>
    (await query(
      'insert into providers (company, contact_name, service_type, password_hash, is_demo) values ($1,$2,$3,$4,$5) returning id',
      [company, contact, service, await hashPassword(pw), demo],
    )).rows[0].id
  const lior = await provider('ניקיון', 'ליאור', 'cleaning', 'dev-pass-1')
  await provider('גינון', 'חמודי', 'gardening', 'dev-pass-2')
  await provider('Уборка', 'Иван', 'cleaning', 'dev-pass-3')
  await provider('Cleaning Co', 'John', 'cleaning', 'dev-pass-4')
  await provider('דמו', 'לקוח דמה', null, 'dev-pass-5', true)

  const point = async (name, mode, token, extra = {}) =>
    (await query(
      `insert into points (name, gps_mode, qr_token, lat, lng, radius_m, service_type, is_active)
       values ($1,$2,$3,32.3132,34.9442,50,$4,$5) returning id`,
      [name, mode, token, extra.service ?? null, extra.active ?? true],
    )).rows[0].id
  await point('לובי', 'optional', 'BQR-dev00000000000000000001')
  await point('מינוס 1', 'none', 'BQR-dev00000000000000000002')
  const gym = await point('גימבורי', 'required', 'BQR-dev00000000000000000003')
  await point('נקודה ישנה', 'optional', 'BQR-dev00000000000000000004', { active: false })
  await query('insert into point_providers (point_id, provider_id) values ($1,$2)', [gym, lior])
  console.log('Seeded sample admin, 5 providers (one demo), 4 points.')
}
// An invented address, so that the header of the provider app shows a line in development and in the E2E tests (the
// committee sets the real one in the committee app). Only when it is still empty: a value typed since is kept.
await query("update building_settings set address = 'רחוב הדוגמה 1, עיר לדוגמה' where id = 1 and address = ''")
console.log(`Scratch schema "${schema}" is ready. Start the API with: node server/dev.mjs --schema=${schema}`)
await getPool().end()
