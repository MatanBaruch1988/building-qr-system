// Usage: npm run db:migrate   (reads DATABASE_URL_UNPOOLED, else DATABASE_URL, from .env.local)
import pg from 'pg'
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const { poolConfig, guardPool } = await import('../server/db.js')
const { migrate } = await import('../server/migrate.js')
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
  process.exitCode = 1
} finally {
  await pool?.end()
}
