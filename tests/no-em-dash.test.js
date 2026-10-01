// The em dash (U+2014) is never used anywhere in this project: not in the screens, the code, the comments or the
// documents. Use a comma, a colon, a full stop or parentheses instead. The character is built from its code point so
// that this file does not contain it either.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const EM_DASH = String.fromCharCode(0x2014)
const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
// .claude is the assistant tooling's own workspace (notes it writes for itself), not part of the project.
// playwright-report, test-results and blob-report are what Playwright generates (its report is a bundle of its own code).
const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.vercel', '.claude', 'coverage', 'playwright-report', 'test-results', 'blob-report',
])
const TEXT = /\.(js|jsx|mjs|cjs|css|html|md|json|sql|txt|yml|yaml)$|^\.env\.example$|^\.gitignore$/
const SKIP_FILES = new Set(['package-lock.json'])

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(path.join(dir, entry.name))
    return TEXT.test(entry.name) && !SKIP_FILES.has(entry.name) ? [path.join(dir, entry.name)] : []
  })
}

describe('no em dash anywhere', () => {
  it('finds none in any source, document, style, page or data file of the project', () => {
    const files = walk(root)
    expect(files.length).toBeGreaterThan(50) // the walk really covers the project
    const offenders = []
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (line.includes(EM_DASH)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 80)}`)
      })
    }
    expect(offenders, `em dash found:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the translations in particular (every language) are free of it', () => {
    for (const lang of ['he', 'en', 'ru', 'ar']) {
      const text = fs.readFileSync(path.join(root, 'src', 'i18n', `${lang}.js`), 'utf8')
      expect(text.includes(EM_DASH), lang).toBe(false)
    }
  })
})
