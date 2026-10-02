// Claude Code hook: checks the text rules on a file right after the agent has edited it. Node built-ins only.
//
// It is wired in .claude/settings.json as a PostToolUse hook for Edit, Write and MultiEdit. Claude Code runs it after
// every such edit and sends the tool call as JSON on stdin ({ "tool_input": { "file_path": "<absolute path>" }, ... }).
// The rules are the two text rules of the project (scripts/text-rules.mjs, the same ones tests/no-em-dash.test.js and
// tests/dates.test.js enforce, so a problem is seen at once and not when the unit tests run):
//   - an em dash in any text file of the project;
//   - for JavaScript under src/, server/ and shared/, another way of writing a date than shared/datetime.js.
//
// Exit code 0: nothing to say (the file is fine, outside the project, not a text file, or gone).
// Exit code 2: the file breaks a rule. The message goes to stderr, and Claude Code shows it to the agent. The edit is
// already saved at that point, so the message asks for the fix before the next step.
//
// A hook must never break a session: empty or unreadable input, a missing file or any unexpected error ends with 0.
import fs from 'node:fs'
import path from 'node:path'
import { findEmDashLines, findDateProblems, isTextFileToCheck } from '../text-rules.mjs'

const MAX_BYTES = 5 * 1024 * 1024 // nobody writes a source file this big by hand: skip it instead of reading it

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** The problems of one edited file as a message for the agent, or null when it is fine (or not ours to check). */
function checkFile(filePath, projectDir) {
  const root = fs.realpathSync(projectDir)
  const file = fs.realpathSync(path.resolve(projectDir, filePath)) // throws when the file is gone: caught in main
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null // outside the project
  const name = relative.split(path.sep).join('/')
  if (!isTextFileToCheck(name)) return null
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > MAX_BYTES) return null

  const text = fs.readFileSync(file, 'utf8')
  const problems = []
  const dashes = findEmDashLines(text)
  if (dashes.length) {
    const where = dashes.map((d) => d.line).join(', ')
    problems.push(
      `an em dash on line${dashes.length === 1 ? '' : 's'} ${where}. Never use it: write a comma, a colon, a full stop, ` +
        'parentheses or a regular hyphen instead.',
    )
  }
  for (const what of findDateProblems(name, text)) {
    problems.push(
      `${what}. A date or time that a person sees is written only by shared/datetime.js (DD/MM/YYYY and HH:MM): ` +
        'use its functions.',
    )
  }
  if (!problems.length) return null
  return (
    `${name} breaks a rule of this project (AGENTS.md, "Rules for every change"). The edit is already saved: ` +
    `fix it now, before you do anything else.\n${problems.map((p) => `  - ${p}`).join('\n')}\n`
  )
}

function main() {
  try {
    const input = JSON.parse(readStdin())
    const filePath = input?.tool_input?.file_path
    if (typeof filePath !== 'string' || !filePath) return 0
    const message = checkFile(filePath, process.env.CLAUDE_PROJECT_DIR || process.cwd())
    if (!message) return 0
    process.stderr.write(message)
    return 2
  } catch {
    return 0
  }
}

process.exitCode = main()
