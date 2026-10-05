// The only writer of app_errors (db/migrations/010_app_errors.sql): the server's own record of what went wrong, kept for 90
// days where the runtime log of the host is kept for about one hour (docs/adr/0007-observability-in-our-own-postgres.md).
// One row is one kind of event in one hour with a count, so a loop of failures is one row and cannot fill the database.
//
// What may go in (AGENTS.md, Safety): the route as it is written in the code (`/admin/points/:id`, or a fixed screen key),
// the HTTP method, the status, the error's code or name (`failureLabel` in server/logSafe.js: a SQLSTATE, a socket errno, an
// error class), the build of the app, and the Vercel request id when the request carried a well-formed one. Counts and times
// are made by the table.
// What never may go in: a message (a library or database error can quote an input or a row value in it), the path that was
// asked for or its query string (a segment can hold a QR code, a name or an e-mail), a body, a token, a name, a QR code or
// a position. Every field below is checked or cut to a length before the query, and the table has the same limits as
// constraints, so a value that should not be there is cut here and refused there, never stored.
//
// This function never throws and never logs. The caller has already logged the error once (describeUnhandled in
// server/router.js), and a failure to record it is not worth a second line or a second failure. It is awaited by the
// router, so it is bounded, and error reporting must never turn into the outage it reports on (a burst of failures while
// the database is slow), so it is limited in four ways:
//   1. It never queues: unless the pool could give a client at once and keep one for the requests that are being served
//      (spareClients in server/db.js, ERROR_RECORD_POOL_RESERVE), nothing is attempted.
//   2. The database bounds the statement itself (ERROR_RECORD_LIMITS: `set local statement_timeout`, `lock_timeout` and
//      `idle_in_transaction_session_timeout` in the transaction of the insert), so a slow or blocked insert is cancelled there
//      and its connection goes back to the pool in about that time. Giving up on the wait (below) does not stop a statement.
//   3. The request waits for the insert at most ERROR_RECORD_TIMEOUT_MS (server/config.js), and a connection that arrives
//      after that is given back unused (the abort signal of the transaction).
//   4. When the error being recorded is itself a failure to reach the database, the insert would fail as well and only hold
//      the answer of the request, so it is not attempted.
import { query, spareClients } from './db.js'
import { ERROR_RECORD_TIMEOUT_MS, ERROR_RECORD_LOCK_TIMEOUT_MS, ERROR_RECORD_POOL_RESERVE } from './config.js'
import { oneLine } from './logSafe.js'

/** The values of app_errors.source and app_errors.kind. tests/error-log.test.js compares them with the checks of the table. */
export const EVENT_SOURCES = Object.freeze(['server', 'provider_app', 'committee_app'])
export const EVENT_KINDS = Object.freeze(['error', 'refusal', 'slow', 'crash', 'unhandled', 'signed_out'])
/** The values of app_errors.method besides the empty string (an event that is not a request). */
export const EVENT_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

// The length limits of the columns (the checks of the table say the same: db/migrations/010_app_errors.sql).
export const PLACE_MAX_LENGTH = 120
export const CODE_MAX_LENGTH = 60
export const APP_BUILD_MAX_LENGTH = 40
export const REQUEST_ID_MAX_LENGTH = 128
export const STATUS_MAX = 599

// What `place` is when a caller passes none (the table needs a place of at least one character).
const UNKNOWN_PLACE = '(unknown)'

// What a Vercel request id (the x-vercel-id header, for example `fra1::iad1::abcde-1700000000000-0123456789ab`) looks like.
// Anything else is not stored and not echoed: a header is the caller's text.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]+$/

/**
 * `value` when it is a well-formed request id (1 to 128 letters, digits, `:`, `_` or `-`), else null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeRequestId(value) {
  return typeof value === 'string' && value.length <= REQUEST_ID_MAX_LENGTH && REQUEST_ID_PATTERN.test(value) ? value : null
}

/**
 * The request id of a request, or null: the `x-vercel-id` header when it is well formed (safeRequestId), else nothing. The
 * router puts it in the 500 answer, and recordEvent stores it with the event, so the committee or the owner can find that
 * request in the log of the host within the hour.
 * @param {Record<string, unknown> | undefined} headers  the lower-cased headers of a Node request
 * @returns {string | null}
 */
export function requestIdOf(headers) {
  return safeRequestId(headers?.['x-vercel-id'])
}

// The SQLSTATEs that say the database is shut down or does not accept the connection (57P01 admin shutdown, 57P02 crash
// shutdown, 57P03 cannot connect now), and the codes that Node gives to a socket that failed.
const SHUTDOWN_SQLSTATES = new Set(['57P01', '57P02', '57P03'])
const SOCKET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'])
// The two errors of `pg` that have no code: the pool gave up waiting for a connection, and a connection ended. Recognised
// here only to decide, never logged and never stored.
const POOL_FAILURES = /^(?:timeout exceeded when trying to connect|Connection terminated)/

/**
 * Whether `err` is a failure to reach the database: a SQLSTATE of class 08 (connection exception), 57P01, 57P02 or 57P03,
 * a socket code of Node (ECONNREFUSED, ECONNRESET, ENOTFOUND, EAI_AGAIN, ETIMEDOUT), or the error of the pool that waited
 * too long for a connection. An error that wraps one (`cause`, or the `errors` of an AggregateError) counts too. It reads
 * the error to decide and keeps nothing of it.
 * @param {unknown} err
 * @param {number} [depth]
 */
