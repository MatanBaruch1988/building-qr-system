// What an entry of the audit log says, for the screen (src/admin/views/AuditView.jsx): who, what, about what, and a short line
// of detail. Pure functions: they take an entry as GET /api/admin/audit gives it (`AuditEntry` in shared/types.js) and return
// plain data, and the view draws that data as React text. Nothing here is ever HTML.
//
// The detail is read by KNOWN KEYS only (the table at the top of server/audit.js): a key that is not named here is never shown,
// whatever it holds, so a field that a later change adds to a detail stays out of the screen until it is added here. A string
// that looks like a key, a hash or a token is left out too (looksSecret), even under a key that is known. Details written
// before #78 have the older shapes (the fields that were sent, flat, instead of `changes`; `provider_ids` as a list instead
// of `{ added, removed }`), so both are read.
import { formatDay, formatDateTime } from '../../shared/datetime.js'
import { serviceLabel } from './hooks.js'
import {
  ACTION_LABELS, FIELD_LABELS, GPS_MODE_LABELS, METHOD_LABELS, RETENTION_LABELS, SYSTEM_ACTOR, SCRIPT_ACTOR, UNKNOWN_ACTOR,
  DELETED_ACTOR_MARK, EMPTY_VALUE, YES, NO,
} from './auditLabels.js'

/** @typedef {{ kind: 'text', text: string }} TextLine */
/** @typedef {{ kind: 'field', label: string, value: string }} FieldLine */
/** @typedef {{ kind: 'change', label: string, from: string, to: string }} ChangeLine */
/** @typedef {TextLine | FieldLine | ChangeLine} DetailLine */

const VALUE_MAX = 80 // characters of one value on the screen: a long description is cut, never the layout
const UNKNOWN_ACTION = 'פעולה לא מוכרת'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const has = (object, key) => Object.hasOwn(object, key)
const isCount = (value) => Number.isInteger(value) && value >= 0
const clip = (text) => {
  const chars = Array.from(text)
  return chars.length > VALUE_MAX ? `${chars.slice(0, VALUE_MAX - 1).join('')}…` : text
}

// The shapes of a secret. `prefix_body` is how every key and token of this app starts (a short word, an underscore, the
// rest); a long run of letters and digits with no space is a hash, a token or an id. Neither is a thing that the committee
// has any use for on a screen, so neither is shown, whatever key it was found under.
const PREFIXED_TOKEN = /^[a-z]{2,5}_[A-Za-z0-9_-]{6,}$/i
const LONG_RUN = /^[A-Za-z0-9+/_=.-]{24,}$/

/**
 * True for a text that looks like a key, a hash, a token or an id: `abc_def123456`, or 24 or more characters of letters,
 * digits and `+/_=.-` with no space and at least one digit and one letter.
 * @param {unknown} value
 */
export function looksSecret(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return PREFIXED_TOKEN.test(text) || (LONG_RUN.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text))
}

/** A day or a moment that the API writes (ISO 8601) as DD/MM/YYYY or DD/MM/YYYY HH:MM, through the one shared module; else null. */
function dateText(text) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const day = formatDay(text)
    return day === '-' ? null : day
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const moment = formatDateTime(text)
    return moment === '-' ? null : moment
  }
  return null
}

/**
 * One value of a field, as a person reads it: no value is "ריק", a boolean is yes or no, a date is DD/MM/YYYY, a name of a
 * kind is its Hebrew word. Null when the value is not something that can be shown (an object, a secret).
 * @param {string} field
 * @param {unknown} value
 * @returns {string | null}
 */
function valueText(field, value) {
  if (value === null || value === undefined || value === '') return EMPTY_VALUE
  if (typeof value === 'boolean') return value ? YES : NO
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value !== 'string' || looksSecret(value)) return null
  if (field === 'gps_mode' && has(GPS_MODE_LABELS, value)) return GPS_MODE_LABELS[value]
  if (field === 'service_type') return clip(serviceLabel(value))
  return clip(dateText(value) ?? value)
}

/** A text from the detail that can be shown as it is (not empty, not a secret), or null. */
const plain = (value) => (typeof value === 'string' && value.trim() && !looksSecret(value) ? clip(value.trim()) : null)

/**
 * What the entry is about, from the name that the detail kept, for a thing that is gone (a delete): the API's own
 * `entity_name` is the current name and wins. A provider is "Company – Contact", as the committee's history names one.
 * @param {string | null | undefined} entity
 * @param {Record<string, unknown>} detail
 */
function keptName(entity, detail) {
  if (entity === 'provider') {
    const company = plain(detail.company)
    const contact = plain(detail.contact_name)
    return company && contact ? `${company} – ${contact}` : company
  }
  if (entity === 'scan') return plain(detail.point_name)
  if (entity === 'admin') return plain(detail.name) ?? plain(detail.email)
  return plain(detail.name) ?? plain(detail.company) ?? plain(detail.point_name)
}

/** "no one", "one", or a number, in the words of the given forms. */
const count = (n, none, one, many) => (n === 0 ? none : n === 1 ? one : many(n))
const size = (value) => (Array.isArray(value) ? value.length : 0)

/**
 * The lines of detail of one entry, from the known keys.
 * @param {{ action?: string, entity?: string | null }} entry
 * @param {Record<string, unknown>} detail
 * @param {string | null} subject  what the entry is about, so that a line does not say it again
 * @returns {DetailLine[]}
 */
