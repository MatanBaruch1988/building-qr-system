// The logic behind the crash screen (src/ui/crash.js): what is logged, the words, and "Reload the app".
// The screen itself is in tests/components/error-boundary.test.jsx.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import { errorName, crashLine, crashText, reloadApp, UPDATE_RELOAD_FALLBACK_MS } from '../src/ui/crash.js'
import { DICTS, LANGS } from '../src/i18n/core.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('what is logged for a crash', () => {
  it('is the name of the error, which app, and nothing else', () => {
    expect(crashLine(new TypeError('Cannot read properties of null (reading "name")'), 'provider')).toBe('Screen crash (provider app): TypeError')
    expect(crashLine(new RangeError('x'), 'committee')).toBe('Screen crash (committee app): RangeError')
  })

  it('does not take a name that holds free text, or anything that is not an error', () => {
    expect(errorName(Object.assign(new Error('x'), { name: 'name typed by somebody 12345' }))).toBe('UnknownError')
    expect(errorName('a thrown string')).toBe('UnknownError')
    expect(errorName({ name: 42 })).toBe('UnknownError')
    expect(errorName(null)).toBe('UnknownError')
    expect(errorName(undefined)).toBe('UnknownError')
    expect(errorName({ name: 'N'.repeat(65) })).toBe('UnknownError')
  })

  it('keeps a custom error class that has a plain name', () => {
    class ApiError extends Error {}
    ApiError.prototype.name = 'ApiError'
    expect(errorName(new ApiError('the server said something'))).toBe('ApiError')
  })

  it('survives an error whose name cannot be read', () => {
    const hostile = {
      get name() {
        throw new Error('no')
      },
    }
    expect(errorName(hostile)).toBe('UnknownError')
  })
})

describe('the words of the fallback screen', () => {
  it('exist in every language, so that a language added later cannot leave the crash screen untranslated', () => {
    for (const { code } of LANGS) {
      for (const key of ['crash.title', 'crash.retry', 'crash.reload']) expect(DICTS[code][key], `${code}:${key}`).toBeTruthy()
    }
  })

  it('are Hebrew for the committee app, whatever the phone has saved', () => {
    const store = new Map([['qr.lang', 'en']])
    vi.stubGlobal('localStorage', { getItem: (k) => store.get(k) ?? null })
    const text = crashText('committee')
    expect(text).toEqual({
      lang: 'he',
      dir: 'rtl',
      title: DICTS.he['crash.title'],
      retry: DICTS.he['crash.retry'],
      reload: DICTS.he['crash.reload'],
    })
  })

  it('are in the language saved on the phone for the provider app, and Hebrew without one', () => {
    const store = new Map()
    vi.stubGlobal('localStorage', { getItem: (k) => store.get(k) ?? null })
    expect(crashText('provider').lang).toBe('he')
    store.set('qr.lang', 'ru')
    expect(crashText('provider')).toMatchObject({ lang: 'ru', dir: 'ltr', title: DICTS.ru['crash.title'] })
    store.set('qr.lang', 'ar')
    expect(crashText('provider')).toMatchObject({ lang: 'ar', dir: 'rtl', title: DICTS.ar['crash.title'] })
  })
})

describe('Reload the app', () => {
  it('reloads the page when no new version is waiting', () => {
    const reload = vi.fn()
    const apply = vi.fn()
    reloadApp({ updateReady: () => false, apply, reload })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
  })

  it('applies a waiting new version, which reloads the page itself', () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    const apply = vi.fn()
    reloadApp({ updateReady: () => true, apply, reload })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads anyway when the update does not reload the page', () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    reloadApp({ updateReady: () => true, apply: vi.fn(), reload })
    vi.advanceTimersByTime(UPDATE_RELOAD_FALLBACK_MS - 1)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads at once when applying the update fails', () => {
    const reload = vi.fn()
    reloadApp({
      updateReady: () => true,
      apply: () => {
        throw new Error('no worker')
      },
      reload,
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('the wiring in main.jsx', () => {
  const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8')

  it('renders the whole app inside the error boundary', () => {
    expect(main).toMatch(/<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>/)
  })

  it('makes the root with the options that keep the message and the stack out of the console', () => {
    expect(main).toMatch(/createRoot\(document\.getElementById\('root'\), crashRootOptions\)/)
  })
})
