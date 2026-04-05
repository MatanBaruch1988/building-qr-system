# Security & Bug Fixes Design

## Purpose
Fix all 26 issues found in the full project code review (5 critical, 8 major, 13 minor). The project currently has no real security — Firestore rules allow unauthenticated read/write, worker PINs are in plaintext, and auth is client-side only.

## Users
- **Admins**: Building managers using Google Sign-in (existing)
- **Workers**: Service workers using PIN entry on mobile devices

## Success Criteria
- [ ] No unauthenticated Firestore reads or writes possible
- [ ] Worker PINs hashed, never transmitted or stored in plaintext
- [ ] Worker auth validated server-side via Cloud Function
- [ ] Admin role enforced via custom claims, not hardcoded email
- [ ] Cloud Functions require authentication
- [ ] All 5 critical, 8 major, and 13 minor issues resolved
- [ ] Existing worker UX preserved (simple PIN entry, offline support)
- [ ] No new features added — fixes only

## Constraints
- Must maintain offline-first PWA behavior
- Must keep simple PIN-based worker UX
- Firebase is the only backend (no external auth providers)
- Hebrew RTL UI must continue working

## Out of Scope
- No new features (e.g., in-app QR scanning, analytics)
- No UI redesign
- No test infrastructure (deferred to a future round)
- No migration tooling for existing data (manual one-time migration acceptable)

## Approach Chosen
**Firebase Anonymous Auth + Server PIN Validation**

Workers sign in anonymously first, then a Cloud Function validates their PIN against a hashed value and returns a Firebase Custom Token with worker claims. Firestore rules use those claims for authorization.

### Why this approach
- Preserves simple PIN UX for workers
- Server-side validation prevents PIN enumeration
- Custom tokens carry worker identity into Firestore rules
- Anonymous auth bootstraps the Firebase Auth session needed for Firestore

### Alternatives considered
- **Custom Auth tokens only**: More complex token refresh management, no anonymous fallback
- **Server validation without Firebase Auth**: Minimal changes but Firestore rules can't enforce worker identity

## Architecture

### Worker Auth Flow (new)
```
Worker selects name → enters PIN
  → signInAnonymously() (Firebase Auth)
  → call Cloud Function: validateWorkerPIN(workerId, pin)
  → Function: hash(pin) === stored hash?
    → Yes: createCustomToken(uid, {workerId, workerName})
    → No: throw unauthenticated error
  → Client: signInWithCustomToken(customToken)
  → Firestore rules: request.auth.token.workerId validates identity
```

### Admin Auth Flow (updated)
```
Admin signs in with Google
  → Cloud Function: setAdminClaim(uid) (called on first admin setup)
  → request.auth.token.admin === true in Firestore rules
  → Remove hardcoded email check from client
```

### Firestore Rules (new)
```
locations:
  read: if request.auth != null
  write: if request.auth.token.admin == true

workers:
  read: if request.auth.token.admin == true  (no client read of PIN)
  write: if request.auth.token.admin == true

scans:
  read: if request.auth != null
  create: if request.auth != null
          && request.auth.token.workerId == request.resource.data.workerId
  update/delete: if request.auth.token.admin == true

failedScans:
  read: if request.auth.token.admin == true
  create: if request.auth != null
```

### PIN Hashing
- Use `crypto.createHash('sha256')` in Cloud Functions (no bcrypt needed for 4-6 digit PINs with rate limiting)
- Add rate limiting: max 5 failed attempts per IP per 10 minutes
- Migration: one-time script to hash existing plaintext PINs

## Components

### New Cloud Functions
1. `validateWorkerPIN(workerId, pin)` — validates PIN, returns custom token
2. `setAdminClaim(uid)` — sets admin custom claim (callable by existing admin only)
3. `hashWorkerPIN(workerId, pin)` — used by admin when creating/updating workers

### Modified Files

**Phase 1 — Auth & Security:**
- `firestore.rules` — complete rewrite with auth requirements
- `functions/index.js` — add validateWorkerPIN, setAdminClaim, hashWorkerPIN
- `src/hooks/useWorkerAuth.js` — Anonymous Auth + custom token flow
- `src/hooks/useAdminAuth.js` — remove hardcoded email, use admin claim
- `src/components/WorkerLogin.jsx` — call Cloud Function instead of client-side check
- `src/components/WorkerManagement.jsx` — hash PINs on create/edit
- `src/services/firebase.js` — ensure anonymous auth provider enabled

**Phase 2 — Backend Fixes:**
- `functions/index.js` — fix timestamp queries (use createdAt), add auth to getDailyStats/syncScanToCalendar, implement syncScanToCalendar stub
- `functions/package.json` — no new dependencies needed (crypto is built-in)

**Phase 3 — Frontend Fixes:**
- `src/services/offlineStorage.js` — fix event listener cleanup (store references)
- `src/services/syncService.js` — fix setInterval cleanup, add cleanup function
- `src/services/scanProcessor.js` — add offline fallback on Firebase save failure
- `src/utils/qrGenerator.js` — fix XSS in document.write (escape title)
- `src/hooks/useFirebaseData.js` — listen for connection changes, establish listeners on reconnect
- `src/components/ScansHistory.jsx` — add server-side workerId filtering
- `src/components/WorkerApp.jsx` — fix 50ms polling interval

**Phase 4 — UX/A11y Polish:**
- `src/components/ui/IconButton.jsx` — add aria-label
- `src/components/ui/Modal.jsx` — add focus trapping, close-on-Escape
- `src/components/WorkerLogin.jsx` — add role="alert", inputMode="numeric"
- `src/components/AdminPanel.jsx` — auto-dismiss success/error messages
- `src/components/LocationForm.jsx` — fix radius 0 fallback

## Data Flow

### Scan Submission (updated)
```
Worker scans QR → app receives ?code= parameter
  → parseQRCodeData() extracts location ID
  → findLocationByCode() matches against cached locations
  → validateScanData() checks worker permissions
  → getGPSPosition() acquires device GPS
  → validateGeofence() distance check with confidence scoring
  → saveScan():
    → Try Firebase (auth token includes workerId claim)
    → On failure: fall back to savePendingScan() (offline storage)
  → Display result
  → Auto-sync when back online (sync also uses auth token)
```

### Offline Flow (updated)
- Worker auth token cached locally after initial PIN validation
- Offline scans saved to localStorage with workerId from token claims
- On sync: token refreshed if needed, then scans submitted with auth

## Error Handling
- PIN validation: rate-limited, generic "invalid PIN" error (no enumeration)
- Token expiry: re-prompt PIN entry (custom tokens expire in 1 hour by default)
- Offline auth: allow scanning with cached token, validate on sync
- Admin claim setup: admin creates first admin via Firebase Console, subsequent via app

## Questions Resolved
- Q: How should worker auth work?
  A: Firebase Anonymous Auth + Server PIN validation via Cloud Function returning custom token
- Q: What scope of fixes?
  A: Everything — all 26 issues
- Q: What's out of scope?
  A: No new features — fixes only
