// The text rules of this project, in one place. Node built-ins only.
//
// Two rules are checked on the text of files:
//   - the em dash (U+2014) is never used, anywhere (see AGENTS.md, "Rules for every change");
//   - a date or time that a person sees is written only by shared/datetime.js (DD/MM/YYYY and HH:MM), so the code in
//     src/, server/ and shared/ must not use another way of writing one.
//
// Two things read these rules, so that they cannot drift apart:
//   - tests/no-em-dash.test.js and tests/dates.test.js, which fail `npm run test:unit` on a violation;
//   - scripts/hooks/check-edit.mjs, the Claude Code hook that tells the agent right after it edits a file.
// To change a rule, change it here. Do not copy a pattern into another file.

// Built from its code point, so that this file does not contain the character either.
export const EM_DASH = String.fromCharCode(0x2014)

// Folders that are not part of the project. .claude is the assistant tooling's own workspace (personal notes and
// settings it writes for itself). playwright-report, test-results and blob-report are what Playwright generates (its
// report is a bundle of its own code).
export const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.vercel', '.claude', 'coverage', 'playwright-report', 'test-results', 'blob-report',
])
// The files that are text of the project. package-lock.json is text, but generated.
export const TEXT = /\.(js|jsx|mjs|cjs|css|html|md|json|sql|txt|yml|yaml)$|^\.env\.example$|^\.gitignore$/
export const SKIP_FILES = new Set(['package-lock.json'])

const norm = (relativePath) => String(relativePath).replace(/\\/g, '/')

/**
 * True when the em dash rule applies to this file: a text file of the project that is not inside a skipped folder.
 * @param relativePath  the path from the project root, with / or \ as the separator
 */
export function isTextFileToCheck(relativePath) {
  const parts = norm(relativePath).split('/').filter(Boolean)
  const name = parts[parts.length - 1]
  if (!name || parts.slice(0, -1).some((dir) => SKIP_DIRS.has(dir))) return false
  return TEXT.test(name) && !SKIP_FILES.has(name)
}

/** The lines of `text` that hold an em dash: [{ line (1-based), text (the trimmed line) }]. */
export function findEmDashLines(text) {
  const found = []
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (line.includes(EM_DASH)) found.push({ line: i + 1, text: line.trim() })
  })
  return found
}

// ---- dates -------------------------------------------------------------------------------------------------------

// The folders (from the project root) where the date rules apply, and the files in them that are code.
export const DATE_RULE_DIRS = ['src', 'server', 'shared']
export const DATE_RULE_FILE = /\.(js|jsx|mjs)$/

// Ways of writing a date or a time that depend on the device or show a month name or a weekday, or a date field that
// shows the device's own format. Each entry is [pattern, description].
export const FORBIDDEN = [
  [/toLocale(Date|Time)?String/, 'toLocaleDateString / toLocaleTimeString / toLocaleString'],
  [/\bdateStyle\b|\btimeStyle\b/, 'dateStyle / timeStyle'],
  [/toDateString|toTimeString|toUTCString/, 'toDateString / toTimeString / toUTCString'],
  [/type=["'](date|time|datetime-local|month|week)["']/, 'a native date or time field'],
  [/\bweekday\s*:|\bmonth\s*:\s*['"](long|short|narrow)/, 'a weekday or a month name'],
]

// Intl.DateTimeFormat is only for shared/datetime.js; server/scans.js also has the API's own machine format
// ('2026-09-30 08:12:00', read by the agent), which is not for people and must not change.
export const INTL_ALLOWED = new Set(['shared/datetime.js', 'server/scans.js'])

/** True when the date rules apply to this file: JavaScript under src/, server/ or shared/. */
export function isDateRuleFile(relativePath) {
  const file = norm(relativePath)
  return DATE_RULE_DIRS.some((dir) => file.startsWith(`${dir}/`)) && DATE_RULE_FILE.test(file)
}

/**
 * The date rules that this file breaks, as short descriptions (none: all good). Comments are not code, so they are
 * removed first. A file the rules do not apply to (see isDateRuleFile) has no problems.
 * @param relativePath  the path from the project root, with / or \ as the separator
 * @param text  the contents of the file
 */
export function findDateProblems(relativePath, text) {
  const file = norm(relativePath)
  if (!isDateRuleFile(file)) return []
  const code = String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const problems = []
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(code)) problems.push(what)
  if (/Intl\.DateTimeFormat/.test(code) && !INTL_ALLOWED.has(file)) problems.push('Intl.DateTimeFormat (use shared/datetime.js)')
  return problems
}
