import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { THEME_KEY, THEMES, CHROME_COLORS, isTheme, readTheme, resolveTheme, applyTheme } from '../src/ui/theme.js'

const storageWith = (value) => ({ getItem: (k) => (k === THEME_KEY ? value : null) })

describe('theme choice', () => {
  it('is one of system | light | dark, and "system" (follow the device) is the default', () => {
    expect(THEMES).toEqual(['system', 'light', 'dark'])
    expect(readTheme(storageWith(null))).toBe('system')
    expect(readTheme(storageWith(undefined))).toBe('system')
  })

  it('reads a saved choice, and treats anything else as "system"', () => {
    expect(readTheme(storageWith('light'))).toBe('light')
    expect(readTheme(storageWith('dark'))).toBe('dark')
    expect(readTheme(storageWith('system'))).toBe('system')
    for (const junk of ['', 'auto', 'LIGHT', '1', '{}', 'null']) expect(readTheme(storageWith(junk)), junk).toBe('system')
  })

  it('survives storage that is blocked (private mode) or missing', () => {
    expect(readTheme({ getItem: () => { throw new Error('denied') } })).toBe('system')
    expect(readTheme(null)).toBe('system')
  })

  it('isTheme only accepts the three values', () => {
    for (const ok of THEMES) expect(isTheme(ok)).toBe(true)
    for (const bad of ['auto', '', null, undefined, 1]) expect(isTheme(bad)).toBe(false)
  })
})

describe('resolveTheme: the device decides only when the person has not chosen', () => {
  it('follows the device on "system"', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
  })
  it('ignores the device once a mode is chosen', () => {
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
  })
})

describe('applyTheme', () => {
  const fakeDoc = () => {
    const metas = { 'meta[name="theme-color"]': { content: '#0b0b0d' }, 'meta[name="color-scheme"]': { content: 'light dark' } }
    return {
      doc: {
        documentElement: { dataset: {}, style: {} },
        querySelector: (sel) => (metas[sel] ? { setAttribute: (name, value) => { metas[sel][name] = value } } : null),
      },
      metas,
    }
  }

  it('puts the resolved theme on <html>, and matches the browser chrome colour to it', () => {
    const light = fakeDoc()
    expect(applyTheme('system', { doc: light.doc, prefersLight: true })).toBe('light')
    expect(light.doc.documentElement.dataset.theme).toBe('light')
    expect(light.doc.documentElement.style.colorScheme).toBe('light')
    expect(light.metas['meta[name="theme-color"]'].content).toBe(CHROME_COLORS.light)

    const dark = fakeDoc()
    expect(applyTheme('dark', { doc: dark.doc, prefersLight: true })).toBe('dark')
    expect(dark.doc.documentElement.dataset.theme).toBe('dark')
    expect(dark.metas['meta[name="theme-color"]'].content).toBe(CHROME_COLORS.dark)
  })

  it('works on a page without the meta tags', () => {
    const doc = { documentElement: { dataset: {}, style: {} }, querySelector: () => null }
    expect(applyTheme('light', { doc })).toBe('light')
  })
})

describe('index.html applies the same theme before the first paint', () => {
  // The page has no inline script (the Content-Security-Policy allows none), so the code that applies the theme is a file of
  // public/, loaded by a script tag of index.html. The comments are dropped first: a word in a comment must not satisfy a check.
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const script = fs.readFileSync(new URL('../public/theme-boot.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((match) => ({ attributes: match[1], body: match[2], at: match.index }))
  const bootTags = tags.filter((tag) => /\bsrc="\/theme-boot\.js"/.test(tag.attributes))

  it('has a script file that reads the same storage key and values', () => {
    expect(script).toContain(`'${THEME_KEY}'`)
    for (const value of ['light', 'dark', 'system']) expect(script).toContain(`'${value}'`)
    expect(script).toContain('prefers-color-scheme: light')
    expect(script).toContain("setAttribute('data-theme'")
  })

  it('uses the same browser-chrome colours as theme.js', () => {
    expect(script).toContain(CHROME_COLORS.light)
    expect(script).toContain(CHROME_COLORS.dark)
  })

  it('has no inline script: every script tag has a src and an empty body', () => {
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) {
      expect(tag.attributes, 'a script tag without a src').toMatch(/\bsrc="[^"]+"/)
      expect(tag.body.trim(), 'a script tag with code in it').toBe('')
    }
  })

  it('loads theme-boot.js once, as a classic script: no async, no defer, no type (it must block the parser)', () => {
    expect(bootTags).toHaveLength(1)
    expect(bootTags[0].attributes).not.toMatch(/\b(async|defer|type)\b/i)
  })

  it('runs before the stylesheet-bearing module script (so there is no flash)', () => {
    const moduleAt = tags.find((tag) => /\btype="module"/.test(tag.attributes))?.at ?? -1
    expect(moduleAt).toBeGreaterThan(-1)
    const bootAt = bootTags[0]?.at ?? -1
    expect(bootAt).toBeGreaterThan(-1)
    expect(bootAt).toBeLessThan(moduleAt)
  })
})
