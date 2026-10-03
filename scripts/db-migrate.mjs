// Usage: npm run db:migrate   (reads DATABASE_URL from .env.local)
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const { getPool } = await import('../server/db.js')
const { migrate } = await import('../server/migrate.js')
const { assertNotProduction } = await import('../server/dbGuard.js')

try {
  // This command never touches production, whatever the environment variables say. Production is migrated by the Vercel
  // production build of a merge to master (scripts/vercel-build.mjs, ADR 0002), behind a gate that a shell variable
  // alone cannot open: a local `vercel build --prod` sets VERCEL_ENV=production too.
  await assertNotProduction(getPool())
  const applied = await migrate(getPool())
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.')
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  await getPool().end()
}
