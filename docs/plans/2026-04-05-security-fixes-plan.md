# Security & Bug Fixes Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task.
> **Design:** See `docs/plans/2026-04-05-security-fixes-design.md` for full specification.
> **Revision:** v2 -- addresses 3 blocking review findings + 1 non-blocking bug fix.

**Goal:** Fix all 26 code review issues (5 critical, 8 major, 13 minor) while preserving offline-first PWA behavior and simple worker UX. Five minor items are explicitly deferred (see Deferred Items section).

**Architecture:** Firebase Anonymous Auth + Server PIN validation via Cloud Function. Firestore rules enforce auth. Admin via custom claims.

**Tech Stack:** React 18, Vite, Firebase (Firestore, Auth, Cloud Functions), PWA

**Prerequisites:** Firebase project with Anonymous Auth enabled, existing codebase at current state

**Durable Decisions:**
- Worker auth: Anonymous Auth -> Cloud Function PIN validation -> Custom Token with claims
- Admin auth: Google Sign-in -> custom claim `admin: true` -> Firestore rules
- PIN storage: SHA-256 hash in Firestore, never plaintext
- Firestore rules: all collections require auth, scans validated by workerId claim
- `getWorkerList` Cloud Function deployed with Phase 1 (not Phase 3) to avoid breaking workers after rules deploy

---

## Phase 1: Auth & Security

**Objective:** Lock down Firestore, implement server-side worker auth, admin custom claims, PIN hashing, AND provide a public worker list Cloud Function so workers can still see the worker selection screen after Firestore rules make the workers collection admin-only. This phase eliminates all 5 critical issues and several major ones.

**Issues addressed:** #1 (Firestore rules allow unauthenticated access), #2 (Worker PINs stored/compared in plaintext), #3 (Admin auth hardcoded to email), #4 (Worker auth is client-side only), #5 (Workers table exposes PINs to all readers)

**IMPORTANT ordering note:** Task 1.8 (getWorkerList + usePublicWorkerList) MUST be deployed together with Task 1.1 (Firestore rules). If rules deploy without the public worker list, the worker app will break because `useWorkers` does direct Firestore reads on the now-admin-only workers collection.

### Task 1.1: Rewrite Firestore Security Rules

**File:** `firestore.rules`

**Current state (lines 1-36):** All collections allow `read: if true` and most allow `write: if true` or `write: if request.auth != null`. No auth required for reads, no admin-only restrictions.

**Steps:**

1. Replace the entire contents of `firestore.rules` with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Locations - readable by any authenticated user, writable only by admin
    match /locations/{locationId} {
      allow read: if request.auth != null;
      allow write: if request.auth.token.admin == true;
    }

    // Workers - only admin can read (prevents PIN exposure) and write
    match /workers/{workerId} {
      allow read: if request.auth.token.admin == true;
      allow write: if request.auth.token.admin == true;
    }

    // Scans - authenticated users can read; create only if workerId claim matches
    match /scans/{scanId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
                    && request.resource.data.workerId == request.auth.token.workerId;
      allow update, delete: if request.auth.token.admin == true;
    }

    // Failed scans - admin reads, any authenticated user can create
    match /failedScans/{scanId} {
      allow read: if request.auth.token.admin == true;
      allow create: if request.auth != null;
    }

    // Default deny
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

**Exit criteria:** `firebase deploy --only firestore:rules` succeeds. Unauthenticated reads to any collection return permission denied.

### Task 1.2: Add Cloud Functions for Auth

**File:** `functions/index.js`

**Current state:** Contains `onScanCreated`, `syncScanToCalendar`, `cleanupOldScans`, `getDailyStats`. No auth functions exist.

**Steps:**

1. Add `crypto` require at the top of `functions/index.js` (line 1 area):
```js
const crypto = require('crypto')
```

2. Add a rate-limiting in-memory store (after `admin.initializeApp()`, around line 6):
```js
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
```

3. Add `validateWorkerPIN` callable Cloud Function (before the `onScanCreated` export):
```js
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
```

4. Add `setAdminClaim` callable Cloud Function:
```js
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
```

5. Add `hashWorkerPIN` callable Cloud Function (used by admin when creating/editing workers):
```js
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
  await admin.firestore().collection('workers').doc(workerId).update({ pinHash })

  return { success: true }
})
```

6. Add one-time PIN migration function:
```js
/**
 * One-time migration: hash all existing plaintext PINs.
 * Only callable by admin.
 */
exports.migratePINsToHash = functions.https.onCall(async (data, context) => {
  if (!context.auth || context.auth.token.admin !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required')
  }

  const workers = await admin.firestore().collection('workers').get()
  const batch = admin.firestore().batch()
  let migrated = 0

  workers.docs.forEach(doc => {
    const worker = doc.data()
    // Only migrate if worker has a plaintext code and no pinHash
    if (worker.code && !worker.pinHash) {
      const pinHash = hashPin(worker.code)
      batch.update(doc.ref, { pinHash, code: admin.firestore.FieldValue.delete() })
      migrated++
    }
  })

  if (migrated > 0) {
    await batch.commit()
  }

  return { success: true, migrated }
})
```

**Exit criteria:** `firebase deploy --only functions` succeeds. All new functions listed in Firebase Console.

### Task 1.3: Implement Worker Auth Hook with Firebase Auth

**File:** `src/hooks/useWorkerAuth.js`

