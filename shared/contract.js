// What the phone (src/) and the server (server/) must AGREE on: the one place. A value or a list that both sides use is
// written here once and imported by both, so that the two can never drift apart. Runs in the browser and on the server,
// so it holds plain constants only (no server secret, no database, nothing that belongs to one side). The flags of a scan
// are the same kind of list and live in shared/flags.js; the prefixes of the other secrets that the server mints (a committee
// session, an agent key) are in server/config.js, which also re-exports what is here.
//
// Moving a value here changes where it is written, never what it is. tests/contract.test.js pins every number and list,
// and says why each one matters. The reason is always the same: an installed app keeps its own copy of the JavaScript
// for days or weeks (AGENTS.md, "Database and API changes"), and the offline queue on a phone can hold check-ins that an
// old version wrote. So a change of a value here is a decision about the old phones, never a detail.

// ---- 1. The offline sync -----------------------------------------------------------------------------------------
// The phone saves a check-in while it has no signal and uploads it later with POST /api/scans/sync.

/**
 * The most scans that the server takes in one POST /api/scans/sync. A bigger batch is refused whole (`batch_too_large`).
 * Never lower it below what an installed phone sends (the chunk below was 10 from the start), or the queue of that phone
 * is stuck for good.
 */
export const MAX_SYNC_BATCH = 20

/**
 * How many saved check-ins the phone uploads in one request. The server handles a batch item by item (about ten database
 * round trips each), so it stays small enough to finish inside the request timeout on a slow connection. It must never
 * exceed MAX_SYNC_BATCH (tests/contract.test.js).
 */
export const SYNC_CHUNK_SIZE = 10

/** The most check-ins that the phone keeps in its queue; when it is full the oldest ones go. A whole number of chunks. */
export const SYNC_QUEUE_MAX_ITEMS = 500

// The codes of a refusal of one scan. They are written in server/scans.js (recordScan: the answer of POST /api/scan, and
// the error of one item of POST /api/scans/sync) and server/routes/provider.js (the sync handler), and read on the phone
// (src/worker/scanQueue.js decides from them what to do with a queued item; src/worker/errors.js, hooks.js and
// src/pages/WorkerApp.jsx show a message for some of them). Written in code only through these constants.
export const SCAN_ERROR_INVALID_SCAN_ID = 'invalid_scan_id'
export const SCAN_ERROR_INVALID_CODE = 'invalid_code'
export const SCAN_ERROR_UNKNOWN_CODE = 'unknown_code'
export const SCAN_ERROR_POINT_INACTIVE = 'point_inactive'
export const SCAN_ERROR_NOT_ASSIGNED = 'not_assigned'
export const SCAN_ERROR_SCAN_ID_CONFLICT = 'scan_id_conflict'
// The database refused the item's data (out of range, malformed): sync only, see the handler in server/routes/provider.js.
export const SCAN_ERROR_INVALID_ITEM = 'invalid_item'

/**
 * The codes that the phone treats as final for a queued item: the server will never accept it, so the phone drops it and
 * counts it (src/worker/scanQueue.js). Any code that is NOT here keeps the item in the queue for a retry, and a retry that
 * never succeeds blocks the head of the queue: the phone stops when a whole chunk makes no progress. So an installed
 * phone knows exactly these seven, and a new code that a sync item can carry has to be decided (permanent here, or
 * retryable below) in the same change that adds it.
 */
export const SYNC_PERMANENT_ERROR_CODES = Object.freeze([
  SCAN_ERROR_INVALID_CODE,
  SCAN_ERROR_UNKNOWN_CODE,
  SCAN_ERROR_POINT_INACTIVE,
  SCAN_ERROR_NOT_ASSIGNED,
  SCAN_ERROR_INVALID_SCAN_ID,
  SCAN_ERROR_SCAN_ID_CONFLICT,
  SCAN_ERROR_INVALID_ITEM,
])

/** The codes of a sync item that are deliberately retried (the item stays in the queue). None today. */
export const SYNC_RETRYABLE_ERROR_CODES = Object.freeze([])

/** Every code that the server can attach to one sync item: each one is permanent or retryable, never both, never neither. */
export const SYNC_ITEM_ERROR_CODES = Object.freeze([...SYNC_PERMANENT_ERROR_CODES, ...SYNC_RETRYABLE_ERROR_CODES])

// ---- 2. The GPS limits that both sides use -----------------------------------------------------------------------

/** A reading counts only when the phone says it is accurate to within this many metres. The phone also stops asking for a better one. */
export const GPS_MAX_USABLE_ACCURACY_M = 150

/**
 * How old a remembered position may be, in seconds. The phone accepts such a position (src/worker/geo.js, `maximumAge`),
 * and the server credits the walking done since only up to this age (server/scanLogic.js), so the two are one number: a
 * phone that accepted an older one would be judged as if it had walked less than it did.
 */
export const GPS_MAX_STALE_AGE_S = 300

// ---- 3. The vocabularies -----------------------------------------------------------------------------------------
// The words of a scan. The database allows exactly these (check constraints in db/migrations/001_init.sql), and the
// agent API documents them (server/schemaDoc.js, docs/agent-api.md). tests/contract.test.js compares them with the table.

