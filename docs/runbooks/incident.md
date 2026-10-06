# Incident checklist

## Reading these runbooks in a copy

These runbooks were written for the first installation (the owner's own building), and every installation uses them. Plain
text is for every installation, with a placeholder where a copy has its own value (`https://<your-domain>`, `<owner>/<repo>`;
where the first installation's real value helps as an example, it is given once in parentheses). A note that begins "The first
installation" describes a service, a setup or a dated record that only the first installation has (its healthchecks.io checks,
its UptimeRobot monitor, the dated lines of its logs) and says in one clause what a copy does instead: the same service under
its own names, an optional one, or none.

## The checklist

Use it when something is broken in production. Go in order, and write down the time of each step. The owner has a shorter
page: [something-broke.md](something-broke.md).

Vercel's runtime logs last only about one hour on the Hobby plan, so a problem that is older than that has no log at all.
The app therefore writes down what went wrong itself (ADR 0007, `docs/adr/0007-observability-in-our-own-postgres.md`), and
step 5 says where to read it, from the place that lasts longest to the one that is gone first.

Two entry points:

- After every production deploy the smoke test runs (`.github/workflows/smoke.yml`), and when it fails it opens an issue
  titled `Smoke test failed after deploying <commit>`. Open the run that the issue links to and read its `FAIL` line:
  `production does not serve <commit>` and `GET /` point to steps 2 and 4, and the two database lines (`the database is at
  ...` and `the database check failed`) to steps 3 to 6. Each line is explained in
  [deploy-and-rollback.md](deploy-and-rollback.md), "The smoke test after a deploy". Then go on from step 2 below.
- An alert from healthchecks.io on the server's own check (the first installation's is named "building-qr server"; a copy
  has this check only if it set `HEALTH_HEARTBEAT_URL`, see `secrets.md`): open its event list and read the text of the
  newest ping (step 5, part a). The text says what happened. Then go on from step 5.

1. **What is broken?** Who sees it (providers, the committee, the agent), on which screen, since when. Is it everyone or one
   phone? A phone that shows old behaviour may simply run an old installed version of the app.
2. **`/api/health`**: `https://<your-domain>/api/health`. It does not use the database. If it fails, the deployment or Vercel
   is the problem. If it answers, look at `commit`: is it the commit you expect?
3. **`/api/health/db`**: it needs a read-only agent key (the Agent tab of `/admin`):
   `curl -H "Authorization: Bearer <agent key>" https://<your-domain>/api/health/db`. `200` shows the newest `migration`.
   `503` means this deployment cannot reach its database or the query failed (the response does not say why: the cause is
   in the Vercel log, which lasts about an hour, see "When the alert is about the database" below). `401` means the key is
   missing, wrong or revoked, not that the site is down.
4. **Vercel, Deployments**: the latest production deployment: did the build pass, did the migration print an error, is it the
   one that is promoted? (The runtime logs are part of step 5, because they are the least durable.)
5. **What the app recorded**: read "Where to look, in this order" below.
6. **Neon console**: is the project and its compute running (a compute that sleeps wakes in a few seconds), any limit reached
   (storage, compute hours), any outage notice?
7. **Roll back the code** if the last deployment is the cause: Instant Rollback (`deploy-and-rollback.md`). It is
   quick and reversible. The database is not rolled back: fix forward.
8. **Data damaged or lost?** Go to `restore.md` at once: the window is 6 hours.
9. **Tell the committee** in plain words: what does not work, what still works (a phone that is offline queues check-ins and
   uploads them later), when you will update them. Say when it is fixed too.
10. **After it is over**, write a short note (in the repository or the issue): what happened, the times, what was done, what
    was the cause, and what to change so that it does not repeat (a test, a guard, a rule in `AGENTS.md`).

**A secret leaked?** Revoke it first and clean the files after (ADR 0004). [secrets.md](secrets.md) says where each secret
of the project lives, who can rotate it and how, and when it was last rotated.