**Current state (lines 1-32):** Pure localStorage, no Firebase Auth. Worker is stored as JSON in localStorage, login just sets state, no server validation.

**Steps:**

1. Replace the entire file with:
```js
import { useState, useEffect, useCallback } from 'react'
import { auth, functions } from '../services/firebase'
import {
  signInAnonymously,
  signInWithCustomToken,
  onAuthStateChanged,
  signOut
} from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'

export function useWorkerAuth() {
  const [worker, setWorker] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Restore worker info from localStorage on mount
  // and listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user && user.isAnonymous === false) {
        // User has a custom token session - restore worker info from localStorage
        const saved = localStorage.getItem('currentWorker')
        if (saved) {
          try {
            const parsed = JSON.parse(saved)
            if (parsed && parsed.id && parsed.name) {
              setWorker(parsed)
            }
          } catch {
            localStorage.removeItem('currentWorker')
          }
        }
      } else if (!user) {
        setWorker(null)
      }
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  const login = useCallback(async (workerId, pin) => {
    setError(null)
    setLoading(true)

    try {
      // Step 1: Sign in anonymously to get a Firebase Auth session
      await signInAnonymously(auth)

      // Step 2: Call Cloud Function to validate PIN and get custom token
      const validatePIN = httpsCallable(functions, 'validateWorkerPIN')
      const result = await validatePIN({ workerId, pin })

      // Step 3: Sign in with the custom token (replaces anonymous session)
      await signInWithCustomToken(auth, result.data.token)

      // Step 4: Save worker info locally
      const workerInfo = {
        id: result.data.workerId,
        name: result.data.workerName,
        company: result.data.workerName
      }
      setWorker(workerInfo)
      localStorage.setItem('currentWorker', JSON.stringify(workerInfo))

      setLoading(false)
      return workerInfo
    } catch (err) {
      setLoading(false)
      // Map Firebase error codes to Hebrew messages
      if (err.code === 'functions/unauthenticated') {
        setError('קוד שגוי')
      } else if (err.code === 'functions/resource-exhausted') {
        setError('יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.')
      } else if (err.code === 'functions/not-found') {
        setError('קוד שגוי')
      } else {
        setError('שגיאה בהתחברות. נסה שוב.')
      }
      throw err
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await signOut(auth)
    } catch (err) {
      console.error('Logout error:', err)
    }
    setWorker(null)
    localStorage.removeItem('currentWorker')
  }, [])

  return { worker, loading, error, login, logout, isLoggedIn: !!worker }
}
```

**Exit criteria:** Worker login calls Cloud Function, receives custom token, signs in with it. Worker info persisted in localStorage for offline recovery.

### Task 1.4: Update Admin Auth to Use Custom Claims

**File:** `src/hooks/useAdminAuth.js`

**Current state (lines 1-77):** Hardcodes `ADMIN_EMAIL = 'matan1988b@gmail.com'` and checks `firebaseUser.email === ADMIN_EMAIL` on line 18. Signs out non-matching emails.

**Steps:**

1. Remove the `ADMIN_EMAIL` constant (line 6).

2. Replace the `onAuthStateChanged` callback (lines 15-30) to check custom claims instead of email:
```js
const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
  if (firebaseUser) {
    // Force token refresh to get latest claims
    const tokenResult = await firebaseUser.getIdTokenResult(true)
    if (tokenResult.claims.admin === true) {
      setUser(firebaseUser)
      setError(null)
    } else {
      // Not an admin - sign out
      signOut(auth)
      setUser(null)
      setError('המשתמש אינו מורשה לגשת לממשק הניהול')
    }
  } else {
    setUser(null)
  }
  setLoading(false)
})
```

3. Remove the email check from the `login` function (lines 43-45). The claim check in `onAuthStateChanged` handles authorization.

4. Update the `isAuthenticated` return value (line 75):
```js
isAuthenticated: !!user
```

**Exit criteria:** Admin login checks `admin: true` custom claim instead of hardcoded email. Non-admin Google users are rejected.

### Task 1.5: Update WorkerLogin to Use Server-Side Validation

**File:** `src/components/WorkerLogin.jsx`

**Current state (lines 17-31):** `handleCodeSubmit` does client-side PIN comparison: `if (code !== selectedWorker.code)` (line 26). Workers list includes PINs sent to client.

**Steps:**

1. Change the component signature to accept `onLogin` that takes `(workerId, pin)` instead of a worker object. The component no longer receives plaintext PINs from the workers list.

2. Replace `handleCodeSubmit` (lines 17-31):
```js
const [submitting, setSubmitting] = useState(false)

const handleCodeSubmit = async (e) => {
  e.preventDefault()
  setError('')

  if (!selectedWorker) {
    setError('אנא בחר נותן שירות')
    return
  }

  setSubmitting(true)
  try {
    await onLogin(selectedWorker.id, code)
  } catch (err) {
    // Error message is set by the hook; show a generic fallback
    setError(err.code === 'functions/resource-exhausted'
      ? 'יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.'
      : 'קוד שגוי')
  } finally {
    setSubmitting(false)
  }
}
```

3. Add `inputMode="numeric"` to the PIN input (line 93):
```jsx
<input
  type="password"
  inputMode="numeric"
  value={code}
  onChange={(e) => setCode(e.target.value)}
  placeholder="הזן קוד"
  autoFocus
  style={{ textAlign: 'center', fontSize: '1.5rem', letterSpacing: '0.5rem' }}
/>
```

