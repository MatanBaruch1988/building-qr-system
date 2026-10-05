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
| Audit log (`audit_log`) | Which committee member did what and when, with the member's name as it was at the time of the action (their e-mail when they have no name), so that the entry stays readable after the member is removed. The details of some entries hold a name or an e-mail (for example a provider that was created or a member that was removed), the building's address, the reason that a member typed when voiding a scan, and an update holds the value that it replaced next to the new one (for example the contact name of a provider before and after), never a password or its hash. The daily job writes one entry a day with counts only. The table is append-only: the database refuses to change or delete a row, and to empty the table. Committee members can read it (see "Who can see it") | Until a legal decision on how long it may be kept is made. Nothing deletes it by itself |
| Login attempts (`auth_attempts`) | When someone tried to sign in, with the network (IP) address of the request. A committee attempt holds the IP address only (no e-mail, because the e-mail is not known before Google has been asked). A provider attempt holds the provider's id and the IP address (no name and no password). They are only used to slow down guessing | Deleted after 1 day |
| Recorded errors (`app_errors`) | Nothing about a person, by construction. When the server fails with an error that it did not expect, one row per kind of failure per hour: the route as it is written in the code (for example `/admin/points/:id`, never the address that was asked for), the method, the status, the error's code or name (never its message), the version of the app, how many times it happened, the first and the last time, and the request id that the host (Vercel) gave to the latest request, so that the failure can be found in the host's own log within the hour. No message, no name, no e-mail, no IP address, no QR code, no position, nothing from the body of a request | Deleted 90 days after the last time it happened |
| Alert days (`alert_pings`) | Nothing about a person, by construction. One date (a day in the building's time zone) for each day on which the server had an unexpected error and told the owner, and the moment the row was made. It is what lets the server send one alert for a day and not one for every error. Nothing about the error is in it | Deleted 30 days after the day |
| Agent keys (`api_keys`) | The name the committee gave the key, a fingerprint of the key, when it was last used. No personal data unless the committee puts a name in the key's name | Until the committee deletes the key |

The daily job never deletes or changes a scan, a refused visit, the audit log, an active session or an active phone. A
session, a phone, a recorded error or an alert day that is not yet past its period is left as it is. The job's own log line and its audit
entry hold counts only (a number for each kind of row, nothing else).

## Who can see it

- **The committee**, in the committee app (`/admin`), after signing in with Google and only if the e-mail is on the committee
  list: the providers, the scans and their history (also as a CSV file), the points and the agent keys. The visits that the
  server refused are listed in the History tab when its type is set to ("לא נקלטו"), read only and not part of the CSV
  file, and through the committee's own API (`GET /api/admin/scan-refusals`). The active phones of a provider, and what
  each reported about itself, can be read through the committee's own API too (`GET /api/admin/providers/:id/devices`: the
  version of the app, what waits on the phone and since when, the totals, the times of the last report and of the last
  upload); the committee app has no screen for them yet.
  A member can also read the audit log, every entry with its details (who did what and when, and the names, e-mail
  addresses and reasons that the details hold, and the current name of the point, provider, member or agent key that an
  entry is about, taken from the committee's own lists), through the committee's own endpoint (`GET /api/admin/audit`,
  the same sign-in), and a read-only screen in the committee app will show the same entries. The committee app does not
  show the label of a phone, the sessions, the login attempts, the recorded errors or the alert days.
- **The committee's own AI agent**, through the read-only agent API (`docs/agent-api.md`), with a key that the committee
  made: the points, the providers (company, contact name, kind of service, whether active, the time of the last scan) and the
  scans (provider name, point, times, distance, accuracy, flags). It cannot write anything, and it does not see the phones or
  what they reported, the labels of the phones, the sessions, the login attempts, the recorded errors, the audit log, the refused visits, the password hashes or any
  token.
- **Whoever runs the services under the app**: the owner of the project and the services that host it (the database is a
  Neon project, the app runs on Vercel). The committee's sign-in goes through Google, which handles it under its own terms.
  The owner's check on healthchecks.io gets one short line when the server has its first unexpected error of a day: the
  route as it is written in the code, the method, the error's code and the time. It holds no personal data.

## Backups

The owner keeps a daily backup of the database on his own computer, for 30 days, and never in the repository or in any
online place (`docs/runbooks/restore.md`). A backup holds everything that was in the database on that day, so a row that the
daily job deleted can still be in a backup, until the backup itself is removed after 30 days.

## Changing this

A retention period changes only by the owner's decision: change the constant in `server/config.js`, the table above and the
test that names it (`tests/retention.test.js`) in the same pull request.
