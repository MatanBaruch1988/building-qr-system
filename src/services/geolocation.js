/**
 * Get current position using browser's Geolocation API
 * Uses a two-phase approach: first try with cache, then high accuracy if needed
 * @param {Object} options - Geolocation options
 * @returns {Promise<{latitude: number, longitude: number, accuracy: number}>}
 */
export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported by this browser'))
      return
    }

    // First try: use cached position (up to 30 seconds old) for faster response
    const fastOptions = {
      enableHighAccuracy: false,
      timeout: 3000,
      maximumAge: 30000, // Accept position up to 30 seconds old
      ...options
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        // If accuracy is good enough (under 100m), use it
        if (position.coords.accuracy <= 100) {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy
          })
        } else {
          // Otherwise, try to get a more accurate position
          getHighAccuracyPosition(resolve, reject)
        }
      },
      () => {
        // Fast attempt failed, try high accuracy
        getHighAccuracyPosition(resolve, reject)
      },
      fastOptions
    )
  })
}

/**
 * Get high accuracy position (fallback)
 */
function getHighAccuracyPosition(resolve, reject) {
  navigator.geolocation.getCurrentPosition(
    (position) => {
      resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      })
    },
    (error) => {
      let message = 'שגיאה בקבלת מיקום'
      switch (error.code) {
        case error.PERMISSION_DENIED:
          message = 'נדחתה הרשאת מיקום. אנא אפשר גישה למיקום בהגדרות הדפדפן'
          break
        case error.POSITION_UNAVAILABLE:
          message = 'מידע מיקום לא זמין'
          break
        case error.TIMEOUT:
          message = 'תם הזמן לקבלת מיקום. נסה שוב'
          break
      }
      reject(new Error(message))
    },
    {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 0
    }
  )
}

/**
 * Check if geolocation is available
 * @returns {boolean}
 */
export function isGeolocationAvailable() {
  return 'geolocation' in navigator
}

/**
 * Request geolocation permission
 * @returns {Promise<string>} - 'granted' | 'denied' | 'prompt'
 */
export async function requestGeolocationPermission() {
  if (!navigator.permissions) {
    // Fallback for browsers that don't support permissions API
    return 'prompt'
  }

  try {
    const result = await navigator.permissions.query({ name: 'geolocation' })
    return result.state
  } catch (error) {
    return 'prompt'
  }
}
