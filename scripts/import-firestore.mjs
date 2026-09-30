// One-time migration of the Firestore JSON export into Postgres.
// Usage:  node scripts/import-firestore.mjs <backup-dir>            (dry run: nothing is written)
//         node scripts/import-firestore.mjs <backup-dir> --apply    (writes)
import fs from 'node:fs'
import path from 'node:path'
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const [dir, flag] = process.argv.slice(2)
if (!dir) {
  console.error('Usage: node scripts/import-firestore.mjs <backup-dir> [--apply]')
  process.exit(1)
}
const apply = flag === '--apply'

const read = (name) => {
  const file = path.join(dir, `${name}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
}

const { getPool } = await import('../server/db.js')
const { importFirestore } = await import('../server/importFirestore.js')

const pool = getPool()
const client = await pool.connect()
try {
  await client.query('begin')
  const report = await importFirestore(client, {
    locations: read('locations'),
    workers: read('workers'),
    scans: read('scans'),
    failedScans: read('failedScans'),
  })
  const count = async (t) => (await client.query(`select count(*)::int n from ${t}`)).rows[0].n
  const after = { points: await count('points'), providers: await count('providers'), assignments: await count('point_providers'), scans: await count('scans') }

  console.log(JSON.stringify({ mode: apply ? 'APPLIED' : 'DRY RUN (rolled back)', ...report, postgresAfter: after }, null, 2))
  await client.query(apply ? 'commit' : 'rollback')
} catch (err) {
  await client.query('rollback').catch(() => {})
  console.error('Import failed, nothing was written:', err.message)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
