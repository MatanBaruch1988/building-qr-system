import fs from 'node:fs'

// `vercel env pull` also writes the platform's own build variables (VERCEL, VERCEL_ENV, TURBO_*, …).
// They describe Vercel's build machines, not this computer, and VERCEL=1 would make local code believe it
// is running in production. Only application settings are loaded.
const PLATFORM_KEYS = /^(VERCEL|TURBO|NX_)/

// A file pulled from the Production environment says so in one of these. Local tooling must never run on
// production data, so such a file is refused instead of being read (see also server/dbGuard.js).
const ENVIRONMENT_KEYS = new Set(['VERCEL_ENV', 'VERCEL_TARGET_ENV'])

const unquote = (value) => value.trim().replace(/^["']|["']$/g, '')

/** Minimal .env reader for local scripts (Vercel injects env vars itself in production). */
export function loadEnv(files = ['.env.local', '.env']) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const entries = []
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!m) continue
      const value = unquote(m[2])
      if (ENVIRONMENT_KEYS.has(m[1]) && value.toLowerCase() === 'production') {
        throw new Error(
          `${file} was pulled from Vercel production (${m[1]}=production). Local tooling, the tests and the dev seed ` +
            'must use a non-production database. Replace the file with a copy of .env.example that points at the ' +
            'non-production Neon project (see the Testing section of AGENTS.md).',
        )
      }
      if (!PLATFORM_KEYS.test(m[1])) entries.push([m[1], value])
    }
    for (const [key, value] of entries) {
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}
