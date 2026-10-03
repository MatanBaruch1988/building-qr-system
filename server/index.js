// Importing the route files registers them with the router.
import './routes/provider.js'
import './routes/admin.js'
import './routes/agent.js'
import { route } from './router.js'
import { query } from './db.js'
import { requireApiKey } from './auth.js'
import { ApiError } from './http.js'

// The first 7 characters of the commit that Vercel built (only a deployment from Git has one), else null.
const commit = () => (process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null)

// No database on purpose: an uptime monitor pings this every few minutes, and a query each time would keep the Neon
// compute awake around the clock.
route('GET', '/health', async () => ({ ok: true, commit: commit() }))

const DB_HEALTH_TIMEOUT_MS = 5_000

// For the smoke test after a deploy ("does this deployment reach its database, and which migration is the newest?"),
// not for the uptime monitor. It needs a read-only agent key: an open route that queries the database would let anyone
// wake the Neon compute and tie up the small connection pool. The key is checked first, and a missing or malformed one is
// refused without a query. A failure says nothing about the cause (that goes to the log).
route('GET', '/health/db', async ({ req }) => {
  let timer
  try {
    const { rows } = await Promise.race([
      requireApiKey(req).then(() =>
        query('select 1 as ok, (select name from schema_migrations order by name desc limit 1) as migration'),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), DB_HEALTH_TIMEOUT_MS)
      }),
    ])
    return { json: { ok: true, commit: commit(), migration: rows[0].migration } }
  } catch (err) {
    if (err instanceof ApiError) throw err // a refused key is a 401, not a database failure
    console.error('health/db failed:', err.message)
    return { status: 503, json: { ok: false, commit: commit() } }
  } finally {
    clearTimeout(timer)
  }
})

export { handle } from './router.js'
