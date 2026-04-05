const functions = require('firebase-functions')
const admin = require('firebase-admin')
const { google } = require('googleapis')
const crypto = require('crypto')

admin.initializeApp()

// Rate limiting for PIN attempts
const pinAttempts = new Map() // key: IP, value: { count, resetTime }
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

function checkRateLimit(ip) {
  const now = Date.now()
  const entry = pinAttempts.get(ip)
  if (!entry || now > entry.resetTime) {
    pinAttempts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    return false
  }
  return true
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex')
}

/**
 * Validate worker PIN and return a custom token with worker claims.
 * Expects: { workerId: string, pin: string }
 * Returns: { token: string, workerName: string }
 */
exports.validateWorkerPIN = functions.https.onCall(async (data, context) => {
  // Require anonymous auth first
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required')
  }

  const { workerId, pin } = data
  if (!workerId || !pin) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing workerId or pin')
  }

  // Rate limiting
  const ip = context.rawRequest?.ip || 'unknown'
  if (!checkRateLimit(ip)) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Too many attempts. Try again later.'
    )
  }

  // Fetch worker document
  const workerDoc = await admin.firestore().collection('workers').doc(workerId).get()
  if (!workerDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Invalid credentials')
  }

  const worker = workerDoc.data()

  // Compare hashed PIN
  const hashedInput = hashPin(pin)
  if (hashedInput !== worker.pinHash) {
    throw new functions.https.HttpsError('unauthenticated', 'Invalid credentials')
  }

  // Create custom token with worker claims
  const uid = context.auth.uid
  const customToken = await admin.auth().createCustomToken(uid, {
    workerId: workerId,
    workerName: worker.company || worker.name || ''
  })

  return {
    token: customToken,
    workerName: worker.company || worker.name || '',
    workerId: workerId
  }
})

/**
 * Set admin custom claim on a user. Only callable by an existing admin.
 * Expects: { targetUid: string }
 */
exports.setAdminClaim = functions.https.onCall(async (data, context) => {
  // Must be called by an authenticated admin
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required')
  }

  // Check if caller is admin
  if (context.auth.token.admin !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Only admins can set admin claims')
  }

  const { targetUid } = data
  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing targetUid')
  }

  await admin.auth().setCustomUserClaims(targetUid, { admin: true })
  return { success: true }
})

/**
 * Hash a worker PIN. Only callable by admin.
 * Expects: { workerId: string, pin: string }
 * Returns: { success: true }
 */
exports.hashWorkerPIN = functions.https.onCall(async (data, context) => {
  if (!context.auth || context.auth.token.admin !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required')
  }

  const { workerId, pin } = data
  if (!workerId || !pin) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing workerId or pin')
  }

  const pinHash = hashPin(pin)
  await admin.firestore().collection('workers').doc(workerId).update({
    pinHash,
    code: admin.firestore.FieldValue.delete()
  })

  return { success: true }
})

/**
 * One-time migration: hash all existing plaintext PINs.
 * Only callable by admin.
 */
exports.migratePINsToHash = functions.https.onCall(async (data, context) => {
  if (!context.auth || context.auth.token.admin !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required')
  }

  const workers = await admin.firestore().collection('workers').get()
  let migrated = 0
  const BATCH_LIMIT = 500

  // Collect all docs that need migration
  const toMigrate = workers.docs.filter(doc => {
    const worker = doc.data()
    return worker.code && !worker.pinHash
  })

  // Process in chunks of 500 (Firestore batch limit)
  for (let i = 0; i < toMigrate.length; i += BATCH_LIMIT) {
    const chunk = toMigrate.slice(i, i + BATCH_LIMIT)
    const batch = admin.firestore().batch()

    chunk.forEach(doc => {
      const worker = doc.data()
      const pinHash = hashPin(worker.code)
      batch.update(doc.ref, { pinHash, code: admin.firestore.FieldValue.delete() })
    })

    await batch.commit()
    migrated += chunk.length
  }

  return { success: true, migrated }
})

/**
 * Get public worker list (id, name, company only - no PINs).
 * Requires authentication (anonymous auth is sufficient).
 */
exports.getWorkerList = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Authentication required')
  }

  const workers = await admin.firestore().collection('workers').get()
  return workers.docs.map(doc => ({
    id: doc.id,
    name: doc.data().name || '',
    company: doc.data().company || '',
    isActive: doc.data().isActive !== false
  }))
})

