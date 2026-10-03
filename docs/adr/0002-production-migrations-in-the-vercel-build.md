# 0002: Production migrations run in the Vercel production build

Status: Accepted, implemented

Date: 02/10/2026

## Context

`npm run db:migrate` refuses a production database (ADR 0005) and nothing else migrates production yet, so a release that
adds a migration needs a step that is not built. That step must not depend on somebody remembering it. Two facts shape
the answer. First, the old deployment keeps serving traffic while the new one builds, so the database must
work for the old code and the new code at the same time. Second, the production database credentials are the most
valuable secret of the project, and the repository is public.

## Decision

Production migrations will run inside the Vercel production build, before the new deployment takes traffic. Vercel already
holds the production credentials, so they never go into GitHub, and a self-hosted copy of the project is migrated on its
first deploy without extra steps.

The gate that lets that build touch production must not be a shell variable alone. The Codex review of the production
guard (ADR 0005) showed that `VERCEL_ENV=production` can be set by any shell, and that a local `vercel build --prod` sets
it too. So `npm run db:migrate` refuses a production database always, whatever the variables say, and the build gets its
own entrypoint that the local scripts do not share. How that entrypoint knows that it runs in the production build is
part of the change that implements this decision.

Expand and contract (AGENTS.md, "Database and API changes") is required, because the old deployment keeps serving during the
build: a migration may only add, and a destructive one needs `-- contract: <reason>`.

## Consequences

Good:

- No production credentials in GitHub, and nothing to remember at release time.
- A migration that fails fails the build, so the new deployment never takes traffic on a schema it cannot use.
- The same path works for a self-hosted copy.

Bad:

- A slow or failing migration slows or blocks the build, and the build log is where it shows.
- The build now holds a write path to production, so the entrypoint is security-sensitive and needs the owner's careful
  review.
- A preview build must never migrate production: only the production build may.

## Alternatives considered

- **Migrating from GitHub Actions.** It needs the production connection string stored in GitHub, which is the exposure the
  project avoids (ADR 0001).
- **Migrating by hand, from a laptop with the production connection string.** Steps get forgotten, the order of "deploy"
  and "migrate" is a guess, and it is exactly the local path that ADR 0005 closes.
- **Migrating at runtime, on the first request.** Several function instances can start together, so it needs a lock, and
  it adds a long wait to a cold start that a person is waiting on.

## Implementation

Added after the decision was implemented (02/10/2026). The decision above is unchanged.

- **The entrypoint.** `vercel.json` sets `buildCommand` to `node scripts/vercel-build.mjs`. It does not call `loadEnv`:
  the variables come from Vercel, and a local run must not read `.env.local`.
- **Build first, then migrate.** It runs `vite build` as `npm run build` does. A failed build stops there and nothing is
  migrated. Only then does `productionBuildDecision` (`server/productionMigrate.js`, a pure function of the environment)
  choose `skip`, `migrate` or `refuse`, and the build log has one line with the choice and why.
- **The gate.** `migrate` needs `VERCEL=1`, `VERCEL_ENV=production`, `VERCEL_GIT_COMMIT_REF=master` and a full 40-character
  lower-case `VERCEL_GIT_COMMIT_SHA`. Vercel sets the branch and the hash only for a deployment that its Git integration
  builds, so a shell that sets `VERCEL_ENV` alone is not enough. Any other build is `skip` (a preview build, a local or
  a CI build: it builds and touches no database), except a production build without that proof, which is `refuse`: the
  deployment fails and the current one keeps serving.
- **The database.** `migrateProduction` uses `DATABASE_URL_UNPOOLED` and refuses a missing one and a pooled one
  (`-pooler`), because the lock needs a session of its own. It reads the marker first: `nonprod` stops the build ("this
  production build points at a non-production database"), `production` or no marker goes on.
- **The lock and the timeouts.** `migrate()` takes one connection and a session-level advisory lock per schema (it waits up
  to 60 s, then fails with "another migration run holds the lock"), so two builds never apply the same file twice. Each
  migration runs in its own transaction with `lock_timeout = 5s` (a migration that waits for a lock held by live traffic
  fails fast instead of queueing every request behind it) and `statement_timeout = 5min` (the app pool's 15 s limit must
  not cut it short).
- **The marker.** When the database was not marked, the run marks it `production` after the migration, in one transaction
  that can be repeated. A new self-hosted deployment is therefore marked on its first deploy. The marker is never changed
  from `production`, and a database marked `nonprod` is never migrated by this path.
- **A failure.** A failed migration rolls back its own transaction, the build exits 1, and Vercel does not promote the
  deployment: the previous one keeps serving, on the schema it already works with. The error is in the build log.
  Migrations that already ran in the same build stay applied (each file is its own transaction), so a fix is a new
  migration, never an edit of an old one.
- **Checking a deploy.** `GET /api/health` is free of the database and shows the commit. `GET /api/health/db` runs one
  query and shows the newest migration, for a smoke test after a deploy. See `docs/runbooks/`.
- **The residual risk.** A deliberate `vercel --prod` from a checkout of master can still pass the gate: it is a production
  deployment, and the CLI attaches the Git data of the checkout. That is why `AGENTS.md` and `.claude/settings.json`
  forbid it, and why the owner deploys only by merging. A redeploy of an old deployment from the
  Vercel dashboard runs the gate again for that commit and applies nothing that is already applied.
