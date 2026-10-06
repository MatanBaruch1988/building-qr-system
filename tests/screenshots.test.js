// The screenshots of the README (npm run screenshots, docs/screenshots/README.md). No browser and no database: the committed
// images are checked for their size and their type, the run is checked for being kept out of the E2E run (so CI never takes
// pictures), and the guard that keeps the run on this machine and in a scratch schema is checked for what it refuses.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  SCREENSHOTS_API_PORT,
  SCREENSHOTS_APP_PORT,
  SCREENSHOTS_DIR,
  SCREENSHOTS_SCHEMA,
  assertLocalScratch,
  assertScreenshotsSchema,
} from '../scripts/screenshots/settings.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const imagesDir = path.join(root, SCREENSHOTS_DIR)

// ---- the images ------------------------------------------------------------------------------------------------

// What the first bytes of each type look like, so that a file called .png that is something else is caught.
const SIGNATURES = {
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  '.jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}

const entries = fs.readdirSync(imagesDir)
const images = entries.filter((name) => name !== 'README.md')

describe('the images in docs/screenshots', () => {
  it('are there, next to the README that says what they are', () => {
    expect(entries).toContain('README.md')
    expect(images.length).toBeGreaterThan(0)
  })

  it('know a type for every extension that is allowed', () => {
    expect(Object.keys(SIGNATURES).sort()).toEqual([...IMAGE_EXTENSIONS].sort())
  })

  it.each(images)('%s is an image that the README can show, with a name that a Markdown link can hold', (name) => {
    const extension = path.extname(name)
    expect(IMAGE_EXTENSIONS, `${name}: only ${IMAGE_EXTENSIONS.join(', ')}`).toContain(extension)
    expect(name, 'lower-case words with hyphens, no spaces').toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.[a-z]+$/)
    const bytes = fs.readFileSync(path.join(imagesDir, name))
    expect(SIGNATURES[extension](bytes), `${name} does not start like a ${extension} file`).toBe(true)
  })

  it.each(images)('%s is at most 300 KB', (name) => {
    const { size } = fs.statSync(path.join(imagesDir, name))
    expect(MAX_IMAGE_BYTES).toBe(300 * 1024)
    expect(size, `${name} is ${Math.round(size / 1024)} KB`).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
  })
})

// ---- the run is not an E2E run ---------------------------------------------------------------------------------

const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
/** `playwright test --list` with these arguments, in the project folder: lists the tests without starting a server. */
const list = (...args) =>
  spawnSync(process.execPath, [cli, 'test', '--list', ...args], {
    cwd: root,
    // No variable of an E2E run is passed on: the screenshots set their own, and the E2E config reads its defaults.
    env: { ...process.env, E2E_APP_PORT: '', E2E_API_PORT: '', E2E_SCHEMA: '', CI: '' },
    encoding: 'utf8',
    timeout: 60_000,
  })

describe('the screenshots are not part of the E2E run, so that CI never takes them', () => {
  const screenshotsConfig = 'playwright.screenshots.config.js'

  it('have a config of their own, at the project root and not under e2e/ or tests/', () => {
    expect(fs.existsSync(path.join(root, screenshotsConfig))).toBe(true)
    const source = fs.readFileSync(path.join(root, screenshotsConfig), 'utf8')
    const testDir = /testDir:\s*'([^']+)'/.exec(source)?.[1]
    expect(testDir, 'the config names its testDir').toBeTruthy()
    const where = path.posix.normalize(testDir)
    for (const forbidden of ['e2e', 'tests']) {
      expect(where === forbidden || where.startsWith(`${forbidden}/`) || where.startsWith(`./${forbidden}`), `testDir ${testDir}`).toBe(false)
    }
    expect(fs.existsSync(path.join(root, where)), 'its testDir exists').toBe(true)
  })

  it('are run by npm run screenshots with that config, and npm run test:e2e does not use it', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(scripts.screenshots).toBe(`playwright test --config ${screenshotsConfig}`)
    expect(scripts['test:e2e']).toBe('playwright test')
    expect(scripts.test).not.toContain('screenshots')
  })

  it('are not listed by the E2E config, which reads ./e2e and nothing else', () => {
    const result = list()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/Total: \d+ tests in \d+ files/)
    expect(result.stdout).not.toContain('screenshots.spec')
  })

  it('are listed by their own config: one spec, in a folder that the E2E config does not read', () => {
    const result = list('--config', screenshotsConfig)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('screenshots.spec.mjs')
    expect(result.stdout).toMatch(/Total: \d+ tests in 1 file/)
    expect(result.stdout).not.toMatch(/(?:^|[\\/\s])e2e[\\/]/m) // none of the E2E specs
  })
})

