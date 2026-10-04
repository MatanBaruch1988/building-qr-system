// The flags that a scan can carry in its `flags` column: the one list. They are signals for the committee and for the
// agent, never a reason to refuse a scan. Runs in the browser and on the server.
//
// Where a flag is written, in code, always through these constants (an unknown name is an import error, a typo in a
// string is not): server/scanLogic.js (location and clock flags), server/scans.js (demo) and server/importFirestore.js
// (legacy_import). Where a flag is described for a reader, the description is kept in step by tests/agent-docs.test.js:
//   - server/schemaDoc.js (GET /api/agent/v1/schema, the `flags` object)
//   - docs/agent-api.md (the list under "Flags are signals, not verdicts")
//   - src/admin/views/HistoryView.jsx (FLAGS, the Hebrew label of each flag in the committee's history screen)
// To add a flag: add a constant here and put it in SCAN_FLAGS, emit it through the constant, and describe it in the three
// places above. The test names every place that is missing it.

export const FLAG_LOCATION_UNVERIFIED = 'location_unverified'
export const FLAG_LOCATION_OUTSIDE_RADIUS = 'location_outside_radius'
export const FLAG_LOCATION_STALE = 'location_stale'
export const FLAG_OFFLINE_SYNC = 'offline_sync'
export const FLAG_CLOCK_SKEW = 'clock_skew'
export const FLAG_DEMO = 'demo'
export const FLAG_LEGACY_IMPORT = 'legacy_import'

/** Every flag, in the order that the documents list them. Frozen: nothing may add one at run time. */
export const SCAN_FLAGS = Object.freeze([
  FLAG_LOCATION_UNVERIFIED,
  FLAG_LOCATION_OUTSIDE_RADIUS,
  FLAG_LOCATION_STALE,
  FLAG_OFFLINE_SYNC,
  FLAG_CLOCK_SKEW,
  FLAG_DEMO,
  FLAG_LEGACY_IMPORT,
])
