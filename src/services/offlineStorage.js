/**
 * Offline Storage Service
 * Saves scans locally when offline and syncs when back online
 */

const STORAGE_KEY = 'pending_scans'

/**
 * Save a scan to local storage (for offline use)
 */
export function savePendingScan(scanData) {
  const pendingScans = getPendingScans()

  const scanWithMeta = {
    ...scanData,
    id: `offline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    savedAt: new Date().toISOString(),
    isSynced: false
  }

  pendingScans.push(scanWithMeta)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingScans))

  return scanWithMeta
}

/**
 * Get all pending (unsynced) scans from local storage
 */
export function getPendingScans() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? JSON.parse(stored) : []
  } catch (error) {
    console.error('Error reading pending scans:', error)
    return []
  }
}

/**
 * Get count of pending scans
 */
export function getPendingScansCount() {
  return getPendingScans().filter(s => !s.isSynced).length
}

/**
 * Mark a scan as synced
 */
export function markScanAsSynced(scanId) {
  const pendingScans = getPendingScans()
  const updated = pendingScans.map(scan =>
    scan.id === scanId ? { ...scan, isSynced: true, syncedAt: new Date().toISOString() } : scan
  )
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
}

/**
 * Remove synced scans older than 24 hours
 */
export function cleanupSyncedScans() {
  const pendingScans = getPendingScans()
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000)

  const filtered = pendingScans.filter(scan => {
    if (!scan.isSynced) return true // Keep unsynced
    const syncedTime = new Date(scan.syncedAt).getTime()
    return syncedTime > oneDayAgo // Keep if synced less than 24h ago
  })

  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

/**
 * Check if we're online
 */
export function isOnline() {
  return navigator.onLine
}

/**
 * Listen for online/offline status changes
 */
export function onConnectionChange(callback) {
  const handleOnline = () => callback(true)
  const handleOffline = () => callback(false)

  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)

  // Return cleanup function that removes the exact same references
  return () => {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  }
}
