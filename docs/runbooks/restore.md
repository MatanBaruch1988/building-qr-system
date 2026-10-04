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
ADR 0005). The dump goes into a temporary file in a private work directory inside the backup folder that belongs to this run
alone (see "Who can read them"), so two runs in the same minute never share a file. Then the file is checked three times: the
table of contents (`pg_restore --list`) must name the data of `scans` and `points`; a full read (`pg_restore --file=` to the
null device, `NUL` on Windows and `/dev/null` elsewhere) must get through every data block and exit with 0 (the first check
alone is not enough, because the table of contents is at the start of the file and a dump that was cut off after it would
pass); and the marker must say production: the table `public.environment_marker`, which every production database has (the
production build of the first deploy sets it, and the local tools read it to refuse production), is read out of the dump
itself with `pg_restore --data-only --table=environment_marker`, and must hold a row `production`. A dump of a database that
does not say so (the wrong project or branch, a stale `BACKUP_DATABASE_URL`) would pass the first two checks and be kept as
a good backup, and the retention could then rotate the real production dumps away over the following days, so such a dump is
not kept and nothing is rotated: the run fails (exit code 1, a line in `backup.log`, an issue with `--report-issue`) with a
message that says what the marker holds (`missing`, `empty` or `says "nonprod"`) and to check `--neon-project`,
`--neon-branch` and `BACKUP_DATABASE_URL`; the project, the host and the connection string are never in it. Only after the
three checks is the file named `building-qr-<UTC date and time>.dump` (a file of the same minute is replaced by it). A failed
dump leaves no file behind.
It keeps the newest 30 dumps (`--keep`) and deletes older ones, and it never touches another file in the folder. "Newest"
is decided by the UTC time in the file names, for all the dumps together, whichever run finishes last: a run that started
earlier and finishes after a newer one never deletes the newer dump. When its own dump is older than the ones that are
kept, it removes its own dump instead, ends with 0 and writes `warning=own-dump-older-than-kept` in `backup.log` (a newer
verified dump exists). A file whose name says a time later than now (a clock that was wrong once) is not counted and not
deleted, and the log says `backups-dated-in-the-future-ignored`; delete such a file by hand. One line
per run is added to `backup.log` in the same folder: the time (DD/MM/YYYY HH:MM), ok or failed, the masked host, the file
and its size, or a short error (and `stale-work-folders-removed=N` when the run cleared work folders that a crashed run left,
see below). It never holds the connection string, the user or the password.

**Where the files are.** A folder on the owner's computer, outside the repository, set with `--out` in the scheduled task.

**Who can read them.** Only the owner, because the dump holds attendance data.