## Where to look, in this order

What the app records about an error (parts a, c and d) never holds a message, a requested address, a name or a QR code
(`AGENTS.md`, Safety). It holds the route as it is written in the code (for example `/admin/points/:id`), the error's code
or name, counts and times. Part b is the committee app itself, so it shows the names that the committee already sees.

### a. healthchecks.io: the event list of the server's own check

The first installation uses healthchecks.io for two checks. A copy that uses the same service gives its checks its own names;
a copy that leaves `HEALTH_HEARTBEAT_URL` out has no server check and no list to read here, and the other parts still apply.
The daily backup (`restore.md`) says only whether the owner's computer made its dump. **"building-qr server"** (the first
installation's name for it) is the server's own check. Open it and read its list of events, newest first: each ping has its
time and a short text. Read down to the last time the check was green. Its period is 1 day and its grace 3 hours (set on
05/10/2026): the daily summary keeps it green, so if no ping arrives for 27 hours the check goes down by itself and alerts, which
is how a server or a cron job that stopped altogether is noticed. The server sends two kinds of ping.

**The first server error of a building day**, at once, to the `/fail` address, so the check turns down and healthchecks.io
alerts the owner. The day is the building's (Asia/Jerusalem, midnight to midnight). Only the first error of a day sends it: the
later ones that day send nothing, but they are in `app_errors` (part c). The text is

```
First server error today, 05/10/2026 14:30: POST /scans/sync 57014
```

which is the time, the HTTP method, the route as it is written in the code, and the error's code: a Postgres SQLSTATE (`57014`
is a statement that the database cancelled for taking too long), a network code (`ECONNRESET`), or the name of the error's
class (`TypeError`). Never the message. A crash that the provider's app or the committee app reports counts as the first
error of the day too, and then the text is `First app error today, <time>: <screen key> <code> (build <build>)`, with a screen
key such as `provider:home`. An app keeps what it noted on the device and sends it after the next sign-in, when it starts,
and when it comes back to the screen (`src/ui/errorReport.js`), so an app's crash can arrive some time after it happened, and
a crash before sign-in only after the next sign-in. The other texts of this
ping, for a database that cannot be asked, are in "When the alert is about the database" below.

**The daily summary**, once a day, about 06:00 to 08:00 in the building's time: Vercel Cron starts the job at 04:00 UTC
(`vercel.json`), and the Hobby plan runs it at some point within that hour. It covers the 24 hours before it runs. It pings
the base address when the hours were fine and `/fail` when they held a technical problem. The first line says which, and
which hours:

```
Daily summary FAIL: 04/10/2026 06:02 to 05/10/2026 06:02
Why: server error, stuck phone
Server errors: 3 in 2 kinds: /admin/points/:id 57014 x2; /scans/sync ECONNRESET x1
Retention job: ran 05/10/2026 03:11 (sessions 0, login attempts 4, device labels 0, app errors 0, alert pings 0)
Phones: 1 stuck (visits waiting for more than 24 hours)
```

A quiet day is the first line (`Daily summary OK: ...`) and the retention line, which is always there. The `Why:` line is
only there for a `FAIL`. Every other line is there only when it has something to say, and a list names the 5 most frequent
kinds and says `(+N more kinds)` when there are more. The sections, and what each one does to the verdict (`server/summary.js`):

