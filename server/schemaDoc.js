// Self-describing contract for the agent API. Served at GET /api/agent/v1/schema and mirrored in docs/agent-api.md.
import {
  TIMEZONE, SCAN_COOLDOWN_MINUTES, GPS_MAX_USABLE_ACCURACY_M, GPS_PIN_TOLERANCE_M, GPS_MAX_ACCURACY_CREDIT_M,
  GPS_STALE_AFTER_S, CLOCK_MAX_AGE_MS, CLOCK_MAX_FUTURE_MS, CLOCK_SKEW_FLAG_MS, AGENT_KEY_MAX_PER_MINUTE, AGENT_KEY_MAX_PER_DAY,
} from './config.js'
import { AGENT_ENDPOINTS, endpointKey } from './agentEndpoints.js'
import { AUDIT_GROUPS } from './auditRead.js'
import { AUDIT_ACTOR_TYPES } from './audit.js'
import {
  FLAG_LOCATION_UNVERIFIED, FLAG_LOCATION_OUTSIDE_RADIUS, FLAG_LOCATION_STALE, FLAG_OFFLINE_SYNC, FLAG_CLOCK_SKEW,
  FLAG_DEMO, FLAG_LEGACY_IMPORT,
} from '../shared/flags.js'
import {
  OUTCOME_ACCEPTED, OUTCOME_REJECTED_FAR, OUTCOME_REJECTED_NO_LOCATION, SOURCE_ONLINE, SOURCE_OFFLINE_SYNC,
  SCAN_ERROR_INVALID_SCAN_ID, SCAN_ERROR_INVALID_CODE, SCAN_ERROR_UNKNOWN_CODE, SCAN_ERROR_POINT_INACTIVE, SCAN_ERROR_NOT_ASSIGNED,
  SCAN_ERROR_SCAN_ID_CONFLICT, SCAN_ERROR_INVALID_ITEM,
} from '../shared/contract.js'

// Every number that the prose below quotes from config.js is written from the constant (never typed), so a change of
// a limit changes this document with it. docs/agent-api.md cannot do that: tests/agent-docs.test.js compares its numbers
// with config.js instead.
const minutes = (ms) => ms / 60_000
const days = (ms) => ms / 86_400_000

// The audit log: what each field, group and action means. The keys of audit_actions are the actions of AUDIT_DETAIL_ALLOW (server/audit.js)
// and the keys of the detail of each are the keys that list allows; the OpenAPI document is written from both, and
// tests/agent-audit.test.js and tests/agent-docs.test.js fail when they differ.
const POINT_DETAIL = {
  name: 'The name of the point.',
  description: 'The description of the point.',
  service_type: 'The kind of service of the point (for example cleaning).',
  gps_mode: "'required', 'optional' or 'none'. See rules.gps_policy.",
  lat: "The latitude of the point itself (never a person's position).",
  lng: "The longitude of the point itself (never a person's position).",
  radius_m: 'The radius around the point in meters that counts as being there.',
  is_active: 'Whether the point can be scanned.',
}
const PROVIDER_DETAIL = {
  company: 'The company name of the provider.',
  contact_name: 'The contact person of the provider.',
  service_type: 'The kind of service of the provider.',
  is_active: 'Whether the provider can sign in.',
  is_demo: 'Whether the provider is the demo account.',
}
/** The older shape of an update (entries written before 05/10/2026): the fields that were sent, flat, where today's entries hold changes. */
const flat = (/** @type {Record<string, string>} */ fields) =>
  Object.fromEntries(Object.entries(fields).map(([key, text]) => [key, `${text} Only in an entry written before 05/10/2026, which holds the fields flat: today's entries hold them in changes.`]))
const CHANGES = (/** @type {string} */ fields) =>
  `What really changed: one key for each of ${fields}, each { from, to } (the value before and after; null is an empty value). Only the fields that changed are there.`
const SCANNED_AT = 'The providers who may scan at the point, as a list of provider ids (empty: any provider may).'

