// The shapes that the phone (src/) and the server (server/) exchange over the API, written once as JSDoc typedefs: the
// scan that comes back, the request and the answer of POST /api/scans/sync, and the envelope of a refusal. It is the
// companion of shared/contract.js: that file holds the values that both sides must agree on, this one the shape of the
// data that carries them.
//
// There is no code in this file and nothing imports it at run time. The type checker (`npm run typecheck`,
// jsconfig.json) is its only reader, through `@import` and `import()` types in the files that send or read these shapes.
// Like the values of the contract, a change of a shape here is a decision about the old phones (AGENTS.md, "Database and
// API changes"): an installed app keeps its own copy of the JavaScript for days or weeks, so a field is added, never
// renamed or removed, and never made required for a client that does not send it yet.

/** @import * as contract from './contract.js' */

/** @typedef {typeof contract.OUTCOME_ACCEPTED | typeof contract.OUTCOME_REJECTED_FAR | typeof contract.OUTCOME_REJECTED_NO_LOCATION} ScanOutcome */
/** @typedef {typeof contract.SOURCE_ONLINE | typeof contract.SOURCE_OFFLINE_SYNC} ScanSource */

/**
 * The `error` member of every refusal: `{ error: { code, message, ...extra } }` (an ApiError of server/http.js on the server,
 * the `extra` of the ApiError of src/api/client.js on the phone). `code` is the machine's word, and what a client decides
 * from; `message` is an English sentence for a developer or a log. Some refusals add fields, for example `field`.
 * `request_id` is added to the 500 `server_error` only, when the host gave the request an id (the x-vercel-id header, a
 * well-formed one): it lets a person match the failure to the host's log, which is kept for about an hour. An optional,
 * additive field: a client that does not know it ignores it (src/api/client.js keeps the whole `error` in `extra`).
 * @typedef {{ code: string, message: string, request_id?: string, [extra: string]: unknown }} ErrorBody
 */

/** @typedef {{ error: ErrorBody }} ErrorEnvelope */

/** @typedef {typeof contract.GPS_MODE_REQUIRED | typeof contract.GPS_MODE_OPTIONAL | typeof contract.GPS_MODE_NONE} GpsMode */

/**
 * A service provider, as the provider's own phone sees one (providerJson in server/routes/provider.js): a tile of the login
 * list (GET /api/public/providers) and the `provider` of a session (POST and GET /api/session).
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} company
 * @property {string} contact_name  empty when there is none
 * @property {string | null} service_type
 */

/**
 * A point, as the phone can ask for it before anyone signs in (GET /api/public/points/resolve).
 * @typedef {object} PublicPoint
 * @property {string} name
 * @property {string} description  empty when there is none
 * @property {boolean} is_active
 * @property {GpsMode} gps_mode
 */

/**
 * A position reading. The phone sends it as it has it (src/worker/geo.js), and the server reads it with normalizeGps
 * (server/scans.js), which drops a reading without a usable `lat` and `lng`.
 * @typedef {object} Gps
 * @property {number} lat  degrees
 * @property {number} lng  degrees
 * @property {number | null} [accuracy]  metres
 * @property {number | null} [age_s]  how old the reading was when the phone took it, in seconds
 */

/**
 * A scan, as the API shows it (scanJson in server/scans.js): the answer of POST /api/scan, the `scan` of a sync result and
 * the rows of GET /api/my/scans.
 * @typedef {object} Scan
 * @property {string} id
 * @property {string} checked_in_at  ISO 8601, UTC
 * @property {string | null} checked_in_local  the building's time, `YYYY-MM-DD HH:MM:SS`
 * @property {string} local_date  `YYYY-MM-DD`, the building's day
 * @property {string} point_id
 * @property {string} point_name
 * @property {string} provider_id
 * @property {string} provider_name
 * @property {string | null} service_type
 * @property {ScanSource} source
 * @property {ScanOutcome} outcome  only `accepted` counts as attendance
 * @property {number | null} distance_m
 * @property {number | null} gps_accuracy_m
 * @property {string[]} flags  names from shared/flags.js
 * @property {boolean} voided
 * @property {string | null} void_reason
 */

/**
 * The answer of POST /api/scan. `duplicate` means an equal visit was already recorded within the cooldown.
 * @typedef {{ scan: Scan, duplicate: boolean }} ScanResponse
 */

/**
 * One check-in of the request of POST /api/scans/sync (what the phone sends from its queue, see flushQueue in
 * src/worker/scanQueue.js). `id` is made on the phone and is what makes a retry safe.
 * @typedef {object} SyncItem
 * @property {string} id
 * @property {string} code  the QR address that was scanned
 * @property {string} client_time  ISO 8601, the phone's clock
 * @property {Gps | null} gps
 */

/**
 * The body of POST /api/scans/sync: at most MAX_SYNC_BATCH items (shared/contract.js).
 * @typedef {{ scans: SyncItem[] }} SyncRequest
 */

/**
 * An item that was recorded (or was already: `duplicate`). `error?: undefined` lets a reader look at `error` without
 * having narrowed on `ok` first: without `strictNullChecks` TypeScript does not narrow a union on a boolean in the `else`.
 * @typedef {{ id: string, ok: true, scan: Scan, duplicate: boolean, error?: undefined }} SyncItemRecorded
 */

/**
 * An item that was refused. `error.code` is one of the SCAN_ERROR_* codes of shared/contract.js, and the phone decides from
 * it whether to drop the item (a permanent code) or keep it for a retry.
 * @typedef {{ id: string, ok: false, error: { code: string, message: string } }} SyncItemRefused
 */

/** @typedef {SyncItemRecorded | SyncItemRefused} SyncItemResult */

/**
 * The answer of POST /api/scans/sync: one result for each item that was sent, with the `id` of the item (the phone never
 * trusts an id that it did not send).
 * @typedef {{ results: SyncItemResult[] }} SyncResponse
 */

/**
 * What a phone reports about itself: the body of POST /api/my/device-status (limits in section 8 of shared/contract.js, read by
 * parseDeviceStatusReport in server/deviceStatus.js). It is a request of its own, never a field of the sync request. EVERY field
 * is optional, and the server ignores a field that is not valid (it never answers 400 for one) and a field that it does not know,
 * so a phone of another version can send fewer or more.
 * @typedef {object} DeviceStatusReport
 * @property {string} [build]  the build id of the app (APP_BUILD_RE); anything else is ignored
 * @property {number} [waiting]  how many visits wait in the phone's queue, a whole number from 0 to SYNC_QUEUE_MAX_ITEMS
 * @property {string | null} [oldest_waiting_at]  ISO 8601 with a zone, the phone's clock for the oldest of them; stored only when
 *   it is not older than DEVICE_STATUS_MAX_AGE_DAYS and not more than 5 minutes ahead of the server, otherwise stored as nothing.
 *   Send it as null (or `waiting: 0`) when nothing waits
 * @property {number} [not_accepted]  visits that the server refused for good since the phone's last report; added to a running
 *   total, cut to 0..DEVICE_STATUS_MAX_COUNT
 * @property {number} [overflowed]  visits that left a full queue since the phone's last report; the same way
 */

/**
 * The answer of POST /api/my/device-status, always, also when the server stored nothing (a report within
 * DEVICE_STATUS_MIN_INTERVAL_S of the last one). `build` is the first 7 characters of the commit that the server runs, or null when
 * it has none (a local server), so that a phone can tell that it is outdated.
 * @typedef {{ ok: true, build: string | null }} DeviceStatusAnswer
 */

export {}
