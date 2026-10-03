// Daily backup of the database to a folder on this machine (see docs/runbooks/restore.md, section "Daily backups").
//
// Usage:
//   npm run db:backup -- --out <dir> --neon-project <project id> [--neon-branch main] [--keep 30]
//                        [--report-issue <owner/repo>] [--pg-bin <dir>]
//   BACKUP_DATABASE_URL=<direct connection string> npm run db:backup -- --out <dir>
//
// Why this exists: on the free Neon plan the database can only be restored to a point in the last 6 hours. A dump on the
// owner's own computer reaches back as far as the files are kept, and it holds personal data, so it never goes to GitHub:
// the folder is outside the repository, `*.dump` is in .gitignore, and nothing here prints or stores the connection string.
//
// What one run does:
//   1. Gets the DIRECT connection string (never the pooled one: pg_dump needs a session) from BACKUP_DATABASE_URL, or from
//      the Neon CLI (`neon connection-string`) when --neon-project is given. It lives in memory only.
//   2. Makes this run's private WORK DIRECTORY inside the folder (`.bqr-<pid>-<random>`), created exclusively and closed
//      to every other account before anything is written into it, and runs pg_dump (custom format) into a temporary file
//      there (`partial.dump`, created empty and exclusively before pg_dump starts). Two runs, in the same minute or at the
//      same time, never share a directory or a file, and another account that can write in the output folder cannot put
//      its own file where pg_dump writes, because it cannot enter the directory (the
//      path of a file is what pg_dump opens, so closing the file alone would not be enough). The password goes to pg_dump
//      through the environment (PGPASSWORD and friends), never on the command line, where other users of a machine can see
//      it. The session is READ-ONLY on the server (`-c default_transaction_read_only=on` in PGOPTIONS), so the backup cannot
//      write to the database it reads, and that is what makes it safe to point at production. It is the one sanctioned local
//      READ of a deployment's database, next to `db:create-admin`, the one sanctioned write (AGENTS.md "Safety", ADR 0005).
//      It does not use the production guard (server/dbGuard.js): reading production is its job.
//   3. Checks the file twice, in the work directory. `pg_restore --list` prints the table of contents, which must name the
//      data of the tables `scans` and `points`; but it does not read the data blocks, so a dump that was cut off after its
//      table of contents would pass. A full read (`pg_restore --file=<the null device>`) writes the SQL of the whole archive
//      to nowhere, which reads and decompresses every data block, and must exit with 0. Then the mode is set and read back
//      (macOS and Linux). Only then is the verified, owner-only file renamed (one volume, so its mode and access list stay)
//      from the work directory to building-qr-<UTC time>.dump in the folder; a file of the same name from a run of the same
//      minute is replaced by this verified one. The work directory is removed at the end, whatever happened, and nothing in
//      it survives: another account can at most replace the FINAL file after the fact, and the data in it was never readable
//      by that account.
//   4. Keeps the newest --keep files that match that exact name and deletes the older ones. Any other file in the folder is
//      left alone, and nothing is rotated after a failed backup.
//   5. Appends one line to backup.log in the folder (the time, ok or failed, the masked host, the file and its size, or a
//      short error) and prints a summary. It never writes the URL, the user or the password, and every message is cleaned
//      of them first.
//
// Who can read the files: only the owner, because the dump holds attendance data. On macOS and Linux the script sets the
// umask to 077 before it creates anything (pg_dump creates its file with the umask it inherits, which is often 022, so the
// file would be readable by every account of the machine), makes the folder with mode 700 and the work directory with mode
// 700, and sets mode 600 on every dump and on backup.log. The mode of the finished dump is READ BACK (stat), and a dump
// that is still readable by others (chmod failed, or the file system ignores modes) is deleted and the backup fails; a new
// backup.log is checked the same way, but only as a warning. A folder that already exists is the user's choice and is never
// changed, but the run REFUSES to start (exit 1, nothing is dumped, and no log is written there, because a log in such a
// folder could be a link to another file of the owner) when group or others can WRITE in it, and warns (in backup.log and
// on the screen) when they can only read it, because the files in it are owner-only anyway.
//
// On Windows a new file inherits the access list of its folder, and a shared, network or synced folder may let others
// in. So the work directory gets an owner-only access list with icacls before anything is written into it (inheritance
// removed, full control for the SID of the current user, found with `whoami /user`, inherited by what is made inside), and
// the empty temporary file gets one of its own. pg_dump then overwrites the file in place, which keeps the access list,
// and so does the rename out of the work directory. If whoami and the user name both fail, or icacls is missing or fails,
// the backup fails before pg_dump writes anything. backup.log gets the same treatment when it is created (best effort: it
// holds no personal data, so a failure there is only a warning). Windows has no refusal for a writable folder (the
// access list of a folder is not read here): choose a folder under the user profile and never a shared or a synced one. A
// sync client copies the file somewhere else, and no access list can stop that. The tools of Windows cannot open a path of
// more than about 260 characters, so on Windows the run refuses a folder whose paths would go over 245 (the names inside
// the work directory are short, and never make a path longer than the final file's).
//
// On a failure, with --report-issue, it opens a GitHub issue with the gh CLI, or adds a comment to the issue with that
// title that is already open (so a failure that lasts a week is one issue, not seven). The issue says only that the backup
// failed and when: no path (it holds a person's name), no host and no error text. The details stay in backup.log. Exit
// code 1 on any failure, 0 on success. Node built-ins only, so there is no install step for a machine that only runs this.
//
// pg_dump must not be older than the server (Neon runs Postgres 18). --pg-bin, then PG_BIN, then on Windows the usual
// install folder of Postgres 18, then PATH, in that order.
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { maskDatabaseHost } from '../server/dbGuard.js'
import { formatDateTime, formatDateTimeUtc } from '../shared/datetime.js'
import { isMain } from './ci-git.mjs'

