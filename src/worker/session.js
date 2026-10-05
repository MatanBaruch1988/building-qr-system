import { safeStorage } from './storage.js'
import { PROVIDER_TOKEN_PREFIX, MAX_TOKEN_LENGTH } from '../../shared/contract.js'

/** @import { Provider } from '../../shared/types.js' */

const KEY = 'qr.session'

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Is this a device token that the server could have minted? The same shape that the server checks before any query
 * (isProviderToken in server/auth.js): its prefix, at least one more character, and not longer than a token can be.
 * @param {any} token
 */
export const isProviderToken = (token) =>
  typeof token === 'string' &&
  token.length > PROVIDER_TOKEN_PREFIX.length &&
  token.startsWith(PROVIDER_TOKEN_PREFIX) &&
  token.length <= MAX_TOKEN_LENGTH

/**
 * Can the provider app draw its screens from these provider details? It needs exactly what it reads: `id` (it owns the
 * check-ins that wait on the phone), `company` and, when there is one, `contact_name` (the greeting and "who signed in").
 * Nothing else is required or looked at, so every shape that a version of the server ever sent still passes: the details
 * that POST /api/session sent before the language moved to the phone also carried `lang`, GET /api/session adds `is_demo`,
 * and a field that is missing or unknown is left alone. (`contact_name` is '' for a provider without a contact person.)
 * @param {any} provider
 */
export function isProvider(provider) {
  return (
    isRecord(provider) &&
    typeof provider.id === 'string' &&
    provider.id !== '' &&
    typeof provider.company === 'string' &&
    (provider.contact_name === undefined || provider.contact_name === null || typeof provider.contact_name === 'string')
  )
}

/**
 * Is this what the app stored when somebody signed in: a device token and the provider's details? The home screen reads
 * `session.provider` on every start, so a stored value without usable details would break it on every start, and the only
 * way out for the person would be to clear the site's data.
 * @param {any} value
 */
export const isSession = (value) => isRecord(value) && isProviderToken(value.token) && isProvider(value.provider)

/**
 * The stored session of one storage, or null. A value that is there but is not a usable session (not JSON, no provider
 * details, a token that is not ours) is removed from that storage, so that the person sees the sign-in list instead of a
 * screen that fails on every start. Only the storage that held the bad value is touched.
 * @param {{ getItem(key: string): string | null, removeItem(key: string): void }} storage
 * @param {boolean} remember
 */
function readFrom(storage, remember) {
  const raw = storage.getItem(KEY)
  if (typeof raw !== 'string') return null
  let value = null
  try {
    value = JSON.parse(raw)
  } catch {
    /* not JSON: removed below */
  }
  if (isSession(value)) return { ...value, remember }
  storage.removeItem(KEY)
  return null
}

// sessionStorage can throw when it is touched (blocked storage): then there is simply no session in it.
const tabStorage = {
  getItem(key) {
    try {
      return sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  removeItem(key) {
    try {
      sessionStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  },
}

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
 *
 * What is read here was written by this app, possibly by an older version of it that has kept the phone for weeks. A
 * value that is not a usable session (see isSession) is removed and counts as signed out.
 * @returns {Session | null}
 */
export function loadSession() {
  return readFrom(safeStorage, true) ?? readFrom(tabStorage, false)
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
