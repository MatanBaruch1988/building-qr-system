// The settings of an end-to-end run (scripts/e2e-config.mjs): the two ports and the scratch schema, read from E2E_APP_PORT,
// E2E_API_PORT and E2E_SCHEMA so that two runs can share a machine. No browser and no database: the config, the teardown and
// the seed are checked for what they would start, or for what they refuse before they start anything.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_API_PORT,
  DEFAULT_APP_PORT,
  DEFAULT_SCHEMA,
  assertScratchSchema,
  e2eSettings,
  parseE2eSchema,
  parsePort,
  runPaths,
} from '../scripts/e2e-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('the defaults are the values every run had before', () => {
  it('are 3100, 3101 and e2e, and an empty environment gives them', () => {
    expect([DEFAULT_APP_PORT, DEFAULT_API_PORT, DEFAULT_SCHEMA]).toEqual([3100, 3101, 'e2e'])
    expect(e2eSettings({})).toEqual({
      appPort: 3100,
      apiPort: 3101,
      schema: 'e2e',
      paths: { buildDir: 'dist', outputDir: 'test-results', reportDir: 'playwright-report' },
    })
  })

  it('treat a variable that is set but empty as not set', () => {
    expect(e2eSettings({ E2E_APP_PORT: '', E2E_API_PORT: '', E2E_SCHEMA: '' })).toEqual(e2eSettings({}))
  })
})

describe('the three variables', () => {
  it('are read as they are given', () => {
    const settings = e2eSettings({ E2E_APP_PORT: '3200', E2E_API_PORT: '3201', E2E_SCHEMA: 'e2e_b' })
    expect([settings.appPort, settings.apiPort, settings.schema]).toEqual([3200, 3201, 'e2e_b'])
  })

  it('are independent: one can be set without the others', () => {
    expect(e2eSettings({ E2E_SCHEMA: 'e2e_b' })).toMatchObject({ appPort: 3100, apiPort: 3101, schema: 'e2e_b' })
    expect(e2eSettings({ E2E_APP_PORT: '3200' })).toMatchObject({ appPort: 3200, apiPort: 3101, schema: 'e2e' })
  })

  it('refuse the same port for the app and the API', () => {
    expect(() => e2eSettings({ E2E_APP_PORT: '3300', E2E_API_PORT: '3300' })).toThrow(/must differ/)
    expect(() => e2eSettings({ E2E_APP_PORT: '3101' })).toThrow(/must differ/)
  })
})

describe('a schema name', () => {
  const valid = ['e2e', 'e2e_b', 'a', 'run2', 'x_1_y', 'a' + 'b'.repeat(30)]
  it.each(valid)('%s is accepted', (name) => {
    expect(parseE2eSchema(name)).toBe(name)
    expect(assertScratchSchema(name)).toBe(name)
  })

  const badShape = [
    'E2E', // upper case
    'e2e-b', // a hyphen
    'e2e b', // a space
    '1e2e', // starts with a digit
    '_e2e', // starts with _
    'a' + 'b'.repeat(31), // 32 characters
    'e2e\n', // a line break at the end
    'e2e"; drop schema public cascade; --', // SQL
    'e2e;', // a command separator
    'e2e.b',
    '../e2e', // a path
    'schéma',
    'אבג',
  ]
  it.each(badShape)('%j is refused for its shape', (name) => {
    expect(() => parseE2eSchema(name)).toThrow(/E2E_SCHEMA .* is not a valid scratch schema name/)
    expect(() => assertScratchSchema(name)).toThrow(/is not a valid scratch schema name/)
  })

  it.each(['public', 'dev_ui', 'neon_auth'])('%s is never the schema of an E2E run', (name) => {
    expect(() => parseE2eSchema(name)).toThrow(new RegExp(`E2E_SCHEMA "${name}" is refused`))
    expect(() => e2eSettings({ E2E_SCHEMA: name })).toThrow(/is refused/)
  })

  it('is checked by the seed too: public and neon_auth are refused, dev_ui (its own default) is not', () => {
    expect(() => assertScratchSchema('public')).toThrow(/"public" is refused/)
    expect(() => assertScratchSchema('neon_auth')).toThrow(/"neon_auth" is refused/)
    expect(assertScratchSchema('dev_ui')).toBe('dev_ui')
  })

  it('that is not a string is refused', () => {
    for (const value of [undefined, null, 3, {}, ['e2e']]) expect(() => assertScratchSchema(value)).toThrow(/not a valid scratch schema name/)
  })
})

