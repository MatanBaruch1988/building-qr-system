# Deploy and roll back

A merge to the production branch is the only way to reach production. The production branch is the repository's default
branch as GitHub reports it during the build (`master` here, often `main` in a copy; ADR 0002, addendum of 06/10/2026). It
is never set by a variable or a file. Nobody runs a deploy, and nobody runs a migration by hand (ADR 0002, `AGENTS.md`). If
something is already broken and you want the short version, read [something-broke.md](something-broke.md).

## How a merge reaches production

1. The owner squash-merges a pull request on GitHub (the four CI checks are green).
2. Vercel's Git integration sees the new commit on the production branch and starts a production build.
3. Vercel runs the build command from `vercel.json`: `node scripts/vercel-build.mjs`.
4. The script runs `vite build`. If the build fails, it stops: nothing is migrated.
5. The script prints one gate line, and then acts on it:
   - `Deploy gate: migrate (...)`: this is the production build of a commit that the Vercel Git integration built. Before it
     connects to the database, the script asks GitHub for the default branch of the repository and prints
     `Production branch: <name> (the default branch on GitHub)`. The commit must be on that branch (see "A build of another
     branch" below). Then, before it applies anything, it checks that every pending migration file is byte-identical to the
     file on that branch on GitHub (one line `Migration NNN_name.sql: verified against GitHub <branch>` per file; with
     nothing pending no file is checked). Then it migrates the production database (`DATABASE_URL_UNPOOLED`, a direct
     connection) and prints `Applied: ...` or `Database is up to date.`
   - `Deploy gate: refuse (...)`: a production build without the Git data of a commit, or a build whose environment is
     unknown (no `VERCEL_ENV`). The build exits 1 and the deployment fails. If the reason says the environment is unknown,
     open the Vercel project settings, Environment Variables, and switch on "Automatically expose System Environment
     Variables".
   - `Deploy gate: skip (...)`: a Vercel preview or development build. It builds and touches no database.
     Branches other than the production branch are not deployed by themselves (`git.deploymentEnabled` in `vercel.json`:
     `"**": false, "master": true, "main": true`), so a pull request gets no automatic preview: the checks run in CI, and
     the daily deployment quota of the Hobby plan stays for production. A preview of one branch can still be made on purpose
     from the Vercel dashboard (Deployments, Create Deployment, the branch); it is a preview build and never migrates.
     `vercel.json` lists `master` and `main` because those are the usual names of a default branch. JSON has no comments,
     so this is where the reason is written: a copy whose default branch has another name must add that name to
     `deploymentEnabled` (and make it the production branch in the settings of the Vercel project), or Vercel will not
     build it by itself.
6. If the script exits 0, Vercel promotes the deployment: production now serves the new code.

### A build of another branch

The production branch is read from GitHub in every production build, with git's own request for it
(`https://github.com/<owner>/<repo>.git/info/refs?service=git-upload-pack`, the one `git ls-remote --symref` makes), not
from the REST API, which allows too few requests for the shared addresses of Vercel's build servers. When the build is of
any other branch than the default branch, the build exits 1 before it connects to the database:

```
Production migration failed: This production build is of the branch <built>, but the production branch of <owner>/<repo> is its default branch on GitHub, <default>. Production is deployed only from a merge to <default>: the production branch of the Vercel project and the default branch on GitHub must be the same
```

The deployment fails and the current one keeps serving. The usual cause is a project whose Vercel production branch is not
the default branch of the repository: make them the same (change the Vercel setting, or the default branch on GitHub).
If the default branch was renamed, the gate follows the new name by itself, but Vercel deploys it only when its name is in
`git.deploymentEnabled` in `vercel.json` (`master` and `main` are there): a branch with another name must be added there,
and made the production branch in the settings of the Vercel project, before its merges deploy (see the deploy steps above).

If GitHub cannot say what the default branch is, the build is refused the same way and never guesses:

- `The default branch of <owner>/<repo> could not be read from GitHub after N tries (HTTP 404)` (or `network error`, or
  `timed out`): GitHub was unreachable, or the repository is private and `MIGRATION_GITHUB_TOKEN` is missing. The build
  asked several times (about a minute). Redeploy when GitHub is back.
- `GitHub refused to give the default branch of <owner>/<repo> (HTTP 401)`: a private repository needs
  `MIGRATION_GITHUB_TOKEN`, a token that can read the contents of the repository, in the Vercel project; or the token that
  is there was refused or has expired. A refused token is not asked for again.
- `The default branch of <owner>/<repo> could not be read from GitHub: the answer ...`: GitHub answered, but not with a
  default branch (an empty repository, or a default branch whose name is not a plain one: letters, digits and `._/-`, at
  most 100 characters). Rename such a branch.

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

## The smoke test after a deploy

Nobody has to remember the check above: after Vercel promotes a production deployment, GitHub gets a `deployment_status`
event and `.github/workflows/smoke.yml` runs `scripts/smoke-check.mjs` against the production domain (never the unique URL
of the deployment, which Vercel Deployment Protection can hide). It is not a merge check: it runs after the merge, so it
cannot block one. If it finds something wrong it opens an issue.

The domain is the repository variable `SMOKE_BASE_URL`, set once from the repository folder:
`gh variable set SMOKE_BASE_URL --body https://<your-domain>` (the address that people open, with no path). It is not
written in the repository, so that a copy tests its own site. Without it every run fails, and the issue is titled
"Smoke test is not set up: SMOKE_BASE_URL is missing": set the variable, then re-run the failed jobs of that run. The
variable decides where the agent key below is sent, so only someone with write access to the repository changes it.

A production deployment that fails (the build, the gate or a migration) opens an issue too, titled "Production
deployment failed for <commit>", with the link to its build log on Vercel: nothing is down then, but the merge is not in
production until a later deployment succeeds.

Where to see it: GitHub, the **Actions** tab, the workflow **Smoke test**. A run for a preview deployment shows as skipped,
which is normal. Open the run of the production deployment: the log has one line per step (`ok`, `FAIL`, `warn` or `skip`)
and, at the end, a summary of the problems.

The three steps:

1. `GET /api/health` until the domain serves the commit that was deployed. It asks every 10 s for up to 5 minutes, because
   the promotion can lag behind the event.
2. `GET /` returns the app page with its root element.
3. `GET /api/health/db` with a read-only agent key: the database answers, and its newest migration is the newest file in
   `db/migrations/` of that commit. It needs the secret `SMOKE_AGENT_KEY`. Without it this step is skipped with a warning
   (`warn 3/3`) and the run still passes. How to set it is at the top of `smoke.yml`: make a key in the Agent tab of
   `/admin`, then run `gh secret set SMOKE_AGENT_KEY` and paste the key at the prompt, never on the command line.

If step 1 fails, steps 2 and 3 are skipped, because they would test a different deployment.

**What an issue means.** An issue titled `Smoke test failed after deploying <commit>` (label `bug`) means that a deploy broke
something, or did not take effect. It links to the run. Read the `FAIL` line there, then go to [incident.md](incident.md)
(the owner's short page is [something-broke.md](something-broke.md)):

- `production does not serve <commit>, it serves <other>`: after 5 minutes the domain still serves another deployment. Look
  in Vercel: did the build fail, was the deployment never promoted? This is also what the run shows after an Instant
  Rollback, when a later merge is built but not promoted until you promote it. If it only needed more time, run the job
  again from the Actions tab (**Re-run all jobs**).
- `GET /` is not the app page: the deployment serves something that cannot start the app. Roll the code back.
- `the database is at <old file>, the code expects <new file>`: the deployment is live but its migration did not run. Look
  in the build log for the `Deploy gate:` line, and read "A failed migration" below. Fix forward: never edit a merged
  migration.
- `the database check failed (HTTP 503)`: this deployment cannot reach its database, so see steps 3 to 6 of
  [incident.md](incident.md), and "When the alert is about the database" there. The script asked three times, 5 s apart, so
  it was not one slow wake-up.
- `the agent key was refused (HTTP 401)`: the secret is wrong or the key was revoked. Make a new key in the Agent tab and
  set the secret again. The site itself may be fine.

Nothing closes the issue by itself: close it when it is fixed. The script only reads, so it can also be run by hand from a
checkout of the deployed commit: `EXPECTED_SHA=<the full commit> SMOKE_BASE_URL=https://<your-domain> node scripts/smoke-check.mjs`. For the database step put
`SMOKE_AGENT_KEY` in the environment from a file or a prompt, never on the command line and never in a chat.

## A failed migration

The build prints `Production migration failed: Migration NNN_name.sql failed: <SQLSTATE> (<condition name>)`, for example
`Migration 012_x.sql failed: 23505 (unique_violation)`, and exits 1. Vercel marks the deployment as failed and does **not**
promote it, so the previous deployment keeps serving. Nothing is needed to "stay up".

The log never holds the message of the database: it can quote a row value of production, and the build log is read by more
people than the owner. So the file, the code and the name of the condition are what it says (a code that has no name there is
in appendix A of the PostgreSQL documentation, "PostgreSQL Error Codes"). To read the database's own message and the position
in the file, run the same file against the non-production database: `npm run db:migrate` prints `Database message:` and the
position, because that database holds fake data only. A failure that only production data causes (a duplicate key, a value
that does not cast) does not happen there: the owner finds the row in the Neon console, and never copies it into a log, an
issue or a pull request.

- The file that failed was rolled back as a whole. Files that ran earlier in the same build stay applied.
- Do not edit the file that was merged. Fix forward: a new pull request with a new migration (the next number), merged the
  same way.
- `another migration run holds the lock` means two builds ran together, or a build was killed in the middle. Wait a minute
  and redeploy the same commit from the Vercel dashboard (**Redeploy**): the lock is released when its session ends.
- `55P03 (lock_not_available)` means the migration waited more than 5 s for a lock that live traffic held. Redeploy later, or
  rewrite the migration (in a new pull request) so that it takes shorter locks.
- `57014 (query_canceled)` means a statement ran longer than the 5 minute limit of a migration. Rewrite the migration (in a
  new pull request) so that it does less in one statement.
- `Migration NNN_name.sql differs from the file on GitHub <branch>` (`master` here, the default branch in a copy) means the
  build holds a migration that is not the merged one (a deploy from a local checkout, or a file edited after the merge).
  Nothing was applied. Deploy by merging, and never edit a merged migration.
- `Migration NNN_name.sql could not be read from GitHub <branch>` means the file was not found there after several tries
  (about a minute): it is not merged, or GitHub was unreachable. If it is merged, redeploy. A private fork needs
  `MIGRATION_GITHUB_TOKEN` in the Vercel project (a token that can read the repository contents; the build uses it for the
  files and to read the default branch).

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
  A production deployment from a checkout can pass the gate. It cannot apply a migration that is not on the production
  branch on GitHub,
  but it can ship app code that nobody reviewed (Vercel's Deployment Policies would block it, a Pro feature).
- Never run `npm run db:migrate` against production: it refuses it, and the marker (`public.environment_marker`) must not
  be edited to get past that.
- Never `vercel env pull` from Production.
