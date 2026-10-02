// The Claude Code edit hook (scripts/hooks/check-edit.mjs, wired in .claude/settings.json): runs the real script in a
// child process with the hook JSON on stdin, against a temporary project folder, and reads its exit code and stderr.
// Exit 0 is silence, exit 2 is "this file breaks a rule, fix it now". No database and no network.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const HOOK = path.join(root, 'scripts', 'hooks', 'check-edit.mjs')
// Built from its code point, so that this file does not contain the character either.
const EM_DASH = String.fromCharCode(0x2014)

let project // the temporary project folder (CLAUDE_PROJECT_DIR)
let outside // another temporary folder, not inside the project

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-hook-project-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-hook-outside-'))
  for (const dir of ['src', 'docs', 'tools', 'node_modules/pkg']) fs.mkdirSync(path.join(project, dir), { recursive: true })
})

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

/** Writes a file into a folder (the project by default) and returns its absolute path. */
function write(relative, text, base = project) {
  const file = path.join(base, relative)
  fs.writeFileSync(file, text)
  return file
}

/** Runs the hook the way Claude Code does: the JSON on stdin, CLAUDE_PROJECT_DIR in the environment. */
function runHook(stdin) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    encoding: 'utf8',
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

const edited = (file) => JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file } })

describe('the edit hook: a clean edit', () => {
  it('says nothing and exits 0 for a file that follows the rules', () => {
    const file = write('src/clean.js', "export const answer = 42 // a plain comment - with a regular hyphen\n")
    expect(runHook(edited(file))).toEqual({ code: 0, stdout: '', stderr: '' })
  })
})

describe('the edit hook: the em dash', () => {
  it('exits 2 and names the file and the line', () => {
    const file = write('docs/notes.md', `# Notes\nfirst line is fine\nsecond ${EM_DASH} line is not\nlast line\n`)
    const result = runHook(edited(file))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('docs/notes.md')
    expect(result.stderr).toMatch(/em dash on line 3\b/)
    expect(result.stderr).toMatch(/fix it now/)
  })

  it('lists every line, also in a file with Windows line endings', () => {
    const file = write('docs/crlf.md', `a ${EM_DASH} b\r\nclean\r\nc ${EM_DASH} d\r\n`)
    const result = runHook(edited(file))
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/em dash on lines 1, 3\b/)
  })

  it('applies outside src, server and shared too (a workflow file, for example)', () => {
    const file = write('tools/ci.yml', `name: x ${EM_DASH} y\n`)
    expect(runHook(edited(file)).code).toBe(2)
  })

  it('accepts a path relative to the project folder', () => {
    write('docs/relative.md', `x ${EM_DASH} y\n`)
    expect(runHook(edited(path.join('docs', 'relative.md'))).code).toBe(2)
  })
})

describe('the edit hook: dates', () => {
  it('exits 2 for a device-dependent date in src and names the rule', () => {
    const file = write('src/when.js', 'export const when = (d) => d.toLocaleDateString()\n')
    const result = runHook(edited(file))
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('src/when.js')
    expect(result.stderr).toContain('toLocaleDateString')
    expect(result.stderr).toContain('shared/datetime.js')
  })

  it('applies the date rule to a file under server and shared, too', () => {
    for (const dir of ['server', 'shared']) {
      fs.mkdirSync(path.join(project, dir), { recursive: true })
      const file = write(`${dir}/when.mjs`, 'export const f = new Intl.DateTimeFormat("en")\n')
      expect(runHook(edited(file)).code, dir).toBe(2)
    }
  })

  it('lets the shared date module use Intl.DateTimeFormat', () => {
    const file = write('shared/datetime.js', 'export const f = new Intl.DateTimeFormat("en-GB")\n')
    expect(runHook(edited(file))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('does not check dates in a file outside src, server and shared', () => {
    const file = write('tools/when.js', 'export const when = (d) => d.toLocaleDateString()\n')
    expect(runHook(edited(file))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('ignores a date pattern that is only in a comment', () => {
    const file = write('src/comment.js', '// never call toLocaleDateString here\nexport const ok = 1\n')
    expect(runHook(edited(file)).code).toBe(0)
  })
})

describe('the edit hook: what it leaves alone', () => {
  it('a file that is not text of the project (a .png) exits 0', () => {
    const file = write('src/logo.png', `not really an image ${EM_DASH}\n`)
    expect(runHook(edited(file))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('a file inside a skipped folder (node_modules) exits 0', () => {
    const file = write('node_modules/pkg/readme.md', `third party ${EM_DASH} text\n`)
    expect(runHook(edited(file))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('a file outside the project exits 0', () => {
    const file = write('elsewhere.md', `outside ${EM_DASH} the project\n`, outside)
    expect(runHook(edited(file))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('a file that no longer exists exits 0', () => {
    const file = write('docs/gone.md', `x ${EM_DASH} y\n`)
    fs.rmSync(file)
    expect(runHook(edited(file))).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('empty, malformed or unexpected input exits 0 and never breaks the session', () => {
    for (const input of ['', '   ', 'not json', '{', 'null', '[]', '{}', '{"tool_input":{}}', '{"tool_input":{"file_path":42}}']) {
      expect(runHook(input), JSON.stringify(input)).toEqual({ code: 0, stdout: '', stderr: '' })
    }
  })
})
