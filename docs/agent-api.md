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

### `GET /scans` filters

`from`, `to` (`YYYY-MM-DD` = Israel calendar day, or a full ISO time with `Z`/offset), `point_id`, `provider_id`,
`service_type`, `flag`, `outcome` (`accepted` default | `rejected` | `all`), `include_voided`, `include_demo`,
`order` (`desc` default | `asc`), `limit` (1 to 500, default 100), `cursor`, `format` (`json` | `csv`).

Paging: the response has `next_cursor`; pass it back as `cursor`. For CSV the cursor is in the `X-Next-Cursor` header.

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

## How to read it

- `outcome: accepted` is a real check-in. `rejected_far` / `rejected_no_location` are refused attempts, kept for the record.
- **Flags are signals, not verdicts.** Report them, weigh them, but do not treat one as proof of anything:
  - `location_unverified`: no usable GPS fix. Normal in basements and stairwells.
  - `location_outside_radius`: a good fix slightly outside the point's radius (within the 15 m pin tolerance).
  - `location_stale`: the phone used a position it remembered (older than a minute), typically from just outside the building.
  - `offline_sync`: scanned without signal, uploaded later (`checked_in_at` is the phone's time).
  - `clock_skew`: the phone's clock was off by more than 5 minutes.
  - `demo`: the demo account (hidden unless `include_demo=true`).
  - `legacy_import`: imported from the old Firebase system on 01/10/2026; its location and device details are not known.
- The same provider at the same point within 10 minutes is stored once.
- Scans are kept. A committee member normally voids a scan (hidden unless `include_voided=true`); they can also delete a single row on purpose (test data), and then it is gone from the API.
- Deleting a point does not delete its scans. An old scan can therefore carry a `point_id` that `/points` no longer lists: use `point_name` (the name at the time of the scan).
- A committee member can also delete a provider. Its scans stay and keep the recorded name, so an old scan can carry a `provider_id` that `/providers` no longer lists: use `provider_name` (the name at the time of the scan).
- Points can be `required`, `optional` or `none` for GPS (`gps_mode` in `/points`). A usable fix is judged the same way on
  `required` and `optional` points (inside the radius + 15 m, crediting the phone's own accuracy up to 50 m). They differ only
  when there is no usable fix: `required` refuses the scan, `optional` accepts it with `location_unverified`. `none` points are never judged.
- Patterns worth looking for are yours to define, for example: missing visits on expected days, the same phone used by
  two providers, two distant points minutes apart, or a run of `location_unverified` at a point that usually has GPS.

## Errors

JSON `{ "error": { "code": "…", "message": "…" } }`. `401 api_key_required | api_key_invalid` (missing, malformed
or revoked key), `400 invalid_filter` (bad date, id, cursor, …).
