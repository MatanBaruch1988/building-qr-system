// The daily database backup (scripts/backup-db.mjs, docs/runbooks/restore.md). No database and no PostgreSQL tools: the
// process runner is a stub that records every call and writes the files that pg_dump would write, and the folder of the
// backups is a real temporary folder, so that the file handling (the temporary file, the rename, the retention) is real.
// Fake values only: the connection string below does not exist.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LOG_NOT_REGULAR_ERROR,
  AMBIGUOUS_SOURCE_ERROR,
  BACKUP_NAME,
  DEFAULT_KEEP,
  ISSUE_TITLE,
  WINDOWS_PG_BIN,
  backupFileName,
  cleanEnv,
  connectionEnv,
  findOpenIssue,
  formatSize,
  FOLDER_UNKNOWN_ERROR,
  FOLDER_WARNING,
  FOLDER_WRITABLE_ERROR,
  icaclsArgs,
  issueBody,
  LOG_SKIPPED,
  main,
  makeScrubber,
  neonCommand,
  nullDevice,
  parseArgs,
  parseSddl,
  notProductionMessage,
  parseMarkerValues,
  aclProblem,
  parseNeonOutput,
  parseWhoamiAccount,
  parseWhoamiSid,
  PARTIAL_NAME,
  UNSUPPORTED_PLATFORM_ERROR,
  PATH_TOO_LONG_ERROR,
  WINDOWS_PATH_LIMIT,
  WORK_NAME,
  WORK_PREFIX,
  pgTool,
  powershellTool,
  READ_ONLY_OPTION,
  resolvePgBin,
  removeStaleWorkFolders,
  rotate,
  runBackup,
  runProcess,
  backupTime,
  selectOld,
  SHARED_FOLDERS_ADVICE,
  SHARED_FOLDERS_PREFIX,
  STALE_WORK_MS,
  SHARED_UNREADABLE_ERROR,
  sharedAclProblem,
  sharedFoldersMessage,
  windowsTool,
} from '../scripts/backup-db.mjs'

const USER = 'backup_user'
const PASSWORD = 'fake/pass@word-123' // as it is after decoding
const ENCODED = 'fake%2Fpass%40word-123' // as it is written in the address
const HOST = 'ep-test-cool-123456.eu-central-1.aws.neon.tech'
const MASKED_HOST = 'ep-tes****.eu-central-1.aws.neon.tech'
const URL_FAKE = `postgresql://${USER}:${ENCODED}@${HOST}/appdb?sslmode=require`
const POOLED = `postgresql://${USER}:${ENCODED}@ep-test-cool-123456-pooler.eu-central-1.aws.neon.tech/appdb?sslmode=require`
const SID = 'S-1-5-21-111-222-333-1001' // a fake SID
// Linux: the uid of the (fake) user, that of another account, and root. Every folder of a test is owned by UID, unless a test says not.
const UID = 1000
const OTHER_UID = 1001
const ROOT_UID = 0
const NOW = new Date('2026-10-03T07:15:42Z')
const FINAL = 'building-qr-20261003T0715Z.dump'
// the temporary file, inside the private work directory (.bqr-work-<random>) that each run makes inside the output folder
const PARTIAL = 'partial.dump'
const LISTING = [
  ';',
  '; Archive created at 2026-10-03 10:15:40',
  '3567; 0 24963 TABLE DATA public scans backup_user',
  '3563; 0 24869 TABLE DATA public points backup_user',
  '3564; 0 24898 TABLE DATA public providers backup_user',
].join('\n')

/** The SQL that `pg_restore --data-only --table=environment_marker --file=-` writes for a dump whose marker table holds `rows`. */
const markerSql = (...rows) =>
  [
    '--',
    '-- PostgreSQL database dump',
    '--',
    '',
    "SET client_encoding = 'UTF8';",
    '',
    '-- Data for Name: environment_marker; Type: TABLE DATA; Schema: public; Owner: -',
    '',
    'COPY public.environment_marker (environment) FROM stdin;',
    ...rows,
    '\\.',
    '',
    '-- PostgreSQL database dump complete',
    '',
  ].join('\n')
/** The same for a dump that has no marker table at all: pg_restore writes the header and no COPY block. */
const NO_MARKER_SQL = "--\n-- PostgreSQL database dump\n--\n\nSET client_encoding = 'UTF8';\n\n-- PostgreSQL database dump complete\n"
const isMarkerCall = (call) => call.args.includes('--data-only')

/** The SDDL of a folder that only the system, the administrators and the (fake) user can change, as Get-Acl writes it. */
const SAFE_SDDL = `O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${SID})`
/** What the PowerShell call prints for these descriptors: the index of the path, a tab, the SDDL, per line. */
const sddlLines = (sddls) => sddls.map((sddl, index) => `${index}\t${sddl}\r\n`).join('')

/** The account of the fake user that the whoami stub answers with, as icacls prints an entry for it on a directory. */
const OWNER_ENTRY = 'PC\\user:(OI)(CI)(F)'
/** What `icacls <name>` prints: the name and the first entry on one line, the others under it, then the summary. */
const aclListing = (name, ...entries) =>
  [`${name} ${entries[0] ?? ''}`.trimEnd(), ...entries.slice(1).map((entry) => `${' '.repeat(name.length + 1)}${entry}`), '', 'Successfully processed 1 files; Failed processing 0 files', '', ''].join('\r\n')

// ---- a stub runner ---------------------------------------------------------------------------------------------------

function toolOf(command) {
  const base = path.basename(String(command).replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '')
  return base === 'cmd' || base === 'neon' ? 'neon' : base
}

const defaults = {
  pg_dump: ({ args, options }) => {
    fs.writeFileSync(path.join(options.cwd, args[args.indexOf('--file') + 1]), 'PGDMP fake dump')
    return { status: 0, stdout: '', stderr: '' }
  },
  pg_restore: (call) => ({ status: 0, stdout: isMarkerCall(call) ? markerSql('production') : LISTING, stderr: '' }),
  neon: () => ({ status: 0, stdout: `${URL_FAKE}\n`, stderr: '' }),
  // Windows only: the SID of the user (a fake one) and the owner-only access list of a file
  whoami: () => ({ status: 0, stdout: `"PC\\user","${SID}"\r\n`, stderr: '' }),
  // Windows only: the security descriptors of the folders of the run, one line per path (the index of the path, a tab, the SDDL):
  // every folder belongs to the system, the administrators and the user, and nobody else
  powershell: ({ options }) => ({
    status: 0,
    stdout: sddlLines(options.env.BQR_ACL_PATHS.split('|').map(() => SAFE_SDDL)),
    stderr: '#< CLIXML\r\n', // PowerShell writes this to stderr even when all is well
  }),
  // a call that changes an access list says what it did; a call with the name alone reads the list, and it is the user's alone
  icacls: ({ args }) =>
    args.length === 1
      ? { status: 0, stdout: aclListing(args[0], OWNER_ENTRY), stderr: '' }
      : { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files\r\n', stderr: '' },
  // list: no open issue yet; comment and create: done
  gh: ({ args }) => ({ status: 0, stdout: args[1] === 'list' ? '[]' : 'https://github.com/owner/repo/issues/1\n', stderr: '' }),
}

/** A runner that records { tool, command, args, options } of every call and answers with a handler per tool. */
function makeRunner(handlers = {}) {
  const calls = []
  const runner = async (command, args, options = {}) => {
    const tool = toolOf(command)
    const call = { tool, command, args, options }
    calls.push(call)
    const handler = handlers[tool] ?? defaults[tool]
    if (!handler) throw new Error(`the test did not expect a call of ${tool}`)
    return handler({ ...call, n: calls.filter((c) => c.tool === tool).length })
  }
  runner.calls = calls
  runner.of = (tool) => calls.filter((c) => c.tool === tool)
  return runner
}

let tmp
let dir

beforeEach(() => {
  // the real path of the folder of the test (a short 8.3 name on Windows is an alias for it): the script works on real paths
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bqr-backup-test-')))
  dir = path.join(tmp, 'backups')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * The file system of a run: the real one, except that the backup folder says it is private (mode 700). A real folder made
 * with the umask of the machine (or by Windows, which has no such modes) would trigger the warning for a folder that other
 * users can read, and these tests are about everything else. The tests of that warning pass their own `fs`.
 */
function privateStat(...args) {
  const [target, ...rest] = args
  if (path.resolve(String(target)) === path.resolve(dir) || isWorkDir(target)) return { mode: 0o040700, uid: UID }
  return fileStat(target, ...rest)
}

/** True for the work directory of a run (the stub says it is private, like a real one made with mode 700). */
function isWorkDir(target) {
  return path.basename(String(target)).startsWith('.bqr-work-')
}

/** The work directories that are in the output folder of the test now: a run makes its own with mkdtemp. */
function backupFilesIn(folder) {
  return fs.readdirSync(folder).filter((name) => BACKUP_NAME.test(name)).sort()
}

function workDirsNow() {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('.bqr-work-')) : []
}

/** The working directory of a tool is this run's own work directory: a .bqr-work-<random> directory inside the output folder. */
function expectWorkCwd(cwd) {
  expect(path.dirname(cwd)).toBe(path.resolve(dir))
  expect(path.basename(cwd)).toMatch(/^\.bqr-work-[A-Za-z0-9]{6}$/)
}

/**
 * The stat of a file as the script sees it on Linux: its real size, and a mode of 600. (A real file on Windows
 * says 666, and on a machine with another umask something else: the script reads the mode back, and these tests are about
 * everything else. The tests of that check pass their own `fs`.) It throws for a file that is not there, like the real one.
 */
function fileStat(target, ...rest) {
  const real = fs.statSync(target, ...rest)
  // a folder (the temp folder, the folders above the backup folder) is an ordinary one that others cannot write in
  return { size: real.size, mode: real.isDirectory() ? 0o040755 : 0o100600, uid: UID }
}

/** Runs one backup into `dir` with the stub, and collects the two kinds of output line. */
async function go({ options = {}, deps = {}, runner = makeRunner() } = {}) {
  const out = []
  const errs = []
  const masks = []
  const result = await runBackup(
    { out: dir, keep: 30, neonProject: null, neonBranch: 'main', reportIssue: null, pgBin: null, ...options },
    {
      env: { BACKUP_DATABASE_URL: URL_FAKE, PATH: '/usr/bin', ...deps.env },
      platform: 'linux',
      exists: () => false,
      runner,
      now: () => NOW,
      fs: { ...fs, statSync: privateStat },
      umask: (mask) => {
        masks.push(mask)
        return 0o022
      },
      getuid: () => UID,
      out: (line) => out.push(line),
      err: (line) => errs.push(line),
      ...Object.fromEntries(Object.entries(deps).filter(([key]) => key !== 'env')),
    },
  )
  let log = ''
  try {
    log = fs.readFileSync(path.join(dir, 'backup.log'), 'utf8')
  } catch {
    // no log (a failure before the folder exists, or a folder where the log should be)
  }
  return { ...result, runner, out, errs, masks, log, files: fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [] }
}

/** Everything a run wrote or printed that a person or a log collector could see: no secret may be in it. */
function visible(r) {
  const texts = [r.out.join('\n'), r.errs.join('\n'), r.log, r.files.join('\n')]
  // every file that is left, also in a work directory that could not be removed (dumps are binary: only their names count)
  const read = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) read(full)
      else if (!entry.name.endsWith('.dump')) texts.push(fs.readFileSync(full, 'utf8'))
    }
  }
  if (fs.existsSync(dir)) read(dir)
  return texts.join('\n')
}

function seed(names) {
  fs.mkdirSync(dir, { recursive: true })
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'old')
}

const oldBackups = [
  'building-qr-20260901T0000Z.dump',
  'building-qr-20260902T0000Z.dump',
  'building-qr-20260903T0000Z.dump',
  'building-qr-20260904T0000Z.dump',
  'building-qr-20260905T0000Z.dump',
]

// ---- the command line ---------------------------------------------------------------------------------------------------

describe('the command line', () => {
  it('has the defaults: keep 30, the main branch, nothing else', () => {
    expect(DEFAULT_KEEP).toBe(30)
    expect(parseArgs(['--out', 'backups'])).toEqual({
      help: false,
      out: 'backups',
      keep: 30,
      neonProject: null,
      neonBranch: 'main',
      reportIssue: null,
      pgBin: null,
    })
  })

  it('reads every option, with a space or with =', () => {
    const wanted = {
      help: false,
      out: 'some dir/backups',
      keep: 7,
      neonProject: 'square-term-12345678',
      neonBranch: 'release/one',
      reportIssue: 'owner/repo.name',
      pgBin: '/opt/pg18/bin',
    }
    expect(
      parseArgs([
        '--out', 'some dir/backups', '--keep', '7', '--neon-project', 'square-term-12345678', '--neon-branch', 'release/one',
        '--report-issue', 'owner/repo.name', '--pg-bin', '/opt/pg18/bin',
      ]),
    ).toEqual(wanted)
    expect(
      parseArgs([
        '--out=some dir/backups', '--keep=7', '--neon-project=square-term-12345678', '--neon-branch=release/one',
        '--report-issue=owner/repo.name', '--pg-bin=/opt/pg18/bin',
      ]),
    ).toEqual(wanted)
  })

  it('needs --out', () => {
    expect(() => parseArgs([])).toThrow(/--out/)
    expect(() => parseArgs(['--out='])).toThrow(/--out/)
    expect(() => parseArgs(['--keep', '3'])).toThrow(/--out/)
  })

  it('keeps at least one backup: --keep is a whole number of 1 or more', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', ' ', '9999999']) {
      expect(() => parseArgs(['--out', 'x', `--keep=${bad}`]), `--keep=${bad}`).toThrow(/--keep/)
    }
    expect(parseArgs(['--out', 'x', '--keep', '1']).keep).toBe(1)
  })

  it('refuses a project id, a branch or a repository with a character that a command line could misread', () => {
    for (const bad of ['a&b', 'a b', '-x', 'a;b', 'a"b', '$(x)', 'a|b', '']) {
      expect(() => parseArgs(['--out', 'x', `--neon-project=${bad}`]), bad).toThrow(/--neon-project/)
    }
    for (const bad of ['a&b', 'a b', '-x', 'a;b', 'a"b', '$(x)', 'a@2024-01-01']) {
      expect(() => parseArgs(['--out', 'x', `--neon-branch=${bad}`]), bad).toThrow(/--neon-branch/)
    }
    for (const bad of ['owner', 'owner/', '/repo', 'a b/c', 'a/b/c', '-x/y;z']) {
      expect(() => parseArgs(['--out', 'x', `--report-issue=${bad}`]), bad).toThrow(/--report-issue/)
    }
  })

  it('refuses an unknown option and a missing value, and never repeats a value in the message', () => {
    expect(() => parseArgs(['--out', 'x', '--nope'])).toThrow('unknown option --nope')
    expect(() => parseArgs(['--out'])).toThrow('--out needs a value')
    expect(() => parseArgs(['--out', '--keep', '3'])).toThrow('--out needs a value')
    let message = ''
    try {
      parseArgs(['--out', 'x', URL_FAKE])
    } catch (err) {
      message = err.message
    }
    expect(message).toMatch(/unknown argument/)
    for (const secret of [PASSWORD, ENCODED, USER, HOST]) expect(message).not.toContain(secret)
  })

  it('answers --help', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true })
    expect(parseArgs(['-h', '--out', 'x'])).toEqual({ help: true })
  })
})

// ---- where pg_dump is -----------------------------------------------------------------------------------------------------

describe('the folder of pg_dump and pg_restore', () => {
  it('prefers --pg-bin, then PG_BIN, then the Windows install when it exists, then PATH', () => {
    const yes = () => true
    const no = () => false
    expect(resolvePgBin({ option: '/a', env: { PG_BIN: '/b' }, platform: 'win32', exists: yes })).toBe('/a')
    expect(resolvePgBin({ env: { PG_BIN: ' /b ' }, platform: 'win32', exists: yes })).toBe('/b')
    expect(resolvePgBin({ env: {}, platform: 'win32', exists: yes })).toBe(WINDOWS_PG_BIN)
    expect(resolvePgBin({ env: {}, platform: 'win32', exists: no })).toBeNull()
    expect(resolvePgBin({ env: {}, platform: 'linux', exists: yes })).toBeNull()
    expect(resolvePgBin({ env: { PG_BIN: '  ' }, platform: 'freebsd', exists: yes })).toBeNull()
  })

  it('the Windows folder is the install of Postgres 18', () => {
    expect(WINDOWS_PG_BIN).toBe('C:\\Program Files\\PostgreSQL\\18\\bin')
  })

  it('names the tool with .exe on Windows and joins it to the folder the way that system does', () => {
    expect(pgTool(WINDOWS_PG_BIN, 'pg_dump', 'win32')).toBe('C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe')
    expect(pgTool(null, 'pg_dump', 'win32')).toBe('pg_dump.exe')
    expect(pgTool('/opt/pg18/bin', 'pg_restore', 'linux')).toBe('/opt/pg18/bin/pg_restore')
    expect(pgTool(null, 'pg_restore', 'freebsd')).toBe('pg_restore')
  })
})

// ---- the connection string ----------------------------------------------------------------------------------------------------

describe('the connection string as environment variables', () => {
  it('makes the variables that pg_dump reads, with the password decoded', () => {
    expect(connectionEnv(URL_FAKE)).toEqual({
      PGHOST: HOST,
      PGPORT: '5432',
      PGUSER: USER,
      PGPASSWORD: PASSWORD,
      PGDATABASE: 'appdb',
      PGSSLMODE: 'require',
      PGOPTIONS: READ_ONLY_OPTION,
    })
  })

  it('puts the password in PGPASSWORD and nowhere else', () => {
    const env = connectionEnv(URL_FAKE)
    const holders = Object.entries(env).filter(([, value]) => value.includes(PASSWORD) || value.includes(ENCODED))
    expect(holders.map(([key]) => key)).toEqual(['PGPASSWORD'])
  })

  it('takes the sslmode of the address, and require when there is none', () => {
    expect(connectionEnv(`postgres://u:p@h.example/db`).PGSSLMODE).toBe('require')
    expect(connectionEnv(`postgres://u:p@h.example/db?sslmode=verify-full`).PGSSLMODE).toBe('verify-full')
    expect(connectionEnv(`postgres://u:p@h.example/db?sslmode=disable`).PGSSLMODE).toBe('disable')
    expect(() => connectionEnv(`postgres://u:p@h.example/db?sslmode=bogus`)).toThrow(/sslmode/)
  })

  it('passes options and channel_binding when the address has them, a port when it has one', () => {
    const env = connectionEnv('postgres://u:p@h.example:6543/db?options=endpoint%3Dep-abc&channel_binding=require')
    expect(env.PGOPTIONS).toBe(`endpoint=ep-abc ${READ_ONLY_OPTION}`)
    expect(env.PGCHANNELBINDING).toBe('require')
    expect(env.PGPORT).toBe('6543')
    expect(() => connectionEnv('postgres://u:p@h.example/db?channel_binding=bogus')).toThrow(/channel_binding/)
  })

  it('has no PGPASSWORD for a password-less address, and reads an IPv6 host without its brackets', () => {
    const env = connectionEnv('postgresql://u@[::1]:5433/db')
    expect('PGPASSWORD' in env).toBe(false)
    expect(env.PGHOST).toBe('::1')
    expect(env.PGPORT).toBe('5433')
  })

  it('refuses the pooled host: pg_dump needs a session', () => {
    expect(() => connectionEnv(POOLED)).toThrow(/direct connection string/)
    expect(() => connectionEnv('postgres://u:p@EP-X-POOLER.example/db'.replace('EP-X-POOLER', 'ep-x-Pooler'))).toThrow(/pooled/)
  })

  it('refuses what is not a postgres address, or has no user or no database, without repeating it', () => {
    for (const bad of ['', 'not a url', 'https://u:p@h.example/db', 'postgres://h.example/db', 'postgres://u:p@h.example/']) {
      expect(() => connectionEnv(bad), bad).toThrow()
    }
    let message = ''
    try {
      connectionEnv(`mysql://${USER}:${ENCODED}@${HOST}/appdb`)
    } catch (err) {
      message = err.message
    }
    for (const secret of [PASSWORD, ENCODED, USER, HOST]) expect(message).not.toContain(secret)
  })
})

describe('the environment of a child process', () => {
  it('drops every PG variable (they could point pg_dump elsewhere) and BACKUP_DATABASE_URL, and keeps the rest', () => {
    const env = cleanEnv({
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      PG_BIN: '/opt/pg',
      PGSERVICE: 'x',
      PGHOST: 'evil',
      pgpassword: 'x',
      PGSSLROOTCERT: 'x',
      BACKUP_DATABASE_URL: URL_FAKE,
      Backup_Database_Url: URL_FAKE,
      EMPTY: undefined,
    })
    expect(env).toEqual({ PATH: '/usr/bin', SystemRoot: 'C:\\Windows', PG_BIN: '/opt/pg' })
  })
})

describe('the Neon CLI', () => {
  it('is run through cmd.exe /c on Windows, because it is neon.cmd there', () => {
    expect(neonCommand({ project: 'square-term-1', branch: 'main', platform: 'win32' })).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/c', 'neon.cmd', 'connection-string', 'main', '--project-id', 'square-term-1'],
    })
  })

  it('is run as neon everywhere else', () => {
    for (const platform of ['linux', 'freebsd']) {
      expect(neonCommand({ project: 'square-term-1', branch: 'release/one', platform })).toEqual({
        command: 'neon',
        args: ['connection-string', 'release/one', '--project-id', 'square-term-1'],
      })
    }
  })

  it('asks for the direct string: it never passes --pooled', () => {
    expect(neonCommand({ project: 'p', branch: 'main', platform: 'linux' }).args).not.toContain('--pooled')
  })

  it('finds the connection string in what the CLI printed, and nothing else', () => {
    expect(parseNeonOutput(`${URL_FAKE}\r\n`)).toBe(URL_FAKE)
    expect(parseNeonOutput(`A new version is available\n${URL_FAKE}\n`)).toBe(URL_FAKE)
    expect(parseNeonOutput('ERROR: not signed in')).toBeNull()
    expect(parseNeonOutput('')).toBeNull()
    expect(parseNeonOutput(undefined)).toBeNull()
  })
})

// ---- file names and retention ---------------------------------------------------------------------------------------------------

describe('the name of a backup', () => {
  it('is building-qr-<UTC time to the minute>.dump', () => {
    expect(backupFileName(NOW)).toBe(FINAL)
    expect(backupFileName(new Date('2026-01-02T23:59:59.999Z'))).toBe('building-qr-20260102T2359Z.dump')
  })

  it('is in UTC, whatever the time zone of the date text', () => {
    expect(backupFileName(new Date('2026-10-03T00:30:00+03:00'))).toBe('building-qr-20261002T2130Z.dump')
  })

  it('matches the pattern that retention uses, and the names sort by time', () => {
    const names = [new Date('2026-10-03T07:15:00Z'), new Date('2025-12-31T23:59:00Z'), new Date('2026-10-03T07:16:00Z')].map(backupFileName)
    for (const name of names) expect(BACKUP_NAME.test(name)).toBe(true)
    expect([...names].sort()).toEqual([names[1], names[0], names[2]])
  })

  it('has a temporary name that ends in .dump (ignored by git) and is not counted by retention', () => {
    expect(PARTIAL_NAME).toBe(PARTIAL)
    expect(PARTIAL.endsWith('.dump')).toBe(true)
    expect(BACKUP_NAME.test(PARTIAL)).toBe(false)
  })
})

describe('which backups to delete', () => {
  const names = [...oldBackups]
  const picked = (list, keep, latest) => selectOld(list, keep, latest).old

  it('knows the time that a backup name says, and a name that is not a backup has none', () => {
    expect(backupTime(FINAL)).toEqual(new Date('2026-10-03T07:15:00Z'))
    expect(backupTime('building-qr-20260101T2359Z.dump')).toEqual(new Date('2026-01-01T23:59:00Z'))
    expect(backupFileName(backupTime(FINAL))).toBe(FINAL)
    for (const bad of [
      'building-qr-20261301T0000Z.dump', // month 13
      'building-qr-20260230T0000Z.dump', // 30 February
      'building-qr-20261003T2460Z.dump', // minute 60, hour 24
      'building-qr-latest.dump',
      'building-qr-20261003T0715Z.dump.bak',
      'notes.txt',
      '',
    ]) {
      expect(backupTime(bad), bad).toBeNull()
    }
  })

  it('sorts all the backups together by their time and keeps the newest ones: whichever file is new on disk is just one of them', () => {
    expect(picked([...names, FINAL], 3)).toEqual(['building-qr-20260903T0000Z.dump', 'building-qr-20260902T0000Z.dump', 'building-qr-20260901T0000Z.dump'])
    expect(picked([...names, FINAL], 1)).toEqual([...oldBackups].reverse())
    expect(picked([...names, FINAL], 30)).toEqual([])
    expect(picked([FINAL], 3)).toEqual([])
    expect(picked([], 3)).toEqual([])
  })

  it('picks the file of a run that is older than the ones that are kept, however it came to be there last', () => {
    const newer = ['building-qr-20261003T0717Z.dump', 'building-qr-20261003T0718Z.dump']
    expect(picked([FINAL, ...newer], 2)).toEqual([FINAL]) // the run of 07:15, finishing after those of 07:17 and 07:18
    expect(picked([FINAL, ...newer], 3)).toEqual([])
    expect(picked([FINAL, newer[1]], 1)).toEqual([FINAL])
  })

  it('never picks a name that is not a backup, and does not count it', () => {
    const others = [
      'notes.txt',
      'backup.log',
      'building-qr-20260101T0000Z.dump.bak',
      'building-qr-latest.dump',
      'Building-QR-20250101T0000Z.dump',
      'building-qr-2025T0000Z.dump',
      'xbuilding-qr-20250101T0000Z.dump',
      'building-qr-20250101T0000Z.partial.dump',
      'my building-qr-20250101T0000Z.dump',
      'building-qr-20261301T0000Z.dump', // matches the pattern, but its time is not a real one
      'building-qr-20260230T0000Z.dump',
    ]
    expect(picked([...others, ...names, FINAL], 1)).toEqual([...oldBackups].reverse())
    expect(picked(others, 1)).toEqual([])
  })

  it('does not count a name that says a time later than now, and does not pick it: it came from a wrong clock', () => {
    const future = ['building-qr-20990101T0000Z.dump', 'building-qr-20980101T0000Z.dump']
    const now = new Date('2026-10-03T08:00:00Z')
    expect(selectOld([...names, ...future, FINAL], 2, now)).toEqual({
      old: ['building-qr-20260904T0000Z.dump', 'building-qr-20260903T0000Z.dump', 'building-qr-20260902T0000Z.dump', 'building-qr-20260901T0000Z.dump'],
      future: 2,
    })
    // with keep 1 the new backup is the one that stays, not a file from the future
    expect(selectOld([...future, FINAL], 1, now)).toEqual({ old: [], future: 2 })
    // without a time for now (a caller that has no clock) the names count like any other
    expect(selectOld([...future, FINAL], 1).old).toEqual(['building-qr-20980101T0000Z.dump', FINAL])
  })
})

// ---- a good backup --------------------------------------------------------------------------------------------------------------

