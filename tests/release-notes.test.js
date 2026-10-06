// The release notes (scripts/release-notes.mjs, run by .github/workflows/release.yml). Three layers: the pure function that
// writes the Markdown, the command line logic with a fake git (so every refusal is reached), and the real git in a
// throwaway repository with fake commits, which proves that the git commands do what the logic expects of them. All the
// names, numbers and addresses here are made up.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  FIRST_RELEASE_TEXT,
  INSTALLERS_HINT,
  ReleaseError,
  checkVersions,
  compareVersions,
  groupSubjects,
  normalizeRepoUrl,
  parseArgs,
  parseSubject,
  renderNotes,
  repoUrlFromEnv,
  run,
} from '../scripts/release-notes.mjs'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const SCRIPT = path.join(root, 'scripts', 'release-notes.mjs')
const REPO = 'https://github.com/fake-owner/fake-repo'
const ENV = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'fake-owner/fake-repo' }

/** The message of the error that `fn` throws (the test fails when it does not throw a ReleaseError). */
function refusal(fn) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseError)
    return error.message
  }
  throw new Error('expected a refusal')
}

const notes = (subjects, over = {}) => renderNotes({ version: '2.1.0', previous: 'v2.0.0', subjects, repoUrl: REPO, ...over })
const position = (text, heading) => text.indexOf(`## ${heading}`)

