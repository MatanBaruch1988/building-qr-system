// The daily database backup (scripts/backup-db.mjs, docs/runbooks/restore.md). No database and no PostgreSQL tools: the
// process runner is a stub that records every call and writes the files that pg_dump would write, and the folder of the
// backups is a real temporary folder, so that the file handling (the temporary file, the rename, the retention) is real.
// Fake values only: the connection string below does not exist.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AMBIGUOUS_SOURCE_ERROR,
  BACKUP_NAME,
  DEFAULT_KEEP,
  EXDEV_ERROR,
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
  parseNeonOutput,
  parseWhoamiSid,
  PARTIAL_NAME,
  PATH_TOO_LONG_ERROR,
  WINDOWS_PATH_LIMIT,
  WORK_PREFIX,
  pgTool,
  READ_ONLY_OPTION,
  resolvePgBin,
  runBackup,
  runProcess,
  selectOld,
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
const NOW = new Date('2026-10-03T07:15:42Z')
const FINAL = 'building-qr-20261003T0715Z.dump'
// the temporary file, inside the private work directory (bqr-work-<random>) that each run makes in the temp folder
const PARTIAL = 'partial.dump'
const LISTING = [
  ';',
  '; Archive created at 2026-10-03 10:15:40',
  '3567; 0 24963 TABLE DATA public scans backup_user',
  '3563; 0 24869 TABLE DATA public points backup_user',
  '3564; 0 24898 TABLE DATA public providers backup_user',
].join('\n')

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
  pg_restore: () => ({ status: 0, stdout: LISTING, stderr: '' }),
  neon: () => ({ status: 0, stdout: `${URL_FAKE}\n`, stderr: '' }),
  // Windows only: the SID of the user (a fake one) and the owner-only access list of a file
  whoami: () => ({ status: 0, stdout: `"PC\\user","${SID}"\r\n`, stderr: '' }),
  icacls: () => ({ status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files\r\n', stderr: '' }),
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bqr-backup-test-'))
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
  if (path.resolve(String(target)) === path.resolve(dir) || isWorkDir(target)) return { mode: 0o040700 }
  return fileStat(target, ...rest)
}

/** True for the work directory of a run (the stub says it is private, like a real one made with mode 700). */
function isWorkDir(target) {
  return path.basename(String(target)).startsWith('bqr-work-')
}

/** The work directories of runs that are in the temp folder of the test now: a run makes its own with mkdtemp. */
function workDirsNow() {
  return fs.readdirSync(tmp).filter((name) => name.startsWith('bqr-work-'))
}

/** The working directory of a tool is this run's own work directory: a bqr-work-<random> directory in the temp folder. */
function expectWorkCwd(cwd) {
  expect(path.dirname(cwd)).toBe(path.resolve(tmp))
  expect(path.basename(cwd)).toMatch(/^bqr-work-[A-Za-z0-9]{6}$/)
}

/**
 * The stat of a file as the script sees it on macOS or Linux: its real size, and a mode of 600. (A real file on Windows
 * says 666, and on a machine with another umask something else: the script reads the mode back, and these tests are about
 * everything else. The tests of that check pass their own `fs`.) It throws for a file that is not there, like the real one.
 */
function fileStat(target, ...rest) {
  return { size: fs.statSync(target, ...rest).size, mode: 0o100600 }
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
      tmpdir: tmp,
      fs: { ...fs, statSync: privateStat },
      umask: (mask) => {
        masks.push(mask)
        return 0o022
      },
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
    expect(resolvePgBin({ env: { PG_BIN: '  ' }, platform: 'darwin', exists: yes })).toBeNull()
  })

  it('the Windows folder is the install of Postgres 18', () => {
    expect(WINDOWS_PG_BIN).toBe('C:\\Program Files\\PostgreSQL\\18\\bin')
  })

  it('names the tool with .exe on Windows and joins it to the folder the way that system does', () => {
    expect(pgTool(WINDOWS_PG_BIN, 'pg_dump', 'win32')).toBe('C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe')
    expect(pgTool(null, 'pg_dump', 'win32')).toBe('pg_dump.exe')
    expect(pgTool('/opt/pg18/bin', 'pg_restore', 'linux')).toBe('/opt/pg18/bin/pg_restore')
    expect(pgTool(null, 'pg_restore', 'darwin')).toBe('pg_restore')
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
    for (const platform of ['linux', 'darwin']) {
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

describe('which old backups to delete', () => {
  const names = [...oldBackups]

  it('keeps the newest ones, counting the new backup, and picks the rest', () => {
    expect(selectOld([...names, FINAL], 3, FINAL)).toEqual(['building-qr-20260903T0000Z.dump', 'building-qr-20260902T0000Z.dump', 'building-qr-20260901T0000Z.dump'].slice(0, 3))
    expect(selectOld([...names, FINAL], 3, FINAL).sort()).toEqual(oldBackups.slice(0, 3))
    expect(selectOld([...names, FINAL], 1, FINAL).sort()).toEqual(oldBackups)
    expect(selectOld([...names, FINAL], 30, FINAL)).toEqual([])
    expect(selectOld([FINAL], 3, FINAL)).toEqual([])
  })

  it('never picks a name that does not match the pattern exactly', () => {
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
    ]
    expect(selectOld([...others, ...names, FINAL], 1, FINAL).sort()).toEqual(oldBackups)
    expect(selectOld(others, 1, FINAL)).toEqual([])
  })

  it('never picks the new backup, even when other files have a later name', () => {
    const future = ['building-qr-20990101T0000Z.dump', 'building-qr-20980101T0000Z.dump']
    const picked = selectOld([...names, ...future, FINAL], 2, FINAL)
    expect(picked).not.toContain(FINAL)
    // the new one and the newest other one are kept, so two files are left
    expect(picked.length).toBe(names.length + future.length - 1)
    expect(picked).not.toContain('building-qr-20990101T0000Z.dump')
    expect(selectOld([...future, FINAL], 1, FINAL).sort()).toEqual([...future].sort())
  })
})

// ---- a good backup --------------------------------------------------------------------------------------------------------------

describe('a good backup', () => {
  it('dumps to a temporary file, checks it, renames it, and prints one summary line', async () => {
    let during
    let inside
    const runner = makeRunner({
      pg_dump: (call) => {
        const answer = defaults.pg_dump(call)
        during = fs.readdirSync(dir)
        inside = fs.readdirSync(call.options.cwd)
        return answer
      },
    })
    const r = await go({ runner })
    expect(r.exitCode).toBe(0)
    expect(r.ok).toBe(true)
    expect(during).toEqual([]) // nothing is in the output folder while the dump is made: the work directory is in the temp folder
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
    expect(r.runner.calls.map((c) => c.tool)).toEqual(['pg_dump', 'pg_restore', 'pg_restore'])
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
      expectWorkCwd(r.runner.of('pg_dump')[0].options.cwd) // the temp folder, not the folder of the backups
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

  it('never deletes the new backup, even when older backups have a later name (a clock that went back)', async () => {
    seed(['building-qr-20990101T0000Z.dump', 'building-qr-20980101T0000Z.dump', ...oldBackups.slice(0, 2)])
    const r = await go({ options: { keep: 2 } })
    expect(r.files).toContain(FINAL)
    expect(r.files.filter((name) => BACKUP_NAME.test(name))).toHaveLength(2)
    expect(r.files).toContain('building-qr-20990101T0000Z.dump')
  })

  it('deletes nothing when there are fewer files than --keep', async () => {
    seed(oldBackups.slice(0, 2))
    const r = await go({ options: { keep: 30 } })
    expect(r.files).toEqual([FINAL, 'backup.log', ...oldBackups.slice(0, 2)].sort())
    expect(r.out[0]).toMatch(/removed 0 old files$/)
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

  it('does not stop a run when it cannot be written, and says so', async () => {
    fs.mkdirSync(path.join(dir, 'backup.log'), { recursive: true }) // a folder where the log should be
    const r = await go()
    expect(r.exitCode).toBe(0)
    expect(r.errs).toEqual(['backup: could not write backup.log'])
    expect(r.files).toContain(FINAL)
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
const bodyFileOf = (call) => call.args[call.args.indexOf('--body-file') + 1]
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

  it('opens a new issue when none is open: the title, the bug label and a body file, which is deleted afterwards', async () => {
    let body
    let bodyFile
    const runner = failing({
      gh: ghBy({
        create: (call) => {
          bodyFile = bodyFileOf(call)
          body = fs.readFileSync(bodyFile, 'utf8')
          return { status: 0, stdout: 'https://github.com/owner/repo/issues/1\n', stderr: '' }
        },
      }),
    })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(r.exitCode).toBe(1)
    expect(ghCalls(r, 'comment')).toEqual([])
    const [create] = ghCalls(r, 'create')
    expect(create.command).toBe('gh')
    expect(create.args).toEqual(['issue', 'create', '--repo', 'owner/repo', '--title', ISSUE_TITLE, '--label', 'bug', '--body-file', bodyFile])
    expect(ISSUE_TITLE).toBe('Daily database backup failed')
    expect(fs.existsSync(path.dirname(bodyFile))).toBe(false)
    expect(body).toContain('03/10/2026 07:15 (UTC)')
    expect(body).toContain('backup.log')
    expect(r.issue).toBe('opened')
    expect(r.log).toContain(' issue=opened error=pg_dump failed')
    expect(r.errs).toContain('backup: an issue was opened')
  })

  it('adds a comment to the open issue instead of opening another one, with the same text', async () => {
    let commentBody
    let bodyFile
    const runner = failing({
      gh: ghBy({
        list: () => listing({ number: 7, title: ISSUE_TITLE }),
        comment: (call) => {
          bodyFile = bodyFileOf(call)
          commentBody = fs.readFileSync(bodyFile, 'utf8')
          return { status: 0, stdout: '', stderr: '' }
        },
      }),
    })
    const r = await go({ options: { reportIssue: 'owner/repo' }, runner })
    expect(r.exitCode).toBe(1)
    expect(ghCalls(r, 'create')).toEqual([])
    const [comment] = ghCalls(r, 'comment')
    expect(comment.args).toEqual(['issue', 'comment', '7', '--repo', 'owner/repo', '--body-file', bodyFile])
    expect(commentBody).toBe(issueBody(NOW))
    expect(fs.existsSync(path.dirname(bodyFile))).toBe(false)
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
      bodies[name] = fs.readFileSync(bodyFileOf(call), 'utf8')
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
          same(p) ? { mode: folderMode } : isWorkDir(p) ? { mode: workMode } : { ...fileStat(p, ...rest), mode: fileMode },
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
      pg_restore: (call) => (call.args[0] === '--list' ? defaults.pg_restore(call) : read(call)),
    })

  it('names the null device: NUL on Windows, /dev/null elsewhere', () => {
    expect(nullDevice('win32')).toBe('NUL')
    expect(nullDevice('linux')).toBe('/dev/null')
    expect(nullDevice('darwin')).toBe('/dev/null')
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
    expect(during).toEqual([]) // no final file yet
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
  it('on macOS and Linux sets the umask to 077 before anything is created, and puts the old one back at the end', async () => {
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

  it('makes the output folder with mode 700 (every folder on the way too), and the work directory with mkdtemp in the temp folder', async () => {
    const rec = recordingFs()
    await go({ deps: { fs: rec.fs } })
    expect(rec.mkdirs).toEqual([{ folder: true, options: { recursive: true, mode: 0o700 } }])
    expect(rec.mkdtemps).toEqual([path.join(tmp, 'bqr-work-')]) // mkdtemp itself makes it with mode 700, with a name nobody can guess
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

  it('creates the real files for the owner only (checked with the real modes on macOS and Linux, where they exist)', async () => {
    if (process.platform === 'win32') return // Windows has no such modes: its protection is the access list of the profile
    const r = await go({ deps: { fs, umask: undefined } })
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

  it('does not hide the answer of the issue step when the body file cannot be deleted', async () => {
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
    expect(r.warning).toBe('old-backups-not-checked')
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
    userName: () => 'Test User',
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

  it('closes the work directory in the temp folder, then the empty temporary file in it, with icacls before pg_dump writes anything: SID, no inheritance', async () => {
    const seen = {}
    const ls = (target) => (fs.existsSync(target) ? fs.readdirSync(target) : null)
    const runner = makeRunner({
      icacls: (call) => {
        if (call.args[0].startsWith('bqr-work-')) seen.atWorkDir = { out: ls(dir), inside: ls(path.join(tmp, call.args[0])) }
        if (call.args[0] === PARTIAL) {
          seen.atFile = { inside: ls(call.options.cwd), size: fs.statSync(path.join(call.options.cwd, PARTIAL)).size, final: fs.existsSync(path.join(dir, FINAL)) }
        }
        return defaults.icacls(call)
      },
      pg_dump: (call) => {
        seen.beforeDump = { out: ls(dir), inside: ls(call.options.cwd) }
        return defaults.pg_dump(call)
      },
    })
    const r = await go({ deps: win(), runner })
    const [dirCall, fileCall] = r.runner.of('icacls')
    // the directory: found by a relative name in the temp folder, with the rights that what is made inside inherits
    expect(dirCall.command).toBe(ICACLS)
    expect(dirCall.args).toEqual([expect.stringMatching(/^bqr-work-[A-Za-z0-9]{6}$/), '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`])
    expect(dirCall.options.cwd).toBe(path.resolve(tmp))
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
    const where = () => `out: ${ls(dir) || 'empty'}, work: ${ls(workDirsNow().map((name) => path.join(tmp, name))[0])}`
    const named = (name) => name.replace(/^bqr-work-.*$/, '<work>')
    const runner = makeRunner({
      whoami: (call) => {
        events.push(`whoami (${where()})`)
        return defaults.whoami(call)
      },
      icacls: (call) => {
        events.push(`icacls ${named(call.args[0])} (${where()})`)
        return defaults.icacls(call)
      },
      pg_dump: (call) => {
        events.push('pg_dump')
        return defaults.pg_dump(call)
      },
      pg_restore: (call) => {
        events.push(call.args[0] === '--list' ? 'list' : 'full read')
        return defaults.pg_restore(call)
      },
    })
    const r = await go({ deps: win(), runner })
    expect(r.exitCode).toBe(0)
    expect(events).toEqual([
      'whoami (out: empty, work: -)',
      'icacls <work> (out: empty, work: )', // the directory exists and is empty when its list is set, and the output folder is empty
      `icacls ${PARTIAL} (out: empty, work: ${PARTIAL})`,
      'pg_dump',
      'list',
      'full read',
      // the file was renamed into the output folder and the work directory is removed: the log is made last
      `icacls backup.log (out: backup.log ${FINAL}, work: -)`,
    ])
  })

  it('prefers the SID to the name: a name with a space or in another alphabet is never used', async () => {
    const r = await go({ deps: win({ userName: () => 'Some Name \u05DE\u05EA\u05DF' }) })
    for (const call of r.runner.of('icacls')) {
      expect(call.args.at(-1)).toMatch(new RegExp(`^\\*${SID}:(\\(OI\\)\\(CI\\))?F$`))
      expect(JSON.stringify(call.args)).not.toContain('Some Name')
    }
  })

  it('falls back to the user name that Node knows when whoami gives no SID (it fails, is missing or prints something else)', async () => {
    const answers = [
      noWho,
      { status: null, stdout: '', stderr: '', problem: 'ENOENT' },
      { status: 0, stdout: 'ERROR: something else\r\n', stderr: '' },
    ]
    for (const answer of answers) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ deps: win(), runner: makeRunner({ whoami: () => answer }) })
      expect(r.exitCode, JSON.stringify(answer)).toBe(0)
      expect(r.runner.of('icacls')[0].args.at(-1)).toBe('Test User:(OI)(CI)F') // the work directory, then the file
    }
  })

  it('fails closed, before the file is made, when the user cannot be found at all', async () => {
    const cases = [
      () => '',
      () => '   ',
      () => 'bad:name',
      () => {
        throw new Error('no user')
      },
    ]
    for (const userName of cases) {
      fs.rmSync(dir, { recursive: true, force: true })
      const r = await go({ deps: win({ userName }), runner: makeRunner({ whoami: () => noWho }) })
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe('the current Windows user could not be found, so a dump cannot be made owner-only')
      expect(r.runner.of('pg_dump')).toEqual([])
      expect(r.runner.of('icacls')).toEqual([])
      expect(r.files).toEqual(['backup.log'])
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
      [expect.stringMatching(/^bqr-work-/), '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`],
      [PARTIAL, '/inheritance:r', '/grant:r', `*${SID}:F`],
      ['backup.log', '/inheritance:r', '/grant:r', `*${SID}:F`],
    ])
    const second = await go({ deps: win() })
    expect(second.runner.of('icacls').map((c) => c.args[0])).toEqual([expect.stringMatching(/^bqr-work-/), PARTIAL]) // the log was there already
    expect(second.log.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('writes a log that cannot be closed anyway, with a warning: it holds no personal data', async () => {
    const runner = makeRunner({ icacls: (call) => (call.args[0] === 'backup.log' ? { status: 5, stdout: '', stderr: '' } : defaults.icacls(call)) })
    const r = await go({ deps: win(), runner })
    expect(r.exitCode).toBe(0)
    expect(r.log).toContain(' ok host=')
    expect(r.errs).toEqual(['backup: warning, backup.log could not be made owner-only'])
  })

  it('does not run on macOS and Linux, where the umask and the modes do this work', async () => {
    const r = await go()
    expect(r.runner.of('whoami')).toEqual([])
    expect(r.runner.of('icacls')).toEqual([])
    expect(r.runner.calls.map((c) => c.tool)).toEqual(['pg_dump', 'pg_restore', 'pg_restore'])
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
    expect(WORK_PREFIX).toBe('bqr-work-')
    expect(BACKUP_NAME.test(`${WORK_PREFIX}abc123`)).toBe(false)
    // mkdtemp adds six characters; the path inside is at most one character longer than the name of the final file
    expect(WORK_PREFIX.length + 6 + 1 + PARTIAL_NAME.length).toBeLessThanOrEqual(FINAL.length + 1)
  })

  it('differs between two runs with the same clock: mkdtemp gives each an unpredictable name of its own', async () => {
    const first = await go()
    fs.rmSync(dir, { recursive: true, force: true })
    const second = await go()
    expect(workOf(first)).toMatch(/^bqr-work-[A-Za-z0-9]{6}$/)
    expect(workOf(second)).toMatch(/^bqr-work-[A-Za-z0-9]{6}$/)
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
    const other = path.join(tmp, 'bqr-work-OTHER1')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, PARTIAL), 'another run is working here')
    const good = await go({ options: { keep: 1 } })
    expect(good.exitCode).toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
    const bad = await go({ runner: makeRunner({ pg_dump: () => ({ status: 1, stdout: '', stderr: 'nope' }) }) })
    expect(bad.exitCode).toBe(1)
    expect(workDirsNow()).toEqual(['bqr-work-OTHER1'])
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
  it('is made by mkdtemp in the temp folder, never in the output folder, after the folder and before the temporary file', async () => {
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
        events.push(`mkdtemp ${path.dirname(String(prefix)) === path.resolve(tmp) ? 'in the temp folder' : 'ELSEWHERE'} ${path.basename(String(prefix))}`)
        return fs.mkdtempSync(prefix, ...rest)
      },
      writeFileSync: (target, data, options) => {
        const inside = path.basename(path.dirname(String(target))).replace(/[A-Za-z0-9]{6}$/, 'XXXXXX')
        events.push(`write ${inside}/${path.basename(String(target))} ${JSON.stringify(options)}`)
        return fs.writeFileSync(target, data, options)
      },
    }
    const runner = makeRunner({
      pg_dump: (call) => {
        outFolderDuringDump = fs.readdirSync(dir)
        return defaults.pg_dump(call)
      },
    })
    const r = await go({ deps: { fs: files }, runner })
    expect(r.exitCode).toBe(0)
    expect(events).toEqual([
      'mkdir folder {"recursive":true,"mode":448}',
      'mkdtemp in the temp folder bqr-work-',
      'write bqr-work-XXXXXX/partial.dump {"flag":"wx","mode":384}',
    ])
    expect(outFolderDuringDump).toEqual([]) // nothing but the finished file ever goes into the output folder
  })

  it('is where pg_dump, the list and the full read run, and the finished file is moved out of it into the output folder', async () => {
    const r = await go()
    const cwds = r.runner.calls.map((c) => c.options.cwd)
    expect(cwds).toHaveLength(3)
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
    const readFails = (call) => (call.args[0] === '--list' ? defaults.pg_restore(call) : { status: 1, stdout: '', stderr: 'cut' })
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
    expect(r.files).toEqual(['backup.log', FINAL]) // nothing of it is in the output folder
    const [left] = workDirsNow()
    expect(fs.readdirSync(path.join(tmp, left))).toEqual([]) // the dump was moved out, so nothing is left in it
    expect(visible(r)).not.toContain(tmp)
  })

  it('on macOS and Linux must be owner-only: a file system that ignores modes stops the run before anything is dumped', async () => {
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
      icacls: (call) => (call.args[0].startsWith('bqr-work-') ? { status: 5, stdout: '', stderr: '' } : defaults.icacls(call)),
    })
    const r = await go({
      options: { keep: 1 },
      runner,
      deps: { fs: files, platform: 'win32', exists: () => false, userName: () => 'Test User', env: { SystemRoot: 'C:\\Windows' } },
    })
    expect(r.exitCode).toBe(1)
    expect(r.message).toBe('icacls failed (exit code 5), so a dump cannot be made owner-only')
    expect(written).not.toContain(PARTIAL) // the temporary file was never made
    expect(r.runner.of('pg_dump')).toEqual([])
    expect(workDirsNow()).toEqual([])
    expect(r.files.filter((name) => BACKUP_NAME.test(name))).toEqual(oldBackups) // nothing was rotated
  })

  describe('when the output folder is on another drive than the temp folder', () => {
    const crossDrive = (code = 'EXDEV') => ({
      ...fs,
      statSync: privateStat,
      renameSync: () => {
        throw Object.assign(new Error(`${code}: cross-device link not permitted, rename '${tmp}/x' -> '${dir}/y'`), { code })
      },
    })

    it('fails with a message that says what to do, deletes the dump, and rotates nothing', async () => {
      seed(oldBackups)
      const r = await go({ options: { keep: 1 }, deps: { fs: crossDrive() } })
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(EXDEV_ERROR)
      expect(EXDEV_ERROR).toMatch(/same drive/)
      expect(EXDEV_ERROR).toMatch(/TEMP/)
      expect(r.files).toEqual(['backup.log', ...oldBackups]) // no final file, nothing rotated
      expect(workDirsNow()).toEqual([]) // the verified dump in the work directory is removed with it
      expect(r.log).toBe(`03/10/2026 10:15 failed host=${MASKED_HOST} error=${EXDEV_ERROR}\n`)
      expect(visible(r)).not.toContain(tmp)
    })

    it('does not hide another reason why a rename failed, and still cleans its message of paths', async () => {
      const r = await go({ deps: { fs: crossDrive('EPERM') } })
      expect(r.exitCode).toBe(1)
      expect(r.message).toMatch(/^EPERM: /)
      expect(r.message).not.toContain(tmp)
      expect(workDirsNow()).toEqual([])
    })
  })

  describe('on Windows, with the limit of 260 characters of its tools', () => {
    const win = { platform: 'win32', exists: () => false, userName: () => 'Test User', env: { SystemRoot: 'C:\\Windows' } }
    /** An output folder whose longest path (the final file) is exactly `length` characters. */
    const folderFor = (length) => path.join(tmp, 'x'.repeat(length - FINAL.length - 1 - tmp.length - 1))
    /** A temp folder whose longest path (the file in the work directory) is exactly `length` characters. */
    const tempFor = (length) => path.join(tmp, 'y'.repeat(length - (WORK_PREFIX.length + 6) - PARTIAL_NAME.length - 2 - tmp.length - 1))

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

    it('does the same for the temp folder, which is where the work directory is', async () => {
      const exact = tempFor(WINDOWS_PATH_LIMIT)
      fs.mkdirSync(exact, { recursive: true })
      expect(path.join(exact, `${WORK_PREFIX}xxxxxx`, PARTIAL_NAME).length).toBe(WINDOWS_PATH_LIMIT)
      const fine = await go({ deps: { ...win, tmpdir: exact } })
      expect(fine.exitCode).toBe(0)
      fs.rmSync(dir, { recursive: true, force: true })
      const tooLong = tempFor(WINDOWS_PATH_LIMIT + 1)
      fs.mkdirSync(tooLong, { recursive: true })
      const r = await go({ deps: { ...win, tmpdir: tooLong } })
      expect(r.exitCode).toBe(1)
      expect(r.message).toBe(PATH_TOO_LONG_ERROR)
      expect(r.runner.calls).toEqual([])
      expect(fs.existsSync(dir)).toBe(false) // the output folder was not made either
      expect(fs.readdirSync(tooLong)).toEqual([]) // and no work directory
    })

    it('has a message that says what to do and holds no path, and the limit leaves room below 260', () => {
      expect(PATH_TOO_LONG_ERROR).toMatch(/shorter backup folder, or a shorter TEMP folder/)
      expect(PATH_TOO_LONG_ERROR).not.toMatch(/[A-Za-z]:\\/)
      expect(WINDOWS_PATH_LIMIT).toBeLessThan(260 - 10)
    })

    it('is not applied on macOS and Linux, where the paths can be long', async () => {
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
  it('is refused on macOS and Linux: nothing runs, nothing is made, no log is written there, and the folder is not changed', async () => {
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
