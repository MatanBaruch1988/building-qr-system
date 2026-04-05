/**
 * Data Cache Service
 * Caches Firebase data (locations, workers) in localStorage
 * so the app can work offline
 */

const LOCATIONS_KEY = 'cached_locations'
const WORKERS_KEY = 'cached_workers'

/**
 * Cache locations data to localStorage
 */
export function cacheLocations(locations) {
  try {
    localStorage.setItem(LOCATIONS_KEY, JSON.stringify({
      data: locations,
      updatedAt: new Date().toISOString()
    }))
  } catch (error) {
    console.error('Error caching locations:', error)
  }
}

/**
 * Get cached locations from localStorage
 * @returns {Array} cached locations or empty array
 */
export function getCachedLocations() {
  try {
    const stored = localStorage.getItem(LOCATIONS_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    return parsed.data || []
  } catch (error) {
    console.error('Error reading cached locations:', error)
    return []
  }
}

/**
 * Cache workers data to localStorage
 */
export function cacheWorkers(workers) {
  try {
    localStorage.setItem(WORKERS_KEY, JSON.stringify({
      data: workers,
      updatedAt: new Date().toISOString()
    }))
  } catch (error) {
    console.error('Error caching workers:', error)
  }
}

/**
 * Get cached workers from localStorage
 * @returns {Array} cached workers or empty array
 */
export function getCachedWorkers() {
  try {
    const stored = localStorage.getItem(WORKERS_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    return parsed.data || []
  } catch (error) {
    console.error('Error reading cached workers:', error)
    return []
  }
}
