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

describe('the same design on a phone and on a computer', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'pages', 'AdminApp.jsx'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'src', 'admin', 'admin.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('the provider-app, light/dark and sign-out controls are the same three icons in the side rail and in the top bar', () => {
    expect(app.match(/<ShellTools onSignOut=\{signOut\} \/>/g)).toHaveLength(2) // once in .a-side, once in .a-top
    const tools = app.slice(app.indexOf('function ShellTools'), app.indexOf('function Shell('))
    expect(tools).toContain('label="אפליקציית נותני השירות"')
    expect(tools).toContain('<ThemeSwitch')
    expect(tools).toContain('label="יציאה"')
  })

  it('the page icons are the same in the side rail and in the bottom bar, at the same size', () => {
    const sizes = [...app.matchAll(/<NavItem [^>]*className="(a-nav__item|a-tab)" size=\{(\d+)\}/g)].map((m) => `${m[1]}:${m[2]}`)
    expect(sizes).toEqual(['a-nav__item:24', 'a-tab:24'])
    expect(app.match(/TABS\.map\(\(t\) => <NavItem/g)).toHaveLength(2) // one list of icons feeds both
  })

  it('the side rail keeps no text buttons for them (only the page links stay as rows)', () => {
    expect(app).not.toMatch(/className="a-nav__item" href=/)
    expect(app).not.toMatch(/<button className="a-nav__item" onClick=\{signOut\}/)
    const theme = fs.readFileSync(path.join(root, 'src', 'ui', 'ThemeSwitch.jsx'), 'utf8')
    expect(theme).not.toMatch(/variant/)
  })

  it('a date field stays inside its column, and always reads DD/MM/YYYY (the native date field did neither on iPhone)', () => {
    const rule = css.match(/\.a-input--date\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('min-width: 0')
    expect(rule).toContain('direction: ltr') // the digits run left to right, not jumbled by an RTL page
    expect(css).toMatch(/\.a-filters > \*\s*\{\s*min-width:\s*0/)
    expect(css).not.toContain("[type='date']") // no native date field is left to style
    for (const f of views) expect(read(f), `${f} uses a native date field`).not.toMatch(/type=["']date["']/)
  })
})

describe('the tiles and headers of the committee screens', () => {
  it('red is used for exactly one thing, deleting, and every screen that lists things has it', () => {
    const uses = views.flatMap((f) => [...read(f).matchAll(/<IconButton([^>]*tone="danger"[^>]*)/g)].map((m) => [f, m[1]]))
    expect(uses.map(([f]) => f).sort()).toEqual([
      'AgentView.jsx', 'CommitteeView.jsx', 'HistoryView.jsx', 'PointsView.jsx', 'ProvidersView.jsx',
    ])
    for (const [f, attrs] of uses) expect(attrs, `${f}: a red button must be a trash can`).toContain('icon={IconTrash}')
  })

  it('the red trash can is the last icon of every tile and row, so it sits in the same place on every screen', () => {
    let groups = 0
    for (const f of views) {
      const found = [...read(f).matchAll(/className="(?:a-card__tools|a-scan__tools)">([\s\S]*?)\n\s*<\/div>/g)].map((m) => m[1])
      for (const group of found) {
        groups++
        // from the last button of the group to its end there is that button only, and it is the trash can
        const fromLast = group.slice(group.lastIndexOf('<IconButton'))
        expect(fromLast, `${f}: the last action of a tile is the trash can`).toContain('icon={IconTrash}')
      }
    }
    expect(groups, 'points, providers, committee, agent keys and history rows').toBe(5)
  })

  it('removing something that can come back (switching off) uses the same icon on every screen: a circle with a bar', () => {
    for (const f of ['PointsView.jsx', 'ProvidersView.jsx', 'CommitteeView.jsx', 'AgentView.jsx', 'HistoryView.jsx']) {
      expect(read(f), f).toMatch(/icon=\{[^}]*IconBan[^}]*\}/)
    }
  })

  it('no tile keeps a row of text buttons at its bottom (the actions are icons in its header)', () => {
    for (const f of views) expect(read(f), `${f} still has a tile actions row`).not.toContain('a-card__actions')
  })

  it('every page that adds something offers it as the primary round button', () => {
    for (const f of ['PointsView.jsx', 'ProvidersView.jsx', 'CommitteeView.jsx', 'AgentView.jsx']) {
      expect(read(f), f).toMatch(/icon=\{IconPlus\}[^>]*tone="primary"/)
    }
  })

  it('deleting a point is a real delete, and the confirmation says its scans stay in the history', () => {
    const src = read('PointsView.jsx')
    expect(src).toMatch(/adminApi\(`\/points\/\$\{p\.id\}`, \{ method: 'DELETE' \}\)/)
    expect(src).toContain('בהיסטוריה, עם שם הנקודה')
    expect(src).toContain('מחיקת הנקודה')
  })

  it('every history row has a delete button, with a confirmation that offers cancelling instead', () => {
    const src = read('HistoryView.jsx')
    expect(src).toMatch(/adminApi\(`\/scans\/\$\{s\.id\}`, \{ method: 'DELETE' \}\)/)
    expect(src).toContain('אי אפשר לשחזר אותה')
    expect(src).toContain('אפשר לבטל אותה במקום')
    // the trash can is outside the "accepted only" condition: a refused attempt can be cleaned up too
    expect(src).toMatch(/<\/div>\s*<\/li>/)
    expect(src).toMatch(/\)\}\s*<IconButton icon=\{IconTrash\} label="מחיקת הנוכחות לצמיתות"/)
  })
})
