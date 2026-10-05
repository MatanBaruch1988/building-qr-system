// Pure scan rules (no database, no HTTP) so they are easy to test and reason about.
import {
  GPS_MAX_USABLE_ACCURACY_M,
  GPS_PIN_TOLERANCE_M,
  GPS_MAX_ACCURACY_CREDIT_M,
  GPS_STALE_AFTER_S,
  GPS_MAX_STALE_AGE_S,
  GPS_WALKING_SPEED_MPS,
  CLOCK_MAX_AGE_MS,
  CLOCK_MAX_FUTURE_MS,
  CLOCK_SKEW_FLAG_MS,
} from './config.js'
import {
  FLAG_LOCATION_UNVERIFIED,
  FLAG_LOCATION_OUTSIDE_RADIUS,
  FLAG_LOCATION_STALE,
  FLAG_OFFLINE_SYNC,
  FLAG_CLOCK_SKEW,
} from '../shared/flags.js'
import {
  GPS_MODE_NONE,
  GPS_MODE_OPTIONAL,
  GPS_MODE_REQUIRED,
  OUTCOME_ACCEPTED,
  OUTCOME_REJECTED_FAR,
  OUTCOME_REJECTED_NO_LOCATION,
  SOURCE_OFFLINE_SYNC,
} from '../shared/contract.js'

// "What is one of our QR codes" is shared with the phone (shared/qrToken.js); it is still importable from here.
export { parseQrToken } from '../shared/qrToken.js'

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function validGps(gps) {
  return (
    gps &&
    Number.isFinite(gps.lat) &&
    Number.isFinite(gps.lng) &&
    Math.abs(gps.lat) <= 90 &&
    Math.abs(gps.lng) <= 180
  )
}

/**
 * Soft GPS policy.
 *  - mode 'none'     : never judged (basement points with no reception). Evidence is still stored.
 *  - a usable fix (accuracy <= GPS_MAX_USABLE_ACCURACY_M) must be inside the point's circle, allowing the pin
 *    tolerance and the phone's own (capped) inaccuracy (config.js); otherwise it is rejected (catches "scanning a
 *    photo of the QR from home"). Slightly outside, within the tolerance, is accepted + `location_outside_radius`.
 *  - a remembered fix (age_s over GPS_STALE_AFTER_S) is flagged `location_stale`; on 'optional' points it also gets
 *    room for the walking done since (config.js). 'required' points ask for a fresh reading and get no such room.
 *  - no / weak fix   : 'required' refuses it; 'optional' accepts it + `location_unverified` (basements, stairwells).
 * 'required' and 'optional' therefore differ only in what happens when the phone cannot say where it is.
 * Returns { outcome, distance_m, gps_accuracy_m, flags }.
 */
export function evaluateGps({ mode, point, gps }) {
  const result = { outcome: OUTCOME_ACCEPTED, distance_m: null, gps_accuracy_m: null, flags: [] }
  const hasFix = validGps(gps)
  const hasPointCoords = Number.isFinite(point.lat) && Number.isFinite(point.lng)

  if (hasFix) {
    const accuracy = Number.isFinite(gps.accuracy) ? Math.max(0, gps.accuracy) : null
    result.gps_accuracy_m = accuracy === null ? null : Math.round(accuracy)
    if (hasPointCoords) {
      result.distance_m = Math.round(haversineMeters(gps.lat, gps.lng, point.lat, point.lng))
    }
  }

  if (mode === GPS_MODE_NONE) return result
  if (!hasPointCoords) {
    // We were asked to check a location but the point has none configured: say so instead of
    // silently passing everyone (the committee can fix the point; the agent can see the flag).
    result.flags.push(FLAG_LOCATION_UNVERIFIED)
    return result
  }

  const usable =
    hasFix && result.gps_accuracy_m !== null && result.gps_accuracy_m <= GPS_MAX_USABLE_ACCURACY_M

  if (!usable) {
    if (mode === GPS_MODE_REQUIRED) return { ...result, outcome: OUTCOME_REJECTED_NO_LOCATION }
    result.flags.push(FLAG_LOCATION_UNVERIFIED)
    return result
  }

  // The same strictness for 'required' and 'optional': inside the circle, plus the pin tolerance, after crediting
  // the phone's (capped) inaccuracy. Slightly outside (within the tolerance) is accepted and flagged.
  const credit = Math.min(result.gps_accuracy_m, GPS_MAX_ACCURACY_CREDIT_M)
  // A remembered reading is where the phone WAS. On 'optional' points the person may have walked since (arriving
  // from the lobby to a basement, say), so a stale reading is judged with that much extra room, and is flagged.
  const age = Number.isFinite(gps.age_s) ? Math.max(0, gps.age_s) : 0
  const stale = age > GPS_STALE_AFTER_S
  const walked = mode === GPS_MODE_OPTIONAL && stale ? Math.min(age, GPS_MAX_STALE_AGE_S) * GPS_WALKING_SPEED_MPS : 0
  const outside = result.distance_m - credit - walked - point.radius_m
  if (outside > GPS_PIN_TOLERANCE_M) return { ...result, outcome: OUTCOME_REJECTED_FAR }
  if (outside > 0) result.flags.push(FLAG_LOCATION_OUTSIDE_RADIUS)
  if (stale) result.flags.push(FLAG_LOCATION_STALE)
  return result
}

/**
 * The phone's clock as a Date, or null when there is none or it cannot be believed: not a time, or a year outside 2000 to
 * 2100 (that also rejects absurd dates, year -271821 and the like, which the database cannot store). The one reading of
 * `client_time`, for a scan (resolveClock) and for the record of a refused visit (server/scanRefusals.js).
 */
export function parseClientTime(clientTime) {
  const client = clientTime ? new Date(clientTime) : null
  return client && !Number.isNaN(client.getTime()) && client.getUTCFullYear() >= 2000 && client.getUTCFullYear() <= 2100 ? client : null
}

/**
 * Decides which time to store. `checked_in_at` is our best estimate of when the person really
 * scanned; `received_at` (server clock) is stored separately by the database default.
 */
export function resolveClock({ source, clientTime, now }) {
  const flags = []
  const client = parseClientTime(clientTime)
  const clientOk = client !== null

  if (source === SOURCE_OFFLINE_SYNC) {
    flags.push(FLAG_OFFLINE_SYNC)
    if (clientOk) {
      const age = now.getTime() - client.getTime()
      if (age >= -CLOCK_MAX_FUTURE_MS && age <= CLOCK_MAX_AGE_MS) {
        return { checkedInAt: age < 0 ? now : client, clientTime: client, flags }
      }
    }
    flags.push(FLAG_CLOCK_SKEW)
    return { checkedInAt: now, clientTime: clientOk ? client : null, flags }
  }

  // A phone that sent a time we cannot believe (or one far from the server's) is worth a flag.
  if ((clientTime && !clientOk) || (clientOk && Math.abs(now.getTime() - client.getTime()) > CLOCK_SKEW_FLAG_MS)) {
    flags.push(FLAG_CLOCK_SKEW)
  }
  return { checkedInAt: now, clientTime: clientOk ? client : null, flags }
}
