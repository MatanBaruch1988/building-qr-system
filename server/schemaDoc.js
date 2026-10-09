// Self-describing contract for the agent API. Served at GET /api/agent/v1/schema and mirrored in docs/agent-api.md.
import {
  TIMEZONE, SCAN_COOLDOWN_MINUTES, GPS_MAX_USABLE_ACCURACY_M, GPS_PIN_TOLERANCE_M, GPS_MAX_ACCURACY_CREDIT_M,
  GPS_STALE_AFTER_S, CLOCK_MAX_AGE_MS, CLOCK_MAX_FUTURE_MS, CLOCK_SKEW_FLAG_MS, AGENT_KEY_MAX_PER_MINUTE, AGENT_KEY_MAX_PER_DAY,
} from './config.js'
import { AGENT_ENDPOINTS, endpointKey } from './agentEndpoints.js'
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

export const schemaDoc = {
  version: 'v1',
  purpose:
    'Attendance log for building service providers (cleaning, gardening). One row per QR scan. ' +
    'This API is read-only and does not analyse anything: it returns the raw records and signals.',
  timezone: TIMEZONE,
  time_fields: {
    checked_in_at: 'UTC ISO time of the visit (best estimate; equals the phone time for plausible offline scans).',
    checked_in_local: `Same instant as 'YYYY-MM-DD HH:mm:ss' in ${TIMEZONE}.`,
    local_date: `Calendar date in ${TIMEZONE}. Use this for "per day" questions.`,
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
    invalid_filter: '400: a bad from, to, point_id, provider_id, outcome, order or limit. The field key names it.',
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
