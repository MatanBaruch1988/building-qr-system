# Attendance data for an AI agent (read-only API)

Building attendance log: one row per QR scan by a service provider (cleaning company, gardener).
The app records facts and signals only. It never analyses, scores or judges: that is your job.

- **Base URL:** `https://<your-domain>/api/agent/v1` (the committee sees the exact address in the admin screen, in the Agent tab ("אייג׳נט"))
- **Auth:** `Authorization: Bearer qrk_…`, a key the committee creates and can revoke at any time. Read-only.
- **Limits:** one key may make at most 60 requests in a minute and at most 2000 in a building day. Over a limit the answer is a
  `429 rate_limited` with a `Retry-After` header (see "Errors"). Ask for fewer, larger pages (`limit=500` and the cursor)
  rather than many small requests.
- **Self-description:** `GET /schema` returns this contract as JSON. Read it first. `GET /openapi.json` returns the same API as an
  OpenAPI 3.1 document, for tools that read OpenAPI (see "OpenAPI" below).
- **Ready-made system prompt for the committee's agent:** [`agent-prompt.md`](agent-prompt.md).
- **Time:** all human-readable times are Israel time. `checked_in_at` is UTC ISO, `checked_in_local` is
  `YYYY-MM-DD HH:mm:ss` in Asia/Jerusalem, `local_date` is the Israeli calendar day (use it for "per day").

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /scans` | Scan records, newest first. Filters below. |
| `GET /refusals` | The visits that the server refused and did not count, newest first. They are not scans. Filters below. |
| `GET /points` | Every service point, including inactive ones, with assigned providers. |
| `GET /providers` | Every provider, including inactive and demo ones, with `last_scan_at` and the health of the provider's phones as numbers. |
| `GET /building` | The name and the address of the building. |
| `GET /schema` | Field, flag and rule descriptions. |
| `GET /openapi.json` | The OpenAPI 3.1 description of this API: endpoints, parameters, answers, errors and the Bearer key. |
| `GET /health` | Liveness and server time. |

### Response envelopes

| Endpoint | Top level of the JSON answer |
|---|---|
| `GET /scans` | `{ scans, count, next_cursor }`. `count` is the number of scans in this page, not the total. `next_cursor` is `null` on the last page. |
| `GET /refusals` | `{ refusals, count, next_cursor }`. `count` is the number of refusals in this page, not the total. `next_cursor` is `null` on the last page. |
| `GET /points` | `{ points }` |
| `GET /providers` | `{ providers }` |
| `GET /building` | `{ building }`, an object with the `name` and the `address` |
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

The same columns as a scan row, in the same order, with a header line and no byte-order mark: the last four, `voided_at`,
`voided_by`, `received_at` and `device_id`, come after `void_reason`. `flags` are joined with `;` (for example
`offline_sync;clock_skew`). `voided` is the text `true` or `false`. A null is an empty cell.

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://<your-domain>/api/agent/v1/scans?from=2026-09-01&to=2026-09-30&limit=500"
```

### `GET /refusals` filters

`from`, `to` (`YYYY-MM-DD` = Israel calendar day, or a full ISO date-time that carries `Z` or an offset such as `+03:00`; they bound
the time at which the server refused the visit), `point_id`, `provider_id` (uuids), `limit` (default 100, at most 200), `cursor`.

How they really behave:

- They are the filters of the committee's own list of these visits, with the same checks and the same errors as `GET /scans`
  (`400 invalid_filter` with `field`, `400 invalid_cursor`). A date-time without `Z` or an offset is refused.
- A `limit` over 200 is cut to 200, not refused. Zero, negative or not a whole number is `400 invalid_filter`.
- `point_id` matches the refusals that name that point. A refusal whose code named no point (see "A refused visit") is matched by no
  `point_id`, so look for those without the filter.
- There is no `outcome`, `order` or `format`: the answer is always JSON, newest first.

Paging: the response has `next_cursor`; pass it back as `cursor`, with the other filters unchanged. A cursor of `GET /scans` is not
one of this list.

### OpenAPI

