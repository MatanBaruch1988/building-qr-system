# 0007: Observability lives in our own Postgres

Status: Accepted, not implemented yet

Date: 05/10/2026

## Context

The owner wants to know when the app breaks, and why, without watching it. Today a failure leaves almost no trace. Seven
facts shape the answer:

- The app runs on Vercel Hobby. Runtime logs are kept for about one hour. Hobby has no log drains and no alerting, and a
  cron job runs at most once a day, at some point within its scheduled hour (`vercel.json` has one job, the retention job).
- An unhandled API error becomes one log line (`describeUnhandled` in `server/router.js`) that is gone after an hour. A 4xx
  answer is never logged.
- A crash on a provider's phone is written only to the phone's console (`src/ui/crash.js`). A queued offline check-in that
  the server refuses with a permanent code is dropped by the phone and leaves no trace on the server
  (`src/worker/scanQueue.js`, `POST /api/scans/sync`).
- The committee's audit rows are written after the change, in a separate transaction (`audit()` in
  `server/routes/admin.js`), so a change can be saved without its row. Nothing reads the audit log: no screen, no endpoint.
- The owner already has two outside monitors. healthchecks.io gets the heartbeat of the daily backup
  (`scripts/backup-db.mjs`), and UptimeRobot checks `/api/health`, which deliberately does not touch the database.
- The owner's laptop is not on all the time, so nothing in production monitoring may depend on it.
- A log never holds personal data or the message of an error (`AGENTS.md`, Safety, and `server/logSafe.js`). What is
  recorded about an error follows the same rule.

## Decision

Errors stay in our own Postgres, alerts go through healthchecks.io, and no new service receives data from the app.

1. **Server errors are recorded in a table, aggregated per hour** (`app_errors`), with safe fields only: the route as it
   is written in the code (`/admin/providers/:id`) or a fixed screen key, the method, the status, the error code or name,
   the app build, counts, times and the Vercel request id. Never a message, a requested path or query, a body, a token, a
   name, a QR code or a position. A request that its guard refused writes nothing.
2. **Alerts go through healthchecks.io**, on a second check next to the backup's:
   - The first server error of a building day (`BUILDING_TZ` in `shared/datetime.js`) pings the `/fail` address at once. A
     small alert-throttle table remembers that the day was announced.
   - A second daily Vercel cron job sends a short summary of the last 24 hours (counts, route patterns and codes only), as
     a success ping, or as `/fail` when those hours held a technical problem (a server error, a crash on a phone, a
     retention run that did not happen, a phone whose uploads are stuck). A refusal that the rules intend, such as a
     provider who is not assigned to the point, is counted in the summary but does not fail it.
   - If the database itself is down, nothing can be counted, so an in-memory throttle still pings at most once an hour.
3. **Reports from the phone and the committee app** go only through guarded endpoints of their own role: `/api/my/...` for
   a provider and `/api/admin/...` for the committee, so the guard of the router runs first (`server/access.js`). The body
   is cut to a whitelist of fields in `shared/contract.js`. There is no public write endpoint, so nobody who is not signed
   in can write to the table. A crash before sign-in waits on the device until the next sign-in.
4. **Three new things in the committee app**, so that a person reads what is recorded:
   - The audit log: the row is written in the transaction of the change, rows are append-only, the screen is read-only.
   - Phone health: what is waiting on each phone and since when, the last sync and the app version. It travels through a
     separate endpoint, so the offline sync contract does not change.
   - Visits not counted: an upload that the server refuses is recorded on the server, in a separate append-only table. It
     is not a new scan outcome, so `SCAN_OUTCOMES` and the outcomes of the agent API do not change.
5. **Retention:** `app_errors` is kept 90 days after its last event, the alert-throttle table 30 days. Both are added to
   the existing daily retention job (`server/retention.js`), with their periods in `server/config.js`.

## Consequences

Good:

- No new vendor, account or secret, and no data from a phone leaves our database. The retention rules and the privacy
  page already cover the place where it lives.
- A problem at night is recorded and reaches the owner without the owner's laptop: the alert comes from the server and from Vercel
  Cron. A day with no summary ping is a signal too, as it is for the backup.
- A lost upload and a crash on a phone become visible, and the audit log is finally read by somebody.

Bad:

- If the database is down, nothing is recorded. The in-memory ping and the missing daily ping are the alert. That throttle
  lives in one function instance, so a long outage can ping more than once an hour.
- A 500 answer waits for one bounded insert (about 1.5 s at worst). The database itself cancels that insert after the same
  time, so an abandoned insert cannot hold a connection longer. The insert is skipped while the connection pool is busy
  (it never queues and never takes the last free connection), so during a burst of failures some errors are not recorded.
- No stack traces or messages are kept, so a deep diagnosis still needs Vercel's logs within the hour, or a reproduction.
- Each new table is one more thing in `docs/privacy.md` and in the retention job. The audit screen also shows entries that
  hold a name or an e-mail, and `docs/privacy.md` says today that the committee app does not show the audit log, so that
  page changes with the screen.
- healthchecks.io alerts on a change of state, so a problem that repeats daily alerts once and then stays visible in the
  event list of the check.

## Alternatives considered

- **Sentry or another error service.** Rejected: a new vendor that receives data from phones, one more account and secret,
  and scrubbing personal data becomes our risk.
- **Vercel log drains and Vercel Observability Plus.** Rejected: they need a paid plan.
- **A collector on the owner's laptop.** Rejected: the laptop is not on all the time.
- **Only Vercel's one-hour logs.** Rejected: a problem at night is gone before anybody looks.