export const DEFAULT_KEEP = 30
export const DEFAULT_NEON_BRANCH = 'main'
export const LOG_NAME = 'backup.log'
export const ISSUE_TITLE = 'Daily database backup failed'
// The tables that a dump must hold the data of, or it is not a backup of this app.
export const REQUIRED_TABLES = ['scans', 'points']
// The exact name of a finished backup. Retention only ever touches files that match all of it, so a note, a copy or a
// folder that somebody put next to the backups is safe. The time is in the name (and sorts) on purpose: it is a machine
// name, not a date that a person reads.
export const BACKUP_NAME = /^building-qr-\d{8}T\d{4}Z\.dump$/
export const WINDOWS_PG_BIN = 'C:\\Program Files\\PostgreSQL\\18\\bin'
// The line that backup.log and the screen get when the backup folder was there already and other users can read it.
export const FOLDER_WARNING =
  'the backup folder can be read by other users (the files in it are owner-only, so they see only the names): tighten it (on macOS and Linux run chmod 700 on the folder)'
// A folder that group or others can WRITE in is refused (see runBackup): they could swap a path for a file of their own.
export const FOLDER_WRITABLE_ERROR =
  'the backup folder can be written by other users (group or others), so nothing was dumped: tighten it (on macOS and Linux run chmod 700 on the folder)'
export const FOLDER_UNKNOWN_ERROR = 'the backup folder could not be inspected, so nothing was dumped'
// icacls and the other tools of Windows cannot open a path longer than MAX_PATH (260 characters, 248 for a working directory),
// where Node itself can. The run refuses a folder whose paths would go over this, instead of failing later with "path not found".
export const WINDOWS_PATH_LIMIT = 245
export const PATH_TOO_LONG_ERROR =
  'the path of the backup folder is too long for the tools of Windows (more than 245 characters with the names inside it): use a shorter folder'
export const LOG_SKIPPED = 'backup: backup.log was not written, because other users can write in the backup folder'

const NEON_TIMEOUT_MS = 2 * 60_000
const DUMP_TIMEOUT_MS = 30 * 60_000
const LIST_TIMEOUT_MS = 5 * 60_000
// Reading a dump to the end takes about as long as it takes to decompress it, so it gets as long as the dump itself.
const READ_TIMEOUT_MS = 30 * 60_000
const GH_TIMEOUT_MS = 60_000
const ICACLS_TIMEOUT_MS = 60_000
// Owner only: read and write for the owner on a file, and all rights for the owner on a folder.
const PRIVATE_FILE = 0o600
const PRIVATE_FOLDER = 0o700
const PRIVATE_UMASK = 0o077
const MAX_CAPTURE = 32 * 1024 * 1024
const SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'])
const CHANNEL_BINDINGS = new Set(['disable', 'prefer', 'require'])
// The option that makes a session read-only on the server: every transaction starts READ ONLY, and a write is refused
// ("cannot execute CREATE TABLE in a read-only transaction"). It goes into PGOPTIONS of pg_dump.
export const READ_ONLY_OPTION = '-c default_transaction_read_only=on'

export const USAGE = [
  'Usage: node scripts/backup-db.mjs --out <dir> [--neon-project <id>] [options]',
  '  --out <dir>             the folder for the backups and backup.log (required, created when missing)',
  `  --keep <n>              how many backups to keep (default ${DEFAULT_KEEP}, at least 1)`,
  '  --neon-project <id>     get the direct connection string from the Neon CLI, for this project',
  `  --neon-branch <name>    the Neon branch (default ${DEFAULT_NEON_BRANCH})`,
  '  --report-issue <o/r>    on a failure, open an issue in this GitHub repository with the gh CLI',
  '  --pg-bin <dir>          the folder of pg_dump and pg_restore (else PG_BIN, else the Windows install, else PATH)',
  'Without --neon-project the connection string is read from BACKUP_DATABASE_URL (the direct one, not -pooler).',
].join('\n')

// ---- arguments -----------------------------------------------------------------------------------------------------

const VALUE_OPTIONS = {
  '--out': 'out',
  '--keep': 'keep',
  '--neon-project': 'neonProject',
  '--neon-branch': 'neonBranch',
  '--report-issue': 'reportIssue',
  '--pg-bin': 'pgBin',
}
// The project id and the branch name go into a command line (through cmd.exe on Windows), so they are checked against a
// short list of safe characters and cannot start with a hyphen (an option) or hold a space, a quote or a shell character.
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Reads the command line (`--name value` or `--name=value`) into { out, keep, neonProject, neonBranch, reportIssue, pgBin,
 * help }. Throws an Error whose message is safe to print: it names an option, and never repeats a value (a person may have
 * pasted a connection string in the wrong place).
 */
export function parseArgs(argv) {
  const raw = {}
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const name = eq === -1 ? arg : arg.slice(0, eq)
    if (!Object.hasOwn(VALUE_OPTIONS, name)) {
      throw new Error(/^--[a-z-]{1,30}$/.test(name) ? `unknown option ${name}` : 'unknown argument (every value follows an option)')
    }
    let value
    if (eq !== -1) {
      value = arg.slice(eq + 1)
    } else {
      value = argv[i + 1]
      if (value === undefined || String(value).startsWith('--')) throw new Error(`${name} needs a value`)
      i++
    }
    raw[VALUE_OPTIONS[name]] = String(value).trim()
  }
  if (help) return { help: true }

  if (!raw.out) throw new Error('--out <dir> is required: the folder where the backups are kept')
  let keep = DEFAULT_KEEP
  if (raw.keep !== undefined) {
    if (!/^\d{1,6}$/.test(raw.keep) || Number(raw.keep) < 1) throw new Error('--keep must be a whole number, 1 or more')
    keep = Number(raw.keep)
  }
  if (raw.neonProject !== undefined && !PROJECT_ID.test(raw.neonProject)) {
    throw new Error('--neon-project must be a Neon project id (letters, digits, - and _)')
  }
  const neonBranch = raw.neonBranch === undefined ? DEFAULT_NEON_BRANCH : raw.neonBranch
  if (!BRANCH_NAME.test(neonBranch)) throw new Error('--neon-branch must be a branch name (letters, digits, . _ / and -)')
  if (raw.reportIssue !== undefined && !REPO_NAME.test(raw.reportIssue)) {
    throw new Error('--report-issue must be written owner/repo')
  }
  if (raw.pgBin !== undefined && !raw.pgBin) throw new Error('--pg-bin needs a folder')
  return {
    help: false,
    out: raw.out,
    keep,
    neonProject: raw.neonProject ?? null,
    neonBranch,
    reportIssue: raw.reportIssue ?? null,
    pgBin: raw.pgBin ?? null,
  }
}

