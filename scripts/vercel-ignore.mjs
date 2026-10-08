// Vercel's "Ignored Build Step" (the `ignoreCommand` of vercel.json): decides whether a commit is deployed at all.
// Vercel runs it in the clone of the commit, before `npm ci`, so it uses Node built-ins only. Exit 0 skips the
// deployment; any other exit, a crash included, builds.
//
// Why: the build id in the JavaScript is the commit (vite.config.js), so every deployment is a new version that every
// installed phone downloads (about 180 KB) and announces with the update banner. A merge that changes only documents,
// tests or CI changes nothing that reaches a phone or the server, so it is not deployed: production keeps the previous
// deployment until the next merge that changes the app (AGENTS.md, "Database and API changes").
//
// The rule is one-sided on purpose. The commit is compared with the last commit that Vercel deployed successfully
// (VERCEL_GIT_PREVIOUS_SHA), never with its parent, so a merge after a failed deployment deploys what that one missed.
// The deployment is skipped only when every changed file is on the list below; anything else builds: a file that is not
// on the list, a migration, a build that is not production, no previous deployment to compare with, a commit that git
// cannot find in Vercel's shallow clone, a git error. What is printed is the decision, a reason and file names.
import { runGit, parseNameStatus, isMain } from './ci-git.mjs'

/** Folders whose files never reach the build or the server. */
export const SKIP_DIRS = Object.freeze([
  'docs/',
  'tests/',
  'e2e/',
  '.github/',
  '.claude/',
  'scripts/hooks/',
  'scripts/screenshots/',
  'legacy-redirect/', // a separate Firebase site (legacy-redirect/README.md)
])

/** Files at the root that only the tests, the linters and the editors read. */
export const SKIP_FILES = Object.freeze([
  'LICENSE',
  'eslint.config.js',
  'jsconfig.json',
  'vitest.config.js',
  'playwright.config.js',
  'playwright.screenshots.config.js',
])

/** True when a change to this file can be left undeployed. */
export function isSkippable(file) {
  if (typeof file !== 'string' || file === '') return false
  if (SKIP_DIRS.some((dir) => file.startsWith(dir))) return true
  if (SKIP_FILES.includes(file)) return true
  if (!file.includes('/') && file.endsWith('.md')) return true // README.md, AGENTS.md and the other documents at the root
  if (/^scripts\/check-[^/]+$/.test(file)) return true // the CI guards and their data (scripts/check-*)
  return false
}

const SHA = /^[0-9a-f]{7,40}$/

/**
 * Decides whether to build. `env` is the build's environment, `git` runs git with an argument list and returns what it
 * printed (it throws on an error). Returns { build, reason, files }.
 */
export function decide(env, git) {
  const build = (reason, files = []) => ({ build: true, reason, files })
  if (env.VERCEL_ENV !== 'production') return build('not a production build')
  const current = env.VERCEL_GIT_COMMIT_SHA
  const previous = env.VERCEL_GIT_PREVIOUS_SHA
  if (!SHA.test(current ?? '') || !SHA.test(previous ?? '')) return build('no previous deployment to compare with')
  if (current === previous) return build('the same commit as the last deployment')

  const diff = () => parseNameStatus(git(['diff', '--name-status', '-z', '--no-renames', previous, current]))
  let changes
  try {
    changes = diff()
  } catch {
    // Vercel clones about ten commits deep: the last deployment can be older than that. Fetch more history once.
    try {
      git(['fetch', '--quiet', '--deepen=200', 'origin'])
      changes = diff()
    } catch {
      return build('git cannot compare the commit with the last deployment')
    }
  }
  const files = changes.map((change) => change.path)
  if (files.length === 0) return build('no changed files')
  const deployable = files.filter((file) => !isSkippable(file))
  if (deployable.length > 0) return build('files that reach the app or the server changed', deployable)
  return { build: false, reason: 'only documents, tests or CI changed', files }
}

if (isMain(import.meta.url)) {
  const decision = decide(process.env, runGit)
  const shown = decision.files.slice(0, 10).join(', ')
  const more = decision.files.length > 10 ? ` and ${decision.files.length - 10} more` : ''
  console.log(
    `vercel-ignore: ${decision.build ? 'build' : 'skip'}, ${decision.reason}${shown ? ` (${shown}${more})` : ''}`,
  )
  process.exitCode = decision.build ? 1 : 0
}
