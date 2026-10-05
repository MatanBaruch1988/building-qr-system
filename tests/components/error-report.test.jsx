// @vitest-environment jsdom
// The provider app tells the server what went wrong on the phone (ADR 0007, decision 3; src/ui/errorReport.js, src/ui/crash.js,
// useErrorReport in src/worker/hooks.js, the screen and the sign-out in src/pages/WorkerApp.jsx). The committee app's side is in
// tests/components/error-report-committee.test.jsx, and the outbox, the reporter and the global handlers on their own in
// tests/components/error-report-outbox.test.js.
//
// What this file proves, with the real ErrorBoundary and the real WorkerApp, and the network (`api`) answered by the test:
//   - the boundary notes a crash with the error's name and nothing of its message, on the screen the app said it was showing;
//   - the screen comes from the app's own state (the sign-in list, the home screen, a check-in in progress, its result), also for
//     a screen that breaks the first time it is drawn;
//   - a forced sign-out (a 401 on a call made with the session) is noted once, with the code that the server answered and the
//     screen it happened on, whichever call met it; the person's own sign-out is not noted;
//   - the report goes to POST /api/my/errors with the session's token once the server has confirmed the stored session, when somebody
//     has just signed in, and when the app comes back to the foreground; never for nobody, never offline, at most once a minute, and
//     a crash before sign-in waits for the sign-in;
//   - a 401 signs the person out the way every other call of the app does, a 404 stops the reports until the app starts again, and
//     any other failure is silent (nothing reaches the console).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { render, renderHook, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import WorkerApp from '../../src/pages/WorkerApp.jsx'
import { useErrorReport } from '../../src/worker/hooks.js'
import ErrorBoundary from '../../src/ui/ErrorBoundary.jsx'
import { crashRootOptions } from '../../src/ui/crash.js'
import { ERRORS_KEY, ERROR_REPORT_MIN_INTERVAL_MS, currentPlace, noteClientError, readOutbox, setPlace } from '../../src/ui/errorReport.js'
import { api } from '../../src/api/client.js'
import he from '../../src/i18n/he.js'
import { PROVIDER_TOKEN_PREFIX } from '../../shared/contract.js'
import { SAMPLE_PROVIDER_NAMES } from '../../scripts/sample-data.mjs'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const SESSION_KEY = 'qr.session'
const TOKEN = PROVIDER_TOKEN_PREFIX + 'a'.repeat(43)
const NEW_TOKEN = PROVIDER_TOKEN_PREFIX + 'b'.repeat(43)
const ploni = { id: '00000000-0000-4000-8000-000000000001', company: 'ניקיון', contact_name: SAMPLE_PROVIDER_NAMES.cleaner, service_type: 'cleaning' }
const almoni = { id: '00000000-0000-4000-8000-000000000002', company: 'גינון', contact_name: SAMPLE_PROVIDER_NAMES.gardener, service_type: 'gardening' }
const START = Date.parse('2026-10-05T08:00:00.000Z')
const MINUTE = ERROR_REPORT_MIN_INTERVAL_MS
const CODE = 'BQR-sample-000000001'
const SECRET = 'fake-person-7731@example.test 050-0000000'
const POINT = { name: 'לובי', description: '', is_active: true, gps_mode: 'none' }
const SCAN = { id: 'scan-1', outcome: 'accepted', point_name: 'לובי', checked_in_at: '2026-10-05T08:00:00.000Z' }

const forever = () => new Promise(() => {}) // an answer that never comes
const refusal = (status, code) => Object.assign(new Error('refused'), { status, code })

