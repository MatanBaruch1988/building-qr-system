import { useSyncExternalStore } from 'react'

// Light / dark appearance for both apps. The person's choice is "system" (follow the device: the default),
// "light" or "dark", kept on this device like the language. <html data-theme> always holds the RESOLVED value
// ("light" | "dark"), which is what ui.css styles. An inline script in index.html applies the same logic before the
// first paint, so keep THEME_KEY and the three values in step with it (tests/theme.test.js checks).

export const THEME_KEY = 'qr.theme'
export const THEMES = ['system', 'light', 'dark']
/** The browser/OS chrome colour (address bar, status bar) for each resolved theme: the same as --w-bg. */
export const CHROME_COLORS = { dark: '#0b0b0d', light: '#f4f5f7' }

export const isTheme = (value) => THEMES.includes(value)

const browserStorage = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The saved choice; anything missing or unknown means "system". */
export function readTheme(storage = browserStorage()) {
  try {
    const stored = storage?.getItem(THEME_KEY)
    return isTheme(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export const resolveTheme = (choice, prefersLight) => (choice === 'light' || choice === 'dark' ? choice : prefersLight ? 'light' : 'dark')

/** Puts the resolved theme on the document. Returns it. */
export function applyTheme(choice, { doc = document, prefersLight = false } = {}) {
  const resolved = resolveTheme(choice, prefersLight)
  const root = doc.documentElement
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME_COLORS[resolved])
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved)
  return resolved
}

// ---- the live store (one per page) ----

let choice = readTheme()
const listeners = new Set()
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null
const prefersLight = () => Boolean(media?.matches)

function apply() {
  const resolved = applyTheme(choice, { prefersLight: prefersLight() })
  // Things drawn outside CSS (the committee map) listen for this to restyle themselves.
  window.dispatchEvent(new CustomEvent('qr-theme-change', { detail: resolved }))
}
const notify = () => listeners.forEach((l) => l())

/** Call once at start-up. Follows the device while the choice is "system", and other tabs of the same app. */
export function initTheme() {
  choice = readTheme()
  apply()
  media?.addEventListener?.('change', () => choice === 'system' && apply())
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY) return
    choice = readTheme()
    apply()
    notify()
  })
}

export function setTheme(next) {
  if (!isTheme(next)) return
  try {
    window.localStorage.setItem(THEME_KEY, next)
  } catch {
    /* private mode: the choice just won't persist */
  }
  choice = next
  apply()
  notify()
}

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** { theme: 'system' | 'light' | 'dark', setTheme }. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => choice, () => 'system')
  return { theme, setTheme }
}
