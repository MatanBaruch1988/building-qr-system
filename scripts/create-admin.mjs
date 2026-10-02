// Adds (or re-enables) a committee member. They sign in with the Google account of this e-mail.
// Usage: npm run db:create-admin -- <google-email> [name]
// There is no password: the very first admin has to be added here, the rest from the admin screen.
// It writes to the database in DATABASE_URL (from the shell, else .env.local, which points at the non-production
// database), so for the first member of a deployment give it that deployment's connection string for this one command
// (see README). It prints which database it is about to write to, and names it again when it is done.
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const [email, name = ''] = process.argv.slice(2)
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run db:create-admin -- <google-email> [name]')
  process.exit(1)
}

const { getPool, query } = await import('../server/db.js')
const { readEnvironmentMarker, maskDatabaseHost } = await import('../server/dbGuard.js')

try {
  // Say where the row goes before writing it: the URL is the one the pool will use, and only its masked host is shown.
  const marker = await readEnvironmentMarker(getPool())
  const host = maskDatabaseHost(getPool().options.connectionString)
  const where = marker ? `the ${marker} database at ${host}` : `the database at ${host} (not marked)`
  console.log(`Writing to ${where}`)

  const { rows } = await query(
    `insert into admins (email, name) values ($1, $2)
     on conflict (email) do update set is_active = true
     returning email, is_active`,
    [email.trim().toLowerCase(), name],
  )
  console.log(`Committee member ready: ${rows[0].email} (signs in with Google) in ${where}`)
} finally {
  await getPool().end()
}
