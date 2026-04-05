/**
 * Sync Service
 * Handles syncing offline scans to Firebase when back online
 */

import { db } from './firebase'
import { collection, addDoc, serverTimestamp } from 'firebase/firestore'
import {
  getPendingScans,
  markScanAsSynced,
  cleanupSyncedScans,
  isOnline,
  onConnectionChange
} from './offlineStorage'

let isSyncing = false
let syncCallbacks = []

/**
 * Register a callback to be notified of sync status changes
 */
export function onSyncStatusChange(callback) {
  syncCallbacks.push(callback)
  return () => {
    syncCallbacks = syncCallbacks.filter(cb => cb !== callback)
  }
}

/**
 * Notify all callbacks of sync status
 */
function notifySyncStatus(status) {
  syncCallbacks.forEach(cb => cb(status))
}

/**
 * Sync all pending scans to Firebase
 */
export async function syncPendingScans() {
  if (!isOnline() || isSyncing) {
    return { synced: 0, failed: 0 }
  }

  isSyncing = true
  notifySyncStatus({ syncing: true })

  const pendingScans = getPendingScans().filter(s => !s.isSynced)
  let synced = 0
  let failed = 0

  for (const scan of pendingScans) {
    try {
      // Prepare scan data for Firebase
      const firebaseScanData = {
        locationId: scan.locationId,
        locationName: scan.locationName,
        workerId: scan.workerId,
        workerName: scan.workerName,
        // Use the original timestamp from when scan was made
        timestamp: serverTimestamp(),
        originalTimestamp: scan.timestamp,
        deviceLatitude: scan.deviceLatitude,
        deviceLongitude: scan.deviceLongitude,
        distanceMeters: scan.distanceMeters,
        isValid: scan.isValid,
        gpsAccuracy: scan.gpsAccuracy,
        // Mark as synced from offline
        syncedFromOffline: true,
        offlineScanId: scan.id,
        offlineSavedAt: scan.savedAt
      }

      await addDoc(collection(db, 'scans'), firebaseScanData)
      markScanAsSynced(scan.id)
      synced++
    } catch (error) {
      console.error('Error syncing scan:', scan.id, error)
      failed++
    }
  }

  // Cleanup old synced scans
  cleanupSyncedScans()

  isSyncing = false
  notifySyncStatus({ syncing: false, synced, failed })

  return { synced, failed }
}

let syncIntervalId = null
let connectionCleanup = null

/**
 * Initialize auto-sync when coming back online
 * Returns a cleanup function to stop auto-sync
 */
export function initAutoSync() {
  // Clear any previous auto-sync
  stopAutoSync()

  // Sync immediately if online
  if (isOnline()) {
    syncPendingScans()
  }

  // Listen for connection changes
  connectionCleanup = onConnectionChange((online) => {
    if (online) {
      console.log('Back online - syncing pending scans...')
      syncPendingScans()
    }
  })

  // Also try to sync periodically (every 30 seconds) when online
  syncIntervalId = setInterval(() => {
    if (isOnline()) {
      syncPendingScans()
    }
  }, 30000)

  return stopAutoSync
}

/**
 * Stop auto-sync and clean up resources
 */
export function stopAutoSync() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
  if (connectionCleanup) {
    connectionCleanup()
    connectionCleanup = null
  }
}