describe('the notes: groups', () => {
  const SUBJECTS = [
    'docs: explain the install steps (#31)',
    'feat(admin): export the history to CSV (#30)',
    'fix(scan): refuse a point that is too far (#29)',
    'feat(api)!: rename a field of the sync (#28)',
    'chore(deps): bump a fake package (#27)',
    'fix!: drop an old setting (#26)',
    'feat: a second feature (#25)',
    'ci: pin an action (#24)',
    'revert: take back a change (#23)',
  ]

  it('puts a breaking change (a ! before the colon, with or without a scope) under Breaking changes only', () => {
    const text = notes(SUBJECTS)
    const breaking = text.slice(position(text, 'Breaking changes'), position(text, 'Features'))
    expect(breaking).toContain('feat(api)!: rename a field of the sync')
    expect(breaking).toContain('fix!: drop an old setting')
    expect(text.match(/rename a field of the sync/g)).toHaveLength(1)
    expect(text.match(/drop an old setting/g)).toHaveLength(1)
  })

  it('puts feat under Features, fix under Fixes and every other type under Other changes, each subject as written', () => {
    const groups = groupSubjects(SUBJECTS)
    expect(groups.features).toEqual(['feat(admin): export the history to CSV (#30)', 'feat: a second feature (#25)'])
    expect(groups.fixes).toEqual(['fix(scan): refuse a point that is too far (#29)'])
    expect(groups.other).toEqual([
      'docs: explain the install steps (#31)',
      'chore(deps): bump a fake package (#27)',
      'ci: pin an action (#24)',
      'revert: take back a change (#23)',
    ])
    expect(groups.breaking).toEqual(['feat(api)!: rename a field of the sync (#28)', 'fix!: drop an old setting (#26)'])
  })

  it('writes the groups in the order: what installers must do, breaking, features, fixes, other, the full list', () => {
    const text = notes(SUBJECTS)
    const order = [
      text.indexOf('## What installers must do'),
      position(text, 'Breaking changes'),
      position(text, 'Features'),
      position(text, 'Fixes'),
      position(text, 'Other changes'),
      text.indexOf('**Full list of changes:**'),
    ]
    expect(order[0]).toBe(0)
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('keeps the order in which the subjects were given inside a group', () => {
    expect(groupSubjects(['fix: b', 'fix: a', 'fix: c']).fixes).toEqual(['fix: b', 'fix: a', 'fix: c'])
  })

  it('leaves out a group that has nothing in it', () => {
    const text = notes(['fix: only a fix (#5)'])
    expect(text).toContain('## Fixes')
    for (const heading of ['Breaking changes', 'Features', 'Other changes']) expect(text).not.toContain(`## ${heading}`)
    const onlyFeature = notes(['feat: only a feature (#6)'])
    expect(onlyFeature).toContain('## Features')
    for (const heading of ['Breaking changes', 'Fixes', 'Other changes']) expect(onlyFeature).not.toContain(`## ${heading}`)
  })

  it('puts a subject that is not a Conventional Commit under Other changes, as it is', () => {
    const odd = [
      'Update the fake readme',
      'Merge pull request #5 from fake-user/fake-branch',
      'feature: not one of the types (#7)',
      'feat:no space after the colon',
      'Feat: capital letter',
      'feat(Bad Scope): a scope with a capital and a space',
      'wip',
    ]
    const groups = groupSubjects(odd)
    expect(groups.other).toEqual(odd)
    expect([groups.breaking, groups.features, groups.fixes]).toEqual([[], [], []])
    const text = notes(odd)
    expect(text).toContain('- Update the fake readme')
    expect(text).toContain('- wip')
    expect(text).not.toContain('## Features')
  })

  it('reads the type and the breaking mark of a subject', () => {
    expect(parseSubject('feat(api)!: x')).toEqual({ type: 'feat', breaking: true })
    expect(parseSubject('fix: x')).toEqual({ type: 'fix', breaking: false })
    expect(parseSubject('ci(smoke): x (#1)')).toEqual({ type: 'ci', breaking: false })
    expect(parseSubject('just words')).toEqual({ type: null, breaking: false })
    // The "!" counts only before the first colon, not somewhere in the description.
    expect(parseSubject('fix: a breaking! change')).toEqual({ type: 'fix', breaking: false })
  })

  it('drops a blank subject', () => {
    expect(groupSubjects(['', '   ', 'fix: a']).fixes).toEqual(['fix: a'])
    expect(groupSubjects(['', '  ']).other).toEqual([])
  })

  it('has the section for the owner, with its comment, first and always', () => {
    const text = notes(['fix: a (#1)'])
    expect(text.startsWith(`## What installers must do\n\n${INSTALLERS_HINT}\n`)).toBe(true)
    expect(INSTALLERS_HINT).toBe(
      '<!-- Write what an installer must do before or after updating, or "Nothing." A major version always has something here. -->',
    )
  })
})

describe('the notes: links', () => {
  it('turns the (#123) of a squash commit into a link to that pull request, and changes nothing else', () => {
    const text = notes(['feat(admin): a new tile (#123)', 'fix: a bug (#4) and another (#56)', 'docs: no number here', 'fix: see #9 without brackets'])
    expect(text).toContain(`- feat(admin): a new tile ([#123](${REPO}/pull/123))`)
    expect(text).toContain(`- fix: a bug ([#4](${REPO}/pull/4)) and another ([#56](${REPO}/pull/56))`)
    expect(text).toContain('- docs: no number here\n')
    expect(text).toContain('- fix: see #9 without brackets\n')
  })

  it('uses the address that it was given, without a trailing slash', () => {
    const text = notes(['fix: a (#1)'], { repoUrl: 'https://git.example.test/fake-owner/fake-repo/' })
    expect(text).toContain('([#1](https://git.example.test/fake-owner/fake-repo/pull/1))')
    expect(text).toContain('https://git.example.test/fake-owner/fake-repo/compare/v2.0.0...v2.1.0')
  })

  it('escapes < so that a title cannot add HTML to the notes, and keeps the rest as written', () => {
    const text = notes(['fix: handle <script>alert(1)</script> and `code` in a title (#8)'])
    expect(text).not.toContain('<script>')
    expect(text).toContain('- fix: handle &lt;script>alert(1)&lt;/script> and `code` in a title')
  })

  it('writes the link to the full list of changes when there is a previous tag', () => {
    expect(notes(['fix: a'])).toContain(`**Full list of changes:** ${REPO}/compare/v2.0.0...v2.1.0\n`)
    expect(notes(['fix: a'], { version: '3.0.0', previous: 'v2.4.1' })).toContain(`${REPO}/compare/v2.4.1...v3.0.0`)
  })
})

describe('the notes: the first release', () => {
  const first = renderNotes({ version: '2.0.0', previous: '', subjects: ['feat: a (#1)', 'fix: b (#2)'], repoUrl: REPO })

  it('has the sentence, the section for the owner, and no lists and no comparison', () => {
    expect(first).toBe(`## What installers must do\n\n${INSTALLERS_HINT}\n\n${FIRST_RELEASE_TEXT}\n`)
    expect(FIRST_RELEASE_TEXT).toBe('The first tagged release. The changes before it are in the history of the default branch.')
    for (const heading of ['Breaking changes', 'Features', 'Fixes', 'Other changes']) expect(first).not.toContain(`## ${heading}`)
    expect(first).not.toContain('Full list of changes')
    expect(first).not.toContain('feat: a')
  })

  it('is the same for a missing previous tag as for an empty one', () => {
    for (const previous of [undefined, null]) {
      expect(renderNotes({ version: '2.0.0', previous, subjects: [], repoUrl: REPO })).toBe(first)
    }
  })
})

describe('the version and the previous tag', () => {
  const INPUT = 'zzz-input-that-must-not-come-back'

  it('accepts MAJOR.MINOR.PATCH', () => {
    for (const version of ['0.0.1', '2.1.0', '10.20.30']) expect(checkVersions({ version, previous: '' })).toBe(false)
    expect(checkVersions({ version: '2.1.0', previous: 'v2.0.0' })).toBe(true)
  })

  it('refuses a version that is not three numbers, without echoing it', () => {
    const bad = ['2.1', 'v2.1.0', '2.1.0-rc.1', '2.1.0+build', ' 2.1.0', '2.1.0 ', '2.1.0\n', '02.1.0', '2.1.00', '2.1.x', '', `${INPUT}`, `2.1.0; echo ${INPUT}`, `$(echo ${INPUT})`, '--output=x', '../2.1.0']
    // One fixed message for every bad input: nothing of the input can be in it.
    const messages = new Set(bad.map((version) => refusal(() => checkVersions({ version, previous: '' }))))
    expect([...messages]).toHaveLength(1)
    expect([...messages][0]).toMatch(/version must look like/)
    expect([...messages][0]).not.toContain(INPUT)
    for (const version of [undefined, null, 2.1, {}]) expect(refusal(() => checkVersions({ version, previous: '' }))).toMatch(/version must look like/)
  })

  it('refuses a previous tag that is not v and three numbers, without echoing it', () => {
    const bad = ['2.0.0', 'v2.0', 'v2.0.0-rc.1', 'V2.0.0', 'main', 'v02.0.0', ' v2.0.0', 'v2.0.0 ', 'v2.0.0\n', `v${INPUT}`, INPUT, `v2.0.0;${INPUT}`, '--output=x', '-n', 'refs/tags/v2.0.0', 'v2.0.0..v3.0.0']
    const messages = new Set(bad.map((previous) => refusal(() => checkVersions({ version: '3.0.0', previous }))))
    expect([...messages]).toHaveLength(1)
    expect([...messages][0]).toMatch(/previous tag must look like/)
    expect([...messages][0]).not.toContain(INPUT)
    expect(refusal(() => checkVersions({ version: '3.0.0', previous: 5 }))).toMatch(/previous tag must look like/)
  })

  it('refuses a version that is not greater than the previous tag', () => {
    for (const [version, previous] of [['2.0.0', 'v2.0.0'], ['1.9.9', 'v2.0.0'], ['2.0.0', 'v2.0.1'], ['2.0.9', 'v2.1.0'], ['9.9.9', 'v10.0.0']]) {
      expect(refusal(() => checkVersions({ version, previous })), `${version} after ${previous}`).toMatch(/greater than the previous tag/)
    }
  })

  it('compares numbers, not text, and has no limit on their size', () => {
    expect(checkVersions({ version: '2.10.0', previous: 'v2.9.0' })).toBe(true)
    expect(checkVersions({ version: '2.0.10', previous: 'v2.0.9' })).toBe(true)
    expect(checkVersions({ version: '10.0.0', previous: 'v9.9.9' })).toBe(true)
    expect(checkVersions({ version: '3.0.0', previous: 'v2.99.99' })).toBe(true)
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0)
    expect(compareVersions('2.1.0', '2.0.9')).toBe(1)
    expect(compareVersions('2.0.9', '2.1.0')).toBe(-1)
    expect(compareVersions('99999999999999999999.0.1', '99999999999999999999.0.0')).toBe(1)
  })

  it('is checked by renderNotes too, so the notes of a bad release are never written', () => {
    refusal(() => notes(['fix: a'], { version: 'abc' }))
    refusal(() => notes(['fix: a'], { previous: 'abc' }))
    refusal(() => notes(['fix: a'], { version: '2.0.0', previous: 'v2.0.0' }))
    refusal(() => renderNotes({ version: 'abc', previous: '', subjects: [], repoUrl: REPO }))
  })
})

describe('the address of the repository', () => {
  it('takes GITHUB_SERVER_URL and GITHUB_REPOSITORY', () => {
    expect(repoUrlFromEnv(ENV)).toBe(REPO)
    expect(repoUrlFromEnv({ GITHUB_SERVER_URL: 'https://git.example.test/', GITHUB_REPOSITORY: 'a.b/c_d-e' })).toBe('https://git.example.test/a.b/c_d-e')
  })

  it('refuses a missing or odd one, without echoing it', () => {
    refusal(() => repoUrlFromEnv({}))
    refusal(() => repoUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com' }))
    const bad = [
      { GITHUB_SERVER_URL: 'http://github.com', GITHUB_REPOSITORY: 'a/b' },
      { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'a/b)(javascript:x)' },
      { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'only-one-part' },
      { GITHUB_SERVER_URL: 'https://user:pass@github.com', GITHUB_REPOSITORY: 'a/b' },
      { GITHUB_SERVER_URL: 'nonsense', GITHUB_REPOSITORY: 'a/b' },
    ]
    for (const env of bad) {
      const message = refusal(() => repoUrlFromEnv(env))
      expect(message).not.toContain('pass')
      expect(message).not.toContain('javascript')
    }
  })

  it('accepts only https://host/owner/repo for the flag, without a query or a fragment', () => {
    expect(normalizeRepoUrl(`${REPO}/`)).toBe(REPO)
    for (const bad of ['http://github.com/a/b', 'https://github.com/a', 'https://github.com/a/b/c', `${REPO}?x=1`, `${REPO}#top`, 'ftp://github.com/a/b', 'github.com/a/b', 'https://github.com/a/b)']) {
      refusal(() => normalizeRepoUrl(bad))
    }
  })
})

describe('the command line: arguments', () => {
  it('reads --name value and --name=value', () => {
    expect(parseArgs(['--version', '2.1.0', '--previous=v2.0.0', '--target', 'abc123', '--out=notes.md', '--repo-url', REPO])).toEqual({
      version: '2.1.0',
      previous: 'v2.0.0',
      target: 'abc123',
      out: 'notes.md',
      repoUrl: REPO,
    })
    expect(parseArgs(['--previous', ''])).toEqual({ previous: '' })
    expect(parseArgs([])).toEqual({})
  })

  it('takes the next argument as the value, whatever it looks like', () => {
    expect(parseArgs(['--version', '--out=x'])).toEqual({ version: '--out=x' })
  })

  it('refuses an unknown or repeated flag, a stray value and a flag without a value, without echoing it', () => {
    for (const argv of [['--versoin', 'zzz-typo'], ['zzz-stray'], ['-v', '2.1.0'], ['--version=2.1.0', '--version=2.2.0'], ['--version'], ['--__proto__', 'x'], ['--constructor=x']]) {
      const message = refusal(() => parseArgs(argv))
      expect(message).toContain('Usage:')
      expect(message).not.toContain('zzz')
    }
  })
})

/** A fake git: `answers` maps the start of the arguments to an output, or to an error to throw. */
function fakeGit(answers) {
  const calls = []
  const runner = (args) => {
    calls.push(args)
    const key = Object.keys(answers).find((name) => args.join(' ').startsWith(name))
    if (key === undefined) throw Object.assign(new Error('fake git: no answer'), { status: 1, stderr: '' })
    const answer = answers[key]
    if (answer instanceof Error) throw answer
    return answer
  }
  return { runner, calls }
}
const gitError = (status, stderr) => Object.assign(new Error('Command failed: git zzz-must-not-be-printed'), { status, stderr })
const NO_TAG = gitError(128, 'fatal: No names found, cannot describe anything.\n')
const TARGET = '0123456789abcdef0123456789abcdef01234567'
const LOG = 'fix: a fix (#3)\nfeat(admin): a feature (#2)\ndocs: some words (#1)\n'
const base = { 'rev-parse --verify --quiet': '' }

describe('the command line: the logic, with a fake git', () => {
  it('writes the notes of the first release when no v* tag is an ancestor of the target', () => {
    const { runner, calls } = fakeGit({ ...base, describe: NO_TAG, 'rev-parse --is-shallow-repository': 'false\n' })
    const result = run({ argv: ['--version', '2.0.0', '--target', TARGET, '--out', 'notes.md'], env: ENV, runner })
    expect(result.notes).toBe(renderNotes({ version: '2.0.0', previous: '', subjects: [], repoUrl: REPO }))
    expect(result.out).toBe('notes.md')
    expect(calls.map((args) => args[0])).not.toContain('log') // nothing to list for the first release
    expect(calls).toContainEqual(['describe', '--tags', '--abbrev=0', '--match', 'v*', TARGET])
  })

  it('finds the previous tag with git describe, reads the first-parent subjects since it, and writes the notes', () => {
    const { runner, calls } = fakeGit({ ...base, describe: 'v2.0.0\n', log: LOG })
    const { notes: text, summary } = run({ argv: ['--version', '2.1.0', '--target', TARGET], env: ENV, runner })
    expect(text).toBe(renderNotes({ version: '2.1.0', previous: 'v2.0.0', subjects: LOG.trim().split('\n'), repoUrl: REPO }))
    expect(calls).toContainEqual(['log', '--first-parent', '--no-show-signature', '--format=%s', `refs/tags/v2.0.0..${TARGET}`])
    expect(summary).toBe('Notes for v2.1.0: 3 change(s) since v2.0.0.')
  })

  it('uses a previous tag that is given, after checking that it exists and is an ancestor of the target', () => {
    const { runner, calls } = fakeGit({ ...base, 'merge-base --is-ancestor': '', log: LOG })
    const { notes: text } = run({ argv: ['--version', '3.0.0', '--previous', 'v2.4.0', '--target', TARGET], env: ENV, runner })
    expect(text).toContain(`${REPO}/compare/v2.4.0...v3.0.0`)
    expect(calls.map((args) => args[0])).not.toContain('describe')
    expect(calls).toContainEqual(['rev-parse', '--verify', '--quiet', 'refs/tags/v2.4.0^{commit}'])
    expect(calls).toContainEqual(['merge-base', '--is-ancestor', 'refs/tags/v2.4.0', TARGET])
  })

  it('treats an empty --previous as "find it", and takes the address from the flag when it is given', () => {
    const { runner } = fakeGit({ ...base, describe: 'v2.0.0\n', log: LOG })
    const { notes: text } = run({ argv: ['--version', '2.1.0', '--previous', '', '--repo-url', 'https://github.com/other-owner/other-repo'], runner })
    expect(text).toContain('https://github.com/other-owner/other-repo/compare/v2.0.0...v2.1.0')
  })

  it('refuses a version that is not greater than the previous tag, found or given', () => {
    const found = fakeGit({ ...base, describe: 'v2.0.0\n', log: LOG })
    expect(refusal(() => run({ argv: ['--version', '2.0.0'], env: ENV, runner: found.runner }))).toMatch(/greater than the previous tag/)
    expect(found.calls.map((args) => args[0])).not.toContain('log')
    const given = fakeGit({ ...base, 'merge-base --is-ancestor': '', log: LOG })
    expect(refusal(() => run({ argv: ['--version', '1.0.0', '--previous', 'v2.0.0'], env: ENV, runner: given.runner }))).toMatch(/greater than the previous tag/)
    expect(given.calls).toEqual([]) // refused before git was asked anything
  })

  it('refuses a bad version or previous tag before it asks git anything, without echoing them', () => {
    for (const argv of [['--version', 'zzz-bad'], ['--version', '2.1.0', '--previous', 'zzz-bad'], [], ['--previous', 'v1.0.0']]) {
      const { runner, calls } = fakeGit({ ...base })
      const message = refusal(() => run({ argv, env: ENV, runner }))
      expect(message).not.toContain('zzz')
      expect(calls).toEqual([])
    }
  })

  it('refuses a previous tag that does not exist, or is not an ancestor of the target', () => {
    // The check of the target comes first and passes; then the tag is looked up and is not there.
    const missing = fakeGit({ [`rev-parse --verify --quiet ${TARGET}`]: '', 'rev-parse --verify --quiet refs/tags/': gitError(1, '') })
    expect(refusal(() => run({ argv: ['--version', '2.1.0', '--previous', 'v2.0.0', '--target', TARGET], env: ENV, runner: missing.runner }))).toMatch(/does not exist/)
    expect(missing.calls.map((args) => args[0])).not.toContain('log')
    const notAncestor = fakeGit({ ...base, 'merge-base --is-ancestor': gitError(1, '') })
    expect(refusal(() => run({ argv: ['--version', '2.1.0', '--previous', 'v2.0.0'], env: ENV, runner: notAncestor.runner }))).toMatch(/not an ancestor/)
  })

  it('refuses a target that is not a commit, or that looks like an option', () => {
    const { runner } = fakeGit({ 'rev-parse --verify --quiet': gitError(1, '') })
    expect(refusal(() => run({ argv: ['--version', '2.1.0', '--target', 'abc123'], env: ENV, runner }))).toMatch(/not a commit/)
    for (const target of ['--output=x', '-n', 'a b', '$(id)', '']) {
      const { runner: never, calls } = fakeGit({})
      refusal(() => run({ argv: ['--version', '2.1.0', '--target', target], env: ENV, runner: never }))
      expect(calls).toEqual([])
    }
  })

  it('refuses a release with nothing in it', () => {
    const { runner } = fakeGit({ ...base, describe: 'v2.0.0\n', log: '\n' })
    expect(refusal(() => run({ argv: ['--version', '2.0.1'], env: ENV, runner }))).toMatch(/Nothing changed/)
  })

  it('refuses to call a release the first one in a shallow clone, where the tags may be missing', () => {
    const { runner } = fakeGit({ ...base, describe: NO_TAG, 'rev-parse --is-shallow-repository': 'true\n' })
    expect(refusal(() => run({ argv: ['--version', '2.0.0'], env: ENV, runner }))).toMatch(/shallow/)
  })

  it('also reads "No tags can describe" as no tag', () => {
    const { runner } = fakeGit({ ...base, describe: gitError(128, "fatal: No tags can describe '0123'.\nTry --always, or create some tags.\n"), 'rev-parse --is-shallow-repository': 'false\n' })
    expect(run({ argv: ['--version', '2.0.0'], env: ENV, runner }).notes).toContain(FIRST_RELEASE_TEXT)
  })

  it('refuses when git describe fails for another reason, or finds a tag that is not v and three numbers', () => {
    const broken = fakeGit({ ...base, describe: gitError(1, 'zzz-must-not-be-printed') })
    expect(refusal(() => run({ argv: ['--version', '2.0.0'], env: ENV, runner: broken.runner }))).not.toContain('zzz')
    const odd = fakeGit({ ...base, describe: 'v2.0.0-rc.1\n' })
    const message = refusal(() => run({ argv: ['--version', '2.0.0'], env: ENV, runner: odd.runner }))
    expect(message).toMatch(/not of the form/)
    expect(message).not.toContain('rc.1')
  })

  it('never prints what git said when it fails', () => {
    const { runner } = fakeGit({ ...base, describe: 'v2.0.0\n', log: gitError(128, 'fatal: zzz-must-not-be-printed') })
    expect(refusal(() => run({ argv: ['--version', '2.1.0'], env: ENV, runner }))).not.toContain('zzz')
  })

  it('needs the address of the repository, from the environment or from --repo-url', () => {
    const { runner } = fakeGit({ ...base, describe: NO_TAG, 'rev-parse --is-shallow-repository': 'false\n' })
    expect(refusal(() => run({ argv: ['--version', '2.0.0'], env: {}, runner }))).toMatch(/GITHUB_SERVER_URL/)
    expect(run({ argv: ['--version', '2.0.0', '--repo-url', REPO], env: {}, runner }).notes).toContain(FIRST_RELEASE_TEXT)
  })
})

// The real git, in a throwaway repository with fake commits. The identity is set through the environment and the user's
// own git configuration (signing, hooks, templates) is left out, so that the test does not depend on the machine.
describe('the command line: real git in a throwaway repository', () => {
  let parent
  let dir
  // An empty file as the global git configuration (git 2.32 and later), so that the user's own settings are not read.
  const gitEnv = {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_CONFIG_GLOBAL: undefined, // set in beforeAll, to a file next to the repository
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fake Author',
    GIT_AUTHOR_EMAIL: 'fake-author@example.invalid',
    GIT_COMMITTER_NAME: 'Fake Author',
    GIT_COMMITTER_EMAIL: 'fake-author@example.invalid',
  }
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const runner = (args) => git(...args)
  const commit = (subject) => git('commit', '--allow-empty', '-m', subject)
  const revise = (version, extra = []) => run({ argv: ['--version', version, ...extra], env: ENV, runner }).notes

  beforeAll(() => {
    parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bqr-release-notes-test-')))
    dir = path.join(parent, 'repo')
    fs.mkdirSync(dir)
    gitEnv.GIT_CONFIG_GLOBAL = path.join(parent, 'empty.gitconfig')
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '')
    git('init', '--quiet', '--initial-branch=main')
  })
  afterAll(() => {
    if (parent) fs.rmSync(parent, { recursive: true, force: true })
  })

  it('is the first release while there is no v* tag, and a tag that is not a version does not count', () => {
    commit('feat: the very first fake feature (#1)')
    git('tag', 'not-a-release')
    const text = revise('1.0.0')
    expect(text).toContain(FIRST_RELEASE_TEXT)
    expect(text).not.toContain('Features')
    expect(refusal(() => revise('1.0.0', ['--previous', 'v0.9.0']))).toMatch(/does not exist/)
  })

  it('finds the newest v* tag behind the target and lists the first-parent subjects since it, a merge as one line', () => {
    git('tag', 'v1.0.0') // a light tag
    commit('fix: a fake fix (#2)')
    git('checkout', '--quiet', '-b', 'side')
    commit('fix: a side commit that is only inside the merge (#3)')
    git('checkout', '--quiet', 'main')
    git('merge', '--quiet', '--no-ff', 'side', '-m', 'feat(api)!: a fake breaking merge (#4)')
    commit('docs: some fake words (#5)')
    const text = revise('2.0.0')
    const link = (n) => `([#${n}](${REPO}/pull/${n}))`
    expect(text).toContain(
      `## Breaking changes\n\n- feat(api)!: a fake breaking merge ${link(4)}\n\n` +
        `## Fixes\n\n- fix: a fake fix ${link(2)}\n\n` +
        `## Other changes\n\n- docs: some fake words ${link(5)}\n\n` +
        `**Full list of changes:** ${REPO}/compare/v1.0.0...v2.0.0\n`,
    )
    expect(text).not.toContain('a side commit') // first-parent: the commits inside a merge are not listed
    expect(text).not.toContain('the very first fake feature') // before the tag
  })

  it('compares with an annotated tag too, and with one that is given by hand', () => {
    git('tag', '-a', 'v2.0.0', '-m', 'a fake annotated tag')
    commit('feat: a fake feature after the annotated tag (#6)')
    const found = revise('2.1.0')
    expect(found).toContain(`${REPO}/compare/v2.0.0...v2.1.0`)
    expect(found).toContain('- feat: a fake feature after the annotated tag')
    expect(found).not.toContain('a fake fix')
    const given = revise('2.1.0', ['--previous', 'v1.0.0'])
    expect(given).toContain(`${REPO}/compare/v1.0.0...v2.1.0`)
    expect(given).toContain('a fake fix')
  })

  it('refuses a version that is not greater, a tag on another line of history, and a release with no change', () => {
    expect(refusal(() => revise('2.0.0'))).toMatch(/greater than the previous tag/)
    git('checkout', '--quiet', '-b', 'elsewhere', 'v1.0.0')
    commit('fix: a fake commit that main does not have (#7)')
    git('tag', 'v1.5.0')
    git('checkout', '--quiet', 'main')
    expect(refusal(() => revise('3.0.0', ['--previous', 'v1.5.0']))).toMatch(/not an ancestor/)
    git('tag', 'v2.1.0')
    expect(refusal(() => revise('2.1.1'))).toMatch(/Nothing changed/)
  })

  it('runs as a command: the notes go to the file, and a bad version prints a fixed message and exits with 1', () => {
    const out = path.join(dir, 'notes.md')
    commit('fix: a fake fix for the command (#8)')
    const ok = spawnSync(process.execPath, [SCRIPT, '--version', '2.1.1', '--repo-url', REPO, '--out', out], { cwd: dir, env: gitEnv, encoding: 'utf8' })
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toContain('Notes for v2.1.1: 1 change(s) since v2.1.0.')
    expect(fs.readFileSync(out, 'utf8')).toContain(`- fix: a fake fix for the command ([#8](${REPO}/pull/8))`)
    const toStdout = spawnSync(process.execPath, [SCRIPT, '--version', '2.1.1', '--repo-url', REPO], { cwd: dir, env: gitEnv, encoding: 'utf8' })
    expect(toStdout.status).toBe(0)
    expect(toStdout.stdout.startsWith('## What installers must do')).toBe(true)

    const bad = spawnSync(process.execPath, [SCRIPT, '--version', 'zzz-bad-input', '--repo-url', REPO], { cwd: dir, env: gitEnv, encoding: 'utf8' })
    expect(bad.status).toBe(1)
    expect(bad.stdout).toBe('')
    expect(bad.stderr).toContain('release-notes: The version must look like 2.1.0')
    expect(bad.stderr).not.toContain('zzz-bad-input')
    const typo = spawnSync(process.execPath, [SCRIPT, '--versoin', 'zzz-typo'], { cwd: dir, env: gitEnv, encoding: 'utf8' })
    expect(typo.status).toBe(1)
    expect(typo.stderr).not.toContain('zzz-typo')
  })
})