/** What the server answers, by route. A test changes these. */
const server = {
  check: async () => ({ provider: ploni }),
  signIn: { token: NEW_TOKEN, provider: ploni },
  errors: async () => ({ ok: true, recorded: 1 }),
  status: async () => ({ ok: true, build: null }),
  sync: async ({ body }) => ({ results: body.scans.map((s) => ({ id: s.id, ok: true, scan: { outcome: 'accepted' } })) }),
  providers: async () => ({ providers: [ploni, almoni] }),
  resolve: async () => ({ point: POINT }),
  scan: async () => ({ scan: SCAN, duplicate: false }),
  scans: async () => ({ scans: [] }),
}
const defaults = { ...server }

let clock = START

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
  vi.clearAllMocks()
  Object.assign(server, defaults)
  setPlace(null)
  clock = START
})

function answerLikeTheServer() {
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  api.mockImplementation(async (path, options = {}) => {
    if (path === '/public/providers') return server.providers()
    if (path === '/public/building') return { building: { address: 'Sample Street 1' } }
    if (path.startsWith('/public/points/resolve')) return server.resolve()
    if (path === '/my/scans') return server.scans()
    if (path === '/session' && options.method === 'POST') return server.signIn
    if (path === '/session' && !options.method) return server.check()
    if (path === '/session' && options.method === 'DELETE') return { ok: true }
    if (path === '/my/device-status') return server.status(options)
    if (path === '/my/errors') return server.errors(options)
    if (path === '/scan') return server.scan(options)
    if (path === '/scans/sync') return server.sync(options)
    throw new Error(`the test does not expect ${path}`)
  })
}

// Testing Library takes onCaughtError (what a boundary caught) and not onUncaughtError: the boundary is above the whole app, so this is the one that main.jsx's root uses here
const start = () => render(<ErrorBoundary><WorkerApp /></ErrorBoundary>, { onCaughtError: crashRootOptions.onCaughtError })
const store = ({ outbox = [], queue = [] } = {}) => {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify({ token: TOKEN, provider: ploni }))
  if (outbox.length) window.localStorage.setItem(ERRORS_KEY, JSON.stringify(outbox))
  if (queue.length) window.localStorage.setItem('qr.queue.v1', JSON.stringify(queue))
}
const note = (event, times = 1) => { for (let i = 0; i < times; i++) noteClientError(event) }
const crash = { kind: 'crash', place: 'provider:home', name: 'TypeError' }
const reports = () => api.mock.calls.filter(([path]) => path === '/my/errors')
const callOrder = () => api.mock.calls.map(([path, options]) => `${options?.method ?? 'GET'} ${path}`)
const quiet = () => ['error', 'warn'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const settleWell = async () => { for (let i = 0; i < 4; i++) await settle() }
const comeBackToTheApp = () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
const signInHeading = () => screen.findByRole('heading', { name: he['login.title'] })
const greeting = () => screen.getByRole('heading', { name: /^שלום,/ })
const crashTitle = () => screen.findByRole('heading', { name: he['crash.title'] })
const signInAsPloni = async () => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(ploni.contact_name) }))
  fireEvent.change(screen.getByLabelText(he['login.passwordLabel'], { selector: 'input' }), { target: { value: 'sample-pass-1' } })
  fireEvent.click(screen.getByRole('button', { name: he['login.submit'] }))
}