4. Disable the submit button while submitting:
```jsx
<button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={submitting}>
  {submitting ? <span className="spinner"></span> : 'כניסה'}
</button>
```

**Exit criteria:** PIN is never compared client-side. Form sends workerId + pin to the auth hook which calls the Cloud Function.

### Task 1.6: Update WorkerManagement to Hide PINs and Hash on Save

**File:** `src/components/WorkerManagement.jsx`

**Current state (lines 30-35):** Displays worker PINs in plaintext in the table: `<td>{worker.code}</td>`.

**Steps:**

1. Replace the PIN column display (line 34) to show masked value:
```jsx
<td>****</td>
```

2. In `src/components/AdminPanel.jsx`, update `handleSaveWorker` (lines 166-193) to call the `hashWorkerPIN` Cloud Function after creating/updating a worker:

After the `addDoc` call (line 176), add:
```js
// Hash the PIN server-side
const hashPIN = httpsCallable(functions, 'hashWorkerPIN')
await hashPIN({ workerId: docRef.id, pin: workerForm.code })
```

After the `updateDoc` call (line 173), add (only if code was changed):
```js
if (workerForm.code) {
  const hashPIN = httpsCallable(functions, 'hashWorkerPIN')
  await hashPIN({ workerId: editingWorker.id, pin: workerForm.code })
}
```

3. Add the import for `httpsCallable` and `functions` at the top of `AdminPanel.jsx`:
```js
import { functions } from '../services/firebase'
import { httpsCallable } from 'firebase/functions'
```

**Exit criteria:** Worker PINs never displayed in the admin table. PINs are hashed server-side on create/update.

### Task 1.7: Update WorkerApp to Use New Auth Flow

**File:** `src/pages/WorkerApp.jsx`

**Current state (line 91):** `handleWorkerLogin` calls `login(selectedWorker)` passing the full worker object.

**Steps:**

1. Update `handleWorkerLogin` (lines 90-99) to use the new async login:
```js
const handleWorkerLogin = async (workerId, pin) => {
  try {
    const workerInfo = await login(workerId, pin)
    // If there's a QR code in the URL, process it
    if (qrCodeFromUrl && locations.length > 0) {
      processCode(qrCodeFromUrl)
    } else {
      setView('scanner')
    }
  } catch (err) {
    // Error is handled by the hook and WorkerLogin component
  }
}
```

2. Update the `WorkerLogin` component usage (lines 156-159) to pass `onLogin` which now expects `(workerId, pin)`:
```jsx
<WorkerLogin
  workers={workers}
  onLogin={handleWorkerLogin}
/>
```

3. Update `WorkerApp.jsx` to import and use `usePublicWorkerList` (from Task 1.8) instead of `useWorkers`:
```js
import { usePublicWorkerList } from '../hooks/useFirebaseData'
// ...
const { workers, loading: workersLoading } = usePublicWorkerList()
```

**Exit criteria:** Worker login flow goes through Firebase Anonymous Auth -> Cloud Function -> Custom Token. No PINs exposed to client. Worker list fetched via Cloud Function, not direct Firestore read.

### Task 1.8: Add getWorkerList Cloud Function and usePublicWorkerList Hook

> **Why in Phase 1:** After Task 1.1 deploys Firestore rules making the workers collection admin-only, the worker app's `useWorkers` hook (which does a direct Firestore `onSnapshot` on the workers collection) will fail with permission denied. Workers would not be able to see the worker selection list to log in. This task MUST deploy alongside the Firestore rules to prevent the worker app from breaking.

**Files:** `functions/index.js`, `src/hooks/useFirebaseData.js`

**Steps:**

1. Add `getWorkerList` callable Cloud Function to `functions/index.js`:
```js
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
```

2. Add `usePublicWorkerList` hook to `src/hooks/useFirebaseData.js`:
```js
import { functions } from '../services/firebase'
import { httpsCallable } from 'firebase/functions'

export function usePublicWorkerList() {
  const [workers, setWorkers] = useState(() => getCachedWorkers())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchWorkers() {
      try {
        // Ensure anonymous auth session exists before calling authenticated Cloud Function.
        // This is needed because workers must see the list BEFORE entering their PIN.
        // signInAnonymously is a no-op if already signed in.
        const { getAuth, signInAnonymously } = await import('firebase/auth')
        await signInAnonymously(getAuth())

        const getList = httpsCallable(functions, 'getWorkerList')
        const result = await getList()
        setWorkers(result.data)
        cacheWorkers(result.data)
      } catch (error) {
        console.error('Error fetching worker list:', error)
        // Keep using cached data
      } finally {
        setLoading(false)
      }
    }

    if (isOnline()) {
      fetchWorkers()
    } else {
      setLoading(false)
    }

    const handleOnline = () => fetchWorkers()
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  return { workers, loading }
}
```

3. The existing `useWorkers` hook (direct Firestore `onSnapshot`) remains for admin usage in `AdminPanel.jsx`. Only the worker app switches to `usePublicWorkerList`.

**Exit criteria:** `getWorkerList` Cloud Function returns worker id/name/company (no PINs). `usePublicWorkerList` hook works with anonymous auth. Worker app continues to show the worker selection list after Firestore rules deploy.

