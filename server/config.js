// Tunable rules in one place. Kept as plain constants: this is a one-building app.
//
// A value that the phone must agree on is NOT written here but in shared/contract.js, and re-exported below so that the
// server code keeps importing it from here: MAX_SYNC_BATCH, GPS_MAX_USABLE_ACCURACY_M, GPS_MAX_STALE_AGE_S,
// PASSWORD_MIN_LENGTH, PROVIDER_TOKEN_PREFIX and MAX_TOKEN_LENGTH. This file holds what only the server uses.
export {
  MAX_SYNC_BATCH,
  GPS_MAX_USABLE_ACCURACY_M,
  GPS_MAX_STALE_AGE_S,
  PASSWORD_MIN_LENGTH,
  PROVIDER_TOKEN_PREFIX,
  MAX_TOKEN_LENGTH,
} from '../shared/contract.js'
import { NAME_MAX_LENGTH } from '../shared/contract.js'

export const TIMEZONE = 'Asia/Jerusalem'

// Same provider + same point within this window is treated as one visit, not two.
export const SCAN_COOLDOWN_MINUTES = 10

// "Soft GPS" (see docs): a reading counts only when the phone says it is accurate to within GPS_MAX_USABLE_ACCURACY_M
// metres (150, shared/contract.js: the phone stops asking for a better fix at the same number).
// A vaguer one (or none) cannot be judged: 'required' points refuse it, 'optional' points accept and flag it.

// When a reading counts, the phone has to be inside the point's circle, with two allowances (every judged mode):
//  - a few metres for a pin that was placed by hand on a map,
//  - the phone's own reported inaccuracy (a weak reading is not the worker's fault), credited up to a cap so a
//    very vague reading cannot stretch the circle far.
// At the usual outdoor accuracy (~10 m) a 50 m point therefore accepts up to ~75 m; at most 50 + 15 + 50 = 115 m.
export const GPS_PIN_TOLERANCE_M = 15
export const GPS_MAX_ACCURACY_CREDIT_M = 50

// A remembered position is where the phone WAS. On 'optional' points (reception comes and goes) a reading older than
// GPS_STALE_AFTER_S is flagged `location_stale`, and the person may have walked since: that far (at a brisk walk,
// for at most GPS_MAX_STALE_AGE_S, 300 seconds, shared/contract.js: the oldest position the phone accepts) is added to
// the allowed distance. 'required' points ask for a fresh reading and get no such allowance.
export const GPS_STALE_AFTER_S = 60
export const GPS_WALKING_SPEED_MPS = 2

// Offline scans keep the phone's clock only if it is plausible. (The size of a sync batch, MAX_SYNC_BATCH, is in
// shared/contract.js with the phone's chunk, which has to stay below it.)
export const CLOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const CLOCK_MAX_FUTURE_MS = 5 * 60 * 1000
export const CLOCK_SKEW_FLAG_MS = 5 * 60 * 1000

// Login throttling (per 15-minute window). Every attempt is charged BEFORE the password is checked,
// so a burst of parallel guesses cannot slip through, and each attempt counts on three levels:
//  - this account from this network address (a typo-prone person is not locked out by strangers),
//  - this account overall (a slow distributed guesser still hits a wall),
//  - this network address overall (bounds the scrypt CPU an attacker can burn).
export const LOGIN_MAX_FAILURES = 8
export const LOGIN_MAX_PER_ACCOUNT = 40
export const LOGIN_MAX_PER_IP = 60
export const LOGIN_WINDOW_MINUTES = 15

export const ADMIN_SESSION_DAYS = 14
export const ADMIN_COOKIE = 'qr_admin'

// How long technical personal data is kept (owner decision of 04/10/2026, written for people in docs/privacy.md). A daily
// job (server/retention.js, GET /api/cron/retention) applies these, and only these: it never touches a scan, the audit
// log, an active session or an active phone. Changing a number is the owner's decision, and docs/privacy.md changes with it.
//  - a committee session is deleted this many days after it expired or was revoked,
//  - a login attempt is deleted after this many days (guardLogin in server/auth.js prunes the same way when someone signs in),
//  - the label of a phone (the browser string it sent at sign-in) is cleared this many days after the phone was revoked, together
//    with what the phone reported about itself (migration 010: its build, how many visits waited and since when, the totals),
//  - a recorded error (app_errors: safe fields only, no personal data) is deleted this many days after its last event,
//  - a day of the alert throttle (alert_pings: one date, no personal data) is deleted this many days after that day.
export const RETENTION_SESSION_DAYS = 30
export const RETENTION_LOGIN_ATTEMPT_DAYS = 1
export const RETENTION_DEVICE_LABEL_DAYS = 90
export const RETENTION_APP_ERROR_DAYS = 90
export const RETENTION_ALERT_PING_DAYS = 30

// Recording an unhandled server error in app_errors (server/errorLog.js) is one insert that the answer of the request waits
// for, so it is bounded: when the database does not answer within this many milliseconds the answer goes out without the
// record, and the record is lost (the error has already been logged once). The ADR of the topic (docs/adr/0007) names the
// cost: a 500 can take this much longer, never more. The wait is not the only bound, because giving up on a statement does
// not stop it: the insert carries the same time as its own statement limit (and as its idle-in-transaction limit), set by
// the database itself (`set local`, server/db.js), so the connection comes back to the pool in about that time too. Its lock
// limit is shorter: a row that another transaction holds (the daily retention job deleting old rows) is not worth waiting for.
export const ERROR_RECORD_TIMEOUT_MS = 1500
export const ERROR_RECORD_LOCK_TIMEOUT_MS = 500
// Recording never queues and never takes the last free connection: it is skipped unless the pool could give a client at once
// and still have this many left for the requests that are being served (the pool of the app has 3, poolConfig in server/db.js).
// A burst of failures while the database is slow therefore cannot make error records compete with healthy work for the pool.
export const ERROR_RECORD_POOL_RESERVE = 1