describe('the boundary notes a crash', () => {
  const SecretChild = ({ error }) => { throw error }
  const mount = (ui) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container, crashRootOptions)
    act(() => root.render(ui))
    return () => { act(() => root.unmount()); container.remove() }
  }

  it('with the error\'s name, the screen that the app was showing and the build, and nothing that the error said', () => {
    const logged = quiet()[0]
    const error = new TypeError(`Cannot read properties of ${SECRET}`)
    error.stack = `TypeError: ${SECRET}\n    at Secret (https://example.test/assets/index-abc.js:1:2)`
    const unmount = mount(<ErrorBoundary app="provider"><SecretChild error={error} /></ErrorBoundary>)
    expect(readOutbox()).toEqual([{ kind: 'crash', place: 'provider:app', name: 'TypeError', build: 'dev', count: 1 }])
    const raw = window.localStorage.getItem(ERRORS_KEY)
    for (const value of [SECRET, 'Secret', 'index-abc', 'Cannot read']) expect(raw).not.toContain(value)
    expect(logged.mock.calls).toEqual([['Screen crash (provider app): TypeError']]) // the one console line that a crash has always had
    unmount()
  })

  it('on the screen that was set, whichever app it is', () => {
    quiet()
    window.history.replaceState(null, '', '/admin')
    const Screen = () => { setPlace('committee:history'); throw new RangeError('x') }
    const unmount = mount(<ErrorBoundary><Screen /></ErrorBoundary>)
    expect(readOutbox()).toEqual([{ kind: 'crash', place: 'committee:history', name: 'RangeError', build: 'dev', count: 1 }])
    unmount()
  })

  it('outside any screen it is provider:app in the provider app and committee:app in the committee app', () => {
    quiet()
    const unmount = mount(<ErrorBoundary><SecretChild error={new Error('x')} /></ErrorBoundary>)
    unmount()
    window.history.replaceState(null, '', '/admin')
    mount(<ErrorBoundary><SecretChild error={new Error('x')} /></ErrorBoundary>)()
    expect(readOutbox().map((e) => e.place)).toEqual(['provider:app', 'committee:app'])
  })

  it('"UnknownError" for something that is thrown and is not an error', () => {
    quiet()
    mount(<ErrorBoundary app="provider"><SecretChild error={`a plain string holding ${SECRET}`} /></ErrorBoundary>)()
    expect(readOutbox()).toEqual([{ kind: 'crash', place: 'provider:app', name: 'UnknownError', build: 'dev', count: 1 }])
    expect(window.localStorage.getItem(ERRORS_KEY)).not.toContain(SECRET)
  })

  it('once for each crash: "Try again" that fails again is a second one, in the same entry', () => {
    quiet()
    const unmount = mount(<ErrorBoundary app="provider"><SecretChild error={new TypeError('x')} /></ErrorBoundary>)
    fireEvent.click(screen.getByRole('button', { name: he['crash.retry'] }))
    expect(readOutbox()).toEqual([{ kind: 'crash', place: 'provider:app', name: 'TypeError', build: 'dev', count: 2 }])
    unmount()
  })

  it('also for a crash that no boundary caught (a blank page, but a noted one)', async () => {
    quiet()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false // inside act() React hands the error back to the test instead of calling onUncaughtError
    try {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container, crashRootOptions)
      root.render(<SecretChild error={new TypeError('x')} />)
      await vi.waitFor(() => expect(readOutbox()).toHaveLength(1))
      expect(readOutbox()[0]).toMatchObject({ kind: 'crash', name: 'TypeError', count: 1 })
      root.unmount()
      container.remove()
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true
    }
  })
})

