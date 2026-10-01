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

function parts(value) {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const out = {}
  for (const part of numbers.formatToParts(date)) out[part.type] = part.value
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

/** The building's calendar day as the API writes it: '2026-10-01'. For queries and logic, not for people. */
export function isoDay(value = new Date()) {
  const p = parts(value)
  return p ? `${p.year}-${p.month}-${p.day}` : ''
}

/** '2026-10-01' (a calendar day from the API) as '01/10/2026'. No time zone is involved: it is already a day. */
export function formatDay(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '')
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '-'
}

/** What a person types, '01/10/2026', as the API's '2026-10-01', or null when it is not a real date. */
export function parseDay(text) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text ?? '').trim())
  if (!match) return null
  const [, day, month, year] = match
  const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  const real = check.getUTCFullYear() === Number(year) && check.getUTCMonth() === Number(month) - 1 && check.getUTCDate() === Number(day)
  return real && Number(year) >= 2000 && Number(year) <= 2100 ? `${year}-${month}-${day}` : null
}

/** While typing: digits only, with the slashes put in by themselves ('0110' becomes '01/10'), at most DD/MM/YYYY. */
export function maskDay(text) {
  const digits = String(text ?? '').replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}