`GET /openapi.json` answers one OpenAPI 3.1 document (JSON). It lists every endpoint of this page with its parameters (types, formats,
allowed values and limits), the shape of every answer (the JSON of a scan, a refused visit, a point, a provider and the building, the CSV variant of `GET /scans`
and its `X-Next-Cursor` header), the errors of the table under "Errors", and the Bearer key. It needs the key like every other endpoint.
Give it to a tool that imports OpenAPI (an agent platform, a client generator). It is built from the same list of endpoints as
`GET /schema`, so the two name the same endpoints; the prose (what a field, a flag or a rule means) stays in `GET /schema`, which
the document points to. A field that a newer version adds to an answer is in the document of that version, and a client that
validates answers should not refuse a field it does not know.

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
  "voided": false, "void_reason": null,
  "voided_at": null, "voided_by": null,
  "received_at": "2026-09-30T06:04:11.402Z",
  "device_id": "uuid"
}
```

`distance_m` is null when no GPS fix was sent, and also when the point has no coordinates.

The last four fields are the details of a scan that the committee sees in its history:

| Key | Meaning |
|---|---|
| `voided_at` | UTC ISO time the scan was voided, or null when it is not voided |
| `voided_by` | The name of the committee member who voided it (their e-mail when they have no name), as it was when they did it. Null when the scan is not voided, or when no record names who |
| `received_at` | UTC ISO time the server received the scan. Unlike `checked_in_at`, which is the best estimate of the visit, it is the server's clock and is never an estimate: for an `offline_sync` scan it is the time of the upload |
| `device_id` | A random uuid for the sign-in of the phone that sent the scan, or null when it is not known (the old import has none). Nothing else about the phone is shown |

`device_id` stands for a phone's sign-in, and a sign-in belongs to one provider. A phone that signs in again, or as another provider, gets a new
id. So it tells apart the phones that one provider's scans came from (several ids: several phones, or the same phone signed in
again), and it cannot show the same physical phone across providers, because two providers never share an id.

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

Refused attempts are kept for the record. `GET /scans` returns only `accepted` unless the `outcome` filter says otherwise. A visit that
the server turned away before it became a scan at all is not an outcome of a scan: it is a refusal (see "A refused visit").

## A refused visit

`GET /refusals` lists the visits that the server refused for good, so that a visit that was not counted can be seen: a point that the
committee had switched off, a person who is not assigned to the point, a code that names nothing. **A refusal is not a scan.** It never
counts as attendance, it is never in `GET /scans`, and it is not a scan with an `outcome` of `rejected_far` or `rejected_no_location`
(those are scans, and `GET /scans?outcome=rejected` returns them). It is a visit that did not become a scan at all, so count the two
lists apart and never add a refusal to the attendance. Visits that were refused before the server began to keep this record are not
there.

```json
{
  "id": 41,
  "at": "2026-09-30T06:12:44.318Z",
  "scan_id": "uuid",
  "source": "offline_sync",
  "code": "point_inactive",
  "provider_id": "uuid", "provider_name": "Sparkle Cleaning – Dana",
  "point_id": "uuid", "point_name": "Roof",
  "client_time": "2026-09-30T05:58:02.000Z"
}
```

A refused visit (`/refusals`):

| Key | Meaning |
|---|---|
| `id` | A whole number that identifies the refusal. It is not the id of any scan |
| `at` | UTC ISO time at which the server refused the visit (the server's clock). The list is in this order, newest first |
| `scan_id` | The phone's own id of the check-in, or null when the phone sent none that was valid. Usually not the id of a row of `/scans`, because the visit was not counted; for `scan_id_conflict` it is the id of a scan of another provider. The same visit sent again is one refusal |
| `source` | `online` (the phone had a signal and the visit arrived at once) or `offline_sync` (the phone uploaded it later from its queue). The same two words as the source of a scan |
| `code` | Why the server refused the visit: one of the codes below |
| `provider_id` | uuid of the service provider who scanned. A provider can be deleted by the committee: its refusals stay, so this can be an id that `/providers` no longer lists |
| `provider_name` | Company – contact name at the time of the visit (kept even if the provider is renamed or deleted) |
| `point_id` | uuid of the service point that the scanned code named, or null when the visit was refused before its code could be matched to a point. A deleted point keeps its refusals, so this can be an id that `/points` no longer lists |
| `point_name` | Name of the point at the time of the visit, or null when `point_id` is null |
| `client_time` | UTC ISO time on the phone's own clock when the person scanned, or null when the phone sent no believable time (a real date between the years 2000 and 2100). The time at which the server refused the visit is `at` |

The `code` of a refusal:

| `code` | Meaning |
|---|---|
| `point_inactive` | The committee had switched the point off when the visit reached the server. The point is named |
| `not_assigned` | The point is assigned to other providers and not to this one (a point with no assignment may be scanned by anyone, and the demo account may scan every point). The point is named |
| `unknown_code` | The scanned text has the shape of a QR code of this system, but no point has it (a point that was deleted, or a code that was never issued). No point is named |
| `invalid_code` | The scanned text is not a QR code of this system at all. No point is named |
| `invalid_scan_id` | The phone's id of the check-in was not a valid id. `scan_id` is then null, and no point is named |
| `scan_id_conflict` | The phone's id of the check-in was already the id of a scan of another provider. `scan_id` is that id; no point is named |
| `invalid_item` | The database refused the data of the visit as out of range or malformed, when a phone uploaded it from its queue (`source` is `offline_sync`). Nothing the committee can mend. A point is named when the code had named one |

What a refusal holds is only the provider's name as it was, the point when the code named one, the two clocks, the code and the id of
the check-in. It never shows the QR code that was scanned or a position (the server does not keep either), and never which phone sent
it.

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
| `active_devices` | How many phones of the provider are signed in now, a number (0 when none) |
| `waiting` | The sum, over the signed-in phones, of the visits that each phone says it holds and has not uploaded yet (0 when none reported). They are not in `/scans` until the phone uploads them |
| `oldest_waiting_at` | UTC ISO time of the oldest visit that waits on any of the signed-in phones (the phone's own clock), or null when nothing waits or no believable time was reported |
| `outdated_devices` | How many of the signed-in phones run a version of the app that is not the server's own (0 when none, or when the server does not know its own version) |
| `last_sync_at` | UTC ISO time of the latest upload of any signed-in phone, or null when none of them uploaded |
| `not_accepted_total` | The sum, over the signed-in phones, of the visits that the server refused for good and the phone dropped from its queue, counted since each phone signed in |
| `overflow_total` | The sum, over the signed-in phones, of the visits that left a full queue on the phone and were dropped (the oldest go first), counted since each phone signed in |

The last seven fields of a provider are the health of its phones, as numbers over all of the provider's signed-in phones: there is
never a row per phone, and never a phone's label or browser string. A provider with no phone signed in has 0 in the numbers and null in
the times. A phone that never reported counts for nothing (an old version of the app does not report), so a count of 0 does not prove
that nothing waits on such a phone.

## The building

`GET /building` answers `{ "building": { "name": "...", "address": "..." } }`: the two texts that the committee types in the
committee app. Nothing else about the building is there (not who saved it or when).

| Key | Meaning |
|---|---|
| `name` | The name of the building, as the committee typed it, or an empty string when none was set |
| `address` | The address of the building, as the committee typed it, or an empty string when none was set |

## How to read it

- `outcome: accepted` is a real check-in. Every other outcome (`rejected_*`) is a refused attempt, kept for the record (see "Outcomes and sources").
- A visit can also be missing from `/scans` because the server refused it before it became a scan. Those are in `/refusals`, never
  counted as attendance (see "A refused visit"). A visit that waits on a phone is in neither list yet.
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
- Patterns worth looking for are yours to define, for example: missing visits on expected days, two distant points
  minutes apart (`device_id` says whether the two scans came from the same phone sign-in or from two), visits that wait on
  a phone (`waiting`, `oldest_waiting_at`) and are not in the scans yet, or a run of `location_unverified` at a point that
  usually has GPS. `device_id` cannot show that one phone was used by two providers: every sign-in has its own id and belongs to one provider.

## Errors

JSON `{ "error": { "code": "…", "message": "…" } }`, sometimes with extra keys such as `field`.

The key is checked first. A request to an endpoint that exists but has no valid key gets a `401`, whatever else is wrong with it (a bad filter, a bad cursor, a body that is not valid JSON): the `400` errors below are answered only to a valid key. `404` and `405` are answered without a key, because no endpoint is reached.

Right after the key, and before anything else about the request, the limit of the key is checked. A key that has made 60 requests in the current minute, or 2000 in the building's day (midnight to midnight, Israel time), gets a `429` until its minute or its day is over. The `429` has a `Retry-After` header (whole seconds) and, in the error, `window` (`minute` or `day`, the limit that was reached) and `retry_after_s` (the same number): wait that long, then ask again. A refused request does not count towards the limits.

| Status and code | Meaning |
|---|---|
| `401 api_key_required` | No key, or the header is not a `Bearer qrk_…` key |
| `401 api_key_invalid` | The key is unknown or revoked |
| `429 rate_limited` | The key has used up a limit: 60 requests in the current minute, or 2000 in the building's day. `window` says which one, and `retry_after_s` (and the `Retry-After` header) how long to wait. Only a valid key gets this answer |
| `400 invalid_filter` | A bad `from`, `to`, `point_id`, `provider_id`, `outcome`, `order` or `limit` (`field` names it) |
| `400 invalid_cursor` | The `cursor` is not one that this API returned |
| `400 invalid_input` | The database refused a value as out of range or malformed |
| `400 invalid_json` | The request carries a body that is not valid JSON (these endpoints read no body: send none). Only a valid key gets this answer; without one it is the `401` |
| `404 not_found` | No such endpoint |
| `405 method_not_allowed` | The endpoint exists but not for this HTTP method (everything here is `GET`) |
| `500 server_error` | An unexpected failure on the server. Try again later |
