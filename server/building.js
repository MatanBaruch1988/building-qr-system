// The building's own settings: its address and its name, the two things the committee types in the committee app (table
// building_settings, one row). The public route (provider app header) and the committee routes share these functions.
import { query } from './db.js'
import { bad, str } from './http.js'
import { ADDRESS_MAX_LENGTH, BUILDING_NAME_MAX_LENGTH } from '../shared/contract.js'

// The longest address, ADDRESS_MAX_LENGTH, and the longest name, BUILDING_NAME_MAX_LENGTH (shared/contract.js: the committee
// form checks them too), are also the limits of the columns (char_length(address) <= 200, char_length(name) <= 80).
// JavaScript counts UTF-16 units, Postgres counts characters, so whatever passes here also passes the database.

// Control characters (tab, line breaks, NUL, ...) and the line and paragraph separators. A line break would split the
// header of the provider app, and NUL cannot be stored in a text column. Everything else is allowed as typed: any
// language, digits, punctuation, and the invisible direction marks that mixed Hebrew and Latin text sometimes needs.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u

/**
 * The building's two texts, as the routes answer them.
 * @typedef {object} Building
 * @property {string} address  empty means show nothing
 * @property {string} name  empty means no name
 */

/** The address from a request body, trimmed. Empty is allowed (it means "show nothing"); a missing field is not. */
export function parseAddress(value) {
  const address = str(value, { field: 'address', max: ADDRESS_MAX_LENGTH })
  if (address === undefined) throw bad('missing_field', 'address is required (it can be empty)', { field: 'address' })
  if (CONTROL.test(address)) throw bad('invalid_field', 'address must not contain control characters', { field: 'address' })
  return address
}

/**
 * The name from a request body, trimmed, or `undefined` when the request does not carry one. The field is optional: the
 * committee screens that were installed before the name existed send the address only, and a save from them must leave the
 * name alone (so `undefined` means "keep what is saved"). A name that is sent is checked like the address: text, empty is
 * allowed (it clears the name), no control characters, at most BUILDING_NAME_MAX_LENGTH characters. `null` is not text, so it is
 * refused rather than read as "not sent": clearing the name is an empty string.
 */
export function parseName(value) {
  if (value === undefined) return undefined
  const name = str(value, { field: 'name', max: BUILDING_NAME_MAX_LENGTH })
  if (name === undefined) throw bad('invalid_field', 'name must be text', { field: 'name' }) // null
  if (CONTROL.test(name)) throw bad('invalid_field', 'name must not contain control characters', { field: 'name' })
  return name
}

/**
 * The saved address and name, '' for each that is empty (also when the row is missing, which the migration prevents).
 * @returns {Promise<Building>}
 */
export async function readBuilding() {
  const { rows } = await query('select address, name from building_settings where id = 1')
  return { address: rows[0]?.address ?? '', name: rows[0]?.name ?? '' }
}

/**
 * Saves the address, the name and who saved them, with the client `c` of the transaction that also writes the audit row
 * (server/audit.js), so the change and its record commit together. The row is locked and read first, so that the caller can say
 * what the two texts were (`before`, what readBuilding would have answered) and what they are now (`after`). `name` is optional:
 * `undefined` keeps the saved name, so `after.name` is then the saved one. A save that leaves both texts as they are writes
 * nothing (not the time and not the member either: they say who CHANGED it), and answers `changed: false`, so that the caller
 * records nothing. An upsert, so a row that went missing does not turn a save into an error.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} c  the client of the transaction
 * @param {string} adminId
 * @param {{ address: string, name?: string }} next
 * @returns {Promise<{ changed: boolean, before: Building, after: Building }>}
 */
export async function saveBuilding(c, adminId, { address, name }) {
  const current = await c.query('select address, name from building_settings where id = 1 for update')
  /** @type {Building} */
  const before = { address: current.rows[0]?.address ?? '', name: current.rows[0]?.name ?? '' }
  /** @type {Building} */
  const after = { address, name: name ?? before.name }
  if (before.address === after.address && before.name === after.name) return { changed: false, before, after }
  await c.query(
    `insert into building_settings (id, address, name, updated_at, updated_by) values (1, $1, $2, now(), $3)
     on conflict (id) do update
       set address = excluded.address, name = excluded.name, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [after.address, after.name, adminId],
  )
  return { changed: true, before, after }
}
