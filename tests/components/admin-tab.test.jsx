// @vitest-environment jsdom
// The tab of the committee app follows the address (#history). The real AdminApp, signed in, with the network (`api`)
// answered by the test: every screen gets an empty list, which is enough to show its heading.
//
// What went wrong: the tab was read from the address once, in the first render, and the listener for a change of the address
// was attached later, in an effect. A change that came in between was lost and the app stayed on the first tab. A link that is
// opened right after sign-in (or a test that does `page.goto('/admin#history')` at that moment) hit it. The address is now
// an external store that React subscribes to (src/admin/tab.js): after subscribing React reads it again, so nothing is lost.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import AdminApp from '../../src/pages/AdminApp.jsx'
import { tabFromHash } from '../../src/admin/tab.js'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const ADMIN = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Sample Member', email: 'member@example.test' }
const TITLE_SUFFIX = ' · נוכחות בבניין'

// Each tab: its key in the address, the label on its button, and the heading that its screen draws.
const TABS = [
  { key: 'points', label: 'נקודות', heading: 'נקודות סריקה' },
  { key: 'providers', label: 'נותני שירות', heading: 'נותני שירות' },
  { key: 'history', label: 'היסטוריה', heading: 'היסטוריית נוכחות' },
  { key: 'agent', label: 'אייג׳נט', heading: "גישה לאייג'נט" },
  { key: 'committee', label: 'ועד', heading: 'חברי הוועד' },
]
const byKey = Object.fromEntries(TABS.map((t) => [t.key, t]))

window.scrollTo = vi.fn() // the shell scrolls to the top on a tab change; jsdom has no scrolling

afterEach(() => {
  cleanup()
  vi.restoreAllMocks() // the spy on window.addEventListener
  window.history.replaceState(null, '', '/')
  document.title = ''
  vi.clearAllMocks()
})

function answerLikeTheServer() {
  api.mockImplementation(async (path) => {
    if (path === '/admin/config') return { google_client_id: '', dev_login: false }
    if (path === '/admin/me') return { admin: ADMIN }
    if (path === '/admin/points') return { points: [] }
    if (path === '/admin/providers') return { providers: [] }
    if (path.startsWith('/admin/scans')) return { scans: [], next_cursor: null }
    if (path === '/admin/api-keys') return { api_keys: [] }
    if (path === '/admin/admins') return { admins: [] }
    if (path === '/admin/building') return { building: { address: '' } }
    throw new Error(`the test does not expect ${path}`)
  })
}

const heading = (tab) => screen.findByRole('heading', { level: 1, name: byKey[tab].heading })
// The page that is shown now, by the headings of the five screens. At most one of them is there.
const shown = () => TABS.filter((t) => screen.queryByRole('heading', { level: 1, name: t.heading })).map((t) => t.key)
// Both navigations are in the page (the side rail and the tab bar of the phone: CSS hides one), so a button is found twice.
const buttons = (tab) => screen.getAllByRole('button', { name: byKey[tab].label })
const current = (tab) => buttons(tab).map((b) => b.getAttribute('aria-current'))

/** A person (or a test) opens another address of the same page: the address changes, and the browser says so. */
async function openByAddress(hash) {
  await act(async () => {
    window.location.hash = hash
    await new Promise((resolve) => setTimeout(resolve, 20)) // jsdom fires `hashchange` a moment later, as a browser does
  })
}

describe('the tab that the address names when the app opens', () => {
  it.each(TABS)('opens $key from #$key', async ({ key }) => {
    answerLikeTheServer()
    window.history.replaceState(null, '', `/#${key}`)
    render(<AdminApp />)
    await heading(key)
    expect(shown()).toEqual([key])
    expect(current(key)).toEqual(['page', 'page'])
    await waitFor(() => expect(document.title).toBe(`${byKey[key].label}${TITLE_SUFFIX}`)) // the title is set by an effect after the heading is drawn
  })

  it.each([['no hash', ''], ['an empty hash', '#'], ['a name that is not a tab', '#nowhere'], ['a tab with something after it', '#history?x=1'], ['the wrong case', '#History']])(
    'opens the first tab for %s',
    async (_what, hash) => {
      answerLikeTheServer()
      window.history.replaceState(null, '', `/${hash}`)
      render(<AdminApp />)
      await heading('points')
      expect(shown()).toEqual(['points'])
      expect(current('points')).toEqual(['page', 'page'])
    },
  )
})