// ---- the PostgreSQL tools ------------------------------------------------------------------------------------------

/** The folder of pg_dump and pg_restore, or null to find them on PATH. The order is in the header of this file. */
export function resolvePgBin({ option, env = {}, platform = process.platform, exists = fs.existsSync } = {}) {
  if (option) return option
  const fromEnv = String(env.PG_BIN ?? '').trim()
  if (fromEnv) return fromEnv
  if (platform === 'win32' && exists(WINDOWS_PG_BIN)) return WINDOWS_PG_BIN
  return null
}

/** The command to run for a tool of PostgreSQL: its full path inside `dir`, or the bare name (a PATH lookup) for none. */
export function pgTool(dir, name, platform = process.platform) {
  const file = platform === 'win32' ? `${name}.exe` : name
  if (!dir) return file
  return (platform === 'win32' ? path.win32 : path.posix).join(dir, file)
}

/** Where output goes to nowhere: NUL on Windows, /dev/null everywhere else. */
export function nullDevice(platform = process.platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}

// ---- owner-only access lists on Windows -------------------------------------------------------------------------------

/**
 * A tool of Windows by its full path in System32. The bare name is not enough: under Git Bash, for example, `whoami` finds
 * a different program (from the Unix tools) before it finds the one of Windows, and a scheduled task has another PATH than
 * a terminal. `env` gives SystemRoot.
 */
export function windowsTool(name, env = {}) {
  const root = String(env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? '').trim() || 'C:\\Windows'
  return path.win32.join(root, 'System32', name)
}

/**
 * The SID of the current user from the output of `whoami /user /fo csv /nh` (a line such as `"PC\name","S-1-5-21-..."`),
 * written as icacls takes it (`*S-1-5-21-...`, the star means "this is a SID, not a name"), or null. A SID is the same
 * whatever the language of Windows is, and whatever characters (a space, another alphabet) the name of the user has.
 */
export function parseWhoamiSid(stdout) {
  const match = /"(S-1-\d+(?:-\d+)+)"/.exec(String(stdout ?? ''))
  return match ? `*${match[1]}` : null
}

/**
 * The arguments of icacls that make `fileName` readable and writable by `owner` alone: /inheritance:r drops every access
 * that the file got from its folder (the copies are removed, not kept), and /grant:r gives that one user full control.
 * `owner` is `*<SID>` (see parseWhoamiSid) or, when the SID cannot be found, the name of the user.
 */
export function icaclsArgs(fileName, owner, { directory = false } = {}) {
  // For a directory (OI)(CI) makes the files and folders made inside it inherit the same owner-only list.
  return [fileName, '/inheritance:r', '/grant:r', `${owner}:${directory ? '(OI)(CI)F' : 'F'}`]
}

/**
 * Who the files belong to, in the form icacls takes: the SID of the current user from `whoami /user`, and when that cannot
 * be read, the user name that Node knows. Throws an Error with a message that is safe to print when there is neither.
 */
