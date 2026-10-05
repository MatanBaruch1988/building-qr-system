// The first unhandled server error of a building day tells the owner at once (docs/adr/0007-observability-in-our-own-postgres.md,
// step 2). The owner's computer is not on all the time and the host (Vercel Hobby) has no alerts, so the server pings its own
// check on healthchecks.io at the /fail address (server/heartbeat.js), and healthchecks.io e-mails and notifies the owner. The
// later errors of the same day send nothing: they are in app_errors (server/errorLog.js) for whoever looks.
//
// How the first one is told from the others: the table alert_pings (db/migrations/011_alert_pings.sql) holds one row for each
// building day that was announced, and `insert ... on conflict do nothing returning day` is the whole decision. Of two errors
// that arrive at the same moment, on any instance of the function, exactly one gets the row back and sends the ping. The day
// is the building's (isoDay of shared/datetime.js), the same day that a person reads in the committee app.
//
// When the database is the failure there is nothing to ask and nothing to count. An error that is a failure to reach it
// (isConnectionFailure of server/errorLog.js), a pool whose connections are all busy (the insert would queue behind other work,
// and the error may be a sign of that very overload), an insert that fails, and an insert that does not answer in time all take
// the same way out: a throttle in the memory of this function instance, one ping an hour at most. A long outage can ping more
// than once an hour, once per instance (the ADR says so). That is the price of needing no database for the alert.
//
// What is sent (AGENTS.md, Safety): a short line with the route as it is written in the code, the HTTP method, the error's
// code or name (failureLabel of server/logSafe.js) and the time, written by shared/datetime.js in the building's time zone.
// Never a message, the path that was asked for, a request id, a name or a body. The request id stays in app_errors.
//
// The answer of the request waits for all of this, because the host has no `waitUntil` and may freeze the function once it has
// answered, and so the wait is bounded (ALERT_TOTAL_TIMEOUT_MS in server/config.js). The cost is at most one wait a day, or one
// an hour when the database is down. noteServerError never throws and never logs: the caller has already logged the error.
// Without HEALTH_HEARTBEAT_URL (every Preview deployment, every local run and every test) it does nothing at all, not even a
// query, so that a day is not marked as announced when no ping could be sent.
import { query, spareClients } from './db.js'
import {
  ALERT_DB_TIMEOUT_MS,
  ALERT_LOCK_TIMEOUT_MS,
  ALERT_POOL_RESERVE,
  ALERT_TOTAL_TIMEOUT_MS,
  ALERT_UNREACHABLE_INTERVAL_MS,
} from './config.js'
import { EVENT_METHODS, isConnectionFailure } from './errorLog.js'
import { isHeartbeatConfigured, sendHeartbeat } from './heartbeat.js'
import { oneLine } from './logSafe.js'
import { formatDateTime, isoDay } from '../shared/datetime.js'

// The row of today, or nothing when the day was announced already. The day is the building's, not the database's.
const CLAIM_DAY = 'insert into alert_pings (day) values ($1) on conflict do nothing returning day'

const TIMED_OUT = Symbol('timed out')

/**
 * The limits that the database puts on the insert (server/db.js sets them with `set local` in the transaction of this one
 * statement; every other statement of the app keeps the limits of the pool), the same way as for the record of an error
 * (ERROR_RECORD_LIMITS in server/errorLog.js): the time that the call waits for it, so that a statement that nobody waits for
 * any more is cancelled by the database in about that time and its connection goes back to the pool, and a short lock limit.
 */
export const ALERT_LIMITS = Object.freeze({
  statementMs: ALERT_DB_TIMEOUT_MS,
  idleInTransactionMs: ALERT_DB_TIMEOUT_MS,
  lockMs: ALERT_LOCK_TIMEOUT_MS,
})

// The text of each kind of line, in front of the time. The first is the daily alert; the others are the way out when the database
// cannot be asked: it did not answer, or every connection of the pool was busy so that the insert would have had to wait in a
// queue behind other work, or it answered but the record of the day failed.
const FIRST_OF_THE_DAY = 'First server error today'
const DATABASE_UNREACHABLE = 'Database unreachable'
const DATABASE_BUSY = 'Server error, database busy'
const ALERT_RECORD_FAILED = 'Server error, alert record failed'

// When this instance last pinged without the database, in milliseconds (Date.now()), or null. One variable for the whole
// instance, on purpose: this is the one place where the database cannot hold the state.
let lastUnreachablePingAt = null

/** Forgets the throttle of this instance. For tests: nothing in the app calls it. */
export function resetAlertThrottle() {
  lastUnreachablePingAt = null
}

/** `value` as one short line of text (never a newline in what is sent: a line of the e-mail is not for the caller to forge). */
const line = (value, max) => oneLine(String(value ?? ''), max)

