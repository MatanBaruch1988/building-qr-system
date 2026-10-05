// The one way to write a row of the audit log (table audit_log: who did what, append-only since migration 007).
//
// A change that the committee makes and the row that records it are ONE transaction: the route opens `tx()` (server/db.js),
// makes its change(s) with the client of that transaction and then calls `audit(c, ...)` with the same client. They commit
// together or not at all, so there is never a change without its row and never a row without its change. This is why `audit`
// takes the client and nothing else: it does not look for a connection of its own, so it cannot end up in another transaction
// (the module's `query()` runs one statement in a transaction of its own and, inside `tx()`, takes a second connection from
// a pool of three), and a caller that has no client to give is a bug that fails the first time it runs, not a row that
// is written late.
//
//   const row = await tx(async (c) => {
//     const r = await c.query('update points set ... where id = $1 returning ...', [...])
//     if (!r.rows.length) throw notFound('point_not_found', 'Point not found')
//     await audit(c, adminActor(admin), 'point.update', { entity: 'point', entityId: id, detail })
//     return r.rows[0]
//   })
//
// Slow or outside work (a password hash, a call to Google, the validation of the body) happens before the transaction, and
// the reads that only build the answer happen after the commit, so the transaction holds its locks for as short a time as
// it can.
//
// The detail of each action. `detail` is a JSON object, or null. Every id is a uuid as text, and an id in a detail is never the
// only way to tell what happened: a name or an e-mail is there only where it was before this table was read by a screen
// (docs/privacy.md). A change that changes nothing writes no row at all (the route still answers as it always did). An update
// writes `changes`: one key for each field whose value really changed, each `{ from, to }` (null is an empty value), read inside
// the transaction under the row's lock, so `from` is what the row held when the change was made. Only the changed fields are
// there, and a field that holds a secret is never a key (changesOf refuses it): a password is `password_changed: true`.
//
//   action                    entity    entity_id   detail
//   admin.add                 admin     member      { email }                                    a new member
//   admin.enable              admin     member      { email, changes: { is_active } }            POST of the e-mail of a switched-off member
//                                                   { changes: { is_active } }                   PATCH is_active: true
//   admin.disable             admin     member      { changes: { is_active } }                   is_active goes from true to false
//   admin.delete              admin     member      { email, name }                              what the member was
//   session.sign_in           admin     member      { method }                                   `google`, or `dev` (the local shortcut); the member is the actor
//   session.sign_out          admin     member      null                                         ended by the member who owned the session (the actor)
//   building.update           building  (null)      { changes: { address } }
//   point.create              point     point       { name, description?, service_type?, gps_mode?, lat?, lng?, radius_m?, is_active?,
//                                                     provider_ids }   the fields that were sent, and the providers who may scan
//                                                                      there (a list of ids: the real ones, never the demo account)
//   point.update              point     point       { changes?: { name, description, service_type, gps_mode, lat, lng, radius_m,
//                                                                 is_active }, provider_ids?: { added, removed } }
//                                                   the coordinates are the point's own place, never a person's position;
//                                                   provider_ids is there only when the list changed, and holds real ids (the demo
//                                                   account is dropped before it is compared); one of the two keys is always there
//   point.delete              point     point       { name, scans_kept }
//   point.regenerate_qr       point     point       null                                         the code itself is never recorded
//   provider.create           provider  provider    { company }
//   provider.update           provider  provider    { changes?: { company, contact_name, service_type, is_active, is_demo },
//                                                     password_changed?: true }                  one of the two keys is always there
//   provider.delete           provider  provider    { company, contact_name, scans_kept }
//   provider.revoke_devices   provider  provider    { devices }                                  how many phones were signed out (0 is possible)
//   scan.void                 scan      scan        { reason }                                   the reason that was typed, or null
//   scan.unvoid               scan      scan        { previous_reason }                          the reason that the restore cleared, or null
//   scan.delete               scan      scan        { point_name, provider_name, checked_in_at, outcome, voided }
//   api_key.create            api_key   key         { name }
//   api_key.revoke            api_key   key         null
//   api_key.delete            api_key   key         { name, key_prefix, was_revoked }
//   retention.run             (null)    (null)      { sessions, login_attempts, device_labels, app_errors, alert_pings }  counts only (the system actor)
//
// A sign-in and a sign-out of a committee member are recorded, a provider's are not (`provider_devices` has them). A sign-in is
// written in the transaction that opens the session; a refused one (not on the list, switched off, another Google account, too
// many attempts) writes nothing, `auth_attempts` already counts those. A sign-out is written only when a session that was not
// ended yet is ended (no cookie, an unknown token and a session that was ended already write nothing). Neither entry holds the
// address of the request, the browser, the Google account or a token.
//
// A member that the owner's command adds (`npm run db:create-admin`, scripts/create-admin.mjs) is written as `admin.add` or
// `admin.enable`, with the same detail as the committee's own routes above and the `script` actor (no id, no name: the
// command runs on the owner's machine and knows no signed-in member). A member who is on the list already writes no entry.
import pg from 'pg'
import { AUDIT_ACTOR_NAME_MAX_LENGTH } from './config.js'

