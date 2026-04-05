/**
 * Calculate distance between two GPS coordinates using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in meters
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000 // Earth's radius in meters
  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const distance = R * c

  return Math.round(distance * 10) / 10 // Round to 1 decimal place
}

/**
 * Convert degrees to radians
 * @param {number} degrees
 * @returns {number}
 */
function toRadians(degrees) {
  return degrees * (Math.PI / 180)
}

/**
 * Check if a point is within a given radius of another point
 * @param {number} lat1 - Latitude of center point
 * @param {number} lon1 - Longitude of center point
 * @param {number} lat2 - Latitude of point to check
 * @param {number} lon2 - Longitude of point to check
 * @param {number} radiusMeters - Allowed radius in meters
 * @returns {{isWithin: boolean, distance: number}}
 */
export function isWithinRadius(lat1, lon1, lat2, lon2, radiusMeters) {
  const distance = calculateDistance(lat1, lon1, lat2, lon2)
  return {
    isWithin: distance <= radiusMeters,
    distance
  }
}

/**
 * Format distance for display
 * @param {number} meters - Distance in meters
 * @returns {string} Formatted distance string
 */
export function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)} מטר`
  }
  return `${(meters / 1000).toFixed(1)} ק"מ`
}

/**
 * Geofence configuration
 */
export const GEOFENCE_CONFIG = {
  SUCCESS_RADIUS: 50,    // מטר - אישור מלא (High Confidence)
  BUFFER_RADIUS: 100,    // מטר - אישור עם הערה (Medium/Low Confidence)
  DEFAULT_RADIUS: 50     // ברירת מחדל ליצירת נקודה חדשה
}

/**
 * Confidence levels for location validation
 */
export const CONFIDENCE_LEVELS = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
}

/**
 * Smart Geofencing - Validate location with confidence score
 *
 * Logic:
 * - distance <= 50m → HIGH confidence (definitely there)
 * - distance 50-100m && gpsAccuracy >= distance → MEDIUM confidence (GPS inaccurate, might be closer)
 * - distance 50-100m && gpsAccuracy < distance → LOW confidence (at the edge)
 * - distance > 100m → REJECT
 *
 * @param {number} distance - Distance from target in meters
 * @param {number} gpsAccuracy - GPS accuracy in meters (lower is better)
 * @param {number} successRadius - Radius for full success (default 50m)
 * @param {number} bufferRadius - Buffer zone outer radius (default 75m)
 * @returns {{isValid: boolean, confidence: string|null, distance: number, reason?: string}}
 */
export function validateWithConfidence(
  distance,
  gpsAccuracy,
  successRadius = GEOFENCE_CONFIG.SUCCESS_RADIUS,
  bufferRadius = GEOFENCE_CONFIG.BUFFER_RADIUS
) {
  // אזור ירוק - אישור מלא
  if (distance <= successRadius) {
    return {
      isValid: true,
      confidence: CONFIDENCE_LEVELS.HIGH,
      distance
    }
  }

  // אזור Buffer - בדיקה עם accuracy
  if (distance <= bufferRadius) {
    // אם ה-GPS לא מדויק (accuracy גבוה מהמרחק) - יש סיכוי שהעובד קרוב יותר
    if (gpsAccuracy >= distance) {
      return {
        isValid: true,
        confidence: CONFIDENCE_LEVELS.MEDIUM,
        distance,
        reason: 'דיוק GPS נמוך - ייתכן שאתה קרוב יותר'
      }
    }
    // accuracy טוב אבל העובד בקצה הטווח
    return {
      isValid: true,
      confidence: CONFIDENCE_LEVELS.LOW,
      distance,
      reason: 'נמצא בקצה הטווח המותר'
    }
  }

  // מחוץ לטווח
  return {
    isValid: false,
    confidence: null,
    distance,
    reason: `מחוץ לטווח המותר (${bufferRadius} מטר)`
  }
}

/**
 * Get confidence display info for UI
 * @param {string|null} confidence - Confidence level
 * @returns {{icon: string, color: string, label: string, badgeClass: string}}
 */
export function getConfidenceDisplay(confidence) {
  switch (confidence) {
    case CONFIDENCE_LEVELS.HIGH:
      return {
        icon: '✅',
        color: '#34C759',
        label: 'גבוה',
        badgeClass: 'badge-success'
      }
    case CONFIDENCE_LEVELS.MEDIUM:
      return {
        icon: '🟠',
        color: '#FF9500',
        label: 'בינוני',
        badgeClass: 'badge-warning'
      }
    case CONFIDENCE_LEVELS.LOW:
      return {
        icon: '🟡',
        color: '#FFCC00',
        label: 'נמוך',
        badgeClass: 'badge-warning'
      }
    default:
      return {
        icon: '❌',
        color: '#FF3B30',
        label: 'נדחה',
        badgeClass: 'badge-danger'
      }
  }
}
