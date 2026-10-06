// The notes of a GitHub release, written from the titles of the pull requests that were merged since the previous release.
// .github/workflows/release.yml runs this; docs/releases.md says how a release is cut and what the versions mean.
//
// Usage: node scripts/release-notes.mjs --version 2.1.0 [--previous v2.0.0] [--target <commit>] [--out <file>]
//                                       [--repo-url https://github.com/<owner>/<repo>]
//
//   --version    the new version, MAJOR.MINOR.PATCH without the v (required)
//   --previous   the tag to compare with, like v2.0.0. Empty or missing: the newest v* tag that is an ancestor of the target,
//                and no such tag means that this is the first release
//   --target     the commit to release (default HEAD; the workflow passes $GITHUB_SHA)
//   --out        write the notes to this file instead of the standard output
//   --repo-url   the address of the repository, for a local try. Without it the address is GITHUB_SERVER_URL and
//                GITHUB_REPOSITORY, which every GitHub Actions runner sets
//
// What it prints is Markdown: an empty "What installers must do" section for the owner to write, then the merged titles
// grouped as breaking changes, features, fixes and other changes, then a link to the full comparison. The pull requests are
// squash-merged, so the first-parent history of the default branch has one commit, with the pull request title, for each of
// them. A title is text that anyone can write, so it only ends up in a Markdown file that the owner reads before publishing
// (the release is a draft), and `<` is escaped so that a title cannot add HTML. Nothing that was typed into the workflow is
// ever echoed back: an input that fails validation gets a fixed message. Node built-ins only, so there is no `npm ci`.
import fs from 'node:fs'
import { runGit, isSafeRef, isMain } from './ci-git.mjs'
import { isValidTitle } from './check-pr-title.mjs'

// MAJOR.MINOR.PATCH, numbers only and no leading zeros (SemVer), with no v for a version and with one for a tag.
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const USAGE =
  'Usage: node scripts/release-notes.mjs --version 2.1.0 [--previous v2.0.0] [--target <commit>] [--out <file>] [--repo-url https://github.com/<owner>/<repo>]'
const FLAGS = { version: 'version', previous: 'previous', target: 'target', out: 'out', 'repo-url': 'repoUrl' }

export const FIRST_RELEASE_TEXT = 'The first tagged release. The changes before it are in the history of the default branch.'
export const INSTALLERS_HINT =
  '<!-- Write what an installer must do before or after updating, or "Nothing." A major version always has something here. -->'
export const GROUP_TITLES = { breaking: 'Breaking changes', features: 'Features', fixes: 'Fixes', other: 'Other changes' }

/** An error whose message is fixed text written here, never a value that somebody typed: it is safe to print. */
export class ReleaseError extends Error {}

/** -1, 0 or 1: how the version `a` compares with the version `b`, both MAJOR.MINOR.PATCH (BigInt, so no size limit). */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(BigInt)
  const right = String(b).split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/**
 * Checks the version, and the previous tag when there is one (undefined, null and '' mean none). Returns true when there is
 * a previous tag. Throws a ReleaseError, with a message that holds none of the input, for a bad version, a bad tag, or a
 * version that is not greater than the previous one.
 */
export function checkVersions({ version, previous }) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new ReleaseError('The version must look like 2.1.0: three numbers with dots, without a v and without leading zeros.')
  }
  if (previous === undefined || previous === null || previous === '') return false
  if (typeof previous !== 'string' || !TAG_PATTERN.test(previous)) {
    throw new ReleaseError('The previous tag must look like v2.0.0: a v and three numbers with dots.')
  }
  if (compareVersions(version, previous.slice(1)) <= 0) {
    throw new ReleaseError('The version must be greater than the previous tag.')
  }
  return true
}

/**
 * The address of the repository without a trailing slash: https, exactly owner/repo, no credentials, query or fragment.
 * It ends up in Markdown links, so it must not hold anything that could end a link.
 */
export function normalizeRepoUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ReleaseError('The repository address is not a web address.')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)) {
    throw new ReleaseError('The repository address must look like https://github.com/<owner>/<repo>.')
  }
  return `${url.origin}${path}`
}