describe('a port', () => {
  it.each([['1024', 1024], ['3200', 3200], ['65535', 65535]])('%s is accepted', (value, port) => {
    expect(parsePort('E2E_APP_PORT', value, 1)).toBe(port)
  })

  it.each(['abc', '0', '80', '1023', '65536', '99999', '123456', '3100.5', '-3100', '+3200', ' 3200', '3200 ', '0x0c80', '3e3'])(
    '%j is refused',
    (value) => {
      expect(() => parsePort('E2E_APP_PORT', value, 1)).toThrow(/E2E_APP_PORT .* is not a valid port/)
    },
  )
})

describe('the folders of a run', () => {
  it('are the usual ones for the default schema, so CI finds its report and traces', () => {
    expect(runPaths('e2e')).toEqual({ buildDir: 'dist', outputDir: 'test-results', reportDir: 'playwright-report' })
  })

  it('belong to the schema of any other run, under node_modules/.cache, so two runs do not share a build or a report', () => {
    const b = runPaths('e2e_b')
    const c = runPaths('e2e_c')
    expect(b.buildDir).toBe('node_modules/.cache/bqr-e2e/e2e_b/dist')
    for (const dir of [...Object.values(b), ...Object.values(c)]) expect(dir.startsWith('node_modules/.cache/bqr-e2e/')).toBe(true)
    expect(new Set([...Object.values(b), ...Object.values(c), ...Object.values(runPaths('e2e'))]).size).toBe(9)
  })
})

// ---- the users of the settings ---------------------------------------------------------------------------------

/** Loads playwright.config.js again, as Playwright does, with these variables set (and the others not set). */
async function loadConfig(env = {}) {
  vi.resetModules()
  for (const name of ['E2E_APP_PORT', 'E2E_API_PORT', 'E2E_SCHEMA']) vi.stubEnv(name, env[name] ?? '')
  return (await import('../playwright.config.js')).default
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('node:child_process')
  vi.resetModules()
})

describe('playwright.config.js', () => {
  it('starts what it always started when no variable is set', async () => {
    const config = await loadConfig()
    const [api, preview] = config.webServer
    expect(config.use.baseURL).toBe('http://localhost:3100')
    expect(api.command).toBe('node scripts/dev-seed.mjs e2e --drop && node scripts/dev-seed.mjs e2e && node server/dev.mjs --schema=e2e')
    expect(api.url).toBe('http://localhost:3101/api/public/providers')
    expect(api.env).toMatchObject({ API_PORT: '3101', GOOGLE_CLIENT_ID: '' })
    expect(preview.command).toBe('npm run build && npx vite preview --port 3100 --strictPort')
    expect(preview.url).toBe('http://localhost:3100')
    expect(preview.env).toMatchObject({ API_PORT: '3101' })
    expect(config.outputDir).toBe('test-results')
    expect(config.reporter.at(-1)).toEqual(['html', { open: 'never', outputFolder: 'playwright-report' }])
  })

  it('uses the three variables for the ports, the schema and the folders, and hands them to both servers', async () => {
    const config = await loadConfig({ E2E_APP_PORT: '3200', E2E_API_PORT: '3201', E2E_SCHEMA: 'e2e_b' })
    const [api, preview] = config.webServer
    const build = 'node_modules/.cache/bqr-e2e/e2e_b/dist'
    expect(config.use.baseURL).toBe('http://localhost:3200')
    expect(api.command).toBe('node scripts/dev-seed.mjs e2e_b --drop && node scripts/dev-seed.mjs e2e_b && node server/dev.mjs --schema=e2e_b')
    expect(api.url).toBe('http://localhost:3201/api/public/providers')
    expect(preview.command).toBe(`npm run build -- --outDir ${build} && npx vite preview --port 3200 --strictPort --outDir ${build}`)
    expect(preview.url).toBe('http://localhost:3200')
    for (const server of [api, preview]) {
      expect(server.env).toMatchObject({ API_PORT: '3201', E2E_APP_PORT: '3200', E2E_API_PORT: '3201', E2E_SCHEMA: 'e2e_b' })
      expect(server.reuseExistingServer).toBe(false)
    }
    expect(config.outputDir).toBe('node_modules/.cache/bqr-e2e/e2e_b/test-results')
    expect(config.reporter.at(-1)).toEqual(['html', { open: 'never', outputFolder: 'node_modules/.cache/bqr-e2e/e2e_b/playwright-report' }])
  })

  it('does not load with a schema or a port that is refused', async () => {
    await expect(loadConfig({ E2E_SCHEMA: 'public' })).rejects.toThrow(/E2E_SCHEMA "public" is refused/)
    await expect(loadConfig({ E2E_SCHEMA: 'dev_ui' })).rejects.toThrow(/is refused/)
    await expect(loadConfig({ E2E_APP_PORT: 'x' })).rejects.toThrow(/E2E_APP_PORT/)
  })
})

