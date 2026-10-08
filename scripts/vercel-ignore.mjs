// Vercel's "Ignored Build Step" (the `ignoreCommand` of vercel.json): decides whether a commit is deployed at all.
// Vercel runs it in the clone of the commit, before `npm ci`, so it uses Node built-ins only. Exit 0 skips the
// deployment; any other exit, a crash included, builds.
//
// Why: the build id in the JavaScript is the commit (vite.config.js), so every deployment is a new version that every
// installed phone downloads (about 180 KB) and announces with the update banner. A merge that changes only documents,
// tests or CI changes nothing that reaches a phone or the server, so it is not deployed: production keeps the previous
// deployment until the next merge that changes the app (AGENTS.md, "Database and API changes").
//
// The rule is one-sided on purpose. The commit is compared with the commit that production serves right now, as its own
// GET /api/health says (`commit`, 7 characters), on the project's production domain (VERCEL_PROJECT_PRODUCTION_URL).
// Never with the parent commit, and never with VERCEL_GIT_PREVIOUS_SHA: that is the last successful deployment of the
// branch, which can be a preview made from the dashboard, and a preview never migrates. So a merge after a failed or a
// rolled-back deployment deploys everything that production does not have. The deployment is skipped only when every
// changed file is on the list below; anything else builds: a file that is not on the list, a migration, a build that is
// not production, a production that does not answer or names no commit, a commit that git cannot find in Vercel's
// shallow clone, a git error. What is printed is the decision, a reason and file names.
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
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/**
 * The commit that production serves now: the `commit` of GET https://<VERCEL_PROJECT_PRODUCTION_URL>/api/health, the
 * public answer of the running production function (server/health.js). Null when it cannot be known: no or an odd
 * domain, no answer within 5 seconds, a redirect, an error status, or no commit in the answer.
 */
export async function productionCommit(env, fetchImpl = fetch) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL
  if (typeof host !== 'string' || !HOST.test(host)) return null
  try {
    const response = await fetchImpl(`https://${host}/api/health`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const body = await response.json()
    return typeof body?.commit === 'string' && SHA.test(body.commit) ? body.commit : null
  } catch {
    return null
  }
}

/**
 * Decides whether to build. `env` is the build's environment, `git` runs git with an argument list and returns what it
 * printed (it throws on an error), `production` is the commit that production serves (productionCommit) or null.
 * Returns { build, reason, files }.
 */
export function decide(env, git, production) {
  const build = (reason, files = []) => ({ build: true, reason, files })
  if (env.VERCEL_ENV !== 'production') return build('not a production build')
  const current = env.VERCEL_GIT_COMMIT_SHA
  if (!SHA.test(current ?? '')) return build('no commit to deploy')
  if (typeof production !== 'string' || !SHA.test(production)) return build('the commit that production serves is not known')
  if (current.startsWith(production)) return build('the commit that production already serves')

  const diff = () => parseNameStatus(git(['diff', '--name-status', '-z', '--no-renames', production, current]))
  let changes
  try {
    changes = diff()
  } catch {
    // Vercel clones about ten commits deep: production can be older than that. Fetch more history once.
    try {
      git(['fetch', '--quiet', '--deepen=200', 'origin'])
      changes = diff()
    } catch {
      return build('git cannot compare the commit with the one that production serves')
    }
  }
  const files = changes.map((change) => change.path)
  if (files.length === 0) return build('no changed files')
  const deployable = files.filter((file) => !isSkippable(file))
  if (deployable.length > 0) return build('files that reach the app or the server changed', deployable)
  return { build: false, reason: 'only documents, tests or CI changed', files }
}

if (isMain(import.meta.url)) {
  const production = process.env.VERCEL_ENV === 'production' ? await productionCommit(process.env) : null
  const decision = decide(process.env, runGit, production)
  const shown = decision.files.slice(0, 10).join(', ')
  const more = decision.files.length > 10 ? ` and ${decision.files.length - 10} more` : ''
  console.log(
    `vercel-ignore: ${decision.build ? 'build' : 'skip'}, ${decision.reason}${shown ? ` (${shown}${more})` : ''}`,
  )
  process.exitCode = decision.build ? 1 : 0
}
