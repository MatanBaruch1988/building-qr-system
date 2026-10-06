# Attendance data for an AI agent (read-only API)

Building attendance log: one row per QR scan by a service provider (cleaning company, gardener).
The app records facts and signals only. It never analyses, scores or judges: that is your job.

- **Base URL:** `https://<your-domain>/api/agent/v1` (the committee sees the exact address in the admin screen, in the Agent tab ("אייג׳נט"))
- **Auth:** `Authorization: Bearer qrk_…`, a key the committee creates and can revoke at any time. Read-only.
- **Self-description:** `GET /schema` returns this contract as JSON. Read it first.
- **Ready-made system prompt for the committee's agent:** [`agent-prompt.md`](agent-prompt.md).
- **Time:** all human-readable times are Israel time. `checked_in_at` is UTC ISO, `checked_in_local` is
  `YYYY-MM-DD HH:mm:ss` in Asia/Jerusalem, `local_date` is the Israeli calendar day (use it for "per day").

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /scans` | Scan records, newest first. Filters below. |
| `GET /points` | Every service point, including inactive ones, with assigned providers. |
| `GET /providers` | Every provider, including inactive and demo ones, with `last_scan_at`. |
| `GET /schema` | Field, flag and rule descriptions. |
| `GET /health` | Liveness and server time. |

### Response envelopes

| Endpoint | Top level of the JSON answer |
|---|---|
| `GET /scans` | `{ scans, count, next_cursor }`. `count` is the number of scans in this page, not the total. `next_cursor` is `null` on the last page. |
| `GET /points` | `{ points }` |
| `GET /providers` | `{ providers }` |
| `GET /health` | `{ ok, server_time, server_time_local }` (UTC ISO, and `YYYY-MM-DD HH:mm:ss` in Israel time) |

### `GET /scans` filters

`from`, `to` (`YYYY-MM-DD` = Israel calendar day, or a full ISO date-time that carries `Z` or an offset such as
`+03:00`; a date-time without one is refused), `point_id`, `provider_id` (uuids), `service_type`, `flag`,
`outcome` (`accepted` default | `rejected` | `all`), `include_voided`, `include_demo`,
`order` (`desc` default | `asc`), `limit` (1 to 500, default 100), `cursor`, `format` (`json` | `csv`).

How they really behave:

- `limit` above 500 is cut to 500, not refused. Zero, negative or not a whole number is `400 invalid_filter`.
- `include_voided` and `include_demo` mean yes only for `true` or `1`. Any other value means no.
- `service_type` and `flag` are cut to 60 characters before they are compared.
- `format=csv` returns CSV. Any other `format` value (or none) returns JSON.

Paging: the response has `next_cursor`; pass it back as `cursor`. For CSV the cursor is in the `X-Next-Cursor` header
(absent on the last page).

### CSV

The same columns as a scan row, in the same order, with a header line and no byte-order mark. `flags` are joined with
`;` (for example `offline_sync;clock_skew`). `voided` is the text `true` or `false`. A null is an empty cell.

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://<your-domain>/api/agent/v1/scans?from=2026-09-01&to=2026-09-30&limit=500"
```

## A scan row

```json
{
  "id": "uuid",
  "checked_in_at": "2026-09-30T06:04:10.821Z",
  "checked_in_local": "2026-09-30 09:04:10",
  "local_date": "2026-09-30",
  "point_id": "uuid", "point_name": "Lobby",
  "provider_id": "uuid", "provider_name": "Sparkle Cleaning",
  "service_type": "cleaning",
  "source": "online",
  "outcome": "accepted",
  "distance_m": 12, "gps_accuracy_m": 8,
  "flags": [],
  "voided": false, "void_reason": null
}
```

`distance_m` is null when no GPS fix was sent, and also when the point has no coordinates.

## Outcomes and sources

| `outcome` | Meaning |
|---|---|
| `accepted` | A real check-in. |
| `rejected_far` | A usable GPS fix placed the phone clearly away from the point. |
| `rejected_no_location` | The point requires GPS (`required`) and no usable fix was sent. |

| `source` | Meaning |
|---|---|
| `online` | The phone had a signal and the scan arrived at once. |
| `offline_sync` | The phone had no signal and uploaded the scan later. |

Refused attempts are kept for the record. `GET /scans` returns only `accepted` unless the `outcome` filter says otherwise.

## A point and a provider

A point (`/points`):

