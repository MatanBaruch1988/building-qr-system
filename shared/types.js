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
 * so a phone of another version can send fewer or more. The earlier fields `not_accepted` and `overflowed` (counts since the last
 * report, added up on the server) are not part of it any more: no released phone ever sent them, and the server now ignores them
 * like any field that it does not know.
 * @typedef {object} DeviceStatusReport
 * @property {string} [build]  the build id of the app (APP_BUILD_RE); anything else is ignored
 * @property {number} [waiting]  how many visits wait in the phone's queue, a whole number from 0 to SYNC_QUEUE_MAX_ITEMS
 * @property {string | null} [oldest_waiting_at]  ISO 8601 with a zone, the phone's clock for the oldest of them; stored only when
 *   it is not older than DEVICE_STATUS_MAX_AGE_DAYS and not more than 5 minutes ahead of the server, otherwise stored as nothing.
 *   Send it as null (or `waiting: 0`) when nothing waits
 * @property {number} [not_accepted_total]  how many visits the server refused for good since the phone signed in (since its device
 *   token), counted on the phone and NEVER reset after a report: a whole number from 0, cut to DEVICE_STATUS_MAX_TOTAL. The server
 *   keeps the larger of this and what it holds, so a retried, duplicate or out-of-order report changes nothing. Anything that is not
 *   a whole number from 0 is ignored (the stored value stays)
 * @property {number} [overflowed_total]  how many visits left a full queue since the phone signed in; counted and read the same way
 */

/**
 * The answer of POST /api/my/device-status, always, also when the server stored nothing (a report within
 * DEVICE_STATUS_MIN_INTERVAL_S of the last one). `build` is the first 7 characters of the commit that the server runs, or null when
 * it has none (a local server), so that a phone can tell that it is outdated.
 * @typedef {{ ok: true, build: string | null }} DeviceStatusAnswer
 */

/**
 * One entry of the audit log, as the committee reads it (GET /api/admin/audit, auditEntry in server/auditRead.js). It is
 * the row of `audit_log`, the name of the member and the current name of what the entry is about, nothing else: no session, no
 * token. The committee's agent reads the same log in a narrower shape (agentAuditEntry in server/auditRead.js: the same fields, with
 * the detail cut to the keys that its action allows).
 * @typedef {object} AuditEntry
 * @property {number} id  the row's number, which orders two entries with the same `at` (a number, like the id of a refused visit)
 * @property {string} at  ISO 8601, UTC
 * @property {string} action  `<group>.<what>`, for example `point.update` or `api_key.revoke`
 * @property {string | null} entity  what the action was about (`point`, `provider`, `scan`, ...); null for `retention.run`
 * @property {string | null} entity_id  null when the entity is one thing (`building`) or there is none
 * @property {string | null} entity_name  the CURRENT name of the thing that the entry is about, found by `entity_id`: the point's name, a
 *   provider's company (and contact, `Company - Contact`, as the history names a provider), a member's name or e-mail, a key's name.
 *   null for any other entity, and when that row no longer exists (a delete: the names in its `detail` are what is left)
 * @property {string} actor_type  `admin` (a committee member), `system` (the daily job) or `script` (a command run on the owner's machine)
 * @property {string | null} actor_id  the member's id; null for `system`; whatever the writer gave for `script`
 * @property {string | null} actor_name  the name as it was at the time of the action (their e-mail when they had no name), else the
 *   member's current name or e-mail for an older row; null for `system` and when nothing is known
 * @property {boolean} actor_deleted  an `admin` actor that is no longer on the committee list (the name on the row is still shown)
 * @property {Record<string, unknown> | null} detail  as it was stored: counts, ids, and for some actions a name, an e-mail, the building's address or the
 *   reason typed for a voided scan (docs/privacy.md)
 */

/**
 * The answer of GET /api/admin/audit: newest first, and `next_cursor` (null on the last page) is passed back as `cursor`.
 * @typedef {{ entries: AuditEntry[], next_cursor: string | null }} AuditPage
 */

/**
 * One thing an app reports about an error on its device (limits in section 9 of shared/contract.js, read by parseClientErrorReport in
 * server/routes/clientErrors.js). Only `kind` and `place` are needed; the server ignores an event without a valid pair, a field that is
 * not valid and a field that it does not know, so an app of another version can send fewer fields or more. Never put a message, a
 * stack, an address, a body, a token, a name, a QR code or a position in it: nothing of the sort is read, and a person reads this
 * type as the list of what leaves the device.
 * @typedef {object} ClientErrorEvent
 * @property {string} kind  one of CLIENT_ERROR_KINDS
 * @property {string} place  one of CLIENT_PLACES; `provider:...` to POST /api/my/errors and `committee:...` to POST /api/admin/client-errors
 * @property {string} [name]  the class of the error (ERROR_NAME_RE), for example `TypeError`
 * @property {string} [code]  a short code (CLIENT_ERROR_CODE_RE), for example an API error code. Kept in place of `name` when both are sent
 * @property {string} [build]  the build id of the app (APP_BUILD_RE)
 * @property {number} [count]  how many times it happened since the last report: a whole number, cut to CLIENT_ERROR_MAX_COUNT (1 when missing or not valid)
 */

/**
 * The body of POST /api/my/errors and POST /api/admin/client-errors: at most MAX_CLIENT_ERROR_EVENTS events (shared/contract.js), the
 * rest are ignored.
 * @typedef {{ events: ClientErrorEvent[] }} ClientErrorReport
 */

/**
 * The answer of both endpoints, always: `recorded` is how many events the server took from the report (valid ones, at most
 * MAX_CLIENT_ERROR_EVENTS), not how many rows it wrote. It never answers 400 for an event it does not like.
 * @typedef {{ ok: true, recorded: number }} ClientErrorAnswer
 */

export {}
