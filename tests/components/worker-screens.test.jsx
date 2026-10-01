// @vitest-environment jsdom
// The provider app's two main screens, rendered with their real translations: the sign-in flow and the result screen.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../src/i18n/index.jsx'
import { LoginView, ResultView } from '../../src/worker/components.jsx'
import he from '../../src/i18n/he.js'
import { api } from '../../src/api/client.js'

vi.mock('../../src/api/client.js', () => ({ api: vi.fn() }))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.clearAllMocks()
})

const withI18n = (ui) => render(<I18nProvider>{ui}</I18nProvider>)
const lior = { id: 'p1', contact_name: 'ליאור', company: 'ניקיון' }
const hamudi = { id: 'p2', contact_name: 'חמודי', company: 'גינון' }

describe('LoginView', () => {
  const view = (props = {}) => (
    <LoginView providers={{ status: 'ready', providers: [lior, hamudi], reload: () => {} }} pointName="לובי" onSignedIn={() => {}} {...props} />
  )

  it('lists the people and names the scanned point', () => {
    withI18n(view())
    expect(screen.getByRole('heading', { name: he['login.title'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: /ליאור/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /חמודי/ })).toBeTruthy()
    expect(screen.getByText(/נקודת סריקה/).textContent).toContain('לובי')
  })

  it('shows a friendly message, not an empty list, when no providers are set up yet', () => {
    withI18n(view({ providers: { status: 'ready', providers: [], reload: () => {} } }))
    expect(screen.getByText(he['login.noProviders'])).toBeTruthy()
  })

  it('offers a retry when the list cannot be loaded', () => {
    const reload = vi.fn()
    withI18n(view({ providers: { status: 'error', providers: [], reload } }))
    expect(screen.getByText(he['login.loadError'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: he['common.retry'] }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('asks for the password of the person chosen, and keeps them signed in by default', async () => {
    const onSignedIn = vi.fn()
    api.mockResolvedValue({ token: 'qrp_token', provider: lior })
    withI18n(view({ onSignedIn }))

    fireEvent.click(screen.getByRole('button', { name: /ליאור/ }))
    expect(screen.getByRole('heading', { name: /שלום/ }).textContent).toContain('ליאור')
    fireEvent.change(screen.getByLabelText(he['login.passwordLabel'], { selector: 'input' }), { target: { value: 'secret-1' } })
    fireEvent.click(screen.getByRole('button', { name: he['login.submit'] }))

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(onSignedIn).toHaveBeenCalledWith({ token: 'qrp_token', provider: lior }, true)
    expect(api).toHaveBeenCalledWith('/session', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ provider_id: 'p1', password: 'secret-1' }) }))
  })

  it('says the password is wrong and clears the field', async () => {
    api.mockRejectedValue(Object.assign(new Error('nope'), { code: 'invalid_credentials', status: 401 }))
    withI18n(view())
    fireEvent.click(screen.getByRole('button', { name: /ליאור/ }))
    const field = screen.getByLabelText(he['login.passwordLabel'], { selector: 'input' })
    fireEvent.change(field, { target: { value: 'wrong-pass' } })
    fireEvent.click(screen.getByRole('button', { name: he['login.submit'] }))

    // the alert region exists from the start and is filled once the server has answered
    expect(await screen.findByText(he['login.wrong'])).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(he['login.wrong'])
    expect(field.value).toBe('')
  })

  it('can go back to choose someone else', () => {
    withI18n(view())
    fireEvent.click(screen.getByRole('button', { name: /ליאור/ }))
    fireEvent.click(screen.getByRole('button', { name: he['login.changeName'] }))
    expect(screen.getByRole('heading', { name: he['login.title'] })).toBeTruthy()
  })
})

describe('ResultView', () => {
  const success = { kind: 'success', scan: { checked_in_at: '2026-10-01T10:00:00Z', point_name: 'לובי' } }
  const show = (result, props = {}) =>
    withI18n(<ResultView result={result} pointName="לובי" provider={lior} onDone={() => {}} onRetry={() => {}} {...props} />)

  it('confirms a check-in and says who is signed in', () => {
    show(success)
    expect(screen.getByRole('heading', { name: he['checkin.success.title'] })).toBeTruthy()
    expect(screen.getByText(/משתמש:/).textContent).toContain('ליאור · ניקיון')
    expect(screen.getByRole('button', { name: he['checkin.done'] })).toBeTruthy()
  })

  it('says who is signed in on a refusal too, which is when it matters most', () => {
    show({ kind: 'error', code: 'not_assigned' })
    expect(screen.getByText(/משתמש:/).textContent).toContain('ליאור · ניקיון')
  })

  it('gives each known refusal its own message and no retry button (trying again cannot help)', () => {
    for (const code of ['not_assigned', 'unknown_code', 'point_inactive', 'invalid_code']) {
      show({ kind: 'error', code })
      expect(screen.getByRole('heading', { name: he[`error.${code}`] }), code).toBeTruthy()
      expect(screen.queryByRole('button', { name: he['checkin.retry'] }), code).toBeNull()
      cleanup()
    }
  })

  it('shows the generic message, with a retry, for a refusal it does not know', () => {
    show({ kind: 'error', code: 'something_new' })
    expect(screen.getByRole('heading', { name: he['error.generic'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: he['checkin.retry'] })).toBeTruthy()
  })

  it('offers a retry when the phone is too far, and the retry is wired', () => {
    const onRetry = vi.fn()
    show({ kind: 'far', scan: { distance_m: 5600 } }, { onRetry })
    expect(screen.getByRole('heading', { name: he['checkin.far.title'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: he['checkin.retry'] }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('tells a check-in that is only saved on the phone', () => {
    show({ kind: 'queued', persisted: true })
    expect(screen.getByRole('heading', { name: he['checkin.queued.title'] })).toBeTruthy()
    expect(screen.getByText(he['checkin.queued.body'])).toBeTruthy()
  })

  it('calls onDone from the done button', () => {
    const onDone = vi.fn()
    show(success, { onDone })
    fireEvent.click(screen.getByRole('button', { name: he['checkin.done'] }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
