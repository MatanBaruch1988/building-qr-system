// Vercel's build command (vercel.json "buildCommand"). Nobody runs it by hand: a merge to master is what deploys.
//
// 1. It builds the app exactly as `npm run build` does (`vite build`). A failed build stops here, nothing is migrated.
// 2. It asks productionBuildDecision (server/productionMigrate.js) what to do about the database:
//    - skip: a Vercel preview or development build. The app is built and no database is touched.
//    - migrate: the production build of a commit on master. The database in DATABASE_URL_UNPOOLED is migrated and, on
//      the first deploy of a new installation, marked as production (ADR 0002). Only migrations that are byte-identical
//      to the files on GitHub master are applied (migrateProduction checks that before it applies anything).
//    - refuse: a production build that cannot prove it comes from a merge to master, and any build whose environment is
//      unknown (no VERCEL_ENV: this script is only Vercel's build command, a local build is `npm run build`). The
//      deployment fails, and the deployment that serves now keeps serving. It fails closed on purpose: if Vercel's
//      system variables were ever not exposed to the build, a production build must not skip its migrations and deploy.
//
// Why a gate, and why this one: VERCEL_ENV=production alone proves nothing. Any shell can set it, and a local
// `vercel build --prod` sets it too (Codex showed this in the review of ADR 0005). Vercel sets VERCEL_GIT_COMMIT_REF,
// VERCEL_GIT_COMMIT_SHA and the repository only for a deployment that its Git integration builds, so the gate asks for
// the branch master, a full commit hash and the repository as well. What is left is a deliberate `vercel --prod` from a
// checkout of master: the CLI uploads local files, so the GitHub check above is what keeps an unreviewed migration out
// (the app code of such a deploy is not checked: Deployment Policies would, but they are a Pro feature). That is why
// AGENTS.md and .claude/settings.json forbid it, and why the owner deploys only by merging.
//
// This file does not call loadEnv on purpose: on Vercel the variables come from Vercel, and a local run must not pick up
// .env.local. It prints the gate's decision and three public values (the environment, the branch and the first 7
// characters of the commit), never any other variable. MIGRATION_GITHUB_TOKEN (optional) is read only to let a private
// fork fetch its own migration files from GitHub; it is never printed.
//
// A failed migration is printed through buildFailureText (server/productionMigrate.js): the migration file and the SQLSTATE
// with its condition name, for example `Migration 012_x.sql failed: 23505 (unique_violation)`, and never the message of the
// database, which can quote a row value of production. This log is read by more people than the owner. To read the database's
// own message, run the file against the non-production database with `npm run db:migrate` (docs/runbooks/deploy-and-rollback.md).
import { spawnSync } from 'node:child_process'
import { productionBuildDecision, migrateProduction, buildFailureText } from '../server/productionMigrate.js'

const build = spawnSync('npm run build', { stdio: 'inherit', shell: true })
if (build.status !== 0) process.exit(build.status ?? 1)

const env = process.env
const { action, reason } = productionBuildDecision(env)
const sha = env.VERCEL_GIT_COMMIT_SHA ? env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : '-'
console.log(
  `Deploy gate: ${action} (${reason}). VERCEL_ENV=${env.VERCEL_ENV ?? '-'} ` +
    `VERCEL_GIT_COMMIT_REF=${env.VERCEL_GIT_COMMIT_REF ?? '-'} commit=${sha}`,
)

if (action === 'refuse') {
  console.error(reason)
  process.exit(1)
}

if (action === 'migrate') {
  try {
    await migrateProduction({
      connectionString: env.DATABASE_URL_UNPOOLED,
      repoOwner: env.VERCEL_GIT_REPO_OWNER,
      repoSlug: env.VERCEL_GIT_REPO_SLUG,
      githubToken: env.MIGRATION_GITHUB_TOKEN,
      log: console.log,
    })
  } catch (err) {
    console.error(`Production migration failed: ${buildFailureText(err)}`)
    process.exit(1)
  }
}
