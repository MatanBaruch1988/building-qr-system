// Best-effort location for the soft-GPS policy. Never throws and never blocks for long:
// the server treats a missing or vague fix as "unverified", not as a failure (see docs).
import { GPS_MAX_USABLE_ACCURACY_M, GPS_MAX_STALE_AGE_S } from '../../shared/contract.js'

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
 * A reading of the browser as the app sends it.
 * age_s: how old the reading is. A remembered position (maximumAge) is where the phone WAS, not where it is.
 * @param {GeolocationPosition} p
 * @returns {Gps}
 */
const fixOf = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, age_s: Math.max(0, Math.round((Date.now() - p.timestamp) / 1000)) })

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
      (p) => done({ fix: fixOf(p) }),
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
 * @returns {Promise<{ fix: Gps | null, reason: string | null }>}  a reading vaguer than GPS_MAX_USABLE_ACCURACY_M is returned
 *   too, the server decides that it is not usable
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
      resolve(best ? { fix: fixOf(best), reason: null } : { fix: null, reason: reason ?? 'timeout' })
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
 * 1) Accept a position up to 5 minutes old (GPS_MAX_STALE_AGE_S, the age that the server credits walking for):
 *    people usually arrive from outside, where GPS worked, so this is instant and works indoors.
 *    2) If that is too vague, try once for a fresh fix.
 * With `precise` it does neither: it watches the position for a few seconds and returns the best reading
 * (watchPrecise above). A point that requires the location asks for that, because a quick estimate can be 150 m off.
 * Returns { fix, reason } where fix is {lat, lng, accuracy, age_s} or null.
 * @param {{ quickMs?: number, preciseMs?: number, maxAgeMs?: number, precise?: boolean }} [options]  the waits and the oldest
 *   position that is accepted, in milliseconds; `precise` takes the precise path, which ignores the other three
 * @returns {Promise<{ fix: Gps | null, reason: string | null }>}  `reason` says why there is no fix: denied, unsupported,
 *   timeout or unavailable
 */
export async function getFix({ quickMs = 4000, preciseMs = 3000, maxAgeMs = GPS_MAX_STALE_AGE_S * 1000, precise = false } = {}) {
  if (precise) return watchPrecise()
  const quick = await ask({ enableHighAccuracy: false, timeout: quickMs, maximumAge: maxAgeMs }, quickMs + 2500)
  if (quick.fix && quick.fix.accuracy <= GPS_MAX_USABLE_ACCURACY_M) return { fix: quick.fix, reason: null }
  if (quick.reason === 'denied' || quick.reason === 'unsupported') return { fix: null, reason: quick.reason }

  const fresh = await ask({ enableHighAccuracy: true, timeout: preciseMs, maximumAge: 0 }, preciseMs + 2500)
  const best = [quick.fix, fresh.fix].filter(Boolean).sort((a, b) => a.accuracy - b.accuracy)[0] ?? null
  return { fix: best, reason: best ? null : fresh.reason ?? quick.reason }
}
