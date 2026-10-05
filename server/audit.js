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
