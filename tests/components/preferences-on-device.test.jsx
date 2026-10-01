// @vitest-environment jsdom
// The two choices a person makes on their own phone, language and light/dark: kept on that phone only once they change
// them (like the sign-in), and kept after signing out. The committee sets neither for anyone.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider, useI18n } from '../../src/i18n/index.jsx'
import { clearSession, saveSession, loadSession } from '../../src/worker/session.js'

function Probe() {
  const { lang, dir, setLang, t } = useI18n()
  return (
    <div>
      <p data-testid="state">{`${lang}/${dir}`}</p>
      <h1>{t('login.title')}</h1>
      <button onClick={() => setLang('ru')}>to Russian</button>
      <button onClick={() => setLang('klingon')}>to nonsense</button>
    </div>
  )
}
const state = () => screen.getByTestId('state').textContent

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('language on the phone', () => {
  it('is Hebrew until the person changes it, and nothing is saved before then', () => {
    render(<I18nProvider><Probe /></I18nProvider>)
    expect(state()).toBe('he/rtl')
    expect(window.localStorage.getItem('qr.lang')).toBeNull()
  })

  it('is saved on the phone when they change it, and the app opens in it next time', () => {
    const first = render(<I18nProvider><Probe /></I18nProvider>)
    fireEvent.click(screen.getByText('to Russian'))
    expect(state()).toBe('ru/ltr')
    expect(window.localStorage.getItem('qr.lang')).toBe('ru')
    first.unmount()

    render(<I18nProvider><Probe /></I18nProvider>) // the app opened again
    expect(state()).toBe('ru/ltr')
  })

  it('ignores a language that does not exist', () => {
    render(<I18nProvider><Probe /></I18nProvider>)
    fireEvent.click(screen.getByText('to nonsense'))
    expect(state()).toBe('he/rtl')
    expect(window.localStorage.getItem('qr.lang')).toBeNull()
  })

  it('stays after signing out (only the sign-in itself is cleared), like the light/dark choice', () => {
    window.localStorage.setItem('qr.lang', 'ar')
    window.localStorage.setItem('qr.theme', 'light')
    saveSession({ token: 'qrp_x', provider: { id: 'p1', company: 'c', contact_name: 'n' } }, true)
    expect(loadSession()).not.toBeNull()
    clearSession()
    expect(loadSession()).toBeNull()
    expect(window.localStorage.getItem('qr.lang')).toBe('ar')
    expect(window.localStorage.getItem('qr.theme')).toBe('light')
    render(<I18nProvider><Probe /></I18nProvider>)
    expect(state()).toBe('ar/rtl')
  })
})
