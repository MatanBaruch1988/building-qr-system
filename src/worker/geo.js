// Best-effort location for the soft-GPS policy. Never throws and never blocks for long:
// the server treats a missing or vague fix as "unverified", not as a failure (see docs).
import { GPS_MAX_USABLE_ACCURACY_M, GPS_MAX_STALE_AGE_S } from '../../shared/contract.js'
import { safeStorage, readJson } from './storage.js'

/** @import { Gps } from '../../shared/types.js' */

/**
 * The accuracy, in meters, at which a point that requires the location stops waiting for a better reading. It is a choice of
 * this screen and the server never reads it (the server judges whatever accuracy arrives, up to GPS_MAX_USABLE_ACCURACY_M),
 * so it stays here and not in shared/contract.js. A phone with a clear view of the sky gets there within seconds, and a
 * reading this close keeps small the part of the fence that the phone's own inaccuracy widens (server/scanLogic.js).
 */
export const PRECISE_TARGET_ACCURACY_M = 30

/**
 * How long, in milliseconds, a point that requires the location waits for a reading as accurate as the target above before it
 * settles for the best one it has. Like the target, it belongs to this screen only. It is the time a person stands in front of
 * the "locating" screen, so it is short.
 */
export const PRECISE_WAIT_MS = 6000

/**
 * How long, in milliseconds, the last resort waits for the position that the browser itself remembers (see `lastKnownFix`).
 * That answer is either at hand or never comes, so the wait is short: it comes on top of the wait for a fresh reading.
 */
export const LAST_KNOWN_WAIT_MS = 1500

/**
 * Where the phone keeps the last usable reading that it got. Versioned like the queue's key (`qr.queue.v1`): a change of the
 * shape is a new key, and an old phone's value is never read as the new one.
 */
const LAST_FIX_KEY = 'qr.lastfix.v1'

/**
 * The reading that the phone keeps. `taken_at` is the reading's own timestamp, in milliseconds, and not the moment it was
 * stored, so keeping a reading again never makes it younger. The age is worked out when the reading is used.
 * @typedef {{ lat: number, lng: number, accuracy: number, taken_at: number }} StoredFix
 */

/**
 * A reading with the moment it was taken, in milliseconds: the internal shape that lets the app keep a reading with its own time
 * (`Gps` only carries the age that it had when it was handed over).
 * @typedef {{ fix: Gps, takenAt: number }} Reading
 */

/** How old a reading taken at `takenAt` (milliseconds) is now, in whole seconds. A clock that runs ahead gives 0, never a negative age. */
const ageOf = (takenAt) => Math.max(0, Math.round((Date.now() - takenAt) / 1000))

/** Can the server use this reading? One vaguer than GPS_MAX_USABLE_ACCURACY_M counts for nothing there, and so does none. */
export const isUsableFix = (fix) => Boolean(fix) && Number.isFinite(fix.accuracy) && fix.accuracy <= GPS_MAX_USABLE_ACCURACY_M

/**
 * A reading of the browser as the app sends it.
 * age_s: how old the reading is. A remembered position (maximumAge) is where the phone WAS, not where it is.
 * @param {GeolocationPosition} p
 * @returns {Gps}
 */
const fixOf = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, age_s: ageOf(p.timestamp) })

/**
 * The reading with its own time. The time is never later than now: a clock that runs ahead must not make a reading look younger
 * than it is, because the phone keeps it by that time.
 * @param {GeolocationPosition} p
 * @returns {Reading}
 */
const readingOf = (p) => ({ fix: fixOf(p), takenAt: Math.min(p.timestamp, Date.now()) })

/**
 * One geolocation request with a watchdog of our own. The browser's `timeout` only starts once the
 * permission question is answered, and some browsers (Firefox "Not now") never answer it at all.
 */
const ask = (options, watchdogMs) =>
  new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ reason: 'unsupported' })
    const timer = setTimeout(() => resolve({ reason: 'timeout' }), watchdogMs)
    const done = (value) => {
      clearTimeout(timer)
      resolve(value)
    }
    navigator.geolocation.getCurrentPosition(
      (p) => done(readingOf(p)),
      (e) => done({ reason: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }),
      options,
    )
  })

