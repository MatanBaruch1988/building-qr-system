// The first committee member of a deployment, added by the first Google sign-in (AGENTS.md, Safety and Code Review Rules).
//
// A new installation has an empty `admins` table, so nobody can sign in. The deployer can say who the first member is in the
// environment variable `FIRST_ADMIN_EMAIL` of the deployment (Vercel, Production), instead of running `npm run db:create-admin`
// with the connection string of production. It is one address, and it is personal data and not a secret: it is read here, on the
// server, from `process.env` and from nowhere else, and its value is never logged, never returned and never written anywhere but
// the new member's row and the `detail` of its audit row (where the e-mail of an added member always is).
//
// `POST /admin/google` (server/routes/admin.js) calls `firstCommitteeMember` inside the transaction of the sign-in, after Google
// has verified the token (the verifier refuses an e-mail that Google has not marked verified, so `google.email` is a verified
// address here) and only when the lookup of an active member by that e-mail found nobody. The steps, in this order, and a refusal
// at any of them is the refusal that the route always gave (403 `not_an_admin`), so a stranger learns nothing:
//   (a) the variable is read now (not when the module loads), trimmed and in lower case; unset, empty or not shaped like an
//       e-mail address is a refusal;
//   (b) it must be exactly equal to the verified Google e-mail, which is trimmed and lowered the same way; anything else is a refusal;
//   (c) `lock table admins in share row exclusive mode`. That mode conflicts with itself and with ROW EXCLUSIVE (every insert, update
//       and delete of `admins`), so two first sign-ins, and a `create-admin` running at the same moment, wait for each other and
//       none can write to the table while this transaction decides. It does not conflict with ROW SHARE, which is what the
//       `select ... for update` of the route took before (see "No deadlock" below);
//   (d) the e-mail is looked up again, now that nobody else can write: when it exists and is active, a parallel sign-in created
//       it, and the route goes on with its normal path with that member (so the second of two parallel first sign-ins just signs in);
//   (e) when `admins` holds ANY row, active or not, this is not a first sign-in: a refusal. The variable never adds a second
//       member, never brings back a member who was switched off and never works again once the committee has a row;
//   (f) the member is inserted with the e-mail, the name that Google gave and the Google account (`google_sub`), and `admin.add`
//       is written by the actor `system` (no id and no name: nobody is signed in yet), in the same transaction. The route then
//       opens the session as for any member, which writes `session.sign_in`. A failure of any statement, the audit row included,
//       rolls back the member with the session: the answer is 500, nothing is left and the next try starts again.
//
// No deadlock. A deadlock needs a cycle of waits, and there is none on the way that a first sign-in takes:
//  - The earlier `select * from admins where email = $1 and is_active for update` of the route takes the table lock ROW SHARE, and
//    SHARE ROW EXCLUSIVE does not conflict with ROW SHARE (only EXCLUSIVE and ACCESS EXCLUSIVE do), and a transaction never waits
//    for its own locks. Two first sign-ins both hold ROW SHARE and both ask for SHARE ROW EXCLUSIVE: the first gets it, the
//    second waits for the first to end, and the first waits for nobody (the second holds only ROW SHARE, which does not stop it).
//  - A transaction that reaches this function holds no row lock of `admins`: the select above found no active member, so it
//    locked no row. Nobody can wait for this transaction on a row while this one waits for the table.
//  - After the table lock, this transaction writes a new row of `admins` and updates it (the route's own `update`), writes rows of
//    `audit_log` and a row of `admin_sessions` (a session of that new row, which nobody else can see before the commit), and reads.
//    The throttle of the login (guardLogin) has a transaction of its own that has ended before the sign-in starts, and
//    `attempt.success()` runs after the commit, so neither holds a lock while this transaction waits.
//  - `create-admin` and the committee's own routes ask for ROW EXCLUSIVE, so they wait here, and they hold nothing that this
//    transaction needs: a committee route that locks a member's row cannot run, because the list is empty or has only the member
//    that a first sign-in just added (and a member can neither remove nor switch off himself).
// The one cycle that is left is a THIRD sign-in of the very same, just created member that starts between the commit of the first
// and the end of the second: it locks the member's row (a normal sign-in does, before it writes) and then waits for the table
// lock that the second holds, while the second needs that row at (d) or at its `update`. Postgres detects that cycle and ends one
// of the two with a deadlock error: that request answers the usual 500, nothing is written for it, and a retry works. It needs three
// sign-ins of one account within milliseconds of each other at the very first sign-in of a deployment, and it cannot leave a
// half-added member.
import { audit } from './audit.js'
import { EMAIL_MAX_LENGTH } from '../shared/contract.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Who the audit log names for the first member: the system, because nobody is signed in yet (no id, no name). */
const SYSTEM_ACTOR = Object.freeze({ type: /** @type {const} */ ('system'), id: null, name: null })

/** The lookup of the route (an active member, locked), so that a member created by a parallel sign-in is found the same way. */
const ACTIVE_MEMBER_BY_EMAIL = 'select * from admins where email = $1 and is_active for update'

/** An address the way it is compared: trimmed and in lower case. Anything that is not text is an empty address. */
const normalized = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

/**
 * The address that `FIRST_ADMIN_EMAIL` names, trimmed and in lower case, or null when the variable is unset, empty or not shaped like
 * an e-mail address (also when it is longer than a committee member's e-mail may be). Read at call time, so a change of the
 * variable takes effect with the next sign-in and a test can set it.
 * @returns {string | null}
 */
function wantedAddress() {
  const address = normalized(process.env.FIRST_ADMIN_EMAIL)
  if (!address || address.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(address)) return null
  return address
}

/**
 * The first committee member of a deployment, for the sign-in `google` (what verifyGoogleCredential returned: the verified e-mail,
 * the name and the Google account), with the client `c` of the transaction of that sign-in. See the steps at the top of this file.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<any> }} c
 *   the client that `tx()` passes: everything here is written in that transaction, and nowhere else
 * @param {{ email: string, name: string, sub: string }} google
 * @returns {Promise<any | null>} the row of the member who may sign in (the one just added, or the one that a parallel first
 *   sign-in added), or null when the address may not be added: the route refuses as it always did
 */
export async function firstCommitteeMember(c, google) {
  const wanted = wantedAddress() // (a)
  if (!wanted || wanted !== normalized(google.email)) return null // (b)
  await c.query('lock table admins in share row exclusive mode') // (c)
  const created = await c.query(ACTIVE_MEMBER_BY_EMAIL, [wanted]) // (d)
  if (created.rows.length) return created.rows[0]
  const any = await c.query('select 1 from admins limit 1') // (e)
  if (any.rows.length) return null
  const inserted = await c.query(
    'insert into admins (email, name, google_sub) values ($1, $2, $3) returning *',
    [wanted, google.name, google.sub],
  ) // (f)
  const member = inserted.rows[0]
  await audit(c, SYSTEM_ACTOR, 'admin.add', { entity: 'admin', entityId: member.id, detail: { email: wanted } })
  return member
}