describe('e2e/global-teardown.js', () => {
  /** Runs the teardown with these variables and returns what it asked Node to run. */
  async function teardownCalls(env) {
    const execFileSync = vi.fn()
    vi.resetModules()
    vi.doMock('node:child_process', () => ({ execFileSync }))
    for (const name of ['E2E_APP_PORT', 'E2E_API_PORT', 'E2E_SCHEMA']) vi.stubEnv(name, env[name] ?? '')
    const { default: teardown } = await import('../e2e/global-teardown.js')
    teardown()
    return execFileSync.mock.calls.map(([, args]) => args)
  }

  it('drops the schema e2e when no variable is set', async () => {
    expect(await teardownCalls({})).toEqual([['scripts/dev-seed.mjs', 'e2e', '--drop']])
  })

  it('drops only the schema of its own run', async () => {
    expect(await teardownCalls({ E2E_SCHEMA: 'e2e_b' })).toEqual([['scripts/dev-seed.mjs', 'e2e_b', '--drop']])
  })

  it('drops nothing for a schema that is refused', async () => {
    await expect(teardownCalls({ E2E_SCHEMA: 'public' })).rejects.toThrow(/is refused/)
  })
})

describe('a refused schema stops a run before anything starts', () => {
  const run = (args, env) =>
    spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 })

  it('Playwright does not even list the tests with E2E_SCHEMA=public, and does with a valid one', () => {
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
    const refused = run([cli, 'test', '--list'], { E2E_SCHEMA: 'public' })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('E2E_SCHEMA "public" is refused')

    const accepted = run([cli, 'test', '--list'], { E2E_SCHEMA: 'e2e_b', E2E_APP_PORT: '3200', E2E_API_PORT: '3201' })
    expect(accepted.status).toBe(0)
    expect(accepted.stdout).toMatch(/Total: \d+ tests in \d+ files/)
  })

  it.each([
    [['public'], /"public" is refused/],
    [['public', '--drop'], /"public" is refused/],
    [['neon_auth', '--drop'], /"neon_auth" is refused/],
    [['E2E', '--drop'], /not a valid scratch schema name/], // it used to fall back to dev_ui, and drop that
    [['e2e', 'e2e_b'], /Expected one schema name/],
  ])('the seed with %j stops with a message, before it connects to a database', (args, message) => {
    const result = run(['scripts/dev-seed.mjs', ...args], { DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(message)
    expect(result.stdout).not.toMatch(/Dropped schema|Scratch schema/)
  })
})
