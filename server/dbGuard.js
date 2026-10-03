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
//
// There is no switch that lets a caller through on production, and no environment variable is read here: a variable
// such as VERCEL_ENV can be set by anyone's shell (a local `vercel build --prod` sets it too), so it proves nothing.
// Production is migrated by a separate deployment-only entrypoint (scripts/vercel-build.mjs, ADR 0002), not through
// this guard.
// scripts/create-admin.mjs is the one local script that may write to a deployment's database on purpose, so it does
// not call assertNotProduction: it reads the marker with readEnvironmentMarker and shows the person where it writes
// (the marker and maskDatabaseHost, never the full URL).

// The name is schema-qualified on purpose: the tests and the scratch schemas run with a search_path that points at
// their own schema, and an unqualified name could be hidden by (or resolved to) a table there.
export const MARKER_TABLE = 'public.environment_marker'

// The table name is interpolated into SQL (an identifier cannot be a query parameter), so it is checked against this
// pattern first: lower-case letters, digits and _, always schema-qualified. Only the tests pass another table (one
// inside their own throwaway schema, so that they never touch the real marker); everything else uses the default.
const MARKER_TABLE_PATTERN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/

/** Returns `table` when it is a safe, schema-qualified name, and throws for anything else (it fails closed). */
export function markerTableName(table = MARKER_TABLE) {
  if (typeof table !== 'string' || !MARKER_TABLE_PATTERN.test(table)) {
    throw new Error(
      'The environment marker table must be named schema.table with lower-case letters, digits and _ (the default is ' +
        'public.environment_marker, which says whether a database is production)',
    )
  }
  return table
}

/**
 * Reads the marker of the database behind `db` (a pg Pool or Client: anything with `.query()`).
 * Returns `'production'`, `'nonprod'`, or `null` when the table or its row is missing (a database that is not marked).
 * When there are several rows, `production` wins: one production row is enough to call the database production.
 * `table` is the schema-qualified marker table (default `public.environment_marker`).
 */
export async function readEnvironmentMarker(db, table = MARKER_TABLE) {
  const name = markerTableName(table)
  const { rows: found } = await db.query(`select to_regclass('${name}') is not null as present`)
  if (!found[0]?.present) return null

  const { rows } = await db.query(`select environment from ${name}`)
  const values = rows.map((row) => String(row.environment).trim().toLowerCase())
  if (values.includes('production')) return 'production'
  return values.includes('nonprod') ? 'nonprod' : null
}

/**
 * The host of a connection string with its middle masked, safe to print: the first 6 characters of the first label,
 * `****`, then the rest of the domain (`ep-wit****.eu-central-1.aws.neon.tech`). Never returns the user, the password,
 * the path or the query, and returns `unknown host` for anything that is not a URL.
 */
export function maskDatabaseHost(connectionString) {
  let hostname
  try {
    hostname = new URL(String(connectionString)).hostname
  } catch {
    return 'unknown host'
  }
  if (!hostname) return 'unknown host'
  const dot = hostname.indexOf('.')
  const label = dot === -1 ? hostname : hostname.slice(0, dot)
  const rest = dot === -1 ? '' : hostname.slice(dot)
  return label.slice(0, 6) + '****' + rest
}

/**
 * Throws when the database behind `db` is marked as production, whatever the environment variables say.
 * `table` is the marker table (default `public.environment_marker`); a name that is not a valid table name throws too.
 */
export async function assertNotProduction(db, table = MARKER_TABLE) {
  if ((await readEnvironmentMarker(db, table)) === 'production') {
    throw new Error(
      'This database is production (public.environment_marker says production). Tests, the dev seed and local ' +
        'scripts never run against it: point .env.local at the non-production Neon project (see .env.example).',
    )
  }
}