async function windowsOwner({ runner, env, userName }) {
  const who = await runner(windowsTool('whoami.exe', env), ['/user', '/fo', 'csv', '/nh'], {
    env: cleanEnv(env),
    timeoutMs: ICACLS_TIMEOUT_MS,
  })
  const sid = !who.problem && who.status === 0 ? parseWhoamiSid(who.stdout) : null
  if (sid) return sid
  let name = ''
  attempt(() => {
    name = String(userName() ?? '').trim()
  })
  if (name && !/[:/*?"<>|]/.test(name)) return name
  throw new Error('the current Windows user could not be found, so a dump cannot be made owner-only')
}

/**
 * Makes `name` (a file in `cwd`) owner-only with icacls. The file name is relative and the folder is the working directory,
 * so no path (and no user name in it) is on the command line or in a message. Throws an Error with a message that is safe
 * to print when icacls is missing, does not finish or exits with an error: a file that cannot be closed must not be used.
 */
async function restrictToOwner({ name, cwd, owner, runner, env, directory = false }) {
  const result = await runner(windowsTool('icacls.exe', env), icaclsArgs(name, owner, { directory }), {
    env: cleanEnv(env),
    cwd,
    timeoutMs: ICACLS_TIMEOUT_MS,
  })
  if (result.problem === 'ENOENT') throw new Error('icacls was not found, so a dump cannot be made owner-only')
  if (result.problem) throw new Error(`icacls did not finish (${result.problem}), so a dump cannot be made owner-only`)
  if (result.status === 3) {
    // 3 is "path not found": for a file that was just made, the usual cause on Windows is a path of more than about 260 characters
    throw new Error('icacls failed (exit code 3, path not found: a very long backup folder path is the usual cause), so a dump cannot be made owner-only')
  }
  if (result.status !== 0) throw new Error(`icacls failed (exit code ${result.status}), so a dump cannot be made owner-only`)
}

// ---- the connection string -----------------------------------------------------------------------------------------

function decode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * The environment variables that pg_dump reads, made from a connection string: PGHOST, PGPORT, PGUSER, PGPASSWORD,
 * PGDATABASE, PGSSLMODE (from the URL's sslmode, else `require`), PGOPTIONS (always: the read-only session, after the
 * `options` of the URL when it has some) and PGCHANNELBINDING when the URL has `channel_binding`. The password is only ever
 * in PGPASSWORD. Throws an Error whose message is safe to print
 * for a string that is not a postgres address, has no user or database, or is the pooled one (a host with -pooler, which
 * hands each statement to another server connection, so it cannot give pg_dump the one session that it needs).
 */
export function connectionEnv(connectionString) {
  let url
  try {
    url = new URL(String(connectionString).trim())
  } catch {
    throw new Error('the connection string is not a postgres:// address')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('the connection string is not a postgres:// address')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('the connection string has no host')
  if (host.toLowerCase().includes('-pooler')) {
    throw new Error(
      'the connection string is the pooled one (its host has -pooler): the backup needs the direct connection string, ' +
        'because pg_dump needs a session',
    )
  }
  const user = decode(url.username)
  const database = decode(url.pathname.replace(/^\//, ''))
  if (!user || !database) throw new Error('the connection string must name a user and a database')
  const sslmode = url.searchParams.get('sslmode') || 'require'
  if (!SSL_MODES.has(sslmode)) throw new Error('the sslmode of the connection string is not one that Postgres knows')

  const env = { PGHOST: host, PGPORT: url.port || '5432', PGUSER: user, PGDATABASE: database, PGSSLMODE: sslmode }
  const password = decode(url.password)
  if (password) env.PGPASSWORD = password
  // Every session of pg_dump is read-only on the SERVER side, whatever the program does: the backup reads the database (the
  // production one too, on purpose, see AGENTS.md "Safety" and ADR 0005), and this makes a write impossible by construction.
  // It comes last, so that it wins over an option of the address that says the opposite.
  const options = String(url.searchParams.get('options') ?? '').trim()
  env.PGOPTIONS = options ? `${options} ${READ_ONLY_OPTION}` : READ_ONLY_OPTION
  const binding = url.searchParams.get('channel_binding')
  if (binding) {
    if (!CHANNEL_BINDINGS.has(binding)) throw new Error('the channel_binding of the connection string is not valid')
    env.PGCHANNELBINDING = binding
  }
  return env
}

/**
 * The environment for a child process: the current one without the variables that could steer pg_dump or pg_restore
 * somewhere else (every PG... variable of libpq: a stray PGSERVICE or PGHOST must not decide which database is dumped) and
 * without BACKUP_DATABASE_URL, which no child needs. PG_BIN is ours and stays.
 */
export function cleanEnv(base) {
  const env = {}
  for (const [key, value] of Object.entries(base ?? {})) {
    if (value === undefined || /^PG[A-Z]/i.test(key) || key.toUpperCase() === 'BACKUP_DATABASE_URL') continue
    env[key] = value
  }
  return env
}

/**
 * The command that asks the Neon CLI for the direct connection string of a branch (the default role and database, not
 * the pooled host). The CLI of Windows is neon.cmd, which Node cannot start by itself, so it goes through cmd.exe /c. The
 * project and the branch were checked by parseArgs, so nothing here can be taken for a shell command.
 */
export function neonCommand({ project, branch, platform = process.platform }) {
  const args = ['connection-string', branch, '--project-id', project]
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/c', 'neon.cmd', ...args] }
  return { command: 'neon', args }
}

/** The connection string in the output of the Neon CLI (the first line that is one), or null. */
export function parseNeonOutput(stdout) {
  const line = String(stdout ?? '')
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => /^postgres(?:ql)?:\/\/\S+$/i.test(text))
  return line ?? null
}

// ---- file names and retention --------------------------------------------------------------------------------------

/** building-qr-20261003T0715Z.dump: the UTC minute that the backup started in. */
export function backupFileName(date) {
  const iso = date.toISOString()
  return `building-qr-${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z.dump`
}

/**
 * The private work directory of ONE run, inside the output folder: the process id and a few random characters, so that two runs
 * (in the same minute, or at the same time) never share a directory. It starts with a dot, it never matches BACKUP_NAME, and
 * retention ignores it (it only looks at plain files). The name is short on purpose: icacls and the other tools of Windows
 * cannot open a path of more than about 260 characters, and a path inside the work directory must not be longer than the
 * path of the final file (see WINDOWS_PATH_LIMIT).
 */
export function workDirName(pid, random) {
  return `.bqr-${pid}-${random}`
}

/**
 * The temporary file inside the work directory. The directory is unique to the run, so the name does not have to be; it ends in
 * .dump, so `*.dump` in .gitignore covers it. It is created with `wx`: a file that is there already is an error.
 */
export const PARTIAL_NAME = 'partial.dump'

/**
 * Which of `names` to delete so that `keep` backups are left: the file `newName` (the backup that was just made) is always
 * kept, and so are the newest `keep - 1` others. A name that does not match BACKUP_NAME is never picked, whatever it is.
 * The names sort by time because the time is in them.
 */
export function selectOld(names, keep, newName) {
  const others = names
    .filter((name) => BACKUP_NAME.test(name) && name !== newName)
    .sort()
    .reverse()
  return others.slice(Math.max(0, keep - 1))
}

/**
 * Deletes the old backups in `dir`. Returns { removed (names), failed (a number) }. Only plain files are considered.
 * `files` is the file system (a test passes a stub).
 */
export function rotate(dir, keep, newName, files = fs) {
  const names = files
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  const removed = []
  let failed = 0
  for (const name of selectOld(names, keep, newName)) {
    try {
      files.rmSync(path.join(dir, name), { force: true })
      removed.push(name)
    } catch {
      failed++
    }
  }
  return { removed, failed }
}

// ---- cleaning text of secrets ----------------------------------------------------------------------------------------

/**
 * A function that cleans a text of everything that could carry the connection string: the string itself, its password (as
 * written, decoded and percent-encoded) and its host (shown masked), any postgres:// address, and the name in `user "..."`
 * or `role "..."` of a libpq message. Each becomes `***` (the host becomes the masked host, as in the log). Without a
 * connection string only the generic patterns apply. The result is one line of at most 400 characters.
 */
export function makeScrubber(connectionString, folders = []) {
  const secrets = new Set()
  const hosts = new Map()
  // Folders whose absolute path holds a person's name (the backup folder, the temp and home folders): a file system error
  // names them in full. Each one becomes its label, in both slash styles, the longest first.
  const hidden = folders
    .filter(([folder]) => typeof folder === 'string' && folder.length > 3)
    .flatMap(([folder, label]) => [
      [folder, label],
      [folder.replaceAll('\\', '/'), label],
      [folder.replaceAll('/', '\\'), label],
    ])
    .sort((a, b) => b[0].length - a[0].length)
  const raw = String(connectionString ?? '').trim()
  if (raw) {
    secrets.add(raw)
    try {
      const url = new URL(raw)
      for (const value of [url.password, decode(url.password), encodeURIComponent(decode(url.password))]) {
        if (value) secrets.add(value)
      }
      if (url.hostname) hosts.set(url.hostname.replace(/^\[|\]$/g, ''), maskDatabaseHost(raw))
    } catch {
      // not an address: the whole string is still removed as a secret
    }
  }
  // The longest first, so that the whole address goes before the password that is inside it.
  const ordered = [...secrets].sort((a, b) => b.length - a.length)
  return (text) => {
    let clean = String(text ?? '')
    for (const secret of ordered) clean = clean.split(secret).join('***')
    for (const [host, masked] of hosts) clean = clean.split(host).join(masked)
    for (const [folder, label] of hidden) clean = clean.split(folder).join(label)
    clean = clean
      .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '***')
      // Any other user folder that an error names: C:\Users\<name>, /home/<name>, /Users/<name>.
      .replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/)[^\\/\s'"]+/gi, '~')
      .replace(/\b(user|role)\s+"[^"]*"/gi, '$1 "***"')
    return clean.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 400)
  }
}

/**
 * The first line that a tool wrote to stderr, as ': text' for a message, or '' for none. It is not shortened here: the
 * scrubber cleans the whole line and only then cuts it, so that a cut cannot leave half of a password in the text.
 */
function firstLine(stderr) {
  const line = String(stderr ?? '')
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find(Boolean)
  return line ? `: ${line}` : ''
}

function toolProblem(name, problem) {
  if (problem === 'ENOENT') {
    return `${name} was not found: install the PostgreSQL 18 client tools, then pass --pg-bin <folder> or set PG_BIN`
  }
  if (problem === 'TIMEOUT') return `${name} did not finish in time`
  return `${name} could not be started (${problem})`
}

// ---- running a process -----------------------------------------------------------------------------------------------

/**
 * Runs a program without a shell and always resolves: { status (the exit code, or null), stdout, stderr, problem? }.
 * `problem` is set when it could not run to the end: 'ENOENT' (no such program), 'TIMEOUT' or another error code. Its
 * standard input is closed, so a program that wants to ask a question fails instead of waiting for ever.
 */
export function runProcess(command, args, { env, cwd, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const out = []
    const err = []
    let size = 0
    let done = false
    let timer
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ...result })
    }
    let child
    try {
      child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      finish({ status: null, problem: error?.code ?? 'ERROR' })
      return
    }
    timer = setTimeout(() => {
      child.kill()
      finish({ status: null, problem: 'TIMEOUT' })
    }, timeoutMs)
    const collect = (chunks) => (chunk) => {
      if (size < MAX_CAPTURE) {
        size += chunk.length
        chunks.push(chunk)
      }
    }
    child.stdout.on('data', collect(out))
    child.stderr.on('data', collect(err))
    child.on('error', (error) => finish({ status: null, problem: error?.code ?? 'ERROR' }))
    child.on('close', (code) => finish({ status: code }))
  })
}

