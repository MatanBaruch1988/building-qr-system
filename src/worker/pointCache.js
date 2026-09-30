import { safeStorage, readJson } from './storage.js'

const KEY = 'qr.points.v1'
const MAX = 50

/** Remembers point names/settings by QR token so the app can name the point (and skip GPS for
 *  basement points) even when the phone has no signal. */
export const getCachedPoint = (token, storage = safeStorage) => readJson(storage, KEY, {})[token] ?? null

export function setCachedPoint(token, point, storage = safeStorage) {
  const all = readJson(storage, KEY, {})
  all[token] = { ...point, seen_at: Date.now() }
  const keep = Object.entries(all).sort((a, b) => b[1].seen_at - a[1].seen_at).slice(0, MAX)
  storage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)))
}

export function dropCachedPoint(token, storage = safeStorage) {
  const all = readJson(storage, KEY, {})
  delete all[token]
  storage.setItem(KEY, JSON.stringify(all))
}
