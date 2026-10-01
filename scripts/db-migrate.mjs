// Usage: npm run db:migrate   (reads DATABASE_URL from .env.local)
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const { getPool } = await import('../server/db.js')
const { migrate } = await import('../server/migrate.js')

try {
  const applied = await migrate(getPool())
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.')
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  await getPool().end()
}
