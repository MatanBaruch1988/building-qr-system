// @vitest-environment jsdom
// The committee app tells the server what went wrong in it (ADR 0007, decision 3; src/ui/errorReport.js, src/ui/crash.js, useErrorReport
// in src/admin/hooks.js, the screen and the sign-out in src/pages/AdminApp.jsx). The provider app's side is in
// tests/components/error-report.test.jsx, and the outbox, the reporter and the global handlers on their own in tests/components/error-report-outbox.test.js.
//
// What this file proves, with the real AdminApp and the real ErrorBoundary, and the network (`api`) answered by the test:
//   - a crash is put on the tab that was open (`committee:<tab>`), also when the shell breaks the first time it is drawn, and the screen
//     is `committee:login` on the sign-in screen and `committee:app` outside any screen;
//   - a forced sign-out (a 401 `admin_required` that `adminApi` announces) is noted once, with the tab it happened on; the person's own
//     sign-out and a visit with nobody signed in are not noted;
//   - the report goes to POST /api/admin/client-errors (the cookie travels by itself) once `/me` has confirmed the session, after a
//     sign-in and when the page comes back to the foreground; never for nobody, never offline, at most once a minute, a crash before sign-in
//     waits for the sign-in, and only the committee's own entries are sent;
//   - a 401 is handled by `adminApi` as for any call (the sign-in screen), a 404 stops the reports until the app starts again, and any other
//     failure is silent (nothing reaches the console).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import AdminApp from '../../src/pages/AdminApp.jsx'
import ErrorBoundary from '../../src/ui/ErrorBoundary.jsx'
import { crashRootOptions } from '../../src/ui/crash.js'
import { ERRORS_KEY, ERROR_REPORT_MIN_INTERVAL_MS, currentPlace, noteClientError, readOutbox, setPlace } from '../../src/ui/errorReport.js'
import { api } from '../../src/api/client.js'
import he from '../../src/i18n/he.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const ADMIN = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Sample Member', email: 'member@example.test' }
const START = Date.parse('2026-10-05T08:00:00.000Z')
const MINUTE = ERROR_REPORT_MIN_INTERVAL_MS
const EXPIRED_NOTICE = 'פג תוקף ההתחברות. היכנסו שוב.'
const TAB_KEYS = ['points', 'providers', 'history', 'agent', 'committee']

const refusal = (status, code) => Object.assign(new Error('refused'), { status, code })

/** What the server answers, by route. A test changes these. */
const server = {
  config: async () => ({ google_client_id: '', dev_login: true }),
  me: async () => ({ admin: ADMIN }),
  devLogin: async () => ({ admin: ADMIN }),
  points: async () => ({ points: [] }),
  errors: async () => ({ ok: true, recorded: 1 }),
}
const defaults = { ...server }

let clock = START

window.scrollTo = vi.fn() // the shell scrolls to the top on a tab change; jsdom has no scrolling

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/admin')
  vi.restoreAllMocks()
  vi.clearAllMocks()
  Object.assign(server, defaults)
  setPlace(null)
  clock = START
  document.title = ''
})

function answerLikeTheServer() {
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  api.mockImplementation(async (path, options = {}) => {
    if (path === '/admin/config') return server.config()
    if (path === '/admin/me') return server.me()
    if (path === '/admin/dev-login') return server.devLogin()
    if (path === '/admin/logout') return { ok: true }
    if (path === '/admin/client-errors') return server.errors(options)
    if (path === '/admin/points') return server.points()
    if (path === '/admin/providers') return { providers: [] }
    if (path.startsWith('/admin/scans')) return { scans: [], next_cursor: null }
    if (path.startsWith('/admin/scan-refusals')) return { refusals: [], next_cursor: null }
    if (path === '/admin/api-keys') return { api_keys: [] }
    if (path === '/admin/admins') return { admins: [] }
    if (path === '/admin/building') return { building: { address: '' } }
    throw new Error(`the test does not expect ${path}`)
  })
}

