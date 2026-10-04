# Restore the production database

The production database is a Neon project. On the current plan Neon keeps history for only **6 hours**: a restore point
older than that does not exist. Act fast, and do not wait for the next morning.

A daily backup on the owner's computer reaches back further (30 days): see [Daily backups](#daily-backups) below. Neon's own
history is the faster way back, but it covers only the last 6 hours, so use it first when the damage is that recent.
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

## Daily backups

The free Neon plan restores only to a point in the last 6 hours, so a scheduled task on the owner's computer also makes a
dump of the database every day. The dumps stay on that computer: they hold personal data (the names of providers, their
check-ins, the e-mail addresses of the committee), so they never go to GitHub, in a pull request, an issue or a log.
`*.dump` is in `.gitignore` as a second net.

**What runs.** `scripts/backup-db.mjs` (`npm run db:backup`), once a day. It asks the Neon CLI for the direct connection
string of the production branch (kept in memory, never written down) and runs `pg_dump` in a read-only session: the server
refuses any write in it, so the backup cannot change production. This is the one sanctioned local read of production (see
ADR 0005). The dump goes into a temporary file in a private work directory in your own temp folder that belongs to this run
alone (see "Who can read them"), so two runs in the same minute never share a file. Then the file is checked twice: the table of contents (`pg_restore --list`) must name the data of `scans` and
`points`, and then a full read (`pg_restore --file=` to the null device, `NUL` on Windows and `/dev/null` elsewhere) must get
through every data block and exit with 0. The first check alone is not enough, because the table of contents is at the
start of the file and a dump that was cut off after it would pass. Only then is the file named
`building-qr-<UTC date and time>.dump` (a file of the same minute is replaced by it). A failed dump leaves no file behind.
It keeps the newest 30 dumps (`--keep`) and deletes older ones, and it never touches another file in the folder. One line
per run is added to `backup.log` in the same folder: the time (DD/MM/YYYY HH:MM), ok or failed, the masked host, the file
and its size, or a short error. It never holds the connection string, the user or the password.

**Where the files are.** A folder on the owner's computer, outside the repository, set with `--out` in the scheduled task.

**Who can read them.** Only the owner, because the dump holds attendance data.

- **A private work directory in your own temp folder.** Every run makes its own directory there (`bqr-work-<random>`, in
  `%TEMP%` on Windows, `$TMPDIR` or `/tmp` on macOS and Linux), with a name nobody can guess, and does all of its work in it:
  the dump is written there, both checks run there, and the mode or access list is set and checked there. Only then is the
  verified file moved into the backup folder, and the work directory is removed, whatever happened. It is deliberately **not**
  made inside the backup folder. Somebody who can write in the backup folder could add an access entry of their own to a
  directory made there (an inheritable one, which neither removing inheritance nor granting your account replaces) in the
  moment between its creation and the moment it is closed, or swap a file's path for a file of their own, because the program
  that dumps (`pg_dump`) opens a file by its path. The temp folder of your account can be written only by your account (on
  Windows it is inside your profile; on macOS and Linux the directory is made with mode 700 in one step), so none of that is
  possible there. At most somebody who can write in the backup folder can replace the finished file afterwards, and the data
  in it was never readable by them. A leftover work directory (a run that was killed) is only ever removed by hand: the
  script never touches the work directory of another run.
- **The backup folder must be on the same drive as the temp folder.** The finished file is moved with a rename, which keeps its
  mode and access list but works on one drive only. When the backup folder is on another drive the run fails with a message
  that says so (`EXDEV`), and nothing is kept. Put the backup folder on the drive of the temp folder (on Windows, the drive of
  your profile), or point `TEMP` (on macOS and Linux `TMPDIR`) of the scheduled task at a private folder on the drive of the
  backup folder. On many Linux systems `/tmp` is a separate disk (in memory): then set `TMPDIR`.
- **On macOS and Linux** the script sets the umask to 077 before it creates anything (`pg_dump` makes its file with the
  umask it inherits, which is often 022 and would let every account of the machine read it), makes the backup folder with
  mode 700, and sets mode 600 on every dump and on `backup.log`; the mode of the dump is read back, and a dump that others
  could still read is deleted and the backup fails. A folder that already exists is your choice and is never changed, but the
  script **refuses to run** (exit code 1, nothing is dumped, nothing is written there, not even the log: a log in such a
  folder could be made a link to another of your files, and the finished file could be replaced) when the group or others can
  write in it. Fix it with `chmod 700 <folder>`. When they can only read it, `backup.log` and the screen get a warning with
  the same advice, because the files in it are owner-only anyway and the others can see only their names.
