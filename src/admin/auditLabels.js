// The words of the audit log screen (src/admin/views/AuditView.jsx), in the Hebrew of the committee app: what each action is
// called, what each group is called, and what each field of a change is called. Nothing here is drawn or fetched.
//
// The keys are the actions that the server writes (the table at the top of server/audit.js: tests/audit-screen.test.jsx fails
// when an action of that table has no phrase here). An action that is not here, for example one that a newer server writes, is
// shown by its own name (describeEntry in src/admin/auditDescribe.js), so a missing phrase never hides an entry.
import { GPS_MODE_REQUIRED, GPS_MODE_OPTIONAL, GPS_MODE_NONE } from '../../shared/contract.js'

/** What was done, as a short phrase. */
export const ACTION_LABELS = Object.freeze({
  'admin.add': 'הוספת חבר ועד',
  'admin.enable': 'הפעלת חבר ועד',
  'admin.disable': 'השבתת חבר ועד',
  'admin.delete': 'מחיקת חבר ועד',
  'building.update': 'עדכון פרטי הבניין',
  'point.create': 'יצירת נקודה',
  'point.update': 'עדכון נקודה',
  'point.delete': 'מחיקת נקודה',
  'point.regenerate_qr': 'החלפת קוד QR',
  'provider.create': 'הוספת נותן שירות',
  'provider.update': 'עדכון נותן שירות',
  'provider.delete': 'מחיקת נותן שירות',
  'provider.revoke_devices': 'ניתוק מכשירים',
  'scan.void': 'ביטול נוכחות',
  'scan.unvoid': 'שחזור נוכחות',
  'scan.delete': 'מחיקת נוכחות',
  'api_key.create': "יצירת מפתח אייג'נט",
  'api_key.revoke': "השבתת מפתח אייג'נט",
  'api_key.delete': "מחיקת מפתח אייג'נט",
  'session.sign_in': 'כניסה',
  'session.sign_out': 'יציאה',
  'retention.run': 'ניקוי אוטומטי',
})

/**
 * The choices of the group filter, in the order of the list. `value` is what the API takes as `group` (the part of an action
 * before the dot, AUDIT_GROUPS in server/routes/audit.js); the first one is "no group".
 */
export const GROUP_OPTIONS = Object.freeze([
  { value: '', label: 'הכל' },
  { value: 'admin', label: 'חברי ועד' },
  { value: 'building', label: 'פרטי הבניין' },
  { value: 'point', label: 'נקודות' },
  { value: 'provider', label: 'נותני שירות' },
  { value: 'scan', label: 'נוכחות' },
  { value: 'api_key', label: "מפתחות אייג'נט" },
  { value: 'session', label: 'כניסות ויציאות' },
  { value: 'retention', label: 'ניקוי אוטומטי' },
])

/**
 * The fields of an update (`detail.changes`), in the order in which they are shown. Only a field that is here is ever shown:
 * a field that the server adds later stays out of the screen until it is added here and someone has decided that the committee
 * may read it. Everything is a plain string, drawn as text.
 */
export const FIELD_LABELS = Object.freeze({
  name: 'שם',
  company: 'חברה',
  contact_name: 'איש קשר',
  description: 'תיאור',
  service_type: 'סוג שירות',
  address: 'כתובת',
  gps_mode: 'בדיקת מיקום',
  lat: 'קו רוחב',
  lng: 'קו אורך',
  radius_m: 'רדיוס (מטרים)',
  is_active: 'פעיל',
  is_demo: 'חשבון דמו',
})

/** The values of `gps_mode`, as the point form names them. */
export const GPS_MODE_LABELS = Object.freeze({
  [GPS_MODE_REQUIRED]: 'מיקום חובה',
  [GPS_MODE_OPTIONAL]: 'מיקום אם אפשר',
  [GPS_MODE_NONE]: 'בלי מיקום',
})

/** The sign-in methods of `session.sign_in`. */
export const METHOD_LABELS = Object.freeze({
  google: 'כניסה עם Google',
  dev: 'כניסת פיתוח',
})

/** The counts of the daily cleanup (`retention.run`). */
export const RETENTION_LABELS = Object.freeze({
  sessions: 'חיבורים שפג תוקפם',
  login_attempts: 'ניסיונות כניסה',
  device_labels: 'שמות מכשירים',
})

/** Who, when it is not a committee member. */
export const SYSTEM_ACTOR = 'המערכת'
export const SCRIPT_ACTOR = 'סקריפט התקנה'
export const UNKNOWN_ACTOR = 'חבר ועד'
export const DELETED_ACTOR_MARK = '(נמחק)'
export const EMPTY_VALUE = 'ריק'
export const YES = 'כן'
export const NO = 'לא'