### Phase 1 Exit Criteria
- [ ] `firebase deploy --only firestore:rules` succeeds
- [ ] `firebase deploy --only functions` succeeds (includes `getWorkerList`)
- [ ] Unauthenticated Firestore reads return permission denied
- [ ] Worker PIN validated server-side, never compared on client
- [ ] Admin identified by `admin: true` custom claim, not hardcoded email
- [ ] Worker PINs stored as SHA-256 hashes in Firestore
- [ ] PIN migration function available for existing data
- [ ] Worker app can still display worker list via `getWorkerList` Cloud Function after rules deploy

---

## Phase 2: Backend Fixes

**Objective:** Fix Cloud Functions bugs: timestamp query field mismatch, missing auth checks on callables, and the empty `syncScanToCalendar` stub.

**Issues addressed:** #6 (cleanupOldScans queries `timestamp` field but scans use `createdAt`), #7 (getDailyStats has no auth check), #8 (syncScanToCalendar is an empty stub), #9 (getDailyStats queries `timestamp` field)

### Task 2.1: Fix Timestamp Field Queries in Cloud Functions

**File:** `functions/index.js`

**Current state:**
- `cleanupOldScans` (line 168): queries `.where('timestamp', '<', cutoffDate)` but scans are saved with `createdAt` field (see `scanProcessor.js` line 123).
- `getDailyStats` (line 197): queries `.where('timestamp', '>=', today)` -- same issue.

**Steps:**

1. In `cleanupOldScans` (line 168), change `'timestamp'` to `'createdAt'`:
```js
.where('createdAt', '<', cutoffDate)
```

2. In `getDailyStats` (line 197), change `'timestamp'` to `'createdAt'`:
```js
.where('createdAt', '>=', today)
```

**Exit criteria:** Both queries target the `createdAt` field which is the Firestore server timestamp set on scan creation.

### Task 2.2: Add Auth Checks to getDailyStats and syncScanToCalendar

**File:** `functions/index.js`

**Current state:**
- `getDailyStats` (line 191): No `context.auth` check. Any caller can retrieve stats.
- `syncScanToCalendar` (line 139): No `context.auth` check.

**Steps:**

1. Add auth check at the beginning of `getDailyStats` (after line 191):
```js
if (!context.auth || context.auth.token.admin !== true) {
  throw new functions.https.HttpsError('permission-denied', 'Admin access required')
}
```

2. Add auth check at the beginning of `syncScanToCalendar` (after line 139):
```js
if (!context.auth || context.auth.token.admin !== true) {
  throw new functions.https.HttpsError('permission-denied', 'Admin access required')
}
```

**Exit criteria:** Both callable functions reject unauthenticated and non-admin callers.

### Task 2.3: Implement syncScanToCalendar Stub

**File:** `functions/index.js`

**Current state (lines 139-155):** The function fetches the scan doc but then returns `{ success: true, message: 'Sync triggered' }` without actually syncing.

**BUG FIX (from review):** The original plan used `scan.timestamp?.toDate()` to get the event time, but `timestamp` is an ISO string field, not a Firestore Timestamp. The correct field is `scan.createdAt` which is a Firestore server timestamp. This has been corrected below.

**Steps:**

1. Replace the function body (lines 139-155) to actually re-trigger the calendar sync logic:
```js
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
```

**Exit criteria:** `syncScanToCalendar` actually creates a Google Calendar event for the specified scan when calendar is configured. Uses `scan.createdAt?.toDate()` (not `scan.timestamp?.toDate()`).

### Phase 2 Exit Criteria
- [ ] `cleanupOldScans` queries the correct `createdAt` field
- [ ] `getDailyStats` queries the correct `createdAt` field
- [ ] `getDailyStats` requires admin auth
- [ ] `syncScanToCalendar` requires admin auth and actually syncs
- [ ] `syncScanToCalendar` uses `createdAt` field (not `timestamp`)
- [ ] `firebase deploy --only functions` succeeds

---

## Phase 3: Frontend Fixes

**Objective:** Fix memory leaks, interval cleanup, offline fallback, XSS, Firebase reconnection, polling issues, and add server-side scan filtering for workers.

**Issues addressed:** #10 (event listener leak in offlineStorage), #11 (setInterval never cleared in syncService), #12 (scanProcessor has no offline fallback on Firebase error), #13 (XSS in qrGenerator printQRCode), #14 (useFirebaseData skips listeners when offline and never re-establishes), #15 (ScansHistory does client-side workerId filtering), #16 (WorkerApp 50ms polling interval is excessive)

### Task 3.1: Fix Event Listener Leak in offlineStorage

**File:** `src/services/offlineStorage.js`

**Current state (lines 84-93):** `onConnectionChange` creates new anonymous arrow functions for `addEventListener` and then tries to `removeEventListener` with different anonymous functions (which never match).

**Steps:**

1. Replace the `onConnectionChange` function (lines 84-93):
```js
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
```

**Exit criteria:** The cleanup function returned by `onConnectionChange` actually removes the event listeners (same function references used for add and remove).

### Task 3.2: Fix setInterval Leak in syncService

**File:** `src/services/syncService.js`

**Current state (lines 94-114):** `initAutoSync` calls `setInterval` (line 109) but never stores the interval ID. The `onConnectionChange` cleanup is also never called. No way to stop auto-sync.

**Steps:**

1. Replace `initAutoSync` (lines 94-114):
```js
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
```

**Exit criteria:** `initAutoSync` returns a cleanup function. `stopAutoSync` clears both the interval and the connection listener.

