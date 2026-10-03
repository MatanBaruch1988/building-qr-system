# Deploy and roll back

A merge to `master` is the only way to reach production. Nobody runs a deploy, and nobody runs a migration by hand
(ADR 0002, `AGENTS.md`). If something is already broken and you want the short version, read
[something-broke.md](something-broke.md).

## How a merge reaches production

1. The owner squash-merges a pull request on GitHub (the four CI checks are green).
2. Vercel's Git integration sees the new commit on `master` and starts a production build.
3. Vercel runs the build command from `vercel.json`: `node scripts/vercel-build.mjs`.
4. The script runs `vite build`. If the build fails, it stops: nothing is migrated.
5. The script prints one gate line, and then acts on it:
   - `Deploy gate: migrate (...)`: this is the production build of a commit on master. Before it applies anything, the
     script checks that every pending migration file is byte-identical to the file on GitHub master (one line
     `Migration NNN_name.sql: verified against GitHub master` per file; with nothing pending there is no check). Then it
     migrates the production database (`DATABASE_URL_UNPOOLED`, a direct connection) and prints `Applied: ...` or
     `Database is up to date.`
   - `Deploy gate: refuse (...)`: a production build without the Git data of a commit on master, or a build whose
     environment is unknown (no `VERCEL_ENV`). The build exits 1 and the deployment fails. If the reason says the
     environment is unknown, open the Vercel project settings, Environment Variables, and switch on "Automatically expose
     System Environment Variables".
   - `Deploy gate: skip (...)`: a Vercel preview or development build. It builds and touches no database.
6. If the script exits 0, Vercel promotes the deployment: production now serves the new code.

The old deployment serves traffic during steps 2 to 6, which is why every migration must work for the old code and the new
code at the same time (expand and contract, `AGENTS.md`, "Database and API changes").

## How to see it

- Vercel dashboard, the project, **Deployments**: the newest production deployment, its status and its **Build Logs**.
- In the build log, search for `Deploy gate:`. The line also shows `VERCEL_ENV`, `VERCEL_GIT_COMMIT_REF` and the first 7
  characters of the commit.
- After it is live, check `https://<your-domain>/api/health` (public, no database, shows `commit`) and
  `https://<your-domain>/api/health/db` (one query, shows the newest `migration`). The second needs a read-only agent key,
  the one the committee creates in the Agent tab of `/admin`:
  `curl -H "Authorization: Bearer <agent key>" https://<your-domain>/api/health/db`. Both should show the commit you merged,
  and the second should show the newest file in `db/migrations/`. Keep the key in a file or a secret, never in a chat.

## A failed migration

The build prints `Production migration failed: Migration NNN_name.sql failed: <reason>` and exits 1. Vercel marks the
deployment as failed and does **not** promote it, so the previous deployment keeps serving. Nothing is needed to "stay up".

- The file that failed was rolled back as a whole. Files that ran earlier in the same build stay applied.
- Do not edit the file that was merged. Fix forward: a new pull request with a new migration (the next number), merged the
  same way.
- `another migration run holds the lock` means two builds ran together, or a build was killed in the middle. Wait a minute
  and redeploy the same commit from the Vercel dashboard (**Redeploy**): the lock is released when its session ends.
- `lock timeout` means the migration waited more than 5 s for a lock that live traffic held. Redeploy later, or rewrite the
  migration (in a new pull request) so that it takes shorter locks.
- `Migration NNN_name.sql differs from the file on GitHub master` means the build holds a migration that is not the merged
  one (a deploy from a local checkout, or a file edited after the merge). Nothing was applied. Deploy by merging, and never
  edit a merged migration.
- `Migration NNN_name.sql could not be read from GitHub master` means the file was not found there after several tries
  (about a minute): it is not merged, or GitHub was unreachable. If it is merged, redeploy. A private fork needs
  `MIGRATION_GITHUB_TOKEN` in the Vercel project (a token that can read the repository contents).

## Roll back the code

If the new code is wrong but the deployment succeeded:

1. Vercel dashboard, **Deployments**, find the last good production deployment, open its menu, **Instant Rollback**.
   The owner does this in the dashboard.
2. Instant Rollback re-promotes the older build as it was. It does **not** run a build, so `scripts/vercel-build.mjs` does
   not run and **no migration runs**.
3. Check `/api/health`: `commit` is the old one.
4. Vercel then stops promoting new deployments by itself. A later merge builds and migrates as usual, but it goes live only
   when the owner promotes it from the dashboard (read the notice that Vercel shows after the rollback).

The old code works with the newer schema because migrations only add (expand) until a later release contracts them.

## The database is never rolled back

A migration is not undone. If a migration was wrong, fix forward with a new migration (expand and contract). If data was
lost or damaged, see `restore.md`.

## Never

- Never `vercel --prod` or `vercel deploy --prod`, from anywhere. `AGENTS.md` and `.claude/settings.json` forbid it.
  A production deployment from a checkout can pass the gate. It cannot apply a migration that is not on GitHub master,
  but it can ship app code that nobody reviewed (Vercel's Deployment Policies would block it, a Pro feature).
- Never run `npm run db:migrate` against production: it refuses it, and the marker (`public.environment_marker`) must not
  be edited to get past that.
- Never `vercel env pull` from Production.