// A request that its guard let in and that took longer than this many milliseconds, from the start of the router to the moment
// its answer was ready, is recorded as a `slow` event in app_errors (server/router.js), with its route, method and status. It
// leaves room for a cold Neon start (a compute that is waking from sleep takes a few seconds, see poolConfig in server/db.js),
// so an ordinary first request after a quiet night is not slow, and a request that takes longer than that is.
export const SLOW_REQUEST_MS = 5000

// The first server error of a building day pings healthchecks.io (server/alerts.js, server/heartbeat.js, docs/adr/0007). The
// host (Vercel Hobby) has no way to finish work after the answer, and the function may freeze once it has answered, so the
// answer of the request waits for the ping, and every wait is bounded. It happens at most once a day, or once an hour (per
// function instance) when the database itself is down.
//  - ALERT_DB_TIMEOUT_MS: the one insert that decides whether the day was already announced. When it does not answer in time
//    the database counts as unreachable, and the throttle in memory decides instead. Like the record of an error (above) the
//    insert carries this time as its own statement limit, set by the database, so a statement that nobody waits for any more
//    is cancelled there, and a connection that arrives after the wait is given back unused. Its lock limit is the same short one
//    (ALERT_LOCK_TIMEOUT_MS): a row that another transaction holds is not worth a long wait.
//  - ALERT_POOL_RESERVE: like the record of an error, the insert never queues and never takes the last free connection: unless
//    the pool could give a client at once and keep this many for the requests that are being served, it is not attempted, and the
//    throttle in memory decides instead.
//  - HEARTBEAT_TIMEOUT_MS: the request to healthchecks.io. One try, no retry on the path of a request.
//  - ALERT_TOTAL_TIMEOUT_MS: the whole of noteServerError, whatever happens inside it (the two above, one after the other).
//  - ALERT_UNREACHABLE_INTERVAL_MS: with no database to ask, one ping an hour at most per function instance.
//  - HEARTBEAT_BODY_MAX_BYTES: what is sent is a short line of text; a longer body is cut (healthchecks.io keeps 100 kB at most).
export const ALERT_DB_TIMEOUT_MS = 1500
export const HEARTBEAT_TIMEOUT_MS = 1000
export const ALERT_TOTAL_TIMEOUT_MS = 2500
export const ALERT_UNREACHABLE_INTERVAL_MS = 60 * 60 * 1000
export const ALERT_POOL_RESERVE = ERROR_RECORD_POOL_RESERVE
export const ALERT_LOCK_TIMEOUT_MS = ERROR_RECORD_LOCK_TIMEOUT_MS
export const HEARTBEAT_BODY_MAX_BYTES = 8 * 1024

// The audit log keeps the name of the committee member as it was at the time of the action (audit_log.actor_name, a
// snapshot, so the entry stays readable after the member is deleted). The column refuses more than this many characters
// (db/migrations/007_audit_log_append_only.sql), so the code cuts a longer name instead of failing the action.
export const AUDIT_ACTOR_NAME_MAX_LENGTH = 200

// A refused visit (scan_refusals, db/migrations/008_scan_refusals.sql) keeps the names of the point and of the provider as they
// were, like a scan does. The columns refuse more than this many characters (the limit of a name elsewhere, and for a
// provider "company", a separator of 3 characters and "contact"), so the code cuts a longer name (an imported one can be)
// instead of losing the record of the refusal.
export const REFUSAL_POINT_NAME_MAX_LENGTH = NAME_MAX_LENGTH
export const REFUSAL_PROVIDER_NAME_MAX_LENGTH = 2 * NAME_MAX_LENGTH + 3

// Every secret the server mints starts with a prefix that says what it is. The same constants are used where a secret is
// minted and where it is checked, so the two can never drift apart. A token that does not start with its prefix cannot
// be one of ours, so it is refused before any database query (see server/auth.js).
// PROVIDER_TOKEN_PREFIX (a provider's phone: Authorization: Bearer ...) and MAX_TOKEN_LENGTH are in shared/contract.js and
// re-exported at the top of this file: the phone checks the same shape on the session that it kept (src/worker/session.js).
// A minted token is its 4-character prefix plus 43 characters (32 random bytes, base64url): 47 in all, and anything longer
// than MAX_TOKEN_LENGTH is not ours either, so it is refused without being hashed or looked up. It leaves room to grow, but
// not for a request that wants us to hash something huge.
export const ADMIN_TOKEN_PREFIX = 'qra_' // a committee session (the HttpOnly cookie)
export const API_KEY_PREFIX = 'qrk_' // a read-only agent key (Authorization: Bearer ...)

// The shortest password of a service provider, PASSWORD_MIN_LENGTH (8), is in shared/contract.js: the committee form checks it too.

// What the database itself enforces on the app's work (server/db.js sets both on every transaction): a statement that
// runs longer than the first is cut off (SQLSTATE 57014), and a transaction that sits idle longer than the second ends
// its connection (25P03). They keep a slow query from running until the 30 s limit of the Vercel function. A migration
// sets its own, longer, statement limit (server/migrate.js).
export const STATEMENT_TIMEOUT_MS = 15_000
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 20_000

export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 500
// The most refused visits that one page of the committee's list holds (GET /api/admin/scan-refusals).
export const MAX_REFUSAL_PAGE_SIZE = 200
// The most audit entries that one page of the committee's list holds (GET /api/admin/audit).
export const MAX_AUDIT_PAGE_SIZE = 200

// The text filters of the scan listing (service_type, flag) are cut to this many characters before they are compared.
export const FILTER_TEXT_MAX_LENGTH = 60
