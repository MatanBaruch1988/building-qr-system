// scripts/vercel-ignore.mjs, Vercel's "Ignored Build Step": which merges are not deployed. Only its pure functions are
// tested here, with stand-ins for git and for fetch. The rule is one-sided: anything that is not clearly a document, a
// test or CI builds, and so does every case where the script cannot tell.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { decide, isSkippable, productionCommit, SKIP_DIRS, SKIP_FILES } from '../scripts/vercel-ignore.mjs'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
// What `git diff --name-status -z` prints: every field ends with a NUL.
const nul = (...fields) => fields.map((field) => `${field}\0`).join('')
const SERVED = 'aaaaaaa' // what production's GET /api/health names: 7 characters
const CURRENT = 'b'.repeat(40)
const production = {
  VERCEL_ENV: 'production',
  VERCEL_GIT_COMMIT_SHA: CURRENT,
  VERCEL_PROJECT_PRODUCTION_URL: 'building-qr-system.vercel.app',
}

/** A stand-in for git: the diff prints these changes, and every call is recorded. */
function fakeGit(output, { failDiffs = 0, failFetch = false } = {}) {
  const calls = []
  let diffs = 0
  const git = (args) => {
    calls.push(args)
    if (args[0] === 'fetch') {
      if (failFetch) throw new Error('fetch failed')
      return ''
    }
    if (args[0] === 'diff') {
      diffs++
      if (diffs <= failDiffs) throw new Error('bad object')
      return output
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
  return { git, calls }
}

/** A stand-in for fetch that gives one answer (or throws it), and records what it was asked. */
function fakeFetch(answer) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (answer instanceof Error) throw answer
    return answer
  }
  return { fetchImpl, calls }
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('which files can be left undeployed', () => {
  it('skips documents, tests, CI and the tools that only check the code', () => {
    for (const file of [
      'README.md',
      'AGENTS.md',
      'CLAUDE.md',
      'SECURITY.md',
      'docs/install.md',
      'docs/screenshots/committee-points.png',
      'docs/adr/0008-anything.md',
      'tests/api.test.js',
      'tests/components/useLoad.test.jsx',
      'e2e/admin.spec.js',
      '.github/workflows/ci.yml',
      '.github/CODEOWNERS',
      '.github/rulesets/master-gates.json',
      '.claude/settings.json',
      'scripts/check-migrations.mjs',
      'scripts/check-bundle-size.json',
      'scripts/hooks/check-edit.mjs',
      'scripts/screenshots/shoot.spec.js',
      'legacy-redirect/public/index.html',
      'LICENSE',
      'eslint.config.js',
      'jsconfig.json',
      'vitest.config.js',
      'playwright.config.js',
      'playwright.screenshots.config.js',
    ]) {
      expect(isSkippable(file), file).toBe(true)
    }
  })

  it('always deploys the app, the server, the shared code, the migrations, the build and its configuration', () => {
    for (const file of [
      'src/main.jsx',
      'src/admin/MapPicker.jsx',
      'src/README.md', // a document inside the app is not at the root: it could be imported
      'server/router.js',
      'shared/contract.js',
      'db/migrations/013_anything.sql',
      'api/index.js',
      'public/pwa-512x512.svg',
      'public/theme-boot.js',
      'index.html',
      'package.json',
      'package-lock.json',
      'vercel.json',
      'vite.config.js',
      '.nvmrc',
      '.env.example',
      'scripts/vercel-build.mjs',
      'scripts/vercel-ignore.mjs',
      'scripts/ci-git.mjs',
      'scripts/migrate.mjs',
      'scripts/checks/anything.mjs', // only files named check-* directly in scripts/ are guards
      'scripts/check-dir/nested.mjs',
      'docs', // a file named like the folder, without the slash
      'tests',
      '',
    ]) {
      expect(isSkippable(file), file).toBe(false)
    }
  })

  it('lists folders with their slash, so that a file with the same start is not taken for one', () => {
    for (const dir of SKIP_DIRS) expect(dir.endsWith('/'), dir).toBe(true)
    expect(isSkippable('docs-site/index.html')).toBe(false)
    expect(isSkippable('testsuite.js')).toBe(false)
  })

  it('lists root files that exist, so that a renamed file is not skipped by a stale name', () => {
    for (const file of SKIP_FILES) expect(fs.existsSync(`${root}/${file}`), file).toBe(true)
  })
})

describe('the decision', () => {
  it('skips a production merge that changed only documents, tests or CI since the commit that production serves', () => {
    const { git, calls } = fakeGit(nul('M', 'docs/install.md', 'A', 'tests/x.test.js', 'M', '.github/workflows/ci.yml', 'D', 'README.md'))
    const decision = decide(production, git, SERVED)
    expect(decision.build).toBe(false)
    expect(decision.files).toEqual(['docs/install.md', 'tests/x.test.js', '.github/workflows/ci.yml', 'README.md'])
    // compared with what production serves (not the parent, not the branch's last deployment), renames as a delete and an add
    expect(calls).toEqual([['diff', '--name-status', '-z', '--no-renames', SERVED, CURRENT]])
  })

  it('never reads VERCEL_GIT_PREVIOUS_SHA, which can be a preview of the branch that never migrated', () => {
    const preview = 'c'.repeat(40)
    const { git, calls } = fakeGit(nul('M', 'README.md'))
    decide({ ...production, VERCEL_GIT_PREVIOUS_SHA: preview }, git, SERVED)
    expect(calls.flat()).not.toContain(preview)
    expect(fs.readFileSync(`${root}/scripts/vercel-ignore.mjs`, 'utf8')).not.toMatch(/env\.VERCEL_GIT_PREVIOUS_SHA/)
  })

  it('builds when one changed file reaches the app, and names it', () => {
    const { git } = fakeGit(nul('M', 'docs/install.md', 'M', 'src/main.jsx'))
    expect(decide(production, git, SERVED)).toEqual({
      build: true,
      reason: 'files that reach the app or the server changed',
      files: ['src/main.jsx'],
    })
  })

  it('builds for a migration', () => {
    const { git } = fakeGit(nul('M', 'README.md', 'A', 'db/migrations/013_anything.sql'))
    expect(decide(production, git, SERVED).build).toBe(true)
  })

  it('builds for a dependency change', () => {
    const { git } = fakeGit(nul('M', 'package-lock.json'))
    expect(decide(production, git, SERVED).build).toBe(true)
  })

  it('builds when a file moves out of the app into the documents (the delete counts)', () => {
    // --no-renames: git prints the rename as a deleted app file and an added document
    const { git } = fakeGit(nul('D', 'src/admin/notes.js', 'A', 'docs/notes.js'))
    expect(decide(production, git, SERVED).build).toBe(true)
  })

  it('builds anything that is not a production build', () => {
    const { git, calls } = fakeGit(nul('M', 'README.md'))
    for (const VERCEL_ENV of ['preview', 'development', undefined, '']) {
      expect(decide({ ...production, VERCEL_ENV }, git, SERVED).build, String(VERCEL_ENV)).toBe(true)
    }
    expect(calls).toEqual([])
  })

  it('builds when the commit to deploy is missing or does not look like one', () => {
    const { git, calls } = fakeGit(nul('M', 'README.md'))
    for (const VERCEL_GIT_COMMIT_SHA of [undefined, '', '--output=/tmp/x', 'HEAD~1', 'B'.repeat(40)]) {
      expect(decide({ ...production, VERCEL_GIT_COMMIT_SHA }, git, SERVED)).toMatchObject({ build: true, reason: 'no commit to deploy' })
    }
    expect(calls).toEqual([])
  })

  it('builds when the commit that production serves is not known or does not look like one', () => {
    const { git, calls } = fakeGit(nul('M', 'README.md'))
    for (const served of [null, undefined, '', 'dev', '--output=/tmp/x', 'HEAD~1', 'AAAAAAA', 'abc']) {
      expect(decide(production, git, served), String(served)).toMatchObject({
        build: true,
        reason: 'the commit that production serves is not known',
      })
    }
    expect(calls).toEqual([])
  })

  it('builds a redeploy of the commit that production already serves', () => {
    const { git } = fakeGit(nul('M', 'README.md'))
    expect(decide(production, git, CURRENT.slice(0, 7))).toMatchObject({ build: true, reason: 'the commit that production already serves' })
  })

  it('builds when nothing changed', () => {
    const { git } = fakeGit('')
    expect(decide(production, git, SERVED)).toMatchObject({ build: true, reason: 'no changed files' })
  })

  it('fetches more history once when production is older than the shallow clone, then decides', () => {
    const { git, calls } = fakeGit(nul('M', 'README.md'), { failDiffs: 1 })
    expect(decide(production, git, SERVED).build).toBe(false)
    expect(calls.map((args) => args[0])).toEqual(['diff', 'fetch', 'diff'])
  })

  it('builds when git still cannot compare after fetching, or the fetch fails', () => {
    const stillMissing = fakeGit(nul('M', 'README.md'), { failDiffs: 2 })
    expect(decide(production, stillMissing.git, SERVED)).toMatchObject({
      build: true,
      reason: 'git cannot compare the commit with the one that production serves',
    })
    const noFetch = fakeGit(nul('M', 'README.md'), { failDiffs: 1, failFetch: true })
    expect(decide(production, noFetch.git, SERVED).build).toBe(true)
  })

  it('builds when git prints something it cannot read', () => {
    const { git } = fakeGit('M\0') // a status without a file name
    expect(decide(production, git, SERVED).build).toBe(true)
  })
})

describe('the commit that production serves', () => {
  it("reads it from production's own GET /api/health, without following a redirect, with a time limit", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ ok: true, commit: '65ef147' }))
    expect(await productionCommit(production, fetchImpl)).toBe('65ef147')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://building-qr-system.vercel.app/api/health')
    expect(calls[0].options.redirect).toBe('error')
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal)
  })

  it('knows nothing without a plain production domain, and then asks nobody', async () => {
    for (const host of [
      undefined,
      '',
      'localhost',
      'https://building-qr-system.vercel.app',
      'evil.example/x',
      'a b.com',
      '-x.vercel.app',
      'x.vercel.app:8080',
      'user@x.vercel.app',
    ]) {
      const { fetchImpl, calls } = fakeFetch(json({ ok: true, commit: '65ef147' }))
      expect(await productionCommit({ ...production, VERCEL_PROJECT_PRODUCTION_URL: host }, fetchImpl), String(host)).toBe(null)
      expect(calls, String(host)).toEqual([])
    }
  })

  it('knows nothing when production does not answer, answers an error, or names no commit', async () => {
    for (const answer of [
      new Error('timeout'),
      json({ ok: true, commit: '65ef147' }, 503),
      json({ ok: true, commit: null }),
      json({ ok: true }),
      json({ ok: true, commit: 'dev' }),
      json({ ok: true, commit: '--output' }),
      json(null),
      { ok: true, status: 200, json: async () => { throw new SyntaxError('not JSON') } },
    ]) {
      const { fetchImpl } = fakeFetch(answer)
      expect(await productionCommit(production, fetchImpl)).toBe(null)
    }
  })
})

describe('the wiring', () => {
  it('is the ignoreCommand of vercel.json', () => {
    const vercel = JSON.parse(fs.readFileSync(`${root}/vercel.json`, 'utf8'))
    expect(vercel.ignoreCommand).toBe('node scripts/vercel-ignore.mjs')
  })

  it('uses Node built-ins only, because Vercel runs it before npm ci', () => {
    const source = fs.readFileSync(`${root}/scripts/vercel-ignore.mjs`, 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const name of imports) expect(name.startsWith('node:') || name.startsWith('./'), name).toBe(true)
    const helper = fs.readFileSync(`${root}/scripts/ci-git.mjs`, 'utf8')
    for (const [, name] of helper.matchAll(/^import .* from '([^']+)'/gm)) expect(name.startsWith('node:'), name).toBe(true)
  })
})