### Task 3.3: Add Offline Fallback on Firebase Save Error

**File:** `src/services/scanProcessor.js`

**Current state (lines 119-135):** `saveScan` checks `onlineStatus` but if the Firebase write fails (e.g., auth error, network flicker), it throws instead of falling back to offline storage.

**Steps:**

1. Update the `saveScan` function (lines 119-135) to catch Firebase errors and fall back:
```js
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
```

**Exit criteria:** A scan that fails to save to Firebase is automatically saved to offline storage instead of showing an error to the user.

### Task 3.4: Fix XSS in printQRCode

**File:** `src/utils/qrGenerator.js`

**Current state (lines 144-203):** `printQRCode` uses `document.write` with the `title` parameter interpolated directly into HTML (line 186: `<h1>${title}</h1>` and line 154: `<title>... - ${title}</title>`). A malicious title could inject scripts.

**Steps:**

1. Add an HTML escape helper at the top of the file (after the imports):
```js
function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}
```

2. In `printQRCode` (line 154), escape the title in the `<title>` tag:
```js
<title>הדפסת QR - ${escapeHtml(title)}</title>
```

3. In `printQRCode` (line 186), escape the title in the `<h1>` tag:
```js
<h1>${escapeHtml(title)}</h1>
```

**Exit criteria:** HTML special characters in the title are escaped. No script injection possible through location names.

### Task 3.5: Fix useFirebaseData Offline/Reconnection Handling

**File:** `src/hooks/useFirebaseData.js`

**Current state (lines 7-28, 31-52):** Both `useLocations` and `useWorkers` check `if (!isOnline()) return` at the start of useEffect (lines 11, 35). If the app starts offline, listeners are never established even when coming back online.

**Note:** The `usePublicWorkerList` hook was already added in Task 1.8. This task focuses on fixing `useLocations` and the admin-only `useWorkers` hook.

**Steps:**

1. Rewrite `useLocations` to handle reconnection:
```js
export function useLocations() {
  const [locations, setLocations] = useState(() => getCachedLocations())

  useEffect(() => {
    let unsub = null

    function startListener() {
      // Don't start if already listening
      if (unsub) return

      unsub = onSnapshot(
        collection(db, 'locations'),
        (snapshot) => {
          const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
          setLocations(data)
          cacheLocations(data)
        },
        (error) => {
          console.error('Locations listener error:', error)
          // Firestore SDK handles reconnection automatically,
          // but if fatal, clean up
          unsub = null
        }
      )
    }

    // Always try to start - Firestore SDK queues if offline
    startListener()

    // Listen for reconnection to restart if listener died
    const handleOnline = () => {
      if (!unsub) startListener()
    }
    window.addEventListener('online', handleOnline)

    return () => {
      if (unsub) unsub()
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  return locations
}
```

2. Apply the same reconnection pattern to the admin-only `useWorkers` hook (used by AdminPanel). Keep using `onSnapshot` on the workers collection -- this still works for admins whose tokens have `admin: true`.

**Exit criteria:** Firestore listeners start regardless of initial online state. Listeners restart on reconnection. Worker app uses the public worker list (from Task 1.8, no PIN exposure).

### Task 3.6: Fix WorkerApp 50ms Polling Interval

**File:** `src/pages/WorkerApp.jsx`

**Current state (line 47):** `setInterval(checkPendingResult, 50)` polls every 50ms. This is extremely aggressive and wastes CPU cycles.

**Steps:**

1. Change the interval from 50ms to 500ms (line 47):
```js
const interval = setInterval(checkPendingResult, 500)
```

**Exit criteria:** Polling interval is 500ms instead of 50ms. The 450ms additional latency is imperceptible to users.

### Task 3.7: Add Server-Side Scan Filtering in ScansHistory

> **Why this task:** ScansHistory.jsx currently fetches ALL scans via a Firestore `onSnapshot` on the scans collection, then filters client-side by `workerId`. With the new auth rules (scans are readable by any authenticated user), every worker can see every other worker's scans in memory. A server-side `where` clause is needed so workers only receive their own scans.

**File:** `src/components/ScansHistory.jsx`

**Current state:** The component uses `useScans()` (or a direct `onSnapshot` on the `scans` collection) and filters by `workerId` in JavaScript after fetching all documents.

**Steps:**

1. Modify the Firestore query in `ScansHistory.jsx` to add a `where('workerId', '==', workerId)` clause when the current user is a worker (not admin):

```js
// Determine query based on user role
const scansQuery = isAdmin
  ? query(collection(db, 'scans'), orderBy('createdAt', 'desc'))
  : query(
      collection(db, 'scans'),
      where('workerId', '==', currentWorkerId),
      orderBy('createdAt', 'desc')
    )
```

2. The `currentWorkerId` should come from the worker auth context (the `worker.id` from `useWorkerAuth`). Pass it as a prop or use context.

3. The `isAdmin` flag should come from the admin auth context. Admins continue to see all scans.

4. Remove the client-side `workerId` filter that was applied after fetching, since the query now handles it.

**Exit criteria:** Workers only receive their own scans from Firestore (server-side filtering). Admins continue to see all scans. No unnecessary data transferred to worker clients.

### Phase 3 Exit Criteria
- [ ] Event listeners properly cleaned up in offlineStorage
- [ ] setInterval properly cleaned up in syncService
- [ ] Firebase save failures fall back to offline storage
- [ ] HTML injection prevented in printQRCode
- [ ] Firestore listeners established regardless of initial online state
- [ ] Worker app does not read workers collection directly
- [ ] Polling interval is 500ms, not 50ms
- [ ] ScansHistory uses server-side workerId filtering for workers