- **On Windows** a new file or folder inherits the access list of its parent, so the script closes each thing itself, with
  `icacls`, as a second net inside the private temp folder: the work directory first (all inherited access removed, full
  control for your own account alone, inherited by what is made inside), then the empty temporary file in it the same way,
  then `pg_dump` overwrites that file in place (which keeps its list). The account is found by its SID with `whoami /user`,
  so a name with a space or in another alphabet does not matter. The rename into the backup folder keeps the list (checked on
  Windows 11), and `backup.log` gets the same list when it is created. If `icacls` is missing or fails, the backup stops
  before anything is dumped, `backup.log` says why, and nothing is rotated. You can look at the result with `icacls <file>`: it
  must list only your own account (the administrators and the system are not on the list either, on purpose). Windows has no
  refusal for a backup folder that others can write in, because the access list of a folder is not read there, so the choice
  of the folder matters more. The tools of Windows (`icacls`, and many others) cannot open a path of more than about 260
  characters, so the script refuses, before it makes anything, a backup folder or a temp folder whose paths would be longer
  than 245 characters (the names inside the work directory are short): use a short backup folder, such as
  `C:\backups\building-qr` or one directly under your profile.
- Choose a backup folder under your user profile (`C:\Users\<your name>`), and never a shared folder, a network drive or a folder
  that a service synchronises to the internet (for example OneDrive or Dropbox): a synchronisation client copies the file
  somewhere else, and no access list can stop that copy.

**What it needs on that computer.**

- The PostgreSQL 18 client tools (`pg_dump` and `pg_restore`; a version older than the server, which is Postgres 18, is
  refused by `pg_dump`). The script finds them through `--pg-bin`, then the `PG_BIN` variable, then on Windows
  `C:\Program Files\PostgreSQL\18\bin`, then `PATH`.
- The Neon CLI, signed in (`neon auth`) as a person who can see the project. Any other Postgres works too: set
  `BACKUP_DATABASE_URL` to its direct connection string (a host without `-pooler`, because `pg_dump` needs a session) and
  leave out `--neon-project`. Use one of the two, never both: when both are given the run stops (exit code 1, nothing is
  dumped) instead of letting one of them win, because a backup of the wrong database is worse than none.
- Optional: the GitHub CLI (`gh`), signed in. With `--report-issue <owner>/<repo>` a failed run opens an issue titled
  "Daily database backup failed", or, when an issue with exactly that title is already open, adds a comment to it (a
  failure that lasts a week is one issue, not seven). The issue and the comment say only that it failed and when: no path,
  no host and no error text, which can hold personal data. The details are in `backup.log`, where the line ends with
  `issue=opened` or `issue=commented-<number>`. If `gh` is missing or fails, the run only logs that.

**How to check that it works.**

- Open the last line of `backup.log` in the backup folder: it says `ok`, with a time from the last 24 hours, and a size that
  is not far from yesterday's. The newest file in the folder has the same name.
- Look inside a file: `pg_restore --list <file>` prints the table of contents. It must show lines such as
  `TABLE DATA public scans` and `TABLE DATA public points` (one `TABLE DATA` line for every table). To read every data
  block, as the script does, run `pg_restore --file=/dev/null <file>` (`--file=NUL` on Windows): it prints nothing and exits
  with 0 for a good file, and with an error such as "could not read from input file: end of file" for a cut one.
- A run by hand is the same command as the task (below). It prints one line with the file, its size and how many old files
  it removed, and exits with 1 on a failure.

**How to restore from a dump.** The dump is a copy of the whole database at one moment. Do it the careful way:

1. Make an empty target that is not production: a new empty database on a check branch (section 1 above), or in a new Neon
   project. With the Neon CLI:

   ```
   neon databases create --project-id <project id> --branch <check branch> --name restore_check
   neon connection-string <check branch> --project-id <project id> --database-name restore_check
   ```

   The second command prints the direct connection string of the empty database (the host, the role, the password and the
   database name are the parts of it). It is a secret: keep it in memory or in a file outside the repository, and never in a
   chat, an issue or a pull request. The database is empty on purpose: `pg_restore` makes the tables itself.
