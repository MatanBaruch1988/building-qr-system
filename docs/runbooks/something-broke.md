# Something broke? Three steps

A short page for the owner, no programming needed. The details are in [incident.md](incident.md),
[deploy-and-rollback.md](deploy-and-rollback.md) and [restore.md](restore.md).

1. **Check that the site is alive.** Open `https://<your-domain>/api/health` in a browser. If it shows `"ok":true`, the
   server is running. Then open `/api/health/db`: if it shows `"ok":true`, the database answers too. If it shows
   `"ok":false` or an error, go to step 2.
2. **Go back to the previous version in Vercel.** Open Vercel, the project, the **Deployments** tab. Find the last version
   that worked well (below the current one), open its menu (the three dots) and choose **Instant Rollback**. It brings the
   previous code back within seconds and does not touch the data. If the trouble started after a merge, this is usually
   what is needed.
3. **Tell the agent (Claude Code) what happened.** Write what you saw, at what time, and what you already did. Do not paste
   passwords or connection strings.

If it looks like data was deleted or damaged: stop and tell the agent at once. Neon keeps only **6 hours** of history to
restore from, so time matters. See [restore.md](restore.md).

Never run `vercel --prod`. A deploy happens only by merging to `master`.
