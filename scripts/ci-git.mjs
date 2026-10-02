// Small helpers shared by the CI guard scripts (check-migrations.mjs and check-tests.mjs). Node built-ins only.
// Lists of file names are always read from git with -z (NUL separated), never line by line: a file name may hold a tab,
// a newline or a quote, and then a line-based parse would see a different file than the one that changed.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** Runs git and returns what it printed. Non-ASCII file names are printed as they are, not escaped. */
export function runGit(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Parses the output of `git diff --name-status -z` into [{ status, path, oldPath? }]. `status` is the first letter of
 * git's code: A added, M modified, D deleted, T type changed, R renamed or C copied (these two carry oldPath as well).
 * With -z every field ends with a NUL and git does not quote or escape anything, so a file name with a tab, a newline or
 * a quote comes through exactly (a line-based parse would split it). The entries are `status NUL path NUL`, and for a
 * rename or a copy `R100 NUL old NUL new NUL`: three separate fields.
 */
export function parseNameStatus(text) {
  const fields = String(text).split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  const changes = []
  let i = 0
  while (i < fields.length) {
    const status = fields[i][0]
    const withOld = status === 'R' || status === 'C'
    const names = fields.slice(i + 1, i + (withOld ? 3 : 2))
    if (!status || names.length < (withOld ? 2 : 1) || names.some((name) => name === '')) {
      throw new Error(`Unexpected "git diff --name-status -z" output near ${JSON.stringify(fields.slice(i, i + 3))}`)
    }
    changes.push(withOld ? { status, oldPath: names[0], path: names[1] } : { status, path: names[0] })
    i += 1 + names.length
  }
  return changes
}

/** Splits the output of a git command run with -z (for example `ls-tree -z --name-only`) into its entries. */
export function splitNul(text) {
  return String(text)
    .split('\0')
    .filter((entry) => entry !== '')
}

const GIT_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/**
 * Turns a file name as `git diff` writes it in a patch header (the `--- ` and `+++ ` lines) into the real name. Git puts
 * a name with a tab, a newline, a quote, a backslash or another control character in double quotes with C escapes
 * (a tab is backslash t, a byte is a backslash and three octal digits), and -z does not change that for a patch. A name
 * with a space is not quoted, but git adds a TAB after it, which is dropped here.
 */
export function unquoteGitPath(raw) {
  const text = String(raw)
  if (!text.startsWith('"')) return text.replace(/\t.*$/, '')
  const chars = Array.from(text)
  const bytes = []
  for (let i = 1; i < chars.length && chars[i] !== '"'; i++) {
    if (chars[i] !== '\\') {
      bytes.push(...Buffer.from(chars[i], 'utf8'))
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(chars.slice(i + 1, i + 4).join(''))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += octal[0].length
    } else if (chars[i + 1] in GIT_ESCAPES) {
      bytes.push(GIT_ESCAPES[chars[i + 1]])
      i++
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Reads `--name value` or `--name=value` from an argument list. */
export function argValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1)
  }
  return undefined
}

/** A base ref or commit is passed to git as an argument, so it must look like one and never like an option. */
export function isSafeRef(ref) {
  return typeof ref === 'string' && /^[A-Za-z0-9_./~^@{}-]+$/.test(ref) && !ref.startsWith('-')
}

/** True when this module is the file node was started with, so that importing it from a test runs nothing. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl)
}
