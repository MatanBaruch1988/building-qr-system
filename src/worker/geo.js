// Best-effort location for the soft-GPS policy. Never throws and never blocks for long:
// the server treats a missing or vague fix as "unverified", not as a failure (see docs).
import { GPS_MAX_USABLE_ACCURACY_M, GPS_MAX_STALE_AGE_S } from '../../shared/contract.js'

/** @import { Gps } from '../../shared/types.js' */

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
      // age_s: how old the reading is. A remembered position (maximumAge) is where the phone WAS, not where it is.
      (p) => done({ fix: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, age_s: Math.max(0, Math.round((Date.now() - p.timestamp) / 1000)) } }),
      (e) => done({ reason: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }),
      options,
    )
  })

/**
 * 1) Accept a position up to 5 minutes old (GPS_MAX_STALE_AGE_S, the age that the server credits walking for):
 *    people usually arrive from outside, where GPS worked, so this is instant and works indoors.
 *    2) If that is too vague, try once for a fresh fix.
 * Returns { fix, reason } where fix is {lat, lng, accuracy, age_s} or null.
 * @param {{ quickMs?: number, preciseMs?: number, maxAgeMs?: number }} [options]  the waits and the oldest position that is
 *   accepted, in milliseconds
 * @returns {Promise<{ fix: Gps | null, reason: string | null }>}  `reason` says why there is no fix: denied, unsupported,
 *   timeout or unavailable
 */
export async function getFix({ quickMs = 4000, preciseMs = 3000, maxAgeMs = GPS_MAX_STALE_AGE_S * 1000 } = {}) {
  const quick = await ask({ enableHighAccuracy: false, timeout: quickMs, maximumAge: maxAgeMs }, quickMs + 2500)
  if (quick.fix && quick.fix.accuracy <= GPS_MAX_USABLE_ACCURACY_M) return { fix: quick.fix, reason: null }
  if (quick.reason === 'denied' || quick.reason === 'unsupported') return { fix: null, reason: quick.reason }

  const precise = await ask({ enableHighAccuracy: true, timeout: preciseMs, maximumAge: 0 }, preciseMs + 2500)
  const best = [quick.fix, precise.fix].filter(Boolean).sort((a, b) => a.accuracy - b.accuracy)[0] ?? null
  return { fix: best, reason: best ? null : precise.reason ?? quick.reason }
}