/** How a point checks the location of a scan (points.gps_mode). Listed in this order everywhere. */
export const GPS_MODE_REQUIRED = 'required'
export const GPS_MODE_OPTIONAL = 'optional'
export const GPS_MODE_NONE = 'none'
export const GPS_MODES = Object.freeze([GPS_MODE_REQUIRED, GPS_MODE_OPTIONAL, GPS_MODE_NONE])
/** The mode of a point that the committee did not choose one for (the default of the column, and of the form). */
export const DEFAULT_GPS_MODE = GPS_MODE_OPTIONAL

/** What became of a scan (scans.outcome). Only `accepted` counts as attendance. */
export const OUTCOME_ACCEPTED = 'accepted'
export const OUTCOME_REJECTED_FAR = 'rejected_far'
export const OUTCOME_REJECTED_NO_LOCATION = 'rejected_no_location'
export const SCAN_OUTCOMES = Object.freeze([OUTCOME_ACCEPTED, OUTCOME_REJECTED_FAR, OUTCOME_REJECTED_NO_LOCATION])

/** How a scan reached the server (scans.source). */
export const SOURCE_ONLINE = 'online'
export const SOURCE_OFFLINE_SYNC = 'offline_sync'
export const SCAN_SOURCES = Object.freeze([SOURCE_ONLINE, SOURCE_OFFLINE_SYNC])

// ---- 4. The limits that the committee form and the server both check --------------------------------------------
// The form tells the person before sending, and the server refuses what the form let through (or what a script sends).

/** The radius of a point, in metres (points.radius_m has the same bounds as a check constraint, and 50 as its default). */
export const POINT_RADIUS_MIN_M = 1
export const POINT_RADIUS_MAX_M = 1000
export const POINT_RADIUS_DEFAULT_M = 50

/** The password of a service provider, in characters. The minimum is what the server enforces; the maximum is the longest it reads. */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 200

// The longest text of each field, in characters (UTF-16 units: the same count on both sides).
export const NAME_MAX_LENGTH = 120 // a point, a company, a contact person, a committee member
export const DESCRIPTION_MAX_LENGTH = 500 // a point
export const SERVICE_TYPE_MAX_LENGTH = 60 // a point, a provider
export const VOID_REASON_MAX_LENGTH = 300 // why a scan was cancelled
export const KEY_NAME_MAX_LENGTH = 80 // an agent key
export const DEVICE_LABEL_MAX_LENGTH = 80 // a phone, as the provider's app names it when it signs in
export const EMAIL_MAX_LENGTH = 200 // a committee member
export const ADDRESS_MAX_LENGTH = 200 // the building (also the limit of the column, see db/migrations/006_building_settings.sql)

// ---- 5. The QR token ---------------------------------------------------------------------------------------------

/** What a token that this system mints starts with (the committee app makes them, the import regenerates them). */
export const QR_TOKEN_PREFIX = 'BQR-'

/**
 * What one of our QR tokens looks like. A token is the prefix and 6 to 80 letters, digits or hyphens: this has to
 * accept every token that was ever printed (the old system's too), so it is never narrowed. parseQrToken
 * (shared/qrToken.js) is the one reader of it.
 */
export const QR_TOKEN_RE = /^BQR-[A-Za-z0-9-]{6,80}$/

// ---- 6. The device token of a service provider -------------------------------------------------------------------
// POST /api/session mints it, the phone keeps it in `qr.session` and sends it as `Authorization: Bearer ...`, and the server
// refuses a token that is not shaped like one before any database query (server/auth.js). The phone applies the same shape
// to what it reads back from its own storage (src/worker/session.js), so that a session that is not one of ours is dropped.

/** What a provider's device token starts with. (server/config.js re-exports it, and the other prefixes are written there.) */
export const PROVIDER_TOKEN_PREFIX = 'qrp_'

/**
 * The longest token of any kind that the server looks at: a minted token is its 4-character prefix plus 43 characters (32
 * random bytes, base64url), 47 in all, and anything longer than this is not ours. (server/config.js re-exports it.)
 */
export const MAX_TOKEN_LENGTH = 200

// ---- 7. The build id of the app ----------------------------------------------------------------------------------
// An installed app keeps running the JavaScript it has until the person next opens it, so the build id is how the committee
// and the owner tell which version a phone runs. vite.config.js writes it into the bundle, src/ui/build.js reads it, and both
// apps show it (the home screen of the provider app, the Committee tab of the committee app).

/**
 * What the build id of the app looks like: the first 7 characters of the commit that Vercel built (the same 7 characters
 * that GET /api/health/db reports as `commit`), or `dev` for a build that has no commit (a local build, the E2E tests, the
 * unit tests). Never narrow it: an installed phone keeps the id it was built with for as long as it is not updated, so a
 * reader of this shape (src/ui/build.js now, the server when a phone reports its build) must accept every id that a build
 * ever wrote.
 */
export const APP_BUILD_RE = /^(?:[0-9a-f]{7}|dev)$/