| Line | What it says | Fails the summary? |
|---|---|---|
| `Server errors` | Unexpected errors of the server (a 500), by route and code | Yes, any (`server error`) |
| `App errors` | What the provider app and the committee app reported, by source, kind, screen key, code and build | Yes for a crash or an uncaught error (`app crash or unhandled error`). A session that the server ended is only counted |
| `Refusals and slow requests` | Refusals and slow requests that were recorded, by source, kind, route and code | No |
| `Retention job` | `ran` with the time and the five counts, or `DID NOT RUN, no run in the last 26 hours` with the time of the last one | Yes when it did not run (`retention job did not run`) |
| `Visits not counted` | Visits that the server refused, by reason code (for example `point_inactive`, `not_assigned`) | No |
| `Phones` | `stuck`: an active phone with visits waiting whose oldest is more than 24 hours old, and how many of those uploaded in the period and are still stuck. `outdated`: phones on another build than the server's | Yes for a stuck phone (`stuck phone`). Outdated is information |
| `New provider phones`, `Committee sign-ins` | The count of the period and the median per day over the 14 days before. `SPIKE` when the count is at least 5 and more than 3 times that median | Yes for a spike (`sign-in spike`) |

`Retention job: DID NOT RUN` means the daily cleanup did not run in the last 26 hours: look in the Cron Jobs page of Vercel
(Settings, Cron Jobs) and check `CRON_SECRET` (`secrets.md`: a missing secret shows as a 401 there).

One more text: `Daily summary could not read the database, <time>: <code>`, sent to `/fail` when the summary could not read the
database at all. See "When the alert is about the database".

**How healthchecks.io alerts.** On a change of state, not on every ping. The first `/fail` turns the check down and alerts
once. Further `/fail` pings (the next errors, the next summary) find it already down, send no new alert, and stay in the event
list. A good ping turns it up again, and the next `/fail` alerts again. So a problem that repeats every day alerts once and
then only shows in the list: after an alert, keep reading the list (and parts b and c) for a day or two, because a second,
different problem in the same time sends no e-mail. A day with no summary ping at all is a signal too: the server or its cron
is down, or `HEALTH_HEARTBEAT_URL` is missing or wrong (`secrets.md`). The period and the grace time of the check decide
when healthchecks.io alerts for a missing ping.

### b. The committee app (`/admin`)

Three screens answer most questions without any query. They need only a working committee app.

- **Which phone is stuck, outdated or silent.** The ("נותני שירות") tab. On the card of a provider that has a phone signed in,
  the button ("מכשירים") opens a list of its phones (a provider with no phone signed in has no button). Per phone:
  ("ממתינות בטלפון") how many visits wait on the phone and since when (a stuck phone is one whose oldest waiting visit is more
  than 24 hours old, and the card then has a warning badge); ("דיווח אחרון") when the phone last reported about itself, or
  ("לא מדווח") when it never did (an old version of the app, or it has not reported yet); ("העלאה אחרונה מהתור") the last time
  it uploaded its queue; and ("גרסה") the build, with a ("ישנה") badge when it is not the server's. A stuck phone that has
  not uploaded for a long time is usually offline or its app was not opened: ask the provider to open it with a connection. A stuck
  phone that does upload but does not drain is one to hand to the agent.
- **Visits that were not counted.** The ("היסטוריה") tab, the field ("סוג"), the choice ("לא נקלטו"). It lists the visits that the
  server refused with a final answer (a point that is switched off, a person who is not assigned to it, a code that names nothing,
  data that could not be stored), with the reason and whether the visit came from the phone's queue. They are not attendance
  and are not in the Excel file. Use it when a provider says "I scanned, and it is not there".
- **Who changed what.** The ("ועד") tab, at the foot, the section ("יומן פעולות") (a button that opens it): every change that a
  member made, and the system's own daily cleanup, with the time and the member. The filters are the dates, the kind of action
  ("סוג פעולה") and the member ("חבר ועד"). Use it when something changed that nobody expected (a point switched off, a
  provider disabled, phones signed out, a scan cancelled), and to see that the daily cleanup ran (the kind ("ניקוי אוטומטי")).

### c. Two read-only queries in the Neon SQL editor of the production project

