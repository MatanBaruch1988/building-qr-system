// @vitest-environment jsdom
// The provider app against a session that it cannot draw its screens from: one that an older or broken version stored, and
// one that the server answers with. The real WorkerApp, inside the real ErrorBoundary, with the network (`api`) answered by
// the test.
//
// What went wrong: the home screen reads `session.provider` on every start, so a stored session with no provider details made
// it throw every time. The screen that takes the place of a broken one appeared, but "Try again" and "Reload the app" read the
// same stored value again, and the only way out was to clear the site's data. Now such a session is removed when it is read
// and the person sees the sign-in list; an answer without details never replaces the ones that the screens draw from.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import WorkerApp from '../../src/pages/WorkerApp.jsx'
import ErrorBoundary from '../../src/ui/ErrorBoundary.jsx'
import { api } from '../../src/api/client.js'
import he from '../../src/i18n/he.js'
import { PROVIDER_TOKEN_PREFIX } from '../../shared/contract.js'
import { SAMPLE_PROVIDER_NAMES } from '../../scripts/sample-data.mjs'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const KEY = 'qr.session'
const TOKEN = PROVIDER_TOKEN_PREFIX + 'a'.repeat(43)
const ploni = { id: '00000000-0000-4000-8000-000000000001', company: 'ניקיון', contact_name: SAMPLE_PROVIDER_NAMES.cleaner, service_type: 'cleaning' }
const almoni = { id: '00000000-0000-4000-8000-000000000002', company: 'גינון', contact_name: SAMPLE_PROVIDER_NAMES.gardener, service_type: 'gardening' }

/** What the server answers, by route. A test changes `server.check` (GET /session) and `server.signIn` (POST /session). */
const server = { check: { provider: ploni }, signIn: { token: TOKEN, provider: ploni } }

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
  Object.assign(server, { check: { provider: ploni }, signIn: { token: TOKEN, provider: ploni } })
})

function answerLikeTheServer() {
  api.mockImplementation(async (path, options = {}) => {
    if (path === '/public/providers') return { providers: [ploni, almoni] }
    if (path === '/public/building') return { building: { address: 'Sample Street 1' } }
    if (path === '/my/scans') return { scans: [] }
    if (path === '/my/device-status') return { ok: true, build: null } // the phone reports its status once it is signed in
    if (path === '/session' && options.method === 'POST') return server.signIn
    if (path === '/session' && !options.method) {
      if (server.check instanceof Error) throw server.check
      return server.check
    }
    throw new Error(`the test does not expect ${path}`)
  })
}

const start = () => render(<ErrorBoundary><WorkerApp /></ErrorBoundary>)
const crashTitle = () => screen.queryByRole('heading', { name: he['crash.title'] })
const signInHeading = () => screen.findByRole('heading', { name: he['login.title'] })
// The heading is drawn at once, the names only when the list of providers has been answered: a test that needs a name waits for it.
const ploniInTheList = () => screen.findByRole('button', { name: new RegExp(ploni.contact_name) })
const greeting = () => screen.getByRole('heading', { name: /^שלום,/ })
const sessionChecked = () => api.mock.calls.some(([path, options]) => path === '/session' && !options?.method)
const stored = () => window.localStorage.getItem(KEY)
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

