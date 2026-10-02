// Usage: npm run db:migrate   (reads DATABASE_URL from .env.local)
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const { getPool } = await import('../server/db.js')
const { migrate } = await import('../server/migrate.js')
const { assertNotProduction } = await import('../server/dbGuard.js')

try {
  // Production is migrated only by the Vercel production build, where VERCEL_ENV is `production` (Vercel sets it and
  // loadEnv never reads it from a file). From any other place a production-marked database is refused.
  await assertNotProduction(getPool(), { allowOnVercelProduction: true })
  const applied = await migrate(getPool())
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.')
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  await getPool().end()
}