export const schemaDoc = {
  version: 'v1',
  purpose:
    'Attendance log for building service providers (cleaning, gardening). One row per QR scan. ' +
    'This API is read-only and does not analyse anything: it returns the raw records and signals, and counts of them (a count is a fact too; what it means is yours to say).',
  timezone: TIMEZONE,
  time_fields: {
    checked_in_at: 'UTC ISO time of the visit (best estimate; equals the phone time for plausible offline scans).',
    checked_in_local: `Same instant as 'YYYY-MM-DD HH:mm:ss' in ${TIMEZONE}.`,
    local_date: `Calendar date in ${TIMEZONE}. Use this for "per day" questions. To count visits per day, ask /counts (group_by=day) instead of counting rows.`,
  },
  // Built from the registry of server/agentEndpoints.js: the key (`GET /api/agent/v1/scans`) and the text of every endpoint, in
  // the order of the registry.
  endpoints: Object.fromEntries(AGENT_ENDPOINTS.map((endpoint) => [endpointKey(endpoint), endpoint.description])),
  auth:
    'Header "Authorization: Bearer qrk_…". Keys are created and revoked by the committee in the admin screen. ' +
    `One key may make at most ${AGENT_KEY_MAX_PER_MINUTE} requests in a minute and at most ${AGENT_KEY_MAX_PER_DAY} in a building day; see errors.rate_limited.`,
  errors: {
    shape: '{ "error": { "code": "...", "message": "..." } }, sometimes with extra keys such as field.',
    api_key_required:
      '401: no key, or the header is not a Bearer qrk_ key. The key is checked first: a request to an endpoint that exists but has no valid key gets a 401, ' +
      'whatever else is wrong with it, and every 400 below is answered only to a valid key.',
    api_key_invalid: '401: the key is unknown or revoked.',
    rate_limited:
      `429: the key is over a limit: at most ${AGENT_KEY_MAX_PER_MINUTE} requests in a minute and at most ${AGENT_KEY_MAX_PER_DAY} in a building day (midnight to midnight in ${TIMEZONE}). ` +
      "The error carries window ('minute' or 'day', the limit that was reached) and retry_after_s, and the Retry-After header says the same in seconds: wait that long and ask again. " +
      'A refused request does not count towards the limits. It is answered right after the key check, so only a valid key gets it, and before the rest of the request is looked at.',
    invalid_filter:
      '400: a bad from, to, point_id, provider_id, group, group_by, actor_id, outcome, order or limit. The field key names it. ' +
      'The counts (/counts) refuse in the same way a from or to that is missing, a range that is too long (the field is to) and an answer ' +
      'that would have too many rows (the field is group_by): their text under endpoints says how long and how many.',
    invalid_cursor: '400: the cursor is not one that this API returned.',
    invalid_input: '400: the database refused a value as out of range or malformed.',
    invalid_json:
      '400: the request carries a body that is not valid JSON. These endpoints read no body: send none. Only a valid key gets this answer; without one it is a 401.',
    not_found: '404: no such endpoint (answered without a key).',
    method_not_allowed: '405: the endpoint exists but not for this HTTP method (everything here is GET). Answered without a key.',
    server_error: '500: an unexpected failure on the server. Try again later.',
  },
  points_fields: {
    id: 'uuid',
    name: 'Name of the point',
    description: 'Free text from the committee, or null',
    service_type: 'e.g. cleaning / gardening, or null',
    gps_mode: "'required', 'optional' or 'none'. See rules.gps_policy.",
    lat: 'Latitude of the point, or null when the point has no coordinates',
    lng: 'Longitude of the point, or null when the point has no coordinates',
    radius_m: 'Radius around the point in meters that counts as being there',
    is_active: 'false when the committee switched the point off (it cannot be scanned)',
    created_at: 'UTC ISO time the point was created',
    assigned_provider_ids: 'Array of provider uuids assigned to the point (empty: any provider may scan it)',
  },
  providers_fields: {
    id: 'uuid',
    company: 'Company name',
    contact_name: 'Contact person, or null',
    service_type: 'e.g. cleaning / gardening, or null',
    is_active: 'false when the committee switched the provider off',
    is_demo: 'true for the demo account (its scans are test data, flagged demo)',
    created_at: 'UTC ISO time the provider was created',
    last_scan_at: 'UTC ISO time of the latest accepted, not voided scan, or null if none',
    active_devices: 'How many phones of the provider are signed in now (a phone that was signed out is not counted): a number, 0 when none. Never a row per phone.',
    waiting: 'The sum, over the signed-in phones, of the visits that each phone says it holds and has not uploaded yet (0 when none reported). A visit that waits on a phone is not in /scans until the phone uploads it.',
    oldest_waiting_at: "UTC ISO time of the oldest visit that waits on any of the signed-in phones (the phone's own clock, as it reported), or null when nothing waits or no believable time was reported",
    outdated_devices: "How many of the signed-in phones reported a version of the app that is not the server's own, a phone that was not updated since an earlier release (0 when none, or when the server does not know its own version)",
    last_sync_at: 'UTC ISO time of the latest upload of any signed-in phone, written by the server when an upload ended, or null when none of them uploaded',
    not_accepted_total: 'The sum, over the signed-in phones, of the visits that the server refused for good and that the phone dropped from its queue, counted since each phone signed in (0 when none)',
    overflow_total: 'The sum, over the signed-in phones, of the visits that left a full queue on the phone and were dropped (the oldest go first), counted since each phone signed in (0 when none)',
  },
  building_fields: {
    name: 'The name of the building, as the committee typed it, or an empty string when the committee has not set one',
    address: 'The address of the building, as the committee typed it, or an empty string when the committee has not set one',
  },
  scan_fields: {
    id: 'uuid',
    point_id: 'uuid of the service point. A point can be deleted by the committee: its scans stay, so an old scan can carry a point_id that /points no longer lists. point_name then still says where it happened.',
    point_name: 'Name at the time of the scan (kept even if the point is later renamed)',
    provider_id: 'uuid of the service provider',
    provider_name: 'Company – contact name at the time of the scan',
    service_type: 'e.g. cleaning / gardening (from the point, else the provider)',
    source: "'online' or 'offline_sync' (the phone had no signal and uploaded later)",
    outcome: "'accepted' is a real check-in. 'rejected_*' are refused attempts kept for the record.",
    distance_m: 'Distance between the phone and the point when a GPS fix was sent, else null. Also null when the point has no coordinates.',
    gps_accuracy_m: 'Reported GPS accuracy in meters, else null',
    flags: 'Signals for you to weigh. Never blocking. See flags below.',
    voided: 'true if a committee member cancelled this scan (excluded by default)',
    void_reason: 'Reason given when voided',
    voided_at: 'UTC ISO time the scan was voided, or null when it is not voided',
    voided_by: 'The name of the committee member who voided the scan (their e-mail when they have no name), as it was when they did it, or null when the scan is not voided or no record names who',
    received_at: 'UTC ISO time the server received the scan. The server clock, which cannot be wrong: unlike checked_in_at it is not an estimate, so for an offline_sync scan it is the time of the upload',
    device_id: "A random uuid for the sign-in of the phone that sent the scan, or null when it is not known (the old import has none). A sign-in belongs to one provider, and a phone that signs in again, or as another provider, gets a new id: so it tells apart the phones that one provider's scans came from, and it does not recognise the same physical phone across sign-ins or providers. Nothing else about the phone is available",
  },
  // The counts (GET /counts, server/scanCounts.js). The row of the answer has all seven fields every time; a dimension that the request
  // did not group by is null. The sum of the counts is the number of scans that /scans returns for the same filters.
  count_fields: {
    day: `The day of the visits in the group, YYYY-MM-DD in ${TIMEZONE} (the local_date of the scans), or null when the answer is not grouped by day.`,
    provider_id: 'uuid of the service provider of the group, or null when the answer is not grouped by provider. A provider can be deleted by the committee: its scans stay, so this can be an id that /providers no longer lists.',
    provider_name: "Company – contact name as the scans recorded it (the provider_name of /scans), or null when the answer is not grouped by provider. The name can change over a range (the committee renamed the provider): every row of one provider then carries the name that its newest counted visit has, so one provider is one name and never two groups.",
    point_id: 'uuid of the service point of the group, or null when the answer is not grouped by point. A point can be deleted by the committee: its scans stay, so this can be an id that /points no longer lists.',
    point_name: 'Name of the point as the scans recorded it (the point_name of /scans, which stays when the point is renamed or deleted), or null when the answer is not grouped by point. When the name changed over the range, every row of one point carries the name that its newest counted visit has.',
    service_type: "The kind of service that the scans carry (the service_type of /scans, from the point, else the provider), or null. When the answer is grouped by service_type, a null means the visits that have no service type; when it is not, null just means not grouped.",
    count: 'How many visits are in the group: the scans that /scans would list for the same filters and the same day, provider, point and service_type. 0 only in the one row of an answer that is not grouped and found no visit.',
  },
  count_groups: {
    day: `One row for each day (the local_date of the visits, a day in ${TIMEZONE}).`,
    provider: 'One row for each service provider (by provider_id).',
    point: 'One row for each service point (by point_id).',
    service_type: 'One row for each kind of service (the service_type of the visits, and one more row for the visits that have none).',
  },
  refusal_fields: {
    id: 'A whole number that identifies the refusal. It is not the id of any scan.',
    at: 'UTC ISO time at which the server refused the visit (the server clock). The list is in this order, newest first.',
    scan_id: "The phone's own id of the check-in, or null when the phone sent none that was valid. Usually not the id of a row of /scans, because the visit was not counted; for scan_id_conflict it is the id of a scan of another provider.",
    source: "'online' (the phone had a signal and the visit arrived at once) or 'offline_sync' (the phone had no signal and uploaded the visit later from its queue). The same two words as the source of a scan.",
    code: 'Why the server refused the visit: one of the codes of refusal_codes.',
    provider_id: 'uuid of the service provider who scanned. A provider can be deleted by the committee: its refusals stay, so an old refusal can carry a provider_id that /providers no longer lists. provider_name then still says who it was.',
    provider_name: 'Company – contact name at the time of the visit (kept even if the provider is renamed or deleted)',
    point_id: 'uuid of the service point that the scanned code named, or null when the visit was refused before its code could be matched to a point (see refusal_codes). A point can be deleted by the committee: its refusals stay, so this can be an id that /points no longer lists.',
    point_name: 'Name of the point at the time of the visit, or null when point_id is null',
    client_time: "UTC ISO time on the phone's own clock when the person scanned, or null when the phone sent no believable time (a real date between the years 2000 and 2100). The time at which the server refused the visit is at.",
  },
  refusal_codes: {
    [SCAN_ERROR_POINT_INACTIVE]: 'The committee had switched the point off when the visit reached the server. The point is named (point_id, point_name).',
    [SCAN_ERROR_NOT_ASSIGNED]: 'The point is assigned to other providers and not to this one (a point with no assignment may be scanned by anyone, and the demo account may scan every point). The point is named.',
    [SCAN_ERROR_UNKNOWN_CODE]: 'The scanned text has the shape of a QR code of this system, but no point has it (a point that was deleted, or a code that was never issued). No point is named.',
    [SCAN_ERROR_INVALID_CODE]: 'The scanned text is not a QR code of this system at all. No point is named.',
    [SCAN_ERROR_INVALID_SCAN_ID]: "The phone's id of the check-in was not a valid id. scan_id is then null, and no point is named.",
    [SCAN_ERROR_SCAN_ID_CONFLICT]: "The phone's id of the check-in was already the id of a scan of another provider. scan_id is that id; no point is named.",
    [SCAN_ERROR_INVALID_ITEM]: 'The database refused the data of the visit as out of range or malformed, when a phone uploaded it from its queue (source offline_sync). Nothing the committee can mend. A point is named when the code had named one.',
  },
  audit_fields: {
    id: 'A whole number that identifies the entry. It is not the id of anything the entry is about.',
    at: 'UTC ISO time at which the change was made (the server clock). The list is in this order, newest first.',
    action: "What was done, as '<group>.<verb>' (for example point.update): one of audit_actions. An entry of a newer version can carry an action that is not listed there: its detail is then null.",
    entity: "What the entry is about: 'point', 'provider', 'admin' (a committee member), 'api_key', 'scan' or 'building', or null for the daily job (retention.run). The entity of each action is in audit_actions.",
    entity_id: 'uuid of the thing the entry is about, as text, or null when there is none (the building, the daily job). The thing may be gone: a point, a provider, a member, a key or a scan can be deleted, and its entries stay.',
    entity_name: "The CURRENT name of the point, provider (the company, and ' – ' and the contact when there is one), committee member (the name, or the e-mail) or agent key that the entry is about, taken from the committee's own lists. Null for any other entity, and when that thing no longer exists (the detail of its delete then holds what it was called).",
    actor_type: "Who made the change: 'admin' (a committee member), 'system' (the daily clean-up job, and the first member of a deployment who is added by the system), or 'script' (a command that the owner ran on a computer).",
    actor_id: 'uuid of the committee member, as text, or null for the system and for a command. Use it as the actor_id filter.',
    actor_name: 'The name of the committee member as it was when they made the change (their e-mail when they had no name), or, for an older entry without one, their current name or e-mail. Null for the system and for a command, and when nothing is known.',
    actor_deleted: 'true when the actor is a committee member who is no longer on the committee list (actor_name is still what they were called).',
    detail: 'Null, or an object with the keys that audit_actions lists for the action of the entry, and no others. A text in it is null when it looks like a key, a hash, a token or an id. See audit_detail.',
  },
  audit_groups: {
    admin: 'The committee list: a member was added, switched on, switched off or deleted.',
    building: "The building's name or address was saved with a new value.",
    point: 'A service point was created, changed, had its QR code replaced, or was deleted.',
    provider: 'A service provider was created, changed, had its phones signed out, or was deleted.',
    scan: 'A committee member voided a scan, restored a voided one, or deleted one for good.',
    api_key: 'An agent key was created, revoked or deleted.',
    retention: 'The daily clean-up job ran (counts only).',
    session: 'A committee member signed in or out.',
  },
  audit_actions: {
    'admin.add': {
      entity: 'admin',
      meaning: 'A member was added to the committee list: by a member, by the owner with a command, or, for the first member of a deployment, by the system.',
      detail: { email: 'The e-mail address of the new member.' },
    },
    'admin.enable': {
      entity: 'admin',
      meaning: 'A member who was switched off was switched on again.',
      detail: {
        email: 'The e-mail address of the member. Only when the member was switched on by adding the same e-mail address again.',
        changes: CHANGES('is_active'),
      },
    },
    'admin.disable': {
      entity: 'admin',
      meaning: 'A member was switched off: they cannot sign in, and their open sessions were ended.',
      detail: { changes: CHANGES('is_active') },
    },
    'admin.delete': {
      entity: 'admin',
      meaning: 'A member was removed from the committee list for good.',
      detail: { email: 'The e-mail address the member had.', name: 'The name the member had (an empty text when there was none).' },
    },
    'session.sign_in': {
      entity: 'admin',
      meaning: 'A committee member signed in. The entity is the member who signed in, who is also the actor.',
      detail: { method: "How: 'google', or 'dev' (a shortcut of a local development setup)." },
    },
    'session.sign_out': {
      entity: 'admin',
      meaning: 'A committee member signed out. The entity is that member. The detail is always null.',
      detail: {},
    },
    'building.update': {
      entity: 'building',
      meaning: "The building's address or name was saved with a new value.",
      detail: { changes: CHANGES('address and name') },
    },
    'point.create': {
      entity: 'point',
      meaning: 'A service point was created.',
      detail: { ...POINT_DETAIL, provider_ids: SCANNED_AT },
    },
    'point.update': {
      entity: 'point',
      meaning: 'A service point was changed, or the list of providers who may scan there was.',
      detail: {
        ...flat(POINT_DETAIL),
        changes: CHANGES('name, description, service_type, gps_mode, lat, lng, radius_m and is_active'),
        provider_ids:
          'The providers added to and removed from the list of providers who may scan at the point: { added, removed }, two lists of provider ids. ' +
          'Only when the list changed. An entry written before 05/10/2026 holds the whole list of provider ids instead.',
      },
    },
    'point.delete': {
      entity: 'point',
      meaning: 'A service point was deleted. Its scans stay, with the name it had.',
      detail: { name: 'The name the point had.', scans_kept: 'How many scans at the point stay in the history.' },
    },
    'point.regenerate_qr': {
      entity: 'point',
      meaning: 'The QR code of a point was replaced, so the printed one stopped working. The code itself is never recorded. The detail is always null.',
      detail: {},
    },
    'provider.create': {
      entity: 'provider',
      meaning: 'A service provider was created.',
      detail: { company: 'The company name of the new provider.' },
    },
    'provider.update': {
      entity: 'provider',
      meaning: 'A service provider was changed, or its password was replaced (a new password signs its phones out, and so does switching the provider off).',
      detail: {
        ...flat(PROVIDER_DETAIL),
        changes: CHANGES('company, contact_name, service_type, is_active and is_demo'),
        password_changed: 'true when the password was replaced. The password itself is never recorded, and the key is there only when it was replaced.',
      },
    },
    'provider.delete': {
      entity: 'provider',
      meaning: 'A service provider was deleted. Its scans stay, with the name it had, and its phones were signed out.',
      detail: {
        company: 'The company name the provider had.',
        contact_name: 'The contact person the provider had (an empty text when there was none).',
        scans_kept: 'How many scans of the provider stay in the history.',
      },
    },
    'provider.revoke_devices': {
      entity: 'provider',
      meaning: 'All the phones of a provider were signed out.',
      detail: { devices: 'How many phones were signed in and were signed out (0 is possible).' },
    },
    'scan.void': {
      entity: 'scan',
      meaning: 'A committee member voided a scan: it no longer counts, and it is hidden unless include_voided is asked for.',
      detail: { reason: 'The reason the member typed, or null when they typed none.' },
    },
    'scan.unvoid': {
      entity: 'scan',
      meaning: 'A committee member restored a voided scan.',
      detail: { previous_reason: 'The reason that the void had, which the restore cleared (null when it had none).' },
    },
    'scan.delete': {
      entity: 'scan',
      meaning: 'A committee member deleted a scan for good (test data, a row that should never have been there). The scan is gone from /scans, and the entry keeps a copy of its main fields.',
      detail: {
        point_name: 'The name of the point of the scan, as it was recorded.',
        provider_name: 'The provider of the scan, as it was recorded.',
        checked_in_at: 'UTC ISO time of the visit.',
        outcome: 'The outcome of the scan. See outcomes.',
        voided: 'true when the scan was voided when it was deleted.',
      },
    },
    'api_key.create': {
      entity: 'api_key',
      meaning: 'An agent key was created. The key itself is never recorded.',
      detail: { name: 'The name the committee gave the key.' },
    },
    'api_key.revoke': {
      entity: 'api_key',
      meaning: 'An agent key was revoked: it stops working at once, and its row stays. The detail is always null.',
      detail: {},
    },
    'api_key.delete': {
      entity: 'api_key',
      meaning: 'An agent key was deleted for good (revoked or not). Its name is in the detail, because the key is gone.',
      detail: {
        name: 'The name the key had.',
        was_revoked: 'true when the key had been revoked before it was deleted.',
      },
    },
    'retention.run': {
      entity: null,
      meaning:
        'The daily clean-up job ran (one entry a day, by the system actor). It has no entity. The detail holds counts only: how many rows of ' +
        'each kind it deleted. An older entry has fewer keys.',
      detail: {
        sessions: 'Committee sessions deleted.',
        login_attempts: 'Login attempts deleted.',
        device_labels: 'Phones whose label and reported status were cleared.',
        app_errors: 'Recorded errors deleted.',
        alert_pings: 'Alert days deleted.',
        api_key_usage: 'Minutes of the usage of agent keys deleted.',
      },
    },
  },
  audit_detail:
    'The detail of an entry is null, or an object whose keys depend on the action: audit_actions lists them for each action, and a key that is ' +
    'not listed there is never shown, whatever the entry holds. A text in a detail is null when it looks like a key, a hash, a token or an id ' +
    '(or when a word of it does), and so is a value that is not of the kind its key holds. A detail never holds a key (not even its first ' +
    "characters), a token, a hash, a password, a QR code, the label or the browser of a phone, a network address or a person's position. " +
    'The detail is null when the action keeps none, when the action is not listed in audit_actions (an entry of a newer version), and when ' +
    "none of its listed keys is in it. Names, e-mail addresses and reasons of the committee are shown: the agent is the committee's analyst. " +
    `The actor_type is one of ${AUDIT_ACTOR_TYPES.join(', ')}, and the group filter is one of ${AUDIT_GROUPS.join(', ')}. The log is append-only: an entry is never ` +
    'changed or deleted.',
  outcomes: {
    [OUTCOME_ACCEPTED]: 'Recorded as attendance.',
    [OUTCOME_REJECTED_FAR]: 'A usable GPS fix placed the phone clearly away from the point.',
    [OUTCOME_REJECTED_NO_LOCATION]: "The point requires GPS ('required') and no usable fix was sent.",
  },
  sources: {
    [SOURCE_ONLINE]: 'The phone had a signal and the scan arrived at once.',
    [SOURCE_OFFLINE_SYNC]: 'The phone had no signal and uploaded the scan later.',
  },
  flags: {
    [FLAG_LOCATION_UNVERIFIED]: 'No usable GPS fix (typical indoors or in basements). Not evidence of fraud on its own.',
    [FLAG_LOCATION_OUTSIDE_RADIUS]: 'A usable fix was a bit outside the point radius but not far enough to reject.',
    [FLAG_LOCATION_STALE]: `The position was remembered by the phone (older than ${GPS_STALE_AFTER_S} seconds), so it shows where the person was a little earlier. 'optional' points allow for the walking since.`,
    [FLAG_OFFLINE_SYNC]: 'Scanned without signal and uploaded later; checked_in_at is the phone time.',
    [FLAG_CLOCK_SKEW]:
      `The phone clock cannot be trusted. Online scan: the phone time differed from the server time by more than ${minutes(CLOCK_SKEW_FLAG_MS)} minutes, ` +
      'or was not a believable time; checked_in_at is the server time. Offline scan (offline_sync): the phone time was older than ' +
      `${days(CLOCK_MAX_AGE_MS)} days, more than ${minutes(CLOCK_MAX_FUTURE_MS)} minutes in the future, missing or not believable; checked_in_at is then the server time of the upload, ` +
      'so the real day of the visit is not known.',
    [FLAG_DEMO]: 'Scanned with the demo account (test data). Hidden by default; use include_demo=true to see it.',
    [FLAG_LEGACY_IMPORT]: 'Imported from the old Firebase system on 01/10/2026; its location and device details are not known.',
  },
  rules: {
    duplicate_window_minutes: SCAN_COOLDOWN_MINUTES,
    duplicate_rule: 'Same provider at the same point within this window is stored once.',
    gps_policy: {
      max_usable_accuracy_m: GPS_MAX_USABLE_ACCURACY_M,
      pin_tolerance_m: GPS_PIN_TOLERANCE_M,
      max_accuracy_credit_m: GPS_MAX_ACCURACY_CREDIT_M,
      distance_rule: `A usable fix is judged the same way on 'required' and 'optional' points: the phone must be inside the point radius plus pin_tolerance_m, after crediting its own reported accuracy (up to max_accuracy_credit_m). Farther than that is rejected_far.`,
      note: "Points can be 'required', 'optional' or 'none' (no reception). 'required' and 'optional' differ only when there is no usable fix: 'required' refuses it (rejected_no_location), 'optional' accepts it with location_unverified. 'none' points are never judged by GPS.",
    },
    history: 'Scans are kept: deleting a point does not delete its scans, and a scan is normally cancelled (voided), not removed. A committee member can still delete a single scan row on purpose (test data); it is then gone from this API. A provider can be deleted by the committee: its scans stay and keep the recorded name, so an old scan can carry a provider_id that /providers no longer lists. provider_name then still says who it was.',
  },
}