describe('a stored session that has no usable provider details', () => {
  const BAD = [
    ['no provider at all', { token: TOKEN }],
    ['a provider that is null', { token: TOKEN, provider: null }],
    ['a provider that is a string', { token: TOKEN, provider: 'x' }],
    ['a provider with no id', { token: TOKEN, provider: { company: 'ניקיון' } }],
    ['a token that is not ours', { token: 'abc', provider: ploni }],
  ]

  it.each(BAD)('shows the sign-in list, not the broken-screen message, for %s, and removes it', async (_what, session) => {
    answerLikeTheServer()
    window.localStorage.setItem(KEY, JSON.stringify(session))
    start()

    expect(await signInHeading()).toBeTruthy()
    expect(await ploniInTheList()).toBeTruthy()
    expect(crashTitle()).toBeNull()
    expect(stored()).toBeNull()
    expect(sessionChecked()).toBe(false) // nobody is signed in, so there is nothing to check
  })

  it('shows the sign-in list when what is stored is not even JSON, and again after a reload (nothing is left to break on)', async () => {
    answerLikeTheServer()
    window.localStorage.setItem(KEY, 'not json{')
    const first = start()
    expect(await signInHeading()).toBeTruthy()
    expect(stored()).toBeNull()
    first.unmount()

    start() // the app opened again
    expect(await signInHeading()).toBeTruthy()
    expect(crashTitle()).toBeNull()
  })

  it('also covers a session that was not remembered (sessionStorage)', async () => {
    answerLikeTheServer()
    window.sessionStorage.setItem(KEY, JSON.stringify({ token: TOKEN }))
    start()
    expect(await signInHeading()).toBeTruthy()
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
  })

  it('can sign in again from that screen, and then the session is kept', async () => {
    answerLikeTheServer()
    window.localStorage.setItem(KEY, JSON.stringify({ token: TOKEN, provider: null }))
    start()
    await signInHeading()

    fireEvent.click(await ploniInTheList())
    fireEvent.change(screen.getByLabelText(he['login.passwordLabel'], { selector: 'input' }), { target: { value: 'sample-pass-1' } })
    fireEvent.click(screen.getByRole('button', { name: he['login.submit'] }))

    await waitFor(() => expect(greeting().textContent).toContain(ploni.contact_name))
    expect(JSON.parse(stored())).toEqual({ token: TOKEN, provider: ploni })
  })
})

describe('a good stored session', () => {
  it('opens the home screen with the stored details', async () => {
    answerLikeTheServer()
    window.localStorage.setItem(KEY, JSON.stringify({ token: TOKEN, provider: { ...ploni, lang: 'he' } })) // the first v2 shape
    start()
    await waitFor(() => expect(greeting().textContent).toContain(ploni.contact_name))
    expect(crashTitle()).toBeNull()
  })

  it.each([
    ['no provider', {}],
    ['a provider that is null', { provider: null }],
    ['a provider that is a string', { provider: 'x' }],
    ['a provider with no id', { provider: { company: 'x' } }],
  ])('keeps the details it has, and stays signed in, when the session check answers with %s', async (_what, answer) => {
    answerLikeTheServer()
    server.check = answer
    window.localStorage.setItem(KEY, JSON.stringify({ token: TOKEN, provider: ploni }))
    start()
    await waitFor(() => expect(sessionChecked()).toBe(true))
    await settle()

    expect(crashTitle()).toBeNull()
    expect(greeting().textContent).toContain(ploni.contact_name)
    expect(JSON.parse(stored())).toEqual({ token: TOKEN, provider: ploni })
  })

  it('still refreshes the details from a session check that has usable ones', async () => {
    answerLikeTheServer()
    server.check = { provider: { ...ploni, contact_name: 'Renamed Person', is_demo: false } }
    window.localStorage.setItem(KEY, JSON.stringify({ token: TOKEN, provider: ploni }))
    start()
    await waitFor(() => expect(greeting().textContent).toContain('Renamed Person'))
  })

  it('is still signed out when the server says the session is revoked (401)', async () => {
    answerLikeTheServer()
    server.check = Object.assign(new Error('revoked'), { status: 401, code: 'invalid_session' })
    window.localStorage.setItem(KEY, JSON.stringify({ token: TOKEN, provider: ploni }))
    start()
    expect(await signInHeading()).toBeTruthy()
    expect(screen.getByText(he['error.invalid_session'])).toBeTruthy()
    expect(stored()).toBeNull()
  })
})

describe('a sign-in answer that cannot be used', () => {
  it.each([
    ['no provider', { token: TOKEN }],
    ['a provider that is null', { token: TOKEN, provider: null }],
    ['no token', { provider: ploni }],
    ['a token that is not ours', { token: 'abc', provider: ploni }],
  ])('says that something went wrong, stores nothing and does not break, for %s', async (_what, answer) => {
    answerLikeTheServer()
    server.signIn = answer
    start()
    await signInHeading()

    fireEvent.click(await ploniInTheList())
    fireEvent.change(screen.getByLabelText(he['login.passwordLabel'], { selector: 'input' }), { target: { value: 'sample-pass-1' } })
    fireEvent.click(screen.getByRole('button', { name: he['login.submit'] }))

    expect((await screen.findByRole('alert')).textContent).toContain(he['error.generic'])
    expect(crashTitle()).toBeNull()
    expect(stored()).toBeNull()
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
  })
})
