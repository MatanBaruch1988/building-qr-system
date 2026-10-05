// Adds (or re-enables) a committee member. They sign in with the Google account of this e-mail.
// Usage: npm run db:create-admin -- <google-email> [name]
// There is no password: the very first admin has to be added here, the rest from the admin screen.
// It writes to the database in DATABASE_URL (from the shell, else .env.local, which points at the non-production
// database), so for the first member of a deployment give it that deployment's connection string for this one command
// (see README). It prints which database it is about to write to, and names it again when it is done.
//
// The member and the audit row that records it (`admin.add` for a new member, `admin.enable` for one who was switched off, with
// the actor `script`: server/audit.js) are written in ONE transaction, so there is never a member that the log does not
// know about. A member who is on the list and active already is left alone and writes no row. The core is the exported
// `addCommitteeMember`, which tests/create-admin.test.js runs against a throwaway schema; the command line below it only runs
// when this file is the one that node was started with, so that importing it runs nothing.
import { loadEnv } from '../server/loadEnv.js'
import { audit, changesOf } from '../server/audit.js'
import { isMain } from './ci-git.mjs'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Who the audit log names for what this command writes: the command itself, run on the owner's machine (no member is signed in). */
const SCRIPT_ACTOR = Object.freeze({ type: /** @type {const} */ ('script'), id: null, name: null })

/**
 * Adds the committee member with this e-mail, or switches them back on, and writes the audit row in the same transaction.
 *  - A new e-mail is inserted (`admin.add`, detail `{ email }`).
 *  - The e-mail of a member who was switched off switches them back on (`admin.enable`, detail `{ email, changes: { is_active } }`).
 *    The name that was given is ignored, as it always was.
 *  - The e-mail of a member who is on the list and active changes nothing and writes no row.
 * The same three cases and the same details as POST /admin/admins (server/routes/admin.js), with the script actor.
 * @param {(fn: (c: any) => Promise<any>) => Promise<any>} run  `tx` of server/db.js (a function that runs `fn(client)` in one
 *   transaction): passed in so that the command can read the environment before it loads the database module.
 * @param {string} email  any case; it is stored in lower case
 * @param {string} [name]
 * @returns {Promise<{ outcome: 'added' | 'enabled' | 'unchanged', member: { id: string, email: string, name: string, is_active: boolean } }>}
 */
export async function addCommitteeMember(run, email, name = '') {
  const address = email.trim().toLowerCase()
  return run(async (c) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await c.query(
        `insert into admins (email, name) values ($1, $2)
         on conflict (email) do nothing returning id, email, name, is_active`,
        [address, name],
      )
      if (inserted.rows.length) {
        const member = inserted.rows[0]
        await audit(c, SCRIPT_ACTOR, 'admin.add', { entity: 'admin', entityId: member.id, detail: { email: address } })
        return { outcome: 'added', member }
      }
      // On the list already: lock the row before reading it, so that the entry says what it really was.
      const found = await c.query('select id, email, name, is_active from admins where email = $1 for update', [address])
      if (!found.rows.length) continue // removed at the very moment between the two statements: try the insert again
      const current = found.rows[0]
      if (current.is_active) return { outcome: 'unchanged', member: current }
      const enabled = await c.query('update admins set is_active = true where id = $1 returning id, email, name, is_active', [current.id])
      await audit(c, SCRIPT_ACTOR, 'admin.enable', {
        entity: 'admin',
        entityId: current.id,
        detail: { email: address, changes: changesOf(current, { is_active: true }) },
      })
      return { outcome: 'enabled', member: enabled.rows[0] }
    }
    throw new Error('The committee list changed at the same moment, try again')
  })
}

if (isMain(import.meta.url)) {
  loadEnv()

  const [email, name = ''] = process.argv.slice(2)
  if (!email || !EMAIL_PATTERN.test(email)) {
    console.error('Usage: npm run db:create-admin -- <google-email> [name]')
    process.exit(1)
  }

  const { getPool, tx } = await import('../server/db.js')
  const { readEnvironmentMarker, maskDatabaseHost } = await import('../server/dbGuard.js')

  try {
    // Say where the row goes before writing it: the URL is the one the pool will use, and only its masked host is shown.
    const marker = await readEnvironmentMarker(getPool())
    const host = maskDatabaseHost(getPool().options.connectionString)
    const where = marker ? `the ${marker} database at ${host}` : `the database at ${host} (not marked)`
    console.log(`Writing to ${where}`)

    const { member } = await addCommitteeMember(tx, email, name)
    console.log(`Committee member ready: ${member.email} (signs in with Google) in ${where}`)
  } finally {
    await getPool().end()
  }
}