// Google Calendar configuration
// IMPORTANT: You need to set up a Service Account and add its credentials
// Run: firebase functions:config:set google.service_account_email="your-sa@project.iam.gserviceaccount.com"
// Run: firebase functions:config:set google.private_key="-----BEGIN PRIVATE KEY-----..."
// Run: firebase functions:config:set calendar.id="ahavatadam86ky@gmail.com"

const SCOPES = ['https://www.googleapis.com/auth/calendar.events']

/**
 * Create a Google Calendar event when a valid scan is recorded
 */
exports.onScanCreated = functions.firestore
  .document('scans/{scanId}')
  .onCreate(async (snap, context) => {
    const scan = snap.data()

    // Only create events for valid scans
    if (!scan.isValid) {
      console.log('Scan is not valid, skipping calendar event')
      return null
    }

    try {
      const config = functions.config()

      // Check if calendar integration is configured
      if (!config.google?.service_account_email || !config.google?.private_key) {
        console.log('Google Calendar not configured. Skipping event creation.')
        console.log('To configure, run:')
        console.log('firebase functions:config:set google.service_account_email="your-sa@project.iam.gserviceaccount.com"')
        console.log('firebase functions:config:set google.private_key="your-private-key"')
        return null
      }

      // Create JWT client for authentication
      const jwtClient = new google.auth.JWT(
        config.google.service_account_email,
        null,
        config.google.private_key.replace(/\\n/g, '\n'),
        SCOPES
      )

      await jwtClient.authorize()

      const calendar = google.calendar({ version: 'v3', auth: jwtClient })

      // Get the calendar ID from config
      const calendarId = config.calendar?.id || 'ahavatadam86ky@gmail.com'

      // Check if calendar event already exists (prevent duplicates)
      if (scan.calendarEventId) {
        console.log('Calendar event already exists for this scan, skipping')
        return null
      }

      // Create event start and end time (prefer createdAt, fallback to timestamp)
      const eventTime = scan.createdAt?.toDate() || scan.timestamp?.toDate() || new Date()
      const eventEnd = new Date(eventTime.getTime() + 15 * 60 * 1000) // 15 minutes duration

      // Create the calendar event
      const event = {
        summary: `✓ אימות נוכחות - ${scan.locationName}`,
        description: formatEventDescription(scan),
        start: {
          dateTime: eventTime.toISOString(),
          timeZone: 'Asia/Jerusalem'
        },
        end: {
          dateTime: eventEnd.toISOString(),
          timeZone: 'Asia/Jerusalem'
        },
        colorId: '10', // Green color
        reminders: {
          useDefault: false,
          overrides: []
        }
      }

      const response = await calendar.events.insert({
        calendarId: calendarId,
        resource: event
      })

      console.log('Calendar event created:', response.data.id)

      // Update the scan document with the calendar event ID
      await snap.ref.update({
        calendarEventId: response.data.id,
        calendarEventUrl: response.data.htmlLink
      })

      return response.data

    } catch (error) {
      console.error('Error creating calendar event:', error)

      // Update scan with error info
      await snap.ref.update({
        calendarError: error.message
      })

      return null
    }
  })

/**
 * Format event description with scan details
 */
function formatEventDescription(scan) {
  const timestamp = scan.createdAt?.toDate() || scan.timestamp?.toDate() || new Date()
  const timeStr = timestamp.toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem'
  })
  const dateStr = timestamp.toLocaleDateString('he-IL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Jerusalem'
  })

  return `
נקודה: ${scan.locationName || 'Unknown'}
עובד: ${scan.workerName || 'Unknown'}
תאריך: ${dateStr}
שעה: ${timeStr}
מרחק: ${scan.distanceMeters?.toFixed(1) || 0} מטר
דיוק GPS: ${scan.gpsAccuracy?.toFixed(1) || 'לא ידוע'} מטר

---
נוצר אוטומטית על ידי מערכת אימות נוכחות QR
  `.trim()
}

/**
 * HTTP function to manually sync a scan to calendar (for testing)
 */