---

## Phase 4: UX/A11y Polish

**Objective:** Add ARIA labels, focus trapping, error roles, numeric input mode, auto-dismiss messages, and fix radius fallback.

**Issues addressed:** #17 (IconButton missing aria-label), #18 (Modal has no focus trapping or Escape-to-close), #19 (WorkerLogin error has no role="alert"), #20 (AdminPanel messages never auto-dismiss), #21 (LocationForm radius fallback allows 0), #22 (WorkerLogin PIN input missing inputMode="numeric"), #23 (Modal close button missing aria-label), #24 (filter buttons missing aria-current), #26 (ScansHistory stats section not a live region)

**Note:** Issue #25 (window.confirm for delete) is deferred -- see Deferred Items section below.

### Task 4.1: Add aria-label to IconButtons

**File:** `src/components/ui/IconButton.jsx`

**Current state (lines 19-28, 31-40):** Buttons use `title` attribute but no `aria-label`.

**Steps:**

1. Add `aria-label` to EditButton (line 25):
```jsx
<button className="icon-btn" title={title} aria-label={title} onClick={handleClick}>
```

2. Add `aria-label` to DeleteButton (line 37):
```jsx
<button className="icon-btn icon-btn-danger" title={title} aria-label={title} onClick={handleClick}>
```

**Exit criteria:** Screen readers announce button purpose.

### Task 4.2: Add Focus Trapping and Escape-to-Close to Modal

**File:** `src/components/ui/Modal.jsx`

**Current state (lines 1-27):** No keyboard event handling, no focus trapping, close button has no aria-label.

**Steps:**

1. Rewrite the Modal component:
```jsx
import React, { useEffect, useRef } from 'react'

function Modal({ show, onClose, title, children, footer }) {
  const modalRef = useRef(null)
  const previousFocusRef = useRef(null)

  useEffect(() => {
    if (!show) return

    // Save currently focused element
    previousFocusRef.current = document.activeElement

    // Focus the modal
    const timer = setTimeout(() => {
      if (modalRef.current) {
        const firstFocusable = modalRef.current.querySelector(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (firstFocusable) firstFocusable.focus()
      }
    }, 50)

    // Handle Escape key
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      // Focus trapping
      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        const firstElement = focusableElements[0]
        const lastElement = focusableElements[focusableElements.length - 1]

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault()
          lastElement.focus()
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault()
          firstElement.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
      // Restore focus
      if (previousFocusRef.current) {
        previousFocusRef.current.focus()
      }
    }
  }, [show, onClose])

  if (!show) return null

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal" onClick={e => e.stopPropagation()} ref={modalRef}>
        <div className="modal-header">
          <h3 id="modal-title">{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="סגור">&times;</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export default Modal
```

**Exit criteria:** Escape closes modal. Tab cycles within modal. Focus restored on close. Close button has aria-label. Modal has role="dialog" and aria-modal.

### Task 4.3: Add role="alert" to WorkerLogin Error

**File:** `src/components/WorkerLogin.jsx`

**Current state (lines 101-104):** Error div has no ARIA role.

**Steps:**

1. Add `role="alert"` to the error div (line 102):
```jsx
{error && (
  <div role="alert" style={{ color: '#dc3545', textAlign: 'center', marginBottom: '15px' }}>
    {error}
  </div>
)}
```

**Exit criteria:** Screen readers announce errors when they appear.

### Task 4.4: Auto-Dismiss Success/Error Messages in AdminPanel

**File:** `src/components/AdminPanel.jsx`

**Current state (lines 230-235):** Messages are displayed but never auto-dismissed.

**Steps:**

1. Add a useEffect to auto-dismiss messages after 5 seconds (after the existing useEffect blocks, around line 70):
```js
useEffect(() => {
  if (message) {
    const timer = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(timer)
  }
}, [message])
```

2. Add `role="alert"` to the message div (line 231):
```jsx
{message && (
  <div role="alert" className={`card ${message.type === 'success' ? 'badge-success' : 'badge-danger'}`}
       style={{ marginBottom: '20px', padding: '15px' }}>
    {message.text}
  </div>
)}
```

**Exit criteria:** Success/error messages disappear after 5 seconds. Screen readers announce them.

### Task 4.5: Fix Radius 0 Fallback in LocationForm

**File:** `src/components/LocationForm.jsx`

**Current state (line 52):** `parseInt(e.target.value) || 10` -- if user types `0`, `parseInt('0')` returns `0` which is falsy, so it falls back to `10`. But the `min="1"` attribute already prevents `0` in the UI. The real issue is `parseInt` returns `NaN` for empty string, and `NaN || 10` gives `10`.

However, the fallback should be `GEOFENCE_CONFIG.DEFAULT_RADIUS` instead of a magic number `10`.

**Steps:**

1. Import `GEOFENCE_CONFIG` in LocationForm.jsx (add to imports):
```js
import { GEOFENCE_CONFIG } from '../utils/distance'
```

2. Update the radius onChange (line 52):
```jsx
onChange={e => {
  const val = parseInt(e.target.value)
  onChange({ ...form, radiusMeters: (val > 0) ? val : GEOFENCE_CONFIG.DEFAULT_RADIUS })
}}
```

