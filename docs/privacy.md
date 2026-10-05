# What personal data the app keeps

A short, plain description of the personal data in the database: what it is, how long it is kept, and who can see it. It is
the basis for a notice to the service providers (the cleaning company, the gardener), which is still to be written. The
rules for the code are in `AGENTS.md` (Safety); the periods below are constants in `server/config.js`, and a daily job
applies them (`server/retention.js`).

Retention periods were decided by the owner on 04/10/2026, and the period of the recorded errors on 05/10/2026. Two things
have no period yet: the scans and the audit log wait for a legal decision, and until then they are kept (see the table).

## What is kept, and for how long

| Where | What it holds about a person | How long it is kept |
|---|---|---|
| Committee members (`admins`) | E-mail address, name, the Google account id, the time of the last sign-in. The members are named by the committee, and they sign in with Google | Until the committee removes the member |
| Committee sessions (`admin_sessions`) | A fingerprint (hash) of the sign-in cookie, and when the session started, expires and was ended. No address, no device details | Deleted 30 days after the session expired or was ended |
| Service providers (`providers`) | Company, contact name, kind of service, language, and a salted hash of the password (never the password) | Until the committee deletes the provider |
| Phones of a provider (`provider_devices`) | A fingerprint (hash) of the phone's sign-in token, when it was created, last used and revoked, and a label: the browser string that the phone sent at sign-in (for example the browser and system name, at most 80 characters) | The label is cleared 90 days after the phone was revoked. An active phone keeps its label. The row stays, with the label empty. A deleted provider takes its phones with it |
| Scans (`scans`) | The provider's name as it was at the time, the point, the time (the server's and the phone's clock), the distance in metres between the phone and the point and the accuracy of the reading, flags, which phone sent it. **The position itself (latitude and longitude) is never stored** | Until the committee deletes it. A legal decision on how long scans may be kept is pending. Nothing deletes a scan by itself |
| Audit log (`audit_log`) | Which committee member did what and when, with the member's name as it was at the time of the action (their e-mail when they have no name), so that the entry stays readable after the member is removed. The details of some entries hold a name or an e-mail (for example a provider that was created or a member that was removed). The daily job writes one entry a day with counts only. The table is append-only: the database refuses to change or delete a row, and to empty the table | Until a legal decision on how long it may be kept is made. Nothing deletes it by itself |
| Login attempts (`auth_attempts`) | When someone tried to sign in, with the network (IP) address of the request. A committee attempt holds the IP address only (no e-mail, because the e-mail is not known before Google has been asked). A provider attempt holds the provider's id and the IP address (no name and no password). They are only used to slow down guessing | Deleted after 1 day |
| Recorded errors (`app_errors`) | Nothing about a person, by construction. When the server fails with an error that it did not expect, one row per kind of failure per hour: the route as it is written in the code (for example `/admin/points/:id`, never the address that was asked for), the method, the status, the error's code or name (never its message), the version of the app, how many times it happened, the first and the last time, and the request id that the host (Vercel) gave to the latest request, so that the failure can be found in the host's own log within the hour. No message, no name, no e-mail, no IP address, no QR code, no position, nothing from the body of a request | Deleted 90 days after the last time it happened |
| Agent keys (`api_keys`) | The name the committee gave the key, a fingerprint of the key, when it was last used. No personal data unless the committee puts a name in the key's name | Until the committee deletes the key |

The daily job never deletes or changes a scan, the audit log, an active session or an active phone. A session, a phone
or a recorded error that is not yet past its period is left as it is. The job's own log line and its audit entry hold counts
only (a number for each kind of row, nothing else).

## Who can see it

- **The committee**, in the committee app (`/admin`), after signing in with Google and only if the e-mail is on the committee
  list: the providers, the scans and their history (also as a CSV file), the points and the agent keys. The committee app
  does not show the label of a phone, the sessions, the login attempts, the recorded errors or the audit log.
- **The committee's own AI agent**, through the read-only agent API (`docs/agent-api.md`), with a key that the committee
  made: the points, the providers (company, contact name, kind of service, whether active, the time of the last scan) and the
  scans (provider name, point, times, distance, accuracy, flags). It cannot write anything, and it does not see the labels of
  the phones, the sessions, the login attempts, the recorded errors, the audit log, the password hashes or any token.
- **Whoever runs the services under the app**: the owner of the project and the services that host it (the database is a
  Neon project, the app runs on Vercel). The committee's sign-in goes through Google, which handles it under its own terms.

## Backups

The owner keeps a daily backup of the database on his own computer, for 30 days, and never in the repository or in any
online place (`docs/runbooks/restore.md`). A backup holds everything that was in the database on that day, so a row that the
daily job deleted can still be in a backup, until the backup itself is removed after 30 days.

## Changing this

A retention period changes only by the owner's decision: change the constant in `server/config.js`, the table above and the
test that names it (`tests/retention.test.js`) in the same pull request.
