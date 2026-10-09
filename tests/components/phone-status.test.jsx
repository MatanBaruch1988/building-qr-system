// @vitest-environment jsdom
// The provider app reports its status to the server (ADR 0007, decision 4, "Phone health"): the real WorkerApp, with the
// network (`api`) answered by the test. Nothing on the screen changes, so what is checked is the calls that the app makes.
//
// What this file proves:
//   - the first report is sent when the server has confirmed the stored session, not before, and for a person who has just
//     signed in; it carries the signed-in person's queue (how many, since when), the build and the totals, with that person's
//     token; a sign-in starts the totals from zero;
//   - a report is sent when an upload has ended and when the app comes back to the foreground, and never while the phone says
//     that it is offline;
//   - a 401 signs the person out the way every other call of the app does, a 404 stops the reports until the app starts again,
//     and any other failure is silent (nothing reaches the console);
//   - a session that the server refuses reports nothing.
// The rules of the throttle itself are in tests/phone-status.test.js.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import WorkerApp from '../../src/pages/WorkerApp.jsx'
import ErrorBoundary from '../../src/ui/ErrorBoundary.jsx'
import { api } from '../../src/api/client.js'
import he from '../../src/i18n/he.js'
import { PROVIDER_TOKEN_PREFIX, DEVICE_STATUS_MIN_INTERVAL_S } from '../../shared/contract.js'
import { SAMPLE_PROVIDER_NAMES } from '../../scripts/sample-data.mjs'
import { REPORT_EVERY_MS } from '../../src/worker/deviceStatus.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const SESSION_KEY = 'qr.session'
const QUEUE_KEY = 'qr.queue.v1'
const HEALTH_KEY = 'qr.health.v1'
const TOKEN = PROVIDER_TOKEN_PREFIX + 'a'.repeat(43)
const NEW_TOKEN = PROVIDER_TOKEN_PREFIX + 'b'.repeat(43)
const ploni = { id: '00000000-0000-4000-8000-000000000001', company: 'ניקיון', contact_name: SAMPLE_PROVIDER_NAMES.cleaner, service_type: 'cleaning' }
const almoni = { id: '00000000-0000-4000-8000-000000000002', company: 'גינון', contact_name: SAMPLE_PROVIDER_NAMES.gardener, service_type: 'gardening' }
const START = Date.parse('2026-10-05T08:00:00.000Z')
const GAP_MS = DEVICE_STATUS_MIN_INTERVAL_S * 1000

const forever = () => new Promise(() => {}) // an answer that never comes
const refusal = (status) => Object.assign(new Error('refused'), { status })

/** What the server answers, by route. A test changes these. `check` and `status` run on every call. */
const server = {
  check: async () => ({ provider: ploni }),
  signIn: { token: NEW_TOKEN, provider: ploni },
  status: async () => ({ ok: true, build: null }),
  sync: async ({ body }) => ({ results: body.scans.map((s) => ({ id: s.id, ok: true, scan: { outcome: 'accepted' } })) }),
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
  clock = START
})

function answerLikeTheServer() {
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  api.mockImplementation(async (path, options = {}) => {
    if (path === '/public/providers') return { providers: [ploni, almoni] }
    if (path === '/public/building') return { building: { address: 'Sample Street 1' } }
    if (path === '/my/scans') return { scans: [] }
    if (path === '/session' && options.method === 'POST') return server.signIn
    if (path === '/session' && !options.method) return server.check()
    if (path === '/session' && options.method === 'DELETE') return { ok: true }
    if (path === '/my/device-status') return server.status(options)
    if (path === '/scans/sync') return server.sync(options)
    throw new Error(`the test does not expect ${path}`)
  })
}

const start = () => render(<ErrorBoundary><WorkerApp /></ErrorBoundary>)
const store = ({ queue = [], health = null } = {}) => {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify({ token: TOKEN, provider: ploni }))
  if (queue.length) window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  if (health) window.localStorage.setItem(HEALTH_KEY, JSON.stringify(health))
}
const queued = (id, extra = {}) => ({
  id, code: 'BQR-abc123', client_time: '2026-10-05T07:00:00.000Z', gps: null, provider_id: ploni.id, saved_at: '2026-10-05T07:00:00.000Z', ...extra,
})
const statusCalls = () => api.mock.calls.filter(([path]) => path === '/my/device-status')
const callOrder = () => api.mock.calls.map(([path, options]) => `${options?.method ?? 'GET'} ${path}`)
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const settleWell = async () => { for (let i = 0; i < 4; i++) await settle() }
const comeBackToTheApp = () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
const signInHeading = () => screen.findByRole('heading', { name: he['login.title'] })
const greeting = () => screen.getByRole('heading', { name: /^שלום,/ })

