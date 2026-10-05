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

/**
 * Saves the address and who saved it, with the client `c` of the transaction that also writes the audit row (server/audit.js),
 * so the change and its record commit together. The row is locked and read first, so that the caller can say what the address
 * was (`before`, what readAddress would have answered) when it changed it. An address that is the one already saved writes
 * nothing (not the time and not the member either: they say who CHANGED it), and answers `changed: false`, so that the caller
 * records nothing. An upsert, so a row that went missing does not turn a save into an error.
 * @returns {Promise<{ changed: boolean, before: string }>}
 */
export async function saveAddress(c, adminId, address) {
  const current = await c.query('select address from building_settings where id = 1 for update')
  const before = current.rows[0]?.address ?? ''
  if (before === address) return { changed: false, before }
  await c.query(
    `insert into building_settings (id, address, updated_at, updated_by) values (1, $1, now(), $2)
     on conflict (id) do update
       set address = excluded.address, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [address, adminId],
  )
  return { changed: true, before }
}
