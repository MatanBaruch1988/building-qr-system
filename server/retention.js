// The daily retention job: it deletes technical personal data once its retention period is over (the periods are constants
// in server/config.js, written for people in docs/privacy.md). GET /api/cron/retention runs it, called by Vercel Cron.
//
// What it does, and all it does:
//   - deletes the committee sessions that expired, or were revoked, more than RETENTION_SESSION_DAYS ago,
//   - deletes the login attempts older than RETENTION_LOGIN_ATTEMPT_DAYS,
//   - clears the label of a phone (provider_devices.label, the browser string it sent at sign-in) when the phone was revoked
//     more than RETENTION_DEVICE_LABEL_DAYS ago, and in the same statement everything that the phone reported about itself
//     (migration 010: the build, the time of the report, how many visits waited and since when, the two running totals, the time
//     of the last upload). The row stays (a scan keeps the id of the phone that made it, and the owner's decision is to clear the
//     text, not the row): only what can identify a person's device, or says what it did, goes. A phone with no label that still
//     holds a status is cleared too, so a status never outlives the period because the label happened to be empty.
//   - deletes the recorded errors (app_errors, safe fields only: server/errorLog.js) whose last event is older than
//     RETENTION_APP_ERROR_DAYS,
//   - writes one audit_log row (`retention.run`, actor `system`) that holds the four counts and nothing else.
// What it never touches: a scan, the audit log, a session that is active or expired less than the period ago, a phone that
// is not revoked or was revoked less than the period ago. Their retention waits for a legal decision (docs/privacy.md).
//
// It is safe to run twice, or late, or not at all for a day (Vercel Cron delivery is best effort): every statement is a
// condition on age, so a run deletes what is due at that moment and the next one finds nothing more.
import { tx } from './db.js'
import { audit } from './audit.js'
import {
  RETENTION_SESSION_DAYS,
  RETENTION_LOGIN_ATTEMPT_DAYS,
  RETENTION_DEVICE_LABEL_DAYS,
  RETENTION_APP_ERROR_DAYS,
} from './config.js'

/**
 * Runs the job once and returns what it removed: `{ sessions, loginAttempts, deviceLabels, appErrors }` (numbers of rows;
 * `deviceLabels` is the number of phones that were cleared, the label and the reported status together). The four statements
 * and the audit row are one transaction, so the audit row says what really happened: all of it or none of it.
 * Each statement still has the 15 second limit of the app (server/db.js). A failure is thrown as it is and the router
 * answers 500 and logs only its code (server/router.js); nothing here logs an error or a row.
 */
export async function runRetention() {
  return tx(async (c) => {
    const sessions = await c.query(
      `delete from admin_sessions
        where expires_at < now() - make_interval(days => $1::int)
           or revoked_at < now() - make_interval(days => $1::int)`,
      [RETENTION_SESSION_DAYS],
    )
    const attempts = await c.query('delete from auth_attempts where at < now() - make_interval(days => $1::int)', [
      RETENTION_LOGIN_ATTEMPT_DAYS,
    ])
    // The `or` list is what is left to clear: a phone that was cleared matches none of it, so a second run finds nothing.
    const labels = await c.query(
      `update provider_devices
          set label = '', app_build = null, status_at = null, waiting_count = null, oldest_waiting_at = null,
              last_sync_at = null, not_accepted_total = 0, overflow_total = 0
        where revoked_at < now() - make_interval(days => $1::int)
          and (label <> '' or app_build is not null or status_at is not null or waiting_count is not null
               or oldest_waiting_at is not null or last_sync_at is not null or not_accepted_total <> 0 or overflow_total <> 0)`,
      [RETENTION_DEVICE_LABEL_DAYS],
    )
    // By the time of the last event, not the first: a row that still gets events is not old.
    const errors = await c.query('delete from app_errors where last_at < now() - make_interval(days => $1::int)', [
      RETENTION_APP_ERROR_DAYS,
    ])
    const counts = {
      sessions: sessions.rowCount,
      loginAttempts: attempts.rowCount,
      deviceLabels: labels.rowCount,
      appErrors: errors.rowCount,
    }
    // Counts only: no id, no name, no label. The audit log has no end date. The committee reads it (GET /api/admin/audit);
    // the agent API and the exports do not have it, and whoever holds the database or a backup can read it too.
    // The name of the system actor stays null on purpose: actor_name is the snapshot of a person's name, and the system actor
    // is already named by actor_type, so a screen can name it in the reader's own language (src/i18n), which a fixed English
    // string in the database could not do.
    await audit(c, { type: 'system', id: null, name: null }, 'retention.run', {
      detail: {
        sessions: counts.sessions,
        login_attempts: counts.loginAttempts,
        device_labels: counts.deviceLabels,
        app_errors: counts.appErrors,
      },
    })
    return counts
  })
}
