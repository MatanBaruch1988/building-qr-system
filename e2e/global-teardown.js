// Removes the scratch schema the end-to-end run created (the seed script refuses to touch the real tables).
import { execFileSync } from 'node:child_process'

export default function globalTeardown() {
  execFileSync(process.execPath, ['scripts/dev-seed.mjs', 'e2e', '--drop'], { stdio: 'inherit' })
}