exports.syncScanToCalendar = functions.https.onCall(async (data, context) => {
  if (!context.auth || context.auth.token.admin !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required')
  }

  const { scanId } = data
  if (!scanId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing scanId')
  }

  const scanDoc = await admin.firestore().collection('scans').doc(scanId).get()
  if (!scanDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Scan not found')
  }

  const scan = scanDoc.data()
  if (!scan.isValid) {
    return { success: false, message: 'Scan is not valid, skipping calendar event' }
  }

  // Check if calendar event already exists (prevent duplicates)
  if (scan.calendarEventId) {
    return { success: false, message: 'Calendar event already exists for this scan' }
  }

  try {
    const config = functions.config()
    if (!config.google?.service_account_email || !config.google?.private_key) {
      return { success: false, message: 'Google Calendar not configured' }
    }

    const jwtClient = new google.auth.JWT(
      config.google.service_account_email,
      null,
      config.google.private_key.replace(/\\n/g, '\n'),
      SCOPES
    )
    await jwtClient.authorize()

    const calendar = google.calendar({ version: 'v3', auth: jwtClient })
    const calendarId = config.calendar?.id || 'ahavatadam86ky@gmail.com'
    const eventTime = scan.createdAt?.toDate() || new Date()
    const eventEnd = new Date(eventTime.getTime() + 15 * 60 * 1000)

    const event = {
      summary: `\u2713 \u05d0\u05d9\u05de\u05d5\u05ea \u05e0\u05d5\u05db\u05d7\u05d5\u05ea - ${scan.locationName}`,
      description: formatEventDescription(scan),
      start: { dateTime: eventTime.toISOString(), timeZone: 'Asia/Jerusalem' },
      end: { dateTime: eventEnd.toISOString(), timeZone: 'Asia/Jerusalem' },
      colorId: '10',
      reminders: { useDefault: false, overrides: [] }
    }

    const response = await calendar.events.insert({
      calendarId: calendarId,
      resource: event
    })

    await scanDoc.ref.update({
      calendarEventId: response.data.id,
      calendarEventUrl: response.data.htmlLink
    })

    return { success: true, eventId: response.data.id }
  } catch (error) {
    console.error('Error syncing to calendar:', error)
    await scanDoc.ref.update({ calendarError: error.message })
    return { success: false, message: error.message }
  }
})

/**
 * Cleanup old scans (optional - runs daily)
 */
exports.cleanupOldScans = functions.pubsub.schedule('0 3 * * *')
  .timeZone('Asia/Jerusalem')
  .onRun(async (context) => {
    const cutoffDate = new Date()
    cutoffDate.setMonth(cutoffDate.getMonth() - 6) // Keep 6 months of data

    // Query docs with createdAt field
    const oldScansCreatedAt = await admin.firestore()
      .collection('scans')
      .where('createdAt', '<', cutoffDate)
      .limit(250)
      .get()

    // Query pre-migration docs that only have timestamp (no createdAt)
    const oldScansTimestamp = await admin.firestore()
      .collection('scans')
      .where('timestamp', '<', cutoffDate)
      .limit(250)
      .get()

    // Deduplicate by doc ID
    const docsToDelete = new Map()
    oldScansCreatedAt.docs.forEach(doc => docsToDelete.set(doc.id, doc.ref))
    oldScansTimestamp.docs.forEach(doc => docsToDelete.set(doc.id, doc.ref))

    if (docsToDelete.size === 0) {
      console.log('No old scans to clean up')
      return null
    }

    const batch = admin.firestore().batch()
    docsToDelete.forEach(ref => {
      batch.delete(ref)
    })

    await batch.commit()
    console.log(`Deleted ${docsToDelete.size} old scans`)

    return null
  })

/**
 * Get daily statistics
 */
exports.getDailyStats = functions.https.onCall(async (data, context) => {
  if (!context.auth || context.auth.token.admin !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required')
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Query docs with createdAt field
  const scansCreatedAt = await admin.firestore()
    .collection('scans')
    .where('createdAt', '>=', today)
    .get()

  // Query pre-migration docs that only have timestamp (no createdAt)
  const scansTimestamp = await admin.firestore()
    .collection('scans')
    .where('timestamp', '>=', today)
    .get()

  // Deduplicate by doc ID
  const uniqueDocs = new Map()
  scansCreatedAt.docs.forEach(doc => uniqueDocs.set(doc.id, doc))
  scansTimestamp.docs.forEach(doc => uniqueDocs.set(doc.id, doc))

  const allDocs = Array.from(uniqueDocs.values())

  const stats = {
    total: allDocs.length,
    valid: 0,
    invalid: 0,
    byLocation: {},
    byWorker: {}
  }

  allDocs.forEach(doc => {
    const scan = doc.data()

    if (scan.isValid) {
      stats.valid++
    } else {
      stats.invalid++
    }

    // Count by location
    if (scan.locationName) {
      stats.byLocation[scan.locationName] = (stats.byLocation[scan.locationName] || 0) + 1
    }

    // Count by worker
    if (scan.workerName) {
      stats.byWorker[scan.workerName] = (stats.byWorker[scan.workerName] || 0) + 1
    }
  })

  return stats
})