/** The address of the repository on the runner: GITHUB_SERVER_URL and GITHUB_REPOSITORY. */
export function repoUrlFromEnv(env) {
  const server = env.GITHUB_SERVER_URL
  const repository = env.GITHUB_REPOSITORY
  if (!server || !repository) {
    throw new ReleaseError('Set GITHUB_SERVER_URL and GITHUB_REPOSITORY, or pass --repo-url.')
  }
  return normalizeRepoUrl(`${server.replace(/\/+$/, '')}/${repository}`)
}

/**
 * What a subject is: its Conventional Commit type (null when it is not one) and whether it is a breaking change (a `!`
 * before the colon). The shape check is the one that CI applies to the pull request title (scripts/check-pr-title.mjs).
 */
export function parseSubject(subject) {
  if (!isValidTitle(subject)) return { type: null, breaking: false }
  const header = subject.slice(0, subject.indexOf(': '))
  return { type: /^[a-z]+/.exec(header)[0], breaking: header.endsWith('!') }
}

/**
 * Sorts the subjects into { breaking, features, fixes, other }, each in the order it was given. A breaking change is only
 * in `breaking`, whatever its type. Everything that is not feat or fix, and every subject that is not a Conventional Commit,
 * is in `other`. A blank subject is dropped.
 */
export function groupSubjects(subjects) {
  const groups = { breaking: [], features: [], fixes: [], other: [] }
  for (const raw of subjects ?? []) {
    const subject = String(raw).trim()
    if (subject === '') continue
    const { type, breaking } = parseSubject(subject)
    if (breaking) groups.breaking.push(subject)
    else if (type === 'feat') groups.features.push(subject)
    else if (type === 'fix') groups.fixes.push(subject)
    else groups.other.push(subject)
  }
  return groups
}

