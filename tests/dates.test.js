// Every date and time a person sees is DD/MM/YYYY and HH:MM (shared/datetime.js). This tests the writer itself, and
// guards the code: another way of writing a date (a month name, a weekday, the browser's own date field, the device's
// locale) fails here before it reaches a screen.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  formatDate, formatTime, formatDateTime, formatDay, isoDay, parseDay, maskDay,
} from '../shared/datetime.js'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')

describe('writing a moment: DD/MM/YYYY and HH:MM in the building time', () => {
  it('summer time (UTC+3) and winter time (UTC+2)', () => {
    expect(formatDateTime('2026-09-30T05:12:00Z')).toBe('30/09/2026 08:12')
    expect(formatDateTime('2026-01-15T10:00:00Z')).toBe('15/01/2026 12:00')
    expect(formatDate('2026-09-30T05:12:00Z')).toBe('30/09/2026')
    expect(formatTime('2026-09-30T05:12:00Z')).toBe('08:12')
  })

  it('the day changes at midnight in the building, not in UTC, and midnight is 00:30, never 24:30', () => {
    expect(formatDateTime('2026-09-30T21:30:00Z')).toBe('01/10/2026 00:30')
    expect(formatDateTime('2026-09-30T20:59:00Z')).toBe('30/09/2026 23:59')
  })

  it('follows the clock change at the end of October', () => {
    expect(formatDateTime('2026-10-24T20:00:00Z')).toBe('24/10/2026 23:00')
    expect(formatDateTime('2026-10-25T20:00:00Z')).toBe('25/10/2026 22:00')
  })

  it('takes a Date or an ISO string, and shows "-" for no date or a bad one', () => {
    expect(formatDateTime(new Date('2026-09-30T05:12:00Z'))).toBe('30/09/2026 08:12')
    for (const nothing of [null, undefined, '', 'not a date', NaN]) {
      expect(formatDateTime(nothing)).toBe('-')
      expect(formatDate(nothing)).toBe('-')
      expect(formatTime(nothing)).toBe('-')
    }
  })

  it('always has the same shape, for any moment', () => {
    let seed = 1
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let i = 0; i < 300; i++) {
      const moment = new Date(Date.UTC(2020, 0, 1) + Math.floor(random() * 12 * 365 * 86_400_000))
      expect(formatDateTime(moment), moment.toISOString()).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)
      expect(formatTime(moment)).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/)
    }
  })

  it('does not depend on the language or region of the machine it runs on', () => {
    const before = formatDateTime('2026-09-30T05:12:00Z')
    const keep = process.env.LANG
    process.env.LANG = 'ar_EG.UTF-8'
    expect(formatDateTime('2026-09-30T05:12:00Z')).toBe(before)
    process.env.LANG = keep
  })
})

describe('a calendar day', () => {
  it("is the building's day as the API writes it, and as a person reads it", () => {
    expect(isoDay('2026-09-30T21:30:00Z')).toBe('2026-10-01')
    expect(formatDay('2026-10-01')).toBe('01/10/2026')
    expect(formatDay('')).toBe('-')
    expect(formatDay('1 Oct 2026')).toBe('-')
    expect(isoDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('is read back from what a person types, only when it is a real date', () => {
    expect(parseDay('01/10/2026')).toBe('2026-10-01')
    expect(parseDay(' 29/02/2028 ')).toBe('2028-02-29') // a leap year
    for (const bad of ['31/02/2026', '29/02/2027', '00/10/2026', '1/10/2026', '01-10-2026', '2026-10-01', '01/10/1999', '01/10/2101', '', null]) {
      expect(parseDay(bad), String(bad)).toBeNull()
    }
  })

  it('is masked while typing: the slashes come by themselves, digits only, nothing past the year', () => {
    expect(maskDay('')).toBe('')
    expect(maskDay('0')).toBe('0')
    expect(maskDay('01')).toBe('01')
    expect(maskDay('011')).toBe('01/1')
    expect(maskDay('0110')).toBe('01/10')
    expect(maskDay('01102026')).toBe('01/10/2026')
    expect(maskDay('01/10/2026999')).toBe('01/10/2026')
    expect(maskDay('ab01x10')).toBe('01/10')
    expect(maskDay('01/1')).toBe('01/1') // already masked text stays as it is
  })
})

// ---- the guard ---------------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])
function walk(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(path.join(dir, entry.name))
    return /\.(js|jsx|mjs)$/.test(entry.name) ? [path.join(dir, entry.name).replace(/\\/g, '/')] : []
  })
}

describe('no other way of writing a date in the code', () => {
  const files = ['src', 'server', 'shared'].flatMap(walk)
  // Ways of writing a date or a time that depend on the device or show a month name or a weekday, or a date field that
  // shows the device's own format.
  const FORBIDDEN = [
    [/toLocale(Date|Time)?String/, 'toLocaleDateString / toLocaleTimeString / toLocaleString'],
    [/\bdateStyle\b|\btimeStyle\b/, 'dateStyle / timeStyle'],
    [/toDateString|toTimeString|toUTCString/, 'toDateString / toTimeString / toUTCString'],
    [/type=["'](date|time|datetime-local|month|week)["']/, 'a native date or time field'],
    [/\bweekday\s*:|\bmonth\s*:\s*['"](long|short|narrow)/, 'a weekday or a month name'],
  ]
  // Intl.DateTimeFormat is only for shared/datetime.js; server/scans.js also has the API's own machine format
  // ('2026-09-30 08:12:00', read by the agent), which is not for people and must not change.
  const INTL_ALLOWED = new Set(['shared/datetime.js', 'server/scans.js'])

  it('the code that writes dates is the shared module, with the API machine format as the one exception', () => {
    expect(files.length).toBeGreaterThan(40)
    const offenders = []
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) offenders.push(`${file}: ${what}`)
      if (/Intl\.DateTimeFormat/.test(text) && !INTL_ALLOWED.has(file)) offenders.push(`${file}: Intl.DateTimeFormat (use shared/datetime.js)`)
    }
    expect(offenders, `another way of writing a date:\n${offenders.join('\n')}`).toEqual([])
  })

  it("the machine string of the API ('YYYY-MM-DD HH:mm:ss') is never shown on a screen", () => {
    const shown = files.filter((f) => f.startsWith('src/') && !f.endsWith('AgentView.jsx')) // AgentView only names it, in the text for the agent
    for (const file of shown) {
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file).not.toContain('checked_in_local')
    }
  })

  it('the committee screens write dates through the shared module', () => {
    const history = fs.readFileSync(path.join(root, 'src/admin/views/HistoryView.jsx'), 'utf8')
    expect(history).toContain("from '../../../shared/datetime.js'")
    expect(history).toMatch(/<DateInput value=\{filters\.from\}/)
    expect(history).toMatch(/<DateInput value=\{filters\.to\}/)
    const hooks = fs.readFileSync(path.join(root, 'src/admin/hooks.js'), 'utf8')
    expect(hooks).toContain("export { formatDateTime } from '../../shared/datetime.js'")
  })
})