describe('the provider app: the screen comes from its own state', () => {
  it('is provider:login on the sign-in list', async () => {
    answerLikeTheServer()
    start()
    await signInHeading()
    expect(currentPlace()).toBe('provider:login')
  })

  it('is provider:home once somebody is signed in', async () => {
    answerLikeTheServer()
    store()
    start()
    await waitFor(() => expect(greeting()).toBeTruthy())
    expect(currentPlace()).toBe('provider:home')
  })

  it('is provider:working while a scanned code is being looked up', async () => {
    answerLikeTheServer()
    server.resolve = forever
    store()
    window.history.replaceState(null, '', `/scan?code=${CODE}`)
    start()
    await settleWell() // the lookup of the code never ends, so the progress screen stays
    expect(currentPlace()).toBe('provider:working')
  })

  it('is provider:working while a check-in is in progress', async () => {
    answerLikeTheServer()
    server.scan = forever
    store()
    window.history.replaceState(null, '', `/scan?code=${CODE}`)
    start()
    await waitFor(() => expect(api.mock.calls.some(([path]) => path === '/scan')).toBe(true))
    expect(currentPlace()).toBe('provider:working')
  })

  it('is provider:result when the check-in has an answer, and provider:home again after "done"', async () => {
    answerLikeTheServer()
    store()
    window.history.replaceState(null, '', `/scan?code=${CODE}`)
    start()
    await screen.findByRole('heading', { name: he['checkin.success.title'] })
    expect(currentPlace()).toBe('provider:result')
    fireEvent.click(screen.getByRole('button', { name: he['checkin.done'] }))
    await waitFor(() => expect(greeting()).toBeTruthy())
    expect(currentPlace()).toBe('provider:home')
  })

  it('goes back to provider:login when the person is signed out', async () => {
    answerLikeTheServer()
    store()
    start()
    await waitFor(() => expect(greeting()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: he['home.switchWorker'] }))
    await signInHeading()
    expect(currentPlace()).toBe('provider:login')
  })

  describe('and a crash is put on the screen that broke', () => {
    it('provider:login: the list of people cannot be drawn', async () => {
      const logged = quiet()[0]
      answerLikeTheServer()
      server.providers = async () => ({ providers: [{ id: 'p-1', company: { not: 'text' }, contact_name: { not: 'text' } }] })
      start()
      await crashTitle()
      expect(readOutbox()).toEqual([expect.objectContaining({ kind: 'crash', place: 'provider:login', count: 1 })])
      expect(readOutbox()[0].name).toMatch(/^[A-Za-z]\w*$/)
      expect(logged.mock.calls).toHaveLength(1)
    })

    it('provider:home: the list of today\'s visits cannot be drawn (the first draw of the screen was fine)', async () => {
      const logged = quiet()[0]
      answerLikeTheServer()
      server.scans = async () => ({ scans: null })
      store()
      start()
      await crashTitle()
      expect(readOutbox()).toEqual([{ kind: 'crash', place: 'provider:home', name: 'TypeError', build: 'dev', count: 1 }])
      expect(logged.mock.calls).toEqual([['Screen crash (provider app): TypeError']])
    })

    it('provider:working: a check-in is in progress when it breaks', async () => {
      quiet()
      answerLikeTheServer()
      server.resolve = forever // the scanned code is still being looked up, so the working screen is what is drawn
      server.scans = async () => ({ scans: null })
      store()
      window.history.replaceState(null, '', `/scan?code=${CODE}`)
      start()
      await crashTitle()
      expect(readOutbox()).toEqual([{ kind: 'crash', place: 'provider:working', name: 'TypeError', build: 'dev', count: 1 }])
    })

    it('provider:result: the answer is on the screen when the list of visits that it asked for comes back broken', async () => {
      quiet()
      answerLikeTheServer()
      let release
      let asked = 0
      server.scans = () => (++asked === 1 ? { scans: [] } : new Promise((resolve) => { release = () => resolve({ scans: null }) })) // the second list is the one that the check-in asks for
      store()
      window.history.replaceState(null, '', `/scan?code=${CODE}`)
      start()
      await screen.findByRole('heading', { name: he['checkin.success.title'] })
      await waitFor(() => expect(release).toBeTypeOf('function'))
      act(() => release())
      await crashTitle()
      expect(readOutbox()).toEqual([{ kind: 'crash', place: 'provider:result', name: 'TypeError', build: 'dev', count: 1 }])
    })
  })
})

