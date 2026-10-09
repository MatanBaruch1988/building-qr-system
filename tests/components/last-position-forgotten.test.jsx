// @vitest-environment jsdom
// The position that the phone keeps (src/worker/geo.js) goes when the person does: on a shared phone, the next person must not
// send what the previous one left. The real WorkerApp, with the network (`api`) answered by the test.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import WorkerApp from '../../src/pages/WorkerApp.jsx'
import { api } from '../../src/api/client.js'
import he from '../../src/i18n/he.js'
import { PROVIDER_TOKEN_PREFIX } from '../../shared/contract.js'
import { SAMPLE_PROVIDER_NAMES } from '../../scripts/sample-data.mjs'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

const LAST_FIX_KEY = 'qr.lastfix.v1'
const TOKEN = PROVIDER_TOKEN_PREFIX + 'a'.repeat(43)
const ploni = { id: '00000000-0000-4000-8000-000000000001', company: 'ניקיון', contact_name: SAMPLE_PROVIDER_NAMES.cleaner, service_type: 'cleaning' }

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.clearAllMocks()
})

/** `check` is what the server answers to the check of the stored session. */
function answerLikeTheServer(check = { provider: ploni }) {
  api.mockImplementation(async (path, options = {}) => {
    if (path === '/public/providers') return { providers: [ploni] }
    if (path === '/public/building') return { building: { address: 'Sample Street 1' } }
    if (path === '/my/scans') return { scans: [] }
    if (path === '/my/device-status') return { ok: true, build: null }
    if (path === '/session' && options.method === 'DELETE') return { ok: true }
    if (path === '/session' && !options.method) {
      if (check instanceof Error) throw check
      return check
    }
    throw new Error(`the test does not expect ${path}`)
  })
}

/** A position that an earlier visit left on the phone, a minute ago. */
const keepAPosition = () => window.localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lat: 32.1, lng: 34.8, accuracy: 20, taken_at: Date.now() - 60_000 }))
const signInHeading = () => screen.findByRole('heading', { name: he['login.title'] })

describe('the last position of the phone', () => {
  it('is deleted when the person chooses to sign out ("switch worker")', async () => {
    answerLikeTheServer()
    window.localStorage.setItem('qr.session', JSON.stringify({ token: TOKEN, provider: ploni }))
    keepAPosition()
    render(<WorkerApp />)
    await waitFor(() => expect(screen.getByRole('heading', { name: /^שלום,/ })).toBeTruthy())
    expect(window.localStorage.getItem(LAST_FIX_KEY), 'it is there until they sign out').not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: he['home.switchWorker'] }))
    await signInHeading()
    expect(window.localStorage.getItem(LAST_FIX_KEY)).toBeNull()
  })

  it('is deleted when the server ended the session', async () => {
    answerLikeTheServer(Object.assign(new Error('revoked'), { status: 401, code: 'invalid_session' }))
    window.localStorage.setItem('qr.session', JSON.stringify({ token: TOKEN, provider: ploni }))
    keepAPosition()
    render(<WorkerApp />)

    await signInHeading()
    expect(screen.getByText(he['error.invalid_session'])).toBeTruthy()
    expect(window.localStorage.getItem(LAST_FIX_KEY)).toBeNull()
  })
})
