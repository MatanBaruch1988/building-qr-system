import { db } from './firebase'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import { parseQRCodeData, extractCodeFromQRData } from '../utils/qrGenerator'
import { getCurrentPosition, isGeolocationAvailable } from './geolocation'
import { calculateDistance, formatDistance, validateWithConfidence, GEOFENCE_CONFIG } from '../utils/distance'
import { savePendingScan, isOnline } from './offlineStorage'
import { checkWorkerAccess } from '../utils/permissions'

/**
 * Find a location matching the scanned QR code
 * @param {string} code - The raw QR code data
 * @param {Array} locations - Array of location objects from Firebase
 * @returns {{ location?: Object, error?: string }}
 */
function findLocationByCode(code, locations) {
  const parseResult = parseQRCodeData(code)
  if (!parseResult.isValid) {
    return { error: parseResult.error || 'קוד QR לא תקין' }
  }

  const location = locations.find(loc => {
    if (!loc || !loc.qrCode) return false
    const locCode = extractCodeFromQRData(loc.qrCode)
    if (locCode && locCode === parseResult.fullCode) return true
    if (loc.qrCode === parseResult.fullCode) return true
    if (parseResult.locationId && loc.id === parseResult.locationId) return true
    return false
  })

  if (!location) {
    return { error: `קוד QR לא נמצא במערכת. קוד: ${parseResult.fullCode || code}` }
  }

  return { location }
}

/**
 * Validate that location and worker data are complete and that
 * the worker has permission to scan at this location
 * @param {Object} location - The matched location object
 * @param {Object} worker - The current worker object
 * @returns {{ valid: true } | { valid: false, error: string, details?: string }}
 */
function validateScanData(location, worker) {
  if (!location || !location.id || !location.name) {
    return {
      valid: false,
      error: 'נתוני נקודה חסרים',
      details: 'אובייקט הנקודה חסר או לא מכיל שדות נדרשים (id, name)'
    }
  }

  if (!worker || !worker.id) {
    return {
      valid: false,
      error: 'נתוני עובד חסרים',
      details: 'אובייקט העובד חסר או לא מכיל שדה id'
    }
  }

  const access = checkWorkerAccess(location, worker)
  if (!access.allowed) {
    return {
      valid: false,
      error: 'אין לך הרשאה לסרוק בנקודה זו',
      details: `הנקודה משויכת ל: ${access.assignedNames}`
    }
  }

  return { valid: true }
}

/**
 * Get the device GPS position, checking availability first
 * @returns {Promise<{ latitude: number, longitude: number, accuracy: number }>}
 * @throws {Error} Hebrew error message if GPS is unavailable
 */
async function getGPSPosition() {
  if (!isGeolocationAvailable()) {
    throw new Error('GPS לא זמין במכשיר זה')
  }
  return await getCurrentPosition()
}

/**
 * Validate that the device is within the allowed geofence of the location
 * @param {Object} location - Location with latitude/longitude fields
 * @param {{ latitude: number, longitude: number, accuracy: number }} position - Device position
 * @returns {{ isValid: boolean, distance: number, validation?: Object, error?: string, details?: string }}
 */
function validateGeofence(location, position) {
  const distance = calculateDistance(
    location.latitude,
    location.longitude,
    position.latitude,
    position.longitude
  )

  const validation = validateWithConfidence(distance, position.accuracy)

  if (!validation.isValid) {
    return {
      isValid: false,
      distance,
      error: validation.reason,
      details: `מרחק: ${formatDistance(distance)}, דיוק GPS: ${Math.round(position.accuracy)} מטר`
    }
  }

  return { isValid: true, distance, validation }
}

/**
 * Save a completed scan to Firebase (online) or local storage (offline)
 * @param {Object} scanData - The scan data to persist
 * @param {boolean} onlineStatus - Whether the device is currently online
 * @returns {Promise<{ scanId: string, savedOffline: boolean }>}
 */
