// Self-describing contract for the agent API. Served at GET /api/agent/v1/schema and mirrored in AGENTS.md.
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
      'Query: from, to (YYYY-MM-DD in Israel time, or ISO date-time), point_id, provider_id, service_type, flag, ' +
      'outcome (accepted|rejected|all, default accepted), include_voided, include_demo, order (asc|desc, default desc), ' +
      'limit (1-500, default 100), cursor (from next_cursor), format (json|csv).',
    'GET /api/agent/v1/points': 'All service points, including inactive ones (is_active=false).',
    'GET /api/agent/v1/providers': 'All service providers, including inactive ones, with last_scan_at.',
    'GET /api/agent/v1/schema': 'This document.',
    'GET /api/agent/v1/health': 'Liveness and current server time.',
  },
  auth: 'Header "Authorization: Bearer qrk_…". Keys are created and revoked by the committee in the admin screen.',
  scan_fields: {
    id: 'uuid',
    point_id: 'uuid of the service point. A point can be deleted by the committee: its scans stay, so an old scan can carry a point_id that /points no longer lists. point_name then still says where it happened.',
    point_name: 'Name at the time of the scan (kept even if the point is later renamed)',
    provider_id: 'uuid of the service provider',
    provider_name: 'Company – contact name at the time of the scan',
    service_type: 'e.g. cleaning / gardening (from the point, else the provider)',
    source: "'online' or 'offline_sync' (the phone had no signal and uploaded later)",
    outcome: "'accepted' is a real check-in. 'rejected_*' are refused attempts kept for the record.",
    distance_m: 'Distance between the phone and the point when a GPS fix was sent, else null',
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
    clock_skew: 'The phone clock differed from the server by more than 5 minutes (or was implausible).',
    demo: 'Scanned with the demo account (test data). Hidden by default; use include_demo=true to see it.',
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
    history: 'Scans are kept: deleting a point does not delete its scans, and a scan is normally cancelled (voided), not removed. A committee member can still delete a single scan row on purpose (test data); it is then gone from this API. Providers are deactivated, not deleted.',
  },
}
