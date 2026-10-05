import { api } from '../api/client.js'
import { PASSWORD_MIN_LENGTH } from '../../shared/contract.js'

/**
 * Committee calls: the session travels in an HttpOnly cookie, nothing to attach.
 * A 401 on a call that needs the session announces it, so the shell can show the sign-in screen.
 */
export async function adminApi(path, opts) {
  try {
    return await api(`/admin${path}`, { timeoutMs: 15_000, ...opts })
  } catch (err) {
    if (err.status === 401 && err.code === 'admin_required' && path !== '/me') {
      window.dispatchEvent(new Event('admin-session-expired'))
    }
    throw err
  }
}

/**
 * One refused visit, as GET /api/admin/scan-refusals shows it (refusalJson in server/scanRefusals.js). The times are ISO 8601.
 * @typedef {object} ScanRefusal
 * @property {number} id
 * @property {string} at  when the server refused it
 * @property {string | null} scan_id  the phone's id of the check-in
 * @property {string} source  a SCAN_SOURCES word: online, or from the phone's queue
 * @property {string} code  a SCAN_ERROR_* code (a newer server may send one that this screen does not know)
 * @property {string} provider_id
 * @property {string} provider_name
 * @property {string | null} point_id  null when the code named no point
 * @property {string | null} point_name
 * @property {string | null} client_time  the phone's clock, when it can be believed
 */

/**
 * The visits that the server refused (GET /api/admin/scan-refusals), newest first, one page at a time:
 * `{ refusals, next_cursor }`. `params` are the endpoint's own (`from`, `to`, `point_id`, `provider_id`, `limit`, `cursor`);
 * an empty one is left out. They are not scans: they never count as attendance.
 * @param {Record<string, string | number | null | undefined>} [params]
 * @returns {Promise<{ refusals: ScanRefusal[], next_cursor: string | null }>}
 */
export function scanRefusals(params = {}) {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value != null) q.set(key, String(value))
  }
  const text = q.toString()
  return adminApi(`/scan-refusals${text ? `?${text}` : ''}`)
}

/**
 * One page of the audit log (GET /api/admin/audit), newest first: `{ entries, next_cursor }` (AuditPage in shared/types.js).
 * `params` are the endpoint's own (`from`, `to` as building days, `group`, `actor_id`, `entity`, `entity_id`, `limit`, `cursor`);
 * an empty one is left out. The log is read only: there is no call that writes to it.
 * @param {Record<string, string | number | null | undefined>} [params]
 * @returns {Promise<import('../../shared/types.js').AuditPage>}
 */
export function auditLog(params = {}) {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value != null) q.set(key, String(value))
  }
  const text = q.toString()
  return adminApi(`/audit${text ? `?${text}` : ''}`)
}

const MESSAGES = {
  not_an_admin: 'החשבון הזה אינו ברשימת הוועד. בקשו מחבר ועד להוסיף את כתובת ה-Gmail שלכם.',
  google_account_mismatch: 'כתובת המייל הזאת קשורה לחשבון Google אחר.',
  google_invalid: 'לא הצלחנו לאמת את חשבון Google. נסו שוב.',
  google_email_unverified: 'כתובת המייל בחשבון Google לא מאומתת.',
  google_not_configured: 'הכניסה עם Google עדיין לא הוגדרה בשרת.',
  too_many_attempts: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
  coordinates_required: 'נקודה שמחייבת מיקום צריכה קואורדינטות. סמנו אותה במפה.',
  password_too_short: `הסיסמה חייבת להכיל לפחות ${PASSWORD_MIN_LENGTH} תווים.`,
  missing_field: 'חסר שדה חובה.',
  invalid_field: 'אחד הערכים לא תקין.',
  cannot_deactivate_self: 'אי אפשר להסיר את הגישה של עצמכם.',
  already_voided: 'הנוכחות כבר בוטלה.',
  not_voided: 'הנוכחות הזו לא מבוטלת.',
  unknown_provider: 'אחד מנותני השירות שנבחרו כבר לא קיים.',
  point_not_found: 'הנקודה לא נמצאה. ייתכן שמישהו אחר שינה אותה, רעננו.',
  provider_not_found: 'נותן השירות לא נמצא. ייתכן שמישהו אחר שינה אותו, רעננו.',
  scan_not_found: 'הנוכחות לא נמצאה.',
  api_key_not_found: 'המפתח לא נמצא או שכבר בוטל.',
  admin_not_found: 'חבר הוועד לא נמצא.',
  invalid_filter: 'אחד מהמסננים לא תקין.',
  invalid_cursor: 'הרשימה השתנתה. רעננו ונסו שוב.',
  nothing_to_update: 'לא שונה כלום.',
  admin_required: 'פג תוקף ההתחברות. היכנסו שוב.',
  network: 'אין חיבור לשרת. נסו שוב.',
  timeout: 'השרת לא ענה בזמן. נסו שוב.',
}

/** A message a committee member can act on. */
export const errorText = (err) => MESSAGES[err?.code] ?? 'משהו השתבש. נסו שוב.'

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      /* ignore */
    }
    ta.remove()
    return ok
  }
}
