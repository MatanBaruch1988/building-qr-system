// Adds (or re-enables) a committee member. They sign in with the Google account of this e-mail.
// Usage: npm run db:create-admin -- <google-email> [name]
// There is no password: the very first admin has to be added here, the rest from the admin screen.
import { loadEnv } from '../server/loadEnv.js'
loadEnv()

const [email, name = ''] = process.argv.slice(2)
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run db:create-admin -- <google-email> [name]')
  process.exit(1)
}

const { getPool, query } = await import('../server/db.js')

try {
  const { rows } = await query(
    `insert into admins (email, name) values ($1, $2)
     on conflict (email) do update set is_active = true
     returning email, is_active`,
    [email.trim().toLowerCase(), name],
  )
  console.log(`Committee member ready: ${rows[0].email} (signs in with Google)`)
} finally {
  await getPool().end()
}
