// Importing the route files registers them with the router.
import './routes/provider.js'
import './routes/admin.js'
import './routes/audit.js'
import './routes/refusals.js'
import './routes/agent.js'
import './routes/cron.js'
import { route } from './router.js'
import { query } from './db.js'
import { requireApiKey } from './auth.js'
import { ApiError } from './http.js'
import { commit, timeLeft, healthTimeout } from './health.js'
import { failureLabel } from './logSafe.js'

// No database on purpose: an uptime monitor pings this every few minutes, and a query each time would keep the Neon
// compute awake around the clock.
route('GET', '/health', async () => ({ ok: true, commit: commit() }))

// For the smoke test after a deploy ("does this deployment reach its database, and which migration is the newest?"),
// not for the uptime monitor. It needs a read-only agent key: an open route that queries the database would let anyone
// wake the Neon compute and tie up the small connection pool. The router checks the key before this handler runs
// (requireApiKeyForHealth in server/health.js, chosen by server/access.js), and a missing or malformed one is refused
// without a query; the call below returns that answer without a second lookup. The key lookup and the query share one
// time limit (DB_HEALTH_TIMEOUT_MS in server/health.js). A failure says nothing about the cause (its code or name goes to the log, never its message).
route('GET', '/health/db', async ({ req }) => {
  let timer
  try {
    // One time limit for the whole request: the guard started it with the key lookup, and this is what is left of it.
    const left = timeLeft(req)
    if (left <= 0) throw healthTimeout()
    const { rows } = await Promise.race([
      requireApiKey(req).then(() =>
        query('select 1 as ok, (select name from schema_migrations order by name desc limit 1) as migration'),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(healthTimeout()), left)
      }),
    ])
    return { json: { ok: true, commit: commit(), migration: rows[0].migration } }
  } catch (err) {
    if (err instanceof ApiError) throw err // a refused key is a 401, not a database failure
    console.error(`health/db failed: ${failureLabel(err)}`)
    return { status: 503, json: { ok: false, commit: commit() } }
  } finally {
    clearTimeout(timer)
  }
})

export { handle } from './router.js'
