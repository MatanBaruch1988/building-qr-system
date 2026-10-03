// Vercel's build command (vercel.json "buildCommand"). Nobody runs it by hand: a merge to master is what deploys.
//
// 1. It builds the app exactly as `npm run build` does (`vite build`). A failed build stops here, nothing is migrated.
// 2. It asks productionBuildDecision (server/productionMigrate.js) what to do about the database:
//    - skip: a preview build, a local or a CI build. The app is built and no database is touched.
//    - migrate: the production build of a commit on master. The database in DATABASE_URL_UNPOOLED is migrated and, on
//      the first deploy of a new installation, marked as production (ADR 0002).
//    - refuse: a production build that cannot prove it comes from a merge to master. The deployment fails, and the
//      deployment that serves now keeps serving.
//
// Why a gate, and why this one: VERCEL_ENV=production alone proves nothing. Any shell can set it, and a local
// `vercel build --prod` sets it too (Codex showed this in the review of ADR 0005). Vercel sets VERCEL_GIT_COMMIT_REF and
// VERCEL_GIT_COMMIT_SHA only for a deployment that its Git integration builds, so the gate asks for the branch master and
// a full commit hash as well. What is left is a deliberate `vercel --prod` from a checkout of master. That is why
// AGENTS.md and .claude/settings.json forbid it, and why the owner deploys only by merging.
//
// This file does not call loadEnv on purpose: on Vercel the variables come from Vercel, and a local run must not pick up
// .env.local. It prints the gate's decision and three public values (the environment, the branch and the first 7
// characters of the commit), never any other variable.
import { spawnSync } from 'node:child_process'
import { productionBuildDecision, migrateProduction } from '../server/productionMigrate.js'

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
    await migrateProduction({ connectionString: env.DATABASE_URL_UNPOOLED, log: console.log })
  } catch (err) {
    console.error(`Production migration failed: ${err.message}`)
    process.exit(1)
  }
}
