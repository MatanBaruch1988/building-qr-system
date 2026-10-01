import { safeStorage, readJson } from './storage.js'

const KEY = 'qr.session'

/**
 * The provider's signed-in state on this phone. "Remember me" keeps it in localStorage; otherwise it
 * lives in sessionStorage and disappears when the tab closes (for a shared phone).
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