describe('the config of the screenshots', () => {
  // The way tests/e2e-config.test.js loads playwright.config.js: again, as Playwright does, with the variables of an E2E run set
  // to something else on purpose (the screenshots must not take them over).
  async function loadScreenshotsConfig() {
    vi.resetModules()
    vi.stubEnv('E2E_APP_PORT', '3100')
    vi.stubEnv('E2E_API_PORT', '3101')
    vi.stubEnv('E2E_SCHEMA', 'e2e')
    return (await import('../playwright.screenshots.config.js')).default
  }
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('serves its own ports and works in its own schema, whatever an E2E run left in the environment', async () => {
    const config = await loadScreenshotsConfig()
    const [api, preview] = config.webServer
    const build = `node_modules/.cache/bqr-e2e/${SCREENSHOTS_SCHEMA}/dist`
    expect(config.use.baseURL).toBe(`http://localhost:${SCREENSHOTS_APP_PORT}`)
    expect(api.command).toBe(
      `node scripts/dev-seed.mjs ${SCREENSHOTS_SCHEMA} --drop && node scripts/dev-seed.mjs ${SCREENSHOTS_SCHEMA} && node server/dev.mjs --schema=${SCREENSHOTS_SCHEMA}`,
    )
    expect(api.url).toBe(`http://localhost:${SCREENSHOTS_API_PORT}/api/public/providers`)
    expect(preview.command).toBe(`npm run build -- --outDir ${build} && npx vite preview --port ${SCREENSHOTS_APP_PORT} --strictPort --outDir ${build}`)
    for (const server of [api, preview]) expect(server.reuseExistingServer).toBe(false)
    expect(config.testDir).toBe('./scripts/screenshots')
    expect(config.globalTeardown).toBe('./e2e/global-teardown.js') // drops the schema of this run (the schema comes from the environment)
  })

  it('does not share a port, a schema or a build with the default E2E run', () => {
    expect([SCREENSHOTS_APP_PORT, SCREENSHOTS_API_PORT]).not.toContain(3100)
    expect([SCREENSHOTS_APP_PORT, SCREENSHOTS_API_PORT]).not.toContain(3101)
    expect(SCREENSHOTS_SCHEMA).not.toBe('e2e')
  })
})

// ---- the guard -------------------------------------------------------------------------------------------------

describe('the guard of the run', () => {
  it.each(['http://localhost:3300', 'http://127.0.0.1:3300', 'http://localhost'])('lets %s through, with the scratch schema', (baseURL) => {
    expect(assertLocalScratch({ baseURL, schema: 'screenshots' })).toMatchObject({ schema: 'screenshots' })
    expect(assertLocalScratch({ baseURL, schema: 'shots_b' }).schema).toBe('shots_b')
  })

  it.each([
    'https://example.com',
    'http://example.com:3300',
    'https://localhost:3300', // not plain http
    'http://192.168.1.20:3300', // another machine on the network
    'http://0.0.0.0:3300',
    'http://[::1]:3300', // only the two names that the E2E run uses
    'http://localhost.example.com',
    'http://127.0.0.1.example.com',
    'http://example.com#localhost',
    'http://localhost@example.com',
    'localhost:3300', // not an address with a scheme: it would be read as the scheme "localhost"
    '',
    undefined,
  ])('refuses the address %j, and says why', (baseURL) => {
    expect(() => assertLocalScratch({ baseURL, schema: 'screenshots' })).toThrow(/Refusing to take screenshots/)
  })

  it.each(['public', 'neon_auth', 'dev_ui', 'e2e', '', undefined, 'Screenshots', 'shots;', 'a-b', '../x'])(
    'refuses the schema %j on a local address',
    (schema) => {
      expect(() => assertLocalScratch({ baseURL: 'http://localhost:3300', schema })).toThrow()
      expect(() => assertScreenshotsSchema(schema)).toThrow()
    },
  )

  it('names the schema of the E2E run as the reason', () => {
    expect(() => assertScreenshotsSchema('e2e')).toThrow(/"e2e".*E2E run/)
  })

  it('stops the seed of the visits before it connects to a database, for a schema that is refused', () => {
    for (const schema of ['public', 'e2e', 'dev_ui', 'neon_auth']) {
      const result = spawnSync(process.execPath, ['scripts/screenshots/seed-history.mjs', schema], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' },
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(result.status, schema).not.toBe(0)
      expect(result.stderr, schema).toMatch(/is refused|Refusing to take screenshots/)
      expect(result.stdout).not.toMatch(/Added \d+ visits/)
    }
  })
})