// Testing Library takes onCaughtError (what a boundary caught) and not onUncaughtError: the boundary is above the whole app
const start = () => render(<ErrorBoundary><AdminApp /></ErrorBoundary>, { onCaughtError: crashRootOptions.onCaughtError })
const open = (tab) => window.history.replaceState(null, '', `/admin#${tab}`)
const crash = { kind: 'crash', place: 'committee:points', name: 'Error' }
const note = (event, times = 1) => { for (let i = 0; i < times; i++) noteClientError(event) }
const reports = () => api.mock.calls.filter(([path]) => path === '/admin/client-errors')
const quiet = () => ['error', 'warn'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const settleWell = async () => { for (let i = 0; i < 4; i++) await settle() }
const comeBackToTheApp = () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
const signedIn = () => screen.findByRole('heading', { level: 1, name: 'נקודות סריקה' })
const loginScreen = () => screen.findByRole('heading', { level: 1, name: 'ניהול נוכחות הבניין' })
const crashTitle = () => screen.findByRole('heading', { name: he['crash.title'] })
const devSignIn = async () => fireEvent.click(await screen.findByRole('button', { name: 'כניסת פיתוח' }))
const sessionExpires = () => act(() => { window.dispatchEvent(new Event('admin-session-expired')) })
const outbox = (events) => window.localStorage.setItem(ERRORS_KEY, JSON.stringify(events))

describe('the committee app: the screen comes from its own state', () => {
  it('is committee:app while the app loads, and when there is no connection', async () => {
    answerLikeTheServer()
    let answer
    server.config = () => new Promise((resolve) => { answer = () => resolve({ google_client_id: '', dev_login: true }) })
    start()
    expect(currentPlace()).toBe('committee:app')
    await act(async () => { answer() })
    await signedIn()
    expect(currentPlace()).toBe('committee:points')
  })

  it('is committee:app on the screen that says there is no connection', async () => {
    answerLikeTheServer()
    server.config = async () => { throw refusal(0, 'network') }
    start()
    await screen.findByRole('heading', { name: 'אין חיבור לשרת' })
    expect(currentPlace()).toBe('committee:app')
  })

  it('is committee:login on the sign-in screen', async () => {
    answerLikeTheServer()
    server.me = async () => { throw refusal(401, 'admin_required') }
    start()
    await loginScreen()
    expect(currentPlace()).toBe('committee:login')
  })

  it.each(TAB_KEYS)('is committee:%s with that tab open, and follows the tab when it changes', async (tab) => {
    answerLikeTheServer()
    open(tab)
    start()
    await screen.findAllByRole('button', { name: /./ })
    await waitFor(() => expect(currentPlace()).toBe(`committee:${tab}`))
    const other = TAB_KEYS.find((key) => key !== tab)
    await act(async () => {
      window.location.hash = other
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await waitFor(() => expect(currentPlace()).toBe(`committee:${other}`))
  })

  it('is committee:login again after the person signs out', async () => {
    answerLikeTheServer()
    start()
    await signedIn()
    fireEvent.click(screen.getAllByRole('button', { name: 'יציאה' })[0])
    await loginScreen()
    expect(currentPlace()).toBe('committee:login')
  })

  describe('and a crash is put on the tab that was open', () => {
    // The committee member's name arrives as an object: the shell cannot draw it, the first time it is drawn.
    it.each(TAB_KEYS)('committee:%s: the shell breaks the first time it is drawn', async (tab) => {
      const logged = quiet()[0]
      answerLikeTheServer()
      server.me = async () => ({ admin: { name: { first: 'x' }, email: 'a@example.test' } })
      open(tab)
      start()
      await crashTitle()
      expect(readOutbox()).toEqual([{ kind: 'crash', place: `committee:${tab}`, name: 'Error', build: 'dev', count: 1 }])
      expect(logged.mock.calls).toEqual([['Screen crash (committee app): Error']])
    })
  })
})

describe('a forced sign-out is noted', () => {
  it('when a call finds the session gone: with the tab that was open and the code, and the person sees the sign-in screen', async () => {
    answerLikeTheServer()
    open('agent')
    start()
    await screen.findAllByRole('button', { name: /./ })
    await waitFor(() => expect(currentPlace()).toBe('committee:agent'))
    await sessionExpires()
    await loginScreen()
    expect(screen.getByText(EXPIRED_NOTICE)).toBeTruthy()
    expect(readOutbox()).toEqual([{ kind: 'signed_out', place: 'committee:agent', code: 'admin_required', build: 'dev', count: 1 }])
  })

  it('through the real call: a screen\'s request that the server answers with 401 admin_required', async () => {
    answerLikeTheServer()
    server.points = async () => { throw refusal(401, 'admin_required') }
    start()
    await loginScreen()
    expect(screen.getByText(EXPIRED_NOTICE)).toBeTruthy()
    expect(readOutbox()).toEqual([{ kind: 'signed_out', place: 'committee:points', code: 'admin_required', build: 'dev', count: 1 }])
  })

  it('once, however many calls find the session gone at the same time', async () => {
    answerLikeTheServer()
    start()
    await signedIn()
    await act(async () => {
      for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('admin-session-expired'))
    })
    await loginScreen()
    expect(readOutbox()).toEqual([expect.objectContaining({ kind: 'signed_out', count: 1 })])
  })

  it('and not sent at once, for the session that has just ended: nobody is signed in', async () => {
    answerLikeTheServer()
    start()
    await signedIn()
    // The first draw of the shell has not run its effects yet, or the person has not seen the sign-in screen yet: either way a report that
    // is asked for in that moment must not go out with a session that is gone.
    await act(async () => {
      window.dispatchEvent(new Event('admin-session-expired'))
      comeBackToTheApp()
    })
    await loginScreen()
    await settleWell()
    expect(reports()).toHaveLength(0)
    expect(readOutbox()).toEqual([expect.objectContaining({ kind: 'signed_out', count: 1 })])
  })

  it('and noted again when it happens again after signing in', async () => {
    answerLikeTheServer()
    server.errors = () => new Promise(() => {}) // the report of the first is never answered, so it is still there
    start()
    await signedIn()
    await sessionExpires()
    await loginScreen()
    await devSignIn()
    await signedIn()
    await sessionExpires()
    await loginScreen()
    expect(readOutbox()).toEqual([expect.objectContaining({ kind: 'signed_out', count: 2 })])
  })

  it('not when nobody was signed in: the sign-in screen at app start is not a sign-out', async () => {
    answerLikeTheServer()
    server.me = async () => { throw refusal(401, 'admin_required') }
    start()
    await loginScreen()
    await sessionExpires() // something that was already in flight when the app started
    await settleWell()
    expect(readOutbox()).toEqual([])
    expect(window.localStorage.getItem(ERRORS_KEY)).toBeNull()
  })

  it('and not when the person signs out: that is their choice', async () => {
    answerLikeTheServer()
    start()
    await signedIn()
    fireEvent.click(screen.getAllByRole('button', { name: 'יציאה' })[0])
    await loginScreen()
    await settleWell()
    expect(readOutbox()).toEqual([])
  })
})

describe('the report', () => {
  it('is sent once `/me` has confirmed the session: through the committee\'s own API client, with no token, only the committee\'s entries', async () => {
    answerLikeTheServer()
    outbox([
      { ...crash, build: 'abc1234', count: 3 },
      { kind: 'crash', place: 'provider:home', name: 'TypeError', build: 'dev', count: 1 },
    ])
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))

    const [path, options] = reports()[0]
    expect(path).toBe('/admin/client-errors')
    expect(options).toMatchObject({ method: 'POST' })
    expect(options).not.toHaveProperty('token') // the session travels in a cookie
    expect(options.timeoutMs).toBeGreaterThan(0)
    expect(options.body).toEqual({ events: [{ kind: 'crash', place: 'committee:points', name: 'Error', build: 'abc1234', count: 3 }] })
    const order = api.mock.calls.map(([p]) => p)
    expect(order.indexOf('/admin/client-errors')).toBeGreaterThan(order.indexOf('/admin/me')) // after the session check, never before it
    // what the server took is gone, and the provider app's entry waits for the provider app
    await waitFor(() => expect(readOutbox()).toEqual([{ kind: 'crash', place: 'provider:home', name: 'TypeError', build: 'dev', count: 1 }]))
  })

  it('is not sent when nothing is noted', async () => {
    answerLikeTheServer()
    start()
    await signedIn()
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(0)
  })

  it('is not sent for nobody: a crash before sign-in waits, and goes out when somebody signs in', async () => {
    answerLikeTheServer()
    server.me = async () => { throw refusal(401, 'admin_required') }
    outbox([{ kind: 'crash', place: 'committee:login', name: 'TypeError', build: 'dev', count: 1 }])
    start()
    await loginScreen()
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(0)
    expect(readOutbox()).toHaveLength(1)

    await devSignIn()
    await waitFor(() => expect(reports()).toHaveLength(1))
    expect(reports()[0][1].body).toEqual({ events: [{ kind: 'crash', place: 'committee:login', name: 'TypeError', build: 'dev', count: 1 }] })
    await waitFor(() => expect(readOutbox()).toEqual([]))
  })

  it('goes out again when the page comes back to the foreground and something was noted since, but not inside a minute of the last one', async () => {
    answerLikeTheServer()
    outbox([{ ...crash, build: 'dev', count: 1 }])
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))

    note({ kind: 'unhandled', place: 'committee:points', name: 'RangeError' })
    clock += MINUTE - 1
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(1) // too soon

    clock += 1
    comeBackToTheApp()
    await waitFor(() => expect(reports()).toHaveLength(2))
    expect(reports()[1][1].body).toEqual({ events: [{ kind: 'unhandled', place: 'committee:points', name: 'RangeError', build: 'dev', count: 1 }] })
  })

  it('sends nothing while the browser says it is offline, and sends when it is back', async () => {
    answerLikeTheServer()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    outbox([{ ...crash, build: 'dev', count: 1 }])
    start()
    await signedIn()
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(0)

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    comeBackToTheApp()
    await waitFor(() => expect(reports()).toHaveLength(1))
  })
})