describe('a forced sign-out is noted', () => {
  it('when the session check at app start finds the session gone: with the code of the answer, on the screen that was shown', async () => {
    answerLikeTheServer()
    server.check = async () => { throw refusal(401, 'invalid_session') }
    store()
    start()
    await signInHeading()
    expect(readOutbox()).toEqual([{ kind: 'signed_out', place: 'provider:home', code: 'invalid_session', build: 'dev', count: 1 }])
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('with the code that the server answered, whatever it is, and without a name', async () => {
    answerLikeTheServer()
    server.check = async () => { throw refusal(401, 'session_gone') }
    store()
    start()
    await signInHeading()
    expect(readOutbox()).toEqual([{ kind: 'signed_out', place: 'provider:home', code: 'session_gone', build: 'dev', count: 1 }])
  })

  it('when a check-in finds the session gone: on the working screen', async () => {
    answerLikeTheServer()
    // The answer takes a moment, as it does on a phone: the working screen is drawn first, and that is where the person was.
    server.scan = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); throw refusal(401, 'invalid_session') }
    store()
    window.history.replaceState(null, '', `/scan?code=${CODE}`)
    start()
    await signInHeading()
    expect(readOutbox()).toEqual([{ kind: 'signed_out', place: 'provider:working', code: 'invalid_session', build: 'dev', count: 1 }])
  })

  it('when the upload of the queue finds the session gone', async () => {
    answerLikeTheServer()
    server.sync = async () => { throw refusal(401, 'invalid_session') }
    store({ queue: [{ id: 'q-1', code: CODE, client_time: '2026-10-05T07:00:00.000Z', gps: null, provider_id: ploni.id, saved_at: '2026-10-05T07:00:00.000Z' }] })
    start()
    await signInHeading()
    expect(readOutbox()).toEqual([expect.objectContaining({ kind: 'signed_out', code: 'invalid_session', count: 1 })])
  })

  it('when the phone\'s status report finds the session gone (the code is the server\'s only answer for a provider\'s token)', async () => {
    answerLikeTheServer()
    server.status = async () => { throw refusal(401, 'invalid_session') }
    store()
    start()
    await signInHeading()
    expect(readOutbox()).toEqual([expect.objectContaining({ kind: 'signed_out', place: 'provider:home', code: 'invalid_session', count: 1 })])
  })

  it('once, however many calls find the session gone at the same time', async () => {
    answerLikeTheServer()
    server.check = async () => { throw refusal(401, 'invalid_session') }
    server.status = async () => { throw refusal(401, 'invalid_session') }
    server.sync = async () => { throw refusal(401, 'invalid_session') }
    store({ queue: [{ id: 'q-1', code: CODE, client_time: '2026-10-05T07:00:00.000Z', gps: null, provider_id: ploni.id, saved_at: '2026-10-05T07:00:00.000Z' }] })
    start()
    await signInHeading()
    await settleWell()
    expect(readOutbox()).toEqual([expect.objectContaining({ kind: 'signed_out', count: 1 })])
  })

  it('and a sign-out that the person chose is not', async () => {
    answerLikeTheServer()
    store()
    start()
    await waitFor(() => expect(greeting()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: he['home.switchWorker'] }))
    await signInHeading()
    await settleWell()
    expect(readOutbox()).toEqual([])
    expect(window.localStorage.getItem(ERRORS_KEY)).toBeNull()
  })

  it('a second forced sign-out, after signing in again, is noted again (here the report of the first has not been answered, so it is still there)', async () => {
    answerLikeTheServer()
    server.errors = forever
    server.check = async () => { throw refusal(401, 'invalid_session') }
    store()
    start()
    await signInHeading()
    server.status = async () => { throw refusal(401, 'invalid_session') }
    await signInAsPloni()
    await waitFor(() => expect(readOutbox()[0]?.count).toBe(2))
    expect(readOutbox()).toHaveLength(1)
  })
})

