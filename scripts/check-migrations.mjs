// CI guard for the database migrations in db/migrations (see .github/workflows/ci.yml, job "guards").
//
// Usage: node scripts/check-migrations.mjs --base origin/master
//
// Why this exists: when a release is deployed, the OLD deployment keeps serving traffic while the new one builds and
// while its migration runs, and a phone that has the old app open keeps calling the old API for a while after that.
// So the database has to work for the old code and the new code at the same time. Changes go in three steps:
// expand (add the new column, table or index), migrate (move the data and switch the code to it), and only in a
// LATER release contract (drop, rename or tighten what the old code relied on). Every migration that contracts
// something must say so with a line `-- contract: <why it is safe now>`, so that it is a decision somebody made and not
// an accident.
//
// What it refuses, from the files that the pull request changes under db/migrations:
//   - an existing migration that is modified, renamed or deleted (a migration that has run is history: fix forward
//     with a new file);
//   - a new file whose name is not NNN_snake_case.sql, or whose number is not exactly one after the previous one
//     (no gaps, no repeats);
//   - a new file with destructive SQL and no `-- contract: <reason>` line. Destructive means DROP TABLE, DROP COLUMN,
//     DROP VIEW, DROP SCHEMA, DROP TYPE, RENAME (a table, column, view, schema or type), TRUNCATE, DELETE FROM,
//     ALTER COLUMN ... TYPE and ALTER COLUMN ... SET NOT NULL. DROP CONSTRAINT, DROP INDEX, DROP TRIGGER, DROP FUNCTION
//     and CREATE OR REPLACE are fine without the line.
// Comments are ignored when looking for the SQL, so a word inside a `--` or `/* */` comment never triggers it.
//
// The destructive-SQL detection is a heuristic: it reads the text of the file, so it cannot see SQL that is assembled at
// run time (for example EXECUTE 'DR' || 'OP TABLE x' in a DO block), and a clever or careless statement can slip past
// it. It catches the common ways and the accidents. The owner's review of every migration stays required.
import path from 'node:path'
import { runGit, parseNameStatus, splitNul, argValue, isSafeRef, isMain } from './ci-git.mjs'

const DIR = 'db/migrations/'
const NAME = /^(\d{3})_[a-z0-9_]+\.sql$/
// The header is looked for in the file as written (it is itself a comment), and it needs a reason after the colon.
const CONTRACT_LINE = /^[ \t]*--[ \t]*contract:[ \t]*\S/m

// Each rule is tried on the SQL with comments removed, lower-cased and with every run of white space made one space.
const CONTRACT_RULES = [
  { label: 'DROP TABLE', test: /\bdrop\s+table\b/ },
  { label: 'DROP COLUMN', test: /\bdrop\s+column\b/ },
  // ALTER TABLE t DROP c: the word COLUMN is optional. Anything else that follows DROP in an ALTER TABLE is a column,
  // except the harmless forms (DROP CONSTRAINT, ALTER COLUMN c DROP DEFAULT / DROP NOT NULL / ...).
  {
    label: 'DROP COLUMN',
    test: /\balter\s+table\b[^;]*?\bdrop\s+(?!constraint\b|default\b|not\b|expression\b|identity\b|column\b)/,
  },
  { label: 'DROP VIEW', test: /\bdrop\s+(?:materialized\s+)?view\b/ },
  { label: 'DROP SCHEMA', test: /\bdrop\s+schema\b/ },
  { label: 'DROP TYPE', test: /\bdrop\s+type\b/ },
  // Renaming a constraint or an index does not matter to code that only reads and writes rows.
  {
    label: 'RENAME',
    test: /\balter\s+(?:table|view|materialized\s+view|schema|type)\b[^;]*?\brename\s+(?!constraint\b)/,
  },
  // "before truncate on t" and "delete or truncate on t" are trigger definitions, not a TRUNCATE.
  { label: 'TRUNCATE', test: /\btruncate\b(?!\s+(?:on|or)\b)/ },
  { label: 'DELETE FROM', test: /\bdelete\s+from\b/ },
  { label: 'ALTER COLUMN ... TYPE', test: /\balter\s+(?:column\s+)?(?:"[^"]+"|\w+)\s+(?:set\s+data\s+)?type\b/ },
  { label: 'ALTER COLUMN ... SET NOT NULL', test: /\balter\s+(?:column\s+)?(?:"[^"]+"|\w+)\s+set\s+not\s+null\b/ },
]

const norm = (p) => String(p).replace(/\\/g, '/')
const inDir = (p) => norm(p).startsWith(DIR)

/** Removes `--` and block comments but leaves string literals alone (a `--` inside quotes is not a comment). */
export function stripComments(sql) {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === "'" ? m : ' '))
}

