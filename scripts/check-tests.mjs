// CI guard against weakening the test suite (see .github/workflows/ci.yml, job "guards").
//
// Usage: node scripts/check-tests.mjs --base origin/master      (a JSON array of the PR's labels may be in PR_LABELS)
//
// Why this exists: Kent Beck has pointed out that an AI coding agent sometimes makes a failing run green by deleting
// the test or switching it off instead of fixing the code. A reviewer skimming a large diff can miss that, so the
// pipeline looks for it on every pull request. In the files that the pull request changes under tests/ and e2e/ it
// refuses:
//   - a deleted test file (*.test.* or *.spec.*), including one moved out of tests/ and e2e/;
//   - a renamed or moved test file whose new path no runner picks up any more (see DISCOVERY below): it still exists,
//     but nothing runs it, which is the same as deleting it;
//   - an added line that focuses a test (`.only(`, or the bracket form `test['only'](`: the rest of the suite would
//     silently not run);
//   - an added line that skips, postpones or disables a test (`.skip`, `.fixme(`, `.todo(`, `xit(`, `xdescribe(`,
//     `xtest(`, or the bracket form `test['skip'](`), EXCEPT a conditional skip that has a real condition and says why,
//     the way e2e/fixtures.js does it for the browsers that cannot do something:
//     test.skip(browserName === 'webkit', 'reason ...'). The condition (the first argument) must not be a literal
//     (`true`, `1`, a string), and the exception covers that one call only: any other skip on the same line is judged on
//     its own.
// Lines that are only a comment are ignored. A change that really has to remove or disable a test says why in the pull
// request and carries the label `allow-test-removal`: the problems are then printed as warnings and the check passes.
//
// This is a heuristic. It reads text, line by line, so it catches accidents and the obvious ways of tampering with the
// tests, not every way (a skip built at run time, a test body emptied out, an assertion weakened). The owner's review of
// the diff is the real gate; a green check does not replace it.
//
// DISCOVERY, so that "no runner picks it up" is decided from the real configuration:
//   - Vitest (vitest.config.js) includes tests/**/*.test.{js,jsx}
//   - Playwright (playwright.config.js) has testDir ./e2e and no testMatch, so its default applies:
//     **/*.@(spec|test).?(c|m)[jt]s?(x) (confirmed in node_modules/playwright/lib/common/index.js)
// A file that either runner picks up counts as picked up. So tests/api.test.js moved to e2e/api.test.js is still found
// (by Playwright, where a Vitest file fails loudly at once), while tests/api.test.js renamed to tests/api.spec.js,
// tests/api.test.mjs or tests/api.js is refused.
import { runGit, parseNameStatus, unquoteGitPath, argValue, isSafeRef, isMain } from './ci-git.mjs'

export const OVERRIDE_LABEL = 'allow-test-removal'

