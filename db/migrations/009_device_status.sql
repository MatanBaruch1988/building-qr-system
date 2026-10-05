-- What a phone reports about itself (ADR 0007, decision 4, "Phone health"). The committee cannot see that a provider's phone
-- holds visits that were never uploaded (the offline queue of the phone), since when, which version of the app it runs, or when
-- it last uploaded. provider_devices.last_seen_at is touched by the sign-in guard at most every 5 minutes and is never shown.
-- Expand only (see AGENTS.md, "Database and API changes"): every column is nullable, or has a constant default, so the
-- deployment that keeps serving while this one is built, which reads and writes named columns only, cannot be broken by it.
-- (A constant default is stored in the catalog and does not rewrite the table.) No schema-qualified names on purpose: tests run
-- this inside a throwaway schema.
--
-- What each column is, and who writes it:
--   app_build          the build id of the app on the phone (shared/contract.js, APP_BUILD_RE: 7 characters of the commit, or dev).
--   status_at          when the phone last reported (POST /api/my/device-status). The server stores a report only when the last one
--                      is DEVICE_STATUS_MIN_INTERVAL_S seconds old, so this is also what throttles the endpoint.
--   waiting_count      how many visits wait on the phone to be uploaded (0 to SYNC_QUEUE_MAX_ITEMS).
--   oldest_waiting_at  the phone's clock for the oldest of them, when the server believes it (not older than
--                      DEVICE_STATUS_MAX_AGE_DAYS, not in the future).
--   not_accepted_total, overflow_total   running totals of what the phone says it dropped since its last report: visits that
--                      the server refused for good, and visits that left a full queue. Added up on the server.
--   last_sync_at       when the server last finished POST /api/scans/sync for this phone. Written by the server from the sync
--                      itself, so it is right for every phone, also one that runs an old version of the app and reports nothing.
-- None of them holds a position, a name or a QR code. The retention job clears all of them with the label of the phone, 90 days
-- after the phone was revoked (server/retention.js, docs/privacy.md).
alter table provider_devices
  add column app_build text check (char_length(app_build) <= 40),
  add column status_at timestamptz,
  add column waiting_count integer check (waiting_count >= 0),
  add column oldest_waiting_at timestamptz,
  add column not_accepted_total integer not null default 0 check (not_accepted_total >= 0),
  add column overflow_total integer not null default 0 check (overflow_total >= 0),
  add column last_sync_at timestamptz;
