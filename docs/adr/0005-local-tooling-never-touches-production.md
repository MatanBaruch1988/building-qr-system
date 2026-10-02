# 0005: Local tooling never touches the production database

Status: Accepted

Date: 02/10/2026

## Context

The tests, the dev seed, the local API server and the local scripts connect to whatever `DATABASE_URL` says. A file made
by `vercel env pull` from the Production environment, or a connection string pasted by hand, would point all of them at
the real attendance data: the tests create and drop schemas, and the seed writes sample rows. The people and agents that
run them work fast, and nobody should have to be careful about this to be safe.

## Decision

Two guards, so that one mistake is not enough:

- `server/loadEnv.js` refuses an env file that was pulled from Vercel production (it says `VERCEL_ENV=production` or
  `VERCEL_TARGET_ENV=production`), instead of reading it.
- `server/dbGuard.js` looks at the database itself. Every real database carries a marker, the table
  `public.environment_marker` (schema-qualified, because the tests run with their own `search_path`), with the value
  `production` or `nonprod`. A database marked `production` is refused by the tests, the dev seed, the dev API server and
  `npm run db:migrate`. A database without the marker (a fresh one, the CI container) is allowed. No environment variable
  is read: any shell can set one.

The non-production database is a separate free Neon project in its own Neon organization (projects cannot be created in the
organization that Vercel manages). `npm run db:create-admin` is the one sanctioned local write to a deployment's database,
because the first committee member has to be added somewhere. It prints where it writes (the marker and a masked host,
never the whole URL), so that the person sees it before the row goes in.

## Consequences

Good:

- Even a hand-copied production URL is refused, because the guard reads the database and not the file.
- There is no switch to let a caller through, so no flag or variable can be set by mistake.
- Production is migrated only by the deployment-only path of ADR 0002.

Bad:

- The guard depends on the marker being there. A production database without the row is not recognized, so the marker has
  to be set up in each real database (it is not part of `db/migrations`, which are the same everywhere).
- A person needs two Neon projects, and a self-hosted copy needs its own marker.
- `db:create-admin` can still write to production when it is given the production URL on purpose. That is its job, and the
  message that names the target is the protection.

## Alternatives considered

- **A Neon branch of production for local work.** It copies the personal attendance data to every developer machine.
- **Trusting `VERCEL_ENV`.** Rejected after the Codex review of this change: any shell can set it, and a local
  `vercel build --prod` sets it too, so it proves nothing about where the code runs.
- **Checking the host name.** It breaks for a self-hosted copy of the project, whose host is not known in advance.
