// localStorage that never throws (private mode, blocked storage, quota) and falls back to memory.
// The memory copy wins on reads, so a value that could not be persisted is still what the app sees
// (it lives until the tab closes). `setItem` says whether it really reached persistent storage.
const memory = new Map()

/**
 * A storage as the app uses one: `localStorage` is one, and so is `safeStorage`, whose `setItem` also says whether the value
 * reached persistent storage (a storage that returns nothing is taken as persisted, see createQueue).
 * @typedef {object} StorageLike
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => boolean | void} setItem
 * @property {(key: string) => void} removeItem
 */

export const safeStorage = {
  getItem(key) {
    if (memory.has(key)) return memory.get(key)
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  /** @returns {boolean} true if the value is in persistent storage, false if only in memory */
  setItem(key, value) {
    try {
      localStorage.setItem(key, value)
      memory.delete(key)
      return true
    } catch {
      memory.set(key, value)
      return false
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
    memory.delete(key)
  },
}

/**
 * The JSON that is stored under `key`, or `fallback` when there is none or it cannot be read.
 * @param {StorageLike} storage
 * @param {string} key
 * @param {any} fallback
 * @returns {any}
 */
export function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}
