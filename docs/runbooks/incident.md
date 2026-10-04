# Incident checklist

Use it when something is broken in production. Go in order, and write down the time of each step. The owner has a shorter
page: [something-broke.md](something-broke.md).

An entry point: after every production deploy the smoke test runs (`.github/workflows/smoke.yml`), and when it fails it
opens an issue titled `Smoke test failed after deploying <commit>`. Open the run that the issue links to and read its
`FAIL` line: `production does not serve <commit>` and `GET /` point to steps 2 and 4, and the two database lines (`the
database is at ...` and `the database check failed`) to steps 3 to 5. Each line is explained in
[deploy-and-rollback.md](deploy-and-rollback.md), "The smoke test after a deploy". Then go on from step 2 below.

1. **What is broken?** Who sees it (providers, the committee, the agent), on which screen, since when. Is it everyone or one
   phone? A phone that shows old behaviour may simply run an old installed version of the app.
2. **`/api/health`**: `https://<your-domain>/api/health`. It does not use the database. If it fails, the deployment or Vercel
   is the problem. If it answers, look at `commit`: is it the commit you expect?
3. **`/api/health/db`**: it needs a read-only agent key (the Agent tab of `/admin`):
   `curl -H "Authorization: Bearer <agent key>" https://<your-domain>/api/health/db`. `200` shows the newest `migration`.
   `503` means this deployment cannot reach its database or the query failed (the cause is only in the Vercel logs, the
   response says nothing). `401` means the key is missing, wrong or revoked, not that the site is down.
4. **Vercel**: Deployments, the latest production deployment: did the build pass, did the migration print an error, is it the
   one that is promoted? Open **Logs** for runtime errors of `/api/*` (by rule they never contain personal data:
   `server/router.js` writes an unhandled error as one line with only the method and the route as it is
   written in the code (never the path that was asked for), the error name, its code (for Postgres the SQLSTATE) and the
   stack frames, never the message or the raw error, and `tests/router-log.test.js` keeps it so; if one does, that is a second problem to fix).
5. **Neon console**: is the project and its compute running (a compute that sleeps wakes in a few seconds), any limit reached
   (storage, compute hours), any outage notice?
6. **Roll back the code** if the last deployment is the cause: Instant Rollback (`deploy-and-rollback.md`). It is
   quick and reversible. The database is not rolled back: fix forward.
7. **Data damaged or lost?** Go to `restore.md` at once: the window is 6 hours.
8. **Tell the committee** in plain words: what does not work, what still works (a phone that is offline queues check-ins and
   uploads them later), when you will update them. Say when it is fixed too.
9. **After it is over**, write a short note (in the repository or the issue): what happened, the times, what was done, what
   was the cause, and what to change so that it does not repeat (a test, a guard, a rule in `AGENTS.md`).

**A secret leaked?** Revoke it first and clean the files after (ADR 0004). [secrets.md](secrets.md) says where each secret
of the project lives, who can rotate it and how, and when it was last rotated.