async function saveScan(scanData, onlineStatus) {
  if (onlineStatus) {
    try {
      const docRef = await addDoc(collection(db, 'scans'), {
        ...scanData,
        createdAt: serverTimestamp()
      })
      return { scanId: docRef.id, savedOffline: false }
    } catch (error) {
      console.error('Firebase save error, falling back to offline:', error)
      // Fall through to offline save instead of throwing
    }
  }

  const offlineResult = savePendingScan(scanData)
  return { scanId: offlineResult.id, savedOffline: true }
}

/**
 * Save a failed scan attempt to Firebase for investigation.
 * Fire-and-forget: errors are silently caught.
 * @param {Object} location - The target location
 * @param {Object} worker - The worker who attempted the scan
 * @param {{ latitude: number, longitude: number, accuracy: number }} position - Device position
 * @param {number} distance - Calculated distance in meters
 */
async function saveFailedScan(location, worker, position, distance) {
  try {
    await addDoc(collection(db, 'failedScans'), {
      locationId: location.id,
      locationName: location.name,
      workerId: worker.id,
      workerName: worker.company || worker.name,
      deviceLatitude: position.latitude,
      deviceLongitude: position.longitude,
      gpsAccuracy: position.accuracy,
      distanceMeters: distance,
      timestamp: new Date().toISOString(),
      createdAt: serverTimestamp()
    })
  } catch (_err) {
    // Fire and forget - do not propagate
  }
}

/**
 * Process a QR scan end-to-end: parse code, validate location & permissions,
 * check GPS geofence, and persist the result.
 *
 * @param {string} code - Raw QR code data from the scanner
 * @param {Array} locations - All locations loaded from Firebase
 * @param {Object} worker - The authenticated worker object
 * @param {(message: string) => void} onProgress - Callback for UI status updates
 * @returns {Promise<Object>} Result object with `success` flag and details
 */
export async function processQRScan(code, locations, worker, onProgress) {
  // 1. Parse and find matching location
  onProgress('מעבד קוד QR...')

  const findResult = findLocationByCode(code, locations)
  if (findResult.error) {
    return { success: false, error: findResult.error }
  }
  const { location } = findResult

  // 2. Validate data and worker permissions
  const validation = validateScanData(location, worker)
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      details: validation.details,
      location: location.name
    }
  }

  // 3. Acquire GPS position
  onProgress('בודק מיקום GPS...')
  let position
  try {
    position = await getGPSPosition()
  } catch (err) {
    return { success: false, error: err.message }
  }

  // 4. Validate geofence
  const geoResult = validateGeofence(location, position)
  if (!geoResult.isValid) {
    await saveFailedScan(location, worker, position, geoResult.distance)
    return {
      success: false,
      error: 'אתה רחוק מדי מהנקודה',
      details: `מרחק: ${formatDistance(geoResult.distance)}. טווח מותר: עד ${GEOFENCE_CONFIG.BUFFER_RADIUS} מטר`,
      location: location.name,
      distance: geoResult.distance
    }
  }

  // 5. Persist the scan
  onProgress('שומר סריקה...')
  const scanData = {
    locationId: location.id,
    locationName: location.name,
    workerId: worker.id,
    workerName: worker.company || worker.name,
    timestamp: new Date().toISOString(),
    deviceLatitude: position.latitude,
    deviceLongitude: position.longitude,
    distanceMeters: geoResult.distance,
    isValid: true,
    gpsAccuracy: position.accuracy,
    confidenceScore: geoResult.validation.confidence
  }

  const saveResult = await saveScan(scanData, isOnline())

  return {
    success: true,
    location: location.name,
    worker: worker.company || worker.name,
    distance: geoResult.distance,
    timestamp: new Date(),
    scanId: saveResult.scanId,
    savedOffline: saveResult.savedOffline,
    confidenceScore: geoResult.validation.confidence
  }
}
