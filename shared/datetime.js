// The one place that writes a date or a time for a person: DD/MM/YYYY and HH:MM (24 hours), in the building's time
// zone. The same on every phone and every computer: never the device's own region or language, and never a month name
// or a weekday. Anything shown on a screen or written into a file for people goes through here, in the browser and on
// the server (the committee's CSV). tests/dates.test.js fails if another way of writing a date turns up in the code.
//
// What is NOT for people keeps its machine format on purpose: the API and the agent read ISO dates (2026-10-01,
// 2026-10-01T18:00:00Z), which cannot be misread as day-month or month-day.

export const BUILDING_TZ = 'Asia/Jerusalem'

// Only used to get the numbers (in the building's zone, 24 hours, Western digits): the text is put together by hand
// below, so no locale can change its shape.
const numbers = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUILDING_TZ,
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

// The same numbers in UTC, for the one column of the committee's file that keeps the exact moment.
const numbersUtc = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

// A moment given as text must say which moment it is (a Z or an offset, as the API writes it). Text without one would
// be read in the time zone of whatever machine runs this, and the same text would show different times on two phones.
const WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i

function parts(value, formatter = numbers) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' && !WITH_ZONE.test(value)) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const out = {}
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value
  return out
}

/** '01/10/2026' (the day in the building's time zone), or '-' when there is no date. */
export function formatDate(value) {
  const p = parts(value)
  return p ? `${p.day}/${p.month}/${p.year}` : '-'
}

/** '21:05', 24 hours, or '-'. */
export function formatTime(value) {
  const p = parts(value)
  return p ? `${p.hour}:${p.minute}` : '-'
}

/** '01/10/2026 21:05', or '-'. */
export function formatDateTime(value) {
  const p = parts(value)
  return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : '-'
}

/** The same as formatDateTime but in UTC ('30/09/2026 05:12'), for the committee's file: it keeps the exact moment. */
export function formatDateTimeUtc(value) {
  const p = parts(value, numbersUtc)
  return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : '-'
}

/** The building's calendar day as the API writes it: '2026-10-01'. For queries and logic, not for people. */
export function isoDay(value = new Date()) {
  const p = parts(value)
  return p ? `${p.year}-${p.month}-${p.day}` : ''
}

/** '2026-10-01' (a calendar day from the API) as '01/10/2026'. No time zone is involved: it is already a day. */
export function formatDay(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '')
  return match && isRealDay(match[1], match[2], match[3]) ? `${match[3]}/${match[2]}/${match[1]}` : '-'
}

/** True for a day that exists on the calendar: 29/02 only in a leap year, no 31st in a 30-day month. */
function isRealDay(year, month, day) {
  const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return check.getUTCFullYear() === Number(year) && check.getUTCMonth() === Number(month) - 1 && check.getUTCDate() === Number(day)
}

/** What a person types, '01/10/2026', as the API's '2026-10-01', or null when it is not a real date. */
export function parseDay(text) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text ?? '').trim())
  if (!match) return null
  const [, day, month, year] = match
  return isRealDay(year, month, day) && Number(year) >= 2000 && Number(year) <= 2100 ? `${year}-${month}-${day}` : null
}

/** While typing: digits only, with the slashes put in by themselves ('0110' becomes '01/10'), at most DD/MM/YYYY. */
export function maskDay(text) {
  const digits = String(text ?? '').replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}

/**
 * What the DD/MM/YYYY field shows after the person edits it. `previous` is the text before the edit, `raw` is what the
 * browser has now (digits, maybe a slash that was typed or deleted) and `caret` is where the cursor is in `raw`.
 * Returns { text, caret }: the masked text and where the cursor goes, after the same digit as before.
 *
 * Deleting a slash also deletes the digit before it. Otherwise the slash would come straight back and the key press
 * would seem to do nothing, and the next one would delete the wrong digit.
 */
export function editDay(previous, raw, caret = String(raw ?? '').length) {
  const text = String(raw ?? '')
  let digits = ''
  let before = 0 // how many digits are left of the cursor
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i])) {
      digits += text[i]
      if (i < caret) before += 1
    }
  }
  const deletedASlash = text.length === String(previous ?? '').length - 1 && maskDay(text) === previous
  if (deletedASlash && before > 0) {
    digits = digits.slice(0, before - 1) + digits.slice(before)
    before -= 1
  }
  digits = digits.slice(0, 8)
  before = Math.min(before, digits.length)
  return { text: maskDay(digits), caret: before + (before > 2 ? 1 : 0) + (before > 4 ? 1 : 0) }
}
