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
 * Where the phone keeps the last usable reading that it took live (see `rememberFix`). Versioned like the queue's key
 * (`qr.queue.v1`): a change of the shape is a new key, and an old phone's value is never read as the new one.
 */
const LAST_FIX_KEY = 'qr.lastfix.v1'

/**
 * The reading that the phone keeps. `taken_at` is the reading's own timestamp, in milliseconds, and not the moment it was
 * stored, so keeping a reading again never makes it younger. The age is worked out when the reading is used.
 * @typedef {{ lat: number, lng: number, accuracy: number, taken_at: number }} StoredFix
 */

/**
 * A reading with the moment it was taken, in milliseconds: the internal shape that lets the app keep a reading with its own time
 * (`Gps` only carries the age that it had when it was handed over). `live` says that the browser took it for this very request
 * (asked with `maximumAge: 0`), and not that it gave back a position that it remembered: only a live reading is ever kept.
 * @typedef {{ fix: Gps, takenAt: number, live: boolean }} Reading
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
 * @param {boolean} live  the browser took it for this request (it was asked with `maximumAge: 0`)
 * @returns {Reading}
 */
const readingOf = (p, live) => ({ fix: fixOf(p), takenAt: Math.min(p.timestamp, Date.now()), live })

/**
 * One geolocation request with a watchdog of our own. The browser's `timeout` only starts once the
 * permission question is answered, and some browsers (Firefox "Not now") never answer it at all.
 * The reading is marked live when the request allowed no remembered position (`maximumAge: 0`).
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
      (p) => done(readingOf(p, options.maximumAge === 0)),
      (e) => done({ reason: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }),
      options,
    )
  })

/**
 * The precise path, for a point that requires the location: it watches the position for a few seconds and keeps the best
 * reading, because the first reading is often the browser's estimate from Wi-Fi and cell towers, which can be off by a
 * hundred meters, and the server widens the fence by the accuracy that the phone reports. It stops as soon as a reading
 * reaches the target (PRECISE_TARGET_ACCURACY_M), and otherwise when the wait (PRECISE_WAIT_MS) is over.
 * Never rejects, and resolves once: the watch and the timers are always cleared. The watch allows no remembered position
 * (`maximumAge: 0`), so what it returns is always live.
 * @returns {Promise<{ fix: Gps | null, takenAt?: number, live?: boolean, reason: string | null }>}  a reading vaguer than
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
      resolve(best ? { ...readingOf(best, true), reason: null } : { fix: null, reason: reason ?? 'timeout' })
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
 * Never rejects. Only the second request is live: the first can give back a position that the browser remembered.
 * @param {{ quickMs: number, preciseMs: number, maxAgeMs: number }} waits
 * @returns {Promise<{ fix: Gps | null, takenAt?: number, live?: boolean, reason: string | null }>}
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
 * still credits walking for. One that is older, or that is not a usable reading at all (an older version of the app, or the storage
 * was touched), is deleted: it can never be used again.
 * @returns {StoredFix | null}
 */
function recallFix() {
  if (safeStorage.getItem(LAST_FIX_KEY) === null) return null
  const stored = readJson(safeStorage, LAST_FIX_KEY, null)
  const valid = stored !== null && typeof stored === 'object' && [stored.lat, stored.lng, stored.accuracy, stored.taken_at].every(Number.isFinite) && isUsableFix(stored)
  // A time in the future means the clock was set back since: the age of the reading cannot be known, so it is not used.
  if (valid && stored.taken_at <= Date.now() && ageOf(stored.taken_at) <= GPS_MAX_STALE_AGE_S) return stored
  safeStorage.removeItem(LAST_FIX_KEY)
  return null
}

/**
 * Keeps a reading, so that a later scan of the same person with no fresh position (no reception in a basement) can still say
 * where the phone was a few minutes earlier, on the way in. Only a usable reading that the browser took live for the request is
 * kept: never a position that it remembered and handed back (the quick path's first request), because that can be a position
 * from before the person signed in, and the app cannot clear the browser's own memory at sign-out. So what is kept was always
 * taken during the signed-in person's own scans, and forgetLastFix deletes it when they leave. One position at most, and one
 * that is younger than the one already kept is never replaced by an older one.
 * @param {{ fix: Gps | null, takenAt?: number, live?: boolean }} found  what a way of asking returned: a reading comes with
 *   its own time, and says whether it is live
 */
function rememberFix({ fix, takenAt, live }) {
  if (!live || !isUsableFix(fix) || takenAt === undefined) return
  const kept = recallFix()
  if (kept && kept.taken_at > takenAt) return
  safeStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, taken_at: takenAt }))
}

/**
 * Forgets the kept position. Called when a person signs in, signs out or is signed out, so that on a shared phone a scan never
 * carries a position from before the person signed in.
 */
export function forgetLastFix() {
  safeStorage.removeItem(LAST_FIX_KEY)
}

/**
 * The last resort when there is no fresh position: the position that the phone kept (recallFix), no older than
 * GPS_MAX_STALE_AGE_S. It is returned with the age that it really has, and the server judges a reading that old without the room
 * that a fresh one gets (server/scanLogic.js). The browser's own last known position is not used on purpose: it may have been
 * taken before the person signed in, perhaps for the previous person on a shared phone, and the app cannot clear it at sign-out.
 * @returns {Gps | null}
 */
function lastKnownFix() {
  const stored = recallFix()
  return stored ? { lat: stored.lat, lng: stored.lng, accuracy: stored.accuracy, age_s: ageOf(stored.taken_at) } : null
}

/**
 * 1) Accept a position up to 5 minutes old (GPS_MAX_STALE_AGE_S, the age that the server credits walking for):
 *    people usually arrive from outside, where GPS worked, so this is instant and works indoors.
 *    2) If that is too vague, try once for a fresh fix.
 * With `precise` it does neither: it watches the position for a few seconds and returns the best reading
 * (watchPrecise above). A point that requires the location asks for that, because a quick estimate can be 150 m off.
 * A usable reading that the browser took live for this request is kept on the phone (rememberFix); one that it handed back from
 * its memory is not. When the way ends without a usable reading, and not because the person refused or the browser cannot, the
 * last resort is the position that the phone kept from the last 5 minutes (lastKnownFix), with its real age_s. There is no such
 * resort after a refusal: a person who does not share the location now must not have a remembered one sent in their place, and
 * a browser without geolocation never gave the app a position to keep.
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
    const last = lastKnownFix()
    if (last) return { fix: last, reason: null }
  }
  return { fix: found.fix, reason: found.reason }
}
