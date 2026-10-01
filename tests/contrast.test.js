// Both themes are held to WCAG AA (4.5:1 for text, 3:1 for the edge of a control and for the focus ring), computed
// from the real tokens in src/ui/ui.css, so a colour change that breaks readability fails here.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const css = fs.readFileSync(new URL('../src/ui/ui.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const block = (selectorStart) => {
  const at = css.indexOf(selectorStart)
  if (at < 0) throw new Error(`no rule starting with ${selectorStart}`)
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
}
const tokens = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))

const parse = (value) => {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4, 6), 16), a: 1 }
  const rgba = value.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/)
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] }
  throw new Error(`cannot parse colour ${value}`)
}
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 })
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

const themes = {
  dark: tokens(block('.w-app, .a-app')),
  light: tokens(block(":root[data-theme='light'] .w-app")),
}
// The light block only overrides: anything it does not mention comes from the dark one, so check the merge.
themes.light = { ...themes.dark, ...themes.light }

describe.each(Object.entries(themes))('%s theme meets WCAG AA', (name, t) => {
  const c = (token) => parse(t[token])
  const pairs = []
  const check = (label, fg, bg, min) => pairs.push([label, fg, bg, min])

  const surfaces = { bg: c('--w-bg'), surface: c('--w-surface'), 'surface-2': c('--w-surface-2') }
  for (const [sn, s] of Object.entries(surfaces)) {
    for (const k of ['--w-text', '--w-text-2', '--w-text-3']) check(`${k} on ${sn}`, c(k), s, 4.5)
  }
  check('white on primary', parse('#ffffff'), c('--w-primary'), 4.5)
  check('white on primary (hover)', parse('#ffffff'), c('--w-primary-hover'), 4.5)
  for (const sn of ['surface', 'surface-2', 'bg']) {
    check(`field border on ${sn}`, c('--w-field-border'), surfaces[sn], 3)
    check(`field border (hover) on ${sn}`, c('--w-field-border-hover'), surfaces[sn], 3)
    check(`focus ring on ${sn}`, c('--w-focus'), surfaces[sn], 3)
  }
  for (const kind of ['success', 'warn', 'danger', 'info']) {
    for (const sn of ['surface', 'bg']) {
      check(`--w-${kind} on ${sn}`, c(`--w-${kind}`), surfaces[sn], 4.5)
      const tint = over(c(`--w-${kind}-bg`), surfaces[sn])
      check(`--w-${kind} on its tint over ${sn}`, c(`--w-${kind}`), tint, 4.5)
      check(`--w-text on the ${kind} tint over ${sn}`, c('--w-text'), tint, 4.5)
    }
  }

  it.each(pairs)(`${name}: %s`, (label, fg, bg, min) => {
    expect(ratio(fg, bg), `${label}: ${ratio(fg, bg).toFixed(2)}:1, needs ${min}:1`).toBeGreaterThanOrEqual(min)
  })
})

describe('controls do not lose their own type and colour to the reset', () => {
  // `.w-app button { font: inherit; color: inherit }` outranked a plain `.w-btn { color: #fff; font-weight: ... }`, so a
  // button took the colour around it (green on blue on the "recorded" screen; dark on blue in the light theme) and
  // lost its weight and size. The reset must have no specificity of its own.
  it('resets controls inside :where(), so the class rules win', () => {
    expect(css).toContain(':where(.w-app, .a-app) :where(button, select, input, textarea) { font: inherit; color: inherit; }')
    expect(css).not.toMatch(/\.w-app button|\.a-app button/)
  })
  it('the filled button is white text on the primary colour', () => {
    expect(css).toMatch(/\.w-btn \{[^}]*background: var\(--w-primary\); color: #fff;/)
  })
})

describe('the two themes define the same set of tokens', () => {
  it('light overrides only tokens that exist in dark, and every dark token is themed', () => {
    const raw = tokens(block(":root[data-theme='light'] .w-app"))
    for (const token of Object.keys(raw)) expect(themes.dark, token).toHaveProperty(token)
    // colour tokens all differ between the themes (a forgotten one would stay dark on a light page)
    const mustDiffer = Object.keys(themes.dark).filter((k) => /^--w-(bg|surface|border|field|text|focus|overlay|shadow)/.test(k))
    for (const token of mustDiffer) expect(raw[token], `${token} is not themed`).toBeDefined()
  })
})