/**
 * Who did it. `type` is `admin` (a committee member, built by adminActor), `system` (the daily retention job) or `script` (a
 * command run on the owner's machine). `id` is a plain text reference with no foreign key (the row must outlive the member),
 * and `name` is the snapshot of the person's name at the time, or null when there is none (the system actor is named by its
 * type).
 * @typedef {object} AuditActor
 * @property {'admin' | 'system' | 'script'} type
 * @property {string | null} id
 * @property {string | null} name
 */

/** @typedef {{ query: (text: string, params?: unknown[]) => Promise<unknown> }} TransactionClient */

const ACTOR_TYPES = ['admin', 'system', 'script']

/**
 * The actor of a committee member, from what requireAdmin returns (`{ id, email, name }`): the name is the member's name, or
 * the e-mail when there is none, cut to the limit of the column (AUDIT_ACTOR_NAME_MAX_LENGTH) by characters and not by UTF-16
 * units, so that a long name is cut and never makes the action fail, and an emoji is never split in two.
 * @param {{ id: string, name?: string | null, email?: string | null }} admin
 * @returns {AuditActor}
 */
export function adminActor(admin) {
  const name = Array.from(admin.name || admin.email || '').slice(0, AUDIT_ACTOR_NAME_MAX_LENGTH).join('')
  return { type: 'admin', id: admin.id, name: name || null }
}

/**
 * Writes one audit row with the client of the transaction that made the change.
 * @param {TransactionClient} c  the client that `tx()` passes to its function. Required: a missing client, a value that cannot
 *   run a query and the pool itself (which would run the insert in another transaction) are programming errors and throw.
 * @param {AuditActor} actor
 * @param {string} action  what was done, `entity.verb` (`point.update`)
 * @param {{ entity?: string | null, entityId?: string | null, detail?: object | null }} [what]  the kind of thing and its id (a
 *   plain text, no foreign key), and a JSON object with what the reader needs to understand the entry. Counts and the fields
 *   that changed, never a secret or a token.
 */
export async function audit(c, actor, action, { entity, entityId, detail } = {}) {
  if (!c || typeof c.query !== 'function') {
    throw new TypeError('audit() needs the client of the transaction that made the change, as its first argument')
  }
  if (c instanceof pg.Pool) {
    throw new TypeError('audit() needs the client of the transaction (tx(async (c) => ...)), not the pool: the pool would write the row in another transaction')
  }
  if (!actor || !ACTOR_TYPES.includes(actor.type)) throw new TypeError(`audit() needs an actor of type ${ACTOR_TYPES.join(', ')}`)
  if (typeof action !== 'string' || !action) throw new TypeError('audit() needs the action')
  await c.query(
    'insert into audit_log (actor_type, actor_id, actor_name, action, entity, entity_id, detail) values ($1,$2,$3,$4,$5,$6,$7)',
    [actor.type, actor.id ?? null, actor.name ?? null, action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null],
  )
}

// A key that names a secret never goes into `changes`, whatever the caller passes: a hash, a token, a password or a key.
const SECRET_FIELD = /hash|token|password|secret|key/i

/**
 * What an update changed, for `detail.changes`: one `{ from, to }` for each field of `fields` (the validated values the route is
 * about to write) whose value differs from the one in `before` (the row, read inside the transaction before the update). An
 * empty object means the update changes nothing. A missing value and null are the same (`null`). Throws for a field that holds a
 * secret, so that a hash can never be recorded by a mistake of a route: say `password_changed: true` instead.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, { from: unknown, to: unknown }>}
 */
export function changesOf(before, fields) {
  /** @type {Record<string, { from: unknown, to: unknown }>} */
  const changes = {}
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_FIELD.test(key)) throw new TypeError(`changesOf() never records the field ${key}: it holds a secret`)
    const from = before[key] ?? null
    const to = value ?? null
    if (from !== to) changes[key] = { from, to }
  }
  return changes
}

/**
 * What a list of ids gained and lost, sorted so that the entry does not depend on the order of a query.
 * @param {string[]} before
 * @param {string[]} after
 * @returns {{ added: string[], removed: string[] }}
 */
export function idsChanged(before, after) {
  return {
    added: after.filter((id) => !before.includes(id)).sort(),
    removed: before.filter((id) => !after.includes(id)).sort(),
  }
}