describe('the first report', () => {
  it('is sent once the server has confirmed the stored session, with the signed-in person\'s queue, the build and the totals', async () => {
    answerLikeTheServer()
    server.sync = forever // the upload does not end: what waits stays in the queue
    store({
      queue: [queued('mine-new'), queued('mine-old', { saved_at: undefined, client_time: '2026-10-04T19:00:00.000Z' }), queued('theirs', { provider_id: almoni.id, saved_at: '2020-01-01T00:00:00.000Z' })],
      health: { not_accepted_total: 2, overflowed_total: 5 },
    })
    start()
    await waitFor(() => expect(statusCalls()).toHaveLength(1))

    const [path, options] = statusCalls()[0]
    expect(path).toBe('/my/device-status')
    expect(options).toMatchObject({ method: 'POST', token: TOKEN })
    expect(options.body).toEqual({
      build: 'dev', waiting: 2, oldest_waiting_at: '2026-10-04T19:00:00.000Z', not_accepted_total: 2, overflowed_total: 5,
    })
    // after the session check, never before it
    const order = callOrder()
    expect(order.indexOf('POST /my/device-status')).toBeGreaterThan(order.indexOf('GET /session'))
    expect(window.localStorage.getItem(HEALTH_KEY)).toBe(JSON.stringify({ not_accepted_total: 2, overflowed_total: 5 })) // a report resets nothing
    await settleWell()
    expect(statusCalls()).toHaveLength(1)
  })

  it('waits for the server\'s answer to the session check', async () => {
    answerLikeTheServer()
    let confirm
    server.check = () => new Promise((resolve) => { confirm = () => resolve({ provider: ploni }) })
    store()
    start()
    await settleWell()
    expect(api.mock.calls.some(([path]) => path === '/session')).toBe(true)
    expect(statusCalls()).toHaveLength(0)

    confirm()
    await waitFor(() => expect(statusCalls()).toHaveLength(1))
  })

  it('is also sent when the session check answers without usable details (the token was accepted)', async () => {
    answerLikeTheServer()
    server.check = async () => ({ provider: null })
    store()
    start()
    await waitFor(() => expect(statusCalls()).toHaveLength(1))
    expect(greeting().textContent).toContain(ploni.contact_name)
  })

  it('is not sent for a session that the server refuses: the person is signed out, and nothing was reported', async () => {
    answerLikeTheServer()
    server.check = async () => { throw refusal(401) }
    store()
    start()
    expect(await signInHeading()).toBeTruthy()
    await settleWell()
    expect(statusCalls()).toHaveLength(0)
  })

  it('is not sent for nobody (the sign-in list)', async () => {
    answerLikeTheServer()
    start()
    await signInHeading()
    await settleWell()
    expect(statusCalls()).toHaveLength(0)
    comeBackToTheApp()
    await settleWell()
    expect(statusCalls()).toHaveLength(0)
  })

  it('is sent for a person who has just signed in, with that sign-in\'s token, and the totals start from zero', async () => {
    answerLikeTheServer()
    // what an earlier person's sign-in left behind
    window.localStorage.setItem(HEALTH_KEY, JSON.stringify({ not_accepted_total: 9, overflowed_total: 9 }))
    start()
    await signInHeading()
    // the heading is drawn at once, the names only when the list of providers has been answered: wait for the name
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(ploni.contact_name) }))
    fireEvent.change(screen.getByLabelText(he['login.passwordLabel'], { selector: 'input' }), { target: { value: 'sample-pass-1' } })
    fireEvent.click(screen.getByRole('button', { name: he['login.submit'] }))

    await waitFor(() => expect(statusCalls()).toHaveLength(1))
    expect(statusCalls()[0][1]).toMatchObject({ token: NEW_TOKEN, body: { waiting: 0, oldest_waiting_at: null, not_accepted_total: 0, overflowed_total: 0 } })
  })
})

