// @vitest-environment jsdom
// The screen that takes the place of one that broke while rendering (src/ui/ErrorBoundary.jsx): the words in each language,
// the way back, the one console line, and that it stands without the language provider.
//
// Every root here is made the way main.jsx makes the real one (createRoot with crashRootOptions), not with Testing Library's
// render: React's own handler for a caught error prints the message and the component stack, and the options are what
// replace it. A test that did not use them would not be testing what the app does.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, screen, fireEvent } from '@testing-library/react'
import ErrorBoundary from '../../src/ui/ErrorBoundary.jsx'
import { crashRootOptions } from '../../src/ui/crash.js'
import { I18nProvider, useI18n } from '../../src/i18n/index.jsx'
import { DICTS, LANGS } from '../../src/i18n/core.js'
import { isUpdateReady, applyUpdate } from '../../src/worker/update.js'

vi.mock('../../src/worker/update.js', () => ({ isUpdateReady: vi.fn(() => false), applyUpdate: vi.fn() }))

const roots = []
function mount(ui) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container, crashRootOptions)
  roots.push({ root, container })
  act(() => root.render(ui))
  return container
}
const unmountAll = () => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
}

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  broken.now = true
})

// A child whose failure the test controls: it throws while `broken.now` is true.
const broken = { now: true }
const SECRET = 'value-typed-by-a-person-8841'
function Child() {
  if (broken.now) throw new TypeError(SECRET)
  return <p>the screen works</p>
}
const failingApp = (props) => (
  <ErrorBoundary {...props}>
    <Child />
  </ErrorBoundary>
)
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('the fallback screen, in the provider app', () => {
  for (const { code, label, dir } of LANGS) {
    it(`speaks ${label} when that is the language chosen on the phone, and lays out ${dir}`, () => {
      quiet()
      window.localStorage.setItem('qr.lang', code)
      mount(failingApp({ app: 'provider' }))

      const heading = screen.getByRole('heading', { level: 1 })
      expect(heading.textContent).toBe(DICTS[code]['crash.title'])
      expect(screen.getByRole('button', { name: DICTS[code]['crash.retry'] })).toBeTruthy()
      expect(screen.getByRole('button', { name: DICTS[code]['crash.reload'] })).toBeTruthy()
      const root = heading.closest('[lang]')
      expect(root.getAttribute('lang')).toBe(code)
      expect(root.getAttribute('dir')).toBe(dir)
      expect(screen.queryByText('the screen works')).toBeNull()
    })
  }

  it('says, word for word, what the brief asks for in English', () => {
    quiet()
    window.localStorage.setItem('qr.lang', 'en')
    mount(failingApp({ app: 'provider' }))
    expect(screen.getByRole('heading').textContent).toBe('Something went wrong on this screen')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload the app' })).toBeTruthy()
  })

  it('is Hebrew when nothing was chosen', () => {
    quiet()
    mount(failingApp({ app: 'provider' }))
    expect(screen.getByRole('heading').textContent).toBe(DICTS.he['crash.title'])
  })

  it('is Hebrew when the saved choice is not a language we have', () => {
    quiet()
    window.localStorage.setItem('qr.lang', 'klingon')
    mount(failingApp({ app: 'provider' }))
    expect(screen.getByRole('heading').textContent).toBe(DICTS.he['crash.title'])
  })

  it('announces itself as an alert and puts the focus on its heading', () => {
    quiet()
    mount(failingApp({ app: 'provider' }))
    const heading = screen.getByRole('heading', { level: 1 })
    expect(screen.getByRole('alert').contains(heading)).toBe(true)
    expect(document.activeElement).toBe(heading)
  })

  it('still renders when the browser refuses access to the saved language', () => {
    quiet()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })
    mount(failingApp({ app: 'provider' }))
    expect(screen.getByRole('heading').textContent).toBe(DICTS.he['crash.title'])
  })
})