Only the owner opens the SQL editor of the **production** project, in his own browser (Neon console, the project, SQL Editor,
with the production branch and database selected). An agent never opens it: no agent reads production (`AGENTS.md`, Safety,
and ADR 0005). Paste **one query at a time** and run it. Both are `select` statements: they only read and change nothing.
The columns hold the safe fields only (no message, no name, no address), so the owner can copy the result to the agent.
Times are written in the building's time.

The last 24 hours of recorded events, added up by `source`, `kind`, `place` and `code` (the same grouping as the daily summary):

```sql
select source, kind, place, code,
       sum(count) as events,
       min(first_at) at time zone 'Asia/Jerusalem' as first_seen,
       max(last_at) at time zone 'Asia/Jerusalem' as last_seen
from app_errors
where last_at >= now() - interval '24 hours'
group by source, kind, place, code
order by events desc, last_seen desc;
```

One route's events, hour by hour, newest first. Replace the text between the quotes with a `place` from the first query (the route as
it is written in the code); change `3 days` to look further back (rows are kept for 90 days). `last_request_id` is the id for part d:

```sql
select bucket at time zone 'Asia/Jerusalem' as hour_start,
       source, kind, method, status, code, app_build as build,
       count as events,
       last_at at time zone 'Asia/Jerusalem' as last_seen,
       last_request_id
from app_errors
where place = '/scans/sync'
  and bucket >= now() - interval '3 days'
order by bucket desc, events desc;
```

How to read them. `events` counts events, not people or requests. `source` is `server` for the server's own errors and
`provider_app` or `committee_app` for what an app reported. An hour with no rows is not proof that nothing failed: when the
database cannot be reached nothing can be written, and while its connection pool is busy the recording is skipped on purpose,
so that recording never makes an overload worse (ADR 0007). An empty result next to a ping in healthchecks.io means exactly
that.

### d. Vercel's runtime logs, only when the problem is less than about an hour old

Vercel keeps them for about one hour. Older than that, there is nothing to find, and the answer is in parts a to c. Within the
hour, open the project in Vercel, **Logs**, and find the request by its id and not by guessing at the time:

- A 500 answer of the API carries the id: `{"error":{"code":"server_error","message":"Something went wrong","request_id":"..."}}`.
  The browser's developer tools show it (the response of the failed request in the Network tab).
- The latest request id of every row of `app_errors` is its `last_request_id` (the second query), so you can get the id of an
  error that nobody saw, as long as it is less than an hour old.
- Search for the id in Logs. If the whole value finds nothing, try the part after the last `::`.

The log line of an unexpected error starts with `unhandled API error:`, then the method and the route as it is written in the
code, the error's name, `code=` and the stack frames. By rule it never holds the message, the path that was asked for or
personal data (`server/router.js` writes it, and `tests/router-log.test.js` keeps it so; if a line does, that is a second
problem to fix). An answer in the 4xx range (a refusal that the rules intend, a wrong password) is never logged and never
recorded.

## When the alert is about the database

Some texts of the `/fail` ping mean that the server could not use its own database to decide what to say. The first four
below are written in `server/alerts.js`, each with the time after the first words (`<text>, DD/MM/YYYY HH:MM`). Each is sent at
most once an hour by each function instance of Vercel, because with no database there is nowhere to remember the day, so a
long outage can ping more than once an hour. And because the day was not remembered, the next error that finds the database
working sends `First server error today` as well, even on the same day: that is not a new problem.

- **`Database unreachable, <time>: <METHOD> <route>`** (no code in the line). The error was itself a failure to reach the database
  (a refused or reset connection, a database that is shutting down, a pool that waited too long for a connection), or the
  database did not answer in time when the server asked whether today was announced. For the first cause it is sent even if the
  first-error ping of the day already went. A failure to reach the database is not even tried as a record, so the error is
  usually not in `app_errors`, and this ping in the healthchecks.io list may be the only trace of the outage.
  1. Call `/api/health/db` (step 3). `200` means the database answers again, so it was short: a Neon compute that had been idle
     can take a few seconds to wake. Write down the time, and look at the next daily summary. `503` means it is still down.
  2. Open the Neon console (step 6): is the project and its compute running, is a limit reached (storage, compute hours), is
     there an outage notice? A limit is the owner's to fix in Neon. An outage of Neon is waited out: the code is not the cause,
     so there is nothing to roll back (unless it began with a deploy: step 4), and a restore is for damaged data, not for an
     outage (`restore.md`).
  3. Tell the committee (step 9). Expect a gap in `app_errors` for the same hours: that is the outage, not lost data.
