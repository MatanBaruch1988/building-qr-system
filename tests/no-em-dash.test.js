// The em dash (U+2014) is never used anywhere in this project: not in the screens, the code, the comments or the
// documents. Use a comma, a colon, a full stop or parentheses instead. The character, the folders to skip and the kind
// of file to read come from scripts/text-rules.mjs, which builds the character from its code point so that no file
// here contains it either. The Claude Code edit hook (scripts/hooks/check-edit.mjs) checks the same rule.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EM_DASH, SKIP_DIRS, TEXT, SKIP_FILES, findEmDashLines } from '../scripts/text-rules.mjs'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')

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
      for (const { line, text } of findEmDashLines(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(root, file)}:${line}: ${text.slice(0, 80)}`)
      }
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
