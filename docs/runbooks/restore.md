# Restore the production database

The production database is a Neon project. On the current plan Neon keeps history for only **6 hours**: a restore point
older than that does not exist. Act fast, and do not wait for the next morning.

A daily backup on the owner's computer is planned (a later pull request). Until then, the 6 hour window is all there is.
The short page for the owner is [something-broke.md](something-broke.md); the general checklist is
[incident.md](incident.md).

## Before anything else

- Stop making it worse: if the app is writing bad data, roll the code back first (`deploy-and-rollback.md`).
- Write down the time of the last good moment (as exactly as you can) and the time now. The restore point must be inside the
  last 6 hours and before the damage.
- Do not restore over production in a hurry. First make a copy, look at it, then decide.

## 1. Make a branch of production at a point in time

A Neon branch is a copy of the data at a moment, made in seconds and without touching production.

- Neon console: the project, **Branches**, the production branch, **Create branch**, choose **Past data** (a point in time),
  and pick the time inside the window.
- Neon CLI: `neon branches create` with the production branch as the parent and a timestamp. The exact flags differ
  between CLI versions, so check them first with `neon branches create --help`.

Name the branch so that it is clear what it is, for example `restore-check`. Its connection string is a secret: keep it in a
file, never in a chat, an issue or a pull request.

## 2. Check the copy

Connect to the branch (the Neon SQL editor is enough) and compare it with what you expect:

```sql
select count(*) from scans;
select count(*) from points;
select count(*) from providers;
select max(received_at) from scans;
```

Also look at `point_providers`, `provider_devices`, `admins`, `api_keys` and `audit_log` when they are part of the damage.
`max(received_at)` of `scans` tells you how far the copy goes. Compare the counts with production now.

## 3. Choose how to recover

- **Restore the main branch from that point** (Neon console, the production branch, **Restore**, from the point in time).
  Everything written after that point is lost, on every table. Use it when most of the data is wrong. Neon keeps the state
  from just before the restore as a backup branch for a short time: note its name.
- **Copy rows back** from the branch into production, with `insert ... select` through a connection to both, or with a
  `psql` dump of the missing rows. Use it when only some rows are gone (a deleted point, a deleted scan). Scans are
  append-only, so a missing scan can be put back as it was.

After a restore, call `/api/health/db` with an agent key (see `incident.md`) and look at a few screens of `/admin`.
Check in the Neon SQL editor that `public.environment_marker` still says `production` (the marker is part of the data,
so a restore from before it was created removes it: the next deploy marks the database again).

## 4. Afterwards

Delete the check branch when you are done (it holds personal data). Then write the short note described in `incident.md`.

## Drill log

A restore that was never tried is a hope, not a plan. Repeat the drill every few months, and after any change to the
database setup (a new Neon project, plan or region, or a change of the production branch). Add one entry here each time,
with no connection string, project id or personal data in it.

- `03/10/2026`: restore drill on the production project with the Neon CLI. A branch of production as of one hour earlier
  (`neon branches create --project-id <id> --name restore-drill-<date> --parent <ISO timestamp> --expires-at <ISO timestamp> --no-secrets`)
  was created in 2.5 s, and its data was readable after 10 s. The whole drill, including deleting the branch, took 15 s.
  The row counts of the main tables on the branch equal production's. The marker said production and the newest migration
  was 005.