export function isConnectionFailure(err, depth = 0) {
  if (err === null || typeof err !== 'object' || depth > 2) return false
  const { code, message, cause, errors } = /** @type {Record<string, unknown>} */ (err)
  if (typeof code === 'string' && (code.startsWith('08') || SHUTDOWN_SQLSTATES.has(code) || SOCKET_CODES.has(code))) return true
  if (err instanceof Error && typeof message === 'string' && POOL_FAILURES.test(message)) return true
  if (cause !== undefined && isConnectionFailure(cause, depth + 1)) return true
  return Array.isArray(errors) && errors.some((inner) => isConnectionFailure(inner, depth + 1))
}

/** `value` as one line of at most `max` characters, without control characters (a NUL byte is refused by Postgres). */
const text = (value, max) => (typeof value === 'string' ? oneLine(value.replace(/\p{Cc}/gu, ' '), max) : '')

/**
 * @typedef {object} RecordedEvent
 * @property {string} source  one of EVENT_SOURCES
 * @property {string} kind  one of EVENT_KINDS
 * @property {string} place  the route as written in the code (never the requested path), cut to 120 characters
 * @property {string} [method]  an HTTP method, else it is stored as empty
 * @property {number} [status]  the status of the answer, 0 to 599
 * @property {string} [code]  failureLabel(err): a code or a name, never a message, cut to 60 characters
 * @property {string} [appBuild]  the commit of the build, cut to 40 characters
 * @property {string | null} [requestId]  the Vercel request id, stored only when it is well formed
 * @property {unknown} [error]  the error that is being recorded. It is only asked whether it is a failure to reach the
 *   database (then nothing is attempted); nothing of it is stored
 */

/**
 * What goes into the row, every field checked or cut so that the insert cannot fail on a value: a place of 1 to 120
 * characters, a code of at most 60, a build of at most 40, a method from the list, a whole status from 0 to 599. Null when
 * the source or the kind is not one of the lists (there is nothing sensible to write instead).
 * @param {RecordedEvent} event
 */
function normalise({ source, kind, place, method, status, code, appBuild, requestId }) {
  if (!EVENT_SOURCES.includes(source) || !EVENT_KINDS.includes(kind)) return null
  const number = Number(status)
  return {
    source,
    kind,
    place: text(place, PLACE_MAX_LENGTH) || UNKNOWN_PLACE,
    method: EVENT_METHODS.includes(method) ? method : '',
    status: Number.isInteger(number) && number >= 0 && number <= STATUS_MAX ? number : 0,
    code: text(code, CODE_MAX_LENGTH),
    appBuild: text(appBuild, APP_BUILD_MAX_LENGTH),
    requestId: safeRequestId(requestId),
  }
}

// The row of this hour for this key gets one more event; the first event of a key in an hour makes the row. A request id
// that is missing never erases the one that is there.
const UPSERT = `
  insert into app_errors (bucket, source, kind, place, method, status, code, app_build, last_request_id)
  values (date_trunc('hour', now()), $1, $2, $3, $4, $5, $6, $7, $8)
  on conflict on constraint app_errors_key do update
    set count = app_errors.count + 1,
        last_at = now(),
        last_request_id = coalesce(excluded.last_request_id, app_errors.last_request_id)`

/**
 * The limits that the database puts on the insert (server/db.js sets them with `set local` in the transaction of this one
 * statement; every other statement of the app keeps the limits of the pool). The statement and idle limits are the time the
 * request waits, so a statement that the request gave up on is cancelled by the database in about that time, and a lock
 * that is held by another transaction is given up on sooner (ERROR_RECORD_LOCK_TIMEOUT_MS).
 */
export const ERROR_RECORD_LIMITS = Object.freeze({
  statementMs: ERROR_RECORD_TIMEOUT_MS,
  idleInTransactionMs: ERROR_RECORD_TIMEOUT_MS,
  lockMs: ERROR_RECORD_LOCK_TIMEOUT_MS,
})

/**
 * Records one event, or does nothing. Never throws, never logs, never queues for a connection, and waits for the database
 * at most ERROR_RECORD_TIMEOUT_MS. See the header of this file for the four limits, and for what may be passed: safe fields only.
 *
 * @param {RecordedEvent} event
 * @returns {Promise<void>}
 */
export async function recordEvent(event) {
  let timer
  const stopped = new AbortController()
  try {
    if (isConnectionFailure(event.error)) return
    const row = normalise(event)
    if (!row) return
    // Not while the pool is busy: this must not queue behind other work, join a queue that is there, or take the connection
    // that a request being served would need. The record is lost, like one that timed out (the error was logged once).
    if (spareClients() <= ERROR_RECORD_POOL_RESERVE) return
    // A late failure of the insert (after the timeout won the race) is handled by the race itself: it listens to both.
    await Promise.race([
      query(UPSERT, [row.source, row.kind, row.place, row.method, row.status, row.code, row.appBuild, row.requestId], {
        limits: ERROR_RECORD_LIMITS,
        signal: stopped.signal,
      }),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ERROR_RECORD_TIMEOUT_MS)
      }),
    ])
  } catch {
    // Silent on purpose: the caller has already logged the error once.
  } finally {
    clearTimeout(timer)
    // Nobody waits for the insert any more. If it has not started (its connection is still being made), it will not.
    stopped.abort()
  }
}