// ---- the issue ---------------------------------------------------------------------------------------------------------

/**
 * The text of the issue that a failed backup opens. It holds no path (a path has a person's name in it), no host and no
 * error text (an error can carry data about people): only the time and where to look. `when` is a Date.
 */
export function issueBody(when) {
  return [
    `The daily database backup failed on ${formatDateTimeUtc(when)} (UTC).`,
    '',
    'The details are in backup.log in the backup folder, on the machine that runs the backup. They are not repeated here on purpose, because they can hold data about people.',
    '',
    'Look at the last lines of backup.log, fix the cause, and run the backup by hand once (see the section "Daily backups" in docs/runbooks/restore.md). Close this issue when a backup has worked again.',
    '',
  ].join('\n')
}

/** Runs `action` and says whether it worked. For a step that must never stop the backup (a cleanup, a chmod, a message). */
function attempt(action) {
  try {
    action()
    return true
  } catch {
    return false
  }
}

/**
 * The number of the open issue that has exactly the title of a failed backup, from the JSON that
 * `gh issue list --json number,title` printed, or null for none (or for text that is not that JSON). The search of GitHub
 * is a fuzzy one, so the title is compared here, letter for letter. With more than one match the newest (the highest
 * number) is taken.
 */
export function findOpenIssue(json) {
  let list
  try {
    list = JSON.parse(String(json ?? ''))
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const numbers = list
    .filter((item) => item && item.title === ISSUE_TITLE && Number.isSafeInteger(item.number) && item.number > 0)
    .map((item) => item.number)
  return numbers.length ? Math.max(...numbers) : null
}

/**
 * Tells the committee with the gh CLI that the backup failed. A failure every day must not open an issue every day, so it
 * first looks for an open issue with this title and adds a comment (the same safe text) to it, and opens a new issue only
 * when there is none. When the search fails, or the comment does, it opens a new issue: a duplicate is better than silence.
 * Never throws. Returns 'opened', 'commented-<number>', 'gh-missing' or 'failed'.
 */
async function openIssue({ repo, runner, now, env, tmpdir, files = fs }) {
  let dir
  try {
    dir = files.mkdtempSync(path.join(tmpdir, 'bqr-backup-issue-'))
    const bodyFile = path.join(dir, 'body.md')
    files.writeFileSync(bodyFile, issueBody(now()), 'utf8')
    const gh = (args) => runner('gh', args, { env: cleanEnv(env), timeoutMs: GH_TIMEOUT_MS })
    const succeeded = (result) => !result.problem && result.status === 0

    const search = await gh([
      'issue', 'list', '--repo', repo, '--state', 'open', '--search', `"${ISSUE_TITLE}" in:title`,
      '--json', 'number,title', '--limit', '100',
    ])
    if (search.problem === 'ENOENT') return 'gh-missing'
    const existing = succeeded(search) ? findOpenIssue(search.stdout) : null
    if (existing !== null) {
      const comment = await gh(['issue', 'comment', String(existing), '--repo', repo, '--body-file', bodyFile])
      if (succeeded(comment)) return `commented-${existing}`
    }

    const created = await gh([
      'issue', 'create', '--repo', repo, '--title', ISSUE_TITLE, '--label', 'bug', '--body-file', bodyFile,
    ])
    if (created.problem === 'ENOENT') return 'gh-missing'
    return succeeded(created) ? 'opened' : 'failed'
  } catch {
    return 'failed'
  } finally {
    // A cleanup must never throw: it runs after the answer is known, and an error here would hide that answer (and, from
    // a finally block, replace the return value). A body file that cannot be deleted is left in the temporary folder.
    if (dir) attempt(() => files.rmSync(dir, { recursive: true, force: true }))
  }
}

// ---- the backup ----------------------------------------------------------------------------------------------------------

/** 123 B, 12.3 KB or 1.2 MB. */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * One line of backup.log: the time (DD/MM/YYYY HH:MM in the building's time, written by shared/datetime.js, because a
 * person reads this file), ok or failed, then key=value fields, and the error (the only free text) last.
 */
export function logLine({ when, ok, host, file, size, removed, warning, issue, error }) {
  const parts = [formatDateTime(when), ok ? 'ok' : 'failed', `host=${host}`]
  if (file) parts.push(`file=${file}`)
  if (size !== undefined) parts.push(`size=${size}`)
  if (removed !== undefined) parts.push(`removed=${removed}`)
  if (warning) parts.push(`warning=${warning}`)
  if (issue) parts.push(`issue=${issue}`)
  if (error) parts.push(`error=${error}`)
  return parts.join(' ')
}

async function connectionStringFor({ options, env, platform, runner }) {
  const fromEnv = String(env.BACKUP_DATABASE_URL ?? '').trim()
  if (fromEnv) return fromEnv
  if (!options.neonProject) {
    throw new Error('there is no database to back up: set BACKUP_DATABASE_URL (the direct connection string) or pass --neon-project')
  }
  const { command, args } = neonCommand({ project: options.neonProject, branch: options.neonBranch, platform })
  const result = await runner(command, args, { env: cleanEnv(env), timeoutMs: NEON_TIMEOUT_MS })
  // 9009 is what cmd.exe answers when it cannot find neon.cmd
  if (result.problem === 'ENOENT' || (platform === 'win32' && result.status === 9009)) {
    throw new Error('the Neon CLI was not found: install it (npm i -g neonctl) and sign in with `neon auth`')
  }
  if (result.problem) throw new Error(`the Neon CLI did not finish (${result.problem})`)
  if (result.status !== 0) throw new Error(`the Neon CLI failed (exit code ${result.status})${firstLine(result.stderr)}`)
  const url = parseNeonOutput(result.stdout)
  if (!url) throw new Error('the Neon CLI did not print a connection string')
  return url
}

/**
 * The default for `umask` of runBackup: sets the umask of this process and returns the old one. A worker thread is not
 * allowed to change it, and then there is nothing to set (the file mode is still set with chmod afterwards).
 */
function setProcessUmask(mask) {
  try {
    return process.umask(mask)
  } catch {
    return undefined
  }
}

/**
 * Makes one backup. Everything it needs from outside comes in through `deps`, so a test needs no database and no
 * PostgreSQL tools: `runner(command, args, { env, cwd, timeoutMs })` (see runProcess), `now`, `env`, `platform`, `exists`,
 * `tmpdir` (for the issue text), `fs` (the file system), `umask(mask)` (returns the old mask), and `out` and `err` for the
 * two kinds of line.
 * Returns { exitCode, ok, message, file, size, removed, issue, line }. It never throws: whatever a step does (a tool that
 * fails, a file that cannot be deleted), it ends by writing the line of backup.log and the cleaned output.
 */
export async function runBackup(options, deps = {}) {
  const {
    env = process.env,
    platform = process.platform,
    runner = runProcess,
    now = () => new Date(),
    exists = fs.existsSync,
    tmpdir = os.tmpdir(),
    fs: files = fs,
    umask = setProcessUmask,
    userName = () => os.userInfo().username,
    pid = process.pid,
    random = () => crypto.randomBytes(3).toString('hex'),
    out = console.log,
    err = console.error,
  } = deps
  const posix = platform !== 'win32'
  const windows = !posix
  const started = now()
  const outDir = path.resolve(options.out)
  const finalName = backupFileName(started)
  // This run's own private work directory (see workDirName) and the temporary file in it: never the name of another run's.
  const workName = workDirName(pid, random())
  const partialName = PARTIAL_NAME
  const workDir = path.join(outDir, workName)
  const partialPath = path.join(workDir, partialName)
  let workCreated = false
  // null: the log may be written. A text: no log is written, and the text says why. '': no log, and nothing more to say.
  let logSkipped = null
  const logPath = path.join(outDir, LOG_NAME)
  const say = (print, text) => attempt(() => print(text))
  // A file system error carries an absolute path, and on most machines that path holds the user's name.
  let home = ''
  attempt(() => {
    home = os.homedir()
  })
  const hiddenFolders = [
    [outDir, '<out dir>'],
    [tmpdir, '<temp>'],
    [home, '~'],
  ]
  let scrub = makeScrubber(undefined, hiddenFolders)
  // The user that owns the files, for icacls on Windows: asked once, when the first file needs it.
  let ownerAsked
  const ownerOf = () => (ownerAsked ??= windowsOwner({ runner, env, userName }))
  let host = '-'
  let folderIsOpen = false
  let result

  // Before anything is created: every file that pg_dump (a child process, which inherits the mask) or this script makes is
  // closed to every other account. The old mask is put back at the end.
  const previousMask = posix ? umask(PRIVATE_UMASK) : undefined

  try {
    // The longest path of the run, before anything is made: the work directory and the file in it, or the final file.
    if (windows && Math.max(partialPath.length, path.join(outDir, finalName).length) > WINDOWS_PATH_LIMIT) {
      logSkipped = '' // the folder is not made, so there is no place for a log, and the message of the failure says it all
      throw new Error(PATH_TOO_LONG_ERROR)
    }
    files.mkdirSync(outDir, { recursive: true, mode: PRIVATE_FOLDER })
    if (posix) {
      // The folder is the user's choice and is never changed. But when GROUP OR OTHERS can write in it, another account can
      // swap the path of a file for a file of its own between two steps of the script (the path is what pg_dump opens), so
      // the run refuses to start. When they can only read it, the files in it are owner-only anyway: a warning is enough.
      // The mode is read back every time (also for a folder made just now): a file system that ignores modes says 777, and a
      // folder that cannot be inspected is not trusted.
      let mode
      attempt(() => {
        mode = files.statSync(outDir).mode
      })
      if (mode === undefined || (mode & 0o022) !== 0) {
        logSkipped = LOG_SKIPPED
        throw new Error(mode === undefined ? FOLDER_UNKNOWN_ERROR : FOLDER_WRITABLE_ERROR)
      }
      folderIsOpen = (mode & 0o077) !== 0
    }
    const connectionString = await connectionStringFor({ options, env, platform, runner })
    scrub = makeScrubber(connectionString, hiddenFolders)
    host = maskDatabaseHost(connectionString)
    const pgEnv = connectionEnv(connectionString)
    const pgBin = resolvePgBin({ option: options.pgBin, env, platform, exists })
    const pgRestore = pgTool(pgBin, 'pg_restore', platform)

    // THE WORK DIRECTORY. Everything that holds data happens in a private directory that this run makes inside the folder:
    // it is created exclusively (no `recursive`, so an existing one is an error and is never reused), closed to every other
    // account BEFORE anything is written into it (mode 700 on macOS and Linux, an owner-only access list on Windows, whose
    // folders inherit the list of their parent), and removed at the end in every case. The temporary file is made, dumped
    // into, checked and closed there. Another account that can write in the output folder can therefore not put its own file
    // where pg_dump writes: it cannot even enter this directory. At most it can replace the FINAL file after the rename,
    // and the data in that file was never readable by it.
    const owner = windows ? await ownerOf() : undefined
    files.mkdirSync(workDir, { mode: PRIVATE_FOLDER })
    workCreated = true
    if (windows) await restrictToOwner({ name: workName, cwd: outDir, owner, runner, env, directory: true })
    if (posix) {
      let workIsPrivate = false
      attempt(() => {
        workIsPrivate = (files.statSync(workDir).mode & 0o077) === 0
      })
      if (!workIsPrivate) throw new Error('the work directory could not be made owner-only (does this file system ignore modes?), so nothing was dumped')
    }

    // The empty temporary file is made in it, exclusively (`wx`), BEFORE pg_dump writes to it. On Windows it is also given an
    // explicit owner-only list (the directory's list would reach it anyway): pg_dump opens the existing file and overwrites it
    // in place, which keeps the list. If this fails nothing is dumped.
    files.writeFileSync(partialPath, '', { flag: 'wx', mode: PRIVATE_FILE })
    if (windows) await restrictToOwner({ name: partialName, cwd: workDir, owner, runner, env })

    // The file name is relative and the work directory is the working directory of the tool, so a path with a name in another
    // alphabet never has to pass through the command line of a Windows program.
    const dump = await runner(
      pgTool(pgBin, 'pg_dump', platform),
      ['--format=custom', '--no-owner', '--no-privileges', '--no-password', '--file', partialName],
      { env: { ...cleanEnv(env), ...pgEnv }, cwd: workDir, timeoutMs: DUMP_TIMEOUT_MS },
    )
    if (dump.problem) throw new Error(toolProblem('pg_dump', dump.problem))
    if (dump.status !== 0) throw new Error(`pg_dump failed (exit code ${dump.status})${firstLine(dump.stderr)}`)

    // Check 1, the table of contents: the data of the tables of this app must be in the archive.
    const listing = await runner(pgRestore, ['--list', partialName], {
      env: cleanEnv(env),
      cwd: workDir,
      timeoutMs: LIST_TIMEOUT_MS,
    })
    if (listing.problem) throw new Error(toolProblem('pg_restore', listing.problem))
    if (listing.status !== 0) {
      throw new Error(`the dump could not be read back with pg_restore --list (exit code ${listing.status})${firstLine(listing.stderr)}`)
    }
    const missing = REQUIRED_TABLES.filter((table) => !new RegExp(`\\bTABLE DATA public ${table}\\b`).test(listing.stdout))
    if (missing.length) throw new Error(`the dump does not hold the data of the table ${missing.join(' and ')}`)

    // Check 2, every data block: the table of contents is at the start of the file and is read without the data, so a dump
    // that was cut off later would pass the first check. Writing the SQL of the whole archive to the null device reads and
    // decompresses all of it, and a cut or damaged block makes pg_restore exit with an error.
    const full = await runner(pgRestore, [`--file=${nullDevice(platform)}`, partialName], {
      env: cleanEnv(env),
      cwd: workDir,
      timeoutMs: READ_TIMEOUT_MS,
    })
    if (full.problem) throw new Error(toolProblem('pg_restore', full.problem))
    if (full.status !== 0) {
      throw new Error(`the dump could not be read to the end with pg_restore (exit code ${full.status})${firstLine(full.stderr)}`)
    }

    if (posix) {
      // Already 600 through the umask and the mode of the empty file: this makes sure. Then the mode is READ BACK: a failed
      // chmod, or a file system that ignores modes (some network and exFAT volumes), must not leave a readable dump. All of
      // it happens in the work directory, before the file is moved to where others might look.
      attempt(() => files.chmodSync(partialPath, PRIVATE_FILE))
      let closed = false
      attempt(() => {
        closed = (files.statSync(partialPath).mode & 0o077) === 0
      })
      if (!closed) {
        throw new Error('the dump could not be made owner-only (chmod failed, or this file system ignores file modes), so it was deleted')
      }
    }

    // Only now, verified and owner-only, after pg_dump has exited and both checks passed, the file is moved to its final name
    // in the output folder. The work directory is inside that folder, so this is a rename on one volume, which keeps the mode
    // and the access list of the file. When the final name exists (a second run in the same minute) the rename replaces it
    // with this verified dump, which is as good.
    const finalPath = path.join(outDir, finalName)
    files.renameSync(partialPath, finalPath)
    const warnings = []
    const size = files.statSync(finalPath).size

    let removed = 0
    try {
      const rotation = rotate(outDir, options.keep, finalName, files)
      removed = rotation.removed.length
      if (rotation.failed) warnings.push(`${rotation.failed}-old-backups-not-removed`)
    } catch {
      warnings.push('old-backups-not-checked')
    }
    result = { ok: true, file: finalName, size, removed, warning: warnings.join(',') || undefined }
  } catch (error) {
    result = { ok: false, message: scrub(error instanceof Error ? error.message : 'unexpected error') }
  }
  // The work directory goes in every case, with everything in it (a failed run's partial dump too). Only a directory that this
  // run created is removed: one that was there already is not ours. A cleanup never throws; when it fails the directory is
  // owner-only, and a warning says that it is still there.
  if (workCreated && !attempt(() => files.rmSync(workDir, { recursive: true, force: true }))) {
    result.warning = [result.warning, 'work-directory-not-removed'].filter(Boolean).join(',')
  }

  let issue
  if (!result.ok && options.reportIssue) {
    issue = await openIssue({ repo: options.reportIssue, runner, now, env, tmpdir, files })
  }
  let when
  try {
    when = now()
  } catch {
    when = new Date()
  }
  const line = logLine({
    when,
    ok: result.ok,
    host,
    file: result.file,
    size: result.size,
    removed: result.removed,
    warning: result.warning,
    issue,
    error: result.message,
  })
  const folderWarning = `${formatDateTime(when)} warning ${FOLDER_WARNING}`
  // On Windows a new backup.log is closed to other users as soon as it exists. It holds no personal data, so when that fails
  // the line is written anyway and a warning says so.
  let logIsOpen = false
  let logExisted = true
  attempt(() => {
    logExisted = files.existsSync(logPath)
  })
  const logAllowed = logSkipped === null // (a log in a folder that others can write could be a link to another file of the owner)
  if (windows && logAllowed) {
    try {
      if (!files.existsSync(logPath)) {
        const owner = await ownerOf()
        files.writeFileSync(logPath, '', { flag: 'wx' })
        await restrictToOwner({ name: LOG_NAME, cwd: outDir, owner, runner, env })
      }
    } catch {
      logIsOpen = true
    }
  }
  const logged = logAllowed && attempt(() => {
    if (folderIsOpen) files.appendFileSync(logPath, `${folderWarning}\n`, { encoding: 'utf8', mode: PRIVATE_FILE })
    files.appendFileSync(logPath, `${line}\n`, { encoding: 'utf8', mode: PRIVATE_FILE })
  })
  if (posix && logAllowed) {
    attempt(() => files.chmodSync(logPath, PRIVATE_FILE))
    // A new log gets the same check as a dump, but only as a warning: it holds no personal data.
    if (logged && !logExisted) {
      let closed = false
      attempt(() => {
        closed = (files.statSync(logPath).mode & 0o077) === 0
      })
      if (!closed) logIsOpen = true
    }
  }
  if (!logAllowed) {
    if (logSkipped) say(err, logSkipped)
  } else if (!logged) {
    say(err, 'backup: could not write backup.log')
  } else if (logIsOpen) {
    say(err, 'backup: warning, backup.log could not be made owner-only')
  }
  if (previousMask !== undefined) attempt(() => umask(previousMask))

  if (folderIsOpen) say(err, `backup: warning, ${FOLDER_WARNING}`)
  if (result.ok) {
    const noun = result.removed === 1 ? 'file' : 'files'
    say(out, `backup ok: ${result.file}, ${formatSize(result.size)}, removed ${result.removed} old ${noun}`)
  } else {
    say(err, `backup failed: ${result.message}`)
  }
  if (result.warning) say(err, `backup: warning, ${result.warning}`)
  if (!result.ok) {
    if (issue === 'opened') say(err, 'backup: an issue was opened')
    if (issue?.startsWith('commented-')) say(err, `backup: a comment was added to the open issue ${issue.slice('commented-'.length)}`)
    if (issue === 'gh-missing') say(err, 'backup: no issue opened, the gh CLI was not found')
    if (issue === 'failed') say(err, 'backup: no issue opened, gh failed')
  }
  return { exitCode: result.ok ? 0 : 1, line, issue, ...result }
}

/** What an unexpected error may say about itself in public: its code or its name, never its message (it may hold a path). */
function errorLabel(error) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)) return error.code
  if (typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name)) return error.name
  return 'Error'
}

/**
 * The command line: reads the arguments, runs the backup, and returns the exit code. It never throws and never lets an
 * unhandled rejection print a stack (which would show absolute paths): an unexpected error becomes one cleaned line.
 * `run`, `out` and `err` are for a test.
 */
export async function main(argv = process.argv.slice(2), { run = runBackup, out = console.log, err = console.error } = {}) {
  try {
    let options
    try {
      options = parseArgs(argv)
    } catch (error) {
      err(`backup: ${error.message}`)
      err(USAGE)
      return 1
    }
    if (options.help) {
      out(USAGE)
      return 0
    }
    const result = await run(options)
    return result.exitCode
  } catch (error) {
    attempt(() => err(`backup failed: unexpected error (${errorLabel(error)})`))
    return 1
  }
}

if (isMain(import.meta.url)) process.exitCode = await main()