**Exit criteria:** Radius defaults to `GEOFENCE_CONFIG.DEFAULT_RADIUS` (not magic `10`) when empty or invalid. Zero is not allowed.

### Task 4.6: Add aria-current to ScansHistory Filter Buttons

**File:** `src/components/ScansHistory.jsx`

**Current state (lines 107-116):** Filter buttons have no `aria-current` attribute.

**Steps:**

1. Add `aria-current` to the filter button (line 111):
```jsx
<button
  key={f.key}
  className={`btn ${filter === f.key ? 'btn-primary' : 'btn-secondary'}`}
  style={{ padding: '6px 12px', fontSize: '0.9rem' }}
  onClick={() => setFilter(f.key)}
  aria-current={filter === f.key ? 'true' : undefined}
>
  {f.label}
</button>
```

**Exit criteria:** Active filter button has `aria-current="true"`.

### Task 4.7: Add aria-live to ScansHistory Stats Section

**File:** `src/components/ScansHistory.jsx`

**Current state (lines 199-208):** Stats section updates dynamically but has no `aria-live` region.

**Steps:**

1. Add `aria-live="polite"` to the stats container (line 199):
```jsx
<div aria-live="polite" style={{ marginTop: '20px', padding: '15px', background: '#f0f4ff', borderRadius: '8px', fontSize: '0.9rem', color: '#555' }}>
```

**Exit criteria:** Screen readers announce stats updates.

### Phase 4 Exit Criteria
- [ ] All icon buttons have aria-label
- [ ] Modal traps focus, closes on Escape, has aria-modal
- [ ] Error messages have role="alert"
- [ ] Admin messages auto-dismiss after 5 seconds
- [ ] Radius fallback uses config constant, prevents 0
- [ ] Filter buttons have aria-current
- [ ] Stats section has aria-live

---

## Deferred Items

The following review issues are intentionally deferred from this plan. They are low-risk, non-security items that do not affect correctness or user safety. They will be addressed in a future cleanup round.

| Issue | Description | Deferral Rationale |
|-------|-------------|-------------------|
| Minor #4 | Per-location `radiusMeters` stored but unused in geofence validation | Functional but not security-relevant. The global `GEOFENCE_CONFIG.DEFAULT_RADIUS` is used instead. Fixing requires changing the validation logic which is risky to combine with auth changes. Deferred to a feature round where geofence per-location config is fully implemented. |
| Minor #5 | Legacy single/multi worker field duplication in location docs | Data model cleanup. Existing code handles both fields correctly. Removing the legacy field requires a data migration and testing all location-related flows. Better done as a standalone cleanup task. |
| Minor #6 | Unused `html5-qrcode` dependency in `package.json` | Zero runtime impact (just increases bundle size slightly). Safe to remove anytime. Deferred to avoid unrelated dependency changes in a security-focused PR. |
| Minor #7 | `AdminPanel.jsx` too large (320 lines) | Code organization concern, not a bug. The component works correctly. Splitting it into sub-components is a refactor best done separately to keep this PR focused on security fixes. |
| Phase 4 #25 | `window.confirm` for delete not replaced with custom modal | UX improvement, not a bug or security issue. `window.confirm` works correctly for its purpose. Replacing it requires designing a confirmation modal component, which is out of scope for fixes-only. |

---

## First-Run Setup Steps (Manual)

After deploying all phases, the admin must perform these one-time setup steps:

1. **Enable Anonymous Auth:** In Firebase Console > Authentication > Sign-in method > Anonymous > Enable
2. **Set initial admin claim:** Run from Firebase Admin SDK or a one-time script:
   ```js
   admin.auth().getUserByEmail('matan1988b@gmail.com')
     .then(user => admin.auth().setCustomUserClaims(user.uid, { admin: true }))
   ```
3. **Migrate existing PINs:** After logging in as admin, call the `migratePINsToHash` Cloud Function to convert all plaintext PINs to hashed values.

---

## File Change Summary

| File | Phase | Change Type |
|------|-------|-------------|
| `firestore.rules` | 1 | Complete rewrite |
| `functions/index.js` | 1, 2 | Major additions + fixes (includes `getWorkerList`) |
| `src/hooks/useWorkerAuth.js` | 1 | Complete rewrite |
| `src/hooks/useAdminAuth.js` | 1 | Major refactor |
| `src/hooks/useFirebaseData.js` | 1, 3 | Add `usePublicWorkerList` (Phase 1) + reconnection fix (Phase 3) |
| `src/components/WorkerLogin.jsx` | 1, 4 | Refactor + a11y |
| `src/components/WorkerManagement.jsx` | 1 | Hide PINs |
| `src/components/AdminPanel.jsx` | 1, 4 | Hash PINs + auto-dismiss |
| `src/pages/WorkerApp.jsx` | 1, 3 | Auth flow + public worker list + polling fix |
| `src/services/offlineStorage.js` | 3 | Fix listener cleanup |
| `src/services/syncService.js` | 3 | Fix interval cleanup |
| `src/services/scanProcessor.js` | 3 | Add offline fallback |
| `src/utils/qrGenerator.js` | 3 | Fix XSS |
| `src/components/ScansHistory.jsx` | 3, 4 | Server-side filtering + aria-current + aria-live |
| `src/components/ui/IconButton.jsx` | 4 | Add aria-label |
| `src/components/ui/Modal.jsx` | 4 | Complete rewrite (focus trap) |
| `src/components/LocationForm.jsx` | 4 | Fix radius fallback |
| `src/services/firebase.js` | -- | No changes needed |

