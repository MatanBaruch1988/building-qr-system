// The production migration: what scripts/vercel-build.mjs runs in the Vercel production build, after the app was built
// (ADR 0002). The pieces are small and take everything they need as arguments, so the tests can run them against a
// throwaway schema. Nothing here reads process.env: the build script passes the environment and the connection string.
import pg from 'pg'
import { normalizeConnectionString, guardPool } from './db.js'
import { migrate } from './migrate.js'
import { MARKER_TABLE, markerTableName, maskDatabaseHost, readEnvironmentMarker } from './dbGuard.js'

// Vercel puts the full commit hash in VERCEL_GIT_COMMIT_SHA for a deployment that it built from Git.
const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * Decides what the build does about the database, from the build environment (the caller passes `process.env`).
 * Returns `{ action: 'migrate' | 'skip' | 'refuse', reason }`:
 * - `skip`: not a Vercel production build (a preview build, a local or a CI build). It builds and never touches a database.
 * - `migrate`: a production build of a commit on master that Vercel's Git integration built (it sets the branch and the
 *   full commit hash only for a deployment triggered from Git).
 * - `refuse`: a production build that does not have that proof. The deployment fails and the current one keeps serving.
 * VERCEL_ENV=production alone proves nothing: any shell can set it, and a local `vercel build --prod` sets it too.
 */
export function productionBuildDecision(env) {
  if (env.VERCEL !== '1') return { action: 'skip', reason: 'not a Vercel build, so no database is touched' }
  if (env.VERCEL_ENV !== 'production') {
    return { action: 'skip', reason: 'not a Vercel production build, so no database is touched' }
  }
  if (env.VERCEL_GIT_COMMIT_REF === 'master' && FULL_SHA.test(env.VERCEL_GIT_COMMIT_SHA ?? '')) {
    return { action: 'migrate', reason: 'a production build of a commit on master, built by the Vercel Git integration' }
  }
  return {
    action: 'refuse',
    reason:
      'A production build needs the Git data of a commit on master (branch master and a full 40-character commit hash). ' +
      'Production is deployed only from a merge to master through the Vercel Git integration, never from a local ' +
      'checkout or the CLI.',
  }
}

// An advisory lock belongs to one session, and a transaction pooler (the -pooler host of Neon) hands the next statement
// to another connection, so the lock would protect nothing.
function hostOf(connectionString) {
  let hostname = ''
  try {
    hostname = new URL(connectionString).hostname
  } catch {
    // the empty host is refused below, the same as a URL without one
  }
  if (!hostname) throw new Error('DATABASE_URL_UNPOOLED is not a valid connection URL')
  return hostname
}

/** Marks the database as production: one transaction, safe to run again. */
async function markProduction(pool, table) {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('begin')
    await client.query(
      `create table if not exists ${table} (environment text primary key check (environment in ('production', 'nonprod')))`,
    )
    await client.query(
      `comment on table ${table} is 'Marks this database as production or nonprod: tests and local scripts refuse a ` +
        `database marked production (server/dbGuard.js). Written by the Vercel production build on its first deploy.'`,
    )
    await client.query(`insert into ${table} (environment) values ('production') on conflict do nothing`)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {
      broken = true
    })
    throw err
  } finally {
    client.release(broken)
  }
}

/**
 * Migrates the database behind `connectionString` and, when it is not marked yet, marks it as production.
 * It refuses a non-production marker. `markerTable` (default public.environment_marker) and `dir` are for the tests,
 * which point them at a table and a folder of their own. Returns the names of the migrations it applied.
 */
export async function migrateProduction({ connectionString, markerTable = MARKER_TABLE, dir, log = () => {} }) {
  // The name is interpolated into SQL below, so it is checked first (see server/dbGuard.js).
  const table = markerTableName(markerTable)
  if (!connectionString) {
    throw new Error('DATABASE_URL_UNPOOLED is not set: the production migration needs the direct connection string of the database')
  }
  if (hostOf(connectionString).includes('-pooler')) {
    throw new Error(
      'DATABASE_URL_UNPOOLED points at a pooled host (-pooler): the migration lock needs a direct connection, a ' +
        'session of its own',
    )
  }

  log(`Production migration target: ${maskDatabaseHost(connectionString)}`)
  const pool = guardPool(
    new pg.Pool({
      connectionString: normalizeConnectionString(connectionString),
      max: 1,
      // A Neon compute that is waking from sleep needs a few seconds to accept the first connection.
      connectionTimeoutMillis: 20_000,
    }),
  )
  try {
    const marker = await readEnvironmentMarker(pool, table)
    if (marker === 'nonprod') {
      throw new Error(
        'This production build points at a non-production database: check the Production environment variables in Vercel',
      )
    }
    log(marker === 'production' ? 'Database marker: production' : 'Database is not marked yet: it is marked production after the migration')

    const applied = await migrate(pool, dir)

    // A new self-hosted deployment has no marker: its first deploy marks it, so that local tooling refuses it from then on.
    if (marker === null) {
      await markProduction(pool, table)
      log('Database marked production')
    }
    log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.')
    return applied
  } finally {
    await pool.end()
  }
}