/** A subject as one Markdown list item: as written, `<` escaped, and each (#123) a link to that pull request. */
function listItem(subject, repoUrl) {
  const text = subject.replace(/</g, '&lt;').replace(/\(#(\d+)\)/g, (_, number) => `([#${number}](${repoUrl}/pull/${number}))`)
  return `- ${text}`
}

/**
 * The Markdown of the notes. `previous` is the tag to compare with, or empty for the first release (then there are no lists
 * and no comparison, only one sentence). Throws a ReleaseError for a bad version or previous tag, or a version that is not
 * greater than the previous one, or a repoUrl that is not a repository address.
 * @param {{ version: string, previous?: string | null, subjects?: string[], repoUrl: string }} input
 */
export function renderNotes({ version, previous, subjects, repoUrl }) {
  const hasPrevious = checkVersions({ version, previous })
  const base = normalizeRepoUrl(repoUrl)
  const lines = ['## What installers must do', '', INSTALLERS_HINT, '']
  if (!hasPrevious) {
    lines.push(FIRST_RELEASE_TEXT, '')
    return lines.join('\n')
  }
  const groups = groupSubjects(subjects)
  for (const key of Object.keys(GROUP_TITLES)) {
    if (groups[key].length === 0) continue
    lines.push(`## ${GROUP_TITLES[key]}`, '', ...groups[key].map((subject) => listItem(subject, base)), '')
  }
  lines.push(`**Full list of changes:** ${base}/compare/${previous}...v${version}`, '')
  return lines.join('\n')
}

/** Reads `--name value` and `--name=value`. Anything else is refused with the usage line, without echoing it. */
export function parseArgs(argv) {
  const found = {}
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(argv[i])
    if (!match || !Object.hasOwn(FLAGS, match[1])) throw new ReleaseError(`An argument is not known. ${USAGE}`)
    let value = match[2]
    if (value === undefined) {
      i++
      if (i >= argv.length) throw new ReleaseError(`A flag has no value. ${USAGE}`)
      value = argv[i] // the next argument is always the value, whatever it looks like
    }
    const key = FLAGS[match[1]]
    if (Object.hasOwn(found, key)) throw new ReleaseError(`A flag is given twice. ${USAGE}`)
    found[key] = value
  }
  return found
}

/** Runs git, and turns any failure into a ReleaseError with `failure` as its message (git's own text can hold a ref). */
function git(runner, args, failure) {
  try {
    return runner(args)
  } catch {
    throw new ReleaseError(failure)
  }
}

/** True when `error` is what `git describe` says when there is no tag to describe the commit with. */
function isNoTagFound(error) {
  return error?.status === 128 && /No names found|No tags can describe/i.test(String(error.stderr ?? ''))
}

/**
 * The newest v* tag that is an ancestor of `target` (git describe, so the nearest one), or '' when there is none, which
 * means this is the first release. In a shallow clone "none" cannot be trusted (the tags and the history are cut), so that
 * is refused: the workflow checks out with fetch-depth 0.
 */
function findPreviousTag(runner, target) {
  let output
  try {
    output = runner(['describe', '--tags', '--abbrev=0', '--match', 'v*', target])
  } catch (error) {
    if (!isNoTagFound(error)) throw new ReleaseError('Could not look for the previous tag with git describe.')
    const shallow = git(runner, ['rev-parse', '--is-shallow-repository'], 'Could not tell whether the clone is shallow.')
    if (shallow.trim() !== 'false') {
      throw new ReleaseError('This clone is shallow, so its tags and history are incomplete. Fetch the full history (fetch-depth: 0).')
    }
    return ''
  }
  const tag = output.trim()
  if (!TAG_PATTERN.test(tag)) {
    throw new ReleaseError('The newest v* tag before the target is not of the form v1.2.3. Pass the previous tag by hand.')
  }
  return tag
}

/** A previous tag that was given by hand must exist and be an ancestor of the target (it is a tag, not a branch). */
function checkGivenTag(runner, previous, target) {
  git(runner, ['rev-parse', '--verify', '--quiet', `refs/tags/${previous}^{commit}`], 'The previous tag does not exist in this repository.')
  git(runner, ['merge-base', '--is-ancestor', `refs/tags/${previous}`, target], 'The previous tag is not an ancestor of the target.')
}

/**
 * Everything the command line does, without touching the process: the arguments and the environment go in, the notes come
 * out. `runner` runs git (default: runGit of scripts/ci-git.mjs); a test hands in a fake or one that works in another folder.
 * @returns {{ notes: string, out: string | undefined, summary: string }}
 */
export function run({ argv, env = process.env, runner = runGit }) {
  const args = parseArgs(argv)
  const target = args.target ?? 'HEAD'
  if (!isSafeRef(target)) throw new ReleaseError('The target must be a commit or a ref name, nothing else.')
  const version = args.version
  checkVersions({ version, previous: args.previous }) // fails before git is asked anything
  const repoUrl = args.repoUrl !== undefined ? normalizeRepoUrl(args.repoUrl) : repoUrlFromEnv(env)

  git(runner, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`], 'The target is not a commit of this repository.')
  let previous = args.previous ?? ''
  if (previous === '') previous = findPreviousTag(runner, target)
  else checkGivenTag(runner, previous, target)
  checkVersions({ version, previous }) // again: now the previous tag may be the one that git found

  let subjects = []
  if (previous !== '') {
    const range = `refs/tags/${previous}..${target}`
    if (!isSafeRef(range)) throw new ReleaseError('The range to read is not safe.')
    // %s is the subject: one line, which for a squash merge is the pull request title.
    const log = git(runner, ['log', '--first-parent', '--no-show-signature', '--format=%s', range], 'Could not read the history with git log.')
    subjects = log.split(/\r?\n/).filter((subject) => subject.trim() !== '')
    if (subjects.length === 0) throw new ReleaseError('Nothing changed since the previous tag, so there is nothing to release.')
  }
  const notes = renderNotes({ version, previous, subjects, repoUrl })
  const summary = previous === '' ? `Notes for v${version}, the first release.` : `Notes for v${version}: ${subjects.length} change(s) since ${previous}.`
  return { notes, out: args.out, summary }
}

function main() {
  try {
    const { notes, out, summary } = run({ argv: process.argv.slice(2) })
    if (out === undefined) {
      process.stdout.write(notes)
    } else {
      fs.writeFileSync(out, notes)
      console.log(`${summary} Written to ${out}`)
    }
  } catch (error) {
    // A ReleaseError holds fixed text. Anything else is a bug here: its name and code, never its message.
    console.error(error instanceof ReleaseError ? `release-notes: ${error.message}` : `release-notes: failed (${error?.code ?? error?.name ?? 'unknown'})`)
    process.exit(1)
  }
}

if (isMain(import.meta.url)) main()
