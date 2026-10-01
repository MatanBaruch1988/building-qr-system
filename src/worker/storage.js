// localStorage that never throws (private mode, blocked storage, quota) and falls back to memory.
// The memory copy wins on reads, so a value that could not be persisted is still what the app sees
// (it lives until the tab closes). `setItem` says whether it really reached persistent storage.
const memory = new Map()

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

export function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}
