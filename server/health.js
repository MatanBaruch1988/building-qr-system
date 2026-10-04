// What GET /api/health/db needs besides its handler (server/index.js): the commit, the time limit, and the guard of that
// route. The route is the smoke test after a deploy, so a database that is down or does not answer must be answered with
// a 503 in its own shape, also when the failure happens while the key is being looked up. The router runs the guard before
// the handler (server/access.js), so the key lookup and its time limit live here, in the guard, and not in the handler.
// There is ONE time limit for the whole request, the key lookup and the health query together: the guard writes down when
// it runs out (deadlines), and the handler races its query against what is left (timeLeft).
import { requireApiKey } from './auth.js'
import { Answer, ApiError } from './http.js'

export const DB_HEALTH_TIMEOUT_MS = 5_000

// The first 7 characters of the commit that Vercel built (only a deployment from Git has one), else null.
export const commit = () => (process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : null)

// When the time limit of a request runs out (a time in ms), written down by the guard that starts it.
const deadlines = new WeakMap()

/** What is left of the time limit of this request, in ms (0 when it is used up). The whole limit when the guard has not run. */
export function timeLeft(req) {
  const deadline = deadlines.get(req)
  return deadline === undefined ? DB_HEALTH_TIMEOUT_MS : Math.max(0, deadline - Date.now())
}

/**
 * `requireApiKey` for GET /api/health/db. A missing, malformed or unknown key is refused exactly as by the plain guard (a
 * 401, and no query for a key that is not shaped like ours). When the lookup fails or does not finish within
 * DB_HEALTH_TIMEOUT_MS, the request is answered with the 503 of this route (`{ ok: false, commit }`) and nothing of the
 * cause: that goes to the log.
 */
export async function requireApiKeyForHealth(req) {
  let timer
  if (!deadlines.has(req)) deadlines.set(req, Date.now() + DB_HEALTH_TIMEOUT_MS)
  try {
    return await Promise.race([
      requireApiKey(req),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), DB_HEALTH_TIMEOUT_MS)
      }),
    ])
  } catch (err) {
    if (err instanceof ApiError) throw err // a refused key is a 401, not a database failure
    console.error('health/db failed:', err.message)
    throw new Answer({ status: 503, json: { ok: false, commit: commit() } })
  } finally {
    clearTimeout(timer)
  }
}