---

### Router Contract (MACHINE-READABLE)
```yaml
STATUS: PLAN_REVISED
PLAN_MODE: execution_plan
PLAN_REVISION: 2
PLAN_REVISION_REASON: "3 blocking review findings + 1 non-blocking bug fix addressed"
VERIFICATION_RIGOR: standard
CONFIDENCE: 90
PLAN_FILE: docs/plans/2026-04-05-security-fixes-plan.md
DESIGN_FILE: docs/plans/2026-04-05-security-fixes-design.md
PHASES: [auth-security, backend-fixes, frontend-fixes, ux-a11y-polish]
TOTAL_TASKS: 19
PHASE_TASK_COUNTS:
  auth-security: 8
  backend-fixes: 3
  frontend-fixes: 7
  ux-a11y-polish: 7
REVISION_CHANGES:
  - type: moved_task
    description: "Moved getWorkerList Cloud Function and usePublicWorkerList hook from Phase 3 to Phase 1 (new Task 1.8)"
    reason: "Phase 1 Firestore rules make workers collection admin-only, breaking worker app if public list not available"
  - type: added_task
    description: "Added Task 3.7: Server-side scan filtering in ScansHistory"
    reason: "ScansHistory fetches all scans client-side; workers can see other workers' scans"
  - type: bug_fix
    description: "Fixed scan.timestamp?.toDate() to scan.createdAt?.toDate() in Task 2.3"
    reason: "timestamp is an ISO string, not a Firestore Timestamp; createdAt is the correct field"
  - type: added_section
    description: "Added Deferred Items section for Minor #4, #5, #6, #7 and Phase 4 #25"
    reason: "Review found these issues had no plan task and no explicit deferral"
DEFERRED_ITEMS:
  - id: "minor-4"
    description: "Per-location radiusMeters stored but unused in geofence validation"
    reason: "Not security-relevant; requires validation logic changes; deferred to feature round"
  - id: "minor-5"
    description: "Legacy single/multi worker field duplication"
    reason: "Data model cleanup requiring migration; better as standalone task"
  - id: "minor-6"
    description: "Unused html5-qrcode dependency"
    reason: "Zero runtime impact; avoid unrelated dependency changes in security PR"
  - id: "minor-7"
    description: "AdminPanel.jsx too large (320 lines)"
    reason: "Code organization; not a bug; refactor best done separately"
  - id: "phase4-25"
    description: "window.confirm for delete not replaced with custom modal"
    reason: "UX improvement; window.confirm works correctly; out of scope for fixes-only"
RISKS_IDENTIFIED:
  - auth-migration-breaks-existing-sessions
  - offline-token-expiry
  - phase-1-deploy-ordering-critical
SCENARIOS:
  - name: "Admin can manage locations and workers"
    command: "firebase deploy && manual test"
    expected: "Admin actions succeed with custom claim"
    actual: "TBD"
    exit_code: 0
  - name: "Worker can authenticate and scan"
    command: "manual test"
    expected: "PIN validated server-side, scan saved with workerId claim"
    actual: "TBD"
    exit_code: 0
  - name: "Unauthenticated access denied"
    command: "curl Firestore REST API without auth"
    expected: "403 Forbidden"
    actual: "TBD"
    exit_code: 0
  - name: "Worker can see worker list after Phase 1 deploy"
    command: "manual test"
    expected: "Worker selection screen shows workers via getWorkerList Cloud Function"
    actual: "TBD"
    exit_code: 0
  - name: "Worker ScansHistory shows only own scans"
    command: "manual test"
    expected: "Firestore query includes where('workerId', '==', workerId) for non-admin users"
    actual: "TBD"
    exit_code: 0
ASSUMPTIONS: [Firebase Anonymous Auth enabled, existing admin has Google account matan1988b@gmail.com]
DECISIONS: [SHA-256 for PIN hashing, 1-hour custom token expiry, rate limit 5 attempts per 10 min, getWorkerList in Phase 1 not Phase 3]
OPEN_DECISIONS: []
DIFFERENCES_FROM_AGREEMENT: []
RECOMMENDED_DEFAULTS: []
ALTERNATIVES: [Custom Auth tokens without anonymous auth, server-only validation without Firebase Auth]
DRAWBACKS: [Token refresh adds complexity, anonymous auth requires enabling in Firebase Console]
PROVABLE_PROPERTIES: []
BLOCKING: []
NEXT_ACTION: proceed_to_build
REMEDIATION_NEEDED: false
REQUIRES_REMEDIATION: false
REMEDIATION_REASON: N/A
GATE_PASSED: true
USER_INPUT_NEEDED: []
MEMORY_NOTES:
  - "4-phase plan: auth-security -> backend-fixes -> frontend-fixes -> ux-a11y-polish"
  - "Worker auth migration requires enabling Anonymous Auth in Firebase Console"
  - "Existing plaintext PINs need one-time hash migration"
  - "CRITICAL: getWorkerList + usePublicWorkerList must deploy with Phase 1 Firestore rules"
  - "ScansHistory server-side filtering added in Task 3.7"
  - "5 minor items explicitly deferred with rationale"
  - "Task 2.3 timestamp bug fixed: scan.createdAt not scan.timestamp"
```
