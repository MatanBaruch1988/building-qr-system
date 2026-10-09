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
// The committee's agent reads this log too, and sees a detail only through AUDIT_DETAIL_ALLOW (below the imports): a new action, or a
// new key of a detail, is not shown to the agent until it has its place in that list (tests/agent-audit.test.js fails until it has).
//
//   action                    entity    entity_id   detail
//   admin.add                 admin     member      { email }                                    a new member; the first one of a deployment can also be
//                                                                                                  added by the `system` actor (FIRST_ADMIN_EMAIL, below)
//   admin.enable              admin     member      { email, changes: { is_active } }            POST of the e-mail of a switched-off member
//                                                   { changes: { is_active } }                   PATCH is_active: true
//   admin.disable             admin     member      { changes: { is_active } }                   is_active goes from true to false
//   admin.delete              admin     member      { email, name }                              what the member was
//   session.sign_in           admin     member      { method }                                   `google`, or `dev` (the local shortcut); the member is the actor
//   session.sign_out          admin     member      null                                         ended by the member who owned the session (the actor)
//   building.update           building  (null)      { changes: { address, name } }               only the field(s) that changed: a save of the address alone
//                                                                                                  (a screen from before the name existed) leaves the name out
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
//   retention.run             (null)    (null)      { sessions, login_attempts, device_labels, app_errors, alert_pings, api_key_usage }  counts only (the system actor)
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
//
// The first member of a deployment can also be added by the first Google sign-in, when the deployer set FIRST_ADMIN_EMAIL
// (server/firstAdmin.js): `admin.add` with the same detail (`{ email }`) and the `system` actor (no id, no name: nobody is signed in
// yet), written in the transaction of that sign-in, just before the `session.sign_in` of the same member. It happens only while
// `admins` has no row at all, so that member is the first one of the deployment's committee list.
import pg from 'pg'
import { AUDIT_ACTOR_NAME_MAX_LENGTH } from './config.js'
import { GPS_MODES, SCAN_OUTCOMES } from '../shared/contract.js'

/**
 * Who did it. `type` is `admin` (a committee member, built by adminActor), `system` (the daily retention job, and the first
 * member that FIRST_ADMIN_EMAIL adds) or `script` (a command run on the owner's machine). `id` is a plain text reference with no
 * foreign key (the row must outlive the member), and `name` is the snapshot of the person's name at the time, or null when there
 * is none (the system actor is named by its type).
 * @typedef {object} AuditActor
 * @property {'admin' | 'system' | 'script'} type
 * @property {string | null} id
 * @property {string | null} name
 */

/** @typedef {{ query: (text: string, params?: unknown[]) => Promise<unknown> }} TransactionClient */

const ACTOR_TYPES = ['admin', 'system', 'script']

/** The kinds of actor that an entry can name (the values of `actor_type`), for the readers of the log. */
export const AUDIT_ACTOR_TYPES = Object.freeze([...ACTOR_TYPES])

// ---------- what of a detail may leave the server for the committee's agent ----------
//
// The committee's agent reads the audit log (GET /api/agent/v1/audit, owner decision of 08/10/2026: the agent is the committee's
// analyst), and a detail goes out only through the list below: for each action, the keys of its detail that the agent may be shown,
// each with the KIND of value that the key holds. A key that is not here is never shown, whatever it holds (the first characters of
// a key in `api_key.delete`, for one, and any key that a later change adds to a detail). An action that is not here shows no
// detail at all, so a new action leaks nothing by default; tests/agent-audit.test.js fails until every action that the code writes
// has its entry, and until the table at the top of this file and this list name the same actions. A value that is not of its kind
// (a number where a text should be) is shown as null, and so is a text that looks like a secret (shared/secretLike.js). The reading
// is `agentAuditDetail` in server/auditRead.js, and `GET /api/agent/v1/schema` and the OpenAPI document are written from this list.
//
// The kinds are: 'text', 'count' (a whole number, 0 or more), 'integer', 'number', 'boolean', 'timestamp' (an ISO 8601 moment),
// 'uuids' (a list of ids), `oneOf(values)`, `changes(fields)` (what an update changed: `{ <field>: { from, to } }` for the fields
// listed, each value of the kind given) and 'ids_change' (`{ added, removed }`, two lists of ids). 'ids_or_change' is the list of
// ids of an older entry or the `{ added, removed }` of today's.
//
// The fields of a point and of a provider are listed once and used for a create, for `changes` and for the flat shape of the
// entries written before 05/10/2026 (#78), which the committee's screen still reads.

