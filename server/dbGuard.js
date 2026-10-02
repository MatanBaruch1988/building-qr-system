// Keeps tests, the dev seed, the local API server and local scripts away from the production database.
//
// Every real database carries a marker: the table public.environment_marker with one row, `production` in the
// production Neon database and `nonprod` in the non-production one. Anything that is not meant to touch production
// asks this guard first (see tests/helpers.js, scripts/dev-seed.mjs, server/dev.mjs, scripts/db-migrate.mjs).
// server/loadEnv.js is the first line of defence (it refuses a .env.local pulled from Vercel production); this is the
// second one, and it looks at the database itself, so it also catches a hand-copied production URL.
//
// A database without the table is not marked, so it is allowed: that is a fresh database and the Postgres container
// that CI starts for every run. Only an explicit `production` row blocks.

// The name is schema-qualified on purpose: the tests and the scratch schemas run with a search_path that points at
// their own schema, and an unqualified name could be hidden by (or resolved to) a table there.
const MARKER_TABLE = 'public.environment_marker'

/**
 * Throws when the database behind `db` (a pg Pool or Client: anything with `.query()`) is marked as production.
 *
 * `allowOnVercelProduction` is for the one caller that must work on production: scripts/db-migrate.mjs, which runs
 * inside the Vercel production build. It only helps when VERCEL_ENV is `production`, and Vercel is the only thing that
 * sets that: loadEnv never takes a VERCEL* key from a file, so a laptop cannot claim it by accident.
 */
export async function assertNotProduction(db, { allowOnVercelProduction = false } = {}) {
  if (allowOnVercelProduction && process.env.VERCEL_ENV === 'production') return

  const { rows: found } = await db.query(`select to_regclass('${MARKER_TABLE}') is not null as present`)
  if (!found[0]?.present) return

  const { rows } = await db.query(`select environment from ${MARKER_TABLE}`)
  if (rows.some((row) => String(row.environment).trim().toLowerCase() === 'production')) {
    throw new Error(
      'This database is production (public.environment_marker says production). Tests, the dev seed and local ' +
        'scripts never run against it: point .env.local at the non-production Neon project (see .env.example).',
    )
  }
}