/** The destructive things a migration does, as labels (empty when there are none). */
export function findContractRisks(sql) {
  const code = stripComments(sql).toLowerCase().replace(/\s+/g, ' ')
  const labels = CONTRACT_RULES.filter((rule) => rule.test.test(code)).map((rule) => rule.label)
  return [...new Set(labels)]
}

/** True when the file has a line `-- contract: <reason>`. */
export function hasContractLine(sql) {
  return CONTRACT_LINE.test(sql)
}

/**
 * Checks what a pull request does to db/migrations and returns the problems as readable strings (none: all good).
 * @param changes  from parseNameStatus: [{ status: 'A'|'M'|'D'|'R'|'C'|'T', path, oldPath? }]
 * @param sqlByPath  the contents of every new file, by path
 * @param existing  the migration files that exist before the pull request (paths or names)
 */
export function checkMigrations(changes, sqlByPath = {}, existing = []) {
  const problems = []
  const added = []

  for (const change of changes) {
    const file = norm(change.path)
    const oldFile = change.oldPath === undefined ? undefined : norm(change.oldPath)
    if (change.status === 'R') {
      if (inDir(oldFile)) problems.push(`${oldFile}: an existing migration must never be renamed or moved (it became ${file})`)
      else if (inDir(file)) added.push(file)
    } else if (change.status === 'C') {
      if (inDir(file)) added.push(file)
    } else if (!inDir(file)) {
      continue
    } else if (change.status === 'A') {
      added.push(file)
    } else if (change.status === 'D') {
      problems.push(`${file}: an existing migration must never be deleted (a migration that has run is history)`)
    } else {
      problems.push(`${file}: an existing migration must never be modified (a migration that has run is history: add a new file instead)`)
    }
  }

  const numbers = existing.map((p) => NAME.exec(path.posix.basename(norm(p)))).filter(Boolean).map((m) => Number(m[1]))
  let next = (numbers.length ? Math.max(...numbers) : 0) + 1

  for (const file of added.sort()) {
    const name = path.posix.basename(file)
    const match = NAME.exec(name)
    if (!match || path.posix.dirname(file) + '/' !== DIR) {
      problems.push(`${file}: a new migration must be named NNN_snake_case.sql in ${DIR} (three digits, lower case, for example 006_add_notes.sql)`)
      continue
    }
    const number = Number(match[1])
    if (number !== next) {
      problems.push(`${file}: the number is ${match[1]} but the next one must be ${String(next).padStart(3, '0')} (no gaps, no repeats)`)
    }
    next = number === next ? next + 1 : Math.max(next, number + 1)

    const sql = sqlByPath[file]
    if (sql === undefined) {
      problems.push(`${file}: the contents of the new file could not be read`)
      continue
    }
    const risks = findContractRisks(sql)
    if (risks.length && !hasContractLine(sql)) {
      problems.push(
        `${file}: contains ${risks.join(', ')} and has no "-- contract: <reason>" line. Old deployments still serve traffic while the new one builds: ` +
          'expand first, contract in a later release, and say here why it is safe now.',
      )
    }
  }

  return problems
}

function main() {
  const base = argValue(process.argv.slice(2), '--base')
  if (!isSafeRef(base)) {
    console.error('Usage: node scripts/check-migrations.mjs --base <ref>   (for example origin/master)')
    process.exit(2)
  }
  let changes
  let sqlByPath = {}
  let existing
  try {
    changes = parseNameStatus(runGit(['diff', '--name-status', '-z', `${base}...HEAD`, '--', 'db/migrations']))
    for (const change of changes) {
      if (['A', 'R', 'C'].includes(change.status) && inDir(change.path)) {
        sqlByPath[norm(change.path)] = runGit(['show', `HEAD:${change.path}`])
      }
    }
    const mergeBase = runGit(['merge-base', base, 'HEAD']).trim()
    existing = splitNul(runGit(['ls-tree', '-r', '-z', '--name-only', mergeBase, '--', 'db/migrations']))
  } catch (err) {
    console.error(`Could not read the migrations from git (base ${base}): ${String(err.stderr || err.message).trim()}`)
    process.exit(2)
  }

  const problems = checkMigrations(changes, sqlByPath, existing)
  if (problems.length) {
    console.error(`Migration check failed (${problems.length}):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  const count = Object.keys(sqlByPath).length
  console.log(`Migrations OK against ${base} (${count} new file${count === 1 ? '' : 's'}, ${changes.length} change${changes.length === 1 ? '' : 's'}).`)
}

if (isMain(import.meta.url)) main()