describe('the fallback screen, in the committee app', () => {
  it('is Hebrew and right to left, whatever language the phone has saved for the provider app', () => {
    quiet()
    window.localStorage.setItem('qr.lang', 'ru')
    mount(failingApp({ app: 'committee' }))
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe(DICTS.he['crash.title'])
    expect(heading.closest('[lang]').getAttribute('lang')).toBe('he')
    expect(heading.closest('[lang]').getAttribute('dir')).toBe('rtl')
    expect(screen.getByRole('button', { name: DICTS.he['crash.retry'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: DICTS.he['crash.reload'] })).toBeTruthy()
  })

  it('knows which app it is in from the address, as the app itself does', () => {
    quiet()
    window.localStorage.setItem('qr.lang', 'en')
    window.history.replaceState(null, '', '/admin')
    mount(failingApp())
    expect(screen.getByRole('heading').textContent).toBe(DICTS.he['crash.title']) // not the English of the provider app
  })

  it('treats every other address as the provider app, in the language chosen on the phone', () => {
    quiet()
    window.localStorage.setItem('qr.lang', 'en')
    window.history.replaceState(null, '', '/scan?code=BQR-sample')
    mount(failingApp())
    expect(screen.getByRole('heading').textContent).toBe(DICTS.en['crash.title'])
  })
})

describe('Try again', () => {
  it('renders the screen afresh once it no longer fails', () => {
    quiet()
    window.localStorage.setItem('qr.lang', 'en')
    mount(failingApp({ app: 'provider' }))
    expect(screen.getByRole('heading').textContent).toBe(DICTS.en['crash.title'])

    broken.now = false
    fireEvent.click(screen.getByRole('button', { name: DICTS.en['crash.retry'] }))
    expect(screen.getByText('the screen works')).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('shows the fallback again when the screen still fails, and works on the next try', () => {
    const logged = quiet()
    mount(failingApp({ app: 'provider' }))
    fireEvent.click(screen.getByRole('button', { name: DICTS.he['crash.retry'] }))
    expect(screen.getByRole('heading').textContent).toBe(DICTS.he['crash.title'])
    expect(logged).toHaveBeenCalledTimes(2) // one line per crash

    broken.now = false
    fireEvent.click(screen.getByRole('button', { name: DICTS.he['crash.retry'] }))
    expect(screen.getByText('the screen works')).toBeTruthy()
  })
})

describe('the console line', () => {
  it('is one line with the app and the error name, and holds neither the message nor a stack', () => {
    const logged = quiet()
    mount(failingApp({ app: 'provider' }))
    // React may render the failing child twice before it gives up (it retries once); it reports the crash once.
    expect(logged.mock.calls).toEqual([['Screen crash (provider app): TypeError']])
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET)
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/\bat \w|Child|componentStack/)
  })

  it('names the committee app when the crash is in /admin', () => {
    const logged = quiet()
    window.history.replaceState(null, '', '/admin')
    mount(failingApp())
    expect(logged.mock.calls).toEqual([['Screen crash (committee app): TypeError']])
  })

  it('does not repeat what a thrown string says', () => {
    const logged = quiet()
    function ThrowsString() {
      throw `a plain string holding ${SECRET}`
    }
    mount(
      <ErrorBoundary app="provider">
        <ThrowsString />
      </ErrorBoundary>,
    )
    expect(logged.mock.calls).toEqual([['Screen crash (provider app): UnknownError']])
    expect(screen.getByRole('heading')).toBeTruthy() // a string was thrown, the fallback is shown all the same
  })

  it('is also what is logged for a crash that no boundary caught (a blank page, but a named one)', async () => {
    const logged = quiet()
    // Inside act() React does not call onUncaughtError: it hands the error back to the test. So render the way the app
    // does, outside act(), and wait for the line.
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    try {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container, crashRootOptions)
      roots.push({ root, container })
      root.render(<Child />)
      await vi.waitFor(() => expect(logged).toHaveBeenCalled())
      expect(container.innerHTML).toBe('')
      expect(logged.mock.calls).toEqual([['Screen crash (provider app): TypeError']])
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true
    }
  })
})

describe('without the language provider', () => {
  function NeedsProvider() {
    useI18n() // throws outside an I18nProvider: the way the provider's own failure looks to a screen
    return <p>never shown</p>
  }
  function BrokenProvider() {
    throw new Error(SECRET)
  }

  it('renders in the saved language when a screen cannot find the provider', () => {
    quiet()
    window.localStorage.setItem('qr.lang', 'ar')
    mount(
      <ErrorBoundary app="provider">
        <NeedsProvider />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading').textContent).toBe(DICTS.ar['crash.title'])
    expect(screen.getByRole('heading').closest('[dir]').getAttribute('dir')).toBe('rtl')
  })

  it('renders in the saved language when the provider itself is what throws', () => {
    const logged = quiet()
    window.localStorage.setItem('qr.lang', 'ru')
    mount(
      <ErrorBoundary app="provider">
        <BrokenProvider />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading').textContent).toBe(DICTS.ru['crash.title'])
    expect(screen.getByRole('heading').closest('[dir]').getAttribute('dir')).toBe('ltr')
    expect(logged.mock.calls).toEqual([['Screen crash (provider app): Error']])
  })

  it('does not use a provider that is there: the fallback is the same with one below it', () => {
    quiet()
    window.localStorage.setItem('qr.lang', 'en')
    mount(
      <ErrorBoundary app="provider">
        <I18nProvider>
          <Child />
        </I18nProvider>
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading').textContent).toBe(DICTS.en['crash.title'])
  })
})

describe('Reload the app', () => {
  const stubLocation = () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, pathname: window.location.pathname, reload })
    return reload
  }

  it('reloads the page when no new version is waiting', () => {
    quiet()
    const reload = stubLocation()
    isUpdateReady.mockReturnValue(false)
    mount(failingApp({ app: 'provider' }))
    fireEvent.click(screen.getByRole('button', { name: DICTS.he['crash.reload'] }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(applyUpdate).not.toHaveBeenCalled()
  })

  it('applies the new version that is waiting instead, because that may be the fix', () => {
    vi.useFakeTimers()
    quiet()
    const reload = stubLocation()
    isUpdateReady.mockReturnValue(true)
    mount(failingApp({ app: 'provider' }))
    fireEvent.click(screen.getByRole('button', { name: DICTS.he['crash.reload'] }))
    expect(applyUpdate).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled() // the update reloads the page itself
  })
})
