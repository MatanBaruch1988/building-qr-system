// The build id of the app: vite.config.js writes it into the bundle, src/ui/build.js reads it, and both apps show it. An
// installed phone keeps running old JavaScript for days or weeks, so this is how anybody tells which version it has.
// (The screens are tested in tests/components/build-label.test.jsx, the shape in tests/contract.test.js.)
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfigFromFile } from 'vite'
import { APP_BUILD_RE } from '../shared/contract.js'
import { appBuildFrom } from '../src/ui/build.js'
import { commit } from '../server/health.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHA = '0123456789abcdef0123456789abcdef01234567'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('appBuildFrom (src/ui/build.js)', () => {
  it('passes a build id: 7 characters of a commit, or dev', () => {
    expect(appBuildFrom('abc1234')).toBe('abc1234')
    expect(appBuildFrom('0123456')).toBe('0123456')
    expect(appBuildFrom('dev')).toBe('dev')
  })

  it('answers dev for anything that is not a build id, so that nothing odd reaches a screen', () => {
    for (const value of [undefined, null, '', 'ABC1234', 'abc123', 'abc12345', 'abcdefg', ' abc1234', 'abc1234\n', 'Dev', 'development', 7, {}, ['abc1234']]) {
      expect(appBuildFrom(value), JSON.stringify(value)).toBe('dev')
    }
  })

  it('accepts exactly what the pattern of the contract accepts', () => {
    for (const value of ['abc1234', 'dev', 'abc123', 'ABC1234', 'x']) {
      expect(appBuildFrom(value) === value, value).toBe(APP_BUILD_RE.test(value))
    }
  })
})

describe('APP_BUILD (src/ui/build.js)', () => {
  const load = async () => (await import('../src/ui/build.js')).APP_BUILD

  it('is dev in a unit test: Vitest does not read vite.config.js, so nothing is defined', async () => {
    expect(await load()).toBe('dev')
  })

  it('is the defined value when it is a build id', async () => {
    vi.stubEnv('VITE_APP_BUILD', 'abc1234')
    vi.resetModules()
    expect(await load()).toBe('abc1234')
  })

  it('is dev when the defined value is not a build id', async () => {
    vi.stubEnv('VITE_APP_BUILD', 'not-a-build')
    vi.resetModules()
    expect(await load()).toBe('dev')
  })
})

describe('vite.config.js defines the build id', () => {
  const KEY = 'import.meta.env.VITE_APP_BUILD'
  const defined = async () => {
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, `${ROOT}vite.config.js`, ROOT, 'silent')
    return JSON.parse(loaded.config.define[KEY])
  }

  it('is the first 7 characters of the commit that Vercel builds', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    expect(await defined()).toBe('0123456')
  })

  it('is the same 7 characters that the server reports as its own commit (GET /api/health)', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    expect(await defined()).toBe(commit())
  })

  it('is a build id that the app accepts', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA)
    const id = await defined()
    expect(APP_BUILD_RE.test(id)).toBe(true)
    expect(appBuildFrom(id)).toBe(id)
  })

  it('is dev when there is no commit (a local build, the E2E tests), also when the variable is empty', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined)
    expect(await defined()).toBe('dev')
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
    expect(await defined()).toBe('dev')
  })
})

describe('the build line is quiet, and stays on a colour that is held to AA', () => {
  const css = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (text, selector) => text.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  it('uses the third text colour (tests/contrast.test.js checks it on every surface in both themes) and a small size', () => {
    const body = rule(css('../src/ui/ui.css'), '.w-build')
    expect(body).toContain('color: var(--w-text-3)')
    expect(body).toMatch(/font-size:\s*0\.8125rem/)
  })

  it('is never hidden on a phone or on a computer', () => {
    for (const [file, selector] of [['../src/ui/ui.css', '.w-build'], ['../src/ui/ui.css', '.w-build--center'], ['../src/admin/admin.css', '.a-build']]) {
      const body = rule(css(file), selector)
      expect(body, selector).not.toBe('')
      expect(body, selector).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:/)
    }
    // no media query hides it either
    for (const file of ['../src/ui/ui.css', '../src/admin/admin.css']) expect(css(file)).not.toMatch(/@media[^{]*\{[^}]*\.(?:w|a)-build[^}]*display:\s*none/)
  })
})
