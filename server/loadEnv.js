import fs from 'node:fs'

// `vercel env pull` also writes the platform's own build variables (VERCEL, VERCEL_ENV, TURBO_*, …).
// They describe Vercel's build machines, not this computer, and VERCEL=1 would make local code believe it
// is running in production. Only application settings are loaded.
const PLATFORM_KEYS = /^(VERCEL|TURBO|NX_)/

/** Minimal .env reader for local scripts (Vercel injects env vars itself in production). */
export function loadEnv(files = ['.env.local', '.env']) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!m || PLATFORM_KEYS.test(m[1])) continue
      if (process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  }
}
