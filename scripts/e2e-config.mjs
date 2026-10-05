// The settings of one end-to-end run: the port of the app (the preview of the production build), the port of the API and the
// scratch schema the run works in. They come from E2E_APP_PORT, E2E_API_PORT and E2E_SCHEMA, and the defaults are the values
// that every run had before (3100, 3101 and "e2e"), so CI and every existing command are unchanged. Node built-ins only:
// playwright.config.js, e2e/global-teardown.js, the seed (scripts/dev-seed.mjs) and tests/e2e-config.test.js all import this
// file, so the rules for a schema name live here and nowhere else.
//
// A schema name goes into SQL as an identifier (`drop schema ... cascade`), and an identifier cannot be a query parameter.
// That is why it is checked against a fixed shape first, and why a few names are refused whatever their shape.

export const DEFAULT_APP_PORT = 3100 // away from the development servers (3000 and 3001), so both can run at the same time
export const DEFAULT_API_PORT = 3101
export const DEFAULT_SCHEMA = 'e2e'

// A lower-case letter first, then lower-case letters, digits or _, at most 31 characters (a run's name also becomes the name
// of a folder, and Postgres cuts an identifier at 63 characters).
const SCHEMA_SHAPE = /^[a-z][a-z0-9_]{0,30}$/

// Names that a scratch schema must never have, and why. The seed refuses the first two (it creates and drops its schema);
// an E2E run also refuses the third, because it drops its schema before and after every run and `dev_ui` is the developer's
// own scratch data (npm run db:seed-dev).
const NEVER_SCRATCH = { public: 'it holds the real tables', neon_auth: "it is Neon Auth's own schema" }
const NEVER_E2E = { ...NEVER_SCRATCH, dev_ui: "it is the developer's scratch data (npm run db:seed-dev)" }

function checkSchema(name, label, refused) {
  const shown = typeof name === 'string' ? JSON.stringify(name) : String(name)
  if (typeof name !== 'string' || !SCHEMA_SHAPE.test(name)) {
    throw new Error(
      `${label} ${shown} is not a valid scratch schema name: a lower-case letter first, then lower-case letters, digits ` +
        'or _, 31 characters at most.',
    )
  }
  if (Object.hasOwn(refused, name)) {
    throw new Error(`${label} "${name}" is refused: ${refused[name]}, so it can never be a scratch schema.`)
  }
  return name
}

/**
 * The check of the seed (scripts/dev-seed.mjs), for the schema it creates, fills or drops. Returns the name, or throws.
 * @param {unknown} name
 */
export function assertScratchSchema(name) {
  return checkSchema(name, 'Schema', NEVER_SCRATCH)
}

/**
 * The schema of an E2E run, from the value of E2E_SCHEMA: the default when the variable is not set (or empty), the name when
 * it is a valid scratch schema that is not `public`, `dev_ui` or `neon_auth`, and an error for anything else.
 * @param {string | undefined} value
 */
export function parseE2eSchema(value) {
  if (value === undefined || value === '') return DEFAULT_SCHEMA
  return checkSchema(value, 'E2E_SCHEMA', NEVER_E2E)
}

/**
 * A port from the value of an environment variable: `fallback` when it is not set (or empty), a whole number from 1024 to
 * 65535 when it is one, and an error for anything else.
 * @param {string} name  the variable, for the message
 * @param {string | undefined} value
 * @param {number} fallback
 */
export function parsePort(name, value, fallback) {
  if (value === undefined || value === '') return fallback
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN
  if (!(port >= 1024 && port <= 65535)) {
    throw new Error(`${name} ${JSON.stringify(value)} is not a valid port: a whole number from 1024 to 65535.`)
  }
  return port
}

/**
 * Where one run keeps its own build and its reports. A run with the default schema keeps the places that Playwright and Vite
 * use anyway (`dist`, `test-results`, `playwright-report`: CI uploads the last two). A run with another schema works in
 * node_modules/.cache (which git, ESLint and the text-rule tests already leave alone), in a folder named after its schema, so
 * that two runs in one worktree do not empty each other's build or overwrite each other's reports.
 * @param {string} schema  a name that parseE2eSchema accepted
 */
export function runPaths(schema) {
  if (schema === DEFAULT_SCHEMA) return { buildDir: 'dist', outputDir: 'test-results', reportDir: 'playwright-report' }
  const base = `node_modules/.cache/bqr-e2e/${schema}`
  return { buildDir: `${base}/dist`, outputDir: `${base}/test-results`, reportDir: `${base}/playwright-report` }
}

/**
 * Everything one run needs, read from `env` (the environment of the process by default). Throws, before anything is started,
 * when a value is not valid or when the two ports are the same.
 * @param {Record<string, string | undefined>} [env]
 */
export function e2eSettings(env = process.env) {
  const appPort = parsePort('E2E_APP_PORT', env.E2E_APP_PORT, DEFAULT_APP_PORT)
  const apiPort = parsePort('E2E_API_PORT', env.E2E_API_PORT, DEFAULT_API_PORT)
  if (appPort === apiPort) throw new Error(`E2E_APP_PORT and E2E_API_PORT must differ (both are ${appPort}).`)
  const schema = parseE2eSchema(env.E2E_SCHEMA)
  return { appPort, apiPort, schema, paths: runPaths(schema) }
}