describe('what the server answers to a report', () => {
  const noted = () => outbox([{ ...crash, build: 'dev', count: 1 }])

  it('a 401 is handled by adminApi as for any call: the sign-in screen with the notice, and the sign-out is noted next to the crash', async () => {
    answerLikeTheServer()
    server.errors = async () => { throw refusal(401, 'admin_required') }
    noted()
    start()
    await loginScreen()
    expect(screen.getByText(EXPIRED_NOTICE)).toBeTruthy()
    expect(readOutbox()).toEqual([
      { ...crash, build: 'dev', count: 1 }, // not lost
      { kind: 'signed_out', place: 'committee:points', code: 'admin_required', build: 'dev', count: 1 },
    ])
    expect(reports()).toHaveLength(1) // and no second try of its own
  })

  it('a 404 (a server from before the endpoint) stops the reports until the app starts again, and keeps the entries', async () => {
    answerLikeTheServer()
    server.errors = async () => { throw refusal(404, 'not_found') }
    noted()
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))
    await settleWell()
    await signedIn() // still signed in, nothing shown

    for (let i = 0; i < 3; i++) {
      note({ kind: 'unhandled', place: 'committee:points', name: `Error${i}` })
      clock += MINUTE
      comeBackToTheApp()
      await settleWell()
    }
    expect(reports()).toHaveLength(1)
    expect(readOutbox()).toHaveLength(4)
  })

  it.each([
    ['a server that fails', () => { throw refusal(500, 'server_error') }],
    ['no signal', () => { throw refusal(0, 'network') }],
    ['an answer that is not "ok"', async () => ({})],
  ])('%s is silent: nothing in the console, the person stays signed in, and the same events are tried a minute later', async (_what, answer) => {
    const logged = quiet()
    answerLikeTheServer()
    server.errors = answer
    noted()
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))
    await settleWell()
    await signedIn()
    expect(readOutbox()).toHaveLength(1)

    clock += MINUTE
    comeBackToTheApp()
    await waitFor(() => expect(reports()).toHaveLength(2))
    expect(reports()[1][1].body).toEqual(reports()[0][1].body)
    expect(logged.flatMap((spy) => spy.mock.calls)).toEqual([])
  })
})
