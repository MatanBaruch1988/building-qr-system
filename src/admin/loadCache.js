// The last answer of each load of the committee app, kept in memory for the life of the page.
//
// The app draws one tab at a time and draws it again from nothing each time the committee comes back to it, so without this every
// switch shows the loading state for the length of a round trip. With it, a tab that was open before draws what it showed then, at once,
// and asks the server for the current answer in the background (`useLoad` in hooks.js, and the History and audit screens, which page by
// themselves). Nothing here is written to the browser's storage: closing or reloading the page empties it.
//
// It holds what one committee member was shown, so it is emptied whenever the member changes: AdminApp calls `clearLoadCache` when the
// member signs out, when the server ends the session, and before a new sign-in. The cache is read only by screens inside the signed-in
// shell, and that shell appears only after a sign-in (emptied just before) or on a page that opened with a session (an empty cache), so
// a member never sees an earlier member's data.

/** The most entries kept. The History and audit screens add one per set of filters; the oldest goes first. */
const MAX_ENTRIES = 60

/** @type {Map<string, unknown>} */
const entries = new Map()
let epoch = 0

/**
 * The keys of the loads that more than one screen makes. A key names the request, so two screens that ask for the same thing share
 * one entry (a point that was renamed on one tab is renamed on the others at once).
 */
export const LOAD_KEY = Object.freeze({
  points: 'points',
  providers: 'providers',
  admins: 'admins',
  apiKeys: 'api-keys',
  building: 'building',
})

/** Forgets everything, and every answer that was asked for before this moment is never stored (it may belong to the member who just left). */
export function clearLoadCache() {
  entries.clear()
  epoch += 1
}

/** Forgets the entries whose key starts with `prefix`, for a screen whose rows its own action has just changed. */
export function dropLoadCache(prefix) {
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key)
}

/** The number to hold while a request is on its way and to give to `writeLoadCache` with its answer. */
export const loadCacheEpoch = () => epoch

/**
 * What was stored under `key`, or `undefined` when nothing was.
 * @param {string} key
 */
export const readLoadCache = (key) => entries.get(key)

/**
 * Stores an answer. It is dropped when the cache was emptied after the request was made (`asked` is `loadCacheEpoch()` from before it).
 * @param {string} key
 * @param {unknown} value  anything but `undefined`, which means "nothing stored"
 * @param {number} asked
 */
export function writeLoadCache(key, value, asked) {
  if (asked !== epoch || value === undefined) return
  entries.delete(key) // a key that is written again moves to the newest place
  entries.set(key, value)
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
}

/**
 * Puts a value that the app itself has just made (a saved setting) in the cache, so that the next time the screen opens it draws
 * what was saved, not what was read before.
 * @param {string} key
 * @param {unknown} value
 */
export const setLoadCache = (key, value) => writeLoadCache(key, value, epoch)