describe('later reports', () => {
  it('an upload that ends is reported on: what is left (here nothing) goes to the server', async () => {
    answerLikeTheServer()
    let confirm
    server.check = () => new Promise((resolve) => { confirm = () => resolve({ provider: ploni }) })
    store({ queue: [queued('a'), queued('b')] })
    start()
    // the upload runs at start and empties the queue, before the session check has answered
    await waitFor(() => expect(statusCalls()).toHaveLength(1))
    expect(statusCalls()[0][1].body).toMatchObject({ waiting: 0, oldest_waiting_at: null })
    expect(statusCalls()[0][1].token).toBe(TOKEN)

    confirm() // the confirmation of the same state is not a new report
    await settleWell()
    expect(statusCalls()).toHaveLength(1)
  })

  it('a change that comes too soon after the last report is sent when the minimum has passed, not lost', async () => {
    answerLikeTheServer()
    server.sync = forever
    store()
    start()
    await waitFor(() => expect(statusCalls()).toHaveLength(1)) // 0 waiting

    clock += 2000
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify([queued('new')]))
    comeBackToTheApp()
    await settleWell()
    expect(statusCalls()).toHaveLength(1) // held back: the minimum between two reports has not passed

    clock += GAP_MS
    comeBackToTheApp()
    await waitFor(() => expect(statusCalls()).toHaveLength(2))
    expect(statusCalls()[1][1].body).toMatchObject({ waiting: 1, oldest_waiting_at: '2026-10-05T07:00:00.000Z' })
  })

  it('coming back to the app reports a queue that changed, and not one that did not (within 10 minutes)', async () => {
    answerLikeTheServer()
    server.sync = forever
    store()
    start()
    await waitFor(() => expect(statusCalls()).toHaveLength(1))

    clock += GAP_MS + 1
    comeBackToTheApp()
    await settleWell()
    expect(statusCalls()).toHaveLength(1) // nothing changed

    window.localStorage.setItem(QUEUE_KEY, JSON.stringify([queued('a'), queued('b')]))
    clock += 1000
    comeBackToTheApp()
    await waitFor(() => expect(statusCalls()).toHaveLength(2))
    expect(statusCalls()[1][1].body.waiting).toBe(2)

    clock += REPORT_EVERY_MS
    comeBackToTheApp() // unchanged, but 10 minutes on: the phone is still alive and still waiting
    await waitFor(() => expect(statusCalls()).toHaveLength(3))
  })

  it('sends nothing while the phone says it is offline, and reports when it is back', async () => {
    answerLikeTheServer()
    server.sync = forever
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    store({ queue: [queued('a')] })
    start()
    await settleWell()
    comeBackToTheApp()
    await settleWell()
    expect(statusCalls()).toHaveLength(0)

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    comeBackToTheApp()
    await waitFor(() => expect(statusCalls()).toHaveLength(1))
    expect(statusCalls()[0][1].body.waiting).toBe(1)
  })
})

describe('what the server answers', () => {
  it('a 401 signs the person out the way another call does: the sign-in list, with the notice that the sign-in expired', async () => {
    answerLikeTheServer()
    server.status = async () => { throw refusal(401) }
    store()
    start()
    expect(await signInHeading()).toBeTruthy()
    expect(screen.getByText(he['error.invalid_session'])).toBeTruthy()
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(window.localStorage.getItem(HEALTH_KEY)).toBeNull() // signing out starts the totals again
  })

  it('a 404 (a server from before the endpoint) stops the reports until the app starts again, and the person is not troubled', async () => {
    answerLikeTheServer()
    server.sync = forever
    server.status = async () => { throw refusal(404) }
    store()
    start()
    await waitFor(() => expect(statusCalls()).toHaveLength(1))
    await settleWell()
    expect(greeting().textContent).toContain(ploni.contact_name) // still signed in, nothing shown

    for (let i = 1; i <= 3; i++) {
      window.localStorage.setItem(QUEUE_KEY, JSON.stringify(Array.from({ length: i }, (_, n) => queued('q' + n))))
      clock += REPORT_EVERY_MS
      comeBackToTheApp()
      await settleWell()
    }
    expect(statusCalls()).toHaveLength(1)
  })

  it.each([
    ['a server that fails', () => { throw refusal(500) }],
    ['no signal', () => { throw refusal(0) }],
    ['an answer that is not "ok"', async () => ({})],
  ])('%s is silent: nothing in the console, the person stays signed in, and the next report is tried', async (_what, answer) => {
    answerLikeTheServer()
    server.sync = forever
    server.status = answer
    const logged = ['error', 'warn'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    store({ health: { not_accepted_total: 1, overflowed_total: 0 } })
    start()
    await waitFor(() => expect(statusCalls()).toHaveLength(1))
    await settleWell()
    expect(greeting().textContent).toContain(ploni.contact_name)
    expect(window.localStorage.getItem(HEALTH_KEY)).toBe(JSON.stringify({ not_accepted_total: 1, overflowed_total: 0 }))

    clock += REPORT_EVERY_MS
    comeBackToTheApp()
    await waitFor(() => expect(statusCalls()).toHaveLength(2))
    expect(statusCalls()[1][1].body).toEqual(statusCalls()[0][1].body) // the same totals again
    expect(logged.flatMap((spy) => spy.mock.calls)).toEqual([])
  })
})
