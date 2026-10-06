# Security policy

This is a small project run by volunteers, but the hosted instance holds real people's attendance data, so a security
report is taken seriously. Thank you for taking the time to send one.

## Supported versions

Only the latest commit of `master` is supported. The hosted instance (the first installation, run by the owner of this
repository) is deployed from `master`. If you host a copy yourself, keep it on `master`: fixes land there first and
nowhere else.

## How to report a vulnerability

Report it privately, through GitHub's private vulnerability reporting (it is enabled for this repository):

https://github.com/MatanBaruch1988/building-qr-system/security/advisories/new

That is the reporting route of this repository and of the first installation. A copy of the project has its own maintainer,
who replaces this address with the one of the copy's repository (`https://github.com/<owner>/<repo>/security/advisories/new`)
and says who answers there.

Never report a vulnerability in a public issue, a pull request or a discussion, and do not share the details anywhere
else before it is fixed. Please write in English.

Please include:

- **The affected part:** the provider app, the committee app, the API, the agent API, a migration or a workflow.
- **Steps to reproduce it:** short and concrete, so that somebody else can follow them.
- **The impact:** what an attacker could read, change or do, and who would be hurt.
- **A proof of concept that uses only your own data.** Do not use anybody else's account, key or records.

## What to expect

This is a volunteer project, so the times below are goals, not a contract.

- We acknowledge your report within 7 days.
- For a high or critical issue we send a fix or a written plan within 30 days.
- We use coordinated disclosure: the advisory is published after the fix is out, and at most 90 days after the report,
  unless you and the maintainer agree on another date.
- If you want credit in the advisory, say so in the report and tell us how to name you.

## What is in scope

- The provider app (scanning, `/`).
- The committee app (`/admin`) and its sign-in.
- The API in `server/` (entry `api/index.js`).
- The read-only agent API ([`docs/agent-api.md`](docs/agent-api.md)).
- The database migrations in `db/migrations/`.
- The CI workflows in `.github/workflows/`.

## What is out of scope

- The configuration of somebody else's self-hosted deployment (their keys, their database, their hosting settings).
- Attacks that need a stolen committee Google account or an unlocked phone.
- Volume or denial-of-service testing.
- Social engineering of the maintainer, the committee or the service providers.

## Rules for testing, in good faith

The hosted instance holds real people's attendance, so please test against your own deployment. The README explains
how to run one. Research that follows these rules is welcome and is treated as good faith.

- Do not read, change or delete other people's data.
- If you reach personal data by accident, stop, do not copy or keep it, and tell us in your report.
- Do not run load tests or anything that could slow the hosted instance down.

## Known and already handled

An old Google API key from the project's earlier Firebase version is in the git history. It was revoked and the
secret-scanning alert is closed, so it does not need a report.