describe('the report', () => {
  it('is sent once the server has confirmed the stored session, with that session\'s token, in a body that is only the events of this app', async () => {
    answerLikeTheServer()
    store({ outbox: [{ ...crash, build: 'abc1234', count: 3 }, { kind: 'crash', place: 'committee:points', name: 'Error', build: 'dev', count: 1 }] })
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))

    const [path, options] = reports()[0]
    expect(path).toBe('/my/errors')
    expect(options).toMatchObject({ method: 'POST', token: TOKEN })
    expect(options.timeoutMs).toBeGreaterThan(0)
    expect(options.body).toEqual({ events: [{ kind: 'crash', place: 'provider:home', name: 'TypeError', build: 'abc1234', count: 3 }] })
    const order = callOrder()
    expect(order.indexOf('POST /my/errors')).toBeGreaterThan(order.indexOf('GET /session')) // after the session check, never before it
    // what the server took is gone from the phone, and the committee app's entry waits for the committee app
    await waitFor(() => expect(readOutbox()).toEqual([{ kind: 'crash', place: 'committee:points', name: 'Error', build: 'dev', count: 1 }]))
  })

  it('waits for the server\'s answer to the session check', async () => {
    answerLikeTheServer()
    let confirm
    server.check = () => new Promise((resolve) => { confirm = () => resolve({ provider: ploni }) })
    store({ outbox: [{ ...crash, build: 'dev', count: 1 }] })
    start()
    await settleWell()
    expect(api.mock.calls.some(([path]) => path === '/session')).toBe(true)
    expect(reports()).toHaveLength(0)
    confirm()
    await waitFor(() => expect(reports()).toHaveLength(1))
  })

  it('is also sent when the session check answers without usable details (the token was accepted)', async () => {
    answerLikeTheServer()
    server.check = async () => ({ provider: null })
    store({ outbox: [{ ...crash, build: 'dev', count: 1 }] })
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))
  })

  it('is not sent when nothing is noted', async () => {
    answerLikeTheServer()
    store()
    start()
    await waitFor(() => expect(api.mock.calls.some(([path]) => path === '/my/device-status')).toBe(true))
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(0)
  })

  it('is not sent for nobody: a crash before sign-in waits on the phone, and goes out with the sign-in\'s token', async () => {
    answerLikeTheServer()
    window.localStorage.setItem(ERRORS_KEY, JSON.stringify([{ kind: 'crash', place: 'provider:login', name: 'TypeError', build: 'dev', count: 1 }]))
    start()
    await signInHeading()
    await settleWell()
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(0)
    expect(readOutbox()).toHaveLength(1)

    await signInAsPloni()
    await waitFor(() => expect(reports()).toHaveLength(1))
    expect(reports()[0][1]).toMatchObject({ token: NEW_TOKEN, body: { events: [{ kind: 'crash', place: 'provider:login', name: 'TypeError', build: 'dev', count: 1 }] } })
    await waitFor(() => expect(readOutbox()).toEqual([]))
  })

  it('goes out again when the app comes back to the foreground and something was noted since, but not inside a minute of the last one', async () => {
    answerLikeTheServer()
    store({ outbox: [{ ...crash, build: 'dev', count: 1 }] })
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))

    note({ kind: 'unhandled', place: 'provider:home', name: 'RangeError' })
    clock += MINUTE - 1
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(1) // too soon

    clock += 1
    comeBackToTheApp()
    await waitFor(() => expect(reports()).toHaveLength(2))
    expect(reports()[1][1].body).toEqual({ events: [{ kind: 'unhandled', place: 'provider:home', name: 'RangeError', build: 'dev', count: 1 }] })
  })

  it('sends nothing while the phone says it is offline, and sends when it is back', async () => {
    answerLikeTheServer()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    store({ outbox: [{ ...crash, build: 'dev', count: 1 }] })
    start()
    await settleWell()
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(0)

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    comeBackToTheApp()
    await waitFor(() => expect(reports()).toHaveLength(1))
  })

  it('is not made at all by a screen that does not crash: nothing was noted, so nothing is sent and the console stays quiet', async () => {
    const logged = quiet()
    answerLikeTheServer()
    store()
    start()
    await waitFor(() => expect(greeting()).toBeTruthy())
    await settleWell()
    expect(reports()).toHaveLength(0)
    expect(logged.flatMap((spy) => spy.mock.calls)).toEqual([])
  })
})

