// The daily retention job: it deletes technical personal data once its retention period is over (the periods are constants
// in server/config.js, written for people in docs/privacy.md). GET /api/cron/retention runs it, called by Vercel Cron.
//
// What it does, and all it does:
//   - deletes the committee sessions that expired, or were revoked, more than RETENTION_SESSION_DAYS ago,
//   - deletes the login attempts older than RETENTION_LOGIN_ATTEMPT_DAYS,
//   - clears the label of a phone (provider_devices.label, the browser string it sent at sign-in) when the phone was revoked
//     more than RETENTION_DEVICE_LABEL_DAYS ago. The row stays (a scan keeps the id of the phone that made it, and the
//     owner's decision is to clear the text, not the row): only the string that can identify a person's device goes.
//   - writes one audit_log row (`retention.run`, actor `system`) that holds the three counts and nothing else.
// What it never touches: a scan, the audit log, a session that is active or expired less than the period ago, a phone that
// is not revoked or was revoked less than the period ago. Their retention waits for a legal decision (docs/privacy.md).
//
// It is safe to run twice, or late, or not at all for a day (Vercel Cron delivery is best effort): every statement is a
// condition on age, so a run deletes what is due at that moment and the next one finds nothing more.
import { tx } from './db.js'
import { audit } from './audit.js'
import { RETENTION_SESSION_DAYS, RETENTION_LOGIN_ATTEMPT_DAYS, RETENTION_DEVICE_LABEL_DAYS } from './config.js'

/**
 * Runs the job once and returns what it removed: `{ sessions, loginAttempts, deviceLabels }` (numbers of rows). The three
 * statements and the audit row are one transaction, so the audit row says what really happened: all of it or none of it.
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
    const labels = await c.query(
      `update provider_devices set label = ''
        where revoked_at < now() - make_interval(days => $1::int) and label <> ''`,
      [RETENTION_DEVICE_LABEL_DAYS],
    )
    const counts = { sessions: sessions.rowCount, loginAttempts: attempts.rowCount, deviceLabels: labels.rowCount }
    // Counts only: no id, no name, no label. The audit log has no end date, and nothing in the app reads it today (no screen,
    // no agent API, no export): only whoever holds the database or a backup can.
    // The name of the system actor stays null on purpose: actor_name is the snapshot of a person's name, and the system actor
    // is already named by actor_type, so a screen can name it in the reader's own language (src/i18n), which a fixed English
    // string in the database could not do.
    await audit(c, { type: 'system', id: null, name: null }, 'retention.run', {
      detail: { sessions: counts.sessions, login_attempts: counts.loginAttempts, device_labels: counts.deviceLabels },
    })
    return counts
  })
}
