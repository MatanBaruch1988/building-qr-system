// Importing the route files registers them with the router.
import './routes/provider.js'
import './routes/admin.js'
import './routes/agent.js'
import { route } from './router.js'
import { query } from './db.js'

// The first 7 characters of the commit that Vercel built (only a deployment from Git has one), else null.
const commit = () => (process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null)

// No database on purpose: an uptime monitor pings this every few minutes, and a query each time would keep the Neon
// compute awake around the clock.
route('GET', '/health', async () => ({ ok: true, commit: commit() }))

const DB_HEALTH_TIMEOUT_MS = 5_000

// For the smoke test after a deploy ("does this deployment reach its database, and which migration is the newest?"),
// not for the uptime monitor. It is public, so a failure says nothing about the cause (that goes to the log).
route('GET', '/health/db', async () => {
  let timer
  try {
    const { rows } = await Promise.race([
      query('select 1 as ok, (select name from schema_migrations order by name desc limit 1) as migration'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), DB_HEALTH_TIMEOUT_MS)
      }),
    ])
    return { json: { ok: true, commit: commit(), migration: rows[0].migration } }
  } catch (err) {
    console.error('health/db failed:', err.message)
    return { status: 503, json: { ok: false, commit: commit() } }
  } finally {
    clearTimeout(timer)
  }
})

export { handle } from './router.js'
