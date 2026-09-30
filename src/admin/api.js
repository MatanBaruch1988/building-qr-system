import { api } from '../api/client.js'

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

const MESSAGES = {
  not_an_admin: 'החשבון הזה אינו ברשימת הוועד. בקשו מחבר ועד להוסיף את כתובת ה-Gmail שלכם.',
  google_account_mismatch: 'כתובת המייל הזאת קשורה לחשבון Google אחר.',
  google_invalid: 'לא הצלחנו לאמת את חשבון Google. נסו שוב.',
  google_email_unverified: 'כתובת המייל בחשבון Google לא מאומתת.',
  google_not_configured: 'הכניסה עם Google עדיין לא הוגדרה בשרת.',
  too_many_attempts: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
  coordinates_required: 'נקודה שמחייבת מיקום צריכה קואורדינטות. סמנו אותה במפה.',
  password_too_short: 'הסיסמה חייבת להכיל לפחות 8 תווים.',
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
