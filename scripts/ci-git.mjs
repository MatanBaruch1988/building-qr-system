// Small helpers shared by the CI guard scripts (check-migrations.mjs and check-tests.mjs). Node built-ins only.
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
 * Parses `git diff --name-status` into [{ status, path, oldPath? }]. `status` is the first letter of git's code:
 * A added, M modified, D deleted, T type changed, R renamed or C copied (these two carry oldPath as well).
 */
export function parseNameStatus(text) {
  return String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [code, first, second] = line.split('\t')
      const status = code[0]
      return status === 'R' || status === 'C' ? { status, oldPath: first, path: second } : { status, path: first }
    })
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
