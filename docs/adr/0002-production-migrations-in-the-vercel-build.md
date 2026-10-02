# 0002: Production migrations run in the Vercel production build

Status: Accepted, not implemented yet

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
