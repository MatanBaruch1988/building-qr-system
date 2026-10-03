// The daily database backup (scripts/backup-db.mjs, docs/runbooks/restore.md). No database and no PostgreSQL tools: the
// process runner is a stub that records every call and writes the files that pg_dump would write, and the folder of the
// backups is a real temporary folder, so that the file handling (the temporary file, the rename, the retention) is real.
// Fake values only: the connection string below does not exist.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BACKUP_NAME,
  DEFAULT_KEEP,
  ISSUE_TITLE,
  WINDOWS_PG_BIN,
  backupFileName,
  cleanEnv,
  connectionEnv,
  findOpenIssue,
  formatSize,
  FOLDER_WARNING,
  issueBody,
  main,
  makeScrubber,
  neonCommand,
  nullDevice,
  parseArgs,
  parseNeonOutput,
  partialFileName,
  pgTool,
  resolvePgBin,
  runBackup,
  runProcess,
  selectOld,
} from '../scripts/backup-db.mjs'

const USER = 'backup_user'
const PASSWORD = 'fake/pass@word-123' // as it is after decoding
const ENCODED = 'fake%2Fpass%40word-123' // as it is written in the address
const HOST = 'ep-test-cool-123456.eu-central-1.aws.neon.tech'
const MASKED_HOST = 'ep-tes****.eu-central-1.aws.neon.tech'
const URL_FAKE = `postgresql://${USER}:${ENCODED}@${HOST}/appdb?sslmode=require`
const POOLED = `postgresql://${USER}:${ENCODED}@ep-test-cool-123456-pooler.eu-central-1.aws.neon.tech/appdb?sslmode=require`
const NOW = new Date('2026-10-03T07:15:42Z')
const FINAL = 'building-qr-20261003T0715Z.dump'
const PARTIAL = 'building-qr-20261003T0715Z.partial.dump'
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
  return path.resolve(String(target)) === path.resolve(dir) ? { mode: 0o040700 } : fs.statSync(target, ...rest)
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
  for (const file of r.files) {
    if (!file.endsWith('.dump')) texts.push(fs.readFileSync(path.join(dir, file), 'utf8'))
  }
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
    expect(env.PGOPTIONS).toBe('endpoint=ep-abc')
    expect(env.PGCHANNELBINDING).toBe('require')
    expect(env.PGPORT).toBe('6543')
    expect('PGOPTIONS' in connectionEnv('postgres://u:p@h.example/db')).toBe(false)
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
    expect(partialFileName(FINAL)).toBe(PARTIAL)
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
    const runner = makeRunner({
      pg_dump: (call) => {
        const answer = defaults.pg_dump(call)
        during = fs.readdirSync(dir)
        return answer
      },
    })
    const r = await go({ runner })
    expect(r.exitCode).toBe(0)
    expect(r.ok).toBe(true)
    expect(during).toEqual([PARTIAL])
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
    expect(dump.options.cwd).toBe(path.resolve(dir))
  })

  it('reads the dump back with pg_restore --list, in the same folder', async () => {
    const r = await go()
    const [list] = r.runner.of('pg_restore')
    expect(list.command).toBe('pg_restore')
    expect(list.args).toEqual(['--list', PARTIAL])
    expect(list.options.cwd).toBe(path.resolve(dir))
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
      expect(r.runner.of('pg_dump')[0].options.cwd).toBe(path.resolve(tmp, 'rel-backups'))
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
  it('BACKUP_DATABASE_URL first: then the Neon CLI is not called at all', async () => {
    const r = await go({ options: { neonProject: 'square-term-1' } })
    expect(r.exitCode).toBe(0)
    expect(r.runner.of('neon')).toEqual([])
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
      `2026-10-03T07:15:42Z failed host=${MASKED_HOST} error=pg_dump failed (exit code 1): pg_dump: error: server closed the connection unexpectedly\n`,
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
    expect(first.log).toBe(`2026-10-03T07:15:42Z ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0\n`)
    const later = new Date('2026-10-04T07:15:03Z')
    const second = await go({ deps: { now: () => later } })
    expect(second.log.split('\n').filter(Boolean)).toEqual([
      `2026-10-03T07:15:42Z ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0`,
      `2026-10-04T07:15:03Z ok host=${MASKED_HOST} file=building-qr-20261004T0715Z.dump size=15 removed=0`,
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
    expect(lines[1]).toBe(`2026-10-04T07:15:03Z failed host=${MASKED_HOST} error=pg_dump failed (exit code 2): bad ***`)
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
    expect(full.options.cwd).toBe(path.resolve(dir))
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
    expect(during).toEqual([PARTIAL])
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
    expect(r.log).toBe(`2026-10-03T07:15:42Z failed host=${MASKED_HOST} error=${r.message}\n`)
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
  /** An fs that records mkdir, chmod and appendFile calls, and says what the stat of the backup folder says. */
  function recordingFs({ folderMode = 0o040700, failChmod = false, events = [] } = {}) {
    const same = (p) => path.resolve(String(p)) === path.resolve(dir)
    return {
      events,
      chmods: [],
      appends: [],
      mkdirs: [],
      get fs() {
        const self = this
        return {
          ...fs,
          mkdirSync: (p, o) => {
            events.push('mkdir')
            self.mkdirs.push({ folder: same(p), options: o })
            return fs.mkdirSync(p, o)
          },
          statSync: (p, ...rest) => (same(p) ? { mode: folderMode } : fs.statSync(p, ...rest)),
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
    expect(events).toEqual(['umask 077', 'mkdir', 'pg_dump', 'umask 022'])
  })

  it('makes the folder with mode 700 and, for a nested folder, every folder on the way', async () => {
    const rec = recordingFs()
    await go({ deps: { fs: rec.fs } })
    expect(rec.mkdirs).toEqual([{ folder: true, options: { recursive: true, mode: 0o700 } }])
  })

  it('sets mode 600 on the finished dump and on backup.log, and creates the log with mode 600', async () => {
    const rec = recordingFs()
    const r = await go({ deps: { fs: rec.fs } })
    expect(rec.chmods).toEqual([
      { name: FINAL, folder: false, mode: 0o600 },
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
      `2026-10-03T07:15:42Z warning ${FOLDER_WARNING}`,
      `2026-10-03T07:15:42Z ok host=${MASKED_HOST} file=${FINAL} size=15 removed=0`,
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
    for (const mode of [0o040750, 0o040705, 0o040770, 0o040777, 0o040701]) {
      seed([])
      const r = await go({ deps: { fs: recordingFs({ folderMode: mode }).fs } })
      expect(r.log, mode.toString(8)).toContain(`warning ${FOLDER_WARNING}`)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not look at a folder that it made itself, and does not warn when the folder cannot be read or on Windows', async () => {
    const asked = []
    const open = { ...recordingFs({ folderMode: 0o040777 }).fs }
    const spy = { ...open, statSync: (p, ...rest) => (asked.push(path.basename(String(p))), open.statSync(p, ...rest)) }
    const fresh = await go({ deps: { fs: spy } })
    expect(fresh.log).not.toContain('warning')
    expect(asked).toEqual([FINAL]) // only the size of the dump, not the folder
    fs.rmSync(dir, { recursive: true, force: true })
    seed([])
    const dirStatFails = (p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(dir)) throw new Error('EACCES')
      return fs.statSync(p, ...rest)
    }
    const unreadable = await go({ deps: { fs: { ...fs, statSync: dirStatFails } } })
    expect(unreadable.exitCode).toBe(0)
    expect(unreadable.log).not.toContain('warning')
    fs.rmSync(dir, { recursive: true, force: true })
    seed([])
    const windows = await go({ deps: { fs: recordingFs({ folderMode: 0o040777 }).fs, platform: 'win32', exists: () => false } })
    expect(windows.log).not.toContain('warning')
  })

  it('a chmod that fails does not fail the backup: the dump is kept, and a warning says that its mode was not set', async () => {
    const rec = recordingFs({ failChmod: true })
    const r = await go({ deps: { fs: rec.fs } })
    expect(r.exitCode).toBe(0)
    expect(r.files).toEqual(['backup.log', FINAL])
    expect(r.warning).toBe('dump-permissions-not-set')
    expect(r.log).toContain(' warning=dump-permissions-not-set')
    expect(r.errs).toEqual(['backup: warning, dump-permissions-not-set'])
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
    expect(r.log).toBe(`2026-10-03T07:15:42Z failed host=${MASKED_HOST} error=${r.message}\n`)
    expect(r.errs).toEqual([`backup failed: ${r.message}`])
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
    expect(r.log).toContain(' issue=opened error=pg_dump failed')
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
