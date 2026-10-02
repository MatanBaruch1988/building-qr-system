// The three guards that CI runs on every pull request (scripts/check-migrations.mjs, check-tests.mjs and
// check-pr-title.mjs). Only their pure functions are tested here: no git and no database.
// The test lines that must look like a focused or skipped test are assembled from pieces, because check-tests.mjs scans
// this very file when it is added to a pull request, and a literal one would make it refuse its own tests.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { checkMigrations, findContractRisks, hasContractLine, stripComments } from '../scripts/check-migrations.mjs'
import { checkTests, isDiscovered, lineProblem, parseAddedLines, parseLabels, OVERRIDE_LABEL } from '../scripts/check-tests.mjs'
import { isValidTitle } from '../scripts/check-pr-title.mjs'
import { parseNameStatus, splitNul, unquoteGitPath, isSafeRef } from '../scripts/ci-git.mjs'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const dot = (word) => `.${word}`
// The bracket form of a member access, `[<quote>word<quote>]`, assembled so that this file has no literal one.
const bracket = (word, quote = "'") => `[${quote}${word}${quote}]`
// What `git diff --name-status -z` prints: every field ends with a NUL.
const nul = (...fields) => fields.map((field) => `${field}\0`).join('')
const EXISTING = ['db/migrations/001_init.sql', 'db/migrations/004_deleting_on_purpose.sql', 'db/migrations/005_delete_everywhere.sql']
const added = (name) => ({ status: 'A', path: `db/migrations/${name}` })
const sqlFor = (name, sql) => ({ [`db/migrations/${name}`]: sql })

describe('git helpers', () => {
  it('reads NUL-separated git name-status output, including renames and copies', () => {
    const output = nul('A', 'db/migrations/006_x.sql', 'M', 'a.js', 'D', 'b.js', 'R100', 'old.js', 'new.js', 'C75', 'src.js', 'copy.js', 'T', 'c.js')
    expect(parseNameStatus(output)).toEqual([
      { status: 'A', path: 'db/migrations/006_x.sql' },
      { status: 'M', path: 'a.js' },
      { status: 'D', path: 'b.js' },
      { status: 'R', oldPath: 'old.js', path: 'new.js' },
      { status: 'C', oldPath: 'src.js', path: 'copy.js' },
      { status: 'T', path: 'c.js' },
    ])
  })

  it('has nothing to say about empty output', () => {
    expect(parseNameStatus('')).toEqual([])
  })

  it('keeps a file name with a tab, a newline, a quote or a backslash exactly, also in a rename', () => {
    const odd = 'tests/we\tird\nname "q" \\ x.test.js'
    expect(parseNameStatus(nul('A', odd, 'D', 'tests/a b.test.js', 'R076', 'tests/old.test.js', odd))).toEqual([
      { status: 'A', path: odd },
      { status: 'D', path: 'tests/a b.test.js' },
      { status: 'R', oldPath: 'tests/old.test.js', path: odd },
    ])
    // The old, line based parse would have seen two different files in the first entry.
    expect(odd.split(/\r?\n/)).toHaveLength(2)
  })

  it('does not take a rename old path for the status of the next entry', () => {
    expect(parseNameStatus(nul('R100', 'M', 'D', 'M', 'x.js'))).toEqual([
      { status: 'R', oldPath: 'M', path: 'D' },
      { status: 'M', path: 'x.js' },
    ])
  })

  it('refuses output that stops in the middle of an entry', () => {
    expect(() => parseNameStatus(nul('R100', 'old.js'))).toThrow(/Unexpected/)
    expect(() => parseNameStatus(nul('M'))).toThrow(/Unexpected/)
    expect(() => parseNameStatus(nul('M', ''))).toThrow(/Unexpected/)
  })

  it('splits git -z lists (ls-tree --name-only) at the NUL only', () => {
    expect(splitNul(nul('db/migrations/001_init.sql', 'db/migrations/we\tird\nname.sql'))).toEqual([
      'db/migrations/001_init.sql',
      'db/migrations/we\tird\nname.sql',
    ])
    expect(splitNul('')).toEqual([])
  })

  it('undoes the quoting that git uses for a file name in a patch header', () => {
    expect(unquoteGitPath('b/tests/plain.test.js')).toBe('b/tests/plain.test.js')
    // A name with a space is not quoted, but git adds a TAB after it.
    expect(unquoteGitPath('b/tests/with space.test.js\t')).toBe('b/tests/with space.test.js')
    expect(unquoteGitPath('"b/tests/we\\tird \\"q\\" \\\\ x\\n.test.js"')).toBe('b/tests/we\tird "q" \\ x\n.test.js')
    expect(unquoteGitPath('"b/tests/we\\tird x.test.js"\t')).toBe('b/tests/we\tird x.test.js')
    expect(unquoteGitPath('"b/tests/caf\\303\\251.test.js"')).toBe('b/tests/café.test.js')
    expect(unquoteGitPath('"b/tests/שלום\\t.test.js"')).toBe('b/tests/שלום\t.test.js')
    expect(unquoteGitPath('/dev/null')).toBe('/dev/null')
  })

  it('only lets something that looks like a ref through to git', () => {
    expect(isSafeRef('origin/master')).toBe(true)
    expect(isSafeRef('0a1b2c3d4e5f60718293a4b5c6d7e8f901234567')).toBe(true)
    for (const bad of [undefined, '', '--output=x', '-n', 'a b', 'a;b', '$(id)']) expect(isSafeRef(bad), String(bad)).toBe(false)
  })
})

