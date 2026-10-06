// Creates a scratch schema with sample data for manual UI testing. Never touches the real tables.
// Usage: node scripts/dev-seed.mjs [schema=dev_ui]          create + seed (if empty)
//        node scripts/dev-seed.mjs [schema=dev_ui] --drop   remove the scratch schema
// The credentials below are DEV-ONLY sample values that exist only inside the scratch schema.
import pg from 'pg'
import { loadEnv } from '../server/loadEnv.js'
import { assertScratchSchema } from './e2e-config.mjs'
loadEnv()

// The name of the schema is the one argument that is not a flag. It goes into SQL as an identifier, so it is checked (and
// `public` and `neon_auth` are refused) before anything else happens. An E2E run passes its own (E2E_SCHEMA).
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (names.length > 1) throw new Error(`Expected one schema name, got ${names.length}: ${names.join(' ')}`)
const schema = assertScratchSchema(names[0] ?? 'dev_ui')
const drop = process.argv.includes('--drop')

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
const { SAMPLE_POINT, SAMPLE_PROVIDER_NAMES } = await import('./sample-data.mjs')
const { providerSnapshotName } = await import('../server/scans.js')
const { SCAN_ERROR_POINT_INACTIVE, SCAN_ERROR_NOT_ASSIGNED, SCAN_ERROR_UNKNOWN_CODE, SCAN_ERROR_INVALID_ITEM, SOURCE_ONLINE, SOURCE_OFFLINE_SYNC } =
  await import('../shared/contract.js')

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
  const ploni = await provider('ניקיון', SAMPLE_PROVIDER_NAMES.cleaner, 'cleaning', 'dev-pass-1')
  const almoni = await provider('גינון', SAMPLE_PROVIDER_NAMES.gardener, 'gardening', 'dev-pass-2')
  const ivan = await provider('Уборка', 'Иван', 'cleaning', 'dev-pass-3')
  const john = await provider('Cleaning Co', 'John', 'cleaning', 'dev-pass-4')
  await provider('דמו', 'לקוח דמה', null, 'dev-pass-5', true)

  const point = async (name, mode, token, extra = {}) =>
    (await query(
      `insert into points (name, gps_mode, qr_token, lat, lng, radius_m, service_type, is_active)
       values ($1,$2,$3,$6,$7,50,$4,$5) returning id`,
      [name, mode, token, extra.service ?? null, extra.active ?? true, SAMPLE_POINT.lat, SAMPLE_POINT.lng],
    )).rows[0].id
  await point('לובי', 'optional', 'BQR-dev00000000000000000001')
  await point('מינוס 1', 'none', 'BQR-dev00000000000000000002')
  const gym = await point('גימבורי', 'required', 'BQR-dev00000000000000000003')
  const old = await point('נקודה ישנה', 'optional', 'BQR-dev00000000000000000004', { active: false })
  await query('insert into point_providers (point_id, provider_id) values ($1,$2)', [gym, ploni])

  // A few visits that the server refused (ADR 0007, "Visits not counted"), so that the committee's list of them has rows to
  // show in development and in the E2E tests: a point that was switched off (from a phone's queue, with the phone's own
  // clock), a person who is not assigned (online), a code that names no point (from a queue) and one item of bad data.
  // Their times are relative to the moment of seeding, so that they fall in the history's default week. The names are the
  // snapshots that a refusal keeps, as the server writes them. Fake people and the seed's own points, like the rest.
  const refusal = (code, source, who, pointRow, minutesAgo, phoneMinutesAgo = null) =>
    query(
      `insert into scan_refusals (at, source, code, provider_id, provider_name, point_id, point_name, client_time)
       values (now() - make_interval(mins => $1::int), $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8::int))`,
      [minutesAgo, source, code, who.id, providerSnapshotName(who), pointRow?.id ?? null, pointRow?.name ?? null, phoneMinutesAgo],
    )
  await refusal(SCAN_ERROR_POINT_INACTIVE, SOURCE_OFFLINE_SYNC, { id: ploni, company: 'ניקיון', contact_name: SAMPLE_PROVIDER_NAMES.cleaner }, { id: old, name: 'נקודה ישנה' }, 180, 205)
  await refusal(SCAN_ERROR_NOT_ASSIGNED, SOURCE_ONLINE, { id: almoni, company: 'גינון', contact_name: SAMPLE_PROVIDER_NAMES.gardener }, { id: gym, name: 'גימבורי' }, 120)
  await refusal(SCAN_ERROR_UNKNOWN_CODE, SOURCE_OFFLINE_SYNC, { id: john, company: 'Cleaning Co', contact_name: 'John' }, null, 60, 100)
  await refusal(SCAN_ERROR_INVALID_ITEM, SOURCE_OFFLINE_SYNC, { id: ivan, company: 'Уборка', contact_name: 'Иван' }, null, 30)
  console.log('Seeded sample admin, 5 providers (one demo), 4 points, 4 refused visits.')
}
// An invented address and an invented name, so that the header of the provider app shows two lines, and the committee app its
// brand, in development and in the E2E tests (the committee sets the real ones in the committee app). Each only when it is still
// empty: a value typed since is kept.
await query("update building_settings set address = 'רחוב הדוגמה 1, עיר לדוגמה' where id = 1 and address = ''")
await query("update building_settings set name = 'בניין הדוגמה' where id = 1 and name = ''")
console.log(`Scratch schema "${schema}" is ready. Start the API with: node server/dev.mjs --schema=${schema}`)
await getPool().end()