/**
 * The precise path, for a point that requires the location: it watches the position for a few seconds and keeps the best
 * reading, because the first reading is often the browser's estimate from Wi-Fi and cell towers, which can be off by a
 * hundred meters, and the server widens the fence by the accuracy that the phone reports. It stops as soon as a reading
 * reaches the target (PRECISE_TARGET_ACCURACY_M), and otherwise when the wait (PRECISE_WAIT_MS) is over.
 * Never rejects, and resolves once: the watch and the timers are always cleared.
 * @returns {Promise<{ fix: Gps | null, takenAt?: number, reason: string | null }>}  a reading vaguer than
 *   GPS_MAX_USABLE_ACCURACY_M is returned too, the server decides that it is not usable
 */
const watchPrecise = () =>
  new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve({ fix: null, reason: 'unsupported' })
    /** @type {GeolocationPosition | null} */
    let best = null
    let reason = null
    let settled = false
    let waited = false
    let waitTimer
    let graceTimer
    let watchId
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(waitTimer)
      clearTimeout(graceTimer)
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId)
      // The age is taken now, when the reading is handed over, as `ask` does: a reading from a few seconds ago is that old.
      resolve(best ? { ...readingOf(best), reason: null } : { fix: null, reason: reason ?? 'timeout' })
    }
    // With no reading yet (the permission question may still be open, or there is no signal) the browser may never answer,
    // so a watchdog of our own ends the wait, as in `ask`: the extra 2.5 seconds are the same. Once the wait is over, the
    // first reading that arrives ends it too, whatever its accuracy.
    waitTimer = setTimeout(() => {
      waited = true
      if (best) finish()
      else graceTimer = setTimeout(finish, 2500)
    }, PRECISE_WAIT_MS)
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p
        if (waited || best.coords.accuracy <= PRECISE_TARGET_ACCURACY_M) finish()
      },
      (e) => {
        // Only "denied" is final. An unavailable position or a timeout can pass: the browser keeps the watch alive.
        if (e.code === 1) {
          reason = 'denied'
          finish()
        } else {
          reason = e.code === 3 ? 'timeout' : 'unavailable'
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: PRECISE_WAIT_MS },
    )
    // A browser may answer before watchPosition returns its id.
    if (settled) navigator.geolocation.clearWatch(watchId)
  })

/**
 * The quick path: 1) accept a position up to `maxAgeMs` old, 2) if that is too vague, try once for a fresh reading.
 * Never rejects.
 * @param {{ quickMs: number, preciseMs: number, maxAgeMs: number }} waits
 * @returns {Promise<{ fix: Gps | null, takenAt?: number, reason: string | null }>}
 */
async function askQuick({ quickMs, preciseMs, maxAgeMs }) {
  const quick = await ask({ enableHighAccuracy: false, timeout: quickMs, maximumAge: maxAgeMs }, quickMs + 2500)
  if (quick.fix && isUsableFix(quick.fix)) return { ...quick, reason: null }
  if (quick.reason === 'denied' || quick.reason === 'unsupported') return { fix: null, reason: quick.reason }

  const fresh = await ask({ enableHighAccuracy: true, timeout: preciseMs, maximumAge: 0 }, preciseMs + 2500)
  const best = [quick, fresh].filter((r) => r.fix).sort((a, b) => a.fix.accuracy - b.fix.accuracy)[0]
  return best ? { ...best, reason: null } : { fix: null, reason: fresh.reason ?? quick.reason }
}

/**
 * The position that the phone kept, if it is young enough to send: no older than GPS_MAX_STALE_AGE_S, the age that the server
 * still credits walking for. One that is older, or that is not a reading at all (an older version of the app, or the storage was
 * touched), is deleted: it can never be used again.
 * @returns {StoredFix | null}
 */
function recallFix() {
  if (safeStorage.getItem(LAST_FIX_KEY) === null) return null
  const stored = readJson(safeStorage, LAST_FIX_KEY, null)
  const valid = stored !== null && typeof stored === 'object' && [stored.lat, stored.lng, stored.accuracy, stored.taken_at].every(Number.isFinite)
  // A time in the future means the clock was set back since: the age of the reading cannot be known, so it is not used.
  if (valid && stored.taken_at <= Date.now() && ageOf(stored.taken_at) <= GPS_MAX_STALE_AGE_S) return stored
  safeStorage.removeItem(LAST_FIX_KEY)
  return null
}