describe('check-migrations: existing files are history', () => {
  it('passes when nothing under db/migrations changed', () => {
    expect(checkMigrations([], {}, EXISTING)).toEqual([])
  })

  it('refuses a modified old migration', () => {
    const problems = checkMigrations([{ status: 'M', path: 'db/migrations/005_delete_everywhere.sql' }], {}, EXISTING)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('005_delete_everywhere.sql')
    expect(problems[0]).toContain('modified')
  })

  it('refuses a deleted old migration', () => {
    const problems = checkMigrations([{ status: 'D', path: 'db/migrations/001_init.sql' }], {}, EXISTING)
    expect(problems[0]).toContain('001_init.sql')
    expect(problems[0]).toContain('deleted')
  })

  it('refuses a renamed old migration and does not also judge the new name', () => {
    const problems = checkMigrations(
      [{ status: 'R', oldPath: 'db/migrations/004_deleting_on_purpose.sql', path: 'db/migrations/004_other_name.sql' }],
      sqlFor('004_other_name.sql', 'select 1;'),
      EXISTING,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('004_deleting_on_purpose.sql')
    expect(problems[0]).toContain('renamed')
  })

  it('refuses an old migration moved out of the folder', () => {
    const problems = checkMigrations([{ status: 'R', oldPath: 'db/migrations/001_init.sql', path: 'docs/001_init.sql' }], {}, EXISTING)
    expect(problems[0]).toContain('renamed or moved')
  })

  it('ignores changes outside db/migrations', () => {
    expect(checkMigrations([{ status: 'M', path: 'server/db.js' }, { status: 'D', path: 'docs/x.md' }], {}, EXISTING)).toEqual([])
  })
})

describe('check-migrations: names and numbers', () => {
  it('accepts the next number', () => {
    expect(checkMigrations([added('006_add_notes.sql')], sqlFor('006_add_notes.sql', 'alter table t add column note text;'), EXISTING)).toEqual([])
  })

  it('accepts several new files in order, however git lists them', () => {
    const changes = [added('007_second.sql'), added('006_first.sql')]
    const sql = { ...sqlFor('006_first.sql', 'create table a (id int);'), ...sqlFor('007_second.sql', 'create table b (id int);') }
    expect(checkMigrations(changes, sql, EXISTING)).toEqual([])
  })

  it('refuses a gap in the numbering', () => {
    const problems = checkMigrations([added('007_skips_one.sql')], sqlFor('007_skips_one.sql', 'select 1;'), EXISTING)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('007_skips_one.sql')
    expect(problems[0]).toContain('next one must be 006')
  })

  it('refuses a number that repeats', () => {
    const changes = [added('006_first.sql'), added('006_again.sql')]
    const sql = { ...sqlFor('006_first.sql', 'select 1;'), ...sqlFor('006_again.sql', 'select 2;') }
    const problems = checkMigrations(changes, sql, EXISTING)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('006_first.sql')
  })

  it('refuses a number that was already used by an old file', () => {
    const problems = checkMigrations([added('005_again.sql')], sqlFor('005_again.sql', 'select 1;'), EXISTING)
    expect(problems[0]).toContain('next one must be 006')
  })

  it('starts at 001 when there are no migrations yet', () => {
    expect(checkMigrations([added('001_init.sql')], sqlFor('001_init.sql', 'create table a (id int);'), [])).toEqual([])
  })

  it('refuses a file name that does not follow NNN_snake_case.sql', () => {
    for (const name of ['6_short.sql', '0006_long.sql', '006_Upper.sql', '006-dash.sql', '006_no_extension', '006_.txt', 'notes.sql']) {
      const problems = checkMigrations([added(name)], sqlFor(name, 'select 1;'), EXISTING)
      expect(problems.length, name).toBe(1)
      expect(problems[0], name).toContain('NNN_snake_case.sql')
    }
  })

  it('refuses a new migration in a sub folder', () => {
    const problems = checkMigrations(
      [{ status: 'A', path: 'db/migrations/archive/006_x.sql' }],
      { 'db/migrations/archive/006_x.sql': 'select 1;' },
      EXISTING,
    )
    expect(problems[0]).toContain('NNN_snake_case.sql')
  })

  it('works with the real migrations folder: consecutive numbers from 001, valid names', () => {
    const names = fs.readdirSync(path.join(root, 'db', 'migrations')).sort()
    expect(names.length).toBeGreaterThan(0)
    names.forEach((name, i) => expect(name.startsWith(String(i + 1).padStart(3, '0') + '_'), name).toBe(true))
    const existing = names.map((name) => `db/migrations/${name}`)
    expect(checkMigrations([], {}, existing)).toEqual([])
    // The next file after the last real one would be accepted.
    const next = String(names.length + 1).padStart(3, '0') + '_next.sql'
    expect(checkMigrations([added(next)], sqlFor(next, 'select 1;'), existing)).toEqual([])
  })
})

describe('check-migrations: destructive SQL needs a contract line', () => {
  const NEEDS_HEADER = [
    ['DROP TABLE', 'drop table old_things;'],
    ['DROP TABLE', 'DROP TABLE IF EXISTS old_things CASCADE;'],
    ['DROP COLUMN', 'alter table admins drop column password_hash;'],
    ['DROP COLUMN', 'alter table admins\n  drop column if exists password_hash;'],
    ['DROP COLUMN', 'alter table admins drop password_hash;'],
    ['DROP COLUMN', 'alter table admins drop if exists password_hash;'],
    ['DROP COLUMN', 'alter table admins add column x int, drop column y;'],
    ['DROP VIEW', 'drop view v_attendance;'],
    ['DROP VIEW', 'drop materialized view if exists v_totals;'],
    ['DROP SCHEMA', 'drop schema legacy cascade;'],
    ['DROP TYPE', 'drop type mood;'],
    ['RENAME', 'alter table scans rename to visits;'],
    ['RENAME', 'alter table scans rename column point_name to place_name;'],
    ['RENAME', 'alter table scans rename point_name to place_name;'],
    ['RENAME', 'alter view v_attendance rename to v_attendance_old;'],
    ['TRUNCATE', 'truncate scans;'],
    ['TRUNCATE', 'TRUNCATE TABLE scans, providers;'],
    ['DELETE FROM', 'delete from point_providers pp where pp.point_id is null;'],
    ['ALTER COLUMN ... TYPE', 'alter table scans alter column checked_in_at type timestamptz(3);'],
    ['ALTER COLUMN ... TYPE', 'alter table scans alter checked_in_at set data type timestamptz(3);'],
    ['ALTER COLUMN ... SET NOT NULL', 'alter table scans alter column point_name set not null;'],
    ['ALTER COLUMN ... SET NOT NULL', 'ALTER TABLE scans ALTER point_name SET NOT NULL;'],
  ]

  it.each(NEEDS_HEADER)('%s without the line is refused: %s', (label, sql) => {
    expect(findContractRisks(sql)).toContain(label)
    const problems = checkMigrations([added('006_x.sql')], sqlFor('006_x.sql', sql), EXISTING)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('006_x.sql')
    expect(problems[0]).toContain('-- contract: <reason>')
  })

  it.each(NEEDS_HEADER)('%s with the line is accepted: %s', (_label, sql) => {
    const withLine = `-- contract: nothing reads this since release 2.3\n${sql}`
    expect(checkMigrations([added('006_x.sql')], sqlFor('006_x.sql', withLine), EXISTING)).toEqual([])
  })

  it('accepts the line anywhere in the file and with any spacing', () => {
    for (const line of ['--contract: gone', '  --   contract:   gone since 2.3  ', '-- contract: x']) {
      expect(hasContractLine(`select 1;\n${line}\ndrop table a;`), line).toBe(true)
    }
  })

  it('does not accept a line without a reason, or a look-alike', () => {
    for (const line of ['-- contract:', '-- contract:   ', '-- contracted: yes', '-- not a contract: yes', '/* contract: yes */', 'select 1; -- contract: no']) {
      expect(hasContractLine(`${line}\ndrop table a;`), line).toBe(false)
    }
    const problems = checkMigrations([added('006_x.sql')], sqlFor('006_x.sql', '-- contract:\ndrop table a;'), EXISTING)
    expect(problems).toHaveLength(1)
  })

  it('names every kind of destructive SQL it found in one message', () => {
    const problems = checkMigrations([added('006_x.sql')], sqlFor('006_x.sql', 'drop table a;\ntruncate b;'), EXISTING)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('DROP TABLE, TRUNCATE')
  })

  it('allows the safe kinds of change without the line', () => {
    const SAFE = [
      'create table notes (id serial primary key, body text);',
      'alter table scans add column note text;',
      'alter table scans add column flag boolean not null default false;',
      'create index scans_note_idx on scans (note);',
      'alter table scans drop constraint if exists scans_point_id_fkey;',
      'alter table scans drop constraint scans_point_id_fkey, add constraint x check (true);',
      'drop index scans_checked_in_idx;',
      'drop index if exists scans_checked_in_idx;',
      'drop trigger if exists scans_guard on scans;',
      'drop function if exists scans_guard();',
      'create or replace function scans_guard() returns trigger language plpgsql as $$ begin return new; end $$;',
      'create or replace view v_attendance as select 1;',
      'alter table scans alter column note drop not null;',
      'alter table scans alter column note drop default;',
      'alter table scans alter column note set default null;',
      'alter table scans rename constraint a to b;',
      'alter index scans_checked_in_idx rename to scans_when_idx;',
      'create trigger scans_no_truncate before truncate on scans for each statement execute function scans_block_truncate();',
      'create trigger t after delete or truncate on scans for each statement execute function f();',
      'alter table point_providers add constraint fk foreign key (provider_id) references providers (id) on delete cascade;',
      'insert into admins (email) values (\'a@example.com\') on conflict do nothing;',
      'update scans set note = \'\' where note is null;',
    ]
    for (const sql of SAFE) {
      expect(findContractRisks(sql), sql).toEqual([])
      expect(checkMigrations([added('006_x.sql')], sqlFor('006_x.sql', sql), EXISTING), sql).toEqual([])
    }
  })

  it('ignores destructive words in comments', () => {
    const sql = [
      '-- we used to drop table old_things here, then truncate scans and delete from admins',
      '/* alter table scans drop column x; rename to y; alter column z set not null */',
      'alter table scans add column note text; -- not a drop column',
    ].join('\n')
    expect(stripComments(sql)).not.toMatch(/drop|truncate|rename/)
    expect(findContractRisks(sql)).toEqual([])
  })

  it('still sees destructive SQL after a comment that has an apostrophe', () => {
    expect(findContractRisks("-- the provider's rows\ndrop table providers;")).toEqual(['DROP TABLE'])
  })

  it('does not take a double hyphen inside a string for a comment', () => {
    expect(findContractRisks("insert into notes (body) values ('a--b'); drop table notes;")).toEqual(['DROP TABLE'])
  })

  it('reports a new file whose contents are missing instead of passing it', () => {
    const problems = checkMigrations([added('006_x.sql')], {}, EXISTING)
    expect(problems[0]).toContain('could not be read')
  })
})

describe('check-tests: reading the diff', () => {
  const DIFF = [
    'diff --git a/e2e/new.spec.js b/e2e/new.spec.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/e2e/new.spec.js',
    '@@ -0,0 +1,3 @@',
    '+first',
    '+++counter',
    '+third',
    'diff --git a/tests/old.test.js b/tests/old.test.js',
    '--- a/tests/old.test.js',
    '+++ b/tests/old.test.js',
    '@@ -4 +4 @@',
    '-before',
    '+after',
    '@@ -10,0 +11,2 @@',
    '+eleven',
    '+twelve',
    '\\ No newline at end of file',
    'diff --git a/tests/gone.test.js b/tests/gone.test.js',
    'deleted file mode 100644',
    '--- a/tests/gone.test.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-x',
    '-y',
  ].join('\n')

  it('lists the added lines with their file and line number', () => {
    expect(parseAddedLines(DIFF)).toEqual([
      { file: 'e2e/new.spec.js', line: 1, text: 'first' },
      { file: 'e2e/new.spec.js', line: 2, text: '++counter' },
      { file: 'e2e/new.spec.js', line: 3, text: 'third' },
      { file: 'tests/old.test.js', line: 4, text: 'after' },
      { file: 'tests/old.test.js', line: 11, text: 'eleven' },
      { file: 'tests/old.test.js', line: 12, text: 'twelve' },
    ])
  })

  it('has nothing to say about an empty diff', () => {
    expect(parseAddedLines('')).toEqual([])
  })

  it('reads the real name of a file that git wrote in quotes, so its lines are still checked', () => {
    const diff = [
      'diff --git "a/e2e/we\\tird \\"q\\".spec.js" "b/e2e/we\\tird \\"q\\".spec.js"',
      '--- "a/e2e/we\\tird \\"q\\".spec.js"',
      '+++ "b/e2e/we\\tird \\"q\\".spec.js"\t',
      '@@ -3,0 +4 @@',
      '+added',
      'diff --git a/tests/with space.test.js b/tests/with space.test.js',
      '--- a/tests/with space.test.js\t',
      '+++ b/tests/with space.test.js\t',
      '@@ -1 +1 @@',
      '+changed',
    ].join('\n')
    expect(parseAddedLines(diff)).toEqual([
      { file: 'e2e/we\tird "q".spec.js', line: 4, text: 'added' },
      { file: 'tests/with space.test.js', line: 1, text: 'changed' },
    ])
    // The checker then treats it as a file under e2e/ (a name left in quotes would not start with it).
    const { problems } = checkTests([], [{ file: 'e2e/we\tird "q".spec.js', line: 4, text: `test${dot('fixme')}('later', async () => {})` }])
    expect(problems).toHaveLength(1)
  })
})

describe('check-tests: what the runners pick up', () => {
  it.each([
    ['tests/api.test.js', true],
    ['tests/components/Row.test.jsx', true],
    ['tests/a/b/c/deep.test.js', true],
    ['e2e/admin.spec.js', true],
    ['e2e/odd.test.js', true],
    ['e2e/sub/deep.spec.mjs', true],
    ['e2e/typed.spec.ts', true],
    // Vitest only runs *.test.js and *.test.jsx under tests/
    ['tests/api.spec.js', false],
    ['tests/api.test.mjs', false],
    ['tests/api.test.ts', false],
    ['tests/api.test.txt', false],
    ['tests/api.js', false],
    ['tests/helpers.js', false],
    // Playwright only runs *.spec.* and *.test.* under e2e/
    ['e2e/fixtures.js', false],
    ['e2e/spec.js', false],
    ['e2e/admin.spec.json', false],
    ['scripts/api.test.js', false],
    ['src/thing.test.js', false],
    ['api.test.js', false],
  ])('%s: %s', (file, picked) => {
    expect(isDiscovered(file)).toBe(picked)
  })

  it('matches the configuration of the two runners (change both together)', () => {
    const vitest = fs.readFileSync(path.join(root, 'vitest.config.js'), 'utf8')
    expect(vitest).toContain("include: ['tests/**/*.test.{js,jsx}']")
    const playwright = fs.readFileSync(path.join(root, 'playwright.config.js'), 'utf8')
    expect(playwright).toContain("testDir: './e2e'")
    // No testMatch: Playwright's default (**/*.@(spec|test).?(c|m)[jt]s?(x)) is what isDiscovered mirrors.
    expect(playwright).not.toMatch(/testMatch|testIgnore/)
  })
})

describe('check-tests: deleted tests', () => {
  it('refuses a deleted test or spec file', () => {
    const problems = checkTests(
      [{ status: 'D', path: 'tests/api.test.js' }, { status: 'D', path: 'e2e/admin.spec.js' }, { status: 'D', path: 'tests/components/Row.test.jsx' }],
      [],
    )
    expect(problems.problems).toHaveLength(3)
    expect(problems.problems[0]).toContain('tests/api.test.js')
    expect(problems.warnings).toEqual([])
  })

  it('refuses a test file moved out of the test folders', () => {
    const { problems } = checkTests([{ status: 'R', oldPath: 'tests/api.test.js', path: 'scripts/api.test.js' }], [])
    expect(problems[0]).toContain('tests/api.test.js')
  })

  it('accepts a test file renamed or moved within the test folders', () => {
    expect(checkTests([{ status: 'R', oldPath: 'tests/api.test.js', path: 'tests/components/api.test.js' }], []).problems).toEqual([])
  })

  it.each([
    ['tests/api.test.js', 'tests/api.spec.js'],
    ['tests/api.test.js', 'tests/api.test.mjs'],
    ['tests/api.test.js', 'tests/api.test.ts'],
    ['tests/api.test.js', 'tests/api.test.js.txt'],
    ['tests/api.test.js', 'tests/api.js'],
    ['tests/api.test.js', 'tests/api'],
    ['tests/components/Row.test.jsx', 'tests/components/Row.jsx'],
    ['tests/api.test.js', 'e2e/helpers.js'],
    ['e2e/admin.spec.js', 'e2e/admin.js'],
    ['e2e/admin.spec.js', 'e2e/admin.spec.json'],
    ['e2e/admin.spec.js', 'tests/admin.spec.js'],
  ])('refuses a rename that nothing runs any more: %s to %s', (oldPath, newPath) => {
    const { problems, warnings } = checkTests([{ status: 'R', oldPath, path: newPath }], [])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(oldPath)
    expect(problems[0]).toContain(newPath)
    expect(problems[0]).toContain('renamed')
    expect(warnings).toEqual([])
  })

  it.each([
    ['tests/api.test.js', 'tests/api-v2.test.js'],
    ['tests/api.test.js', 'tests/components/api.test.jsx'],
    ['tests/components/Row.test.jsx', 'tests/Row.test.js'],
    ['e2e/admin.spec.js', 'e2e/committee.spec.js'],
    ['e2e/admin.spec.js', 'e2e/admin/screens.spec.js'],
    ['e2e/admin.spec.js', 'e2e/admin.test.js'],
    ['e2e/admin.spec.js', 'e2e/admin.spec.mjs'],
    // tests/api.test.js moved into e2e/ with a .test.js name is still found: by Playwright, by its default testMatch.
    // (A Vitest file does not run there: it would fail at once, which is loud, not silent.)
    ['tests/api.test.js', 'e2e/api.test.js'],
  ])('accepts a rename that a runner still finds: %s to %s', (oldPath, newPath) => {
    expect(checkTests([{ status: 'R', oldPath, path: newPath }], [])).toEqual({ problems: [], warnings: [] })
  })

  it('does not mind a rename of a file that no runner picked up before', () => {
    expect(checkTests([{ status: 'R', oldPath: 'tests/helpers.js', path: 'tests/utils.js' }], []).problems).toEqual([])
    expect(checkTests([{ status: 'R', oldPath: 'e2e/fixtures.js', path: 'e2e/support.js' }], []).problems).toEqual([])
  })

  it('turns a refused rename into a warning with the allow-test-removal label', () => {
    const change = { status: 'R', oldPath: 'tests/api.test.js', path: 'tests/api.spec.js' }
    const { problems, warnings } = checkTests([change], [], [OVERRIDE_LABEL])
    expect(problems).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('accepts deleting a helper that is not a test, or a file somewhere else', () => {
    const changes = [{ status: 'D', path: 'tests/old-helper.js' }, { status: 'D', path: 'src/thing.test.js' }, { status: 'M', path: 'tests/api.test.js' }]
    expect(checkTests(changes, []).problems).toEqual([])
  })
})

describe('check-tests: focused and skipped tests', () => {
  const refused = [
    `it${dot('only')}('works', () => {})`,
    `  describe${dot('only')}('group', () => {`,
    `test${dot('only')}('works', async ({ page }) => {`,
    `test${dot('describe')}${dot('only')}('group', () => {`,
    `it${dot('skip')}('works', () => {})`,
    `describe${dot('skip')}('group', () => {`,
    `test${dot('skip')}('works', async () => {})`,
    `test${dot('describe')}${dot('skip')}('group', () => {`,
    `test${dot('fixme')}('works', async () => {})`,
    `test${dot('fixme')}(browserName === 'webkit', 'later')`,
    `${'x'}${'it'}('works', () => {})`,
    `${'x'}${'describe'}('group', () => {})`,
    `${'x'}${'test'}('works', () => {})`,
    // a skip that has no reason, or a condition that is always true, is not the allowed kind
    `test${dot('skip')}()`,
    `test${dot('skip')}(browserName === 'webkit')`,
    `test${dot('skip')}(true, 'always')`,
    `test${dot('skip')}('title is not a condition', 'reason')`,
    `test${dot('skip')}(browserName === 'webkit', '')`,
    `describe${dot('skip')}(browserName === 'webkit', 'a reason on a describe is still a skipped group')`,
    `  it${dot('skip')}${dot('each')}([1, 2])('works', () => {})`,
    // postponed with a todo
    `it${dot('todo')}('later')`,
    `  test${dot('todo')}('later', () => {})`,
    `describe${dot('todo')}('later')`,
    // the same things written with a bracket instead of a dot
    `test${bracket('skip')}('works', async () => {})`,
    `it${bracket('only', '"')}('works', () => {})`,
    `  describe${bracket('skip', '`')}('group', () => {})`,
    `test${bracket('fixme')}('works', async () => {})`,
    `it${bracket('todo')} ('later')`,
    `test${dot('describe')}${bracket('only')}('group', () => {`,
    `test${bracket('skip')}(browserName === 'webkit', 'a bracket skip has no allowed form')`,
    // a condition that is a constant skips for every browser, so it is not a conditional skip
    `test${dot('skip')}(1, 'always')`,
    `test${dot('skip')}(0, 'never mind')`,
    `test${dot('skip')}(true, 'x')`,
    `test${dot('skip')}(false, 'x')`,
    `test${dot('skip')}(!0, 'x')`,
    `test${dot('skip')}((true), 'x')`,
    `test${dot('skip')}(null, 'x')`,
    `test${dot('skip')}("always", 'x')`,
    `test${dot('skip')}(\`always\`, 'x')`,
    `test${dot('skip')}(1.5e3, 'x')`,
    `testInfo${dot('skip')}(true, 'x')`,
    // two arguments exactly: a reason and nothing else, and the condition is not missing
    `test${dot('skip')}(browserName === 'webkit', 'reason', async () => {})`,
    `test${dot('skip')}(, 'reason')`,
    `test${dot('skip')}(browserName === 'webkit', browserReason)`,
    // the exception covers one skip and nothing else on the same line
    `test${dot('skip')}(browserName === 'webkit', 'a reason'); it${dot('skip')}('works', () => {})`,
    `test${dot('skip')}(browserName === 'webkit', 'a reason'); test${dot('skip')}(true, 'x')`,
    `test${dot('skip')}(browserName === 'webkit', 'a reason') && it${dot('skip')}('works', () => {})`,
    `it${dot('skip')}('works', () => {}); test${dot('skip')}(browserName === 'webkit', 'a reason')`,
    `test${dot('skip')}(browserName === 'webkit', 'a reason'), ${'x'}${'it'}('works', () => {})`,
    `test${dot('skip')}(browserName === 'webkit', 'a reason'); it${dot('todo')}('later')`,
    `test${dot('skip')}(browserName === 'webkit', 'a reason'); test${dot('fixme')}('works', () => {})`,
    `test${dot('skip')}(browserName === 'webkit', 'a reason'); it${bracket('skip')}('works', () => {})`,
    `test${dot('skip')}(browserName === 'webkit', 'a reason'); it${dot('only')}('works', () => {})`,
    // a skip hidden in the condition of an allowed one
    `test${dot('skip')}(!!test${dot('skip')}(true, 'x'), 'a reason')`,
    // not the test object: another object's skip method
    `page${dot('test')}${dot('skip')}(browserName === 'webkit', 'a reason')`,
  ]

  it.each(refused)('refuses an added line: %s', (text) => {
    expect(lineProblem(text)).toEqual(expect.any(String))
    const { problems } = checkTests([], [{ file: 'tests/x.test.js', line: 7, text }])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('tests/x.test.js:7')
  })

  const accepted = [
    `test${dot('skip')}(browserName === 'webkit', 'Playwright WebKit cannot emulate offline: see docs/manual-ios-checklist.md')`,
    `  test${dot('skip')}(isMobile, "mobile has no hover")`,
    `test${dot('skip')}(!process.env.CI, \`only meaningful on CI\`)`,
    `testInfo${dot('skip')}(project.name !== 'android-chrome', 'android only')`,
    // the condition may be a call with commas, a function or a comparison with a string: it is still not a constant
    `test${dot('skip')}(isIn(browserName, ['webkit', 'firefox']), 'those cannot do it')`,
    `test${dot('skip')}(({ browserName }) => browserName === 'webkit', 'a function is a condition too')`,
    `test${dot('skip')}('webkit' === browserName, 'a comparison is not a literal')`,
    `test${dot('skip')}(browserName === 'webkit', 'the reason may mention ${dot('skip')}( as text')`,
    `test${dot('skip')}(browserName === 'webkit', 'it has a, comma') // and a trailing comment`,
    `test${dot('skip')}(browserName === 'webkit', 'trailing comma',)`,
    `it('does not run anything with an only in its name', () => {})`,
    `const todoList = ['skip', 'only']`,
    `expect(labels['skip']).toBe(1)`,
    `const skipped = skipLibCheck + onlyOnce`,
    `// ${'it'}${dot('only')}( and ${'x'}${'it'}( in a comment do nothing`,
    ` * ${'test'}${dot('skip')}('inside a doc comment')`,
    '',
  ]

  it.each(accepted)('accepts an added line: %s', (text) => {
    expect(lineProblem(text)).toBeNull()
  })

  it('accepts the conditional skip that e2e/fixtures.js already has', () => {
    const line = fs.readFileSync(path.join(root, 'e2e', 'fixtures.js'), 'utf8').split(/\r?\n/).find((l) => l.includes(`test${dot('skip')}(`))
    expect(line, 'e2e/fixtures.js has its conditional skip').toBeTruthy()
    expect(lineProblem(line)).toBeNull()
  })

  it('does not judge added lines outside tests/ and e2e/', () => {
    expect(checkTests([], [{ file: 'scripts/other.js', line: 1, text: `it${dot('only')}('x')` }]).problems).toEqual([])
  })

  it('shows the file, the line number and the offending line', () => {
    const { problems } = checkTests([], [{ file: 'e2e/admin.spec.js', line: 42, text: `  test${dot('fixme')}('later', async () => {})` }])
    expect(problems[0]).toContain('e2e/admin.spec.js:42')
    expect(problems[0]).toContain('fixme')
  })
})

describe('check-tests: the allow-test-removal label', () => {
  const changes = [{ status: 'D', path: 'tests/api.test.js' }]
  const lines = [{ file: 'tests/x.test.js', line: 3, text: `it${dot('only')}('x', () => {})` }]

  it('turns the problems into warnings, all of them', () => {
    const result = checkTests(changes, lines, ['bug', OVERRIDE_LABEL])
    expect(result.problems).toEqual([])
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain('tests/api.test.js')
  })

  it('does nothing for other labels or none', () => {
    expect(checkTests(changes, lines, ['bug', 'allow-something-else']).problems).toHaveLength(2)
    expect(checkTests(changes, lines, []).problems).toHaveLength(2)
    expect(checkTests(changes, lines).problems).toHaveLength(2)
  })

  it('has no warnings when there is nothing to warn about', () => {
    expect(checkTests([], [], [OVERRIDE_LABEL])).toEqual({ problems: [], warnings: [] })
  })

  it('reads the label names from the JSON that the workflow passes in', () => {
    expect(parseLabels('["bug","allow-test-removal"]')).toEqual(['bug', OVERRIDE_LABEL])
    expect(parseLabels('[]')).toEqual([])
    expect(parseLabels(undefined)).toEqual([])
    expect(parseLabels('')).toEqual([])
    expect(parseLabels('not json')).toEqual([])
    expect(parseLabels('{"allow-test-removal":true}')).toEqual([])
    expect(parseLabels('[1,null,"ok"]')).toEqual(['ok'])
  })
})

describe('check-pr-title: Conventional Commits', () => {
  it.each([
    'feat: export attendance to CSV',
    'fix: refuse a scan from too far away',
    'fix(scan): refuse a point that is too far',
    'feat(api)!: remove the old agent route',
    'ci: add GitHub Actions pipeline with guards, unit and e2e on Postgres 18',
    'docs(readme): describe the rulesets',
    'chore(deps-dev): bump vitest',
    'refactor: split the admin routes',
    'perf: index scans by day',
    'test: cover the contract line',
    'build: use Node 24',
    'style: format the tiles',
    'revert: feat: export attendance to CSV',
    'fix: a',
  ])('accepts %s', (title) => {
    expect(isValidTitle(title)).toBe(true)
  })

  it.each([
    'Add the pipeline',
    'ci add GitHub Actions pipeline',
    'Fix: refuse a scan',
    'feat:no space after the colon',
    'feat:  two spaces before the text',
    'feat: ',
    'feat:',
    'feature: export attendance',
    'fix (scan): a space before the scope',
    'fix(Scan): upper case scope',
    'fix(): empty scope',
    'fix(a_b): underscore in scope',
    'fix!(scan): bang before the scope',
    'fix: first line\nsecond line',
    ' fix: leading space',
    '',
    null,
    undefined,
    42,
  ])('refuses %j', (title) => {
    expect(isValidTitle(title)).toBe(false)
  })
})
