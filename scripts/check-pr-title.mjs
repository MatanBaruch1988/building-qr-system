// CI guard for the pull request title (see .github/workflows/ci.yml, job "guards", pull requests only).
//
// Usage: PR_TITLE="fix(scan): refuse a point that is too far" node scripts/check-pr-title.mjs
//
// Why this exists: the project merges with "squash", and the pull request title becomes the commit title on master.
// Conventional Commits (type(scope): description) keeps that history readable. The title is read from the PR_TITLE
// environment variable, never pasted into a shell command, because a title is text that anyone can write.
import { isMain } from './ci-git.mjs'

export const TYPES = ['feat', 'fix', 'docs', 'chore', 'refactor', 'perf', 'test', 'build', 'ci', 'style', 'revert']
export const TITLE_PATTERN = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: \\S.*$`)

/** True when the title is a Conventional Commits title. */
export function isValidTitle(title) {
  return typeof title === 'string' && TITLE_PATTERN.test(title)
}

function main() {
  const title = process.env.PR_TITLE
  if (isValidTitle(title)) {
    console.log(`Pull request title OK: ${JSON.stringify(title)}`)
    return
  }
  console.error(`The pull request title does not follow Conventional Commits: ${JSON.stringify(title ?? '')}`)
  console.error('It must look like  type(scope): description  or  type: description  (scope is optional, ! marks a breaking change).')
  console.error(`The types are: ${TYPES.join(', ')}.`)
  console.error('Examples:  feat(admin): export attendance to CSV   |   fix: refuse a scan from too far away   |   ci: add GitHub Actions pipeline')
  process.exit(1)
}

if (isMain(import.meta.url)) main()