| Key | Meaning |
|---|---|
| `id` | uuid |
| `name` | Name of the point |
| `description` | Free text from the committee, or null |
| `service_type` | e.g. cleaning / gardening, or null |
| `gps_mode` | `required`, `optional` or `none` |
| `lat`, `lng` | Coordinates of the point, null when it has none |
| `radius_m` | Radius in meters around the point that counts as being there |
| `is_active` | false when the committee switched the point off |
| `created_at` | UTC ISO time the point was created |
| `assigned_provider_ids` | Provider uuids assigned to the point (empty: any provider may scan it) |

A provider (`/providers`):

| Key | Meaning |
|---|---|
| `id` | uuid |
| `company` | Company name |
| `contact_name` | Contact person, or null |
| `service_type` | e.g. cleaning / gardening, or null |
| `is_active` | false when the committee switched the provider off |
| `is_demo` | true for the demo account (its scans are test data) |
| `created_at` | UTC ISO time the provider was created |
| `last_scan_at` | UTC ISO time of the latest accepted, not voided scan, or null |

## How to read it

- `outcome: accepted` is a real check-in. Every other outcome (`rejected_*`) is a refused attempt, kept for the record (see "Outcomes and sources").
- **Flags are signals, not verdicts.** Report them, weigh them, but do not treat one as proof of anything:
  - `location_unverified`: no usable GPS fix. Normal in basements and stairwells.
  - `location_outside_radius`: a good fix slightly outside the point's radius (within the 15 m pin tolerance).
  - `location_stale`: the phone used a position it remembered (older than 60 seconds), typically from just outside the building.
  - `offline_sync`: scanned without signal, uploaded later (`checked_in_at` is the phone's time).
  - `clock_skew`: the phone's clock cannot be trusted. Online: it differed from the server by more than 5 minutes (or
    was not a believable time). Offline: the phone time was older than 7 days, more than 5 minutes in the future, missing
    or not believable; then `checked_in_at` is the server time of the upload, so the real day of the visit is not known.
  - `demo`: the demo account (hidden unless `include_demo=true`).
  - `legacy_import`: imported from the old Firebase system on 01/10/2026; its location and device details are not known.
    The flag is written by the one-time import of an old Firebase system's data (`npm run db:import-firestore`) and by
    nothing else: the first installation ran it, and a copy that never ran it never sees the flag.
- The same provider at the same point within 10 minutes is stored once.
- Scans are kept. A committee member normally voids a scan (hidden unless `include_voided=true`); they can also delete a single row on purpose (test data), and then it is gone from the API.
- Deleting a point does not delete its scans. An old scan can therefore carry a `point_id` that `/points` no longer lists: use `point_name` (the name at the time of the scan).
- A committee member can also delete a provider. Its scans stay and keep the recorded name, so an old scan can carry a `provider_id` that `/providers` no longer lists: use `provider_name` (the name at the time of the scan).
- Points can be `required`, `optional` or `none` for GPS (`gps_mode` in `/points`). A fix is usable when the phone reports an accuracy of 150 m or better. A usable fix is judged the same way on
  `required` and `optional` points (inside the radius + 15 m, crediting the phone's own accuracy up to 50 m). They differ only
  when there is no usable fix: `required` refuses the scan, `optional` accepts it with `location_unverified`. `none` points are never judged.
- Patterns worth looking for are yours to define, for example: missing visits on expected days, the same phone used by
  two providers, two distant points minutes apart, or a run of `location_unverified` at a point that usually has GPS.

## Errors

JSON `{ "error": { "code": "…", "message": "…" } }`, sometimes with extra keys such as `field`.

The key is checked first. A request to an endpoint that exists but has no valid key gets a `401`, whatever else is wrong with it (a bad filter, a bad cursor, a body that is not valid JSON): the `400` errors below are answered only to a valid key. `404` and `405` are answered without a key, because no endpoint is reached.

| Status and code | Meaning |
|---|---|
| `401 api_key_required` | No key, or the header is not a `Bearer qrk_…` key |
| `401 api_key_invalid` | The key is unknown or revoked |
| `400 invalid_filter` | A bad `from`, `to`, `point_id`, `provider_id`, `outcome`, `order` or `limit` (`field` names it) |
| `400 invalid_cursor` | The `cursor` is not one that this API returned |
| `400 invalid_input` | The database refused a value as out of range or malformed |
| `400 invalid_json` | The request carries a body that is not valid JSON (these endpoints read no body: send none). Only a valid key gets this answer; without one it is the `401` |
| `404 not_found` | No such endpoint |
| `405 method_not_allowed` | The endpoint exists but not for this HTTP method (everything here is `GET`) |
| `500 server_error` | An unexpected failure on the server. Try again later |
