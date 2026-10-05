# Something broke? Four steps

A short page for the owner, no programming needed. The details are in [incident.md](incident.md),
[deploy-and-rollback.md](deploy-and-rollback.md) and [restore.md](restore.md).

An issue on GitHub titled "Smoke test failed after deploying ..." means that a deploy broke something: follow the steps below.
So does an alert from UptimeRobot (the site did not answer), and so does an e-mail from healthchecks.io about the check
"building-qr server" (the server had an error: its text says which, so keep it for step 3).

1. **Check that the site is alive.** Open `https://<your-domain>/api/health` in a browser. If it shows `"ok":true`, the
   server is running. (The database check, `/api/health/db`, needs an agent key, so ask the agent to run it.) If the page
   does not open or shows an error, go to step 2.
2. **Go back to the previous version in Vercel.** Open Vercel, the project, the **Deployments** tab. Find the last version
   that worked well (below the current one), open its menu (the three dots) and choose **Instant Rollback**. It brings the
   previous code back within seconds and does not touch the data. If the trouble started after a merge, this is usually
   what is needed.
3. **Read what the app wrote down.** Vercel keeps its own log for only about an hour, so look here first, in this order, and
   copy what you find into your message to the agent:
   1. **healthchecks.io.** Open the check "building-qr server" and read its list of events, newest first. "First server error
      today" is the first error of that day (it names the route and the error's code). "Daily summary FAIL" is the morning
      report of the last 24 hours, about 06:00 to 08:00, and its "Why:" line says why it failed. "Daily summary OK" means the
      last 24 hours were fine. healthchecks.io e-mails you when a problem starts, but not again on the days after, so read
      the list and not only the e-mails.
   2. **The committee app.** The ("נותני שירות") tab, then the button ("מכשירים") on the provider's card: which phone has
      visits waiting for a long time, runs an old version, or does not report. The ("היסטוריה") tab, then ("סוג") and
      ("לא נקלטו"): visits that the server refused. The ("ועד") tab, then ("יומן פעולות") at the bottom: who changed what,
      and when.
   3. **Neon's SQL editor.** In your own browser, open the SQL editor of the production project in Neon and run, one at a time,
      the two queries in "Where to look" in [incident.md](incident.md) (part c). They only read. Copy the result to the agent.
   4. **Vercel's log**, only if the problem is less than an hour old: the project, **Logs**, and search for the `request_id`
      that the failed answer carries (the agent can tell you where it is).

   If the text says "Database unreachable", "database busy" or "alert record failed", open the Neon console and see whether
   the project is running, then read "When the alert is about the database" in [incident.md](incident.md), or tell the agent.
4. **Tell the agent (Claude Code) what happened.** Write what you saw, at what time, what you read in step 3, and what you
   already did. Do not paste passwords or connection strings.

If it looks like data was deleted or damaged: stop and tell the agent at once. Neon keeps only **6 hours** of history to
restore from, so time matters. See [restore.md](restore.md).

Never run `vercel --prod`. A deploy happens only by merging to `master`.
