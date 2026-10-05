// The part of the accessibility scan that needs no browser: turning what axe reports into a flat list, comparing it with
// the baseline (e2e/a11y-baseline.js), and writing the report of a failing scan. `expectNoA11yViolations` in
// e2e/fixtures.js runs axe and calls these; tests/a11y-report.test.js checks them without a browser.

/** The CSS path that axe gives for a node (a path through an iframe or a shadow root is written with ">>"). */
const targetOf = (node) => node.target.map((part) => (Array.isArray(part) ? part.join(' >> ') : part)).join(' ')

/**
 * One entry per element and rule, from axe's `violations`. `detail` is the first message of the check that failed: for a
 * contrast problem it holds the ratio and both colours.
 */
export function flattenViolations(violations) {
  return violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      rule: violation.id,
      impact: violation.impact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      target: targetOf(node),
      detail: [...node.any, ...node.all, ...node.none][0]?.message ?? '',
    })),
  )
}

/**
 * Compares the problems found on one screen with the baseline entries of that screen. The match is exact: an entry covers
 * one rule on one element, so the same rule on another element is a new problem, and an entry that nothing matches any
 * more is `gone` (the list must not outlive its problems).
 */
export function compareWithBaseline(problems, baseline, screen) {
  const same = (a, b) => a.rule === b.rule && a.target === b.target
  const listed = baseline.filter((entry) => entry.screen === screen)
  return {
    fresh: problems.filter((problem) => !listed.some((entry) => same(entry, problem))),
    gone: listed.filter((entry) => !problems.some((problem) => same(entry, problem))),
  }
}

/** The report of a failing scan: what is wrong and where, rule by rule, then the baseline entries to remove. Empty when there is nothing to say. */
export function formatReport(screen, { fresh, gone }) {
  const lines = []
  if (fresh.length) {
    lines.push(`${fresh.length} accessibility problem(s) on "${screen}":`)
    for (const rule of [...new Set(fresh.map((problem) => problem.rule))]) {
      const ofRule = fresh.filter((problem) => problem.rule === rule)
      lines.push(`  ${rule} (${ofRule[0].impact}): ${ofRule[0].help} ${ofRule[0].helpUrl}`)
      for (const problem of ofRule) {
        lines.push(`    ${problem.target}`)
        if (problem.detail) lines.push(`      ${problem.detail}`)
      }
    }
  }
  if (gone.length) {
    const one = gone.length === 1
    lines.push(`${gone.length} entr${one ? 'y' : 'ies'} of e2e/a11y-baseline.js no longer ${one ? 'occurs' : 'occur'} on "${screen}": remove ${one ? 'it' : 'them'}.`)
    for (const entry of gone) lines.push(`    ${entry.rule}: ${entry.target}`)
  }
  return lines.join('\n')
}

/**
 * The screens that the spec scans, read from its source, so that a baseline entry for a screen that was renamed or removed
 * can be found without running a browser. A scan is named by a plain string: `scanBothThemes(page, 'name')` scans
 * "name [light]" and "name [dark]", and `{ context: 'name [print]' }` names one scan. `unreadable` lists the lines that
 * name a scan in another way (a template, a variable), which this reading cannot follow: there must be none.
 */
export function scannedContexts(specSource) {
  const contexts = new Set()
  const unreadable = []
  for (const line of specSource.split('\n')) {
    if (line.trim().startsWith('//')) continue
    if (/function scanBothThemes/.test(line) || line.includes('context: `${screen} [${scheme}]`')) continue // the helper itself
    const both = line.includes('scanBothThemes(page,')
    if (both) {
      const named = /scanBothThemes\(page, '([^'\\]+)'/.exec(line)
      if (named) {
        contexts.add(`${named[1]} [light]`)
        contexts.add(`${named[1]} [dark]`)
      } else unreadable.push(line.trim())
    }
    if (/\bcontext:/.test(line)) {
      const named = /\bcontext: '([^'\\]+)'/.exec(line)
      if (named) contexts.add(named[1])
      else unreadable.push(line.trim())
    }
  }
  return { contexts, unreadable }
}

/** The baseline entries whose screen is not one that is scanned: nothing would ever check them. */
export function entriesForUnscannedScreens(baseline, contexts) {
  return baseline.filter((entry) => !contexts.has(entry.screen))
}
