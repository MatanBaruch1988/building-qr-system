// Usage: npm run db:migrate   (reads DATABASE_URL_UNPOOLED, else DATABASE_URL, from .env.local)
import pg from 'pg'
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const { poolConfig, guardPool } = await import('../server/db.js')
const { migrate, MigrationError } = await import('../server/migrate.js')
const { assertNotProduction } = await import('../server/dbGuard.js')

// The migration holds a session-level advisory lock for the whole run (server/migrate.js). A transaction pooler (the
// -pooler host of Neon) hands each statement to whichever server connection is free, so it cannot keep that lock: the
// direct connection is required.
const raw = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
let pool
try {
  if (!raw) throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set (see .env.example)')
  if (new URL(raw).hostname.includes('-pooler')) {
    throw new Error('The migration needs the direct connection string: set DATABASE_URL_UNPOOLED (the host without -pooler)')
  }
  pool = guardPool(new pg.Pool(poolConfig(raw)))
  // This command never touches production, whatever the environment variables say. Production is migrated by the Vercel
  // production build of a merge to master (scripts/vercel-build.mjs, ADR 0002), behind a gate that a shell variable
  // alone cannot open: a local `vercel build --prod` sets VERCEL_ENV=production too.
  await assertNotProduction(pool)
  const applied = await migrate(pool)
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.')
} catch (err) {
  console.error(err.message)
  if (err instanceof MigrationError) {
    // The message of a MigrationError says the file and the SQLSTATE only, because the production build log must never hold the
    // database's own text (it can quote a row value). Here it is safe to print more: assertNotProduction ran first and refuses a
    // production database, and this tool is for the development database, which holds fake data only. This is where a person
    // reads why a migration failed.
    console.error(`Database message: ${err.databaseMessage}`)
    if (err.position) console.error(`Position in ${err.file}: character ${err.position}`)
  }
  process.exitCode = 1
} finally {
  await pool?.end()
}
