// Self-describing contract for the agent API. Served at GET /api/agent/v1/schema and mirrored in docs/agent-api.md.
import {
  TIMEZONE, SCAN_COOLDOWN_MINUTES, GPS_MAX_USABLE_ACCURACY_M, GPS_PIN_TOLERANCE_M, GPS_MAX_ACCURACY_CREDIT_M,
} from './config.js'

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
  endpoints: {
    'GET /api/agent/v1/scans':
      'Query: from, to (YYYY-MM-DD = a calendar day in Israel time, or an ISO date-time that carries Z or an offset), ' +
      'point_id, provider_id (uuids), service_type, flag (text, cut to 60 characters), ' +
      'outcome (accepted|rejected|all, default accepted), ' +
      'include_voided, include_demo (only true or 1 mean yes; anything else means no), order (asc|desc, default desc), ' +
      'limit (1-500, default 100; a larger number is cut to 500, not refused), cursor (from next_cursor), ' +
      'format (csv for CSV; any other value, or none, returns JSON). ' +
      'Returns { scans, count, next_cursor }: count is the number of scans in this page (not the total), ' +
      'next_cursor is null on the last page. With format=csv the body is CSV and next_cursor is in the X-Next-Cursor header ' +
      '(absent on the last page). CSV: flags are joined with ";", booleans are the text true/false, null is an empty cell.',
    'GET /api/agent/v1/points':
      'Returns { points } with every service point, including inactive ones (is_active=false). See points_fields.',
    'GET /api/agent/v1/providers':
      'Returns { providers } with every service provider, including inactive ones, with last_scan_at. See providers_fields.',
    'GET /api/agent/v1/schema': 'This document.',
    'GET /api/agent/v1/health': 'Liveness. Returns { ok, server_time (UTC ISO), server_time_local (YYYY-MM-DD HH:mm:ss in the building time zone) }.',
  },
  auth: 'Header "Authorization: Bearer qrk_…". Keys are created and revoked by the committee in the admin screen.',
  errors: {
    shape: '{ "error": { "code": "...", "message": "..." } }, sometimes with extra keys such as field.',
    api_key_required: '401: no key, or the header is not a Bearer qrk_ key.',
    api_key_invalid: '401: the key is unknown or revoked.',
    invalid_filter: '400: a bad from, to, point_id, provider_id, outcome, order or limit. The field key names it.',
    invalid_cursor: '400: the cursor is not one that this API returned.',
    invalid_input: '400: the database refused a value as out of range or malformed.',
    not_found: '404: no such endpoint.',
    method_not_allowed: '405: the endpoint exists but not for this HTTP method (everything here is GET).',
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
  },
  outcomes: {
    accepted: 'Recorded as attendance.',
    rejected_far: 'A usable GPS fix placed the phone clearly away from the point.',
    rejected_no_location: "The point requires GPS ('required') and no usable fix was sent.",
  },
  flags: {
    location_unverified: 'No usable GPS fix (typical indoors or in basements). Not evidence of fraud on its own.',
    location_outside_radius: 'A usable fix was a bit outside the point radius but not far enough to reject.',
    location_stale: "The position was remembered by the phone (older than a minute), so it shows where the person was a little earlier. 'optional' points allow for the walking since.",
    offline_sync: 'Scanned without signal and uploaded later; checked_in_at is the phone time.',
    clock_skew:
      'The phone clock cannot be trusted. Online scan: the phone time differed from the server time by more than 5 minutes, ' +
      'or was not a believable time; checked_in_at is the server time. Offline scan (offline_sync): the phone time was older than ' +
      '7 days, more than 5 minutes in the future, missing or not believable; checked_in_at is then the server time of the upload, ' +
      'so the real day of the visit is not known.',
    demo: 'Scanned with the demo account (test data). Hidden by default; use include_demo=true to see it.',
    legacy_import: 'Imported from the old Firebase system on 01/10/2026; its location and device details are not known.',
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
