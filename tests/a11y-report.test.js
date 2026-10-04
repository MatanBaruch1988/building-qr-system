// The rules of the accessibility baseline (e2e/a11y-baseline.js), checked without a browser: what it covers, what it does
// not, and that it cannot go stale. The scan itself is e2e/a11y.spec.js; this file holds the logic that it calls
// (e2e/a11y-report.js) and the shape of the list.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { flattenViolations, compareWithBaseline, formatReport, scannedContexts, entriesForUnscannedScreens } from '../e2e/a11y-report.js'
import { A11Y_BASELINE } from '../e2e/a11y-baseline.js'

// What axe returns for one violation of one rule on two elements (only the fields that the report reads).
const violation = (id, targets, extra = {}) => ({
  id,
  impact: 'serious',
  help: 'Elements must meet minimum color contrast ratio thresholds',
  helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
  nodes: targets.map((target) => ({
    target,
    any: [{ message: 'Element has insufficient color contrast of 3.2' }],
    all: [],
    none: [],
  })),
  ...extra,
})

const SCREEN = 'provider he: sign-in list [dark]'
const entry = (rule, target, screen = SCREEN) => ({ screen, rule, target, reason: 'a design decision of the committee' })

describe('flattenViolations', () => {
  it('gives one entry for each element of each rule, with its CSS path and the first message', () => {
    const problems = flattenViolations([violation('color-contrast', [['.w-small'], ['.w-lead']]), violation('label', [['#name']])])
    expect(problems.map((p) => [p.rule, p.target])).toEqual([['color-contrast', '.w-small'], ['color-contrast', '.w-lead'], ['label', '#name']])
    expect(problems[0]).toMatchObject({ impact: 'serious', detail: 'Element has insufficient color contrast of 3.2' })
  })

  it('writes a path through an iframe or a shadow root as one string', () => {
    const [problem] = flattenViolations([violation('label', [['iframe', ['host', '#inner']]])])
    expect(problem.target).toBe('iframe host >> #inner')
  })
})

describe('compareWithBaseline', () => {
  const found = flattenViolations([violation('color-contrast', [['.w-small'], ['.w-lead']])])

  it('is clean when nothing is found and the baseline has nothing for the screen', () => {
    expect(compareWithBaseline([], [], SCREEN)).toEqual({ fresh: [], gone: [] })
    expect(formatReport(SCREEN, { fresh: [], gone: [] })).toBe('')
  })

  it('every problem is new when the baseline is empty', () => {
    expect(compareWithBaseline(found, [], SCREEN).fresh).toHaveLength(2)
  })

  it('a baseline entry covers exactly one rule on one element of one screen', () => {
    const baseline = [entry('color-contrast', '.w-small')]
    const { fresh, gone } = compareWithBaseline(found, baseline, SCREEN)
    expect(gone).toEqual([])
    // the same rule on another element is a new problem
    expect(fresh.map((p) => p.target)).toEqual(['.w-lead'])
    // another rule on the covered element is a new problem too
    expect(compareWithBaseline(flattenViolations([violation('label', [['.w-small']])]), baseline, SCREEN).fresh).toHaveLength(1)
  })

  it('an entry of another screen covers nothing here, and is not reported as gone here', () => {
    const baseline = [entry('color-contrast', '.w-small', 'provider he: sign-in list [light]')]
    const { fresh, gone } = compareWithBaseline(found, baseline, SCREEN)
    expect(fresh).toHaveLength(2)
    expect(gone).toEqual([])
  })

  it('an entry whose problem is gone fails, so the list cannot go stale', () => {
    const baseline = [entry('color-contrast', '.w-small'), entry('color-contrast', '.w-removed')]
    const { fresh, gone } = compareWithBaseline(found, baseline, SCREEN)
    expect(fresh.map((p) => p.target)).toEqual(['.w-lead'])
    expect(gone.map((e) => e.target)).toEqual(['.w-removed'])
  })
})