describe('what the server answers to a report', () => {
  const noted = () => ({ outbox: [{ ...crash, build: 'dev', count: 1 }] })

  it('a 401 signs the person out the way another call does: the sign-in list with the notice that the sign-in expired, and it is noted', async () => {
    answerLikeTheServer()
    server.errors = async () => { throw refusal(401, 'invalid_session') }
    store(noted())
    start()
    expect(await signInHeading()).toBeTruthy()
    expect(screen.getByText(he['error.invalid_session'])).toBeTruthy()
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(readOutbox()).toEqual([
      { ...crash, build: 'dev', count: 1 }, // not lost
      { kind: 'signed_out', place: 'provider:home', code: 'invalid_session', build: 'dev', count: 1 },
    ])
    expect(reports()).toHaveLength(1) // and no second try of its own
  })

  it('after that 401 the entries go out with the next sign-in, once the minute has passed', async () => {
    answerLikeTheServer()
    let refuse = true
    server.errors = async () => { if (refuse) throw refusal(401, 'invalid_session'); return { ok: true, recorded: 2 } }
    store(noted())
    start()
    await signInHeading()
    refuse = false
    clock += MINUTE
    await signInAsPloni()
    await waitFor(() => expect(reports()).toHaveLength(2))
    expect(reports()[1][1]).toMatchObject({ token: NEW_TOKEN })
    expect(reports()[1][1].body.events.map((e) => e.kind)).toEqual(['crash', 'signed_out'])
    await waitFor(() => expect(readOutbox()).toEqual([]))
  })

  it('a 404 (a server from before the endpoint) stops the reports until the app starts again, and keeps the entries', async () => {
    answerLikeTheServer()
    server.errors = async () => { throw refusal(404, 'not_found') }
    store(noted())
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))
    await settleWell()
    expect(greeting().textContent).toContain(ploni.contact_name) // still signed in, nothing shown

    for (let i = 0; i < 3; i++) {
      note({ kind: 'unhandled', place: 'provider:home', name: `Error${i}` })
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
    store(noted())
    start()
    await waitFor(() => expect(reports()).toHaveLength(1))
    await settleWell()
    expect(greeting().textContent).toContain(ploni.contact_name)
    expect(readOutbox()).toHaveLength(1)

    clock += MINUTE
    comeBackToTheApp()
    await waitFor(() => expect(reports()).toHaveLength(2))
    expect(reports()[1][1].body).toEqual(reports()[0][1].body)
    expect(logged.flatMap((spy) => spy.mock.calls)).toEqual([])
  })
})

describe('the report and a session that has just ended', () => {
  const session = { token: TOKEN, provider: ploni }
  const hook = (extra = {}) => renderHook(() => useErrorReport({ session, confirmedToken: TOKEN, onSignedOut: vi.fn(), ...extra }))

  it('is trusted when the app says nothing else: the report goes out for the session that the app has', async () => {
    answerLikeTheServer()
    window.localStorage.setItem(ERRORS_KEY, JSON.stringify([{ ...crash, build: 'dev', count: 1 }]))
    hook()
    await waitFor(() => expect(reports()).toHaveLength(1))
    expect(reports()[0][1].token).toBe(TOKEN)
  })

  it('is not used for sending once the app already knows that it ended (the draw that shows it has not happened yet)', async () => {
    answerLikeTheServer()
    window.localStorage.setItem(ERRORS_KEY, JSON.stringify([{ ...crash, build: 'dev', count: 1 }]))
    hook({ liveSession: () => null })
    await settleWell()
    comeBackToTheApp()
    await settleWell()
    expect(reports()).toHaveLength(0)
    expect(readOutbox()).toHaveLength(1)
  })

  it('is reported with the session that the app has now when it says who that is', async () => {
    answerLikeTheServer()
    window.localStorage.setItem(ERRORS_KEY, JSON.stringify([{ ...crash, build: 'dev', count: 1 }]))
    hook({ liveSession: () => session })
    await waitFor(() => expect(reports()).toHaveLength(1))
  })
})
