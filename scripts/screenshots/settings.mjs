// What the README screenshots (npm run screenshots) share: where they run, where they go, how big an image may be, and the
// guard that keeps the run on the developer's own machine. Node built-ins and scripts/e2e-config.mjs only, so that the
// Playwright config, the spec, the seed and tests/screenshots.test.js can all import it.

import { DEFAULT_SCHEMA, parseE2eSchema } from '../e2e-config.mjs'

// The run is a Playwright run of its own and reuses the machinery of the E2E run (playwright.config.js reads the three
// settings below as E2E_APP_PORT, E2E_API_PORT and E2E_SCHEMA), with values of its own so that it can run next to a
// development server (3000, 3001), an E2E run (3100, 3101, schema e2e) and a second E2E run (3200, 3201).
export const SCREENSHOTS_APP_PORT = 3300
export const SCREENSHOTS_API_PORT = 3301
export const SCREENSHOTS_SCHEMA = 'screenshots'

/** The folder of the images, from the project root. */
export const SCREENSHOTS_DIR = 'docs/screenshots'

/** The most that one image may weigh, in bytes. The README shows them, and a repository that is cloned by every committee that
 * installs it should not grow by megabytes for pictures. The script fails when an image is bigger, and tests/screenshots.test.js
 * fails when one that is committed is. */
export const MAX_IMAGE_BYTES = 300 * 1024

/** The image types that a README (GitHub's Markdown) shows and that a screenshot can be (Playwright itself writes .png and .jpg). */
export const IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp'])

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/**
 * The schema half of the guard: a scratch schema that is not the one of the E2E run (that run drops its schema before and after
 * it runs, so two runs that share one drop each other's data), and not `public`, `dev_ui` or `neon_auth` (parseE2eSchema refuses
 * those). Returns the name, or throws.
 * @param {string | undefined} schema
 */
export function assertScreenshotsSchema(schema) {
  let name
  try {
    name = parseE2eSchema(schema) // throws for a bad name, public, dev_ui and neon_auth
  } catch (err) {
    // The check is the E2E run's, so its message names E2E_SCHEMA, which is not what the person who ran this did wrong.
    throw new Error(`Refusing to take screenshots: ${String(err.message).replace(/^E2E_SCHEMA /, 'the schema ')}`, { cause: err })
  }
  if (name === DEFAULT_SCHEMA) {
    throw new Error(`Refusing to take screenshots in the schema "${name}": it is the E2E run's, which drops it before and after every run.`)
  }
  return name
}

/**
 * The guard of the run. The screenshots are taken of the fake sample data in a scratch schema, on this machine, and of nothing
 * else. Throws, with a message that says what was wrong, unless
 *  - the address of the app is `http://localhost:<port>` or `http://127.0.0.1:<port>` (never another host, never https), and
 *  - the schema is one that assertScreenshotsSchema accepts.
 * It runs when the config is read, and again in the spec with the address that Playwright really uses.
 * @param {{ baseURL: string | undefined, schema: string | undefined }} where
 */
export function assertLocalScratch({ baseURL, schema }) {
  let url
  try {
    url = new URL(String(baseURL))
  } catch {
    throw new Error(`Refusing to take screenshots: ${JSON.stringify(baseURL)} is not an address. Only http://localhost or http://127.0.0.1 is allowed.`)
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to take screenshots of ${url.protocol}//${url.hostname}: only http://localhost and http://127.0.0.1 are allowed. ` +
        'The screenshots show the fake sample data of a scratch schema on this machine, never a real installation.',
    )
  }
  return { host: url.hostname, schema: assertScreenshotsSchema(schema) }
}