- **`Server error, database busy, <time>: <METHOD> <route> <code>`**. The server did not ask the database at all: every connection
  of that function instance's pool was in use, and for the alert it never waits in the queue and never takes the last free
  connection. The error may well be a symptom of that very overload. The line does not say that it is the first error of the
  day, and the error itself was probably not recorded in `app_errors` either (recording is skipped while the pool is busy, the
  same rule), so the queries of part c can show fewer errors than happened.
  1. Call `/api/health/db`. A quick `200` means the burst has passed.
  2. In the Neon console look at the monitoring of the project (connections, CPU) and at the running queries: a slow query
     that holds connections is what fills the pool. Run the first query of part c for the same hours: a `57014` there is
     a statement that the database cancelled for taking too long.
  3. If it comes back on more than one day, hand it to the agent: it is a question of one slow query or of the size of the
     pool, not an emergency.
- **`Server error, alert record failed, <time>: <METHOD> <route> <code>`**. The database answered, but writing the day's row in
  `alert_pings` failed for a reason that is not a lost connection: the table is missing, a permission, or the statement was
  cancelled. The part after the time is the real server error, so treat it as a first error of the day as well.
  1. Call `/api/health/db`: `migration` must be the newest file in `db/migrations/`. If it is older, the migration did not run, or
     a restore removed it (`restore.md`): redeploy the production deployment from the Vercel dashboard so that the build
     migrates it (`deploy-and-rollback.md`, "A failed migration").
  2. If the migration is fine, give the agent the line and the result of the queries of part c.
- **`App error, database busy`, `App error, alert record failed`** (and `Database unreachable`) for an error that an app
  reported: the same causes and the same steps. The line has the screen key and the build instead of the method and the route.
- **`Daily summary could not read the database, <time>: <code>`**, from the daily summary (once a day, not throttled): the
  database was not readable at that moment (`<code>` is a Postgres SQLSTATE, a network code or an error class, never a
  message). The same steps apply, and the call itself ends with a 503.

## UptimeRobot: what it sees and what it does not

The first installation uses UptimeRobot (nothing in the code needs it: a copy can use the same service, any other monitor of
`/api/health`, or none). Its owner has two monitors in UptimeRobot, each every 5 minutes: a Keyword monitor on
`https://<your-domain>/api/health` that expects the text `"ok":true`, and an HTTP monitor on the home page. An alert goes by
e-mail and to the UptimeRobot app on the iPhone. There is no public status page. An alert from either monitor means that the
site or the function did not answer: start at step 2.

What it does **not** see, on purpose:

- **The database.** `/api/health` never touches the database (the smoke test and `/api/health/db` are for that), and the home
  page is a static file. So UptimeRobot stays green while the database is down, while a route fails with a 500, while a phone
  is stuck, and while the daily jobs do not run.
- A database outage therefore reaches the owner another way (where `HEALTH_HEARTBEAT_URL` is set): through the first-error
  ping of healthchecks.io, whose in-memory path ("Database unreachable" above) needs no database but does need a request that
  fails, so a night without traffic sends nothing; and through the daily summary the next morning, which fails when it cannot
  read the database. A `503` from `/api/health/db` sends no ping by itself.
- A `500` of a route, a stuck phone, a retention job that did not run and a spike of sign-ins reach him through healthchecks.io
  (parts a and b above), never through UptimeRobot.