function detailLines(entry, detail, subject) {
  /** @type {DetailLine[]} */
  const lines = []
  const field = (label, value) => lines.push({ kind: 'field', label, value })
  const text = (value) => lines.push({ kind: 'text', text: value })
  const repeatsSubject = (value) => Boolean(subject) && typeof value === 'string' && subject.includes(value)

  // An update: each field that changed, from what it was to what it is now.
  const changes = isObject(detail.changes) ? detail.changes : {}
  const handled = new Set()
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    if (!has(changes, key) || !isObject(changes[key])) continue
    handled.add(key)
    const from = valueText(key, changes[key].from)
    const to = valueText(key, changes[key].to)
    if (from !== null && to !== null) lines.push({ kind: 'change', label, from, to })
  }
  // The older shape, and a create: the fields that were set, flat. A name that the subject says already is not said twice.
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    if (handled.has(key) || !has(detail, key)) continue
    const raw = detail[key]
    if (raw === null || raw === undefined || raw === '' || isObject(raw) || Array.isArray(raw)) continue
    if ((key === 'name' || key === 'company' || key === 'contact_name') && repeatsSubject(raw)) continue
    const value = valueText(key, raw)
    if (value !== null) field(label, value)
  }

  if (detail.password_changed === true) text('הסיסמה הוחלפה')

  // The providers who may scan at a point: the whole list (a create, the older update) or what the update added and removed.
  if (Array.isArray(detail.provider_ids)) {
    text(count(detail.provider_ids.length, 'אין נותני שירות מורשים', 'נותן שירות מורשה אחד', (n) => `${n} נותני שירות מורשים`))
  } else if (isObject(detail.provider_ids)) {
    const added = size(detail.provider_ids.added)
    const removed = size(detail.provider_ids.removed)
    if (added) text(count(added, '', 'נוסף נותן שירות אחד לנקודה', (n) => `נוספו ${n} נותני שירות לנקודה`))
    if (removed) text(count(removed, '', 'הוסר נותן שירות אחד מהנקודה', (n) => `הוסרו ${n} נותני שירות מהנקודה`))
  }

  const reason = plain(detail.reason)
  if (reason) field('סיבה', reason)
  const previous = plain(detail.previous_reason)
  if (previous) field('הסיבה לביטול', previous)

  const devices = detail.devices
  if (isCount(devices)) text(count(devices, 'אף מכשיר לא היה מחובר', 'נותק מכשיר אחד', (n) => `נותקו ${n} מכשירים`))
  if (isCount(detail.scans_kept)) field('נוכחויות שנשארו בהיסטוריה', String(detail.scans_kept))
  if (typeof detail.method === 'string' && has(METHOD_LABELS, detail.method)) text(METHOD_LABELS[detail.method])

  const email = plain(detail.email)
  if (email && email.includes('@') && !repeatsSubject(email)) field('אימייל', email)

  if (entry.entity === 'scan') {
    const provider = plain(detail.provider_name)
    if (provider) field('נותן שירות', provider)
    const when = typeof detail.checked_in_at === 'string' ? dateText(detail.checked_in_at) : null
    if (when) field('זמן הנוכחות', when)
    if (detail.voided === true) text('הנוכחות הייתה מבוטלת')
  }
  if (entry.action === 'retention.run') {
    for (const [key, label] of Object.entries(RETENTION_LABELS)) {
      if (isCount(detail[key])) field(label, String(detail[key]))
    }
  }
  return lines
}

/**
 * The entry as the screen draws it.
 * @param {import('../../shared/types.js').AuditEntry} entry
 * @returns {{
 *   phrase: { text: string, known: boolean },
 *   subject: string | null,
 *   actor: { name: string, deleted: boolean },
 *   lines: DetailLine[],
 * }}
 */
export function describeEntry(entry) {
  const detail = isObject(entry.detail) ? entry.detail : {}
  const action = typeof entry.action === 'string' ? entry.action : ''
  const known = has(ACTION_LABELS, action)
  // An action that is not known is shown by its own name, in a neutral way, unless that name looks like a secret.
  const phrase = known
    ? { text: ACTION_LABELS[action], known: true }
    : { text: action && !looksSecret(action) ? clip(action) : UNKNOWN_ACTION, known: false }

  // A sign-in is about the member who signs in, who is the actor already, so it names no subject.
  const named = typeof entry.entity_name === 'string' && entry.entity_name.trim() ? clip(entry.entity_name.trim()) : null
  const subject = action.startsWith('session.') ? null : named ?? keptName(entry.entity, detail)

  let actor
  if (entry.actor_type === 'system') actor = { name: SYSTEM_ACTOR, deleted: false }
  else if (entry.actor_type === 'script') actor = { name: SCRIPT_ACTOR, deleted: false }
  else actor = { name: typeof entry.actor_name === 'string' && entry.actor_name.trim() ? entry.actor_name.trim() : UNKNOWN_ACTOR, deleted: entry.actor_deleted === true }

  return { phrase, subject, actor, lines: detailLines(entry, detail, subject) }
}

/** The actor as one text: the name, and "(נמחק)" after a member who is no longer on the committee. */
export const actorText = (actor) => (actor.deleted ? `${actor.name} ${DELETED_ACTOR_MARK}` : actor.name)
