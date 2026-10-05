// Removes the scratch schema the end-to-end run created (the seed script refuses to touch the real tables). It is the schema of
// this run, E2E_SCHEMA (see playwright.config.js), so a run never drops the schema of another run.
import { execFileSync } from 'node:child_process'
import { e2eSettings } from '../scripts/e2e-config.mjs'

export default function globalTeardown() {
  const { schema } = e2eSettings()
  execFileSync(process.execPath, ['scripts/dev-seed.mjs', schema, '--drop'], { stdio: 'inherit' })
}
