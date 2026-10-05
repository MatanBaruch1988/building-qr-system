import { APP_BUILD_RE } from '../../shared/contract.js'

// The build id of the JavaScript that is running: the first 7 characters of the commit that Vercel built, or 'dev' for a
// build that has none (shared/contract.js, APP_BUILD_RE). vite.config.js writes it into the bundle as
// import.meta.env.VITE_APP_BUILD; both apps show it (src/ui/BuildLabel.jsx). An installed phone keeps running old JavaScript
// for days or weeks, and this is how anybody tells which version that is.

/**
 * `value` when it has the shape of a build id (APP_BUILD_RE), otherwise 'dev': a missing value (Vitest does not read
 * vite.config.js) or one of another shape never reaches a screen.
 * @param {unknown} value
 * @returns {string}
 */
export const appBuildFrom = (value) => (typeof value === 'string' && APP_BUILD_RE.test(value) ? value : 'dev')

/** The build id of this app (see above). */
export const APP_BUILD = appBuildFrom(import.meta.env.VITE_APP_BUILD)
