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

## Addendum (03/10/2026): the daily backup is a sanctioned read

The free Neon plan restores production only to a point in the last 6 hours, so the owner decided on a daily dump of the
database on the owner's own computer (`npm run db:backup`, `scripts/backup-db.mjs`, described in
`docs/runbooks/restore.md`). That reads the production database on purpose, so it is an exception to the rule of this
decision. It is written down here so that it stays narrow:

- With `db:create-admin`, it is one of the two sanctioned local accesses to a deployment's database. `db:create-admin`
  writes (one row); the backup only reads.
- It is read-only by construction. It runs `pg_dump`, and every session of `pg_dump` is made read-only by the server:
  `-c default_transaction_read_only=on` goes into `PGOPTIONS`, after any options of the connection string, so nothing in
  that string can turn it off. A write in such a session fails with "cannot execute ... in a read-only transaction".
- It does not use the production guard (`server/dbGuard.js`), because refusing production would defeat its purpose. The
  read-only session is the protection instead.
- The dump never leaves the owner's machine: a folder outside the repository, files that only the owner can read (the
  umask and the modes on macOS and Linux, an owner-only access list on Windows), `*.dump` in `.gitignore`, and no
  connection string or personal data in a log, an issue or a pull request.
- It refuses to work in a folder that another account can change: the output folder and every folder above it (the access
  lists are read as SDDL on Windows, the modes elsewhere). It then works in a private directory inside that folder
  (`fs.mkdtemp`: an unpredictable name, mode 700 in one step) and moves the verified file out of it with a rename at the end.
  Without that rule, somebody who can write in the output folder could add an access entry to a directory made there, or swap
  the path of a file that `pg_dump` is about to open, before the directory or file is closed. Nothing depends on the temp
  folder of the user, which on a shared computer is often writable by other accounts.
- It reads one database, chosen in one place: `BACKUP_DATABASE_URL` or `--neon-project`, and giving both is an error, so that
  the environment never silently wins over the command line.
- A change that lets the backup write, or run without the read-only session, is P1 in the code review rules of
  `AGENTS.md`.
