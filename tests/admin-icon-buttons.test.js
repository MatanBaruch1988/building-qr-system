// Secondary actions in the committee app are shown as icons (IconButton). Red is only for removing something.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { IconButton } from '../src/admin/ui.jsx'
import { IconTrash, IconEdit, IconPlus } from '../src/admin/icons.jsx'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const views = fs.readdirSync(path.join(root, 'src', 'admin', 'views')).filter((f) => f.endsWith('.jsx'))
const read = (f) => fs.readFileSync(path.join(root, 'src', 'admin', 'views', f), 'utf8')
const html = (el) => renderToStaticMarkup(el)

describe('IconButton', () => {
  it('is a button with the label as its accessible name and its tooltip, and no visible text', () => {
    const out = html(React.createElement(IconButton, { icon: IconEdit, label: 'עריכה', onClick: () => {} }))
    expect(out).toContain('<button')
    expect(out).toContain('type="button"')
    expect(out).toContain('aria-label="עריכה"')
    expect(out).toContain('title="עריכה"')
    expect(out).toContain('class="a-icon-btn"')
    expect(out.replace(/<svg[\s\S]*?<\/svg>/, '').replace(/<[^>]+>/g, '')).toBe('') // nothing but the icon
  })

  it('has a danger and a primary look, and a link form for downloads', () => {
    expect(html(React.createElement(IconButton, { icon: IconTrash, label: 'x', tone: 'danger' }))).toContain('a-icon-btn a-icon-btn--danger')
    expect(html(React.createElement(IconButton, { icon: IconPlus, label: 'x', tone: 'primary' }))).toContain('a-icon-btn a-icon-btn--primary')
    const link = html(React.createElement(IconButton, { icon: IconEdit, label: 'ייצוא', href: '/x.csv', download: 'x.csv' }))
    expect(link).toContain('<a ')
    expect(link).toContain('href="/x.csv"')
    expect(link).toContain('download="x.csv"')
    expect(link).toContain('aria-label="ייצוא"')
  })

  it('passes disabled through', () => {
    expect(html(React.createElement(IconButton, { icon: IconEdit, label: 'x', disabled: true }))).toContain('disabled')
  })
})

describe('icon button styling', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'admin', 'admin.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  it('is grey, with no edge and no fill, and turns the palette blue on hover, press and focus', () => {
    const base = rule('.a-icon-btn')
    expect(base).toContain('background: none')
    expect(base).toContain('border: 0')
    expect(base).toContain('var(--w-text-2)')
    expect(css).toMatch(/\.a-icon-btn:hover:not\(:disabled\)\s*\{\s*color:\s*var\(--w-info\)/)
    expect(css).toMatch(/\.a-icon-btn:active:not\(:disabled\),\s*\.a-icon-btn:focus-visible\s*\{\s*color:\s*var\(--w-info\);\s*outline:\s*none/)
  })

  it('the danger one is red at rest and stays red', () => {
    expect(rule('.a-icon-btn--danger, .a-icon-btn--danger:focus-visible')).toContain('var(--w-danger)')
    expect(css).not.toMatch(/\.a-icon-btn--danger:hover:not\(:disabled\)\s*\{[^}]*--w-info/)
  })

  it('the primary one is a filled round button with white icon', () => {
    const primary = rule('.a-icon-btn--primary, .a-icon-btn--primary:focus-visible')
    expect(primary).toContain('background: var(--w-primary)')
    expect(primary).toContain('color: #fff')
    expect(primary).toContain('border-radius: 50%')
  })
})

describe('the tiles and headers of the committee screens', () => {
  it('red is used for exactly one thing: removing a point', () => {
    const uses = views.flatMap((f) => [...read(f).matchAll(/<IconButton[^>]*tone="danger"/g)].map(() => f))
    expect(uses).toEqual(['PointsView.jsx'])
    expect(read('PointsView.jsx')).toMatch(/icon=\{IconTrash\}[^>]*tone="danger"/)
  })

  it('no tile keeps a row of text buttons at its bottom (the actions are icons in its header)', () => {
    for (const f of views) expect(read(f), `${f} still has a tile actions row`).not.toContain('a-card__actions')
  })

  it('every page that adds something offers it as the primary round button', () => {
    for (const f of ['PointsView.jsx', 'ProvidersView.jsx', 'CommitteeView.jsx', 'AgentView.jsx']) {
      expect(read(f), f).toMatch(/icon=\{IconPlus\}[^>]*tone="primary"/)
    }
  })

  it('removing a point keeps its history: it deactivates, and says so', () => {
    const src = read('PointsView.jsx')
    expect(src).toContain("body: { is_active: false }")
    expect(src).toContain('כל ההיסטוריה שלה נשמרת')
    expect(src).not.toMatch(/method: 'DELETE'/)
  })
})
