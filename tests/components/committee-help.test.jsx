// @vitest-environment jsdom
// The short guide in the Committee tab (src/admin/views/HelpSection.jsx, its text in src/admin/help.js): a section that a button
// opens, closed at first, with flat <h3> topics, in Hebrew, short, and in the names that the screens use. The real section and
// the real Committee tab, with the network (`adminApi`) answered by the test.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import HelpSection from '../../src/admin/views/HelpSection.jsx'
import CommitteeView from '../../src/admin/views/CommitteeView.jsx'
import { HELP_TOPICS, HELP_MAX_LENGTH } from '../../src/admin/help.js'
import { ToastProvider, ConfirmProvider } from '../../src/admin/ui.jsx'
import { adminApi } from '../../src/admin/api.js'
import { EM_DASH } from '../../scripts/text-rules.mjs'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))
vi.mock('../../src/admin/api.js', async (importOriginal) => ({ ...(await importOriginal()), adminApi: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const BUTTON = 'איך עובדים עם המערכת'
// The topics, in the order of the screen: the names that the owner chose.
const TOPICS = [
  'נקודות ושלטי QR',
  'נותני שירות והטלפונים שלהם',
  "היסטוריה ו'לא נקלטו'",
  "האייג'נט",
  'יומן הפעולות',
  'כשמגיעה התראה',
  'כשטלפון תקוע',
]

const opener = () => screen.getByRole('button', { name: BUTTON })
const panelOf = () => document.getElementById(opener().getAttribute('aria-controls'))
const topics = () => screen.queryAllByRole('heading', { level: 3 })
/** Everything that a person can read when the guide is open: the button and the topics. */
const readable = () => `${opener().textContent}${panelOf().textContent}`
const mount = () => render(<HelpSection />)

describe('the section', () => {
  it('is closed at first: a button that is the heading of the section, a panel that is hidden, and no topic', () => {
    mount()
    expect(opener().getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('heading', { level: 2, name: BUTTON }).contains(opener())).toBe(true)
    expect(panelOf().hidden).toBe(true)
    expect(topics()).toHaveLength(0)
    expect(panelOf().textContent).toBe('') // nothing is drawn while it is closed
  })

  it('is a region that the button names, and the button controls the panel that follows it', () => {
    mount()
    const region = screen.getByRole('region', { name: BUTTON })
    expect(region.contains(opener())).toBe(true)
    expect(region.contains(panelOf())).toBe(true)
    expect(opener().getAttribute('type')).toBe('button')
  })

  it('opens with the button and closes with the same button, and aria-expanded follows', () => {
    mount()
    fireEvent.click(opener())
    expect(opener().getAttribute('aria-expanded')).toBe('true')
    expect(panelOf().hidden).toBe(false)
    expect(topics().length).toBeGreaterThan(0)
    fireEvent.click(opener())
    expect(opener().getAttribute('aria-expanded')).toBe('false')
    expect(panelOf().hidden).toBe(true)
    expect(topics()).toHaveLength(0)
    fireEvent.click(opener())
    expect(opener().getAttribute('aria-expanded')).toBe('true') // and again
  })

  it('keeps the same button and panel when it opens (the id that aria-controls names does not change)', () => {
    mount()
    const panel = panelOf()
    const id = opener().getAttribute('aria-controls')
    fireEvent.click(opener())
    expect(panelOf()).toBe(panel)
    expect(opener().getAttribute('aria-controls')).toBe(id)
  })

  it('has no action in it: only the one button, and no link', () => {
    mount()
    fireEvent.click(opener())
    expect(within(panelOf()).queryAllByRole('button')).toHaveLength(0)
    expect(within(panelOf()).queryAllByRole('link')).toHaveLength(0)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('the topics', () => {
  it('has a heading for every topic, flat (<h3>), in the order of the screen, and nothing else', () => {
    mount()
    fireEvent.click(opener())
    expect(topics().map((h) => h.textContent)).toEqual(TOPICS)
    expect(topics()).toHaveLength(HELP_TOPICS.length)
    expect(within(panelOf()).queryAllByRole('heading').filter((h) => h.tagName !== 'H3')).toHaveLength(0) // no heading of another level
  })

  it('has under each heading its sentences, as text', () => {
    mount()
    fireEvent.click(opener())
    for (const topic of HELP_TOPICS) {
      const text = screen.getByText(topic.text)
      expect(text.tagName).toBe('P')
      const heading = screen.getByRole('heading', { level: 3, name: topic.title })
      expect(heading.nextElementSibling).toBe(text)
    }
  })

  it('is two to four short sentences for each topic', () => {
    for (const { title, text } of HELP_TOPICS) {
      const sentences = text.split(/[.!?](?=\s|$)/).map((s) => s.trim()).filter(Boolean)
      expect(sentences.length, `${title}: sentences`).toBeGreaterThanOrEqual(2)
      expect(sentences.length, `${title}: sentences`).toBeLessThanOrEqual(4)
      for (const s of sentences) expect(s.length, `${title}: a sentence of ${s.length} characters: ${s}`).toBeLessThanOrEqual(160)
    }
  })

  it('is short: everything that a person can read when it is open is within the limit (about 3,000 characters)', () => {
    expect(HELP_MAX_LENGTH, 'the limit was not raised').toBeLessThanOrEqual(3000)
    mount()
    fireEvent.click(opener())
    expect(readable().length).toBeLessThanOrEqual(HELP_MAX_LENGTH)
    expect(readable().length, 'and it says something').toBeGreaterThan(800)
  })

  it('has no em dash and no stray markup', () => {
    mount()
    fireEvent.click(opener())
    expect(readable()).not.toContain(EM_DASH)
    expect(JSON.stringify(HELP_TOPICS)).not.toContain(EM_DASH)
    expect(readable()).not.toMatch(/[<>{}]/)
  })

  it('is plain text: the sentences make no element, whatever they hold', () => {
    mount()
    fireEvent.click(opener())
    expect(panelOf().querySelectorAll('*:not(div):not(h3):not(p)')).toHaveLength(0)
  })

  it('is in Hebrew', () => {
    for (const { title, text } of HELP_TOPICS) {
      expect(title, 'a title in Hebrew').toMatch(/[֐-׿]/)
      expect(text, `${title}: text in Hebrew`).toMatch(/[֐-׿]/)
    }
  })
})

describe('the names that the guide quotes', () => {
  // A name between double quotes is a button, a tab or a field of the committee app. The guide is only useful if the name is
  // there on a screen, so each one must be written in the source of the committee app, as a text of its own (between quotes,
  // or between the tags of an element). A screen that renames a button fails here until the guide says the new name.
  const source = (() => {
    const files = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|jsx)$/.test(entry.name) && entry.name !== 'help.js') files.push(full)
      }
    }
    walk(path.join(process.cwd(), 'src', 'admin'))
    files.push(path.join(process.cwd(), 'src', 'pages', 'AdminApp.jsx'))
    return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  })()
  const quoted = [...new Set(HELP_TOPICS.flatMap(({ text }) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1])))]
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  it('finds the quoted names at all (the check is not empty)', () => {
    expect(quoted.length).toBeGreaterThan(15)
    for (const name of ['נקודה חדשה', 'הדפסת שלט', 'מכשירים', 'יומן פעולות', 'לא נקלטו']) expect(quoted).toContain(name)
  })

  it.each(quoted)('"%s" is written on a screen of the committee app', (name) => {
    expect(source, name).toMatch(new RegExp(`["'\`>]${escape(name)}["'\`<]`))
  })
})

describe('in the Committee tab', () => {
  const committee = () => {
    adminApi.mockImplementation(async (apiPath) => {
      if (apiPath === '/admins') return { admins: [] }
      if (apiPath === '/building') return { building: { address: '' } }
      throw new Error(`unexpected call ${apiPath}`)
    })
    render(<ToastProvider><ConfirmProvider><CommitteeView admin={{ id: 'a1', name: 'Dana', email: 'dana@example.test' }} /></ConfirmProvider></ToastProvider>)
  }
  const after = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('is closed, after the building card and before the version line and the audit log, and asks the server for nothing', async () => {
    committee()
    const building = await screen.findByLabelText('כתובת הבניין')
    expect(opener().getAttribute('aria-expanded')).toBe('false')
    expect(topics()).toHaveLength(0)
    const version = screen.getByText('גרסה').closest('p')
    const audit = screen.getByRole('button', { name: 'יומן פעולות' })
    expect(after(building, opener())).toBe(true)
    expect(after(opener(), version)).toBe(true)
    expect(after(opener(), audit)).toBe(true)
    expect(adminApi.mock.calls.map(([p]) => p).sort()).toEqual(['/admins', '/building']) // opening a guide is not a request
  })

  it('opens without touching the audit log, which stays the last section of the page', async () => {
    committee()
    await screen.findByLabelText('כתובת הבניין')
    fireEvent.click(opener())
    expect(topics().map((h) => h.textContent)).toEqual(TOPICS)
    expect(screen.getByRole('button', { name: 'יומן פעולות' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getAllByRole('button', { name: /יומן פעולות|איך עובדים/ })).toHaveLength(2)
    const sections = [...document.querySelectorAll('section')]
    expect(sections.at(-1).className).toBe('a-audit-section')
    expect(sections.map((s) => s.className)).toContain('a-help-section')
    expect(adminApi.mock.calls.map(([p]) => p).sort()).toEqual(['/admins', '/building'])
  })
})
