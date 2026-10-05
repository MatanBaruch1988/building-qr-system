# What personal data the app keeps

A short, plain description of the personal data in the database: what it is, how long it is kept, and who can see it. It is
the basis for a notice to the service providers (the cleaning company, the gardener), which is still to be written. The
rules for the code are in `AGENTS.md` (Safety); the periods below are constants in `server/config.js`, and a daily job
applies them (`server/retention.js`).

Retention periods were decided by the owner on 04/10/2026, and the periods of the recorded errors and of the alert days on
05/10/2026. Three things have no period yet: the scans, the refused visits and the audit log wait for a legal decision, and
until then they are kept (see the table).

## What is kept, and for how long

| Where | What it holds about a person | How long it is kept |
|---|---|---|
| Committee members (`admins`) | E-mail address, name, the Google account id, the time of the last sign-in. The members are named by the committee, and they sign in with Google | Until the committee removes the member |
| Committee sessions (`admin_sessions`) | A fingerprint (hash) of the sign-in cookie, and when the session started, expires and was ended. No address, no device details | Deleted 30 days after the session expired or was ended |
| Service providers (`providers`) | Company, contact name, kind of service, language, and a salted hash of the password (never the password) | Until the committee deletes the provider |
| Phones of a provider (`provider_devices`) | A fingerprint (hash) of the phone's sign-in token, when it was created, last used and revoked, and a label: the browser string that the phone sent at sign-in (for example the browser and system name, at most 80 characters). It also holds what the phone reports about itself: the version of the app, how many visits wait on the phone to be uploaded and since when, how many visits were not accepted and how many were dropped from a full queue (two running totals), the time of the last report, and the time of the last upload (which the server writes itself). It holds no position, no names and no QR codes | The label and everything that the phone reported are cleared 90 days after the phone was revoked. An active phone keeps them. The row stays, with the label and the reported data empty. A deleted provider takes its phones with it |
| Scans (`scans`) | The provider's name as it was at the time, the point, the time (the server's and the phone's clock), the distance in metres between the phone and the point and the accuracy of the reading, flags, which phone sent it. **The position itself (latitude and longitude) is never stored** | Until the committee deletes it. A legal decision on how long scans may be kept is pending. Nothing deletes a scan by itself |
| Refused visits (`scan_refusals`) | A visit that the server refused with a final answer (the point is switched off or was never assigned to the provider, the QR code is not one of ours or names no point, the data of the visit could not be stored), so that the committee can learn that a visit was not counted. The provider's name as it was at the time, the point (when the code named one), the time (the server's and the phone's clock), the reason (a code), which phone sent it. **The position itself and the QR code that was scanned are never stored.** It is not a scan and never counts as attendance. The table is append-only: the database refuses to change or delete a row, and to empty the table | Until a legal decision on how long it may be kept is made, like scans. Nothing deletes it by itself |
| Audit log (`audit_log`) | Which committee member did what and when, with the member's name as it was at the time of the action (their e-mail when they have no name), so that the entry stays readable after the member is removed. The details of some entries hold a name or an e-mail (for example a provider that was created or a member that was removed), the building's address, the reason that a member typed when voiding a scan, and an update holds the value that it replaced next to the new one (for example the contact name of a provider before and after), never a password or its hash. It also holds when a committee member signed in (and whether through Google) and when they signed out: the member and the time only, no network address, no device or browser details, no Google account id and no cookie. A sign-in that was refused writes no entry, and a service provider's sign-in is not in this log (the phones of a provider are in `provider_devices`). A member that the owner added with the command `npm run db:create-admin` is in the log too, as added by the command (no member is named as the actor). The daily job writes one entry a day with counts only. The table is append-only: the database refuses to change or delete a row, and to empty the table. Committee members can read it (see "Who can see it") | Until a legal decision on how long it may be kept is made. Nothing deletes it by itself |
| Login attempts (`auth_attempts`) | When someone tried to sign in, with the network (IP) address of the request. A committee attempt holds the IP address only (no e-mail, because the e-mail is not known before Google has been asked). A provider attempt holds the provider's id and the IP address (no name and no password). They are only used to slow down guessing | Deleted after 1 day |
| Recorded errors (`app_errors`) | Nothing about a person, by construction. When the server fails with an error that it did not expect, or when the provider app or the committee app reports a crash (see "What the two apps report"), one row per kind of failure per hour: the route as it is written in the code (for example `/admin/points/:id`, never the address that was asked for) or, for an app, the screen key (for example `provider:home`), the method, the status, the error's code or name (never its message), the version of the app, how many times it happened, the first and the last time, and the request id that the host (Vercel) gave to the latest request, so that the failure can be found in the host's own log within the hour (an error that an app reports has none). The same table also counts, by route, the requests that the server refused after the caller had been let in (a 4xx, with the code of the refusal, for example a sync that was too big) and the requests that took more than 5 seconds: the same fields, a count, and nothing about the person who made the request. A request that was refused at the door (not signed in), a sign-in attempt and a path that does not exist record nothing. No message, no name, no e-mail, no IP address, no QR code, no position, nothing from the body of a request | Deleted 90 days after the last time it happened |
| Alert days (`alert_pings`) | Nothing about a person, by construction. One date (a day in the building's time zone) for each day on which the server had an unexpected error, or an app reported a crash, and told the owner, and the moment the row was made. It is what lets the server send one alert for a day and not one for every error. Nothing about the error is in it | Deleted 30 days after the day |
| Agent keys (`api_keys`) | The name the committee gave the key, a fingerprint of the key, when it was last used. No personal data unless the committee puts a name in the key's name | Until the committee deletes the key |

The daily job never deletes or changes a scan, a refused visit, the audit log, an active session or an active phone. A
session, a phone, a recorded error or an alert day that is not yet past its period is left as it is. The job's own log line and its audit
entry hold counts only (a number for each kind of row, nothing else).

## What the two apps report

The provider app (on a service provider's phone) and the committee app tell the server when a screen crashes, when something
goes wrong that nothing caught, and when the server ended the session. The server keeps these reports so that the owner can
learn that an app is broken without anybody having to tell him. A report is sent only after sign-in, through the endpoint of the
signed-in role (`POST /api/my/errors` for a provider's phone, `POST /api/admin/client-errors` for the committee app): there is
no endpoint that can be written to without signing in, and a crash before sign-in waits on the device until the next sign-in.
The server cuts every report to a fixed list of fields (`shared/contract.js`) and ignores everything else.

- **What they report:** the screen key (one of a fixed list, such as `provider:home` or `committee:points`, never an address),
  the kind (a crash, an error that nothing caught, or a session that the server ended), the error's name (its class, such as
  `TypeError`) or a short code, the build of the app (the first 7 characters of the commit), and how many times it happened.
- **What they never report:** a message, a URL or address, a stack, a body, a token, a name, a QR code or a position. The server
  reads none of these fields even if an app sends one, and it keeps a name, a code and a build only when it has the shape of one.
  It stores nothing about who sent the report: not the provider, not the phone, not the committee member.
- **Where it is kept:** in `app_errors` (the table above, with the server's own errors), one row for each kind of report per
  hour with a count, deleted 90 days after the last time it happened.
- **Who is told:** the first crash or uncaught error of a day (of the apps or of the server, whichever comes first) sends one
  short line to the owner's check on healthchecks.io: the screen key, the error's name or code, the build and the time. A
  session that the server ended is only counted.

## Who can see it

- **The committee**, in the committee app (`/admin`), after signing in with Google and only if the e-mail is on the committee
  list: the providers, the scans and their history (also as a CSV file), the points and the agent keys. The visits that the
  server refused are listed in the History tab when its type is set to ("לא נקלטו"), read only and not part of the CSV
  file, and through the committee's own API (`GET /api/admin/scan-refusals`). The active phones of a provider, and what
  each reported about itself, can be read through the committee's own API too (`GET /api/admin/providers/:id/devices`: the
  version of the app, what waits on the phone and since when, the totals, the times of the last report and of the last
  upload). The Providers tab of the committee app shows the same, read only: a line on the card of a provider whose phones
  have visits waiting, and a dialog that lists each phone (the card's button ("מכשירים")).
  A member can also read the audit log, every entry with its details (who did what and when, and the names, e-mail
  addresses and reasons that the details hold, and the current name of the point, provider, member or agent key that an
  entry is about, taken from the committee's own lists), through the committee's own endpoint (`GET /api/admin/audit`,
  the same sign-in), and on a read-only screen in the committee app, a section at the foot of the Committee tab
  ("יומן פעולות"). It shows the same entries by the fields it knows and leaves out any value that looks like a key, a hash or
  a token. The committee app does not show the label of a phone, the sessions, the login attempts, the recorded errors or the alert days.
- **The committee's own AI agent**, through the read-only agent API (`docs/agent-api.md`), with a key that the committee
  made: the points, the providers (company, contact name, kind of service, whether active, the time of the last scan) and the
  scans (provider name, point, times, distance, accuracy, flags). It cannot write anything, and it does not see the phones or
  what they reported, the labels of the phones, the sessions, the login attempts, the recorded errors, the audit log, the refused visits, the password hashes or any
  token.
- **Whoever runs the services under the app**: the owner of the project and the services that host it (the database is a
  Neon project, the app runs on Vercel). The committee's sign-in goes through Google, which handles it under its own terms.
  The owner's check on healthchecks.io gets one short line when the server has its first unexpected error of a day: the
  route as it is written in the code, the method, the error's code and the time. When an app reports the first crash of a day
  instead, the line has the screen key, the error's name or code, the build and the time. It holds no personal data. It also
  gets one short summary of the last 24 hours each day (`server/summary.js`): counts, route patterns as they are written in
  the code, error codes, screen keys, build versions and times, and nothing about a person (no name, e-mail address, QR code,
  phone label or id).

## Backups

The owner keeps a daily backup of the database on his own computer, for 30 days, and never in the repository or in any
online place (`docs/runbooks/restore.md`). A backup holds everything that was in the database on that day, so a row that the
daily job deleted can still be in a backup, until the backup itself is removed after 30 days.

## Changing this

A retention period changes only by the owner's decision: change the constant in `server/config.js`, the table above and the
test that names it (`tests/retention.test.js`) in the same pull request.