/**
 * Keeps a reading that the browser gave, so that a scan without a fresh position (no reception in a basement) can still say
 * where the phone was a few minutes earlier, on the way in. Only a usable reading is kept, one at most, and one that is younger
 * than the one already kept is never replaced by an older one.
 * @param {{ fix: Gps | null, takenAt?: number }} found  what a way of asking returned: a reading comes with its own time
 */
function rememberFix({ fix, takenAt }) {
  if (!isUsableFix(fix) || takenAt === undefined) return
  const kept = recallFix()
  if (kept && kept.taken_at > takenAt) return
  safeStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, taken_at: takenAt }))
}

/**
 * Forgets the kept position. Called when a person signs out or is signed out, so that on a shared phone the next person does
 * not send the previous one's position.
 */
export function forgetLastFix() {
  safeStorage.removeItem(LAST_FIX_KEY)
}

/**
 * The last resort when there is no fresh position: the youngest usable one of the position that the phone kept (recallFix) and
 * the one that the browser itself remembers, both no older than GPS_MAX_STALE_AGE_S. It is returned with the age that it really
 * has, and the server judges a reading that old without the room that a fresh one gets (server/scanLogic.js).
 * @returns {Promise<Gps | null>}
 */
async function lastKnownFix() {
  const stored = recallFix()
  const browser = await ask({ enableHighAccuracy: false, maximumAge: GPS_MAX_STALE_AGE_S * 1000, timeout: LAST_KNOWN_WAIT_MS }, LAST_KNOWN_WAIT_MS + 1000)
  // The person can have withdrawn the permission since the search began: then nothing remembered is sent either.
  if (browser.reason === 'denied') return null
  /** @type {Reading[]} */
  const candidates = []
  if (stored) candidates.push({ fix: { lat: stored.lat, lng: stored.lng, accuracy: stored.accuracy, age_s: ageOf(stored.taken_at) }, takenAt: stored.taken_at })
  if (browser.fix) candidates.push(browser)
  const youngest = candidates
    .filter((c) => isUsableFix(c.fix) && c.fix.age_s <= GPS_MAX_STALE_AGE_S)
    .sort((a, b) => b.takenAt - a.takenAt || a.fix.accuracy - b.fix.accuracy)[0]
  return youngest ? youngest.fix : null
}

/**
 * 1) Accept a position up to 5 minutes old (GPS_MAX_STALE_AGE_S, the age that the server credits walking for):
 *    people usually arrive from outside, where GPS worked, so this is instant and works indoors.
 *    2) If that is too vague, try once for a fresh fix.
 * With `precise` it does neither: it watches the position for a few seconds and returns the best reading
 * (watchPrecise above). A point that requires the location asks for that, because a quick estimate can be 150 m off.
 * Whichever way it went, a usable reading is kept on the phone (rememberFix). When the way ends without a usable reading, and not
 * because the person refused or the browser cannot, the last resort is the youngest position from the last 5 minutes that the
 * phone has (lastKnownFix), with its real age_s. There is no such resort after a refusal: a person who does not share the
 * location now must not have a remembered one sent in their place, and a browser without geolocation has nothing to remember.
 * Returns { fix, reason } where fix is {lat, lng, accuracy, age_s} or null.
 * @param {{ quickMs?: number, preciseMs?: number, maxAgeMs?: number, precise?: boolean }} [options]  the waits and the oldest
 *   position that is accepted, in milliseconds; `precise` takes the precise path, which ignores the other three
 * @returns {Promise<{ fix: Gps | null, reason: string | null }>}  `reason` says why there is no fix: denied, unsupported,
 *   timeout or unavailable
 */
export async function getFix({ quickMs = 4000, preciseMs = 3000, maxAgeMs = GPS_MAX_STALE_AGE_S * 1000, precise = false } = {}) {
  const found = precise ? await watchPrecise() : await askQuick({ quickMs, preciseMs, maxAgeMs })
  if (found.fix && isUsableFix(found.fix)) {
    rememberFix(found)
    return { fix: found.fix, reason: null }
  }
  // Not after "denied": the person has just refused to share the location, so the app must not send one it remembered from
  // before. Not after "unsupported" either: such a browser never gave the app a position to remember.
  if (found.reason !== 'denied' && found.reason !== 'unsupported') {
    const last = await lastKnownFix()
    if (last) return { fix: last, reason: null }
  }
  return { fix: found.fix, reason: found.reason }
}
