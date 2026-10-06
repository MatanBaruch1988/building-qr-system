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

Added after the decision was implemented (02/10/2026) and revised after the Codex review of the pull request
(03/10/2026): the gate fails closed, and only migrations that are on GitHub master are applied. The decision above is
unchanged.

- **The entrypoint.** `vercel.json` sets `buildCommand` to `node scripts/vercel-build.mjs`. It does not call `loadEnv`:
  the variables come from Vercel, and a local run must not read `.env.local`.
- **Build first, then migrate.** It runs `vite build` as `npm run build` does. A failed build stops there and nothing is
  migrated. Only then does `productionBuildDecision` (`server/productionMigrate.js`, a pure function of the environment)
  choose `skip`, `migrate` or `refuse`, and the build log has one line with the choice and why.
- **The gate.** It decides from `VERCEL_ENV`, in this order. `preview` and `development` are `skip`: the app is built and
  no database is touched. `production` is `migrate` only with `VERCEL=1`, `VERCEL_GIT_COMMIT_REF=master`, a full
  40-character lower-case `VERCEL_GIT_COMMIT_SHA` and `VERCEL_GIT_REPO_OWNER` and `VERCEL_GIT_REPO_SLUG` (the next bullet
  needs the repository), and `refuse` otherwise. Anything else, including no `VERCEL_ENV` at all, is `refuse` too: it
  fails closed, so a build that does not say what it is never deploys. Vercel sets the branch, the hash and the repository
  only for a deployment that its Git integration builds, so a shell that sets `VERCEL_ENV` alone is not enough. A
  `refuse` fails the deployment and the current one keeps serving. A local build is `npm run build`, never this script.