/**
 * The whole line that is sent: `<lead>, <DD/MM/YYYY HH:MM>: <METHOD> <place>[ <code>]`. The time is the moment of the call, in
 * the building's time zone. A method that is not one of the five is left out, and a place or code is cut to the length that
 * app_errors keeps.
 */
function bodyOf(lead, { place, method, code }, withCode) {
  const where = [EVENT_METHODS.includes(method) ? method : '', line(place, 120)].filter(Boolean).join(' ')
  const tail = [where, withCode ? line(code, 60) : ''].filter(Boolean).join(' ')
  return `${lead}, ${formatDateTime(new Date())}${tail ? `: ${tail}` : ''}`
}

/**
 * Whether this instance may ping now without the database, and if it may, takes the place: the ping is as good as sent (one try,
 * no retry), so a second error a moment later finds the place taken.
 */
function takeThePlaceOfThisHour() {
  const now = Date.now()
  if (lastUnreachablePingAt !== null) {
    const elapsed = now - lastUnreachablePingAt
    // A clock that went backwards does not hold the alert back for longer than the interval.
    if (elapsed >= 0 && elapsed < ALERT_UNREACHABLE_INTERVAL_MS) return false
  }
  lastUnreachablePingAt = now
  return true
}

/**
 * Asks the database whether this error is the first of the building day, and takes the day if it is. Never throws. It never
 * queues behind other work and never takes the last free connection (spareClients of server/db.js, ALERT_POOL_RESERVE): when
 * the pool is busy it does not ask at all (the error may be the sign of that very overload, and a wait would only hold up the
 * answer of the request). The database bounds the statement itself (ALERT_LIMITS), and a connection that arrives after the wait
 * is over is given back unused (the abort signal of the transaction).
 * @returns {Promise<'first' | 'already' | 'busy' | 'unreachable' | 'failed'>} `busy`: not asked, the pool had no free
 *   connection; `unreachable`: it did not answer in time, or the insert failed because it could not be reached; `failed`: the
 *   insert failed for another reason (the table is not there, say)
 */
async function claimTheDay() {
  let timer
  const stopped = new AbortController()
  try {
    if (spareClients() <= ALERT_POOL_RESERVE) return 'busy'
    const answer = await Promise.race([
      query(CLAIM_DAY, [isoDay()], { limits: ALERT_LIMITS, signal: stopped.signal }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ALERT_DB_TIMEOUT_MS)
      }),
    ])
    if (answer === TIMED_OUT) return 'unreachable'
    return answer.rowCount === 1 ? 'first' : 'already'
  } catch (failure) {
    // A late failure of the insert (after the timer won the race) is handled by the race itself: it listens to both.
    return isConnectionFailure(failure) ? 'unreachable' : 'failed'
  } finally {
    clearTimeout(timer)
    // Nobody waits for the insert any more. If it has not started (its connection is still being made), it will not.
    stopped.abort()
  }
}

/** Does the work of noteServerError, without the bound. */
async function announce(event) {
  if (isConnectionFailure(event.error)) {
    if (takeThePlaceOfThisHour()) await sendHeartbeat({ signal: 'fail', body: bodyOf(DATABASE_UNREACHABLE, event, false) })
    return
  }
  const day = await claimTheDay()
  if (day === 'already') return
  if (day === 'first') {
    await sendHeartbeat({ signal: 'fail', body: bodyOf(FIRST_OF_THE_DAY, event, true) })
    return
  }
  if (!takeThePlaceOfThisHour()) return
  const body =
    day === 'unreachable'
      ? bodyOf(DATABASE_UNREACHABLE, event, false)
      : bodyOf(day === 'busy' ? DATABASE_BUSY : ALERT_RECORD_FAILED, event, true)
  await sendHeartbeat({ signal: 'fail', body })
}

/**
 * Tells the owner about a server error when it is the first of the building day (see the header). Never throws, never logs,
 * and waits at most ALERT_TOTAL_TIMEOUT_MS. Pass the same safe fields that the router gives recordEvent: the route as it is
 * written in the code, the method and failureLabel of the error; `error` is only asked whether it is a failure to reach the
 * database, and nothing of it is sent.
 *
 * @param {object} event
 * @param {string} event.place  the route as written in the code (never the path that was asked for)
 * @param {string} event.method  an HTTP method
 * @param {string} event.code  failureLabel(error): a code or a name, never a message
 * @param {unknown} [event.error]  the error that is being reported
 * @returns {Promise<void>}
 */
export async function noteServerError(event) {
  let timer
  try {
    if (!isHeartbeatConfigured()) return
    await Promise.race([
      announce(event ?? {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ALERT_TOTAL_TIMEOUT_MS)
      }),
    ])
  } catch {
    // Silent on purpose: the caller has already logged the error once.
  } finally {
    clearTimeout(timer)
  }
}
