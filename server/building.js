// The building's address: the one setting the committee types in the committee app (table building_settings, one row).
// The public route (provider app header) and the committee routes share these three functions.
import { query } from './db.js'
import { bad, str } from './http.js'
import { ADDRESS_MAX_LENGTH } from '../shared/contract.js'

// The longest address, ADDRESS_MAX_LENGTH (shared/contract.js: the committee form checks it too), is also the limit of
// the column (char_length(address) <= 200). JavaScript counts UTF-16 units, Postgres counts characters, so whatever
// passes here also passes the database.

// Control characters (tab, line breaks, NUL, ...) and the line and paragraph separators. A line break would split the
// header of the provider app, and NUL cannot be stored in a text column. Everything else is allowed as typed: any
// language, digits, punctuation, and the invisible direction marks that mixed Hebrew and Latin text sometimes needs.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u

/** The address from a request body, trimmed. Empty is allowed (it means "show nothing"); a missing field is not. */
export function parseAddress(value) {
  const address = str(value, { field: 'address', max: ADDRESS_MAX_LENGTH })
  if (address === undefined) throw bad('missing_field', 'address is required (it can be empty)', { field: 'address' })
  if (CONTROL.test(address)) throw bad('invalid_field', 'address must not contain control characters', { field: 'address' })
  return address
}

/** The saved address, or '' when there is none (also when the row is missing, which the migration prevents). */
export async function readAddress() {
  const { rows } = await query('select address from building_settings where id = 1')
  return rows[0]?.address ?? ''
}

/** Saves the address and who saved it. An upsert, so a row that went missing does not turn a save into an error. */
export async function saveAddress(adminId, address) {
  const { rows } = await query(
    `insert into building_settings (id, address, updated_at, updated_by) values (1, $1, now(), $2)
     on conflict (id) do update
       set address = excluded.address, updated_at = excluded.updated_at, updated_by = excluded.updated_by
     returning address`,
    [address, adminId],
  )
  return rows[0].address
}