/** A value that is one of the listed words. @param {readonly string[]} values */
const oneOf = (values) => Object.freeze({ kind: 'enum', values: Object.freeze([...values]) })
/** What an update changed: the listed fields, each as `{ from, to }`. @param {Record<string, unknown>} fields */
const changes = (fields) => Object.freeze({ kind: 'changes', fields: Object.freeze({ ...fields }) })

/** How a committee member signed in (`session.sign_in`): through Google, or the local development shortcut. */
export const AUDIT_SIGN_IN_METHODS = Object.freeze(['google', 'dev'])

const POINT_FIELDS = Object.freeze({
  name: 'text', description: 'text', service_type: 'text', gps_mode: oneOf(GPS_MODES), lat: 'number', lng: 'number',
  radius_m: 'integer', is_active: 'boolean',
})
const PROVIDER_FIELDS = Object.freeze({
  company: 'text', contact_name: 'text', service_type: 'text', is_active: 'boolean', is_demo: 'boolean',
})

/**
 * The detail of each action that the agent may be shown: `{ <action>: { <key>: <kind> } }`. An empty entry is an action whose
 * detail is null (or that has nothing to show). See the comment above for the kinds.
 */
export const AUDIT_DETAIL_ALLOW = Object.freeze({
  'admin.add': Object.freeze({ email: 'text' }),
  'admin.enable': Object.freeze({ email: 'text', changes: changes({ is_active: 'boolean' }) }),
  'admin.disable': Object.freeze({ changes: changes({ is_active: 'boolean' }) }),
  'admin.delete': Object.freeze({ email: 'text', name: 'text' }),
  'session.sign_in': Object.freeze({ method: oneOf(AUDIT_SIGN_IN_METHODS) }),
  'session.sign_out': Object.freeze({}),
  'building.update': Object.freeze({ changes: changes({ address: 'text', name: 'text' }) }),
  'point.create': Object.freeze({ ...POINT_FIELDS, provider_ids: 'uuids' }),
  'point.update': Object.freeze({ ...POINT_FIELDS, changes: changes(POINT_FIELDS), provider_ids: 'ids_or_change' }),
  'point.delete': Object.freeze({ name: 'text', scans_kept: 'count' }),
  'point.regenerate_qr': Object.freeze({}),
  'provider.create': Object.freeze({ company: 'text' }),
  'provider.update': Object.freeze({ ...PROVIDER_FIELDS, changes: changes(PROVIDER_FIELDS), password_changed: 'boolean' }),
  'provider.delete': Object.freeze({ company: 'text', contact_name: 'text', scans_kept: 'count' }),
  'provider.revoke_devices': Object.freeze({ devices: 'count' }),
  'scan.void': Object.freeze({ reason: 'text' }),
  'scan.unvoid': Object.freeze({ previous_reason: 'text' }),
  'scan.delete': Object.freeze({
    point_name: 'text', provider_name: 'text', checked_in_at: 'timestamp', outcome: oneOf(SCAN_OUTCOMES), voided: 'boolean',
  }),
  'api_key.create': Object.freeze({ name: 'text' }),
  'api_key.revoke': Object.freeze({}),
  'api_key.delete': Object.freeze({ name: 'text', was_revoked: 'boolean' }), // not `key_prefix`: the first characters of a key
  'retention.run': Object.freeze({
    sessions: 'count', login_attempts: 'count', device_labels: 'count', app_errors: 'count', alert_pings: 'count', api_key_usage: 'count',
  }),
})

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