- **The database.** `migrateProduction` uses `DATABASE_URL_UNPOOLED` and refuses a missing one and a pooled one
  (`-pooler`), because the lock needs a session of its own. It reads the marker first: `nonprod` stops the build ("this
  production build points at a non-production database"), `production` or no marker goes on.
- **Only migrations that are on GitHub master.** Before anything is applied, `migrateProduction` lists the pending files
  (the files of the build that `schema_migrations` does not have; with none, there is no network call). For each one it
  fetches `https://raw.githubusercontent.com/<owner>/<slug>/refs/heads/master/db/migrations/<file>` and requires the
  bytes to equal the local file exactly (the repository and the Vercel checkout are both LF, so nothing is normalized). A
  difference fails the build at once. A 404, a failing status or a network error is retried a few times (2, 5, 10, 20 and
  30 s), because the raw CDN can serve a stale 404 for a moment after a merge, and then fails the build too. A private
  fork sets `MIGRATION_GITHUB_TOKEN`, which is sent as `Authorization: Bearer` and never logged. Migration files never
  change once merged (the `guards` CI check), so "every pending file is identical to the one on master" means that only
  reviewed, merged migrations are applied, whatever started the build.
- **The lock and the timeouts.** `migrate()` takes one connection and a session-level advisory lock per schema (it waits up
  to 60 s, then fails with "another migration run holds the lock"), so two builds never apply the same file twice. Each
  migration runs in its own transaction with `lock_timeout = 5s` (a migration that waits for a lock held by live traffic
  fails fast instead of queueing every request behind it) and `statement_timeout = 5min` (the app pool's 15 s limit must
  not cut it short).
- **The marker.** When the database was not marked, the run marks it `production` after the migration, in one transaction
  that can be repeated. A new self-hosted deployment is therefore marked on its first deploy. The marker is never changed
  from `production`, and a database marked `nonprod` is never migrated by this path.
- **A failure.** A failed migration rolls back its own transaction, the build exits 1, and Vercel does not promote the
  deployment: the previous one keeps serving, on the schema it already works with. The build log says the file and the
  SQLSTATE with its condition name (`Migration 012_x.sql failed: 23505 (unique_violation)`), never the database's own
  message, which can quote a row value of production (`scripts/vercel-build.mjs` prints a failure through `buildFailureText`).
  Migrations that already ran in the same build stay applied (each file is its own transaction), so a fix is a new
  migration, never an edit of an old one.
- **Checking a deploy.** `GET /api/health` is public, free of the database, and shows the commit. `GET /api/health/db`
  needs a read-only agent key (`Authorization: Bearer qrk_...`, the key of the Agent tab): an open route that queries the
  database would let anyone wake the Neon compute and tie up the small connection pool. A missing or malformed key is
  refused without a query. With a key it runs one query and shows the newest migration (503 without detail when it
  fails), for a smoke test after a deploy. See `docs/runbooks/`. The workflow `.github/workflows/smoke.yml` now does this
  check automatically after every production deployment (`scripts/smoke-check.mjs`) and opens an issue when it fails.
- **A setting it depends on.** The gate reads Vercel's system environment variables, which reach the build only while the
  project setting "Automatically expose System Environment Variables" is on (it is: checked on 03/10/2026). With it off, a
  build has no `VERCEL_ENV`, and the gate answers `refuse`: the deployment fails instead of deploying without its
  migrations, and the message names the setting. The check after a deploy (`/api/health/db` shows the newest migration, and
  it must match the newest file in `db/migrations/`) stays as a second net.
- **The residual risk.** A deliberate `vercel --prod` from a checkout of master still passes the gate: it is a production
  deployment, and the CLI attaches the Git data of the checkout. Because the CLI uploads local files, which may be
  uncommitted or unpushed, the check against GitHub master is what remains: such a deploy can no longer apply a migration
  that is not merged. It can still ship unreviewed app code to production. Vercel's Deployment Policies would close that
  part too, but they are a Pro feature and this account is on Hobby. That is why `AGENTS.md` and `.claude/settings.json`
  forbid `vercel --prod`, and why the owner deploys only by merging. A redeploy of an old deployment from the Vercel
  dashboard runs the gate again for that commit and applies nothing that is already applied.
- **What the gate is for.** It stops mistakes, not a hostile deployer. A CLI deploy uploads the build script along with
  everything else, so somebody who deliberately deploys with the owner's Vercel credentials can change or delete this
  gate, the GitHub check and the repository name it trusts (`VERCEL_GIT_REPO_OWNER` and `VERCEL_GIT_REPO_SLUG`, which a
  CLI deploy takes from the checkout's origin). No check inside the build can stop that. The protection against it
  is outside the code: the Vercel credentials stay with the owner (an agent never deploys), and on Pro a Deployment
  Policy that allows only Git for production. Reviewers: a finding that only a hostile CLI deployer can exploit is
  answered by this paragraph, not by another check in the build.

## Addendum (06/10/2026): the production branch is the default branch, as GitHub reports it

The gate above wrote the branch `master` in two places: a production build migrated only when `VERCEL_GIT_COMMIT_REF` was
`master`, and the check of the migration files fetched them from `refs/heads/master`. A copy of this project (a fork, or
one made with the Deploy button) often has `main` as its default branch, and in such a copy nothing could deploy. The
decision above is unchanged. Only where the name of the branch comes from changed.

- **The rule.** The production branch is the repository's default branch, as GitHub reports it during the build. It is
  never a value from the build environment (no variable), never a file of the build, and never a name written in the code
  (`AGENTS.md`, "Database and API changes"). It is the branch that Vercel deploys to production and that the rulesets
  protect (`~DEFAULT_BRANCH`), so "merged" and "on the production branch" mean the same.
- **Why not a value from the environment (the Codex finding).** A name that the build environment supplies can be moved. A
  build environment that names a topic branch would move both checks onto that branch: the gate would let a build of the
  topic branch migrate, and the byte check would compare the pending files with the same unreviewed branch, so "identical
  to the file on that branch" would stop meaning "reviewed and merged". The default branch is the one thing that the
  environment of a build does not configure, and changing it is an administrator's action on GitHub.
- **How it is read.** `readDefaultBranch` in `server/productionMigrate.js` asks git's smart HTTP discovery,
  `GET https://github.com/<owner>/<slug>.git/info/refs?service=git-upload-pack`, which is what `git ls-remote --symref`
  does, and takes the capability `symref=HEAD:refs/heads/<name>` of the first reference line. It is not the REST API: that
  allows 60 requests an hour for each address without a token, and the build servers of Vercel share their addresses.
  The request carries no `Git-Protocol` header, because protocol version 2 answers without the symref. The body is read as
  a stream only as far as that first line (a repository lists every branch, tag and pull request after it) and the rest is
  dropped. `tests/fixtures/github-info-refs.js` is a real answer, trimmed.
- **What is checked.** The name must be a plain branch name: letters, digits and `._/-`, at most 100 characters, no leading
  `-`, `.` or `/`, no `..`, `//` or `@{`, no trailing `/` or `.`. When the answer cannot be read (a failing status, a
  network error, a timeout, a body that is not a reference list, no symref, a name that is not plain), the build is refused
  with `The default branch of <owner>/<slug> could not be read from GitHub ...`. It never falls back to `master`, to `main`
  or to the branch of the build. Failing statuses and network errors are retried with the waits of the migration files.
- **The gate.** Every condition of the first gate stays: `VERCEL=1`, `VERCEL_ENV=production`, a full commit hash, the
  repository, and a refusal of an unknown environment. Only the literal branch is gone. `productionBuildDecision` asks for
  a branch to be present, and `migrateProduction` then reads the default branch and refuses unless `VERCEL_GIT_COMMIT_REF`
  is exactly it, before it creates its pool: no statement runs against the database first. The refusal ends the build the
  way a refusal always did (`Production migration failed: ...`, exit 1, the deployment fails, the current one keeps serving)
  and names both branches. When the branch matches, the log says `Production branch: <name> (the default branch on GitHub)`.
- **The byte check.** The files are fetched from `refs/heads/<default branch>/db/migrations/<file>`, each segment of the
  branch name URL-encoded and the `/` kept as a separator. The messages name the branch, so for this repository they are
  what they were (`verified against GitHub master`).
- **A private repository.** `MIGRATION_GITHUB_TOKEN` is still the only credential. A file is fetched with
  `Authorization: Bearer`, as before. The discovery is sent as git sends a token to github.com: Basic authentication with the
  token as the password. The token is never logged and is in no message.
- **`vercel.json`.** `git.deploymentEnabled` lists `master` and `main`. JSON has no comments, so the reason is in
  `docs/runbooks/deploy-and-rollback.md`: a copy whose default branch has another name adds it there.
- **What it costs.** Every production build makes one more request, a round trip to github.com, even when no migration is
  pending, because the branch must be known before the database is touched. If GitHub cannot be reached, the deployment
  fails and the current one keeps serving, as for a migration file that cannot be read.
- **What is left.** A deploy through the CLI from a checkout still passes and still has the residual risk described above.
  Whoever can change the default branch of the repository changes the production branch with it. That is an administrator,
  who could change the rulesets as well, so it is outside what a check in the build can stop.