const TEST_DIR = /^(?:tests|e2e)\//
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const VITEST_FILE = /^tests\/(?:.*\/)?[^/]+\.test\.jsx?$/
const PLAYWRIGHT_FILE = /^e2e\/(?:.*\/)?[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/
const COMMENT_ONLY = /^(?:\/\/|\/\*|\*)/
const ONLY = /\.only\s*\(|\[\s*(['"`])only\1\s*\]\s*\(/
// Every way of skipping, postponing or disabling that this guard knows. The match `.skip` alone is checked further for
// the allowed conditional form.
const SKIPPING = /\.skip\b|\.fixme\s*\(|\.todo\s*\(|\bx(?:it|describe|test)\s*\(|\[\s*(['"`])(?:skip|fixme|todo)\1\s*\]\s*\(/g
// What a skip condition must not be: a constant (a literal is a skip for everyone, whatever the browser).
const LITERAL =
  /^(?:true|false|null|undefined|NaN|Infinity|[+-]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|0x[\da-f]+|0b[01]+|0o[0-7]+|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)$/i
// A reason: a string that holds something besides white space.
const REASON = /^(['"`])\s*(?!\1)\S/

const norm = (p) => String(p).replace(/\\/g, '/')
const isTestFile = (p) => TEST_DIR.test(norm(p)) && TEST_FILE.test(norm(p))

/** True when Vitest or Playwright would run a test file at this path (see DISCOVERY above). */
export function isDiscovered(p) {
  return VITEST_FILE.test(norm(p)) || PLAYWRIGHT_FILE.test(norm(p))
}

/**
 * Reads the added lines out of `git diff -U0` output: [{ file, line, text }] with the line number in the new file.
 * Git writes a file name with a tab, a newline or a quote in double quotes with escapes: unquoteGitPath undoes that.
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
      const name = unquoteGitPath(row.slice(4))
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

/** Index just after the string literal that starts at code[start] (or the end of the line when it is not closed). */
function skipString(code, start) {
  const quote = code[start]
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === '\\') i++
    else if (code[i] === quote) return i + 1
  }
  return code.length
}

/**
 * The arguments of the call whose `(` is at code[open]: { args: [{ text, start, end }], closed }. A trailing comma does
 * not make an extra argument. Strings and nested brackets are skipped over, so a comma inside them does not split.
 */
function parseCall(code, open) {
  const args = []
  let depth = 0
  let start = open + 1
  let closed = false
  let i = open + 1
  for (; i < code.length; i++) {
    const ch = code[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i) - 1
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        closed = true
        break
      }
      depth--
    } else if (ch === ',' && depth === 0) {
      args.push({ text: code.slice(start, i), start, end: i })
      start = i + 1
    }
  }
  args.push({ text: code.slice(start, i), start, end: i })
  if (args[args.length - 1].text.trim() === '') args.pop()
  return { args, closed }
}

/** True for a constant such as `true`, `1`, `'always'`, `!0` or `(false)`. */
function isLiteral(text) {
  let value = text.trim()
  while (value.startsWith('!') || (value.startsWith('(') && value.endsWith(')'))) {
    value = (value.startsWith('!') ? value.slice(1) : value.slice(1, -1)).trim()
  }
  return LITERAL.test(value)
}

/**
 * The allowed kind of skip is `test.skip(<condition>, '<reason>')` (or `testInfo.skip`): exactly two arguments, the first
 * not a constant, the second a non-empty string. `skipAt` is the index of the `.skip` in the line. Returns the range of
 * the reason (it is a string, so a `.skip` inside it is only text) or null when this is not the allowed kind.
 */
function conditionalSkipReason(code, skipAt) {
  if (!/(?<![\w$.])(?:test|testInfo)$/.test(code.slice(0, skipAt))) return null
  const open = /^\.skip\s*\(/.exec(code.slice(skipAt))
  if (!open) return null
  const { args } = parseCall(code, skipAt + open[0].length - 1)
  if (args.length !== 2) return null
  const [condition, reason] = args
  if (!condition.text.trim() || isLiteral(condition.text) || !REASON.test(reason.text.trim())) return null
  return { start: reason.start, end: reason.end }
}

/** What is wrong with one added line of a test file: a sentence, or null when it is fine. */
export function lineProblem(text) {
  const code = String(text).trim()
  if (!code || COMMENT_ONLY.test(code)) return null
  if (ONLY.test(code)) return 'focuses a test with .only( so the rest of the suite would not run'
  let reasonRange = null
  for (const match of code.matchAll(SKIPPING)) {
    if (reasonRange && match.index >= reasonRange.start && match.index < reasonRange.end) continue
    const allowed = match[0] === '.skip' ? conditionalSkipReason(code, match.index) : null
    if (!allowed) {
      return 'skips, postpones or disables a test (only a conditional skip with a real condition and a reason is allowed)'
    }
    reasonRange = allowed
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
    } else if (change.status === 'R' && isDiscovered(change.oldPath) && !isDiscovered(file)) {
      found.push(
        `${norm(change.oldPath)}: test file renamed to ${file}, which no test runner picks up (Vitest runs tests/**/*.test.{js,jsx}, Playwright runs e2e/**/*.{spec,test}.js)`,
      )
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
    changes = parseNameStatus(runGit(['diff', '--name-status', '-z', `${base}...HEAD`, '--', 'tests', 'e2e']))
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
