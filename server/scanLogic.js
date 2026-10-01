// Pure scan rules (no database, no HTTP) so they are easy to test and reason about.
import {
  GPS_MAX_USABLE_ACCURACY_M,
  GPS_REJECT_MARGIN_M,
  GPS_REQUIRED_PIN_TOLERANCE_M,
  GPS_REQUIRED_MAX_CREDIT_M,
  CLOCK_MAX_AGE_MS,
  CLOCK_MAX_FUTURE_MS,
  CLOCK_SKEW_FLAG_MS,
} from './config.js'

const TOKEN_RE = /^BQR-[A-Za-z0-9-]{6,80}$/

/** Accepts the full printed URL (…/scan?code=BQR-…) or the bare BQR-… token. */
export function parseQrToken(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (TOKEN_RE.test(raw)) return raw
  try {
    const code = new URL(raw).searchParams.get('code')
    return code && TOKEN_RE.test(code) ? code : null
  } catch {
    return null
  }
}

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
 *  - mode 'optional' : a usable fix that is clearly far away (GPS_REJECT_MARGIN_M beyond the radius) is rejected
 *                      (catches "scanning a photo of the QR from home"); no / weak fix is accepted + `location_unverified`;
 *                      slightly outside the radius is accepted + `location_outside_radius`.
 *  - mode 'required' : strict. No usable fix is refused. A usable fix must be inside the circle, allowing the pin
 *                      tolerance and the phone's own (capped) inaccuracy; see config.js.
 * Returns { outcome, distance_m, gps_accuracy_m, flags }.
 */
export function evaluateGps({ mode, point, gps }) {
  const result = { outcome: 'accepted', distance_m: null, gps_accuracy_m: null, flags: [] }
  const hasFix = validGps(gps)
  const hasPointCoords = Number.isFinite(point.lat) && Number.isFinite(point.lng)

  if (hasFix) {
    const accuracy = Number.isFinite(gps.accuracy) ? Math.max(0, gps.accuracy) : null
    result.gps_accuracy_m = accuracy === null ? null : Math.round(accuracy)
    if (hasPointCoords) {
      result.distance_m = Math.round(haversineMeters(gps.lat, gps.lng, point.lat, point.lng))
    }
  }

  if (mode === 'none') return result
  if (!hasPointCoords) {
    // We were asked to check a location but the point has none configured: say so instead of
    // silently passing everyone (the committee can fix the point; the agent can see the flag).
    result.flags.push('location_unverified')
    return result
  }

  const usable =
    hasFix && result.gps_accuracy_m !== null && result.gps_accuracy_m <= GPS_MAX_USABLE_ACCURACY_M

  if (!usable) {
    if (mode === 'required') return { ...result, outcome: 'rejected_no_location' }
    result.flags.push('location_unverified')
    return result
  }

  if (mode === 'required') {
    // Strict: inside the circle, plus the pin tolerance, after crediting the phone's (capped) inaccuracy.
    const credit = Math.min(result.gps_accuracy_m, GPS_REQUIRED_MAX_CREDIT_M)
    const outside = result.distance_m - credit - point.radius_m
    if (outside > GPS_REQUIRED_PIN_TOLERANCE_M) return { ...result, outcome: 'rejected_far' }
    if (outside > 0) result.flags.push('location_outside_radius')
    return result
  }

  // 'optional': only a clearly distant fix is refused; slightly outside is accepted and flagged.
  const slack = result.distance_m - result.gps_accuracy_m
  if (slack > GPS_REJECT_MARGIN_M) return { ...result, outcome: 'rejected_far' }
  if (slack > point.radius_m) result.flags.push('location_outside_radius')
  return result
}

/**
 * Decides which time to store. `checked_in_at` is our best estimate of when the person really
 * scanned; `received_at` (server clock) is stored separately by the database default.
 */
export function resolveClock({ source, clientTime, now }) {
  const flags = []
  const client = clientTime ? new Date(clientTime) : null
  // Also rejects absurd dates (year -271821…) that the database cannot store.
  const clientOk = client && !Number.isNaN(client.getTime()) && client.getUTCFullYear() >= 2000 && client.getUTCFullYear() <= 2100

  if (source === 'offline_sync') {
    flags.push('offline_sync')
    if (clientOk) {
      const age = now.getTime() - client.getTime()
      if (age >= -CLOCK_MAX_FUTURE_MS && age <= CLOCK_MAX_AGE_MS) {
        return { checkedInAt: age < 0 ? now : client, clientTime: client, flags }
      }
    }
    flags.push('clock_skew')
    return { checkedInAt: now, clientTime: clientOk ? client : null, flags }
  }

  // A phone that sent a time we cannot believe (or one far from the server's) is worth a flag.
  if ((clientTime && !clientOk) || (clientOk && Math.abs(now.getTime() - client.getTime()) > CLOCK_SKEW_FLAG_MS)) {
    flags.push('clock_skew')
  }
  return { checkedInAt: now, clientTime: clientOk ? client : null, flags }
}