- **The backup folder, and every folder above it, must not be changeable by another account. This is the only folder rule.**
  Every check of a path before the path is used has a short gap in which an account that can write in that folder could
  rename a directory away and put its own at the same path, swap a file for a link, or add an access entry of its own. So the
  script does not try to win those races one by one: before it makes anything, it looks at the backup folder and at every
  folder above it up to the root, and it stops (exit code 1, nothing made, nothing dumped, nothing rotated) when another
  account can change one of them. On Windows it reads the access lists as SDDL (with SIDs, so the language of Windows does
  not matter) with one `powershell.exe` call (`Get-Acl`, the paths in an environment variable, a few tenths of a second in
  all), and trusts only your own account, the system (`S-1-5-18`), the administrators (`S-1-5-32-544`) and TrustedInstaller.
  For the backup folder itself, an allow entry for any other account that gives add file, add subfolder, delete a child,
  delete, change the permissions, take ownership, or generic write or all (also through an alias such as `FA`, `FW`, `GA`,
  `GW`, `WD`, `WO` or `SD`) refuses the run; for the folders above it the same, except add file and add subfolder (the root
  of the system drive lets every signed-in account create a folder, and that is fine). An entry that only applies to what is
  made inside (inherit-only) and a deny entry are ignored. A folder owned by another account is refused. An access list that
  cannot be read, or has an entry that is not understood (a conditional one), is refused too: nothing that is not understood
  is trusted. On Linux every folder of the chain, the backup folder and each folder above it, must be owned by you or
  by root (an owner can rename or delete anything in a folder, and so can the owner of a sticky folder: the sticky bit only
  protects a file from the others), and no folder above the backup folder may be writable by the group or by others unless it
  has the sticky bit and is owned by you or root (as `/tmp` is: nobody can rename or delete what they do not own), because a
  member of the group could rename the whole subtree, and the members are not known; and the backup folder itself must not be
  writable by the group or others (see the next item but one). A home folder with mode 775 (some older Linux setups give every user a private group and that mode)
  is therefore refused: tighten it with `chmod g-w ~`. If the backup folder does not exist yet, the nearest folder that exists
  is judged in its place, and the check is made again, on the real chain, right after the run has made the new folders and
  before it does anything else: a new folder can inherit an entry for another account (or a default ACL can widen its mode) that
  the parent's own list does not show. A new folder that is refused is removed again (only the folders that this run made, and
  only while they are empty). The run never makes a folder inside a folder that other accounts can write in (on Linux the group
  or others, sticky or not, so not directly in `/tmp`; on Windows the nearest existing folder must pass the rights of the folder
  itself): another account could put a link at that name between the look and the mkdir, and `mkdir -p` says nothing about an
  existing link. Make the backup folder in your own home folder or profile. After the mkdir the run looks at what it made once
  more (each new folder is a real directory and not a link, and the folder resolves to the same path as before) and refuses
  anything else, removing only what it made. An existing folder of yours under `/tmp` is not affected: nothing is made there.
  **The folders that are judged are the real ones**: `--out` is resolved first (symbolic links, on
  Windows also junctions and short names), and the check, the work directory, `backup.log` and the rename all use the resolved
  path, so a link cannot make the check look at other folders than the ones that hold the files. A link that points at nothing,
  or a part of the path that cannot be inspected, is refused. The message says whether it is the backup folder itself or a folder above it,
  never an account or a path, and what to do: use a backup folder in your own profile. When this refuses the run,
  `backup.log` is not written (the screen says so), and `--report-issue` still opens its issue. **The scheduled task needs
  nothing about `TEMP` or `TMPDIR`**: the script does not use the temp folder at all, so a shared temp folder (for example one
  where another account has an explicit Modify entry) changes nothing. The checks below stay as a second net (the work
  directory's access list read back, the two looks at `backup.log`, the mode checks), and the races that they cover need write
  access to the backup folder or to a folder above it, which this check refuses.
- **A private work directory inside the backup folder.** Every run makes its own directory there, after the check above and
  after the folder exists (`.bqr-work-<random>`, a name nobody can guess, hidden on Linux), and does all of its work
  in it: the dump is written there, the checks run there, and the mode or access list is set and checked there. Only then is
  the verified file moved into the backup folder with a rename (on the same volume, so it cannot fail for that reason), and
  the work directory is removed, whatever happened. It inherits the access list of the backup folder, which only the trusted
  accounts can change (on Linux it is made with mode 700 in one step), and nobody else can add an access entry of
  their own to it or swap its path, because that needs write access to the backup folder. A work directory is a directory,
  and retention only ever touches files with the exact name of a backup, so it is never counted, rotated or deleted by
  retention.
- **Work folders that a killed run left behind are removed by the next run.** At the start of a run, after the checks, every
  directory in the backup folder whose name is exactly `.bqr-work-` and six letters or digits, and that was last changed more
  than 24 hours ago, is removed with what is in it. Younger ones are left alone, because another run may be using one, and so
  is everything else: a file, a link, any other name, any backup. `backup.log` says how many were removed
  (`stale-work-folders-removed=N`, never a path); a folder that cannot be removed is a warning
  (`N-stale-work-folders-not-removed`) and the run goes on.
- **On Linux** the script sets the umask to 077 before it creates anything (`pg_dump` makes its file with the
  umask it inherits, which is often 022 and would let every account of the machine read it), makes the backup folder with
  mode 700, and sets mode 600 on every dump and on `backup.log`; the mode of the dump is read back, and a dump that others
  could still read is deleted and the backup fails. A folder that already exists is your choice and is never changed, but the
  script **refuses to run** (exit code 1, nothing is dumped, nothing is written there, not even the log: a log in such a
  folder could be made a link to another of your files, and the finished file could be replaced) when the group or others can
  write in it. Fix it with `chmod 700 <folder>`. When they can only read it, `backup.log` and the screen get a warning with
  the same advice, because the files in it are owner-only anyway and the others can see only their names.
- **On Windows** a new file or folder inherits the access list of its parent, so the script closes each thing itself, with
  `icacls`, as a second net inside the checked backup folder: the work directory first (all inherited access removed, full
  control for your own account alone, inherited by what is made inside), then the empty temporary file in it the same way,
  then `pg_dump` overwrites that file in place (which keeps its list). Right after the first call the list of the work
  directory is read back (`icacls <dir>`), and the run stops, before anything is written into the directory, unless it is
  exactly one entry: yours, full control, inherited by what is inside (`(OI)(CI)(F)`). Another entry, an inherited one or a
  deny stops it. This catches an entry that another account added to the directory in the moment before its list was set,
  which neither removing inheritance nor granting your account removes (it could only happen if another account can write in
  the backup folder, which the check above refuses). The account is found by its SID with `whoami /user`,
  so a name with a space or in another alphabet does not matter. The rename into the backup folder keeps the list (checked on
  Windows 11), and `backup.log` gets the same list when it is created. If `icacls` is missing or fails, the backup stops
  before anything is dumped, `backup.log` says why, and nothing is rotated. You can look at the result with `icacls <file>`: it
  must list only your own account (the administrators and the system are not on the list either, on purpose). The tools of
  Windows (`icacls`, and many others) cannot open a path of more than about 260 characters, so the script refuses, before it
  makes anything, a backup folder whose paths would be longer than 245 characters (the names inside the work directory are
  short): use a short backup folder, such as
  `C:\backups\building-qr` or one directly under your profile.
- **`backup.log` must be a plain file with one name.** Before anything is dumped, and again right before the line is added,
  the script checks (without following a link) that an existing `backup.log` is a regular file and has no other name. A
  symbolic link or another reparse point, or a hard link, which an account that can write in the backup folder could plant
  so that an append goes to another of your files, makes the run stop (exit code 1, nothing dumped, nothing written): delete
  the file, or move it away, and run again.
- Choose a backup folder under your user profile (`C:\Users\<your name>`), and never a shared folder, a network drive or a folder
  that a service synchronises to the internet (for example OneDrive or Dropbox): a synchronisation client copies the file
  somewhere else, and no access list can stop that copy.

**What it needs on that computer.**

- **Windows or Linux.** Any other system, macOS included, is refused before anything is made (exit code 1, the message says
  that the backup runs on Windows and Linux). The folder checks read what Windows and Linux report. On Linux a POSIX ACL
  cannot hide write access from them: with an extended ACL the group bits of the mode are the ACL mask (`acl(5)`), and a
  named entry only gives what the mask also holds, so an entry that lets another account write makes the folder look
  group-writable and it is refused; the files are made with modes 700 and 600 and the dump gets `chmod 600`, so the mask of
  a new object is empty and an inherited default ACL gives nobody access. A file system with its own ACLs (NFSv4, SMB) is
  not covered: use a local folder. macOS has extended ACLs that the mode does not show, and nobody can run or test that code
  here (no Mac, and CI is Linux), so it is refused until it can be added with a Mac to test it on.

- The PostgreSQL 18 client tools (`pg_dump` and `pg_restore`; a version older than the server, which is Postgres 18, is
  refused by `pg_dump`). The script finds them through `--pg-bin`, then the `PG_BIN` variable, then on Windows
  `C:\Program Files\PostgreSQL\18\bin`, then `PATH`.
- The Neon CLI, signed in (`neon auth`) as a person who can see the project. Any other Postgres works too: set
  `BACKUP_DATABASE_URL` to its direct connection string (a host without `-pooler`, because `pg_dump` needs a session) and
  leave out `--neon-project`. Never type the string in a command (`export BACKUP_DATABASE_URL=postgres://...`, or the
  variable in front of `node`): the shell history keeps it (see "Why no secret is typed in a command" below). Put it in the
  variable from a prompt that is not recorded. In bash:
  `read -rs -p 'Connection string: ' BACKUP_DATABASE_URL; export BACKUP_DATABASE_URL`. In zsh:
  `read -rs 'BACKUP_DATABASE_URL?Connection string: '; export BACKUP_DATABASE_URL`. In PowerShell:
  `$env:BACKUP_DATABASE_URL = [System.Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Connection string')).Password`.
  A scheduled task cannot answer a prompt, so for the daily task use the Neon CLI, which needs no string. That database must carry the marker `production` (see "What runs"); a database that was never
  deployed to production by this project has none, and the backup refuses it until the table
  `public.environment_marker (environment text)` holds a row `production`. Use one of the two, never both: when both are given the run stops (exit code 1, nothing is
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
  with 0 for a good file, and with an error such as "could not read from input file: end of file" for a cut one. The marker
  is read with `pg_restore --data-only --schema=public --table=environment_marker --file=- <file>`: the output must have a
  `COPY public.environment_marker (environment) FROM stdin;` block with the line `production` in it.
- A run by hand is the same command as the task (below). It prints one line with the file, its size and how many old files
  it removed, and exits with 1 on a failure.

**How to restore from a dump.** The dump is a copy of the whole database at one moment. Do it the careful way.

**Why no secret is typed in a command.** Whatever is typed in a command is recorded: in the history file of bash or zsh, and in
the history file of PowerShell (PSReadLine, `ConsoleHost_history.txt`), where it stays after the window is closed, unprotected,
and in a backup of the profile; and while a program runs, its arguments are visible to the other users of the machine. The
steps below therefore never type a password. The Neon CLI prints the connection string, and the lines below take it into
variables without showing it; the history keeps only the lines themselves, which hold no secret. Where a password has to be
typed (a Postgres that is not on Neon), it goes into a prompt that is not recorded.

The steps:

1. Make an empty target that is not production: a new empty database on a check branch (section 1 above), or in a new Neon
   project. With the Neon CLI:

   ```
   neon databases create --project-id <project id> --branch <check branch> --name restore_check
   ```

   The database is empty on purpose: `pg_restore` makes the tables itself.
2. Put the connection of that database in the environment of this one terminal window. The direct connection string of the
   empty database holds the host, the role, the password and the database name. It is a secret: it goes into variables in
   memory (never into a command you type, a file in the repository, a chat, an issue or a pull request).

   In bash or zsh:

   ```
   url=$(neon connection-string <check branch> --project-id <project id> --database-name restore_check)
   rest=${url#*://}; auth=${rest%%@*}; hostdb=${rest#*@}
   export PGUSER=${auth%%:*} PGPASSWORD=${auth#*:} PGHOST=${hostdb%%/*} PGPORT=5432 PGSSLMODE=require
   unset url rest auth hostdb
   ```

   In PowerShell (`neon.cmd` and not `neon`: the `.ps1` shim that npm makes can be blocked by the execution policy):

   ```
   $url = neon.cmd connection-string <check branch> --project-id <project id> --database-name restore_check
   $u = [Uri]$url
   $login = $u.UserInfo.Split(':', 2)
   $env:PGUSER = [Uri]::UnescapeDataString($login[0])
   $env:PGPASSWORD = [Uri]::UnescapeDataString($login[1])
   $env:PGHOST = $u.Host; $env:PGPORT = '5432'; $env:PGSSLMODE = 'require'
   Remove-Variable url, u, login
   ```

   A generated Neon password is made of letters and digits, so the bash lines need no decoding (the PowerShell lines decode it
   anyway, which does no harm). If you must type a password (a Postgres that is not on Neon), set the other variables with ordinary commands, they
   are not secrets (`PGHOST`, `PGPORT`, `PGUSER`, `PGSSLMODE`), and take the password at a prompt that is not recorded: in
   bash `read -rs -p 'Password: ' PGPASSWORD; export PGPASSWORD` (in zsh `read -rs 'PGPASSWORD?Password: '; export PGPASSWORD`),
   in PowerShell `$env:PGPASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Password')).Password`.
   The secure string is turned into text only in memory, for the variable.
3. Restore the dump into it with the same version of the tools (18 or newer), giving `pg_restore` only the name of the
   database (this is how the drill below ran, and it keeps the password out of the arguments of the program):

   ```
   pg_restore --no-owner --no-privileges --exit-on-error --dbname restore_check <file>
   ```

   Close the window afterwards: the variables go with it. `--exit-on-error` stops at the first error instead of leaving a half
   restored copy. `--no-owner` and `--no-privileges` make the tables belong to the role you connect with. `--dbname` is
   required: without it `pg_restore` prints the SQL to the screen and restores nothing. When all is well it prints nothing and
   exits with 0 (the drill below took about 16 seconds for a small database, most of it the network). Do not pass the whole
   connection string to `--dbname`: it would be a command with the password in it, in the history and in the arguments.
4. Check the copy with the queries of step 2 above (the counts of `scans`, `points` and `providers`, and `max(received_at)` of
   `scans`, which tells you how far the dump goes). Compare them with what you expect and with production now. The copy
   carries the marker of `public.environment_marker` with it (`production` for a dump of production), so the local tools of
   this repository refuse to run against a copy of production, on purpose.
5. Only then recover: copy the rows that are missing from the checked copy into production (step 3 above, "Copy rows back").
   Never restore a dump over production without first restoring it to a separate database and checking it (steps 1 to 4):
   a restore replaces data, and the wrong dump cannot be undone.
6. Delete the check database when you are done (it holds personal data):
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
If the run is refused because another account can change the backup folder or a folder above it (the first item of "Who can
read them"), the backup folder must move into your own profile. Nothing about `TEMP` is needed.

**On Linux** a cron line does the same (`crontab -e`). Cron has a short `PATH`, so use full paths, or set `PATH` at
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
