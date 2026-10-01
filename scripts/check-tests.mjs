// CI guard against weakening the test suite (see .github/workflows/ci.yml, job "guards").
//
// Usage: node scripts/check-tests.mjs --base origin/master      (a JSON array of the PR's labels may be in PR_LABELS)
//
// Why this exists: Kent Beck has pointed out that an AI coding agent sometimes makes a failing run green by deleting
// the test or switching it off instead of fixing the code. A reviewer skimming a large diff can miss that, so the
// pipeline looks for it on every pull request. In the files that the pull request changes under tests/ and e2e/ it
// refuses:
//   - a deleted test file (*.test.* or *.spec.*), including one moved out of tests/ and e2e/;
//   - an added line that focuses a test (`.only(`: the rest of the suite would silently not run);
//   - an added line that skips or disables a test (`.skip`, `.fixme(`, `xit(`, `xdescribe(`, `xtest(`),
//     EXCEPT a conditional skip that says why, the way e2e/fixtures.js does it for the browsers that cannot do
//     something: test.skip(browserName === 'webkit', 'reason ...').
// Lines that are only a comment are ignored. A change that really has to remove or disable a test says why in the pull
// request and carries the label `allow-test-removal`: the problems are then printed as warnings and the check passes.
import { runGit, parseNameStatus, argValue, isSafeRef, isMain } from './ci-git.mjs'

export const OVERRIDE_LABEL = 'allow-test-removal'

const TEST_DIR = /^(?:tests|e2e)\//
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const COMMENT_ONLY = /^(?:\/\/|\/\*|\*)/
const ONLY = /\.only\s*\(/
const SKIP = /\.skip\b|\.fixme\s*\(|\bx(?:it|describe|test)\s*\(/
// test.skip(<a condition>, '<a reason>'): the condition is anything but a bare string or `true` (those would skip
// the test for everyone), the reason is a non-empty string.
const CONDITIONAL_SKIP = /\b(?:test|testInfo)\.skip\s*\(\s*(?!['"`]|true\s*[,)])[^,]+,\s*(['"`])\s*(?!\1)\S/

const norm = (p) => String(p).replace(/\\/g, '/')
const isTestFile = (p) => TEST_DIR.test(norm(p)) && TEST_FILE.test(norm(p))

/**
 * Reads the added lines out of `git diff -U0` output: [{ file, line, text }] with the line number in the new file.
 */
export function parseAddedLines(diffText) {
  const added = []
  let file = null
  let line = 0
  let inHunk = false
  for (const row of String(diffText).split(/\r?\n/)) {
    if (row.startsWith('diff --git ')) {
      inHunk = false
      file = null
    } else if (!inHunk && row.startsWith('+++ ')) {
      const name = row.slice(4).replace(/\t.*$/, '')
      file = name === '/dev/null' ? null : name.replace(/^b\//, '')
    } else if (row.startsWith('@@')) {
      inHunk = true
      line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0)
    } else if (inHunk && row.startsWith('+')) {
      if (file) added.push({ file, line, text: row.slice(1) })
      line++
    }
  }
  return added
}

/** What is wrong with one added line of a test file: a sentence, or null when it is fine. */
export function lineProblem(text) {
  const code = String(text).trim()
  if (!code || COMMENT_ONLY.test(code)) return null
  if (ONLY.test(code)) return 'focuses a test with .only( so the rest of the suite would not run'
  if (SKIP.test(code) && !CONDITIONAL_SKIP.test(code)) {
    return 'skips or disables a test (only a conditional skip that passes a reason is allowed)'
  }
  return null
}

/** The label names from the PR_LABELS value (a JSON array of strings); anything else means no labels. */
export function parseLabels(raw) {
  try {
    const labels = JSON.parse(raw)
    return Array.isArray(labels) ? labels.filter((label) => typeof label === 'string') : []
  } catch {
    return []
  }
}

/**
 * @param changes  from parseNameStatus, for tests/ and e2e/
 * @param addedLines  from parseAddedLines
 * @param labels  the pull request's label names
 * @returns { problems, warnings }: with the override label the same findings come back as warnings
 */
export function checkTests(changes, addedLines, labels = []) {
  const found = []
  for (const change of changes) {
    const file = norm(change.path)
    if (change.status === 'D' && isTestFile(file)) {
      found.push(`${file}: test file deleted`)
    } else if (change.status === 'R' && isTestFile(change.oldPath) && !isTestFile(file)) {
      found.push(`${norm(change.oldPath)}: test file moved out of the tests (now ${file})`)
    }
  }
  for (const { file, line, text } of addedLines) {
    if (!TEST_DIR.test(norm(file))) continue
    const why = lineProblem(text)
    if (why) found.push(`${norm(file)}:${line}: ${why}: ${String(text).trim().slice(0, 100)}`)
  }
  return labels.includes(OVERRIDE_LABEL) ? { problems: [], warnings: found } : { problems: found, warnings: [] }
}

function main() {
  const base = argValue(process.argv.slice(2), '--base')
  if (!isSafeRef(base)) {
    console.error('Usage: node scripts/check-tests.mjs --base <ref>   (for example origin/master)')
    process.exit(2)
  }
  let changes
  let added
  try {
    changes = parseNameStatus(runGit(['diff', '--name-status', `${base}...HEAD`, '--', 'tests', 'e2e']))
    added = parseAddedLines(runGit(['diff', '-U0', '--no-color', '--no-ext-diff', `${base}...HEAD`, '--', 'tests', 'e2e']))
  } catch (err) {
    console.error(`Could not read the test changes from git (base ${base}): ${String(err.stderr || err.message).trim()}`)
    process.exit(2)
  }

  const { problems, warnings } = checkTests(changes, added, parseLabels(process.env.PR_LABELS))
  if (warnings.length) {
    console.warn(`Warning: tests were removed or disabled, allowed by the "${OVERRIDE_LABEL}" label (${warnings.length}):`)
    for (const warning of warnings) console.warn(`  - ${warning}`)
  }
  if (problems.length) {
    console.error(`Test check failed (${problems.length}):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(`Fix the code, not the test. If a test really has to go, say why in the pull request and add the label "${OVERRIDE_LABEL}".`)
    process.exit(1)
  }
  console.log(`Tests OK against ${base} (${changes.length} changed file${changes.length === 1 ? '' : 's'} under tests/ and e2e/).`)
}

if (isMain(import.meta.url)) main()