describe('the address that changes between the first render and the listener', () => {
  it('opens the tab that the address names by then (the race)', async () => {
    answerLikeTheServer()
    let moved = 0
    const attach = window.addEventListener.bind(window)
    // Just before the app attaches its listener for `hashchange`, the address changes the way a link that is opened at that
    // moment changes it. `replaceState` fires no `hashchange`, so only reading the address again after subscribing can see it.
    vi.spyOn(window, 'addEventListener').mockImplementation((type, ...rest) => {
      if (type === 'hashchange' && moved === 0) {
        moved += 1
        window.history.replaceState(null, '', '#history')
      }
      return attach(type, ...rest)
    })

    render(<AdminApp />)
    // the shell is drawn and has attached its listener, and the address changed just before that
    await waitFor(() => expect(moved, 'the address changed before the listener was attached').toBe(1))
    await heading('history')
    expect(shown()).toEqual(['history'])
    expect(current('history')).toEqual(['page', 'page'])
    await waitFor(() => expect(document.title).toBe(`${byKey.history.label}${TITLE_SUFFIX}`)) // the title is set by an effect after the heading is drawn
  })
})

describe('changing the tab while the app is open', () => {
  it('follows a change of the address, and a change back, and goes to the first tab when the address names none', async () => {
    answerLikeTheServer()
    render(<AdminApp />)
    await heading('points')

    await openByAddress('#history')
    await heading('history')
    expect(shown()).toEqual(['history'])
    await waitFor(() => expect(document.title).toBe(`${byKey.history.label}${TITLE_SUFFIX}`)) // the title is set by an effect after the heading is drawn

    await openByAddress('#committee')
    await heading('committee')
    expect(shown()).toEqual(['committee'])

    await openByAddress('#nowhere')
    await heading('points')
    expect(shown()).toEqual(['points'])
  })

  it('follows the back button', async () => {
    answerLikeTheServer()
    render(<AdminApp />)
    await heading('points')
    await openByAddress('#providers')
    await heading('providers')
    await openByAddress('#agent')
    await heading('agent')

    await act(async () => {
      window.history.back()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await heading('providers')
    expect(shown()).toEqual(['providers'])
    expect(window.location.hash).toBe('#providers')
  })

  it.each(TABS)('opens $key from its button (the one in the side rail and the one in the tab bar) and puts it in the address', async ({ key }) => {
    answerLikeTheServer()
    for (const index of [0, 1]) {
      // from the first tab each time, so that every button has somewhere to go from
      window.history.replaceState(null, '', '/#points')
      render(<AdminApp />)
      await heading('points')

      fireEvent.click(buttons(key)[index])
      await heading(key)
      await waitFor(() => expect(window.location.hash).toBe(`#${key}`))
      expect(shown()).toEqual([key])
      expect(current(key)).toEqual(['page', 'page'])
      for (const other of TABS.filter((t) => t.key !== key)) expect(current(other.key), `${other.key} is not the current page`).toEqual([null, null])
      await waitFor(() => expect(document.title).toBe(`${byKey[key].label}${TITLE_SUFFIX}`)) // the title is set by an effect after the heading is drawn
      cleanup()
    }
  })
})

describe('tabFromHash', () => {
  const keys = ['one', 'two', 'three']
  it('names the tab after the #, and the first key for anything else', () => {
    expect(tabFromHash(keys, '#two')).toBe('two')
    expect(tabFromHash(keys, '#three')).toBe('three')
    expect(tabFromHash(keys, '')).toBe('one')
    expect(tabFromHash(keys, '#')).toBe('one')
    expect(tabFromHash(keys, '#four')).toBe('one')
    expect(tabFromHash(keys, '#Two')).toBe('one')
    expect(tabFromHash(keys, 'two')).toBe('one') // `slice(1)` takes the # off: a hash always starts with one
  })

  it('reads the address of the page when it is not given a hash', () => {
    window.history.replaceState(null, '', '/#three')
    expect(tabFromHash(keys)).toBe('three')
  })
})