2. Restore the dump into it with the same version of the tools (18 or newer). Put the values of the target in the
   environment of this one terminal window, and give `pg_restore` only the name of the database (this is how the drill below
   ran, and it keeps the password out of the arguments of the program, which other users of a machine can see):

   ```
   export PGHOST=<host> PGPORT=5432 PGUSER=<role> PGPASSWORD=<password> PGSSLMODE=require
   pg_restore --no-owner --no-privileges --exit-on-error --dbname restore_check <file>
   ```

   In PowerShell set each variable the same way, `$env:PGHOST = '<host>'`, `$env:PGPORT = '5432'` and so on, then run the
   same `pg_restore` line. Close the window afterwards.

   `--exit-on-error` stops at the first error instead of leaving a half restored copy. `--no-owner` and `--no-privileges`
   make the tables belong to the role you connect with. `--dbname` is required: without it `pg_restore` prints the SQL to
   the screen and restores nothing. When all is well it prints nothing and exits with 0 (the drill below took about 16
   seconds for a small database, most of it the network). For a one-off by hand `--dbname` also accepts the whole
   connection string, but then the password is part of the command line.
3. Check the copy with the queries of step 2 above (the counts of `scans`, `points` and `providers`, and `max(received_at)` of
   `scans`, which tells you how far the dump goes). Compare them with what you expect and with production now. The copy
   carries the marker of `public.environment_marker` with it (`production` for a dump of production), so the local tools of
   this repository refuse to run against a copy of production, on purpose.
4. Only then recover: copy the rows that are missing from the checked copy into production (step 3 above, "Copy rows back").
   Never restore a dump over production without first restoring it to a separate database and checking it (steps 1 to 3):
   a restore replaces data, and the wrong dump cannot be undone.
5. Delete the check database when you are done (it holds personal data):
   `neon databases delete restore_check --project-id <project id> --branch <check branch>`, and the check branch or project
   with it.

**How to set the task on Windows.** Use Task Scheduler. It runs only when the user is signed in, so no password is stored.
With PowerShell (the placeholders are `<repo>` for the folder of this repository, `<out dir>` for the backup folder,
`<project id>` for the Neon project id, and `<owner>/<repo-name>` for the GitHub repository; `where node` prints the path
of `node.exe`):

```
$action = New-ScheduledTaskAction -Execute '<path of node.exe>' -WorkingDirectory '<repo>' -Argument 'scripts\backup-db.mjs --out "<out dir>" --neon-project <project id> --report-issue <owner>/<repo-name>'
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'Building QR daily backup' -Action $action -Trigger $trigger -Settings $settings
```

`-StartWhenAvailable` is "Run task as soon as possible after a scheduled start is missed", so a computer that was off at 03:00
makes the backup when it is next on. Without `-User` and `-Password` the task runs as the signed-in user, only while that user
is signed in. In the Task Scheduler window the same settings are on the **Settings** tab and under **Security options**
("Run only when user is logged on"). Run the task once by hand from the window and read `backup.log` before you rely on it.

**On macOS or Linux** a cron line does the same (`crontab -e`). Cron has a short `PATH`, so use full paths, or set `PATH` at
the top of the crontab so that `node`, `neon`, `pg_dump` and `gh` are found:

```
0 3 * * * cd <repo> && node scripts/backup-db.mjs --out "<out dir>" --neon-project <project id> --report-issue <owner>/<repo-name>
```

Keep the backup folder somewhere that is itself protected (a disk with encryption, and a copy on another disk that you control
if you want to survive the loss of this one): the dumps are as sensitive as the database.

## Drill log

A restore that was never tried is a hope, not a plan. Repeat the drill every few months, and after any change to the
database setup (a new Neon project, plan or region, or a change of the production branch). Add one entry here each time,
with no connection string, project id or personal data in it.

- `03/10/2026`: restore drill on the production project with the Neon CLI. A branch of production as of one hour earlier
  (`neon branches create --project-id <id> --name restore-drill-<date> --parent <ISO timestamp> --expires-at <ISO timestamp> --no-secrets`)
  was created in 2.5 s, and its data was readable after 10 s. The whole drill, including deleting the branch, took 15 s.
  The row counts of the main tables on the branch equal production's. The marker said production and the newest migration
  was 005.
- `03/10/2026`: restore from a daily dump into an empty database, on the non-production project only. A fresh dump from
  `npm run db:backup` was restored with `pg_restore --no-owner --no-privileges --exit-on-error` (the connection in `PG...`
  variables) into a new empty database made with `neon databases create`: 12 tables, counts equal, no error, restore took
  15.5 s. That database holds almost no rows (only `schema_migrations` and `environment_marker`), so the drill was repeated
  with a scratch source database with sample rows (fake data, 1500 scans): 12 tables, counts and a content hash of every
  table equal, sequences, both triggers and the view equal, the append-only trigger still refused an edit of a scan, restore
  took 16.2 s. All scratch databases and files were deleted afterwards. The steps worked as written; the runbook now names
  `--exit-on-error`, the `PG...` form and the Neon CLI commands that the drill used. Still to do: a drill with a dump of
  production, onto a check branch.