describe('a good backup', () => {
  it('dumps to a temporary file, checks it, renames it, and prints one summary line', async () => {
    let during
    let inside
    let cwd
    const runner = makeRunner({
      pg_dump: (call) => {
        const answer = defaults.pg_dump(call)
        cwd = call.options.cwd
        during = fs.readdirSync(dir)
        inside = fs.readdirSync(call.options.cwd)
        return answer
      },
    })
    const r = await go({ runner })
    expect(r.exitCode).toBe(0)
    expect(r.ok).toBe(true)
    expect(during).toEqual([path.basename(cwd)]) // only the work directory is in the output folder while the dump is made
    expect(inside).toEqual([PARTIAL]) // and the temporary file is in it
    expect(r.files).toEqual(['backup.log', FINAL])
    expect(fs.readFileSync(path.join(dir, FINAL), 'utf8')).toBe('PGDMP fake dump')
    expect(r.out).toEqual([`backup ok: ${FINAL}, 15 B, removed 0 old files`])
    expect(r.errs).toEqual([])
    expect(r.file).toBe(FINAL)
    expect(r.size).toBe(15)
  })

  it('runs pg_dump in the custom format, with no owner and no privileges, with the file name relative to the folder', async () => {
    const r = await go()
    const [dump] = r.runner.of('pg_dump')
    expect(dump.command).toBe('pg_dump')
    expect(dump.args).toEqual(['--format=custom', '--no-owner', '--no-privileges', '--no-password', '--file', PARTIAL])
    expectWorkCwd(dump.options.cwd)
  })

  it('reads the dump back with pg_restore --list, in the same folder', async () => {
    const r = await go()
    const [list] = r.runner.of('pg_restore')
    expect(list.command).toBe('pg_restore')
    expect(list.args).toEqual(['--list', PARTIAL])
    expectWorkCwd(list.options.cwd)
    expect(r.runner.calls.map((c) => c.tool)).toEqual(['pg_dump', 'pg_restore', 'pg_restore', 'pg_restore'])
  })

  it('creates the folder when it is missing, also a nested one', async () => {
    dir = path.join(tmp, 'a', 'b', 'backups')
    const r = await go()
    expect(r.exitCode).toBe(0)
    expect(r.files).toEqual(['backup.log', FINAL])
  })

  it('works with a relative --out, by making it absolute first', async () => {
    const before = process.cwd()
    process.chdir(tmp)
    try {
      const r = await go({ options: { out: 'rel-backups' } })
      const cwd = r.runner.of('pg_dump')[0].options.cwd // the work directory, inside the folder of the backups, as an absolute path
      expect(path.isAbsolute(cwd)).toBe(true)
      expect(fs.realpathSync(path.dirname(cwd))).toBe(fs.realpathSync(path.join(tmp, 'rel-backups')))
      expect(path.basename(cwd)).toMatch(/^\.bqr-work-[A-Za-z0-9]{6}$/)
      expect(fs.existsSync(path.join(tmp, 'rel-backups', FINAL))).toBe(true)
    } finally {
      process.chdir(before)
    }
  })

  it('uses the tools of --pg-bin, and on Windows pg_dump.exe in the Postgres 18 folder when it exists', async () => {
    const own = await go({ options: { pgBin: '/opt/pg18/bin' } })
    expect(own.runner.of('pg_dump')[0].command).toBe('/opt/pg18/bin/pg_dump')
    expect(own.runner.of('pg_restore')[0].command).toBe('/opt/pg18/bin/pg_restore')
    fs.rmSync(dir, { recursive: true, force: true })
    const win = await go({ deps: { platform: 'win32', exists: (p) => p === WINDOWS_PG_BIN } })
    expect(win.runner.of('pg_dump')[0].command).toBe(`${WINDOWS_PG_BIN}\\pg_dump.exe`)
    expect(win.runner.of('pg_restore')[0].command).toBe(`${WINDOWS_PG_BIN}\\pg_restore.exe`)
  })

  it('pgBin from PG_BIN is used when there is no option', async () => {
    const r = await go({ deps: { env: { PG_BIN: '/from/env' } } })
    expect(r.runner.of('pg_dump')[0].command).toBe('/from/env/pg_dump')
  })

  it('makes a second backup of the same minute over the first (one name per minute) without leaving the temporary file', async () => {
    await go()
    const r = await go()
    expect(r.files).toEqual(['backup.log', FINAL])
  })
})

// ---- the secrets ------------------------------------------------------------------------------------------------------------------

describe('the password and the connection string', () => {
  it('reach pg_dump only through the environment: never a command line, never a file, never a printed line', async () => {
    const r = await go()
    for (const call of r.runner.calls) {
      const commandLine = JSON.stringify([call.command, call.args])
      for (const secret of [PASSWORD, ENCODED, USER, HOST, 'postgresql://', 'sslmode']) {
        expect(commandLine, `${call.tool} ${secret}`).not.toContain(secret)
      }
    }
    const [dump] = r.runner.of('pg_dump')
    expect(dump.options.env).toMatchObject({
      PGHOST: HOST,
      PGPORT: '5432',
      PGUSER: USER,
      PGPASSWORD: PASSWORD,
      PGDATABASE: 'appdb',
      PGSSLMODE: 'require',
    })
    // pg_restore --list makes no connection, so it gets none of it
    expect(Object.keys(r.runner.of('pg_restore')[0].options.env).filter((key) => /^PG[A-Z]/.test(key))).toEqual([])
    const seen = visible(r)
    for (const secret of [PASSWORD, ENCODED, USER, HOST, 'postgresql://']) expect(seen).not.toContain(secret)
  })

  it('are not in the environment of a child from outside, and a stray PG variable cannot steer pg_dump', async () => {
    const r = await go({ deps: { env: { PGSERVICE: 'other', PGHOST: 'evil.example', PGPASSFILE: '/x', PG_BIN: '/opt' } } })
    const env = r.runner.of('pg_dump')[0].options.env
    expect(env.PGHOST).toBe(HOST)
    expect('PGSERVICE' in env).toBe(false)
    expect('PGPASSFILE' in env).toBe(false)
    expect('BACKUP_DATABASE_URL' in env).toBe(false)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('are cleaned out of an error that repeats them: the address, the password in both forms, the host and the user', async () => {
    const stderr = `pg_dump: error: connection to server at "${HOST}" (10.0.0.1), port 5432 failed: FATAL:  password authentication failed for user "${USER}"\nconnection string was ${URL_FAKE}\n`
    const r = await go({ runner: makeRunner({ pg_dump: () => ({ status: 1, stdout: '', stderr }) }) })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(
      `pg_dump failed (exit code 1): pg_dump: error: connection to server at "${MASKED_HOST}" (10.0.0.1), port 5432 failed: FATAL:  password authentication failed for user "***"`,
    )
    const seen = visible(r)
    for (const secret of [PASSWORD, ENCODED, USER, HOST, 'postgresql://']) expect(seen).not.toContain(secret)
    expect(r.log).toContain('error=pg_dump failed (exit code 1)')
  })

  it('are cleaned out of an error line that repeats them as text', async () => {
    for (const line of [
      `could not use ${URL_FAKE} at all`,
      `the password was ${PASSWORD} and also ${ENCODED}`,
      `x${PASSWORD}${ENCODED}${URL_FAKE}`,
    ]) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ runner: makeRunner({ pg_dump: () => ({ status: 1, stdout: '', stderr: line }) }) })
      const seen = visible(r)
      for (const secret of [PASSWORD, ENCODED, 'postgresql://']) expect(seen, line).not.toContain(secret)
      expect(seen).toContain('***')
    }
  })

  it('are cleaned before a long line is cut, so a cut cannot leave a part of the password', async () => {
    // The prefix of the message is 30 characters. The password starts at 225 or at 390 of the message, so a cut of the
    // line at 200, or of the message at 400, before the cleaning would leave a part of it.
    for (const before of [195, 360]) {
      fs.rmSync(dir, { recursive: true, force: true })
      const line = `${'x'.repeat(before)}${PASSWORD}${'y'.repeat(300)}`
      const r = await go({ runner: makeRunner({ pg_dump: () => ({ status: 1, stdout: '', stderr: line }) }) })
      expect(r.message.length).toBeLessThanOrEqual(400)
      expect(visible(r), String(before)).not.toMatch(/fake|pass@|word-1/)
      expect(r.message).toContain('xxxxx***yyyyy')
    }
  })

  it('an unexpected error (the folder cannot be made) is a failure with exit code 1, not an exception, and holds no secret', async () => {
    fs.writeFileSync(path.join(tmp, 'a-file'), 'x')
    const r = await go({ options: { out: path.join(tmp, 'a-file', 'sub') } })
    expect(r.exitCode).toBe(1)
    expect(r.errs.some((line) => line.startsWith('backup failed: '))).toBe(true)
    expect(r.runner.calls).toEqual([])
    for (const secret of [PASSWORD, ENCODED, USER, HOST]) expect(r.errs.join('\n')).not.toContain(secret)
  })
})

describe('cleaning a text', () => {
  const scrub = makeScrubber(URL_FAKE)

  it('replaces the address, the password in each form and a postgres address of any kind with ***', () => {
    expect(scrub(`failed for ${URL_FAKE}!`)).toBe('failed for ***!')
    expect(scrub(`a ${PASSWORD} b ${ENCODED} c`)).toBe('a *** b *** c')
    expect(scrub('see postgres://other:pw@elsewhere.example/db?x=1 now')).toBe('see *** now')
    expect(makeScrubber()('see postgresql://other:pw@elsewhere.example/db now')).toBe('see *** now')
  })

  it('shows the host masked, as in the log, and hides the name of a user or a role', () => {
    expect(scrub(`server at ${HOST} failed`)).toBe(`server at ${MASKED_HOST} failed`)
    expect(scrub('password authentication failed for user "someone"')).toBe('password authentication failed for user "***"')
    expect(scrub('role "someone" does not exist')).toBe('role "***" does not exist')
  })

  it('makes one printable line of at most 400 characters', () => {
    expect(scrub('a\nb\r\nc\td')).toBe('a b c d')
    expect(scrub('caf\u00e9')).toBe('caf?')
    expect(scrub('z'.repeat(1000))).toHaveLength(400)
    expect(scrub(undefined)).toBe('')
  })

  it('replaces the folders it is given, in both slash styles, and any other user folder, so no name is printed', () => {
    const clean = makeScrubber(URL_FAKE, [
      ['C:\\Users\\Some One\\Backups\\bqr', '<out dir>'],
      ['C:\\Users\\Some One', '~'],
      ['/tmp', '<temp>'],
    ])
    expect(clean("ENOTDIR: not a directory, mkdir 'C:\\Users\\Some One\\Backups\\bqr'")).toBe(
      "ENOTDIR: not a directory, mkdir '<out dir>'",
    )
    expect(clean("open 'C:/Users/Some One/other/file'")).toBe("open '~/other/file'")
    expect(clean("rm '/tmp/bqr-backup-issue-1/body.md'")).toBe("rm '<temp>/bqr-backup-issue-1/body.md'")
    expect(makeScrubber()("mkdir '/home/someone/backups'")).toBe("mkdir '~/backups'")
    expect(makeScrubber()("stat '/Users/someone/x'")).toBe("stat '~/x'")
    expect(makeScrubber()("open 'D:\\Users\\someone\\x'")).toBe("open '~\\x'")
  })

  it('works without an address, and with one that cannot be parsed', () => {
    expect(makeScrubber()('plain text')).toBe('plain text')
    expect(makeScrubber('not an address')('say not an address twice: not an address')).toBe('say *** twice: ***')
  })
})

// ---- where the address comes from ----------------------------------------------------------------------------------------------------

