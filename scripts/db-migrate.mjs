// Usage: npm run db:migrate   (reads DATABASE_URL from .env.local)
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const { getPool } = await import('../server/db.js')
const { migrate } = await import('../server/migrate.js')
const { assertNotProduction } = await import('../server/dbGuard.js')

try {
  // This command never touches production, whatever the environment variables say. Production will be migrated by a
  // separate deployment-only entrypoint that comes with the Vercel production build step (a later change). That one
  // must not be unlockable by a shell variable alone: a local `vercel build --prod` sets VERCEL_ENV=production too.
  await assertNotProduction(getPool())
  const applied = await migrate(getPool())
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.')
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  await getPool().end()
}