describe('formatReport', () => {
  it('names the screen, the rule with its impact and help, the element, and what is wrong with it', () => {
    const fresh = flattenViolations([violation('color-contrast', [['.w-small']])])
    const text = formatReport(SCREEN, { fresh, gone: [] })
    expect(text).toContain(`"${SCREEN}"`)
    expect(text).toContain('color-contrast (serious): Elements must meet minimum color contrast ratio thresholds')
    expect(text).toContain('.w-small')
    expect(text).toContain('insufficient color contrast of 3.2')
  })

  it('tells which baseline entries to remove', () => {
    const text = formatReport(SCREEN, { fresh: [], gone: [entry('label', '#name')] })
    expect(text).toContain('entry of e2e/a11y-baseline.js no longer occurs')
    expect(text).toContain('label: #name')
  })
})

describe('the baseline file', () => {
  it('has, for every entry, the screen, the rule, the CSS target and the reason why it is not fixed', () => {
    for (const e of A11Y_BASELINE) {
      for (const key of ['screen', 'rule', 'target', 'reason']) expect(typeof e[key] === 'string' && e[key].trim() !== '', `${JSON.stringify(e)}: ${key}`).toBe(true)
    }
  })

  it('lists no problem twice', () => {
    const keys = A11Y_BASELINE.map((e) => [e.screen, e.rule, e.target].join('\u0000'))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('names, for every entry, a screen that the spec really scans (an entry for a renamed or removed screen is never checked)', () => {
    const { contexts, unreadable } = scannedContexts(fs.readFileSync(new URL('../e2e/a11y.spec.js', import.meta.url), 'utf8'))
    expect(unreadable, 'scans that are not named by a plain string, which this check cannot read').toEqual([])
    expect(contexts.size, 'the spec scans many screens').toBeGreaterThan(50)
    const orphans = entriesForUnscannedScreens(A11Y_BASELINE, contexts).map((e) => `${e.screen}: ${e.rule} ${e.target}`)
    expect(orphans, 'baseline entries for a screen that the spec does not scan').toEqual([])
  })
})

describe('scannedContexts and entriesForUnscannedScreens', () => {
  const spec = [
    "// scanBothThemes(page, 'a comment is not a scan')",
    'async function scanBothThemes(page, screen, options = {}) {',
    '  await expectNoA11yViolations(page, { context: `${screen} [${scheme}]`, ...options })',
    '}',
    "    await scanBothThemes(page, 'provider he: sign-in list')",
    "    await scanBothThemes(page, 'committee phone: point form', { exclude: ['.x'] })",
    "    await expectNoA11yViolations(page, { context: 'committee: the printed sign [print]' })",
  ].join('\n')

  it('reads both themes of a screen, a single named scan, and nothing from comments or the helper itself', () => {
    const { contexts, unreadable } = scannedContexts(spec)
    expect(unreadable).toEqual([])
    expect([...contexts].sort()).toEqual([
      'committee phone: point form [dark]',
      'committee phone: point form [light]',
      'committee: the printed sign [print]',
      'provider he: sign-in list [dark]',
      'provider he: sign-in list [light]',
    ])
  })

  it('reports a scan that is named in a way it cannot follow, so that none can hide from the check', () => {
    expect(scannedContexts("await scanBothThemes(page, `committee phone: ${tab}`)").unreadable).toHaveLength(1)
    expect(scannedContexts('await expectNoA11yViolations(page, { context: name })').unreadable).toHaveLength(1)
  })

  it('finds an entry whose screen was renamed or removed', () => {
    const { contexts } = scannedContexts(spec)
    const baseline = [
      entry('color-contrast', '.w-small', 'provider he: sign-in list [dark]'),
      entry('color-contrast', '.w-small', 'provider he: the list of people [dark]'), // the screen was renamed
      entry('label', '#name', 'committee phone: a screen that was removed [light]'),
    ]
    expect(entriesForUnscannedScreens(baseline, contexts).map((e) => e.screen)).toEqual([
      'provider he: the list of people [dark]',
      'committee phone: a screen that was removed [light]',
    ])
  })
})