describe('where the connection string comes from', () => {
  it('BACKUP_DATABASE_URL alone: the Neon CLI is not called at all', async () => {
    const r = await go()
    expect(r.exitCode).toBe(0)
    expect(r.runner.of('neon')).toEqual([])
  })

  it('both BACKUP_DATABASE_URL and --neon-project is refused: nothing is dumped, and neither source wins', async () => {
    seed(oldBackups)
    const r = await go({ options: { neonProject: 'square-term-1', keep: 1 } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(AMBIGUOUS_SOURCE_ERROR)
    expect(r.runner.calls).toEqual([]) // not the Neon CLI, not pg_dump
    expect(workDirsNow()).toEqual([])
    expect(r.files).toEqual(['backup.log', ...oldBackups]) // nothing was rotated
    expect(r.log).toBe(`03/10/2026 10:15 failed host=- error=${AMBIGUOUS_SOURCE_ERROR}\n`)
    expect(AMBIGUOUS_SOURCE_ERROR).toMatch(/use only one of them/)
    for (const secret of [PASSWORD, ENCODED, USER, HOST, 'postgresql://']) expect(visible(r)).not.toContain(secret)
  })

  it('refuses the two sources whatever the order, and takes a blank BACKUP_DATABASE_URL as not given', async () => {
    const blank = await go({ options: { neonProject: 'square-term-1' }, deps: { env: { BACKUP_DATABASE_URL: '   ' } } })
    expect(blank.exitCode).toBe(0)
    expect(blank.runner.of('neon')).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
    const both = await go({ options: { neonProject: 'square-term-1', neonBranch: 'release' } })
    expect(both.exitCode).toBe(1)
    expect(both.message).toBe(AMBIGUOUS_SOURCE_ERROR)
  })

  it('the Neon CLI otherwise, with the project and the branch, and the string stays in memory', async () => {
    const r = await go({ options: { neonProject: 'square-term-1', neonBranch: 'main' }, deps: { env: { BACKUP_DATABASE_URL: '' } } })
    expect(r.exitCode).toBe(0)
    const [neon] = r.runner.of('neon')
    expect(neon.command).toBe('neon')
    expect(neon.args).toEqual(['connection-string', 'main', '--project-id', 'square-term-1'])
    expect(r.runner.of('pg_dump')[0].options.env.PGPASSWORD).toBe(PASSWORD)
    const seen = visible(r)
    for (const secret of [PASSWORD, ENCODED, USER, HOST, 'postgresql://']) expect(seen).not.toContain(secret)
    // and nothing in the folder holds it: the dump is the stub's text, the log is a line without it
    expect(r.files).toEqual(['backup.log', FINAL])
  })

  it('on Windows the Neon CLI goes through cmd.exe /c', async () => {
    const r = await go({
      options: { neonProject: 'square-term-1' },
      deps: { platform: 'win32', exists: () => false, env: { BACKUP_DATABASE_URL: '' } },
    })
    expect(r.exitCode).toBe(0)
    const [neon] = r.runner.of('neon')
    expect(neon.command).toBe('cmd.exe')
    expect(neon.args).toEqual(['/d', '/c', 'neon.cmd', 'connection-string', 'main', '--project-id', 'square-term-1'])
    expect(r.runner.of('pg_dump')[0].command).toBe('pg_dump.exe')
  })

  it('a clear error when there is neither, and nothing is run', async () => {
    const r = await go({ deps: { env: { BACKUP_DATABASE_URL: '  ' } } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toMatch(/BACKUP_DATABASE_URL.*--neon-project/)
    expect(r.runner.calls).toEqual([])
    expect(r.log).toMatch(/ failed host=- error=there is no database to back up/)
  })

  it('says so when the Neon CLI is missing, fails, or prints something else, and never echoes what it printed', async () => {
    const env = { BACKUP_DATABASE_URL: '' }
    const options = { neonProject: 'square-term-1' }
    const missing = await go({ options, deps: { env }, runner: makeRunner({ neon: () => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' }) }) })
    expect(missing.message).toMatch(/Neon CLI was not found/)
    fs.rmSync(dir, { recursive: true, force: true })
    const cmdMissing = await go({
      options,
      deps: { env, platform: 'win32' },
      runner: makeRunner({ neon: () => ({ status: 9009, stdout: '', stderr: "'neon.cmd' is not recognized" }) }),
    })
    expect(cmdMissing.message).toMatch(/Neon CLI was not found/)
    fs.rmSync(dir, { recursive: true, force: true })
    const failed = await go({ options, deps: { env }, runner: makeRunner({ neon: () => ({ status: 1, stdout: '', stderr: 'ERROR: not signed in\nmore' }) }) })
    expect(failed.message).toBe('the Neon CLI failed (exit code 1): ERROR: not signed in')
    fs.rmSync(dir, { recursive: true, force: true })
    const odd = await go({ options, deps: { env }, runner: makeRunner({ neon: () => ({ status: 0, stdout: 'TOP-SECRET-TEXT\n', stderr: '' }) }) })
    expect(odd.message).toBe('the Neon CLI did not print a connection string')
    expect(visible(odd)).not.toContain('TOP-SECRET-TEXT')
    fs.rmSync(dir, { recursive: true, force: true })
    const slow = await go({ options, deps: { env }, runner: makeRunner({ neon: () => ({ status: null, stdout: '', stderr: '', problem: 'TIMEOUT' }) }) })
    expect(slow.message).toMatch(/did not finish/)
    for (const r of [missing, cmdMissing, failed, odd, slow]) {
      expect(r.exitCode).toBe(1)
      expect(r.runner.of('pg_dump')).toEqual([])
    }
  })

  it('refuses the pooled string before pg_dump runs, and says why', async () => {
    const r = await go({ deps: { env: { BACKUP_DATABASE_URL: POOLED } } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toMatch(/pooled.*direct connection string/)
    expect(r.runner.of('pg_dump')).toEqual([])
    expect(r.files).toEqual(['backup.log'])
    expect(r.log).toContain(` failed host=${MASKED_HOST} error=the connection string is the pooled one`)
    for (const secret of [PASSWORD, ENCODED, USER, 'postgresql://']) expect(visible(r)).not.toContain(secret)
  })

  it('refuses an address that is not a postgres address, without repeating it', async () => {
    const r = await go({ deps: { env: { BACKUP_DATABASE_URL: 'https://user:hunter2@example.com/db' } } })
    expect(r.exitCode).toBe(1)
    expect(r.runner.calls).toEqual([])
    expect(visible(r)).not.toContain('hunter2')
  })
})

// ---- a backup that fails -------------------------------------------------------------------------------------------------------------

describe('a failing pg_dump', () => {
  it('deletes the temporary file, does not rotate, and exits 1', async () => {
    seed(oldBackups)
    const runner = makeRunner({
      pg_dump: ({ args, options }) => {
        fs.writeFileSync(path.join(options.cwd, args[args.indexOf('--file') + 1]), 'half a dump')
        return { status: 1, stdout: '', stderr: 'pg_dump: error: server closed the connection unexpectedly\nmore detail' }
      },
    })
    const r = await go({ options: { keep: 1 }, runner })
    expect(r.exitCode).toBe(1)
    expect(r.ok).toBe(false)
    expect(r.files).toEqual([...oldBackups, 'backup.log'].sort())
    expect(r.runner.of('pg_restore')).toEqual([])
    expect(r.out).toEqual([])
    expect(r.errs).toEqual(['backup failed: pg_dump failed (exit code 1): pg_dump: error: server closed the connection unexpectedly'])
    expect(r.log).toBe(
      `03/10/2026 10:15 failed host=${MASKED_HOST} error=pg_dump failed (exit code 1): pg_dump: error: server closed the connection unexpectedly\n`,
    )
  })

  it('says so when pg_dump is not installed, and when it takes too long', async () => {
    const missing = await go({ runner: makeRunner({ pg_dump: () => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' }) }) })
    expect(missing.exitCode).toBe(1)
    expect(missing.message).toMatch(/pg_dump was not found.*--pg-bin.*PG_BIN/)
    fs.rmSync(dir, { recursive: true, force: true })
    const slow = await go({ runner: makeRunner({ pg_dump: () => ({ status: null, stdout: '', stderr: '', problem: 'TIMEOUT' }) }) })
    expect(slow.message).toBe('pg_dump did not finish in time')
    expect(slow.files).toEqual(['backup.log'])
  })

  it('is a failure when the runner itself throws, never an exception', async () => {
    const r = await go({
      runner: makeRunner({
        pg_dump: () => {
          throw new Error(`boom ${URL_FAKE}`)
        },
      }),
    })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('boom ***')
  })
})

describe('a dump that does not hold the data', () => {
  const listing = (...lines) => ({ pg_restore: () => ({ status: 0, stdout: [';', ...lines].join('\n'), stderr: '' }) })

  it('fails when the list has no scans, deletes the file, does not rotate', async () => {
    seed(oldBackups)
    const r = await go({ options: { keep: 1 }, runner: makeRunner(listing('1; 0 1 TABLE DATA public points x', '2; 0 2 TABLE DATA public providers x')) })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('the dump does not hold the data of the table scans')
    expect(r.files).toEqual([...oldBackups, 'backup.log'].sort())
  })

  it('fails when the list has no points', async () => {
    const r = await go({ runner: makeRunner(listing('1; 0 1 TABLE DATA public scans x')) })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('the dump does not hold the data of the table points')
    expect(r.files).toEqual(['backup.log'])
  })

  it('does not take a look-alike for scans: another schema, another table, only the table definition', async () => {
    const r = await go({
      runner: makeRunner(
        listing(
          '1; 0 1 TABLE DATA public scans_archive x',
          '2; 0 2 TABLE DATA other scans x',
          '3; 1259 3 TABLE public scans x',
          '4; 0 4 TABLE DATA public points x',
        ),
      ),
    })
    expect(r.exitCode).toBe(1)
    expect(r.message).toMatch(/table scans$/)
  })

  it('fails when the list says both are missing', async () => {
    const r = await go({ runner: makeRunner(listing()) })
    expect(r.message).toBe('the dump does not hold the data of the table scans and points')
  })

  it('fails when pg_restore --list fails (a file that is not a dump), and does not repeat what it said about the file', async () => {
    seed(oldBackups)
    const r = await go({
      options: { keep: 1 },
      runner: makeRunner({ pg_restore: () => ({ status: 1, stdout: '', stderr: 'pg_restore: error: input file does not appear to be a valid archive' }) }),
    })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('the dump could not be read back with pg_restore --list (exit code 1): pg_restore: error: input file does not appear to be a valid archive')
    expect(r.files).toEqual([...oldBackups, 'backup.log'].sort())
  })

  it('fails when pg_restore is not installed', async () => {
    const r = await go({ runner: makeRunner({ pg_restore: () => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' }) }) })
    expect(r.message).toMatch(/pg_restore was not found/)
    expect(r.files).toEqual(['backup.log'])
  })
})

// ---- retention -----------------------------------------------------------------------------------------------------------------------

describe('retention', () => {
  it('keeps the newest --keep files, counting the new one, and leaves every other file in the folder alone', async () => {
    const others = [
      'notes.txt',
      'building-qr-20260101T0000Z.dump.bak',
      'building-qr-latest.dump',
      'Building-QR-20250101T0000Z.dump',
      'building-qr-20250101T0000Z.partial.dump',
    ]
    seed([...oldBackups, ...others])
    fs.mkdirSync(path.join(dir, 'building-qr-20250102T0000Z.dump')) // a folder with a matching name is not a backup
    const r = await go({ options: { keep: 3 } })
    expect(r.exitCode).toBe(0)
    expect(r.files).toEqual(
      [FINAL, 'backup.log', 'building-qr-20250102T0000Z.dump', 'building-qr-20260904T0000Z.dump', 'building-qr-20260905T0000Z.dump', ...others].sort(),
    )
    expect(r.out).toEqual([`backup ok: ${FINAL}, 15 B, removed 3 old files`])
    expect(r.log).toContain(' removed=3')
    expect(fs.statSync(path.join(dir, 'building-qr-20250102T0000Z.dump')).isDirectory()).toBe(true)
  })

  it('with --keep 1 leaves only the new backup', async () => {
    seed(oldBackups)
    const r = await go({ options: { keep: 1 } })
    expect(r.files).toEqual(['backup.log', FINAL])
    expect(r.out[0]).toMatch(/removed 5 old files$/)
  })

  it('says "1 old file" for one', async () => {
    seed(oldBackups.slice(0, 2))
    const r = await go({ options: { keep: 2 } })
    expect(r.out[0]).toMatch(/removed 1 old file$/)
  })

  it('does not count a backup dated in the future, and does not delete it: the new dump is kept, with a warning', async () => {
    seed(['building-qr-20990101T0000Z.dump', 'building-qr-20980101T0000Z.dump', ...oldBackups.slice(0, 2)])
    const r = await go({ options: { keep: 2 } })
    expect(r.exitCode).toBe(0)
    // the newest two of [the new dump, 02 September, 01 September] are kept; the two from the future are left as they are
    expect(r.files).toEqual(
      ['backup.log', FINAL, 'building-qr-20260902T0000Z.dump', 'building-qr-20980101T0000Z.dump', 'building-qr-20990101T0000Z.dump'].sort(),
    )
    expect(r.removed).toBe(1)
    expect(r.warning).toBe('2-backups-dated-in-the-future-ignored')
  })

  it('deletes nothing when there are fewer files than --keep', async () => {
    seed(oldBackups.slice(0, 2))
    const r = await go({ options: { keep: 30 } })
    expect(r.files).toEqual([FINAL, 'backup.log', ...oldBackups.slice(0, 2)].sort())
    expect(r.out[0]).toMatch(/removed 0 old files$/)
  })
})

// ---- runs that finish in the opposite order of their start --------------------------------------------------------------------------

describe('retention when a run that started earlier finishes later', () => {
  const T0715 = new Date('2026-10-03T07:15:42Z')
  const T0716 = new Date('2026-10-03T07:16:10Z')
  const END = new Date('2026-10-03T07:20:00Z')
  const A = 'building-qr-20261003T0715Z.dump' // the older run
  const B = 'building-qr-20261003T0716Z.dump' // the newer run
  /** The clock of a run: its start the first time it is asked, and a later time (the end of the run) after that. */
  const clockOf = (start, end = END) => {
    let first = true
    return () => {
      if (!first) return end
      first = false
      return start
    }
  }
  const backupsLeft = () => fs.readdirSync(dir).filter((name) => BACKUP_NAME.test(name)).sort()

  /** Two overlapping runs: A starts first and is slow, B starts a minute later and finishes first. */
  async function overlapping(keep, seeded = []) {
    seed(seeded)
    const slowDump = async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return defaults.pg_dump(call)
    }
    const [a, b] = await Promise.all([
      go({ options: { keep }, runner: makeRunner({ pg_dump: slowDump }), deps: { now: clockOf(T0715) } }),
      go({ options: { keep }, deps: { now: clockOf(T0716) } }),
    ])
    return { a, b }
  }

  it('with --keep 1 the run that finishes last does not delete the newer dump: it removes its own, and still ends with 0', async () => {
    const { a, b } = await overlapping(1)
    expect(b.exitCode).toBe(0)
    expect(b.removed).toBe(0) // when B finished, A was not there yet
    expect(a.exitCode).toBe(0) // a newer verified dump exists
    expect(a.ok).toBe(true)
    expect(a.removed).toBe(1)
    expect(a.warning).toBe('own-dump-older-than-kept')
    expect(backupsLeft()).toEqual([B])
    expect(a.log.split('\n').filter(Boolean).at(-1)).toContain(`file=${A} size=15 removed=1 warning=own-dump-older-than-kept`)
    expect(a.out).toEqual([`backup ok: ${A}, 15 B, removed 1 old file`])
    expect(a.errs).toEqual(['backup: warning, own-dump-older-than-kept'])
    expect(b.errs).toEqual([])
  })

  it('with --keep 2 both dumps stay, and the oldest of the older backups goes', async () => {
    const { a, b } = await overlapping(2, oldBackups.slice(0, 3))
    expect(a.exitCode).toBe(0)
    expect(b.exitCode).toBe(0)
    expect(backupsLeft()).toEqual([A, B])
    expect(a.warning).toBeUndefined() // its own file is among the newest two
    expect(a.removed + b.removed).toBe(3) // the three older ones, 03 September and before
  })

  it('with --keep 2 and two newer dumps already there, a late older run cannot push one of them out', async () => {
    const newer = ['building-qr-20261003T0717Z.dump', 'building-qr-20261003T0718Z.dump']
    seed([...newer, ...oldBackups.slice(0, 2)])
    const r = await go({ options: { keep: 2 }, deps: { now: clockOf(T0715) } })
    expect(r.exitCode).toBe(0)
    expect(backupsLeft()).toEqual(newer) // the old rule kept the new file and deleted the 07:17 dump
    expect(r.removed).toBe(3) // its own file and the two of September
    expect(r.warning).toBe('own-dump-older-than-kept')
  })

  it('in the normal case (the new dump is the newest) nothing changes: the newest --keep are kept, no warning', async () => {
    seed(oldBackups)
    const r = await go({ options: { keep: 3 } })
    expect(backupsLeft()).toEqual([FINAL, 'building-qr-20260904T0000Z.dump', 'building-qr-20260905T0000Z.dump'].sort())
    expect(r.removed).toBe(3)
    expect(r.warning).toBeUndefined()
  })

  it('a second run of the same minute replaces the file of the first and removes nothing else that is kept', async () => {
    const first = await go({ options: { keep: 1 }, deps: { now: clockOf(T0715) } })
    const second = await go({ options: { keep: 1 }, deps: { now: clockOf(T0715) } })
    expect(first.warning).toBeUndefined()
    expect(second.warning).toBeUndefined()
    expect(backupsLeft()).toEqual([A])
  })

  it('treats a dump of a later minute than now as a wrong clock, not as a newer dump (a frozen clock makes it one)', async () => {
    seed([B])
    const r = await go({ options: { keep: 1 }, deps: { now: () => T0715 } }) // now is 07:15 and 07:16 has not come yet
    expect(backupsLeft()).toEqual([A, B])
    expect(r.warning).toBe('1-backups-dated-in-the-future-ignored')
  })
})

// ---- the marker: only a dump of a production database is kept --------------------------------------------------------------------------

describe('the marker of the dump', () => {
  /** A runner whose pg_restore answers the marker call with `sql` (or with `answer`, a whole result) and the others as usual. */
  const withMarker = (sql, answer) =>
    makeRunner({ pg_restore: (call) => (isMarkerCall(call) ? (answer ?? { status: 0, stdout: sql, stderr: '' }) : defaults.pg_restore(call)) })

  describe('reading the values out of the SQL of the dump', () => {
    it('reads a production marker, and a non-production one', () => {
      expect(parseMarkerValues(markerSql('production'))).toEqual(['production'])
      expect(parseMarkerValues(markerSql('nonprod'))).toEqual(['nonprod'])
    })

    it('trims and lowers the case, like the guard does, and reads every row', () => {
      expect(parseMarkerValues(markerSql(' Production '))).toEqual(['production'])
      expect(parseMarkerValues(markerSql('nonprod', 'PRODUCTION'))).toEqual(['nonprod', 'production'])
      expect(parseMarkerValues(markerSql('production').replace(/\n/g, '\r\n'))).toEqual(['production'])
    })

    it('gives an empty list for a table without rows, and null for a dump that has no such table', () => {
      expect(parseMarkerValues(markerSql())).toEqual([])
      expect(parseMarkerValues(NO_MARKER_SQL)).toBeNull()
      expect(parseMarkerValues('')).toBeNull()
      expect(parseMarkerValues(undefined)).toBeNull()
    })

    it('is not fooled by another table, or by a row that only looks like a COPY block', () => {
      expect(parseMarkerValues('COPY public.points (id, name) FROM stdin;\n1\tproduction\n\\.\n')).toBeNull()
      expect(parseMarkerValues('COPY other.environment_marker (environment) FROM stdin;\nproduction\n\\.\n')).toBeNull()
      // a value that is in the data of another table, after the end of the marker rows, does not count
      expect(parseMarkerValues(`${markerSql('nonprod')}\nCOPY public.x (a) FROM stdin;\nproduction\n\\.\n`)).toEqual(['nonprod'])
    })

    it('finds the column by its name when the table has more columns, and ignores a table without the column', () => {
      const wide = 'COPY public.environment_marker (set_at, environment) FROM stdin;\n2026-10-03\tproduction\n\\.\n'
      expect(parseMarkerValues(wide)).toEqual(['production'])
      expect(parseMarkerValues('COPY public.environment_marker (kind) FROM stdin;\nproduction\n\\.\n')).toEqual([])
    })
  })

  describe('the message of a refusal', () => {
    it('says what the marker holds, as short labels, and what to check', () => {
      expect(notProductionMessage(null)).toMatch(/public\.environment_marker is missing\)/)
      expect(notProductionMessage([])).toMatch(/public\.environment_marker is empty\)/)
      expect(notProductionMessage(['nonprod'])).toMatch(/public\.environment_marker says "nonprod"\)/)
      expect(notProductionMessage(['nonprod', 'staging'])).toMatch(/says "nonprod" and "staging"\)/)
      expect(notProductionMessage(['a b c'])).toMatch(/says something else\)/) // only a label is shown, never free text
      for (const values of [null, [], ['nonprod']]) {
        const message = notProductionMessage(values)
        expect(message).toMatch(/--neon-project and --neon-branch/)
        expect(message).toMatch(/BACKUP_DATABASE_URL/)
        expect(message).toMatch(/was not kept/)
        expect(message).not.toMatch(/postgres|neon\.tech|[A-Za-z]:\\|\/Users\//)
      }
    })
  })

  describe('in a run', () => {
    it('keeps a dump whose marker says production, after the full read and before it is moved, from the dump itself', async () => {
      let finalDuringCheck
      const runner = makeRunner({
        pg_restore: (call) => {
          if (!isMarkerCall(call)) return defaults.pg_restore(call)
          finalDuringCheck = fs.existsSync(path.join(dir, FINAL))
          return defaults.pg_restore(call)
        },
      })
      const r = await go({ runner })
      expect(r.exitCode).toBe(0)
      const [list, full, mark] = r.runner.of('pg_restore')
      expect(list.args[0]).toBe('--list')
      expect(full.args).toEqual(['--file=/dev/null', PARTIAL])
      expect(mark.command).toBe('pg_restore')
      expect(mark.args).toEqual(['--data-only', '--schema=public', '--table=environment_marker', '--file=-', PARTIAL])
      expectWorkCwd(mark.options.cwd) // the dump in the work directory, not a second connection to the database
      expect(Object.keys(mark.options.env).filter((key) => /^PG[A-Z]/.test(key))).toEqual([])
      expect(finalDuringCheck).toBe(false) // nothing was moved yet
      expect(r.runner.of('neon')).toEqual([]) // and no other connection was made
      expect(r.files).toEqual(['backup.log', FINAL])
    })

    it('accepts a marker with a production row among others, like the guard (one production row is enough)', async () => {
      const r = await go({ runner: withMarker(markerSql('nonprod', 'production')) })
      expect(r.exitCode).toBe(0)
    })

    const refusals = {
      'a dump without the marker table': [withMarker(NO_MARKER_SQL), null],
      'a dump whose marker says nonprod': [withMarker(markerSql('nonprod')), ['nonprod']],
      'a dump whose marker table is empty': [withMarker(markerSql()), []],
      'a dump whose marker says something else': [withMarker(markerSql('staging')), ['staging']],
    }
    for (const [what, [runner, values]] of Object.entries(refusals)) {
      it(`refuses ${what}: nothing is kept, moved or rotated, and the failure is logged`, async () => {
        seed(oldBackups)
        const r = await go({ options: { keep: 1, reportIssue: 'owner/repo' }, runner })
        expect(r.exitCode).toBe(1)
        expect(r.message).toBe(notProductionMessage(values))
        expect(r.files).toEqual(['backup.log', ...oldBackups]) // no new file, and the five old dumps are all still there
        expect(workDirsNow()).toEqual([]) // the dump in the work directory is deleted
        expect(r.log).toBe(`03/10/2026 10:15 failed host=${MASKED_HOST} issue=opened error=${r.message}\n`)
        expect(r.issue).toBe('opened') // the committee is told, like for any other failure
        expect(r.errs).toContain(`backup failed: ${r.message}`)
        for (const secret of [PASSWORD, ENCODED, USER, HOST, 'postgresql://']) expect(visible(r)).not.toContain(secret)
      })
    }

    it('is checked before the dump is renamed, so the old backups of the real database are never rotated by the wrong one', async () => {
      // the story of the finding: a stale BACKUP_DATABASE_URL points at a non-production database that has scans and points
      seed(oldBackups)
      const first = await go({ options: { keep: 5 }, runner: withMarker(markerSql('nonprod')) })
      expect(first.exitCode).toBe(1)
      expect(backupFilesIn(dir)).toEqual(oldBackups) // every real dump survives, as often as the task runs
      fs.rmSync(path.join(dir, 'backup.log'))
      const second = await go({ options: { keep: 1 }, runner: withMarker(markerSql('nonprod')) })
      expect(second.exitCode).toBe(1)
      expect(backupFilesIn(dir)).toEqual(oldBackups)
    })

    it('fails when the marker cannot be read at all: pg_restore fails, is missing, or takes too long', async () => {
      const answers = [
        [{ status: 1, stdout: '', stderr: 'pg_restore: error: out of memory' }, 'the marker of the dump could not be read with pg_restore (exit code 1): pg_restore: error: out of memory'],
        [{ status: null, stdout: '', stderr: '', problem: 'ENOENT' }, 'pg_restore was not found: install the PostgreSQL 18 client tools, then pass --pg-bin <folder> or set PG_BIN'],
        [{ status: null, stdout: '', stderr: '', problem: 'TIMEOUT' }, 'pg_restore did not finish in time'],
      ]
      for (const [answer, message] of answers) {
        fs.rmSync(dir, { recursive: true, force: true })
        const r = await go({ runner: withMarker('', answer) })
        expect(r.exitCode, message).toBe(1)
        expect(r.message).toBe(message)
        expect(r.files).toEqual(['backup.log'])
        expect(workDirsNow()).toEqual([])
      }
    })

    it('is not run when an earlier check failed: one reason is enough, and the marker of a broken dump means nothing', async () => {
      const noScans = makeRunner({ pg_restore: () => ({ status: 0, stdout: '3563; 0 24869 TABLE DATA public points x', stderr: '' }) })
      const r = await go({ runner: noScans })
      expect(r.exitCode).toBe(1)
      expect(r.runner.of('pg_restore').filter(isMarkerCall)).toEqual([])
      fs.rmSync(dir, { recursive: true, force: true })
      const cut = makeRunner({ pg_restore: (call) => (call.args[0] === '--list' ? defaults.pg_restore(call) : { status: 1, stdout: '', stderr: 'cut' }) })
      const r2 = await go({ runner: cut })
      expect(r2.exitCode).toBe(1)
      expect(r2.runner.of('pg_restore').filter(isMarkerCall)).toEqual([])
    })

    it('does not print the connection string or the host in the refusal, whatever the address is', async () => {
      const r = await go({ runner: withMarker(markerSql('nonprod')), deps: { env: { BACKUP_DATABASE_URL: POOLED.replace('-pooler', '') } } })
      expect(r.exitCode).toBe(1)
      for (const text of [HOST, 'ep-test-cool', PASSWORD, ENCODED, USER, 'postgresql://']) expect(visible(r)).not.toContain(text) // (the log has the masked host, by design)
    })
  })
})

// ---- the log ---------------------------------------------------------------------------------------------------------------------------

describe('backup.log', () => {
  it('gets one line per run: the UTC time, ok, the masked host, the file and its size', async () => {
    const first = await go()
    expect(first.log).toBe(`03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0\n`)
    const later = new Date('2026-10-04T07:15:03Z')
    const second = await go({ deps: { now: () => later } })
    expect(second.log.split('\n').filter(Boolean)).toEqual([
      `03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0`,
      `04/10/2026 10:15 ok host=${MASKED_HOST} file=building-qr-20261004T0715Z.dump size=15 removed=0`,
    ])
  })

  it('also gets a line for a failed run, after the ok lines of the runs before it, and never holds a secret', async () => {
    await go()
    const r = await go({
      deps: { now: () => new Date('2026-10-04T07:15:03Z') },
      runner: makeRunner({ pg_dump: () => ({ status: 2, stdout: '', stderr: `bad ${URL_FAKE}` }) }),
    })
    const lines = r.log.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(`04/10/2026 10:15 failed host=${MASKED_HOST} error=pg_dump failed (exit code 2): bad ***`)
    for (const secret of [PASSWORD, ENCODED, USER, HOST, 'postgresql://']) expect(r.log).not.toContain(secret)
  })

  it('refuses a backup.log that is a folder: nothing is dumped, and the message says what to do', async () => {
    fs.mkdirSync(path.join(dir, 'backup.log'), { recursive: true }) // a folder where the log should be
    const r = await go()
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(LOG_NOT_REGULAR_ERROR)
    expect(r.runner.calls).toEqual([])
    expect(r.errs).toEqual([`backup failed: ${LOG_NOT_REGULAR_ERROR}`])
    expect(r.files).toEqual(['backup.log'])
  })

  it('formats a size the way a person reads it', () => {
    expect(formatSize(15)).toBe('15 B')
    expect(formatSize(26942)).toBe('26.3 KB')
    expect(formatSize(5 * 1024 * 1024 + 300 * 1024)).toBe('5.3 MB')
  })
})

// ---- the issue -------------------------------------------------------------------------------------------------------------------------------

/** A gh stub: one answer per subcommand (list, comment, create); the first two default to "no open issue" and "done". */
function ghBy({ list, comment, create } = {}) {
  const handlers = {
    list: list ?? (() => ({ status: 0, stdout: '[]', stderr: '' })),
    comment: comment ?? (() => ({ status: 0, stdout: 'https://github.com/owner/repo/issues/1#issuecomment-1\n', stderr: '' })),
    create: create ?? (() => ({ status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' })),
  }
  return (call) => handlers[call.args[1]](call)
}

const ghCalls = (r, subcommand) => r.runner.of('gh').filter((call) => call.args[1] === subcommand)
const bodyOf = (call) => call.args[call.args.indexOf('--body') + 1]
const listing = (...items) => ({ status: 0, stdout: JSON.stringify(items), stderr: '' })

describe('finding the open issue', () => {
  it('takes the number of the open issue with exactly the title, the newest when there are several', () => {
    expect(findOpenIssue(JSON.stringify([{ number: 7, title: ISSUE_TITLE }]))).toBe(7)
    expect(
      findOpenIssue(JSON.stringify([{ number: 3, title: ISSUE_TITLE }, { number: 12, title: ISSUE_TITLE }, { number: 9, title: ISSUE_TITLE }])),
    ).toBe(12)
  })

  it('does not take a look-alike: GitHub search is fuzzy, so the title is compared letter for letter', () => {
    const items = [
      { number: 20, title: 'Daily database backup failed again' },
      { number: 21, title: 'daily database backup failed' },
      { number: 22, title: ` ${ISSUE_TITLE}` },
      { number: 23, title: 'Smoke test failed after deploying abc1234' },
      { number: 24, title: null },
      { number: 25 },
    ]
    expect(findOpenIssue(JSON.stringify(items))).toBeNull()
    expect(findOpenIssue(JSON.stringify([...items, { number: 4, title: ISSUE_TITLE }]))).toBe(4)
  })

  it('takes only a real issue number, and gives null for anything that is not that JSON', () => {
    for (const number of ['5', 0, -1, 1.5, null, 2 ** 60]) {
      expect(findOpenIssue(JSON.stringify([{ number, title: ISSUE_TITLE }])), String(number)).toBeNull()
    }
    for (const text of ['', 'not json', '{}', '"x"', 'null', '[]', undefined, '{"number":1,"title":"Daily database backup failed"}']) {
      expect(findOpenIssue(text), String(text)).toBeNull()
    }
  })
})

describe('the issue after a failure', () => {
  const failing = (extra = {}) =>
    makeRunner({
      pg_dump: () => ({ status: 1, stdout: '', stderr: `UNIQUE-ERROR-TEXT for user "${USER}" at ${HOST}` }),
      ...extra,
    })

  it('looks for an open issue with the title first, with the repository, the state and the exact search', async () => {
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner: failing({ gh: ghBy() }) })
    const [list] = ghCalls(r, 'list')
    expect(list.command).toBe('gh')
    expect(list.args).toEqual([
      'issue', 'list', '--repo', 'owner/repo', '--state', 'open', '--search', '"Daily database backup failed" in:title',
      '--json', 'number,title', '--limit', '100',
    ])
    expect(r.runner.of('gh')[0]).toBe(list)
  })

  it('opens a new issue when none is open: the title, the bug label and the body in the argument (no file, no temp folder)', async () => {
    let body
    const runner = failing({
      gh: ghBy({
        create: (call) => {
          body = bodyOf(call)
          return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' }
        },
      }),
    })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(r.exitCode).toBe(1)
    expect(ghCalls(r, 'comment')).toEqual([])
    const [create] = ghCalls(r, 'create')
    expect(create.command).toBe('gh')
    expect(create.args).toEqual(['issue', 'create', '--repo', 'owner/repo', '--title', ISSUE_TITLE, '--label', 'bug', '--body', body])
    expect(ISSUE_TITLE).toBe('Daily database backup failed')
    expect(body).toBe(issueBody(NOW))
    expect(create.args).not.toContain('--body-file')
    expect(body).toContain('03/10/2026 07:15 (UTC)')
    expect(body).toContain('backup.log')
    expect(r.issue).toBe('opened')
    expect(r.log).toContain(' issue=opened error=pg_dump failed')
    expect(r.errs).toContain('backup: an issue was opened')
  })

  it('adds a comment to the open issue instead of opening another one, with the same text', async () => {
    let commentBody
    const runner = failing({
      gh: ghBy({
        list: () => listing({ number: 7, title: ISSUE_TITLE }),
        comment: (call) => {
          commentBody = bodyOf(call)
          return { status: 0, stdout: '', stderr: '' }
        },
      }),
    })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(r.exitCode).toBe(1)
    expect(ghCalls(r, 'create')).toEqual([])
    const [comment] = ghCalls(r, 'comment')
    expect(comment.args).toEqual(['issue', 'comment', '7', '--repo', 'owner/repo', '--body', commentBody])
    expect(commentBody).toBe(issueBody(NOW))
    expect(r.issue).toBe('commented-7')
    expect(r.log).toContain(' issue=commented-7 error=pg_dump failed')
    expect(r.errs).toContain('backup: a comment was added to the open issue 7')
  })

  it('comments on the newest of several open issues, and only on one with exactly the title', async () => {
    const runner = failing({
      gh: ghBy({
        list: () =>
          listing(
            { number: 31, title: 'Daily database backup failed again' },
            { number: 12, title: ISSUE_TITLE },
            { number: 30, title: ISSUE_TITLE },
            { number: 40, title: 'daily database backup failed' },
          ),
      }),
    })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(r.issue).toBe('commented-30')
    expect(ghCalls(r, 'comment')[0].args[2]).toBe('30')
    expect(ghCalls(r, 'create')).toEqual([])
  })

  it('opens a new issue when the open issues are only look-alikes', async () => {
    const runner = failing({ gh: ghBy({ list: () => listing({ number: 5, title: 'Daily database backup failed again' }) }) })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(r.issue).toBe('opened')
    expect(ghCalls(r, 'comment')).toEqual([])
    expect(ghCalls(r, 'create')).toHaveLength(1)
  })

  it('opens a new issue when the search fails, answers nonsense or takes too long: a duplicate is better than silence', async () => {
    const searches = {
      'an exit code': () => ({ status: 1, stdout: '', stderr: 'gh: HTTP 502' }),
      'not JSON': () => ({ status: 0, stdout: 'Showing 0 of 0 issues', stderr: '' }),
      'JSON that is not a list': () => ({ status: 0, stdout: '{"message":"rate limit"}', stderr: '' }),
      'a time out': () => ({ status: null, stdout: '', stderr: '', problem: 'TIMEOUT' }),
    }
    for (const [what, list] of Object.entries(searches)) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ options: { reportIssue: 'owner/repo' }, runner: failing({ gh: ghBy({ list }) }) })
      expect(r.issue, what).toBe('opened')
      expect(ghCalls(r, 'comment'), what).toEqual([])
      expect(ghCalls(r, 'create'), what).toHaveLength(1)
      expect(r.exitCode).toBe(1)
    }
  })

  it('opens a new issue when the comment cannot be added (a locked issue, no rights)', async () => {
    const runner = failing({
      gh: ghBy({
        list: () => listing({ number: 7, title: ISSUE_TITLE }),
        comment: () => ({ status: 1, stdout: '', stderr: 'gh: Conversation is locked' }),
      }),
    })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(ghCalls(r, 'comment')).toHaveLength(1)
    expect(ghCalls(r, 'create')).toHaveLength(1)
    expect(r.issue).toBe('opened')
  })

  it('says nothing about a path, a host or the error: no data, not even the name of a person, in an issue or a comment', async () => {
    const bodies = {}
    const capture = (name) => (call) => {
      bodies[name] = bodyOf(call)
      return { status: 0, stdout: '', stderr: '' }
    }
    await go({ options: { reportIssue: 'owner/repo' }, runner: failing({ gh: ghBy({ create: capture('issue') }) }) })
    fs.rmSync(dir, { recursive: true, force: true })
    await go({
      options: { reportIssue: 'owner/repo' },
      runner: failing({ gh: ghBy({ list: () => listing({ number: 7, title: ISSUE_TITLE }), comment: capture('comment') }) }),
    })
    const forbidden = [
      dir, tmp, path.basename(tmp), os.tmpdir(), os.homedir(), path.basename(os.homedir()),
      HOST, MASKED_HOST, 'ep-tes', 'neon.tech', USER, PASSWORD, 'postgres', 'UNIQUE-ERROR-TEXT', 'pg_dump', 'exit code', FINAL, 'appdb',
    ]
    for (const name of ['issue', 'comment']) {
      expect(bodies[name], name).toBe(issueBody(NOW))
      for (const text of forbidden) expect(bodies[name], `${name}: ${text}`).not.toContain(text)
    }
  })

  it('needs no file and no temp folder: it writes nothing, whatever the file system does', async () => {
    const written = []
    const files = {
      ...fs,
      statSync: privateStat,
      mkdtempSync: (prefix, ...rest) => {
        written.push(`mkdtemp ${path.basename(String(prefix))}`)
        return fs.mkdtempSync(prefix, ...rest)
      },
      writeFileSync: (target, data, options) => {
        written.push(`write ${path.basename(String(target))}`)
        return fs.writeFileSync(target, data, options)
      },
    }
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner: failing({ gh: ghBy() }), deps: { fs: files } })
    expect(r.issue).toBe('opened')
    expect(written).toEqual([`mkdtemp ${WORK_PREFIX}`, `write ${PARTIAL}`]) // the work directory and its file, and nothing for the issue
  })

  it('is built from the time alone, so an error text cannot get into it', () => {
    expect(issueBody.length).toBe(1)
    const body = issueBody(new Date('2026-01-31T23:59:00Z'))
    expect(body).toContain('31/01/2026 23:59 (UTC)')
    expect(body).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//)
  })

  it('is not opened for a good backup, and not when --report-issue is not given', async () => {
    const good = await go({ options: { reportIssue: 'owner/repo' } })
    expect(good.runner.of('gh')).toEqual([])
    expect(good.log).not.toContain('issue=')
    fs.rmSync(dir, { recursive: true, force: true })
    const noOption = await go({ runner: failing() })
    expect(noOption.exitCode).toBe(1)
    expect(noOption.runner.of('gh')).toEqual([])
    expect(noOption.log).not.toContain('issue=')
  })

  it('is only logged when gh is missing: the run still ends with 1 and does not throw, and nothing else is tried', async () => {
    const runner = failing({ gh: () => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' }) })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(r.exitCode).toBe(1)
    expect(r.issue).toBe('gh-missing')
    expect(r.runner.of('gh')).toHaveLength(1)
    expect(r.log).toMatch(/ failed host=\S+ issue=gh-missing error=/)
    expect(r.errs).toContain('backup: no issue opened, the gh CLI was not found')
  })

  it('is only logged when gh is missing at the last step too', async () => {
    const runner = failing({ gh: ghBy({ create: () => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' }) }) })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(r.issue).toBe('gh-missing')
    expect(r.exitCode).toBe(1)
  })

  it('is only logged when gh fails (not signed in, no such label), or throws', async () => {
    const failed = await go({
      options: { reportIssue: 'owner/repo' },
      runner: failing({ gh: () => ({ status: 1, stdout: '', stderr: 'gh: not logged in' }) }),
    })
    expect(failed.exitCode).toBe(1)
    expect(failed.issue).toBe('failed')
    expect(failed.log).toContain(' issue=failed ')
    expect(failed.errs).toContain('backup: no issue opened, gh failed')
    fs.rmSync(dir, { recursive: true, force: true })
    const threw = await go({
      options: { reportIssue: 'owner/repo' },
      runner: failing({
        gh: () => {
          throw new Error('spawn failed')
        },
      }),
    })
    expect(threw.exitCode).toBe(1)
    expect(threw.issue).toBe('failed')
    expect(threw.errs).toContain('backup: no issue opened, gh failed')
  })

  it('does not hand a connection string or a PG variable to gh, in any of its calls', async () => {
    const runner = failing({ gh: ghBy({ list: () => listing({ number: 7, title: ISSUE_TITLE }) }) })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner, deps: { env: { PGHOST: 'x', GH_TOKEN: 'token-for-gh' } } })
    expect(r.runner.of('gh').length).toBeGreaterThanOrEqual(2)
    for (const gh of r.runner.of('gh')) {
      expect(gh.options.env.GH_TOKEN).toBe('token-for-gh')
      expect('BACKUP_DATABASE_URL' in gh.options.env).toBe(false)
      expect('PGHOST' in gh.options.env).toBe(false)
    }
  })
})

/** An fs that records mkdir, chmod and appendFile calls, and says what the stat of the backup folder says. */
function recordingFs({ folderMode = 0o040700, workMode = 0o040700, fileMode = 0o100600, failChmod = false, events = [] } = {}) {
  const same = (p) => path.resolve(String(p)) === path.resolve(dir)
  return {
    events,
    chmods: [],
    appends: [],
    mkdirs: [],
    mkdtemps: [],
    get fs() {
      const self = this
      return {
        ...fs,
        mkdirSync: (p, o) => {
          events.push('mkdir')
          self.mkdirs.push({ folder: same(p), options: o })
          return fs.mkdirSync(p, o)
        },
        mkdtempSync: (prefix, ...rest) => {
          events.push('mkdtemp')
          self.mkdtemps.push(String(prefix))
          return fs.mkdtempSync(prefix, ...rest)
        },
        statSync: (p, ...rest) =>
          same(p) ? { mode: folderMode, uid: UID } : isWorkDir(p) ? { mode: workMode, uid: UID } : fileStat(p, ...rest).mode === 0o040755 ? fileStat(p, ...rest) : { ...fileStat(p, ...rest), mode: fileMode },
        chmodSync: (p, mode) => {
          self.chmods.push({ name: path.basename(String(p)), folder: same(p), mode })
          if (failChmod) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        },
        appendFileSync: (p, data, o) => {
          self.appends.push({ name: path.basename(String(p)), options: o })
          return fs.appendFileSync(p, data, o)
        },
      }
    },
  }
}

// ---- reading every data block ------------------------------------------------------------------------------------------------------

describe('the full read of the dump', () => {
  const failingRead = (extra = {}) => ({ status: 1, stdout: '', stderr: 'pg_restore: error: could not read from input file: end of file', ...extra })
  /** A pg_restore that passes --list (the table of contents is fine) and answers the full read with `read`. */
  const runnerWithRead = (read, dump = defaults.pg_dump) =>
    makeRunner({
      pg_dump: dump,
      pg_restore: (call) => (call.args[0] === '--list' || isMarkerCall(call) ? defaults.pg_restore(call) : read(call)),
    })

  it('names the null device: NUL on Windows, /dev/null elsewhere', () => {
    expect(nullDevice('win32')).toBe('NUL')
    expect(nullDevice('linux')).toBe('/dev/null')
    expect(nullDevice('freebsd')).toBe('/dev/null')
  })

  it('runs pg_restore --file=<null device> on the temporary file, after the list, in the same folder, with no PG variable', async () => {
    const r = await go()
    const [list, full] = r.runner.of('pg_restore')
    expect(list.args).toEqual(['--list', PARTIAL])
    expect(full.command).toBe('pg_restore')
    expect(full.args).toEqual(['--file=/dev/null', PARTIAL])
    expectWorkCwd(full.options.cwd)
    expect(Object.keys(full.options.env).filter((key) => /^PG[A-Z]/.test(key))).toEqual([])
    expect('BACKUP_DATABASE_URL' in full.options.env).toBe(false)
    expect(r.runner.calls.map((c) => `${c.tool}${c.tool === 'pg_restore' ? ` ${c.args[0].split('=')[0]}` : ''}`)).toEqual([
      'pg_dump',
      'pg_restore --list',
      'pg_restore --file',
      'pg_restore --data-only',
    ])
  })

  it('uses NUL on Windows, and the pg_restore.exe of the Postgres 18 folder', async () => {
    const r = await go({ deps: { platform: 'win32', exists: (p) => p === WINDOWS_PG_BIN } })
    const [, full] = r.runner.of('pg_restore')
    expect(full.command).toBe(`${WINDOWS_PG_BIN}\\pg_restore.exe`)
    expect(full.args).toEqual(['--file=NUL', PARTIAL])
  })

  it('happens before the file is kept: the temporary file is still the only one when it runs', async () => {
    let during
    const runner = runnerWithRead(() => {
      during = fs.readdirSync(dir)
      return { status: 0, stdout: '', stderr: '' }
    })
    const r = await go({ runner })
    expect(during.filter((name) => !name.startsWith('.bqr-work-'))).toEqual([]) // no final file yet, only the work directory
    expect(r.exitCode).toBe(0)
    expect(r.files).toEqual(['backup.log', FINAL])
  })

  it('a dump that passes --list but cannot be read to the end fails the backup, deletes the temporary file and rotates nothing', async () => {
    seed(oldBackups)
    const r = await go({ options: { keep: 1 }, runner: runnerWithRead(() => failingRead()) })
    expect(r.exitCode).toBe(1)
    expect(r.ok).toBe(false)
    expect(r.message).toBe(
      'the dump could not be read to the end with pg_restore (exit code 1): pg_restore: error: could not read from input file: end of file',
    )
    expect(r.runner.of('pg_restore')).toHaveLength(2)
    expect(r.files).toEqual(['backup.log', ...oldBackups])
    expect(r.out).toEqual([])
    expect(r.errs).toEqual([`backup failed: ${r.message}`])
    expect(r.log).toBe(`03/10/2026 10:15 failed host=${MASKED_HOST} error=${r.message}\n`)
  })

  it('also fails when the full read cannot start or takes too long', async () => {
    const missing = await go({ runner: runnerWithRead(() => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' })) })
    expect(missing.exitCode).toBe(1)
    expect(missing.message).toMatch(/pg_restore was not found/)
    expect(missing.files).toEqual(['backup.log'])
    fs.rmSync(dir, { recursive: true, force: true })
    const slow = await go({ runner: runnerWithRead(() => ({ status: null, stdout: '', stderr: '', problem: 'TIMEOUT' })) })
    expect(slow.exitCode).toBe(1)
    expect(slow.message).toBe('pg_restore did not finish in time')
    expect(slow.files).toEqual(['backup.log'])
  })

  it('is not run when the list already failed: one reason is enough, and the second call would read a broken file', async () => {
    const noScans = makeRunner({ pg_restore: () => ({ status: 0, stdout: '3563; 0 24869 TABLE DATA public points x', stderr: '' }) })
    const r = await go({ runner: noScans })
    expect(r.exitCode).toBe(1)
    expect(r.runner.of('pg_restore')).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
    const listFails = makeRunner({ pg_restore: () => ({ status: 1, stdout: '', stderr: 'pg_restore: error: bad archive' }) })
    const r2 = await go({ runner: listFails })
    expect(r2.exitCode).toBe(1)
    expect(r2.runner.of('pg_restore')).toHaveLength(1)
  })

  it('cleans a secret out of what the full read said, like every other message', async () => {
    const r = await go({ runner: runnerWithRead(() => failingRead({ stderr: `could not read ${URL_FAKE}` })) })
    for (const secret of [PASSWORD, ENCODED, 'postgresql://']) expect(visible(r)).not.toContain(secret)
    expect(r.message).toContain('***')
  })
})

// ---- who can read the files ------------------------------------------------------------------------------------------------------------

describe('files for the owner only', () => {
  it('on Linux sets the umask to 077 before anything is created, and puts the old one back at the end', async () => {
    const events = []
    const rec = recordingFs({ events })
    const runner = makeRunner({
      pg_dump: (call) => {
        events.push('pg_dump')
        return defaults.pg_dump(call)
      },
    })
    const r = await go({
      runner,
      deps: {
        fs: rec.fs,
        umask: (mask) => {
          events.push(`umask ${mask.toString(8).padStart(3, '0')}`)
          return 0o022
        },
      },
    })
    expect(r.exitCode).toBe(0)
    expect(events).toEqual(['umask 077', 'mkdir', 'mkdtemp', 'pg_dump', 'umask 022']) // the output folder, then the work directory
  })

  it('makes the output folder with mode 700 (every folder on the way too), and the work directory with mkdtemp inside it', async () => {
    const rec = recordingFs()
    await go({ deps: { fs: rec.fs } })
    expect(rec.mkdirs).toEqual([{ folder: true, options: { recursive: true, mode: 0o700 } }])
    expect(rec.mkdtemps).toEqual([path.join(path.resolve(dir), '.bqr-work-')]) // mkdtemp itself makes it with mode 700, with a name nobody can guess
  })

  it('sets mode 600 on the dump (in the work directory, before it moves) and on backup.log, and creates the log with mode 600', async () => {
    const rec = recordingFs()
    const r = await go({ deps: { fs: rec.fs } })
    expect(rec.chmods).toEqual([
      { name: PARTIAL, folder: false, mode: 0o600 },
      { name: 'backup.log', folder: false, mode: 0o600 },
    ])
    expect(rec.appends).toEqual([{ name: 'backup.log', options: { encoding: 'utf8', mode: 0o600 } }])
    expect(r.exitCode).toBe(0)
  })

  it('also sets mode 600 on the log of a failed run', async () => {
    const rec = recordingFs()
    const r = await go({ deps: { fs: rec.fs }, runner: makeRunner({ pg_dump: () => ({ status: 1, stdout: '', stderr: 'nope' }) }) })
    expect(r.exitCode).toBe(1)
    expect(rec.chmods).toEqual([{ name: 'backup.log', folder: false, mode: 0o600 }])
  })

  it('on Windows sets no umask and no mode: the profile folder has the right access list already', async () => {
    const rec = recordingFs()
    const r = await go({ deps: { fs: rec.fs, platform: 'win32', exists: () => false } })
    expect(r.exitCode).toBe(0)
    expect(r.masks).toEqual([])
    expect(rec.chmods).toEqual([])
  })

  it('a folder that was there already is not changed, but a warning says when others can read it', async () => {
    seed([])
    const rec = recordingFs({ folderMode: 0o040755 })
    const r = await go({ deps: { fs: rec.fs } })
    expect(r.exitCode).toBe(0)
    expect(rec.chmods.filter((c) => c.folder)).toEqual([])
    expect(r.log.split('\n').filter(Boolean)).toEqual([
      `03/10/2026 10:15 warning ${FOLDER_WARNING}`,
      `03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0`,
    ])
    expect(r.errs).toEqual([`backup: warning, ${FOLDER_WARNING}`])
    expect(FOLDER_WARNING).toMatch(/tighten it/)
  })

  it('says nothing for an existing folder that only the owner can use, whatever the owner bits are', async () => {
    for (const mode of [0o040700, 0o040500, 0o040600]) {
      seed([])
      const r = await go({ deps: { fs: recordingFs({ folderMode: mode }).fs } })
      expect(r.log, mode.toString(8)).not.toContain('warning')
      expect(r.errs, mode.toString(8)).toEqual([])
      fs.rmSync(dir, { recursive: true, force: true })
    }
    for (const mode of [0o040750, 0o040705, 0o040755, 0o040701, 0o040711]) {
      seed([])
      const r = await go({ deps: { fs: recordingFs({ folderMode: mode }).fs } })
      expect(r.log, mode.toString(8)).toContain(`warning ${FOLDER_WARNING}`)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('looks at the folder every time, also at one it made itself, and does not look at all on Windows', async () => {
    const asked = []
    const spy = { ...recordingFs().fs }
    const spied = { ...spy, statSync: (p, ...rest) => (asked.push(path.basename(String(p))), spy.statSync(p, ...rest)) }
    const fresh = await go({ deps: { fs: spied } })
    expect(fresh.exitCode).toBe(0)
    expect(fresh.log).not.toContain('warning')
    expect(asked).toContain(path.basename(dir))
    fs.rmSync(dir, { recursive: true, force: true })
    asked.length = 0
    const windows = await go({ deps: { fs: spied, platform: 'win32', exists: () => false } })
    expect(windows.exitCode).toBe(0)
    expect(asked).not.toContain(path.basename(dir))
  })

  it('creates the real files for the owner only (checked with the real modes on Linux, where they exist)', async () => {
    if (process.platform === 'win32') return // Windows has no such modes: its protection is the access list of the profile
    // The real file system reports the real owner of the folders, so the run must compare them with the real user, not
    // with the invented one that the other tests use.
    const r = await go({ deps: { fs, umask: undefined, getuid: process.getuid } })
    expect(r.exitCode).toBe(0)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dir, FINAL)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(dir, 'backup.log')).mode & 0o777).toBe(0o600)
  })
})

// ---- a cleanup never throws ------------------------------------------------------------------------------------------------------------

describe('a cleanup that fails', () => {
  const busy = () => {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${tmp}/secret-place'`), { code: 'EBUSY' })
  }

  it('does not hide a failed backup: the line is logged, the output is cleaned, the result is returned', async () => {
    const files = { ...fs, statSync: privateStat, rmSync: busy }
    const runner = makeRunner({
      pg_dump: (call) => {
        defaults.pg_dump(call) // the partial file exists, and cannot be deleted
        return { status: 1, stdout: '', stderr: `pg_dump: error: boom ${URL_FAKE}` }
      },
    })
    const r = await go({ deps: { fs: files }, runner })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('pg_dump failed (exit code 1): pg_dump: error: boom ***')
    // the work directory cannot be removed either (rmSync throws for everything here): a warning says that it is still there
    expect(r.log).toBe(`03/10/2026 10:15 failed host=${MASKED_HOST} warning=work-directory-not-removed error=${r.message}\n`)
    expect(r.errs).toEqual([`backup failed: ${r.message}`, 'backup: warning, work-directory-not-removed'])
    expect(visible(r)).not.toContain('secret-place')
    expect(visible(r)).not.toContain(tmp)
  })

  it('does not hide the answer of the issue step when nothing can be deleted', async () => {
    const files = { ...fs, statSync: privateStat, rmSync: busy }
    const r = await go({
      deps: { fs: files },
      options: { reportIssue: 'owner/repo' },
      runner: makeRunner({ pg_dump: () => ({ status: 1, stdout: '', stderr: 'nope' }) }),
    })
    expect(r.exitCode).toBe(1)
    expect(r.issue).toBe('opened')
    expect(r.log).toContain(' warning=work-directory-not-removed issue=opened error=pg_dump failed')
    expect(r.errs).toContain('backup: an issue was opened')
    expect(visible(r)).not.toContain('secret-place')
  })

  it('does not fail a good backup when an old backup cannot be deleted: it is a warning', async () => {
    seed(oldBackups)
    const files = {
      ...fs,
      statSync: privateStat,
      rmSync: (p, o) => {
        if (path.basename(String(p)).startsWith('building-qr-20260901')) return busy()
        return fs.rmSync(p, o)
      },
    }
    const r = await go({ deps: { fs: files }, options: { keep: 1 } })
    expect(r.exitCode).toBe(0)
    expect(r.removed).toBe(4)
    expect(r.warning).toBe('1-old-backups-not-removed')
    expect(r.files).toEqual(['backup.log', 'building-qr-20260901T0000Z.dump', FINAL])
    expect(r.log).toContain(' removed=4 warning=1-old-backups-not-removed')
  })

  it('does not fail a good backup when the folder cannot be listed for the rotation', async () => {
    const files = {
      ...fs,
      statSync: privateStat,
      readdirSync: () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      },
    }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(0)
    // the same listing is what the clean-up of work folders that a crashed run left needs, so it says that it could not look either
    expect(r.warning).toBe('old-backups-not-checked,stale-work-folders-not-checked')
  })

  it('still returns when the screen itself fails (a closed pipe)', async () => {
    const r = await go({
      deps: {
        out: () => {
          throw new Error('EPIPE')
        },
        err: () => {
          throw new Error('EPIPE')
        },
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.log).toContain(' ok host=')
  })
})

describe('the command line entry', () => {
  const lines = () => {
    const out = []
    const errs = []
    return { out, errs, deps: { out: (l) => out.push(l), err: (l) => errs.push(l) } }
  }

  it('returns the exit code of the run', async () => {
    const io = lines()
    expect(await main(['--out', dir], { ...io.deps, run: async (options) => ({ exitCode: options.keep === 30 ? 0 : 9 }) })).toBe(0)
    expect(await main(['--out', dir, '--keep', '2'], { ...io.deps, run: async () => ({ exitCode: 1 }) })).toBe(1)
  })

  it('an unexpected error prints one cleaned line with its code or name, never its message or a path, and returns 1', async () => {
    const cases = [
      [Object.assign(new Error(`ENOENT: no such file or directory, open '${tmp}/secret-place'`), { code: 'ENOENT' }), 'ENOENT'],
      [new TypeError(`bad thing at ${tmp}/secret-place with ${URL_FAKE}`), 'TypeError'],
      [Object.assign(new Error('x'), { code: 'not a code /path' }), 'Error'],
      [Object.assign(new Error('x'), { name: 'Odd Name /path' }), 'Error'],
      ['a thrown string with a path /secret-place', 'Error'],
      [undefined, 'Error'],
    ]
    for (const [thrown, label] of cases) {
      const io = lines()
      const code = await main(['--out', dir], {
        ...io.deps,
        run: async () => {
          throw thrown
        },
      })
      expect(code).toBe(1)
      expect(io.errs).toEqual([`backup failed: unexpected error (${label})`])
      expect(io.out).toEqual([])
      expect(io.errs.join('\n')).not.toMatch(/secret-place|postgresql|fake/)
    }
  })

  it('still returns 1 when even the message cannot be printed', async () => {
    const code = await main(['--out', dir], {
      out: () => {},
      err: () => {
        throw new Error('EPIPE')
      },
      run: async () => {
        throw new Error('boom')
      },
    })
    expect(code).toBe(1)
  })

  it('a wrong command line prints the reason and the usage and returns 1, and --help prints the usage and returns 0', async () => {
    const bad = lines()
    expect(await main(['--keep', '0', '--out', dir], { ...bad.deps, run: async () => ({ exitCode: 0 }) })).toBe(1)
    expect(bad.errs[0]).toMatch(/^backup: --keep must be/)
    expect(bad.errs[1]).toMatch(/^Usage: /)
    const help = lines()
    expect(await main(['--help'], { ...help.deps, run: async () => ({ exitCode: 9 }) })).toBe(0)
    expect(help.out.join('\n')).toMatch(/^Usage: /)
  })
})

// ---- owner-only access lists on Windows ------------------------------------------------------------------------------------------------

describe('the helpers for the access list of a file on Windows', () => {
  it('finds a tool of Windows by its full path in System32, whatever PATH holds', () => {
    expect(windowsTool('icacls.exe', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\icacls.exe')
    expect(windowsTool('whoami.exe', { windir: 'E:\\Windows' })).toBe('E:\\Windows\\System32\\whoami.exe')
    expect(windowsTool('whoami.exe', {})).toBe('C:\\Windows\\System32\\whoami.exe')
    expect(windowsTool('whoami.exe', { SystemRoot: '  ' })).toBe('C:\\Windows\\System32\\whoami.exe')
    expect(windowsTool('whoami.exe')).toBe('C:\\Windows\\System32\\whoami.exe')
  })

  it('reads the SID out of whoami /user /fo csv /nh, as icacls takes it, whatever the user name looks like', () => {
    expect(parseWhoamiSid(`"PC\\user","${SID}"\r\n`)).toBe(`*${SID}`)
    expect(parseWhoamiSid(`"PC\\Some Name","${SID}"`)).toBe(`*${SID}`)
    expect(parseWhoamiSid(`"PC\\\u05DE\u05EA\u05DF","${SID}"\n`)).toBe(`*${SID}`)
    expect(parseWhoamiSid('"AzureAD\\a.b@example.test","S-1-12-1-1-2-3-4"')).toBe('*S-1-12-1-1-2-3-4')
  })

  it('gives null for output that holds no SID', () => {
    for (const text of ['', undefined, 'ERROR: not found', '"PC\\user"', 'S-1-5-21-1-2-3 without quotes', '"PC\\user","S-2-5"', '"PC\\user","S-1-"']) {
      expect(parseWhoamiSid(text), String(text)).toBeNull()
    }
  })

  it('builds the icacls arguments: no inheritance, full control for the one user, the file by a relative name', () => {
    expect(icaclsArgs(PARTIAL, `*${SID}`)).toEqual([PARTIAL, '/inheritance:r', '/grant:r', `*${SID}:F`])
    expect(icaclsArgs('backup.log', 'Test User')).toEqual(['backup.log', '/inheritance:r', '/grant:r', 'Test User:F'])
  })
})

describe('owner-only files on Windows', () => {
  const win = (deps = {}) => ({
    platform: 'win32',
    exists: () => false,
    ...deps,
    env: { SystemRoot: 'C:\\Windows', ...deps.env },
  })
  const ICACLS = 'C:\\Windows\\System32\\icacls.exe'
  const WHOAMI = 'C:\\Windows\\System32\\whoami.exe'
  const noWho = { status: 1, stdout: '', stderr: 'ERROR: nope' }

  it('asks whoami (the one of Windows, by its full path) for the SID of the user, once', async () => {
    const r = await go({ deps: win() })
    expect(r.exitCode).toBe(0)
    const [who] = r.runner.of('whoami')
    expect(who.command).toBe(WHOAMI)
    expect(who.args).toEqual(['/user', '/fo', 'csv', '/nh'])
    expect(r.runner.of('whoami')).toHaveLength(1) // for the dump and for the log
  })

  it('closes the work directory in the output folder, then the empty temporary file in it, with icacls before pg_dump writes anything: SID, no inheritance', async () => {
    const seen = {}
    const ls = (target) => (fs.existsSync(target) ? fs.readdirSync(target) : null)
    const lsOut = () => ls(dir)?.filter((name) => !name.startsWith('.bqr-work-')) ?? null // what is in the output folder besides the work directory
    const runner = makeRunner({
      icacls: (call) => {
        if (call.args[0].startsWith('.bqr-work-')) seen.atWorkDir = { out: lsOut(), inside: ls(path.join(dir, call.args[0])) }
        if (call.args[0] === PARTIAL) {
          seen.atFile = { inside: ls(call.options.cwd), size: fs.statSync(path.join(call.options.cwd, PARTIAL)).size, final: fs.existsSync(path.join(dir, FINAL)) }
        }
        return defaults.icacls(call)
      },
      pg_dump: (call) => {
        seen.beforeDump = { out: lsOut(), inside: ls(call.options.cwd) }
        return defaults.pg_dump(call)
      },
    })
    const r = await go({ deps: win(), runner })
    const [dirCall, fileCall] = r.runner.of('icacls').filter((call) => call.args.length > 1) // the calls that change a list
    // the directory: found by a relative name in the output folder, with the rights that what is made inside inherits
    expect(dirCall.command).toBe(ICACLS)
    expect(dirCall.args).toEqual([expect.stringMatching(/^\.bqr-work-[A-Za-z0-9]{6}$/), '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`])
    expect(dirCall.options.cwd).toBe(path.resolve(dir))
    // the file: by a relative name in the work directory
    expect(fileCall.args).toEqual([PARTIAL, '/inheritance:r', '/grant:r', `*${SID}:F`])
    expectWorkCwd(fileCall.options.cwd)
    expect(path.basename(fileCall.options.cwd)).toBe(dirCall.args[0])
    for (const call of [dirCall, fileCall]) {
      expect(Object.keys(call.options.env).filter((key) => /^PG[A-Z]/.test(key))).toEqual([])
    }
    expect(seen).toEqual({
      atWorkDir: { out: [], inside: [] }, // nothing is in the directory when its list is set, and nothing is in the output folder
      atFile: { inside: [PARTIAL], size: 0, final: false },
      beforeDump: { out: [], inside: [PARTIAL] },
    })
    // nothing in the command lines names a folder, a user or the connection
    const commandLines = JSON.stringify([dirCall.args, fileCall.args])
    for (const text of [dir, tmp, os.homedir(), USER, HOST, PASSWORD]) expect(commandLines).not.toContain(text)
  })

  it('goes in this order: whoami, the work directory, icacls on it, the empty file, icacls, pg_dump, the list, the full read, the rename, the new log', async () => {
    const events = []
    const ls = (target) => (target && fs.existsSync(target) ? fs.readdirSync(target).join(' ') : '-')
    const outList = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith('.bqr-work-')).join(' ') || 'empty' : '-')
    const where = () => `out: ${outList()}, work: ${ls(workDirsNow().map((name) => path.join(dir, name))[0])}`
    const named = (name) => name.replace(/^\.bqr-work-.*$/, '<work>')
    const runner = makeRunner({
      whoami: (call) => {
        events.push(`whoami (${where()})`)
        return defaults.whoami(call)
      },
      powershell: (call) => {
        events.push(`folders checked (${where()})`)
        return defaults.powershell(call)
      },
      icacls: (call) => {
        events.push(`icacls ${named(call.args[0])}${call.args.length === 1 ? ' read back' : ''} (${where()})`)
        return defaults.icacls(call)
      },
      pg_dump: (call) => {
        events.push('pg_dump')
        return defaults.pg_dump(call)
      },
      pg_restore: (call) => {
        events.push(call.args[0] === '--list' ? 'list' : isMarkerCall(call) ? 'marker' : 'full read')
        return defaults.pg_restore(call)
      },
    })
    const r = await go({ deps: win(), runner })
    expect(r.exitCode).toBe(0)
    expect(events).toEqual([
      'whoami (out: -, work: -)', // before anything is made: the output folder does not exist yet
      'folders checked (out: -, work: -)', // the access lists of the folders of the run are read before anything is made
      'icacls <work> (out: empty, work: )', // the directory exists and is empty when its list is set, and the output folder is empty
      'icacls <work> read back (out: empty, work: )', // and its list is read back before anything is written into it
      `icacls ${PARTIAL} (out: empty, work: ${PARTIAL})`,
      'pg_dump',
      'list',
      'full read',
      'marker',
      // the file was renamed into the output folder and the work directory is removed: the log is made last
      `icacls backup.log (out: backup.log ${FINAL}, work: -)`,
    ])
  })

  it('prefers the SID to the name: a name with a space or in another alphabet is never used', async () => {
    const runner = makeRunner({ whoami: () => ({ status: 0, stdout: `"PC\\Some Name \u00E9\u00E8","${SID}"\r\n`, stderr: '' }) })
    const r = await go({ deps: win(), runner })
    for (const call of r.runner.of('icacls').filter((c) => c.args.length > 1)) {
      expect(call.args.at(-1)).toMatch(new RegExp(`^\\*${SID}:(\\(OI\\)\\(CI\\))?F$`))
      expect(JSON.stringify(call.args)).not.toContain('Some Name')
    }
  })

  it('fails closed, before anything is made, when whoami gives no SID (it fails, is missing or prints something else): there is no fallback to the name', async () => {
    const answers = [
      noWho,
      { status: null, stdout: '', stderr: '', problem: 'ENOENT' },
      { status: 0, stdout: 'ERROR: something else\r\n', stderr: '' },
    ]
    for (const answer of answers) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ deps: win(), runner: makeRunner({ whoami: () => answer }) })
      expect(r.exitCode, JSON.stringify(answer)).toBe(1)
      expect(r.message).toBe('the current Windows user could not be found, so a dump cannot be made owner-only')
      expect(r.runner.of('powershell')).toEqual([]) // the folders cannot be judged without the SID of the user
      expect(r.runner.of('icacls')).toEqual([])
      expect(r.runner.of('pg_dump')).toEqual([])
      expect(r.files).toEqual([]) // not even the output folder was made, and no log is written in a folder that is not known
      expect(workDirsNow()).toEqual([])
    }
  })

  it('fails closed when icacls fails: before pg_dump writes anything, nothing is rotated, and the message holds no path', async () => {
    seed(oldBackups)
    const runner = makeRunner({ icacls: () => ({ status: 5, stdout: `Failed processing 1 files: ${dir}`, stderr: `${dir}: Access is denied.` }) })
    const r = await go({ options: { keep: 1 }, deps: win(), runner })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('icacls failed (exit code 5), so a dump cannot be made owner-only')
    expect(r.runner.of('pg_dump')).toEqual([])
    expect(r.runner.of('pg_restore')).toEqual([])
    expect(r.files).toEqual(['backup.log', ...oldBackups]) // the empty temporary file is deleted, the old backups are all still there
    expect(r.errs).toContain(`backup failed: ${r.message}`)
    for (const text of [dir, tmp, os.homedir()]) expect(visible(r)).not.toContain(text)
    expect(r.log).toBe(`03/10/2026 10:15 failed host=${MASKED_HOST} error=${r.message}\n`)
  })

  it('fails closed when icacls is missing or does not finish', async () => {
    const missing = await go({ deps: win(), runner: makeRunner({ icacls: () => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' }) }) })
    expect(missing.exitCode).toBe(1)
    expect(missing.message).toBe('icacls was not found, so a dump cannot be made owner-only')
    expect(missing.runner.of('pg_dump')).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
    const slow = await go({ deps: win(), runner: makeRunner({ icacls: () => ({ status: null, stdout: '', stderr: '', problem: 'TIMEOUT' }) }) })
    expect(slow.exitCode).toBe(1)
    expect(slow.message).toBe('icacls did not finish (TIMEOUT), so a dump cannot be made owner-only')
    expect(slow.runner.of('pg_dump')).toEqual([])
    expect(slow.files).toEqual(['backup.log'])
  })

  it('closes a new backup.log the same way, and does not touch a log that exists', async () => {
    const first = await go({ deps: win() })
    expect(first.runner.of('icacls').map((c) => c.args)).toEqual([
      [expect.stringMatching(/^\.bqr-work-/), '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`],
      [expect.stringMatching(/^\.bqr-work-/)], // the list of the work directory, read back
      [PARTIAL, '/inheritance:r', '/grant:r', `*${SID}:F`],
      ['backup.log', '/inheritance:r', '/grant:r', `*${SID}:F`],
    ])
    const second = await go({ deps: win() })
    expect(second.runner.of('icacls').map((c) => c.args[0])).toEqual([expect.stringMatching(/^\.bqr-work-/), expect.stringMatching(/^\.bqr-work-/), PARTIAL]) // the log was there already
    expect(second.log.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('writes a log that cannot be closed anyway, with a warning: it holds no personal data', async () => {
    const runner = makeRunner({ icacls: (call) => (call.args[0] === 'backup.log' ? { status: 5, stdout: '', stderr: '' } : defaults.icacls(call)) })
    const r = await go({ deps: win(), runner })
    expect(r.exitCode).toBe(0)
    expect(r.log).toContain(' ok host=')
    expect(r.errs).toEqual(['backup: warning, backup.log could not be made owner-only'])
  })

  it('does not run on Linux, where the umask and the modes do this work', async () => {
    const r = await go()
    expect(r.runner.of('whoami')).toEqual([])
    expect(r.runner.of('icacls')).toEqual([])
    expect(r.runner.calls.map((c) => c.tool)).toEqual(['pg_dump', 'pg_restore', 'pg_restore', 'pg_restore'])
  })
})

// ---- a read-only session ---------------------------------------------------------------------------------------------------------------

describe('the session of pg_dump is read-only', () => {
  it('has the option that makes every transaction of the session read-only', () => {
    expect(READ_ONLY_OPTION).toBe('-c default_transaction_read_only=on')
  })

  it('puts it in PGOPTIONS for an address without options, and after the options that the address has', () => {
    expect(connectionEnv('postgres://u:p@h.example/db').PGOPTIONS).toBe(READ_ONLY_OPTION)
    expect(connectionEnv('postgres://u:p@h.example/db?options=endpoint%3Dep-abc').PGOPTIONS).toBe(`endpoint=ep-abc ${READ_ONLY_OPTION}`)
    expect(connectionEnv('postgres://u:p@h.example/db?options=-c%20search_path%3Dx').PGOPTIONS).toBe(`-c search_path=x ${READ_ONLY_OPTION}`)
  })

  it('comes last, so that an option of the address that turns it off cannot win', () => {
    const env = connectionEnv('postgres://u:p@h.example/db?options=-c%20default_transaction_read_only%3Doff')
    expect(env.PGOPTIONS).toBe(`-c default_transaction_read_only=off ${READ_ONLY_OPTION}`)
    expect(env.PGOPTIONS.endsWith('default_transaction_read_only=on')).toBe(true)
  })

  it('is in the environment of every pg_dump that a run starts, whatever the environment of the machine says', async () => {
    const r = await go({ deps: { env: { PGOPTIONS: '-c default_transaction_read_only=off' } } })
    const [dump] = r.runner.of('pg_dump')
    expect(dump.options.env.PGOPTIONS).toBe(READ_ONLY_OPTION)
    expect(r.runner.of('pg_dump')).toHaveLength(1)
  })

  it('goes with the address of BACKUP_DATABASE_URL and with the one from the Neon CLI alike', async () => {
    const fromEnv = await go()
    fs.rmSync(dir, { recursive: true, force: true })
    const fromNeon = await go({ options: { neonProject: 'square-term-1' }, deps: { env: { BACKUP_DATABASE_URL: '' } } })
    for (const r of [fromEnv, fromNeon]) expect(r.runner.of('pg_dump')[0].options.env.PGOPTIONS).toBe(READ_ONLY_OPTION)
  })
})

// ---- one temporary file per run -----------------------------------------------------------------------------------------------------------

describe('one work directory and one temporary file per run', () => {
  const workOf = (r) => path.basename(r.runner.of('pg_dump')[0].options.cwd)

  it('has a prefix that is not a backup name, and a path inside the work directory that is not longer than the final file\'s', () => {
    expect(WORK_PREFIX).toBe('.bqr-work-')
    expect(BACKUP_NAME.test(`${WORK_PREFIX}abc123`)).toBe(false)
    expect(WORK_NAME.test(`${WORK_PREFIX}abc123`)).toBe(true)
    // mkdtemp adds six characters; the path inside is not longer than the name of the final file (with its separator)
    expect(WORK_PREFIX.length + 6 + 1 + PARTIAL_NAME.length).toBeLessThanOrEqual(FINAL.length + 1)
  })

  it('differs between two runs with the same clock: mkdtemp gives each an unpredictable name of its own', async () => {
    const first = await go()
    fs.rmSync(dir, { recursive: true, force: true })
    const second = await go()
    expect(workOf(first)).toMatch(/^\.bqr-work-[A-Za-z0-9]{6}$/)
    expect(workOf(second)).toMatch(/^\.bqr-work-[A-Za-z0-9]{6}$/)
    expect(workOf(first)).not.toBe(workOf(second))
  })

  it('is made empty and exclusively (wx) before pg_dump starts, with mode 600', async () => {
    const made = []
    const files = {
      ...fs,
      statSync: privateStat,
      writeFileSync: (p, data, o) => {
        made.push({ name: path.basename(String(p)), data, options: o })
        return fs.writeFileSync(p, data, o)
      },
    }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(0)
    expect(made).toEqual([{ name: PARTIAL, data: '', options: { flag: 'wx', mode: 0o600 } }])
  })

  it('never reuses a temporary file that is there already, even inside a work directory that it made', async () => {
    const files = {
      ...fs,
      statSync: privateStat,
      mkdtempSync: (prefix, ...rest) => {
        const made = fs.mkdtempSync(prefix, ...rest)
        fs.writeFileSync(path.join(made, PARTIAL), 'planted by another account')
        return made
      },
    }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toMatch(/EEXIST/)
    expect(r.runner.of('pg_dump')).toEqual([])
    expect(workDirsNow()).toEqual([]) // the work directory is this run's own, so it is removed with what was planted
    expect(r.files).toEqual(['backup.log'])
  })

  it('leaves the work directory of another run alone, on success and on failure', async () => {
    const other = path.join(dir, '.bqr-work-OTHER1')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, PARTIAL), 'another run is working here')
    const good = await go({ options: { keep: 1 } })
    expect(good.exitCode).toBe(0)
    const bad = await go({ runner: makeRunner({ pg_dump: () => ({ status: 1, stdout: '', stderr: 'nope' }) }) })
    expect(bad.exitCode).toBe(1)
    expect(workDirsNow()).toEqual(['.bqr-work-OTHER1'])
    expect(fs.readFileSync(path.join(other, PARTIAL), 'utf8')).toBe('another run is working here')
  })

  it('lets two runs of the same minute work at the same time: each has its own directory, and the later rename replaces the final one', async () => {
    const names = []
    const slowDump = async (call) => {
      names.push(path.basename(call.options.cwd))
      await new Promise((resolve) => setTimeout(resolve, 30))
      return defaults.pg_dump(call)
    }
    const two = await Promise.all([go({ runner: makeRunner({ pg_dump: slowDump }) }), go({ runner: makeRunner({ pg_dump: slowDump }) })])
    expect(two.map((r) => r.exitCode)).toEqual([0, 0])
    expect(new Set(names).size).toBe(2) // each run dumped in its own directory
    expect(fs.readdirSync(dir).sort()).toEqual(['backup.log', FINAL]) // one final file is left
    expect(workDirsNow()).toEqual([]) // and both work directories are gone
    expect(fs.readFileSync(path.join(dir, FINAL), 'utf8')).toBe('PGDMP fake dump')
  })
})

// ---- the mode of the finished dump is read back --------------------------------------------------------------------------------------

describe('a dump that is still readable by others', () => {
  const MODE_MESSAGE = 'the dump could not be made owner-only (chmod failed, or this file system ignores file modes), so it was deleted'

  it('a failed chmod is harmless when the file is closed anyway (the umask did it): the dump is kept, with no warning', async () => {
    const rec = recordingFs({ failChmod: true, fileMode: 0o100600 })
    const r = await go({ deps: { fs: rec.fs } })
    expect(r.exitCode).toBe(0)
    expect(r.files).toEqual(['backup.log', FINAL])
    expect(r.warning).toBeUndefined()
  })

  it('a failed chmod on a file that others can read: the dump is deleted, nothing is rotated, the backup fails', async () => {
    seed(oldBackups)
    const rec = recordingFs({ failChmod: true, fileMode: 0o100644 })
    const r = await go({ options: { keep: 1 }, deps: { fs: rec.fs } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(MODE_MESSAGE)
    expect(r.files).toEqual(['backup.log', ...oldBackups])
    expect(r.out).toEqual([])
    // the new log says 644 too in this stub, which is its own warning, printed before the failure
    expect(r.errs).toEqual(['backup: warning, backup.log could not be made owner-only', `backup failed: ${MODE_MESSAGE}`])
    expect(r.log).toBe(`03/10/2026 10:15 failed host=${MASKED_HOST} error=${MODE_MESSAGE}\n`)
  })

  it('a chmod that works on a file system that ignores modes (the stat still says 664) fails the same way', async () => {
    const rec = recordingFs({ fileMode: 0o100664 })
    const r = await go({ deps: { fs: rec.fs } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(MODE_MESSAGE)
    expect(r.files).toEqual(['backup.log'])
    expect(rec.chmods[0]).toEqual({ name: PARTIAL, folder: false, mode: 0o600 })
  })

  it('refuses every mode where a group or others have any right', async () => {
    for (const mode of [0o100640, 0o100604, 0o100660, 0o100606, 0o100666, 0o100644, 0o100601, 0o100610]) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ deps: { fs: recordingFs({ fileMode: mode }).fs } })
      expect(r.exitCode, mode.toString(8)).toBe(1)
      expect(r.files, mode.toString(8)).toEqual(['backup.log'])
    }
    for (const mode of [0o100600, 0o100400, 0o100700, 0o100500]) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ deps: { fs: recordingFs({ fileMode: mode }).fs } })
      expect(r.exitCode, mode.toString(8)).toBe(0)
    }
  })

  it('fails closed when the mode cannot be read at all: the dump is deleted', async () => {
    const files = {
      ...fs,
      statSync: (p, ...rest) => {
        if (path.basename(String(p)) === PARTIAL) throw new Error('EIO')
        return privateStat(p, ...rest)
      },
    }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(MODE_MESSAGE)
    expect(r.files).toEqual(['backup.log'])
  })

  it('is not checked on Windows, where icacls does this work', async () => {
    const rec = recordingFs({ fileMode: 0o100666 })
    const r = await go({ deps: { fs: rec.fs, platform: 'win32', exists: () => false } })
    expect(r.exitCode).toBe(0)
    expect(r.files).toEqual(['backup.log', FINAL])
  })

  it('a new backup.log that others can read is only a warning: the line is written and the run goes on', async () => {
    const rec = recordingFs({ fileMode: 0o100644, failChmod: true })
    // the dump must pass its own check, so only the log says 644
    const files = {
      ...rec.fs,
      statSync: (p, ...rest) => (path.basename(String(p)) === 'backup.log' ? { size: 0, mode: 0o100644 } : privateStat(p, ...rest)),
    }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(0)
    expect(r.log).toContain(' ok host=')
    expect(r.errs).toEqual(['backup: warning, backup.log could not be made owner-only'])
  })

  it('does not check a log that was there before (it is the user\'s file, and may have a mode that was chosen)', async () => {
    seed([])
    fs.writeFileSync(path.join(dir, 'backup.log'), '')
    const asked = []
    const files = {
      ...fs,
      statSync: (p, ...rest) => {
        asked.push(path.basename(String(p)))
        return path.basename(String(p)) === 'backup.log' ? { size: 0, mode: 0o100644 } : privateStat(p, ...rest)
      },
    }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(0)
    expect(r.errs).toEqual([])
    expect(asked).not.toContain('backup.log')
  })
})

// ---- the private work directory ------------------------------------------------------------------------------------------------------

describe('the private work directory', () => {
  it('is made by mkdtemp inside the output folder, after the folder exists and before the temporary file', async () => {
    const events = []
    let outFolderDuringDump
    const files = {
      ...fs,
      statSync: privateStat,
      mkdirSync: (target, options) => {
        events.push(`mkdir folder ${JSON.stringify(options)}`)
        return fs.mkdirSync(target, options)
      },
      mkdtempSync: (prefix, ...rest) => {
        events.push(`mkdtemp ${path.dirname(String(prefix)) === path.resolve(dir) ? 'in the output folder' : 'ELSEWHERE'} ${path.basename(String(prefix))}`)
        return fs.mkdtempSync(prefix, ...rest)
      },
      writeFileSync: (target, data, options) => {
        const inside = path.basename(path.dirname(String(target))).replace(/[A-Za-z0-9]{6}$/, 'XXXXXX')
        events.push(`write ${inside}/${path.basename(String(target))} ${JSON.stringify(options)}`)
        return fs.writeFileSync(target, data, options)
      },
    }
    let work
    const runner = makeRunner({
      pg_dump: (call) => {
        work = path.basename(call.options.cwd)
        outFolderDuringDump = fs.readdirSync(dir)
        return defaults.pg_dump(call)
      },
    })
    const r = await go({ deps: { fs: files }, runner })
    expect(r.exitCode).toBe(0)
    expect(events).toEqual([
      'mkdir folder {"recursive":true,"mode":448}',
      'mkdtemp in the output folder .bqr-work-',
      'write .bqr-work-XXXXXX/partial.dump {"flag":"wx","mode":384}',
    ])
    expect(outFolderDuringDump).toEqual([work]) // only the work directory, and later the finished file, are in the output folder
  })

  it('is where pg_dump, the list and the full read run, and the finished file is moved out of it into the output folder', async () => {
    const r = await go()
    const cwds = r.runner.calls.map((c) => c.options.cwd)
    expect(cwds).toHaveLength(4) // pg_dump, the list, the full read and the marker
    expect(new Set(cwds).size).toBe(1)
    expectWorkCwd(cwds[0])
    expect(fs.existsSync(path.join(dir, FINAL))).toBe(true)
    expect(workDirsNow()).toEqual([])
  })

  it('is removed after a good backup and after every kind of failure, with whatever a failed run left in it', async () => {
    const halfDump = (call) => {
      defaults.pg_dump(call) // a half written dump is in the directory
      return { status: 1, stdout: '', stderr: 'pg_dump: error: boom' }
    }
    const readFails = (call) => (call.args[0] === '--list' || isMarkerCall(call) ? defaults.pg_restore(call) : { status: 1, stdout: '', stderr: 'cut' })
    const scenarios = [
      ['pg_dump fails after it wrote', makeRunner({ pg_dump: halfDump }), {}],
      ['pg_dump is not found', makeRunner({ pg_dump: () => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' }) }), {}],
      ['the list lacks scans', makeRunner({ pg_restore: () => ({ status: 0, stdout: '1; 0 1 TABLE DATA public points x', stderr: '' }) }), {}],
      ['the list fails', makeRunner({ pg_restore: () => ({ status: 1, stdout: '', stderr: 'bad' }) }), {}],
      ['the full read fails', makeRunner({ pg_restore: readFails }), {}],
      ['the mode is not owner-only', makeRunner(), { fs: recordingFs({ fileMode: 0o100644 }).fs }],
    ]
    for (const [what, runner, deps] of scenarios) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ runner, deps })
      expect(r.exitCode, what).toBe(1)
      expect(workDirsNow(), what).toEqual([])
      expect(r.files, what).toEqual(['backup.log'])
    }
    fs.rmSync(dir, { recursive: true, force: true })
    const good = await go()
    expect(good.exitCode).toBe(0)
    expect(workDirsNow()).toEqual([])
  })

  it('that cannot be removed is a warning that says so: a good backup stays good, and the dump itself was moved out', async () => {
    const files = {
      ...fs,
      statSync: privateStat,
      rmSync: (target, options) => {
        if (isWorkDir(target)) {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: 'EBUSY' })
        }
        return fs.rmSync(target, options)
      },
    }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(0)
    expect(r.warning).toBe('work-directory-not-removed')
    expect(r.log).toBe(`03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0 warning=work-directory-not-removed\n`)
    expect(r.errs).toEqual(['backup: warning, work-directory-not-removed'])
    expect(r.files.filter((name) => !name.startsWith('.bqr-work-'))).toEqual(['backup.log', FINAL])
    const [left] = workDirsNow()
    expect(fs.readdirSync(path.join(dir, left))).toEqual([]) // the dump was moved out, so nothing is left in it
    expect(visible(r)).not.toContain(tmp)
    // and it is a directory, so the retention of the next run never sees it as a backup
    const next = await go({ options: { keep: 1 }, deps: { now: () => new Date('2026-10-04T07:15:00Z') } })
    expect(next.exitCode).toBe(0)
    expect(next.files).toContain(left)
    expect(next.files).toContain('building-qr-20261004T0715Z.dump')
  })

  it('on Linux must be owner-only: a file system that ignores modes stops the run before anything is dumped', async () => {
    const r = await go({ deps: { fs: recordingFs({ workMode: 0o040755 }).fs } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('the work directory could not be made owner-only (does this file system ignore modes?), so nothing was dumped')
    expect(r.runner.of('pg_dump')).toEqual([])
    expect(workDirsNow()).toEqual([])
  })

  it('on Windows, an icacls that fails on the work directory stops the run before anything is written into it', async () => {
    seed(oldBackups)
    const written = []
    const files = {
      ...fs,
      statSync: privateStat,
      writeFileSync: (target, data, options) => {
        written.push(path.basename(String(target)))
        return fs.writeFileSync(target, data, options)
      },
    }
    const runner = makeRunner({
      icacls: (call) => (call.args[0].startsWith('.bqr-work-') ? { status: 5, stdout: '', stderr: '' } : defaults.icacls(call)),
    })
    const r = await go({
      options: { keep: 1 },
      runner,
      deps: { fs: files, platform: 'win32', exists: () => false, env: { SystemRoot: 'C:\\Windows' } },
    })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('icacls failed (exit code 5), so a dump cannot be made owner-only')
    expect(written).not.toContain(PARTIAL) // the temporary file was never made
    expect(r.runner.of('pg_dump')).toEqual([])
    expect(workDirsNow()).toEqual([])
    expect(r.files.filter((name) => BACKUP_NAME.test(name))).toEqual(oldBackups) // nothing was rotated
  })

  describe('on Windows, with the limit of 260 characters of its tools', () => {
    const win = { platform: 'win32', exists: () => false, env: { SystemRoot: 'C:\\Windows' } }
    /** An output folder whose longest path (the final file) is exactly `length` characters. */
    const folderFor = (length) => path.join(tmp, 'x'.repeat(length - FINAL.length - 1 - tmp.length - 1))
    /** An output folder whose path inside the work directory (the temporary file) is exactly `length` characters. */
    const workFolderFor = (length) => path.join(tmp, 'y'.repeat(length - (WORK_PREFIX.length + 6) - PARTIAL_NAME.length - 2 - tmp.length - 1))

    it('allows an output folder whose longest path is the limit, and refuses one character more, before anything is made', async () => {
      const exact = folderFor(WINDOWS_PATH_LIMIT)
      expect(path.join(exact, FINAL).length).toBe(WINDOWS_PATH_LIMIT)
      const fine = await go({ options: { out: exact }, deps: win })
      expect(fine.exitCode).toBe(0)
      const tooLong = folderFor(WINDOWS_PATH_LIMIT + 1)
      const r = await go({ options: { out: tooLong }, deps: win })
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(PATH_TOO_LONG_ERROR)
      expect(r.runner.calls).toEqual([]) // not even whoami or the Neon CLI
      expect(r.errs).toEqual([`backup failed: ${PATH_TOO_LONG_ERROR}`]) // and no log, which has no folder to be in
      expect(r.log).toBe('')
      expect(fs.existsSync(tooLong)).toBe(false) // nothing was made
    })

    it('counts the temporary file in the work directory too: it is inside the output folder and its path is not longer than the final file', () => {
      const exact = workFolderFor(WINDOWS_PATH_LIMIT)
      expect(path.join(exact, `${WORK_PREFIX}xxxxxx`, PARTIAL_NAME).length).toBe(WINDOWS_PATH_LIMIT)
      expect(path.join(exact, `${WORK_PREFIX}xxxxxx`, PARTIAL_NAME).length).toBeLessThan(path.join(exact, FINAL).length)
    })

    it('has a message that says what to do and holds no path, and the limit leaves room below 260', () => {
      expect(PATH_TOO_LONG_ERROR).toMatch(/shorter backup folder/)
      expect(PATH_TOO_LONG_ERROR).not.toMatch(/TEMP/)
      expect(PATH_TOO_LONG_ERROR).not.toMatch(/[A-Za-z]:\\/)
      expect(WINDOWS_PATH_LIMIT).toBeLessThan(260 - 10)
    })

    it('is not applied on Linux, where the paths can be long', async () => {
      const r = await go({ options: { out: folderFor(WINDOWS_PATH_LIMIT + 5) } })
      expect(r.exitCode).toBe(0)
    })

    it('explains exit code 3 of icacls (path not found): a path that is too long is the usual cause', async () => {
      const runner = makeRunner({ icacls: () => ({ status: 3, stdout: 'Failed processing 1 files', stderr: '' }) })
      const r = await go({ runner, deps: win })
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe('icacls failed (exit code 3, path not found: a very long backup folder path is the usual cause), so a dump cannot be made owner-only')
      expect(r.runner.of('pg_dump')).toEqual([])
    })
  })
})

// ---- a folder that other users can write in ----------------------------------------------------------------------------------------------

describe('a folder that other users can write in', () => {
  it('is refused on Linux: nothing runs, nothing is made, no log is written there, and the folder is not changed', async () => {
    seed(oldBackups)
    const rec = recordingFs({ folderMode: 0o040777 })
    const r = await go({ options: { keep: 1 }, deps: { fs: rec.fs } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(FOLDER_WRITABLE_ERROR)
    expect(r.runner.calls).toEqual([]) // not even the Neon CLI
    expect(r.files).toEqual(oldBackups) // no work directory, no log, nothing rotated
    expect(r.log).toBe('')
    expect(rec.chmods).toEqual([])
    expect(rec.appends).toEqual([])
    expect(r.errs).toEqual([LOG_SKIPPED, `backup failed: ${FOLDER_WRITABLE_ERROR}`])
    expect(visible(r)).not.toContain(tmp)
  })

  it('is refused for every mode where the group or others can write, and allowed for the others', async () => {
    for (const mode of [0o040770, 0o040777, 0o040720, 0o040702, 0o040775, 0o040757, 0o040722]) {
      fs.rmSync(dir, { recursive: true, force: true })
      seed([])
      const r = await go({ deps: { fs: recordingFs({ folderMode: mode }).fs } })
      expect(r.exitCode, mode.toString(8)).toBe(1)
      expect(r.message, mode.toString(8)).toBe(FOLDER_WRITABLE_ERROR)
    }
    for (const mode of [0o040700, 0o040750, 0o040755, 0o040705, 0o040701, 0o040711, 0o040500]) {
      fs.rmSync(dir, { recursive: true, force: true })
      seed([])
      const r = await go({ deps: { fs: recordingFs({ folderMode: mode }).fs } })
      expect(r.exitCode, mode.toString(8)).toBe(0)
    }
  })

  it('is refused also when the folder was made by this run on a file system that ignores modes (it says 777)', async () => {
    const r = await go({ deps: { fs: recordingFs({ folderMode: 0o040777 }).fs } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(FOLDER_WRITABLE_ERROR)
    expect(r.runner.calls).toEqual([])
  })

  it('is refused when the folder cannot be inspected: a folder that is not known is not trusted', async () => {
    const dirStatFails = (target, ...rest) => {
      if (path.resolve(String(target)) === path.resolve(dir)) throw new Error('EACCES')
      return privateStat(target, ...rest)
    }
    const r = await go({ deps: { fs: { ...fs, statSync: dirStatFails } } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(FOLDER_UNKNOWN_ERROR)
    expect(r.runner.calls).toEqual([])
    expect(r.errs).toEqual([LOG_SKIPPED, `backup failed: ${FOLDER_UNKNOWN_ERROR}`])
  })

  it('is not refused on Windows: the access list of a folder is not read there, the work directory is what protects', async () => {
    const r = await go({ deps: { fs: recordingFs({ folderMode: 0o040777 }).fs, platform: 'win32', exists: () => false } })
    expect(r.exitCode).toBe(0)
    expect(r.log).toContain(' ok host=')
  })

  it('still tells the committee when --report-issue is given: the issue does not touch the folder', async () => {
    const r = await go({ options: { reportIssue: 'owner/repo' }, deps: { fs: recordingFs({ folderMode: 0o040777 }).fs } })
    expect(r.exitCode).toBe(1)
    expect(r.issue).toBe('opened')
    expect(r.log).toBe('')
    expect(r.errs).toEqual([LOG_SKIPPED, `backup failed: ${FOLDER_WRITABLE_ERROR}`, 'backup: an issue was opened'])
  })

  it('has a message that holds no path and says how to fix it', () => {
    for (const message of [FOLDER_WRITABLE_ERROR, FOLDER_UNKNOWN_ERROR, LOG_SKIPPED, FOLDER_WARNING]) {
      expect(message).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//)
    }
    expect(FOLDER_WRITABLE_ERROR).toMatch(/chmod 700/)
  })
})

// ---- the access list of the work directory is read back ------------------------------------------------------------------------------------

describe('the access list of the work directory is read back on Windows', () => {
  const win = (deps = {}) => ({
    platform: 'win32',
    exists: () => false,
    ...deps,
    env: { SystemRoot: 'C:\\Windows', ...deps.env },
  })
  /** An icacls that answers a read of the work directory with `listing(name)` and everything else as usual. */
  const reading = (listing) =>
    makeRunner({
      icacls: (call) =>
        call.args.length === 1 && call.args[0].startsWith('.bqr-work-') ? { status: 0, stdout: listing(call.args[0]), stderr: '' } : defaults.icacls(call),
    })
  const NOT_ALONE = (why) => `the access list of the work directory is not the user's alone (${why}), so nothing was dumped: is the backup folder shared with another account?`

  describe('what is read', () => {
    const name = '.bqr-work-AbC123'

    it('accepts the one entry that is made: the user, full control, inherited by files and folders', () => {
      expect(aclProblem(aclListing(name, OWNER_ENTRY), { name, account: 'PC\\user' })).toBeNull()
      // real icacls output has this shape (an account name with a space, here an invented one)
      const real = `${name} pc_owner\\Some Person:(OI)(CI)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`
      expect(aclProblem(real, { name, account: 'pc_owner\\some person' })).toBeNull() // whoami writes the name in lower case
    })

    it('does not depend on the language of the summary line, or on the case of the account', () => {
      const german = `${name} PC\\user:(OI)(CI)(F)\r\n\r\n1 Dateien erfolgreich verarbeitet; Fehler bei der Verarbeitung von 0 Dateien\r\n`
      expect(aclProblem(german, { name, account: 'pc\\USER' })).toBeNull()
    })

    it('refuses a second entry, whoever it is for and in whatever language its name is', () => {
      for (const extra of ['Everyone:(OI)(CI)(R)', 'BUILTIN\\Administratoren:(I)(OI)(CI)(F)', 'S-1-5-21-1-2-3-1001:(OI)(CI)(F)', 'NT AUTHORITY\\SYSTEM:(OI)(CI)(F)']) {
        expect(aclProblem(aclListing(name, OWNER_ENTRY, extra), { name, account: 'PC\\user' }), extra).toBe('more than one entry')
        expect(aclProblem(aclListing(name, extra, OWNER_ENTRY), { name, account: 'PC\\user' }), extra).toBe('more than one entry')
      }
    })

    it('refuses an entry that is inherited, a deny, not full control, or not inherited by what is inside', () => {
      for (const rights of ['(I)(OI)(CI)(F)', '(OI)(CI)(DENY)(F)', '(OI)(CI)(M)', '(F)', '(OI)(F)', '(CI)(F)', '(OI)(CI)(IO)(F)', '(OI)(CI)(RX)']) {
        expect(aclProblem(aclListing(name, `PC\\user:${rights}`), { name, account: 'PC\\user' }), rights).toBe(
          'the entry is inherited, a deny, or not full control for the folder and what is in it',
        )
      }
    })

    it('refuses an entry of another account, when the account of the user is known', () => {
      expect(aclProblem(aclListing(name, 'BUILTIN\\Users:(OI)(CI)(F)'), { name, account: 'PC\\user' })).toBe('the entry is for another account')
      expect(aclProblem(aclListing(name, 'BUILTIN\\Users:(OI)(CI)(F)'), { name, account: null })).toBeNull() // only the shape can be checked
    })

    it('refuses an output that holds no entry at all (nothing is trusted that cannot be read)', () => {
      for (const output of ['', undefined, 'Successfully processed 0 files; Failed processing 1 files\r\n', 'garbage']) {
        expect(aclProblem(output, { name, account: 'PC\\user' }), String(output)).toBe('no entry could be read')
      }
    })

    it('reads the account of the user out of the whoami line', () => {
      expect(parseWhoamiAccount(`"PC\\user","${SID}"\r\n`)).toBe('PC\\user')
      expect(parseWhoamiAccount(`"PC\\Some Name","${SID}"`)).toBe('PC\\Some Name')
      for (const bad of ['', undefined, 'ERROR: nope', '"PC\\user"']) expect(parseWhoamiAccount(bad), String(bad)).toBeNull()
    })
  })

  describe('in a run', () => {
    const entries = {
      'a second entry of another account (the one the finding is about)': [OWNER_ENTRY, 'Everyone:(OI)(CI)(R)'],
      'an entry for another account only': ['BUILTIN\\Users:(OI)(CI)(F)'],
      'an inherited entry': ['PC\\user:(I)(OI)(CI)(F)'],
      'a deny entry': ['PC\\user:(OI)(CI)(DENY)(F)'],
      'an entry that is not inherited by what is inside': ['PC\\user:(F)'],
      'no entry that can be read': [],
    }
    for (const [what, list] of Object.entries(entries)) {
      it(`refuses ${what}: nothing is written into the directory, nothing is dumped, and nothing is rotated`, async () => {
        seed(oldBackups)
        const written = []
        const files = {
          ...fs,
          statSync: privateStat,
          writeFileSync: (target, data, options) => {
            written.push(path.basename(String(target)))
            return fs.writeFileSync(target, data, options)
          },
        }
        const runner = reading((name) => aclListing(name, ...list))
        const r = await go({ options: { keep: 1 }, runner, deps: win({ fs: files }) })
        const why = list.length === 0 ? 'no entry could be read' : null
        expect(r.exitCode).toBe(1)
        expect(r.message).toMatch(/^the access list of the work directory is not the user's alone \(/)
        if (why) expect(r.message).toBe(NOT_ALONE(why))
        expect(r.message).not.toMatch(/Everyone|Users|PC|user:/) // no account name in the message
        expect(written).not.toContain(PARTIAL) // the temporary file was never made
        expect(r.runner.of('pg_dump')).toEqual([])
        expect(r.runner.of('pg_restore')).toEqual([])
        expect(workDirsNow()).toEqual([]) // the directory is deleted
        expect(r.files.filter((name) => BACKUP_NAME.test(name))).toEqual(oldBackups)
        expect(r.log).toContain(' failed host=')
        expect(visible(r)).not.toContain(tmp)
      })
    }

    it('says why in the message: more than one entry', async () => {
      const r = await go({ runner: reading((name) => aclListing(name, OWNER_ENTRY, 'Everyone:(OI)(CI)(R)')), deps: win() })
      expect(r.message).toBe(NOT_ALONE('more than one entry'))
    })

    it('reads the list after the call that changes it, in the output folder, before the file is made and before pg_dump', async () => {
      const seen = []
      const runner = makeRunner({
        icacls: (call) => {
          if (call.args.length === 1) {
            seen.push({ args: call.args, cwd: call.options.cwd, partial: fs.existsSync(path.join(call.options.cwd, call.args[0], PARTIAL)), calls: r0.length })
          }
          return defaults.icacls(call)
        },
        pg_dump: (call) => {
          seen.push('pg_dump')
          return defaults.pg_dump(call)
        },
      })
      const r0 = []
      const r = await go({ runner, deps: win() })
      expect(r.exitCode).toBe(0)
      expect(seen).toEqual([{ args: [expect.stringMatching(/^\.bqr-work-/)], cwd: path.resolve(dir), partial: false, calls: 0 }, 'pg_dump'])
    })

    it('fails closed when the list cannot be read back at all (icacls fails, is missing or does not finish)', async () => {
      const answers = [{ status: 5, stdout: '', stderr: '' }, { status: null, stdout: '', stderr: '', problem: 'ENOENT' }, { status: null, stdout: '', stderr: '', problem: 'TIMEOUT' }]
      for (const answer of answers) {
        fs.rmSync(dir, { recursive: true, force: true })
        const runner = makeRunner({ icacls: (call) => (call.args.length === 1 ? answer : defaults.icacls(call)) })
        const r = await go({ runner, deps: win() })
        expect(r.exitCode, JSON.stringify(answer)).toBe(1)
        expect(r.message).toBe('icacls could not read the access list of the work directory back, so nothing was dumped')
        expect(r.runner.of('pg_dump')).toEqual([])
        expect(workDirsNow()).toEqual([])
      }
    })

    it('compares the entry with the account of the user, in any case, and accepts a list that is the user alone', async () => {
      const r = await go({ runner: reading((name) => aclListing(name, 'pc\\USER:(OI)(CI)(F)')), deps: win() })
      expect(r.exitCode).toBe(0)
    })

    it('is not done on Linux, where the mode of the work directory is read back instead', async () => {
      const r = await go()
      expect(r.runner.of('icacls')).toEqual([])
    })
  })
})

// ---- a backup.log that is not a plain file --------------------------------------------------------------------------------------------------

describe('a backup.log that is a link or has another name', () => {
  const logPath = () => path.join(dir, 'backup.log')
  /** An lstat that says a stub, whatever the file is: for a platform that cannot make the real thing. */
  const lstatSaying = (info, after = 0) => {
    let calls = 0
    return (target, ...rest) => {
      if (path.basename(String(target)) === 'backup.log' && ++calls > after) return info
      return fs.lstatSync(target, ...rest)
    }
  }
  const SYMLINK = { isFile: () => false, isSymbolicLink: () => true, nlink: 1 }

  it('refuses a symbolic link (seen through a stub): nothing is dumped, nothing is appended, and the message says what to do', async () => {
    seed([])
    fs.writeFileSync(logPath(), 'the log\n')
    const files = { ...fs, statSync: privateStat, lstatSync: lstatSaying(SYMLINK) }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(LOG_NOT_REGULAR_ERROR)
    expect(LOG_NOT_REGULAR_ERROR).toMatch(/delete it or move it away/)
    expect(r.runner.calls).toEqual([]) // not even the Neon CLI
    expect(workDirsNow()).toEqual([])
    expect(r.errs).toEqual([`backup failed: ${LOG_NOT_REGULAR_ERROR}`]) // said once
    expect(fs.readFileSync(logPath(), 'utf8')).toBe('the log\n') // nothing was appended
  })

  it('refuses a real symbolic link (only where this platform can make one), and does not write through it', async () => {
    seed([])
    const target = path.join(tmp, 'another-file-of-the-owner.txt')
    fs.writeFileSync(target, 'precious\n')
    try {
      fs.symlinkSync(target, logPath())
    } catch {
      return // this platform needs a privilege to make a symbolic link: the stub test above covers the check
    }
    const r = await go()
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(LOG_NOT_REGULAR_ERROR)
    expect(fs.readFileSync(target, 'utf8')).toBe('precious\n')
    expect(r.runner.calls).toEqual([])
  })

  it('refuses a dangling symbolic link as well (seen through a stub: it points at nothing, so it "does not exist" for existsSync)', async () => {
    seed([])
    const files = { ...fs, statSync: privateStat, lstatSync: lstatSaying(SYMLINK), existsSync: (target) => (path.basename(String(target)) === 'backup.log' ? false : fs.existsSync(target)) }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(LOG_NOT_REGULAR_ERROR)
  })

  it('refuses a hard link (another name of the same file): the other name is not written to', async () => {
    seed([])
    const other = path.join(tmp, 'another-name.txt')
    fs.writeFileSync(other, 'precious\n')
    fs.linkSync(other, logPath()) // two names for one file: nlink is 2
    const r = await go()
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(LOG_NOT_REGULAR_ERROR)
    expect(fs.readFileSync(other, 'utf8')).toBe('precious\n')
    expect(r.runner.calls).toEqual([])
    expect(r.files).toEqual(['backup.log'])
  })

  it('refuses a log that cannot be inspected', async () => {
    seed([])
    const files = {
      ...fs,
      statSync: privateStat,
      lstatSync: (target, ...rest) => {
        if (path.basename(String(target)) === 'backup.log') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        return fs.lstatSync(target, ...rest)
      },
    }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe(LOG_NOT_REGULAR_ERROR)
  })

  it('still appends to a normal log that is there already, and makes one that is not', async () => {
    seed([])
    fs.writeFileSync(logPath(), 'an older line\n')
    const first = await go()
    expect(first.exitCode).toBe(0)
    expect(first.log.split('\n').filter(Boolean)).toEqual(['an older line', `03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0`])
    fs.rmSync(dir, { recursive: true, force: true })
    const second = await go()
    expect(second.exitCode).toBe(0)
    expect(second.log.split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('checks again right before the append: a link planted in between gets nothing, the dump is kept, and the screen says why', async () => {
    seed([])
    fs.writeFileSync(logPath(), 'the log\n')
    // the first look (before anything is dumped) sees a plain file, the second (before the append) sees a link
    const files = { ...fs, statSync: privateStat, lstatSync: lstatSaying(SYMLINK, 1) }
    const r = await go({ deps: { fs: files } })
    expect(r.exitCode).toBe(0) // the backup itself was fine
    expect(r.files).toEqual(['backup.log', FINAL])
    expect(fs.readFileSync(logPath(), 'utf8')).toBe('the log\n') // nothing was appended
    expect(r.errs).toEqual([LOG_NOT_REGULAR_ERROR])
  })

  it('has a message that holds no path', () => {
    expect(LOG_NOT_REGULAR_ERROR).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//)
  })
})

// ---- a folder that another account can change ----------------------------------------------------------------------------------------------

describe('a folder that another account can change', () => {
  // Every SID here is invented (the real ones of a machine are never in the repository): the user is SID, another user is OTHER,
  // and APP stands for the capability SID that Windows gives to application packages.
  const OTHER = 'S-1-5-21-111-222-333-1002'
  const GROUP = 'S-1-5-21-111-222-333-513'
  const APP = 'S-1-15-3-1-2-3-4-5-6-7'
  const INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  const CHANGES = 'another account is allowed to change it'
  const acl = (...entries) => `O:BAG:SYD:PAI${entries.map((entry) => `(${entry})`).join('')}`
  const asFolder = (sddl) => sharedAclProblem(sddl, { user: SID, kind: 'folder' })
  const asAncestor = (sddl) => sharedAclProblem(sddl, { user: SID, kind: 'ancestor' })
  const hex = (mask) => `0x${mask.toString(16)}`

  // The access lists that Windows writes by default, as Get-Acl prints them, with the SIDs of this test.
  const TEMP_DEFAULT = `O:${SID}G:${GROUP}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${SID})`
  const DOCUMENTS_WITH_READER = `O:${SID}G:${GROUP}D:AI(A;OICI;0x1200a9;;;${OTHER})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${SID})`
  const PROFILE_DEFAULT = `O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${SID})(A;;0x100020;;;${APP})`
  const USERS_DEFAULT = `O:SYG:SYD:PAI(A;OICIIO;GXGR;;;WD)(A;;0x1200a9;;;WD)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)(A;;0x100021;;;${APP})`
  const ROOT_DEFAULT = `O:${INSTALLER}G:${INSTALLER}D:PAI(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;;0x1000a1;;;${APP})`
  // The temp folder of a machine where a second user and a group have Modify through an explicit entry that is inherited
  const TEMP_WITH_MODIFY = `${TEMP_DEFAULT}(A;OICI;0x1301bf;;;${OTHER})(A;OICI;0x1301bf;;;${GROUP})`
  // A folder above, with full control for an application package that applies to the folder itself (and is inherited)
  const LOCAL_WITH_APP = `O:${SID}G:${GROUP}D:AI(A;ID;FA;;;${APP})(A;OICIIOID;GA;;;${APP})(A;OICIID;FA;;;${SID})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`

  describe('reading a security descriptor', () => {
    it('reads the owner, the flags, the rights (aliases and hex) and the trustee of every entry', () => {
      const parsed = parseSddl(`O:${SID}G:${GROUP}D:PAI(A;OICI;FA;;;SY)(D;;0x2;;;WD)(A;OICIIOID;GRGX;;;${OTHER})S:AI(AU;SAFA;FA;;;WD)`)
      expect(parsed.owner).toBe(SID)
      expect(parsed.nullDacl).toBe(false)
      expect(parsed.aces).toEqual([
        { type: 'A', flags: ['OI', 'CI'], mask: 0x1f01ff, sid: 'SY' },
        { type: 'D', flags: [], mask: 0x2, sid: 'WD' },
        { type: 'A', flags: ['OI', 'CI', 'IO', 'ID'], mask: 0xa0000000, sid: OTHER },
      ])
    })

    it('reads a hex mask in any case, a list of aliases, an object entry, an empty list, and a descriptor with no owner', () => {
      expect(parseSddl('D:(A;;0X1301BF;;;BU)').aces[0].mask).toBe(0x1301bf)
      expect(parseSddl('D:(A;;SDWDWO;;;BU)').aces[0].mask).toBe(0x10000 | 0x40000 | 0x80000)
      expect(parseSddl(`D:(OA;;0x2;bf967aba-0de6-11d0-a285-00aa003049e2;;${OTHER})`).aces).toEqual([{ type: 'OA', flags: [], mask: 0x2, sid: OTHER }])
      expect(parseSddl('O:BAG:SYD:PAI')).toEqual({ owner: 'BA', aces: [], nullDacl: false })
      expect(parseSddl('D:(A;;FA;;;SY)').owner).toBeNull()
    })

    it('reads a descriptor with no access list at all (a NULL DACL) as that', () => {
      expect(parseSddl('O:BAG:SYD:NO_ACCESS_CONTROL')).toEqual({ owner: 'BA', aces: [], nullDacl: true })
    })

    it('throws for everything that it cannot read: nothing is guessed', () => {
      const unreadable = [
        '',
        undefined,
        null,
        'garbage',
        'O:SYG:SY', // no list
        'D:(A;;FA;;;SY', // a bracket is not closed
        'D:(A;;FA;;;SY)(', // a bracket is left open
        'D:(XA;;FA;;;WD;(Member_of {SID(BA)}))', // a conditional entry
        'D:(XD;;FA;;;WD;(Member_of {SID(BA)}))',
        'D:(A;;FA;;;WD;(Member_of {SID(BA)}))', // an allow entry with a condition after the trustee
        'D:(AU;;FA;;;WD)', // an audit entry in the list
        'D:(RA;;;;;WD;("Department",TS,0,"Sales"))', // a resource attribute
        'D:(ZA;;FA;;;WD)', // a type that does not exist
        'D:(A;;ZZ;;;WD)', // a right that does not exist
        'D:(A;;FA0x2;;;WD)', // an alias and a hex number mixed
        'D:(A;;2;;;WD)', // a decimal number
        'D:(A;;;;;WD)', // no right
        'D:(A;;FA;;;)', // no trustee
        'D:(A;;FA;;;x)', // a trustee that is neither a SID nor an alias
        'D:(A;;FA;;WD)', // too few fields
        'D:(A;;FA;;;WD;)', // too many fields
        'O:xyG:SYD:(A;;FA;;;SY)', // an owner that is not a SID or an alias
      ]
      for (const text of unreadable) {
        expect(() => parseSddl(text), String(text)).toThrow()
        expect(() => sharedAclProblem(text, { user: SID, kind: 'folder' }), String(text)).toThrow()
        expect(() => sharedAclProblem(text, { user: SID, kind: 'ancestor' }), String(text)).toThrow()
      }
    })
  })

  describe('what makes a folder one that another account can change', () => {
    // each of the rights that let an account add, delete, rename or re-permission: add file, add subdirectory, delete child,
    // delete, write DAC, write owner, generic write, generic all
    const ON_FOLDER = [0x2, 0x4, 0x40, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000]
    const ON_ANCESTOR = [0x40, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000]

    it('refuses a folder where an unknown SID has any one of the rights that change it, as a hex mask (alone or with others)', () => {
      for (const mask of ON_FOLDER) {
        expect(asFolder(acl(`A;OICI;${hex(mask)};;;${OTHER}`)), hex(mask)).toBe(CHANGES)
        expect(asFolder(acl(`A;;${hex(mask | 0x1200a9)};;;${OTHER}`)), hex(mask | 0x1200a9)).toBe(CHANGES)
      }
      for (const mask of [0x1301bf, 0x1f01ff, 0x1e01ff, 0x1201bf, 0x120116]) expect(asFolder(acl(`A;OICI;${hex(mask)};;;${OTHER}`)), hex(mask)).toBe(CHANGES)
    })

    it('refuses a folder where an unknown SID has one of the aliases that contain those rights', () => {
      for (const rights of ['FA', 'FW', 'GA', 'GW', 'WD', 'WO', 'SD', 'DC', 'CC', 'LC', 'DT', 'KA', 'KW', 'FRFW', 'GRGW', 'SDGR', 'RCWD', 'FXWO']) {
        expect(asFolder(acl(`A;OICI;${rights};;;${OTHER}`)), rights).toBe(CHANGES)
      }
    })

    it('refuses an entry for any untrusted trustee: a SID, a group alias, or an application package', () => {
      for (const trustee of [OTHER, GROUP, APP, 'WD', 'BU', 'AU', 'IU', 'NU', 'LS', 'NS', 'CO', 'S-1-1-0', 'S-1-5-11', 'S-1-5-32-545']) {
        expect(asFolder(acl(`A;OICI;FA;;;${trustee}`)), trustee).toBe(CHANGES)
      }
    })

    it('allows a folder where another account can only read, list, execute or write attributes', () => {
      for (const mask of [0x1200a9, 0x120089, 0x1200a0, 0x100020, 0x1, 0x8, 0x10, 0x20, 0x80, 0x100, 0x20000, 0x80000000, 0x20000000, 0x1000a1, 0x100021]) {
        expect(asFolder(acl(`A;OICI;${hex(mask)};;;${OTHER}`)), hex(mask)).toBeNull()
      }
      for (const rights of ['GR', 'GX', 'GRGX', 'FR', 'FX', 'FRFX', 'RC', 'KR', 'KX', 'SW', 'RP', 'WP', 'LO', 'CR']) {
        expect(asFolder(acl(`A;OICI;${rights};;;${OTHER}`)), rights).toBeNull()
      }
    })

    it('judges a folder ABOVE by the rights that move or replace the subtree: delete, delete child, re-permission, take ownership, generic write and all', () => {
      for (const mask of ON_ANCESTOR) expect(asAncestor(acl(`A;OICI;${hex(mask)};;;${OTHER}`)), hex(mask)).toBe(CHANGES)
      for (const rights of ['FA', 'GA', 'GW', 'WD', 'WO', 'SD', 'DT', 'KA', 'GRGW']) expect(asAncestor(acl(`A;OICI;${rights};;;${OTHER}`)), rights).toBe(CHANGES)
      // Modify has delete (0x10000), and so is not allowed above either
      expect(asAncestor(acl(`A;OICI;0x1301bf;;;${OTHER}`))).toBe(CHANGES)
    })

    it('allows add file and add subdirectory on a folder ABOVE: the root of the system drive gives the second to every signed-in account', () => {
      for (const mask of [0x2, 0x4, 0x6, 0x100116, 0x20006]) expect(asAncestor(acl(`A;;${hex(mask)};;;${OTHER}`)), hex(mask)).toBeNull()
      for (const rights of ['LC', 'DC', 'CC', 'FW', 'KW']) expect(asAncestor(acl(`A;;${rights};;;${OTHER}`)), rights).toBeNull()
      // and the same rights are refused on the folder itself
      for (const mask of [0x2, 0x4, 0x6, 0x100116, 0x20006]) expect(asFolder(acl(`A;;${hex(mask)};;;${OTHER}`)), hex(mask)).toBe(CHANGES)
    })

    it('ignores an entry that is inherit-only (IO): it does not apply to the folder, only to what is made in it', () => {
      for (const flags of ['OICIIO', 'CIIO', 'OIIO', 'OICIIOID', 'IO']) {
        expect(asFolder(acl(`A;${flags};FA;;;${OTHER}`)), flags).toBeNull()
        expect(asAncestor(acl(`A;${flags};GA;;;${OTHER}`)), flags).toBeNull()
      }
    })

    it('does not ignore an entry that is only inherited (ID) or only applies to the folder: those apply', () => {
      for (const flags of ['ID', 'OICIID', '', 'OICI', 'CI', 'OI']) {
        expect(asFolder(acl(`A;${flags};FA;;;${OTHER}`)), flags).toBe(CHANGES)
        expect(asAncestor(acl(`A;${flags};FA;;;${OTHER}`)), flags).toBe(CHANGES)
      }
    })

    it('ignores a deny entry: it only takes rights away', () => {
      expect(asFolder(acl(`D;;FA;;;${OTHER}`))).toBeNull()
      expect(asFolder(acl(`D;OICI;0x1301bf;;;WD`))).toBeNull()
      expect(asAncestor(acl(`D;;GA;;;${OTHER}`))).toBeNull()
      expect(asFolder(acl(`OD;;0x2;bf967aba-0de6-11d0-a285-00aa003049e2;;${OTHER}`))).toBeNull()
      expect(asFolder(acl(`OA;;0x2;bf967aba-0de6-11d0-a285-00aa003049e2;;${OTHER}`))).toBe(CHANGES) // an object entry that allows counts
    })

    it('trusts the system, the administrators, TrustedInstaller and the current user, by SID or by alias, and nobody else', () => {
      for (const trustee of ['SY', 'BA', 'S-1-5-18', 'S-1-5-32-544', INSTALLER, SID]) {
        expect(asFolder(acl(`A;OICI;FA;;;${trustee}`)), trustee).toBeNull()
        expect(asAncestor(acl(`A;OICI;FA;;;${trustee}`)), trustee).toBeNull()
      }
      // a SID that differs from the user's in one digit is another account
      expect(asFolder(acl(`A;OICI;FA;;;S-1-5-21-111-222-333-1011`))).toBe(CHANGES)
      expect(asFolder(acl(`A;OICI;FA;;;${INSTALLER}0`))).toBe(CHANGES)
      // the user is the one that the caller says: with another user, the old user is not trusted
      expect(sharedAclProblem(acl(`A;OICI;FA;;;${OTHER}`), { user: OTHER, kind: 'folder' })).toBeNull()
      expect(sharedAclProblem(acl(`A;OICI;FA;;;${SID}`), { user: OTHER, kind: 'folder' })).toBe(CHANGES)
    })

    it('refuses a folder that another account owns (an owner can change the list whatever it says), and accepts the trusted owners', () => {
      expect(asFolder(`O:${OTHER}G:SYD:PAI(A;OICI;FA;;;SY)`)).toBe('it is owned by another account')
      expect(asAncestor(`O:${OTHER}G:SYD:PAI(A;OICI;FA;;;SY)`)).toBe('it is owned by another account')
      expect(asFolder('O:WDG:SYD:PAI(A;OICI;FA;;;SY)')).toBe('it is owned by another account')
      for (const owner of ['SY', 'BA', 'S-1-5-18', 'S-1-5-32-544', INSTALLER, SID]) expect(asFolder(`O:${owner}G:SYD:PAI(A;OICI;FA;;;SY)`), owner).toBeNull()
    })

    it('refuses a folder with no access list at all (a NULL DACL gives every account full control)', () => {
      expect(asFolder('O:BAG:SYD:NO_ACCESS_CONTROL')).toMatch(/no access list at all/)
      expect(asAncestor('O:BAG:SYD:NO_ACCESS_CONTROL')).toMatch(/no access list at all/)
    })

    it('accepts an empty list: nobody has access', () => {
      expect(asFolder('O:BAG:SYD:PAI')).toBeNull()
    })

    it('judges the default access lists of Windows, with invented SIDs, the way the finding needs', () => {
      // the temp folder and the Documents folder of a normal profile (a reader with Read and Execute is fine)
      expect(asFolder(TEMP_DEFAULT)).toBeNull()
      expect(asFolder(DOCUMENTS_WITH_READER)).toBeNull()
      // the profile folder, C:\Users and C:\ as folders above
      expect(asAncestor(TEMP_DEFAULT)).toBeNull()
      expect(asAncestor(PROFILE_DEFAULT)).toBeNull()
      expect(asAncestor(USERS_DEFAULT)).toBeNull()
      expect(asAncestor(ROOT_DEFAULT)).toBeNull()
      // and as the folder itself, the profile folder and C:\Users (nobody else can add to them)
      expect(asFolder(PROFILE_DEFAULT)).toBeNull()
      expect(asFolder(USERS_DEFAULT)).toBeNull()
      // C:\ lets every signed-in account create a folder in it (LC is 0x4): fine above, not as the folder itself
      expect(asFolder(ROOT_DEFAULT)).toBe(CHANGES)
    })

    it('judges the shapes of a shared machine: a temp folder with an explicit Modify for another user, a folder above with full control for an application package', () => {
      expect(asFolder(TEMP_WITH_MODIFY)).toBe(CHANGES)
      expect(asAncestor(TEMP_WITH_MODIFY)).toBe(CHANGES)
      expect(asAncestor(LOCAL_WITH_APP)).toBe(CHANGES)
      expect(asFolder(LOCAL_WITH_APP)).toBe(CHANGES)
    })

    it('says which folder in a message that holds no account, no SID and no path', () => {
      const all = [
        [['itself'], 'the backup folder itself'],
        [['above'], 'a folder above the backup folder'],
        [['above', 'itself'], 'the backup folder itself, a folder above the backup folder'],
        [['itself', 'above', 'itself', 'above'], 'the backup folder itself, a folder above the backup folder'],
      ]
      for (const [levels, which] of all) {
        const message = sharedFoldersMessage(levels)
        expect(message).toBe(`${SHARED_FOLDERS_PREFIX}${which}${SHARED_FOLDERS_ADVICE}`)
        expect(message).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\/|S-1-|\\/)
      }
      expect(SHARED_FOLDERS_ADVICE).toMatch(/your own profile/)
      expect(SHARED_FOLDERS_ADVICE).not.toMatch(/TEMP|TMPDIR/) // the temp folder is not part of this: nothing depends on it
      expect(SHARED_UNREADABLE_ERROR).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\/|TEMP|TMPDIR|temp folder/)
    })
  })

  // ---- in a run --------------------------------------------------------------------------------------------------------------------------

  /**
   * The folders of one test: the output folder (dir) inside out-root, so that "the backup folder itself" and "a folder above the
   * backup folder" can be told apart. The output folder is made unless `outExists` is false.
   */
  function layout({ outExists = true } = {}) {
    const outRoot = path.join(tmp, 'out-root')
    dir = path.join(outRoot, 'backups')
    fs.mkdirSync(outRoot, { recursive: true })
    if (outExists) fs.mkdirSync(dir, { recursive: true })
    return { outRoot }
  }
  const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase()
  /** A runner whose PowerShell answers with `pick(path)` for every path that it is asked about (and the rest as the defaults do). */
  const where = (pick, extra = {}) =>
    makeRunner({
      powershell: ({ options }) => ({
        status: 0,
        stdout: sddlLines(options.env.BQR_ACL_PATHS.split('|').map(pick)),
        stderr: '#< CLIXML\r\n',
      }),
      ...extra,
    })
  /** A runner whose PowerShell says that these folders are shared (a Modify for another user) and everything else is private. */
  const sharing = (...folders) => where((folder) => (folders.some((shared) => same(folder, shared)) ? TEMP_WITH_MODIFY : SAFE_SDDL))
  const fakeWindows = (deps = {}) => ({ platform: 'win32', exists: () => false, ...deps, env: { SystemRoot: 'C:\\Windows', ...deps.env } })
  const refusal = (which) => `${SHARED_FOLDERS_PREFIX}${which}${SHARED_FOLDERS_ADVICE}`

  describe('on Windows', () => {
    /** One run with everything made visible: the file system calls that make something, and the answers. */
    async function runWith(runner, { keep = 1, deps = {} } = {}) {
      const rec = recordingFs()
      const r = await go({ options: { keep }, runner, deps: fakeWindows({ fs: rec.fs, ...deps }) })
      return { ...r, rec }
    }

    it('refuses an output folder that another account can change, before anything is made: no work directory, no tool, no log, nothing rotated', async () => {
      layout()
      seed(oldBackups)
      const r = await runWith(sharing(dir))
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(refusal('the backup folder itself'))
      expect(r.runner.calls.map((call) => call.tool)).toEqual(['whoami', 'powershell']) // not icacls, not the Neon CLI, not pg_dump
      expect(r.rec.events).toEqual([]) // no mkdir, no mkdtemp
      expect(workDirsNow()).toEqual([])
      expect(r.files).toEqual(oldBackups) // no backup.log, no rotation
      expect(r.log).toBe('')
      expect(r.errs).toEqual([LOG_SKIPPED, `backup failed: ${refusal('the backup folder itself')}`])
      expect(r.message).not.toContain(OTHER)
      expect(visible(r)).not.toContain(tmp)
    })

    it('refuses a folder above the output folder: no log, because the output folder could have been replaced', async () => {
      const { outRoot } = layout()
      seed(oldBackups)
      const r = await runWith(sharing(outRoot))
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(refusal('a folder above the backup folder'))
      expect(r.files).toEqual(oldBackups)
      expect(r.log).toBe('')
      expect(r.errs).toEqual([LOG_SKIPPED, `backup failed: ${refusal('a folder above the backup folder')}`])
      expect(r.rec.events).toEqual([])
      expect(r.runner.of('pg_dump')).toEqual([])
    })

    it('names both when the folder and a folder above it can be changed', async () => {
      const { outRoot } = layout()
      const r = await runWith(sharing(dir, outRoot))
      expect(r.message).toBe(refusal('the backup folder itself, a folder above the backup folder'))
      expect(r.rec.events).toEqual([])
    })

    it('refuses an ancestor with any one of the dangerous rights (and accepts the one that only adds a subfolder), for every ancestor that there is', async () => {
      const { outRoot } = layout()
      const everyFolder = []
      for (let cur = path.resolve(dir); ; cur = path.win32.dirname(cur)) {
        everyFolder.push(cur)
        if (path.win32.dirname(cur) === cur) break
      }
      expect(everyFolder.length).toBeGreaterThan(3)
      for (const rights of ['0x10000', '0x40', '0x40000', '0x80000', 'GW', 'GA']) {
        for (const ancestor of everyFolder.slice(1)) {
          const risky = acl(`A;OICI;${rights};;;${OTHER}`)
          const r = await runWith(where((folder) => (same(folder, ancestor) ? risky : SAFE_SDDL)))
          expect(r.exitCode, `${rights} on ${path.basename(ancestor)}`).toBe(1)
          expect(r.message, `${rights} on ${path.basename(ancestor)}`).toBe(refusal('a folder above the backup folder'))
          expect(r.rec.events).toEqual([])
        }
      }
      for (const ancestor of [outRoot, tmp]) {
        const r = await runWith(where((folder) => (same(folder, ancestor) ? acl(`A;;LC;;;${OTHER}`) : SAFE_SDDL)))
        expect(r.exitCode, path.basename(ancestor)).toBe(0)
      }
    })

    it('refuses a folder that another account owns', async () => {
      const { outRoot } = layout()
      const r = await runWith(where((folder) => (same(folder, outRoot) ? `O:${OTHER}G:SYD:PAI(A;OICI;FA;;;SY)` : SAFE_SDDL)))
      expect(r.message).toBe(refusal('a folder above the backup folder'))
    })

    it('refuses a folder that is not made yet through the nearest folder that exists (the one that the new folder is made in)', async () => {
      const { outRoot } = layout({ outExists: false })
      const r = await runWith(sharing(outRoot))
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(refusal('the backup folder itself'))
      expect(fs.existsSync(dir)).toBe(false) // not made
      expect(r.log).toBe('')
      expect(r.errs[0]).toBe(LOG_SKIPPED)
      expect(r.rec.events).toEqual([])
    })

    it('accepts the default access lists of Windows (the profile folder, C:\\Users and C:\\, with invented SIDs)', async () => {
      layout()
      const r = await runWith(
        where((folder) => {
          const parent = path.win32.dirname(folder)
          if (parent === folder) return ROOT_DEFAULT
          if (path.win32.dirname(parent) === parent) return USERS_DEFAULT
          return same(folder, tmp) ? DOCUMENTS_WITH_READER : PROFILE_DEFAULT
        }),
      )
      expect(r.exitCode).toBe(0)
      expect(r.log).toContain(' ok host=')
    })

    it('accepts entries that do not apply (inherit-only, deny) for another account on every folder', async () => {
      layout()
      const quiet = `${SAFE_SDDL}(A;OICIIO;GA;;;${OTHER})(A;CIIOID;FA;;;WD)(D;;FA;;;${OTHER})(D;OICI;0x1301bf;;;WD)`
      const r = await runWith(where(() => quiet))
      expect(r.exitCode).toBe(0)
    })

    it('refuses when the access lists cannot be read: PowerShell fails, is missing, does not finish, or gives too little or something odd', async () => {
      const lines = (...sddls) => ({ status: 0, stdout: sddlLines(sddls), stderr: '' })
      const conditional = `O:BAG:SYD:PAI(XA;;FA;;;WD;(Member_of {SID(BA)}))`
      const answers = {
        'a failing PowerShell': () => ({ status: 1, stdout: '', stderr: 'Get-Acl : cannot find the path' }),
        'a PowerShell that is missing': () => ({ status: null, stdout: '', stderr: '', problem: 'ENOENT' }),
        'a PowerShell that does not finish': () => ({ status: null, stdout: '', stderr: '', problem: 'TIMEOUT' }),
        'no output': () => ({ status: 0, stdout: '', stderr: '' }),
        // a call that did not end well is not trusted, whatever it printed before
        'an exit code that is not 0, after a full output': ({ options }) => ({ status: 1, stdout: sddlLines(options.env.BQR_ACL_PATHS.split('|').map(() => SAFE_SDDL)), stderr: '' }),
        'a call that was stopped, after a full output': ({ options }) => ({ status: null, problem: 'TIMEOUT', stdout: sddlLines(options.env.BQR_ACL_PATHS.split('|').map(() => SAFE_SDDL)), stderr: '' }),
        'the first path only': () => lines(SAFE_SDDL),
        'a line that is not "index TAB sddl"': () => ({ status: 0, stdout: 'garbage\r\n', stderr: '' }),
        'a descriptor that cannot be read': ({ options }) => lines(...options.env.BQR_ACL_PATHS.split('|').map(() => 'not an sddl')),
        'a conditional entry': ({ options }) => lines(...options.env.BQR_ACL_PATHS.split('|').map((_, index) => (index === 0 ? conditional : SAFE_SDDL))),
        'a conditional entry on a folder above': ({ options }) => lines(...options.env.BQR_ACL_PATHS.split('|').map((_, index, all) => (index === all.length - 1 ? conditional : SAFE_SDDL))),
      }
      for (const [what, answer] of Object.entries(answers)) {
        layout({ outExists: false })
        const r = await runWith(makeRunner({ powershell: answer }))
        expect(r.exitCode, what).toBe(1)
        expect(r.message, what).toBe(SHARED_UNREADABLE_ERROR)
        expect(r.runner.of('pg_dump'), what).toEqual([])
        expect(r.rec.events, what).toEqual([])
        expect(fs.existsSync(dir), what).toBe(false) // the output folder is not even made, and no log is written in a folder that is not known
        expect(r.errs, what).toEqual([`backup failed: ${SHARED_UNREADABLE_ERROR}`])
      }
    })

    it('refuses a descriptor with no access list at all (a NULL DACL)', async () => {
      layout()
      const r = await runWith(where((folder) => (same(folder, dir) ? 'O:BAG:SYD:NO_ACCESS_CONTROL' : SAFE_SDDL)))
      expect(r.message).toBe(refusal('the backup folder itself'))
    })

    it('reads every path with ONE PowerShell call: a full path to the tool, an encoded script, the paths in an environment variable', async () => {
      const { outRoot } = layout()
      const r = await runWith(makeRunner())
      expect(r.exitCode).toBe(0)
      expect(r.runner.calls.map((call) => call.tool).slice(0, 2)).toEqual(['whoami', 'powershell'])
      const calls = r.runner.of('powershell')
      expect(calls).toHaveLength(1)
      const [call] = calls
      expect(call.command).toBe(powershellTool({ SystemRoot: 'C:\\Windows' }))
      expect(call.command).toBe(path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
      expect(call.args).toHaveLength(5)
      expect(call.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
      const script = Buffer.from(call.args[4], 'base64').toString('utf16le')
      expect(script).toContain('Get-Acl -LiteralPath')
      expect(script).toContain('.Sddl')
      expect(script).toContain('$env:BQR_ACL_PATHS')
      expect(script).not.toContain(path.basename(tmp)) // no path in the script, so nothing to quote
      // the paths: the output folder and what is above it, up to the root of the drive, each once
      const paths = call.options.env.BQR_ACL_PATHS.split('|')
      expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length)
      expect(paths.slice(0, 3).map((p) => p.toLowerCase())).toEqual([dir, outRoot, tmp].map((p) => path.resolve(p).toLowerCase()))
      expect(path.win32.dirname(paths.at(-1))).toBe(paths.at(-1)) // the root of the drive is the last
      // the environment of the call holds no database address and no PG variable
      expect(call.options.env.BACKUP_DATABASE_URL).toBeUndefined()
      expect(call.options.env.SystemRoot).toBe('C:\\Windows')
      expect(call.options.timeoutMs).toBeGreaterThan(0)
      expect(JSON.stringify(call.args)).not.toContain(PASSWORD)
    })

    it('reads for the nearest existing folder when the output folder is not made yet, and does not make it first', async () => {
      const { outRoot } = layout({ outExists: false })
      const r = await runWith(makeRunner())
      expect(r.exitCode).toBe(0)
      expect(r.runner.of('powershell')).toHaveLength(1)
      const paths = r.runner.of('powershell')[0].options.env.BQR_ACL_PATHS.split('|')
      expect(paths[0].toLowerCase()).toBe(path.resolve(outRoot).toLowerCase())
      expect(paths.map((p) => p.toLowerCase())).not.toContain(path.resolve(dir).toLowerCase())
    })

    it('does the check once per run, before the connection string is asked for and before anything is dumped', async () => {
      layout()
      const r = await runWith(makeRunner())
      const tools = r.runner.calls.map((call) => call.tool)
      expect(tools.filter((tool) => tool === 'powershell')).toHaveLength(1)
      expect(tools.indexOf('powershell')).toBeLessThan(tools.indexOf('pg_dump'))
    })

    it('does not ask the folders of a run that is refused for another reason first (the path is too long): no PowerShell', async () => {
      layout()
      const long = path.join(dir, 'x'.repeat(240))
      const r = await go({ options: { out: long }, runner: makeRunner(), deps: fakeWindows() })
      expect(r.message).toBe(PATH_TOO_LONG_ERROR)
      expect(r.runner.of('powershell')).toEqual([])
    })

    it('does not look at the temp folder at all: a shared %TEMP% changes nothing', async () => {
      layout()
      const sharedTemp = path.join(tmp, 'shared-temp')
      fs.mkdirSync(sharedTemp)
      const asked = []
      const runner = where((folder) => {
        asked.push(folder)
        return same(folder, sharedTemp) ? TEMP_WITH_MODIFY : SAFE_SDDL
      })
      const r = await runWith(runner, { deps: { env: { TEMP: sharedTemp, TMP: sharedTemp, TMPDIR: sharedTemp } } })
      expect(r.exitCode).toBe(0)
      expect(r.runner.of('powershell')[0].options.env.BQR_ACL_PATHS.toLowerCase()).not.toContain('shared-temp')
      expectWorkCwd(r.runner.of('pg_dump')[0].options.cwd) // the work directory is in the output folder, whatever TEMP says
      expect(fs.readdirSync(sharedTemp)).toEqual([]) // nothing was made there
    })
  })

  describe('on Linux', () => {
    // modes: [folder, mode, owner uid (UID when left out)]; a mode of null makes the stat fail
    const modeOf = (modes) => (target, ...rest) => {
      const key = path.resolve(String(target))
      for (const [folder, mode, uid = UID] of modes) {
        if (path.resolve(folder) !== key) continue
        if (mode === null) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        return { mode, uid }
      }
      return privateStat(target, ...rest)
    }
    async function runWith(modes, { keep = 1, deps = {} } = {}) {
      const rec = recordingFs()
      const stat = modeOf(modes)
      const r = await go({ options: { keep }, deps: { fs: { ...rec.fs, statSync: stat }, ...deps } })
      return { ...r, rec }
    }

    it('refuses a folder above the output folder that the group or others can write in, unless it has the sticky bit', async () => {
      const { outRoot } = layout()
      seed(oldBackups)
      // others, and the group (a member of the group could rename the whole subtree, and the members are not known)
      for (const mode of [0o040777, 0o040707, 0o040702, 0o040770, 0o040775, 0o040760, 0o040720, 0o040772]) {
        const r = await runWith([[outRoot, mode]])
        expect(r.exitCode, mode.toString(8)).toBe(1)
        expect(r.message, mode.toString(8)).toBe(refusal('a folder above the backup folder'))
        expect(r.runner.calls, mode.toString(8)).toEqual([])
        expect(r.rec.events, mode.toString(8)).toEqual([])
        expect(r.log, mode.toString(8)).toBe('')
        expect(r.errs[0], mode.toString(8)).toBe(LOG_SKIPPED)
        expect(r.files, mode.toString(8)).toEqual(oldBackups)
      }
      // the folder of the test is above the output folder as well
      const high = await runWith([[tmp, 0o040777]])
      expect(high.message).toBe(refusal('a folder above the backup folder'))
      const high770 = await runWith([[tmp, 0o040770]])
      expect(high770.message).toBe(refusal('a folder above the backup folder'))
      // sticky (this is /tmp: nobody can rename or delete what they do not own), and a folder that the group and others can only read
      for (const mode of [0o041777, 0o041707, 0o041770, 0o041775, 0o040755, 0o040750, 0o040705, 0o040700]) {
        for (const folder of [outRoot, tmp]) {
          const r = await runWith([[folder, mode]])
          expect(r.exitCode, `${mode.toString(8)} on ${path.basename(folder)}`).toBe(0)
          seed([])
        }
      }
    })

    it('judges the nearest folder that exists for an output folder that is not made yet, and makes nothing when it is shared', async () => {
      const { outRoot } = layout({ outExists: false })
      const r = await runWith([[outRoot, 0o040777]])
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(refusal('the backup folder itself'))
      expect(fs.existsSync(dir)).toBe(false)
      expect(r.errs[0]).toBe(LOG_SKIPPED)
      expect(r.rec.events).toEqual([])
      const group = await runWith([[outRoot, 0o040770]])
      expect(group.message).toBe(refusal('the backup folder itself'))
      expect(fs.existsSync(dir)).toBe(false)
      for (const mode of [0o041777, 0o041770]) {
        const sticky = await runWith([[outRoot, mode]])
        expect(sticky.exitCode, mode.toString(8)).toBe(0)
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses a folder above that another account owns, even with the sticky bit (the owner can rename or delete any child), and accepts one that root owns', async () => {
      const { outRoot } = layout()
      seed(oldBackups)
      // owned by another uid: refused whatever the mode is, sticky or not
      for (const mode of [0o041777, 0o041770, 0o041755, 0o040755, 0o040700, 0o040777]) {
        for (const folder of [outRoot, tmp]) {
          const r = await runWith([[folder, mode, OTHER_UID]])
          expect(r.exitCode, `${mode.toString(8)} on ${path.basename(folder)}`).toBe(1)
          expect(r.message, mode.toString(8)).toBe(refusal('a folder above the backup folder'))
          expect(r.runner.calls).toEqual([])
          expect(r.rec.events).toEqual([])
          expect(r.log).toBe('')
          expect(r.errs[0]).toBe(LOG_SKIPPED)
          expect(r.files).toEqual(oldBackups)
        }
      }
      // any other uid is another account, a system account (such as 33) as well as one above the user's own
      for (const uid of [33, 999, 1002, 65534]) {
        const r = await runWith([[outRoot, 0o041777, uid]])
        expect(r.message, String(uid)).toBe(refusal('a folder above the backup folder'))
      }
      // owned by root: accepted, sticky (like /tmp) or plain (like /home or /)
      for (const mode of [0o041777, 0o041770, 0o040755, 0o040750]) {
        for (const folder of [outRoot, tmp]) {
          const r = await runWith([[folder, mode, ROOT_UID]])
          expect(r.exitCode, `${mode.toString(8)} root on ${path.basename(folder)}`).toBe(0)
          seed([])
        }
      }
      // owned by the user: the sticky exception holds (a world-writable sticky folder of the user's own)
      const own = await runWith([[outRoot, 0o041777, UID]])
      expect(own.exitCode).toBe(0)
      // and a folder that root owns but that is writable by others WITHOUT the sticky bit is still refused
      const open = await runWith([[outRoot, 0o040777, ROOT_UID]])
      expect(open.message).toBe(refusal('a folder above the backup folder'))
    })

    it('refuses a backup folder that another account owns, whatever its mode, and accepts one that root owns', async () => {
      layout()
      for (const mode of [0o040700, 0o040755, 0o041777]) {
        const r = await runWith([[dir, mode, OTHER_UID]])
        expect(r.exitCode, mode.toString(8)).toBe(1)
        expect(r.message, mode.toString(8)).toBe(refusal('the backup folder itself'))
        expect(r.runner.calls).toEqual([])
        expect(r.rec.events).toEqual([])
        expect(r.errs[0]).toBe(LOG_SKIPPED)
        expect(r.log).toBe('')
      }
      // root's own folder passes this check (the mode check of the folder itself, and the permissions, then decide)
      const root = await runWith([[dir, 0o040700, ROOT_UID]])
      expect(root.exitCode).toBe(0)
    })

    it('refuses the nearest folder that exists, for a backup folder that is not made yet, when another account owns it', async () => {
      const { outRoot } = layout({ outExists: false })
      const r = await runWith([[outRoot, 0o040755, OTHER_UID]])
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(refusal('the backup folder itself'))
      expect(fs.existsSync(dir)).toBe(false)
      expect(r.rec.events).toEqual([])
      const root = await runWith([[outRoot, 0o040755, ROOT_UID]])
      expect(root.exitCode).toBe(0)
    })

    it('names both when the backup folder is owned by another account and a folder above it is open', async () => {
      const { outRoot } = layout()
      const r = await runWith([[dir, 0o040700, OTHER_UID], [outRoot, 0o040777]])
      expect(r.message).toBe(refusal('the backup folder itself, a folder above the backup folder'))
    })

    it('refuses when the owner cannot be read or the user is not known: not known is not trusted', async () => {
      layout()
      const noOwner = (target, ...rest) => {
        const info = privateStat(target, ...rest)
        return path.resolve(String(target)) === path.resolve(tmp) ? { mode: info.mode } : info
      }
      for (const [what, deps] of Object.entries({
        'a stat with no uid': { fs: { ...fs, statSync: noOwner } },
        'no getuid': { getuid: null },
        'a getuid that gives nothing': { getuid: () => undefined },
      })) {
        const r = await go({ deps })
        expect(r.exitCode, what).toBe(1)
        expect(r.message, what).toBe(SHARED_UNREADABLE_ERROR)
        expect(r.runner.calls, what).toEqual([])
        expect(r.errs, what).toEqual([`backup failed: ${SHARED_UNREADABLE_ERROR}`])
      }
    })

    it('asks the system for the user by default (process.getuid), and does not need it on Windows', async () => {
      layout()
      if (typeof process.getuid === 'function') {
        // the real uid with files that really belong to this account: the whole chain of the real folder of the test passes
        const real = await runBackup(
          { out: dir, keep: 30, neonProject: null, neonBranch: 'main', reportIssue: null, pgBin: null },
          { env: { BACKUP_DATABASE_URL: URL_FAKE, PATH: '/usr/bin' }, platform: 'linux', exists: () => false, runner: makeRunner(), now: () => NOW, out: () => {}, err: () => {} },
        )
        expect(real.exitCode).toBe(0)
      }
      const win = await go({ deps: fakeWindows({ getuid: undefined }) })
      expect(win.exitCode).toBe(0)
    })

    it('still refuses the output folder itself when group or others can write in it (the message of the mode check)', async () => {
      layout()
      const r = await runWith([[dir, 0o040777]])
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(FOLDER_WRITABLE_ERROR)
      expect(r.runner.calls).toEqual([])
      expect(r.errs[0]).toBe(LOG_SKIPPED)
    })

    it('refuses when a folder of the chain cannot be inspected: a folder that is not known is not trusted', async () => {
      const { outRoot } = layout({ outExists: false })
      for (const folder of [outRoot, tmp]) {
        const r = await runWith([[folder, null]])
        expect(r.exitCode).toBe(1)
        expect(r.message).toBe(SHARED_UNREADABLE_ERROR)
        expect(r.errs).toEqual([`backup failed: ${SHARED_UNREADABLE_ERROR}`])
        expect(r.runner.calls).toEqual([])
        expect(fs.existsSync(dir)).toBe(false)
      }
    })

    it('does not run PowerShell, and does not read an access list', async () => {
      layout()
      const r = await runWith([])
      expect(r.exitCode).toBe(0)
      expect(r.runner.of('powershell')).toEqual([])
      expect(r.runner.of('whoami')).toEqual([])
    })

    it('does not look at the temp folder at all: a TMPDIR that everybody can write in changes nothing', async () => {
      layout()
      const sharedTemp = path.join(tmp, 'shared-temp')
      fs.mkdirSync(sharedTemp)
      const r = await runWith([[sharedTemp, 0o040777]], { deps: { env: { TMPDIR: sharedTemp, TEMP: sharedTemp, TMP: sharedTemp } } })
      expect(r.exitCode).toBe(0)
      expectWorkCwd(r.runner.of('pg_dump')[0].options.cwd)
      expect(fs.readdirSync(sharedTemp)).toEqual([])
    })
  })

  describe('a backup folder that is a link, or is in one', () => {
    // The folders that count are the real ones. The chain of parents is walked by name, and a link in the path would make the
    // check judge the folders of the link and not the folders of its target, so --out is resolved first (realpath), and the check,
    // the work directory, the log and the rename all use the real path.
    const statting = (modes) => (target, ...rest) => {
      const key = path.resolve(String(target))
      for (const [folder, mode, uid = UID] of modes) if (path.resolve(folder) === key) return { mode, uid }
      return privateStat(target, ...rest)
    }
    /**
     * A file system whose lstat and realpath see `alias` as `target`, as a link would, for a platform where a link needs a privilege.
     * Everything else is the real one, and `events` records what is made.
     */
    function throughAlias(alias, target, { modes = [] } = {}) {
      const events = []
      const through = (p) => {
        const text = String(p)
        return text === alias || text.startsWith(alias + path.sep) ? path.join(target, text.slice(alias.length)) : text
      }
      const resolved = (p, ...rest) => fs.realpathSync(through(p), ...rest)
      resolved.native = (p, ...rest) => fs.realpathSync.native(through(p), ...rest)
      return {
        events,
        fs: {
          ...fs,
          statSync: statting(modes),
          lstatSync: (p, ...rest) => fs.lstatSync(through(p), ...rest),
          realpathSync: resolved,
          mkdirSync: (p, o) => {
            events.push('mkdir')
            return fs.mkdirSync(p, o)
          },
          mkdtempSync: (prefix, ...rest) => {
            events.push(`mkdtemp ${path.dirname(String(prefix))}`)
            return fs.mkdtempSync(prefix, ...rest)
          },
        },
      }
    }
    /** The folders of one test: a shared parent with the real backup folder in it, and the name of a link to that parent. */
    function links() {
      const shared = path.join(tmp, 'shared')
      const real = path.join(shared, 'backups')
      fs.mkdirSync(real, { recursive: true })
      dir = real // what the helpers look at (the log, the listing): the REAL folder
      return { shared, real, alias: path.join(tmp, 'via-alias') }
    }

    it('on Linux judges the folders of the target: a link into a folder that the group or others can write in is refused, nothing is made', async () => {
      const { shared, real, alias } = links()
      for (const mode of [0o040777, 0o040770, 0o040775]) {
        const spy = throughAlias(alias, shared, { modes: [[shared, mode]] })
        const r = await go({ options: { out: path.join(alias, 'backups') }, deps: { fs: spy.fs } })
        expect(r.exitCode, mode.toString(8)).toBe(1)
        expect(r.message, mode.toString(8)).toBe(refusal('a folder above the backup folder'))
        expect(r.runner.calls, mode.toString(8)).toEqual([])
        expect(spy.events, mode.toString(8)).toEqual([]) // nothing made
        expect(fs.existsSync(alias), mode.toString(8)).toBe(false) // and nothing made at the path of the link, either
        expect(fs.readdirSync(real), mode.toString(8)).toEqual([])
        expect(r.log, mode.toString(8)).toBe('')
        expect(r.errs[0], mode.toString(8)).toBe(LOG_SKIPPED)
      }
    })

    it('on Linux, a link to a private folder passes, and the work directory, the log and the dump are in the real folder', async () => {
      const { shared, real, alias } = links()
      const spy = throughAlias(alias, shared, { modes: [[shared, 0o040755]] })
      const r = await go({ options: { out: path.join(alias, 'backups') }, deps: { fs: spy.fs } })
      expect(r.exitCode).toBe(0)
      expect(spy.events).toEqual(['mkdir', `mkdtemp ${real}`]) // the folder, then the work directory, both by the real path
      expectWorkCwd(r.runner.of('pg_dump')[0].options.cwd) // dir is the real folder here
      expect(fs.existsSync(path.join(real, FINAL))).toBe(true)
      expect(r.log).toContain(' ok host=')
      expect(fs.existsSync(alias)).toBe(false) // nothing went back through the path of the link
      expect(visible(r)).not.toContain(tmp)
    })

    it('on Windows, runs the check on the real chain: the access lists that are read are the ones of the target and its parents', async () => {
      const { shared, real, alias } = links()
      const spy = throughAlias(alias, shared)
      const asked = []
      const runner = where((folder) => {
        asked.push(folder)
        return same(folder, shared) ? TEMP_WITH_MODIFY : SAFE_SDDL
      })
      const refused = await go({ options: { out: path.join(alias, 'backups') }, runner, deps: fakeWindows({ fs: spy.fs }) })
      expect(refused.exitCode).toBe(1)
      expect(refused.message).toBe(refusal('a folder above the backup folder'))
      expect(spy.events).toEqual([])
      const paths = refused.runner.of('powershell')[0].options.env.BQR_ACL_PATHS.split('|').map((p) => p.toLowerCase())
      expect(paths.slice(0, 2)).toEqual([real, shared].map((p) => p.toLowerCase())) // the real folder and its real parent
      expect(paths.join('|')).not.toContain('via-alias') // the link is never looked at
      expect(fs.existsSync(alias)).toBe(false)
      // with a private parent the same link passes, and everything is done in the real folder
      const spyOk = throughAlias(alias, shared)
      const ok = await go({ options: { out: path.join(alias, 'backups') }, runner: makeRunner(), deps: fakeWindows({ fs: spyOk.fs }) })
      expect(ok.exitCode).toBe(0)
      expect(spyOk.events).toEqual(['mkdir', `mkdtemp ${real}`])
      expectWorkCwd(ok.runner.of('pg_dump')[0].options.cwd)
      expect(fs.existsSync(path.join(real, FINAL))).toBe(true)
      for (const call of ok.runner.of('icacls')) expect(String(call.options.cwd ?? '').toLowerCase()).not.toContain('via-alias')
    })

    it('resolves a link that is only a part of the path, and a folder that is not made yet below it', async () => {
      const { shared, alias } = links()
      const spy = throughAlias(alias, shared, { modes: [[shared, 0o040777]] })
      const r = await go({ options: { out: path.join(alias, 'not', 'made', 'yet') }, deps: { fs: spy.fs } })
      expect(r.exitCode).toBe(1)
      // the nearest folder that exists is the real shared folder, which stands in for the output folder
      expect(r.message).toBe(refusal('the backup folder itself'))
      expect(spy.events).toEqual([])
      expect(fs.existsSync(path.join(shared, 'not'))).toBe(false)
    })

    it('with a real link (where this platform can make one): a link into a shared folder is refused, a link to a private folder passes and the dump lands in the real folder', async () => {
      const { shared, real } = links()
      const link = path.join(tmp, 'via-link-a')
      try {
        fs.symlinkSync(real, link, 'junction') // a junction on Windows needs no privilege
      } catch {
        return // this platform needs a privilege to make a link: the tests above cover the check through the injected file system
      }
      const parentLink = path.join(tmp, 'via-link-b')
      fs.symlinkSync(shared, parentLink, 'junction')
      // Linux: the real parent is writable by others
      for (const out of [link, path.join(parentLink, 'backups')]) {
        const refused = await go({ options: { out }, deps: { fs: { ...fs, statSync: statting([[shared, 0o040777]]) } } })
        expect(refused.exitCode, out).toBe(1)
        expect(refused.message, out).toBe(refusal('a folder above the backup folder'))
        expect(fs.readdirSync(real), out).toEqual([])
      }
      // Windows (the platform is faked, the links are real): the real parent is shared
      const asked = []
      const runner = where((folder) => {
        asked.push(folder)
        return same(folder, shared) ? TEMP_WITH_MODIFY : SAFE_SDDL
      })
      for (const out of [link, path.join(parentLink, 'backups')]) {
        const refused = await go({ options: { out }, runner, deps: fakeWindows({ fs: { ...fs, statSync: privateStat } }) })
        expect(refused.exitCode, out).toBe(1)
        expect(refused.message, out).toBe(refusal('a folder above the backup folder'))
      }
      expect(asked.map((folder) => folder.toLowerCase()).some((folder) => folder.includes('via-link'))).toBe(false)
      // a private parent: it passes, and the dump is in the real folder
      const ok = await go({ options: { out: link }, deps: { fs: { ...fs, statSync: statting([[shared, 0o040755]]) } } })
      expect(ok.exitCode).toBe(0)
      expect(fs.existsSync(path.join(real, FINAL))).toBe(true)
      expectWorkCwd(ok.runner.of('pg_dump')[0].options.cwd)
    })

    it('refuses a link that points at nothing, and a part of the path that cannot be inspected or resolved: not known is not trusted', async () => {
      const { shared, alias } = links()
      const broken = {
        'a link that points at nothing (realpath says it is not there)': (spy) => {
          spy.fs.realpathSync.native = () => {
            throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${alias}'`), { code: 'ENOENT' })
          }
        },
        'a part that cannot be read (EACCES)': (spy) => {
          spy.fs.realpathSync.native = () => {
            throw Object.assign(new Error(`EACCES: permission denied, lstat '${alias}'`), { code: 'EACCES' })
          }
        },
        'an lstat that is refused for the folder (not for the folders above it)': (spy) => {
          spy.fs.lstatSync = (p, ...rest) => {
            if (String(p).startsWith(alias)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
            return fs.lstatSync(p, ...rest)
          }
        },
        'a file system that cannot resolve at all': (spy) => {
          delete spy.fs.realpathSync
        },
      }
      for (const [what, breakIt] of Object.entries(broken)) {
        for (const platform of ['linux', 'win32']) {
          const spy = throughAlias(alias, shared)
          breakIt(spy)
          const r = await go({ options: { out: path.join(alias, 'backups') }, deps: platform === 'win32' ? fakeWindows({ fs: spy.fs }) : { fs: spy.fs } })
          expect(r.exitCode, `${what} on ${platform}`).toBe(1)
          expect(r.message, what).toBe(SHARED_UNREADABLE_ERROR)
          expect(r.runner.calls, what).toEqual([]) // not even whoami
          expect(spy.events, what).toEqual([])
          expect(r.log, what).toBe('')
          expect(r.errs, what).toEqual([`backup failed: ${SHARED_UNREADABLE_ERROR}`])
          expect(r.message, what).not.toContain(tmp)
        }
      }
    })

    it('refuses a real link that points at nothing (where this platform can make one)', async () => {
      const link = path.join(tmp, 'dangling')
      try {
        fs.symlinkSync(path.join(tmp, 'nowhere'), link, 'junction')
      } catch {
        return
      }
      const r = await go({ options: { out: link } })
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(SHARED_UNREADABLE_ERROR)
      expect(fs.existsSync(path.join(tmp, 'nowhere'))).toBe(false)
      expect(r.runner.calls).toEqual([])
    })

    it('measures the limit of Windows on the resolved path, which can be longer than the one that was given', async () => {
      const { shared, alias } = links()
      const spy = throughAlias(alias, shared)
      const longReal = path.join(tmp, 'z'.repeat(WINDOWS_PATH_LIMIT))
      spy.fs.realpathSync.native = () => longReal
      const r = await go({ options: { out: path.join(alias, 'backups') }, deps: fakeWindows({ fs: spy.fs }) })
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(PATH_TOO_LONG_ERROR)
      expect(r.runner.calls).toEqual([])
      expect(spy.events).toEqual([])
    })

    it('leaves a folder with no link in it as it is: the same real path, so nothing else changes', async () => {
      const { real } = links()
      const r = await go({ options: { out: real } })
      expect(r.exitCode).toBe(0)
      expect(fs.existsSync(path.join(real, FINAL))).toBe(true)
    })
  })

  it('keeps the per-path checks as a second net: the work directory list and the checks of backup.log are still made', async () => {
    // (tests above: "the access list of the work directory is read back on Windows", "a backup.log that is a link or has another name")
    layout()
    const r = await go({ runner: makeRunner(), deps: fakeWindows({ fs: { ...fs, statSync: privateStat } }) })
    expect(r.exitCode).toBe(0)
    const icacls = r.runner.of('icacls')
    expect(icacls.some((call) => call.args.length === 1 && call.args[0].startsWith('.bqr-work-'))).toBe(true) // the read-back of the work directory
    expect(icacls.length).toBeGreaterThan(3)
  })

  it('has no trace of the temp folder in the script: os.tmpdir() is not used, and no advice about TEMP or TMPDIR is given', () => {
    const source = fs.readFileSync(new URL('../scripts/backup-db.mjs', import.meta.url), 'utf8')
    expect(source).not.toMatch(/tmpdir/i)
    expect(source).not.toMatch(/\bTMPDIR\b|\bTEMP\b|\bTMP\b|%TEMP%/)
    expect(source).not.toMatch(/EXDEV/)
  })
})

// ---- work folders that a crashed run left behind -----------------------------------------------------------------------------------------

describe('work folders that a crashed run left behind', () => {
  const HOUR = 60 * 60 * 1000
  // a folder that another account can change (an explicit Modify for another user), as the first path of the PowerShell answer
  const SHARED_FOR_STALE = `${SAFE_SDDL}(A;OICI;0x1301bf;;;S-1-5-21-111-222-333-1002)`
  /** A work folder in the output folder with a half dump in it, last changed `hoursOld` hours before the clock of the tests (NOW). */
  function workFolder(name, hoursOld, { inside = true } = {}) {
    const folder = path.join(dir, name)
    fs.mkdirSync(folder, { recursive: true })
    if (inside) fs.writeFileSync(path.join(folder, PARTIAL), 'a half dump')
    const when = new Date(NOW.getTime() - hoursOld * HOUR)
    fs.utimesSync(folder, when, when)
    return folder
  }
  const namesInDir = () => fs.readdirSync(dir).sort()

  it('has an exact name pattern: the prefix and six letters or digits, nothing else', () => {
    for (const name of ['.bqr-work-AbC123', '.bqr-work-000000', '.bqr-work-zzzzzz']) expect(WORK_NAME.test(name), name).toBe(true)
    const others = [
      'bqr-work-AbC123', '.bqr-work-AbC12', '.bqr-work-AbC1234', '.bqr-work-AbC12_', '.bqr-work-AbC12-', '.bqr-work-AbC12 ', ' .bqr-work-AbC123',
      '.bqr-work-AbC123/', '.bqr-work-AbC123.old', 'x.bqr-work-AbC123', '..bqr-work-AbC123', '.BQR-WORK-AbC123', '.bqr-work-', '.bqr-work-ab-123',
      '.bqr-work-AbC12\u00E9', 'building-qr-20261003T0715Z.dump', 'backup.log', '',
    ]
    for (const name of others) expect(WORK_NAME.test(name), JSON.stringify(name)).toBe(false)
    expect(STALE_WORK_MS).toBe(24 * HOUR)
  })

  it('removes a folder that is older than 24 hours, with all that is in it, and keeps one that is not', () => {
    seed([])
    const old = workFolder('.bqr-work-OLD001', 25)
    fs.mkdirSync(path.join(old, 'nested', 'deeper'), { recursive: true })
    fs.writeFileSync(path.join(old, 'nested', FINAL), 'a file with the name of a dump, inside the work folder')
    fs.utimesSync(old, new Date(NOW.getTime() - 25 * HOUR), new Date(NOW.getTime() - 25 * HOUR))
    const young = workFolder('.bqr-work-YNG001', 23)
    const result = removeStaleWorkFolders(dir, NOW, fs)
    expect(result).toEqual({ removed: 1, failed: 0, checked: true })
    expect(namesInDir()).toEqual(['.bqr-work-YNG001'])
    expect(fs.readFileSync(path.join(young, PARTIAL), 'utf8')).toBe('a half dump')
  })

  it('counts "older than 24 hours" strictly, by the modification time, and ignores a time that is in the future', () => {
    seed([])
    workFolder('.bqr-work-UNDER1', 24 - 1 / 3600) // one second less than 24 hours: not older
    workFolder('.bqr-work-JUST01', 24 + 1 / 3600) // one second more: older
    workFolder('.bqr-work-FUTURE', -5) // a clock that was wrong: never removed
    workFolder('.bqr-work-EMPTY1', 100, { inside: false }) // empty, and old: removed as well
    const result = removeStaleWorkFolders(dir, NOW, fs)
    expect(result.removed).toBe(2)
    expect(namesInDir()).toEqual(['.bqr-work-FUTURE', '.bqr-work-UNDER1'])
  })

  it('removes nothing but a directory with the exact name: not another name, not a file, not a dump, not backup.log, whatever their age', () => {
    seed(oldBackups)
    fs.writeFileSync(path.join(dir, 'backup.log'), 'a log\n')
    const longAgo = new Date(NOW.getTime() - 1000 * HOUR)
    const keepers = ['bqr-work-AbC123', '.bqr-work-AbC12', '.bqr-work-AbC1234', '.bqr-work-AbC12_', 'x.bqr-work-AbC123', '.bqr-work-AbC123.old', 'notes', FINAL.replace('.dump', '-copy.dump')]
    for (const name of keepers) {
      workFolder(name, 1000)
    }
    // a FILE with the exact name of a work directory is not a directory
    fs.writeFileSync(path.join(dir, '.bqr-work-FILE01'), 'a file, not a folder')
    // a directory with the name of a dump
    fs.mkdirSync(path.join(dir, 'building-qr-20260801T0000Z.dump'))
    for (const name of [...oldBackups, 'backup.log', '.bqr-work-FILE01', 'building-qr-20260801T0000Z.dump']) fs.utimesSync(path.join(dir, name), longAgo, longAgo)
    const before = namesInDir()
    const result = removeStaleWorkFolders(dir, NOW, fs)
    expect(result).toEqual({ removed: 0, failed: 0, checked: true })
    expect(namesInDir()).toEqual(before)
    expect(fs.readFileSync(path.join(dir, 'backup.log'), 'utf8')).toBe('a log\n')
  })

  it('does not reach outside the folder that matched: a file next to the output folder, the other backups and a link are left alone', () => {
    seed(oldBackups)
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me')
    fs.writeFileSync(path.join(tmp, 'next-to-the-folder.txt'), 'keep me too')
    const longAgo = new Date(NOW.getTime() - 1000 * HOUR)
    const stale = workFolder('.bqr-work-STALE1', 1000)
    // a link inside the work folder to a folder outside: removing the work folder removes the link, not what it points to
    try {
      fs.symlinkSync(outside, path.join(stale, 'link-to-outside'), 'junction')
    } catch {
      // this platform needs a privilege to make a link: the rest of the test still holds
    }
    fs.utimesSync(stale, longAgo, longAgo)
    // and a link in the output folder whose NAME matches, pointing at a folder outside: it is not followed and not removed
    let namedLink = true
    try {
      fs.symlinkSync(outside, path.join(dir, '.bqr-work-LINK01'), 'junction')
      fs.lutimesSync(path.join(dir, '.bqr-work-LINK01'), longAgo, longAgo)
    } catch {
      namedLink = false
    }
    const result = removeStaleWorkFolders(dir, NOW, fs)
    expect(result.removed).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(fs.readFileSync(path.join(tmp, 'next-to-the-folder.txt'), 'utf8')).toBe('keep me too')
    expect(namesInDir().filter((name) => BACKUP_NAME.test(name))).toEqual(oldBackups)
    if (namedLink) expect(fs.lstatSync(path.join(dir, '.bqr-work-LINK01')).isSymbolicLink()).toBe(true)
  })

  it('never throws: a folder that cannot be listed is "not checked", one that cannot be removed is "failed"', () => {
    const nowhere = removeStaleWorkFolders(path.join(tmp, 'does-not-exist'), NOW, fs)
    expect(nowhere).toEqual({ removed: 0, failed: 0, checked: false })
    seed([])
    workFolder('.bqr-work-STUCK1', 30)
    workFolder('.bqr-work-GONE01', 30)
    const files = {
      ...fs,
      rmSync: (target, options) => {
        if (path.basename(String(target)) === '.bqr-work-STUCK1') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        return fs.rmSync(target, options)
      },
    }
    expect(removeStaleWorkFolders(dir, NOW, files)).toEqual({ removed: 1, failed: 1, checked: true })
    expect(namesInDir()).toEqual(['.bqr-work-STUCK1'])
  })

  it('looks again before it removes: an entry that was a directory in the listing but is a link or a file now (swapped in between) is left alone', () => {
    const longAgo = NOW.getTime() - 1000 * HOUR
    const removed = []
    const entry = (name) => ({ name, isDirectory: () => true })
    const files = (info) => ({
      readdirSync: () => [entry('.bqr-work-SWAP01')],
      lstatSync: () => ({ mtimeMs: longAgo, ...info }),
      rmSync: (target) => removed.push(target),
    })
    const asLink = removeStaleWorkFolders('dir', NOW, files({ isDirectory: () => false, isSymbolicLink: () => true }))
    const asJunction = removeStaleWorkFolders('dir', NOW, files({ isDirectory: () => true, isSymbolicLink: () => true }))
    const asFile = removeStaleWorkFolders('dir', NOW, files({ isDirectory: () => false, isSymbolicLink: () => false }))
    expect([asLink.removed, asJunction.removed, asFile.removed]).toEqual([0, 0, 0])
    expect(removed).toEqual([])
    const asDirectory = removeStaleWorkFolders('dir', NOW, files({ isDirectory: () => true, isSymbolicLink: () => false }))
    expect(asDirectory.removed).toBe(1) // the same stub with a real directory is removed, so the stub itself is not what refuses
    expect(removed).toEqual([path.join('dir', '.bqr-work-SWAP01')])
  })

  describe('in a run', () => {
    it('removes the old ones at the start, after the checks and before its own work directory exists, and says how many in the log, with no path', async () => {
      seed([])
      workFolder('.bqr-work-OLD001', 30)
      workFolder('.bqr-work-OLD002', 48, { inside: false })
      workFolder('.bqr-work-YNG001', 2)
      let atDump
      let atMkdtemp
      const files = {
        ...fs,
        statSync: privateStat,
        mkdtempSync: (prefix, ...rest) => {
          atMkdtemp = fs.readdirSync(dir).sort()
          return fs.mkdtempSync(prefix, ...rest)
        },
      }
      const runner = makeRunner({
        pg_dump: (call) => {
          atDump = fs.readdirSync(dir).sort()
          return defaults.pg_dump(call)
        },
      })
      const r = await go({ runner, deps: { fs: files } })
      expect(r.exitCode).toBe(0)
      expect(atMkdtemp).toEqual(['.bqr-work-YNG001']) // the old ones were gone before this run made its own
      expect(atDump).toEqual(['.bqr-work-YNG001', path.basename(runner.of('pg_dump')[0].options.cwd)].sort())
      expect(r.log).toBe(`03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0 stale-work-folders-removed=2\n`)
      expect(r.files).toEqual(['.bqr-work-YNG001', 'backup.log', FINAL]) // the young one is another run's: left alone
      expect(r.log).not.toContain(tmp)
      expect(r.log).not.toContain('bqr-work-OLD')
      expect(r.out).toEqual([`backup ok: ${FINAL}, 15 B, removed 0 old files`])
      expect(r.errs).toEqual([])
    })

    it('says nothing in the log when there is nothing to remove, so the line is the same as before', async () => {
      seed([])
      workFolder('.bqr-work-YNG001', 2)
      const r = await go()
      expect(r.log).toBe(`03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0\n`)
      expect(r.log).not.toContain('stale')
    })

    it('says how many in the log of a failed run too, and does not count them as the old backups that were removed', async () => {
      seed([])
      workFolder('.bqr-work-OLD001', 30)
      const r = await go({ runner: makeRunner({ pg_dump: () => ({ status: 1, stdout: '', stderr: 'nope' }) }) })
      expect(r.exitCode).toBe(1)
      expect(r.log).toBe(`03/10/2026 10:15 failed host=${MASKED_HOST} stale-work-folders-removed=1 error=pg_dump failed (exit code 1): nope\n`)
      expect(r.files).toEqual(['backup.log'])
    })

    it('is a warning, and the run goes on, when an old folder cannot be removed', async () => {
      seed([])
      workFolder('.bqr-work-STUCK1', 30)
      workFolder('.bqr-work-OLD001', 30)
      const files = {
        ...fs,
        statSync: privateStat,
        rmSync: (target, options) => {
          if (path.basename(String(target)) === '.bqr-work-STUCK1') throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: 'EBUSY' })
          return fs.rmSync(target, options)
        },
      }
      const r = await go({ deps: { fs: files } })
      expect(r.exitCode).toBe(0)
      expect(r.warning).toBe('1-stale-work-folders-not-removed')
      expect(r.log).toBe(`03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0 stale-work-folders-removed=1 warning=1-stale-work-folders-not-removed\n`)
      expect(r.errs).toEqual(['backup: warning, 1-stale-work-folders-not-removed'])
      expect(visible(r)).not.toContain(tmp)
      expect(r.files).toEqual(['.bqr-work-STUCK1', 'backup.log', FINAL])
    })

    it('does not touch anything when a check refuses the run: the folder that others can write in, a backup.log that is not a file', async () => {
      seed([])
      const stale = workFolder('.bqr-work-OLD001', 30)
      const open = await go({ deps: { fs: recordingFs({ folderMode: 0o040777 }).fs } })
      expect(open.exitCode).toBe(1)
      expect(fs.existsSync(stale)).toBe(true)
      fs.mkdirSync(path.join(dir, 'backup.log'))
      const badLog = await go()
      expect(badLog.exitCode).toBe(1)
      expect(badLog.message).toBe(LOG_NOT_REGULAR_ERROR)
      expect(fs.existsSync(stale)).toBe(true)
    })

    it('does not touch anything on Windows when the folder can be changed by another account', async () => {
      seed([])
      const stale = workFolder('.bqr-work-OLD001', 30)
      const r = await go({ runner: makeRunner({ powershell: ({ options }) => ({ status: 0, stdout: sddlLines(options.env.BQR_ACL_PATHS.split('|').map((_, index) => (index === 0 ? SHARED_FOR_STALE : SAFE_SDDL))), stderr: '' }) }), deps: { platform: 'win32', exists: () => false, env: { SystemRoot: 'C:\\Windows' } } })
      expect(r.exitCode).toBe(1)
      expect(r.message).toMatch(/^nothing was dumped, because another account can change a folder/)
      expect(fs.existsSync(stale)).toBe(true)
    })

    it('also works on Windows: the same removal, after the folders were checked', async () => {
      seed([])
      const stale = workFolder('.bqr-work-OLD001', 30)
      const r = await go({ deps: { platform: 'win32', exists: () => false, env: { SystemRoot: 'C:\\Windows' }, fs: { ...fs, statSync: privateStat } } })
      expect(r.exitCode).toBe(0)
      expect(fs.existsSync(stale)).toBe(false)
      expect(r.log).toContain(' removed=0 stale-work-folders-removed=1')
      expect(r.runner.calls.map((call) => call.tool).slice(0, 2)).toEqual(['whoami', 'powershell'])
    })
  })

  describe('and retention', () => {
    it('never counts, rotates or deletes a work folder, finished or not, young or old: only files with the exact name of a backup', () => {
      seed(['building-qr-20260901T0000Z.dump', 'building-qr-20260902T0000Z.dump', 'building-qr-20260903T0000Z.dump'])
      // a work folder that holds a finished dump under a dump name, one that is empty, one with a half dump, a file and a dump-named directory
      const finished = path.join(dir, '.bqr-work-DONE01')
      fs.mkdirSync(finished)
      fs.writeFileSync(path.join(finished, 'building-qr-20260701T0000Z.dump'), 'finished, still inside')
      fs.writeFileSync(path.join(finished, PARTIAL), 'x')
      fs.mkdirSync(path.join(dir, '.bqr-work-EMPTY1'))
      workFolder('.bqr-work-HALF01', 1000)
      fs.writeFileSync(path.join(dir, '.bqr-work-FILE01'), 'a file')
      fs.mkdirSync(path.join(dir, 'building-qr-20260801T0000Z.dump'))
      const before = fs.readdirSync(dir).sort()
      const result = rotate(dir, 1, NOW, fs)
      expect(result).toEqual({ removed: ['building-qr-20260902T0000Z.dump', 'building-qr-20260901T0000Z.dump'], failed: 0, future: 0 })
      const after = fs.readdirSync(dir).sort()
      expect(after).toEqual(before.filter((name) => !result.removed.includes(name)))
      expect(fs.readFileSync(path.join(finished, 'building-qr-20260701T0000Z.dump'), 'utf8')).toBe('finished, still inside')
      expect(fs.existsSync(path.join(dir, 'building-qr-20260801T0000Z.dump'))).toBe(true) // a directory with a dump name
    })

    it('in a run with --keep 1: the old backups go, the young work folders of other runs stay with what is in them, and removed= counts only backups', async () => {
      seed(oldBackups)
      const finished = path.join(dir, '.bqr-work-DONE01')
      fs.mkdirSync(finished)
      fs.writeFileSync(path.join(finished, 'building-qr-20260701T0000Z.dump'), 'finished, still inside')
      fs.mkdirSync(path.join(dir, '.bqr-work-EMPTY1'))
      const half = workFolder('.bqr-work-HALF01', 3)
      fs.utimesSync(finished, new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR))
      fs.utimesSync(path.join(dir, '.bqr-work-EMPTY1'), new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR))
      const r = await go({ options: { keep: 1 } })
      expect(r.exitCode).toBe(0)
      expect(r.removed).toBe(5)
      expect(r.files.filter((name) => BACKUP_NAME.test(name))).toEqual([FINAL])
      expect(workDirsNow().sort()).toEqual(['.bqr-work-DONE01', '.bqr-work-EMPTY1', '.bqr-work-HALF01'])
      expect(fs.readFileSync(path.join(finished, 'building-qr-20260701T0000Z.dump'), 'utf8')).toBe('finished, still inside')
      expect(fs.readFileSync(path.join(half, PARTIAL), 'utf8')).toBe('a half dump')
      expect(r.log).toBe(`03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=5\n`)
    })

    it('does not delete an old work folder by retention either: only the clean-up of stale folders does, and it says so', async () => {
      seed(oldBackups)
      const half = workFolder('.bqr-work-HALF01', 1000)
      const r = await go({ options: { keep: 1 } })
      expect(r.exitCode).toBe(0)
      expect(r.removed).toBe(5) // five backups, not six: the work folder is not one
      expect(fs.existsSync(half)).toBe(false)
      expect(r.log).toBe(`03/10/2026 10:15 ok host=${MASKED_HOST} file=${FINAL} size=15 removed=5 stale-work-folders-removed=1\n`)
    })
  })
})

// ---- a system that is not Windows or Linux ---------------------------------------------------------------------------------------------------

describe('a system that is not Windows or Linux', () => {
  // macOS has extended ACLs that the mode does not show, and nobody can run or test the code for them here: it is refused, with
  // every other system that is not Windows or Linux, before anything is made.
  const others = ['darwin', 'freebsd', 'openbsd', 'netbsd', 'sunos', 'aix', 'android', 'cygwin', 'haiku', '']

  it('is refused before anything is made: no tool, no folder, no work directory, no log, no umask, nothing rotated', async () => {
    for (const platform of others) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ deps: { platform } })
      expect(r.exitCode, platform).toBe(1)
      expect(r.ok, platform).toBe(false)
      expect(r.message, platform).toBe(UNSUPPORTED_PLATFORM_ERROR)
      expect(r.runner.calls, platform).toEqual([]) // not even whoami, the Neon CLI or pg_dump
      expect(r.masks, platform).toEqual([]) // the umask of the process is not even changed
      expect(fs.existsSync(dir), platform).toBe(false) // the folder is not made
      expect(r.log, platform).toBe('')
      expect(r.errs, platform).toEqual([`backup failed: ${UNSUPPORTED_PLATFORM_ERROR}`])
      expect(r.out, platform).toEqual([])
    }
  })

  it('leaves the folder as it is when it is there: old backups, a log and a stale work folder are not touched', async () => {
    seed(oldBackups)
    fs.writeFileSync(path.join(dir, 'backup.log'), 'a log\n')
    const stale = path.join(dir, '.bqr-work-OLD001')
    fs.mkdirSync(stale)
    const longAgo = new Date(NOW.getTime() - 100 * 60 * 60 * 1000)
    fs.utimesSync(stale, longAgo, longAgo)
    const before = fs.readdirSync(dir).sort()
    const r = await go({ options: { keep: 1 }, deps: { platform: 'darwin' } })
    expect(r.exitCode).toBe(1)
    expect(fs.readdirSync(dir).sort()).toEqual(before)
    expect(fs.readFileSync(path.join(dir, 'backup.log'), 'utf8')).toBe('a log\n')
  })

  it('still opens an issue with --report-issue, like any other failure (a daily run that never works must be seen)', async () => {
    const r = await go({ options: { reportIssue: 'owner/repo' }, deps: { platform: 'darwin' } })
    expect(r.exitCode).toBe(1)
    expect(r.issue).toBe('opened')
    expect(r.runner.of('gh').length).toBeGreaterThanOrEqual(2)
    expect(r.runner.calls.filter((call) => call.tool !== 'gh')).toEqual([])
    expect(r.errs).toEqual([`backup failed: ${UNSUPPORTED_PLATFORM_ERROR}`, 'backup: an issue was opened'])
  })

  it('says which systems it runs on, and holds no path', () => {
    expect(UNSUPPORTED_PLATFORM_ERROR).toBe(
      'the backup runs on Windows and Linux; on this system its folder checks cannot see every way another account could change the folder',
    )
    expect(UNSUPPORTED_PLATFORM_ERROR).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//)
  })

  it('does not change Windows and Linux: both still run, and are the only two that do', async () => {
    const linux = await go({ deps: { platform: 'linux' } })
    expect(linux.exitCode).toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
    const windows = await go({ deps: { platform: 'win32', exists: () => false, env: { SystemRoot: 'C:\\Windows' } } })
    expect(windows.exitCode).toBe(0)
  })

  it('claims support for Windows and Linux only, in the script and in the runbook', () => {
    const source = fs.readFileSync(new URL('../scripts/backup-db.mjs', import.meta.url), 'utf8')
    expect(source).toMatch(/new Set\(\['win32', 'linux'\]\)/)
    // no claim of support for macOS, in the script or in the runbook (the runbook says it is refused)
    expect(source).not.toMatch(/macOS and Linux|macOS or Linux/)
    const runbook = fs.readFileSync(new URL('../docs/runbooks/restore.md', import.meta.url), 'utf8')
    expect(runbook).not.toMatch(/macOS and Linux|macOS or Linux/)
    expect(runbook).toMatch(/Windows or Linux/)
  })
})

// ---- the real process runner ---------------------------------------------------------------------------------------------------------------

describe('runProcess', () => {
  it('captures the output and the exit code', async () => {
    const r = await runProcess(process.execPath, ['-e', 'console.log("hi"); console.error("oops"); process.exit(3)'])
    expect(r.status).toBe(3)
    expect(r.stdout.trim()).toBe('hi')
    expect(r.stderr.trim()).toBe('oops')
    expect(r.problem).toBeUndefined()
  })

  it('answers ENOENT for a program that does not exist, and TIMEOUT for one that does not end', async () => {
    const missing = await runProcess('this-program-does-not-exist-xyz', [])
    expect(missing.problem).toBe('ENOENT')
    expect(missing.status).toBeNull()
    const slow = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 })
    expect(slow.problem).toBe('TIMEOUT')
    expect(slow.status).toBeNull()
  })

  it('passes exactly the environment and the working directory it is given', async () => {
    const script = 'console.log(JSON.stringify([process.env.ONLY_THIS, process.env.BACKUP_DATABASE_URL ?? null, process.cwd()]))'
    const env = { ONLY_THIS: 'yes', SystemRoot: process.env.SystemRoot }
    const r = await runProcess(process.execPath, ['-e', script], { env, cwd: tmp })
    const [only, leaked, cwd] = JSON.parse(r.stdout)
    expect(only).toBe('yes')
    expect(leaked).toBeNull()
    expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(tmp))
  })

  it('closes standard input, so that a program that waits for an answer ends at once', async () => {
    const r = await runProcess(process.execPath, ['-e', "process.stdin.on('end', () => console.log('closed')); process.stdin.resume()"], { timeoutMs: 20000 })
    expect(r.stdout.trim()).toBe('closed')
  })
})
