// scripts/vercel-ignore.mjs, Vercel's "Ignored Build Step": which merges are not deployed. Only its pure functions are
// tested here, with a stand-in for git. The rule is one-sided: anything that is not clearly a document, a test or CI
// builds, and so does every case where the script cannot tell.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { decide, isSkippable, SKIP_DIRS, SKIP_FILES } from '../scripts/vercel-ignore.mjs'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
// What `git diff --name-status -z` prints: every field ends with a NUL.
const nul = (...fields) => fields.map((field) => `${field}\0`).join('')
const PREVIOUS = 'a'.repeat(40)
const CURRENT = 'b'.repeat(40)
const production = { VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: PREVIOUS, VERCEL_GIT_COMMIT_SHA: CURRENT }

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
  it('skips a production merge that changed only documents, tests or CI', () => {
    const { git, calls } = fakeGit(nul('M', 'docs/install.md', 'A', 'tests/x.test.js', 'M', '.github/workflows/ci.yml', 'D', 'README.md'))
    const decision = decide(production, git)
    expect(decision.build).toBe(false)
    expect(decision.files).toEqual(['docs/install.md', 'tests/x.test.js', '.github/workflows/ci.yml', 'README.md'])
    // compared with the last deployment, not with the parent commit, and renames shown as a delete and an add
    expect(calls).toEqual([['diff', '--name-status', '-z', '--no-renames', PREVIOUS, CURRENT]])
  })

  it('builds when one changed file reaches the app, and names it', () => {
    const { git } = fakeGit(nul('M', 'docs/install.md', 'M', 'src/main.jsx'))
    expect(decide(production, git)).toEqual({ build: true, reason: 'files that reach the app or the server changed', files: ['src/main.jsx'] })
  })

  it('builds for a migration', () => {
    const { git } = fakeGit(nul('M', 'README.md', 'A', 'db/migrations/013_anything.sql'))
    expect(decide(production, git).build).toBe(true)
  })

  it('builds for a dependency change', () => {
    const { git } = fakeGit(nul('M', 'package-lock.json'))
    expect(decide(production, git).build).toBe(true)
  })

  it('builds when a file moves out of the app into the documents (the delete counts)', () => {
    // --no-renames: git prints the rename as a deleted app file and an added document
    const { git } = fakeGit(nul('D', 'src/admin/notes.js', 'A', 'docs/notes.js'))
    expect(decide(production, git).build).toBe(true)
  })

  it('builds anything that is not a production build', () => {
    const { git, calls } = fakeGit(nul('M', 'README.md'))
    for (const VERCEL_ENV of ['preview', 'development', undefined, '']) {
      expect(decide({ ...production, VERCEL_ENV }, git).build, String(VERCEL_ENV)).toBe(true)
    }
    expect(calls).toEqual([])
  })

  it('builds when there is no previous deployment to compare with, or a commit does not look like one', () => {
    const { git, calls } = fakeGit(nul('M', 'README.md'))
    for (const env of [
      { ...production, VERCEL_GIT_PREVIOUS_SHA: undefined },
      { ...production, VERCEL_GIT_PREVIOUS_SHA: '' },
      { ...production, VERCEL_GIT_COMMIT_SHA: undefined },
      { ...production, VERCEL_GIT_PREVIOUS_SHA: '--output=/tmp/x' },
      { ...production, VERCEL_GIT_PREVIOUS_SHA: 'HEAD~1' },
      { ...production, VERCEL_GIT_COMMIT_SHA: 'B'.repeat(40) },
    ]) {
      expect(decide(env, git)).toMatchObject({ build: true, reason: 'no previous deployment to compare with' })
    }
    expect(calls).toEqual([])
  })

  it('builds a redeploy of the commit that is already deployed', () => {
    const { git } = fakeGit(nul('M', 'README.md'))
    expect(decide({ ...production, VERCEL_GIT_PREVIOUS_SHA: CURRENT }, git).build).toBe(true)
  })

  it('builds when nothing changed', () => {
    const { git } = fakeGit('')
    expect(decide(production, git)).toMatchObject({ build: true, reason: 'no changed files' })
  })

  it('fetches more history once when the last deployment is older than the shallow clone, then decides', () => {
    const { git, calls } = fakeGit(nul('M', 'README.md'), { failDiffs: 1 })
    expect(decide(production, git).build).toBe(false)
    expect(calls.map((args) => args[0])).toEqual(['diff', 'fetch', 'diff'])
  })

  it('builds when git still cannot compare after fetching, or the fetch fails', () => {
    const stillMissing = fakeGit(nul('M', 'README.md'), { failDiffs: 2 })
    expect(decide(production, stillMissing.git)).toMatchObject({ build: true, reason: 'git cannot compare the commit with the last deployment' })
    const noFetch = fakeGit(nul('M', 'README.md'), { failDiffs: 1, failFetch: true })
    expect(decide(production, noFetch.git).build).toBe(true)
  })

  it('builds when git prints something it cannot read', () => {
    const { git } = fakeGit('M\0') // a status without a file name
    expect(decide(production, git).build).toBe(true)
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
