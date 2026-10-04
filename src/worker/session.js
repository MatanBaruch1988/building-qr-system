import { safeStorage, readJson } from './storage.js'

/** @import { Provider } from '../../shared/types.js' */

const KEY = 'qr.session'

/**
 * Who is signed in on this phone: the device token that the server gave at sign-in, and the provider.
 * @typedef {object} Session
 * @property {string} token
 * @property {Provider} provider
 * @property {boolean} [remember]  set by loadSession: where the session was kept (see saveSession)
 */

/**
 * The provider's signed-in state on this phone. "Remember me" keeps it in localStorage; otherwise it
 * lives in sessionStorage and disappears when the tab closes (for a shared phone).
 * @returns {Session | null}
 */
export function loadSession() {
  const fromLocal = readJson(safeStorage, KEY, null)
  if (fromLocal?.token) return { ...fromLocal, remember: true }
  try {
    const raw = sessionStorage.getItem(KEY)
    const s = raw ? JSON.parse(raw) : null
    if (s?.token) return { ...s, remember: false }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * @param {Session} session  only its `token` and `provider` are kept
 * @param {boolean} remember
 */
export function saveSession({ token, provider }, remember) {
  clearSession()
  const value = JSON.stringify({ token, provider })
  if (remember) safeStorage.setItem(KEY, value)
  else {
    try {
      sessionStorage.setItem(KEY, value)
    } catch {
      safeStorage.setItem(KEY, value)
    }
  }
}

export function clearSession() {
  safeStorage.removeItem(KEY)
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
