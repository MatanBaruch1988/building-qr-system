import { randomBytes } from 'node:crypto'
import { route } from '../router.js'
import { query, tx } from '../db.js'
import { hashPassword, randomToken, sha256 } from '../crypto.js'
import {
  ApiError, bad, conflict, forbidden, notFound, requireUuid, isUuid, str, num, toCsv, cookieHeader, getCookie, clientIp,
} from '../http.js'
import { requireAdmin, isAdminToken, guardLogin } from '../auth.js'
import { verifyGoogleCredential } from '../google.js'
import { firstCommitteeMember } from '../firstAdmin.js'
import { readBuilding, saveBuilding, parseAddress, parseName } from '../building.js'
import { listScans, listAllScans, scanJson, COMMITTEE_CSV_COLUMNS, committeeCsvRow } from '../scans.js'
import { audit, adminActor, changesOf, idsChanged } from '../audit.js'
import { commit } from '../health.js'
import { ADMIN_COOKIE, ADMIN_SESSION_DAYS, ADMIN_TOKEN_PREFIX, API_KEY_PREFIX } from '../config.js'
import {
  GPS_MODES, GPS_MODE_REQUIRED, DEFAULT_GPS_MODE,
  POINT_RADIUS_MIN_M, POINT_RADIUS_MAX_M,
  PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH,
  NAME_MAX_LENGTH, DESCRIPTION_MAX_LENGTH, SERVICE_TYPE_MAX_LENGTH, VOID_REASON_MAX_LENGTH, KEY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH, QR_TOKEN_PREFIX,
} from '../../shared/contract.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isSecure = (req) => !!process.env.VERCEL || String(req.headers['x-forwarded-proto'] || '').includes('https')

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '')
  const proto = req.headers['x-forwarded-proto'] || 'http'
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`
}

// Every change that the committee makes is one transaction that holds the change and its audit row (`tx`, then `audit(c,
// adminActor(admin), ...)` with the client of that transaction: server/audit.js), so there is no change without its row and no
// row without its change. Slow or outside work (a password hash, a call to Google, the validation of the body) comes before
// the transaction, and the reads that only build the answer (POINT_SELECT, PROVIDER_SELECT) come after the commit.
//
// The row says what really happened (the detail of each action is described at the top of server/audit.js). So an update reads
// the row it changes first, under its lock and in the same transaction, and writes `changes` (the fields whose value differs,
// each `{ from, to }`: changesOf); a change that changes nothing writes nothing, not the row and not its audit entry, and the
// route answers as it always did.

/** Builds "col = $n, …" from an object of already-validated fields. */
function setClause(fields, startAt = 1) {
  const keys = Object.keys(fields)
  return {
    sql: keys.map((k, i) => `${k} = $${startAt + i}`).join(', '),
    values: keys.map((k) => fields[k]),
  }
}

function password(value, required = false) {
  const pw = str(value, { field: 'password', max: PASSWORD_MAX_LENGTH, required })
  if (pw !== undefined && pw.length < PASSWORD_MIN_LENGTH) {
    throw bad('password_too_short', `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  }
  return pw
}

// ---------- sign in / out ----------

/** Local development only: lets a developer (or an automated UI check) get an admin session without Google. */
const devLoginAllowed = () => !process.env.VERCEL && process.env.DEV_ADMIN_LOGIN === '1'

/**
 * Opens a session for a committee member with the client `c` of the transaction that looked the member up: the session row, the
 * time of the last sign-in and the audit row (`session.sign_in`) are written in that transaction, so a session never exists
 * without its entry, and an entry never says that someone signed in when nothing was opened. `member` is who signs in as the
 * committee will know them (`{ id, email, name }`, the name being the Google name on a first sign-in), and `method` is how
 * (`google`, or `dev` for the local shortcut). The entry holds the member and the method and nothing else: not the address
 * of the request, not the browser, not the Google account and never the token. Returns the token that goes into the cookie
 * (only its hash is stored).
 */
async function createAdminSession(c, member, method) {
  const token = randomToken(ADMIN_TOKEN_PREFIX)
  await c.query(
    `insert into admin_sessions (admin_id, token_hash, expires_at)
     values ($1, $2, now() + ($3 || ' days')::interval)`,
    [member.id, sha256(token), String(ADMIN_SESSION_DAYS)],
  )
  await c.query('update admins set last_login_at = now() where id = $1', [member.id])
  await audit(c, adminActor(member), 'session.sign_in', { entity: 'admin', entityId: member.id, detail: { method } })
  return token
}

/** The answer of a sign-in, once its transaction has committed: the session cookie, and who signed in. */
function adminSessionAnswer(req, res, token, adminRow) {
  res.setHeader('Set-Cookie', cookieHeader(ADMIN_COOKIE, token, {
    maxAgeSeconds: ADMIN_SESSION_DAYS * 86400,
    secure: isSecure(req),
  }))
  return { admin: { id: adminRow.id, email: adminRow.email, name: adminRow.name } }
}

// What the login screen needs to draw the Google button (the client id is public by design).
route('GET', '/admin/config', async () => ({
  google_client_id: process.env.GOOGLE_CLIENT_ID || null,
  dev_login: devLoginAllowed(),
}))

// The browser sends the ID token Google issued after "Sign in with Google".
route('POST', '/admin/google', async ({ req, res, body }) => {
  const credential = str(body.credential, { field: 'credential', max: 4000, required: true })
  const ip = clientIp(req)
  const attempt = await guardLogin({ scope: 'admin', account: ip, ip })

  const google = await verifyGoogleCredential(credential)
  // One transaction, and the order matters: the member's row is locked first (so that disabling or deleting them at the same
  // moment is seen or waited for), the Google account is compared with the one that is linked BEFORE anything is written (a
  // refused sign-in writes nothing to `admins`, not even the name), and only then are the link, the name, the session, the time
  // of the sign-in and the audit row (`session.sign_in`) written, all or none. A refused sign-in (not on the list, switched
  // off, another Google account) throws before any of that, so it writes no entry: `auth_attempts` already counts it. The
  // throttle (guardLogin above) has a transaction of its own on purpose: a refused attempt must stay counted.
  //
  // The one exception to "not on the list": a deployment whose committee list has no row at all can name its first member in
  // FIRST_ADMIN_EMAIL (server/firstAdmin.js). Only when no active member has this e-mail, and in this same transaction, it either
  // adds that member (with the `admin.add` entry of the `system` actor, before the `session.sign_in` below) and the sign-in goes on
  // with them like any other, or says no, and the refusal is the one that is given to every stranger.
  const { row, token } = await tx(async (c) => {
    const found = await c.query('select * from admins where email = $1 and is_active for update', [google.email])
    const member = found.rows[0] ?? (await firstCommitteeMember(c, google))
    if (!member) throw forbidden('not_an_admin', 'This Google account is not on the committee list')
    if (member.google_sub && member.google_sub !== google.sub) {
      throw forbidden('google_account_mismatch', 'This e-mail is linked to a different Google account')
    }
    await c.query(
      `update admins set google_sub = coalesce(google_sub, $2), name = case when name = '' then $3 else name end where id = $1`,
      [member.id, google.sub, google.name],
    )
    const who = { id: member.id, email: member.email, name: member.name || google.name }
    return { row: who, token: await createAdminSession(c, who, 'google') }
  })
  // The counters of this account are given back only after the sign-in is complete. (It runs on the pool: it must not run inside
  // the transaction above, where it would take a second connection from a pool of three.)
  await attempt.success()
  return adminSessionAnswer(req, res, token, row)
})

route('POST', '/admin/dev-login', async ({ req, res, body }) => {
  if (!devLoginAllowed()) throw new ApiError(404, 'not_found', 'Unknown endpoint')
  const email = str(body.email, { field: 'email', max: EMAIL_MAX_LENGTH, required: true }).toLowerCase()
  const { row, token } = await tx(async (c) => {
    const found = await c.query('select * from admins where email = $1 and is_active for update', [email])
    if (!found.rows.length) throw forbidden('not_an_admin', 'Not an admin')
    return { row: found.rows[0], token: await createAdminSession(c, found.rows[0], 'dev') }
  })
  return adminSessionAnswer(req, res, token, row)
})

// This route is public (server/access.js): it has no guard, so no member is known when it starts, and the cookie is the only thing
// it looks at. Whoever the session belongs to is read by the very statement that ends it (a join to `admins`), so the entry
// names the member who owned the session and nothing a caller sent. The answer is the same in every case, and so is the cookie
// that is cleared.
//  - No cookie, or a value that is not shaped like one of our session tokens: no statement at all, no entry.
//  - A token that matches no session, or a session that was ended already: the statement changes nothing and returns nothing,
//    so there is no entry, and the time at which the session was first ended is not moved.
//  - A session that is not ended: it is ended and `session.sign_out` is written, in one transaction (a failure of the entry
//    leaves the session as it was, and the caller gets the 500 and may try again).
route('POST', '/admin/logout', async ({ req, res }) => {
  const token = getCookie(req, ADMIN_COOKIE)
  // Only a cookie shaped like one of our session tokens can match a session: any other value costs no query.
  if (token && isAdminToken(token)) {
    await tx(async (c) => {
      const ended = await c.query(
        `update admin_sessions s set revoked_at = now()
           from admins a
          where s.token_hash = $1 and s.revoked_at is null and a.id = s.admin_id
      returning a.id, a.email, a.name`,
        [sha256(token)],
      )
      if (!ended.rows.length) return
      await audit(c, adminActor(ended.rows[0]), 'session.sign_out', { entity: 'admin', entityId: ended.rows[0].id })
    })
  }
  res.setHeader('Set-Cookie', cookieHeader(ADMIN_COOKIE, '', { maxAgeSeconds: 0, secure: isSecure(req) }))
  return { ok: true }
})

route('GET', '/admin/me', async ({ req }) => {
  const { admin } = await requireAdmin(req)
  return { admin }
})

// ---------- who is on the committee list ----------

route('GET', '/admin/admins', async ({ req }) => {
  await requireAdmin(req)
  const { rows } = await query('select id, email, name, is_active, last_login_at, created_at from admins order by created_at')
  return { admins: rows }
})

route('POST', '/admin/admins', async ({ req, body }) => {
  const { admin } = await requireAdmin(req)
  const email = str(body.email, { field: 'email', max: EMAIL_MAX_LENGTH, required: true }).toLowerCase()
  if (!EMAIL_RE.test(email)) throw bad('invalid_field', 'Not a valid e-mail address', { field: 'email' })
  const name = str(body.name, { field: 'name', max: NAME_MAX_LENGTH }) ?? ''
  // Three cases, one answer (201 and the member): a new e-mail is added (`admin.add`); the e-mail of a member who was switched off
  // switches them back on (`admin.enable`, with the e-mail and what changed); the e-mail of a member who is already on the list
  // changes nothing and writes no entry (the name in the request is ignored, as it always was). The row of an existing member is
  // locked before it is read, so that the entry says what it really was.
  const added = await tx(async (c) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await c.query(
        `insert into admins (email, name) values ($1, $2)
         on conflict (email) do nothing returning id, email, name, is_active`,
        [email, name],
      )
      if (inserted.rows.length) {
        await audit(c, adminActor(admin), 'admin.add', { entity: 'admin', entityId: inserted.rows[0].id, detail: { email } })
        return inserted.rows[0]
      }
      const found = await c.query('select id, email, name, is_active from admins where email = $1 for update', [email])
      if (!found.rows.length) continue // removed at the very moment between the two statements: try the insert again
      const member = found.rows[0]
      if (member.is_active) return member
      const enabled = await c.query('update admins set is_active = true where id = $1 returning id, email, name, is_active', [member.id])
      await audit(c, adminActor(admin), 'admin.enable', {
        entity: 'admin',
        entityId: member.id,
        detail: { email, changes: changesOf(member, { is_active: true }) },
      })
      return enabled.rows[0]
    }
    throw conflict('admin_list_changed', 'The committee list changed at the same moment, try again')
  })
  return { status: 201, json: { admin: added } }
})

route('PATCH', '/admin/admins/:id', async ({ req, params, body }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  if (typeof body.is_active !== 'boolean') throw bad('invalid_field', 'is_active must be true or false', { field: 'is_active' })
  if (id === admin.id && !body.is_active) throw conflict('cannot_deactivate_self', 'You cannot remove your own access')
  // The switch and the sign-out of that member's sessions are one transaction: the member's row is locked first (so a sign-in
  // at the same moment waits for the answer instead of slipping a new session in), and a failure of any step leaves the member as
  // they were, never switched off with sessions that still work.
  const member = await tx(async (c) => {
    const found = await c.query('select id, email, name, is_active from admins where id = $1 for update', [id])
    if (!found.rows.length) throw notFound('admin_not_found', 'Admin not found')
    const current = found.rows[0]
    // A member who is already in the state that was asked for changes nothing: no write, no sign-out (a member who is off has no
    // session that works: a sign-in and a session both need is_active), no entry. The answer is the same.
    if (current.is_active === body.is_active) return current
    const r = await c.query('update admins set is_active = $2 where id = $1 returning id, email, name, is_active', [id, body.is_active])
    if (!body.is_active) await c.query('update admin_sessions set revoked_at = now() where admin_id = $1 and revoked_at is null', [id])
    await audit(c, adminActor(admin), body.is_active ? 'admin.enable' : 'admin.disable', {
      entity: 'admin',
      entityId: id,
      detail: { changes: changesOf(current, { is_active: body.is_active }) },
    })
    return r.rows[0]
  })
  return { admin: member }
})

// Deleting a committee member takes them off the list for good (their sessions go with them). You cannot delete
// yourself, which also means the list is never left without someone who can sign in. To keep the person on the list but
// shut them out for now, remove their access instead.
route('DELETE', '/admin/admins/:id', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  if (id === admin.id) throw conflict('cannot_delete_self', 'You cannot delete yourself')
  await tx(async (c) => {
    const r = await c.query('delete from admins where id = $1 returning email, name', [id])
    if (!r.rows.length) throw notFound('admin_not_found', 'Admin not found')
    await audit(c, adminActor(admin), 'admin.delete', {
      entity: 'admin',
      entityId: id,
      detail: { email: r.rows[0].email, name: r.rows[0].name },
    })
  })
  return { ok: true }
})

// ---------- the building ----------

// The building's address, which the service providers' app shows at the top, and its name. Either may be empty: then the app
// shows nothing for it.
route('GET', '/admin/building', async ({ req }) => {
  await requireAdmin(req)
  return { building: await readBuilding() }
})

// The address is required (it can be empty). The name is optional: a screen that was installed before the name existed sends
// the address only, and its save leaves the saved name as it is.
route('PUT', '/admin/building', async ({ req, body }) => {
  const { admin } = await requireAdmin(req)
  const address = parseAddress(body.address)
  const name = parseName(body.name)
  return { building: await tx(async (c) => {
    const { changed, before, after } = await saveBuilding(c, admin.id, { address, name })
    if (changed) { // a save that changes neither text has nothing to record
      await audit(c, adminActor(admin), 'building.update', {
        entity: 'building',
        detail: { changes: changesOf(before, after) },
      })
    }
    return after
  }) }
})

// ---------- points ----------

const POINT_SELECT = `
  select p.*, coalesce(array_agg(pp.provider_id) filter (where pp.provider_id is not null), '{}') as provider_ids,
         (select count(*)::int from scans s where s.point_id = p.id) as scan_count
    from points p left join point_providers pp on pp.point_id = p.id`

const pointJson = (p, req) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  service_type: p.service_type,
  gps_mode: p.gps_mode,
  lat: p.lat,
  lng: p.lng,
  radius_m: p.radius_m,
  is_active: p.is_active,
  qr_token: p.qr_token,
  qr_url: `${baseUrl(req)}/scan?code=${p.qr_token}`,
  provider_ids: p.provider_ids,
  scan_count: p.scan_count, // scans recorded at this point (they survive deleting it)
  created_at: p.created_at,
})

const newQrToken = () => `${QR_TOKEN_PREFIX}${randomBytes(12).toString('hex')}`

function pointFields(body, { create }) {
  const f = {}
  const name = str(body.name, { field: 'name', max: NAME_MAX_LENGTH, required: create, nonEmpty: true })
  if (name !== undefined) f.name = name
  const description = str(body.description, { field: 'description', max: DESCRIPTION_MAX_LENGTH })
  if (description !== undefined) f.description = description
  if (body.service_type !== undefined) f.service_type = str(body.service_type, { field: 'service_type', max: SERVICE_TYPE_MAX_LENGTH }) || null
  if (body.gps_mode !== undefined) {
    if (!GPS_MODES.includes(body.gps_mode)) throw bad('invalid_field', 'gps_mode must be required, optional or none', { field: 'gps_mode' })
    f.gps_mode = body.gps_mode
  }
  // null clears the coordinate; a blank string is an error (it used to silently switch GPS checking off).
  if (body.lat !== undefined) f.lat = body.lat === null ? null : num(body.lat, { field: 'lat', min: -90, max: 90 })
  if (body.lng !== undefined) f.lng = body.lng === null ? null : num(body.lng, { field: 'lng', min: -180, max: 180 })
  if (body.radius_m !== undefined) f.radius_m = num(body.radius_m, { field: 'radius_m', min: POINT_RADIUS_MIN_M, max: POINT_RADIUS_MAX_M, integer: true })
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') throw bad('invalid_field', 'is_active must be true or false', { field: 'is_active' })
    f.is_active = body.is_active
  }
  return f
}

/** A point that must verify GPS needs somewhere to verify against. */
function assertLocatable(point) {
  if (point.gps_mode === GPS_MODE_REQUIRED && (point.lat == null || point.lng == null)) {
    throw bad('coordinates_required', "A point with gps_mode 'required' needs coordinates", { field: 'lat' })
  }
}

function providerIds(body) {
  if (body.provider_ids === undefined) return undefined
  if (!Array.isArray(body.provider_ids) || !body.provider_ids.every(isUuid)) {
    throw bad('invalid_field', 'provider_ids must be a list of ids', { field: 'provider_ids' })
  }
  return [...new Set(body.provider_ids.map((i) => i.toLowerCase()))]
}

/**
 * Replaces the providers who may scan at a point, and says what the list was and what it is now, as sorted lists of ids, so
 * that the audit entry holds real ids: the ones the delete took away (the statement itself says which) and the ones that were
 * inserted (the demo account is dropped first, it is never listed).
 */
async function replaceAssignments(c, pointId, ids) {
  const was = await c.query('delete from point_providers where point_id = $1 returning provider_id', [pointId])
  const before = was.rows.map((r) => r.provider_id).sort()
  if (!ids.length) return { before, after: [] }
  const found = await c.query('select id, is_demo from providers where id = any($1::uuid[])', [ids])
  if (found.rows.length !== ids.length) throw bad('unknown_provider', 'One of the providers does not exist')
  // The demo account may scan every point (see recordScan), so it is never listed per point.
  const real = found.rows.filter((r) => !r.is_demo).map((r) => r.id).sort()
  if (real.length) {
    await c.query(
      'insert into point_providers (point_id, provider_id) select $1, unnest($2::uuid[])',
      [pointId, real],
    )
  }
  return { before, after: real }
}

route('GET', '/admin/points', async ({ req }) => {
  await requireAdmin(req)
  const { rows } = await query(`${POINT_SELECT} group by p.id order by p.is_active desc, p.name`)
  return { points: rows.map((p) => pointJson(p, req)) }
})

route('POST', '/admin/points', async ({ req, body }) => {
  const { admin } = await requireAdmin(req)
  const fields = pointFields(body, { create: true })
  assertLocatable({ gps_mode: DEFAULT_GPS_MODE, ...fields })
  const ids = providerIds(body) ?? []
  const created = await tx(async (c) => {
    const cols = [...Object.keys(fields), 'qr_token']
    const vals = [...Object.values(fields), newQrToken()]
    const { rows } = await c.query(
      `insert into points (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      vals,
    )
    const { after } = await replaceAssignments(c, rows[0].id, ids)
    await audit(c, adminActor(admin), 'point.create', {
      entity: 'point',
      entityId: rows[0].id,
      detail: { ...fields, provider_ids: after },
    })
    return rows[0].id
  })
  const { rows } = await query(`${POINT_SELECT} where p.id = $1 group by p.id`, [created])
  return { status: 201, json: { point: pointJson(rows[0], req) } }
})

route('PATCH', '/admin/points/:id', async ({ req, params, body }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const fields = pointFields(body, { create: false })
  const ids = providerIds(body)
  if (!Object.keys(fields).length && ids === undefined) throw bad('nothing_to_update', 'No fields to update')
  await tx(async (c) => {
    const current = await c.query('select * from points where id = $1 for update', [id])
    if (!current.rows.length) throw notFound('point_not_found', 'Point not found')
    assertLocatable({ ...current.rows[0], ...fields })
    // Only the fields whose value differs are written (a request that repeats the saved values leaves even updated_at alone) and
    // recorded.
    const changes = changesOf(current.rows[0], fields)
    const detail = {}
    if (Object.keys(changes).length) {
      const written = Object.fromEntries(Object.keys(changes).map((key) => [key, fields[key]]))
      const { sql, values } = setClause({ ...written, updated_at: new Date() })
      await c.query(`update points set ${sql} where id = $${values.length + 1}`, [...values, id])
      detail.changes = changes
    }
    if (ids !== undefined) {
      const { before, after } = await replaceAssignments(c, id, ids)
      const assignments = idsChanged(before, after)
      if (assignments.added.length || assignments.removed.length) detail.provider_ids = assignments
    }
    if (Object.keys(detail).length) {
      await audit(c, adminActor(admin), 'point.update', { entity: 'point', entityId: id, detail })
    }
  })
  const { rows } = await query(`${POINT_SELECT} where p.id = $1 group by p.id`, [id])
  return { point: pointJson(rows[0], req) }
})

// Deleting a point is allowed. The scans recorded there are NOT touched: they keep the point's name (the snapshot made
// when they were recorded). Only its who-may-scan list goes with it. The point's printed QR stops working.
route('DELETE', '/admin/points/:id', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const gone = await tx(async (c) => {
    const found = await c.query('select id, name from points where id = $1 for update', [id])
    if (!found.rows.length) throw notFound('point_not_found', 'Point not found')
    const kept = await c.query('select count(*)::int as n from scans where point_id = $1', [id])
    await c.query('delete from points where id = $1', [id]) // the assignments follow (on delete cascade)
    const result = { name: found.rows[0].name, scans_kept: kept.rows[0].n }
    await audit(c, adminActor(admin), 'point.delete', { entity: 'point', entityId: id, detail: result })
    return result
  })
  return { ok: true, scans_kept: gone.scans_kept }
})

// Old printed QR stops working; use when a photo of it may have leaked.
route('POST', '/admin/points/:id/regenerate-qr', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  await tx(async (c) => {
    const r = await c.query('update points set qr_token = $2, updated_at = now() where id = $1 returning id', [id, newQrToken()])
    if (!r.rows.length) throw notFound('point_not_found', 'Point not found')
    await audit(c, adminActor(admin), 'point.regenerate_qr', { entity: 'point', entityId: id })
  })
  const { rows } = await query(`${POINT_SELECT} where p.id = $1 group by p.id`, [id])
  return { point: pointJson(rows[0], req) }
})

// ---------- providers ----------

// The last three columns are the health of the provider's ACTIVE phones (ADR 0007, "Phone health"; what a phone reports is stored by
// server/deviceStatus.js): `waiting` is the sum of what the phones say waits in their queues (0 when none reported),
// `oldest_waiting_at` the oldest of the phones that have something waiting (null when none), and `outdated_devices` how many phones
// reported a build that is not the server's own (0 when the server does not know its build). They are new fields of the answer, added
// after the others, which are as they were. $1 is the server's build (providerRows binds it), so the values of a caller start at $2.
const PROVIDER_SELECT = `
  select p.id, p.company, p.contact_name, p.service_type, p.is_active, p.is_demo, p.created_at,
         (p.password_hash is not null) as has_password,
         (select count(*)::int from provider_devices d where d.provider_id = p.id and d.revoked_at is null) as active_devices,
         (select max(s.checked_in_at) from scans s where s.provider_id = p.id and s.outcome = 'accepted' and s.voided_at is null) as last_scan_at,
         (select count(*)::int from scans s where s.provider_id = p.id) as scan_count, -- scans recorded for them (they survive deleting them)
         phones.waiting, phones.oldest_waiting_at, phones.outdated_devices
    from providers p
    cross join lateral (
      select coalesce(sum(d.waiting_count), 0)::int as waiting,
             min(d.oldest_waiting_at) filter (where d.waiting_count > 0) as oldest_waiting_at,
             (count(*) filter (where d.app_build is not null and d.app_build <> $1::text))::int as outdated_devices
        from provider_devices d
       where d.provider_id = p.id and d.revoked_at is null
    ) phones`

/** The rows of PROVIDER_SELECT followed by `tail` (a where, an order); `values` are the parameters of `tail`, numbered from $2. */
const providerRows = async (tail, values = []) => (await query(`${PROVIDER_SELECT} ${tail}`, [commit(), ...values])).rows

function providerFields(body, { create }) {
  const f = {}
  const company = str(body.company, { field: 'company', max: NAME_MAX_LENGTH, required: create, nonEmpty: true })
  if (company !== undefined) f.company = company
  const contact = str(body.contact_name, { field: 'contact_name', max: NAME_MAX_LENGTH })
  if (contact !== undefined) f.contact_name = contact
  if (body.service_type !== undefined) f.service_type = str(body.service_type, { field: 'service_type', max: SERVICE_TYPE_MAX_LENGTH }) || null
  for (const flag of ['is_active', 'is_demo']) {
    if (body[flag] === undefined) continue
    if (typeof body[flag] !== 'boolean') throw bad('invalid_field', `${flag} must be true or false`, { field: flag })
    f[flag] = body[flag]
  }
  return f
}

route('GET', '/admin/providers', async ({ req }) => {
  await requireAdmin(req)
  return { providers: await providerRows('order by p.is_active desc, p.company, p.contact_name') }
})

route('POST', '/admin/providers', async ({ req, body }) => {
  const { admin } = await requireAdmin(req)
  const fields = providerFields(body, { create: true })
  const pw = password(body.password)
  if (pw) fields.password_hash = await hashPassword(pw)
  const cols = Object.keys(fields)
  const created = await tx(async (c) => {
    const { rows } = await c.query(
      `insert into providers (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(fields),
    )
    await audit(c, adminActor(admin), 'provider.create', { entity: 'provider', entityId: rows[0].id, detail: { company: fields.company } })
    return rows[0].id
  })
  const out = await providerRows('where p.id = $2', [created])
  return { status: 201, json: { provider: out[0] } }
})

route('PATCH', '/admin/providers/:id', async ({ req, params, body }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const fields = providerFields(body, { create: false })
  const pw = password(body.password)
  const passwordHash = pw ? await hashPassword(pw) : undefined
  if (!Object.keys(fields).length && !passwordHash) throw bad('nothing_to_update', 'No fields to update')

  await tx(async (c) => {
    // Only the columns that an entry may show are read: the hash of the password is written and never read, and never recorded.
    const found = await c.query(
      'select company, contact_name, service_type, is_active, is_demo from providers where id = $1 for update',
      [id],
    )
    if (!found.rows.length) throw notFound('provider_not_found', 'Provider not found')
    const changes = changesOf(found.rows[0], fields)
    // A new password is always a change (a new salt makes a new hash). The values that are saved already: nothing to write or record.
    if (!Object.keys(changes).length && !passwordHash) return
    const written = Object.fromEntries(Object.keys(changes).map((key) => [key, fields[key]]))
    if (passwordHash) written.password_hash = passwordHash
    const { sql, values } = setClause({ ...written, updated_at: new Date() })
    await c.query(`update providers set ${sql} where id = $${values.length + 1}`, [...values, id])
    // Deactivating or resetting a password signs the person out of every phone.
    if (changes.is_active?.to === false || passwordHash) {
      await c.query('update provider_devices set revoked_at = now() where provider_id = $1 and revoked_at is null', [id])
    }
    const detail = {}
    if (Object.keys(changes).length) detail.changes = changes
    if (passwordHash) detail.password_changed = true
    await audit(c, adminActor(admin), 'provider.update', { entity: 'provider', entityId: id, detail })
  })
  const out = await providerRows('where p.id = $2', [id])
  return { provider: out[0] }
})

// Deleting a provider is allowed. The scans recorded for them are NOT touched: they keep the provider's name (the
// snapshot made when they were recorded). The provider's phones are signed out and their who-may-scan entries go with
// them (both follow on delete cascade). To only stop someone signing in, deactivate them instead.
route('DELETE', '/admin/providers/:id', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const gone = await tx(async (c) => {
    const found = await c.query('select id, company, contact_name from providers where id = $1 for update', [id])
    if (!found.rows.length) throw notFound('provider_not_found', 'Provider not found')
    const kept = await c.query('select count(*)::int as n from scans where provider_id = $1', [id])
    await c.query('delete from providers where id = $1', [id])
    const result = { company: found.rows[0].company, contact_name: found.rows[0].contact_name, scans_kept: kept.rows[0].n }
    await audit(c, adminActor(admin), 'provider.delete', { entity: 'provider', entityId: id, detail: result })
    return result
  })
  return { ok: true, scans_kept: gone.scans_kept }
})

route('POST', '/admin/providers/:id/revoke-devices', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const revoked = await tx(async (c) => {
    // The provider's row is locked against being deleted until this commits, so the entry never names a provider that is gone.
    // A provider that does not exist has no phones to revoke: the answer is the same (0) and nothing is recorded.
    const found = await c.query('select 1 from providers where id = $1 for key share', [id])
    if (!found.rows.length) return 0
    const r = await c.query(
      'update provider_devices set revoked_at = now() where provider_id = $1 and revoked_at is null',
      [id],
    )
    await audit(c, adminActor(admin), 'provider.revoke_devices', { entity: 'provider', entityId: id, detail: { devices: r.rowCount } })
    return r.rowCount
  })
  return { revoked }
})

// ---------- scans ----------

route('GET', '/admin/scans', async ({ req, query: q }) => {
  await requireAdmin(req)
  if (q.format === 'csv') {
    // The export is the committee's archive: every matching row, not one page.
    const { scans, truncated } = await listAllScans({ ...q, cursor: undefined })
    return {
      text: toCsv(scans.map(committeeCsvRow), COMMITTEE_CSV_COLUMNS),
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="scans.csv"',
        ...(truncated ? { 'X-Truncated': 'true' } : {}),
      },
    }
  }
  const { scans, next_cursor } = await listScans(q)
  return { scans, next_cursor }
})

// A scan is voided once (its reason is history); restoring it is a separate, explicit action.
async function setVoid(req, params, body, voided) {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const reason = voided ? str(body.reason, { field: 'reason', max: VOID_REASON_MAX_LENGTH }) || null : null
  const row = await tx(async (c) => {
    // The row is read under its lock first: restoring a scan clears its reason, and the entry keeps the reason that it cleared.
    const found = await c.query('select voided_at, void_reason from scans where id = $1 for update', [id])
    if (!found.rows.length) throw notFound('scan_not_found', 'Scan not found')
    const was = found.rows[0]
    if ((was.voided_at == null) !== voided) {
      throw conflict(voided ? 'already_voided' : 'not_voided', voided ? 'Scan is already voided' : 'Scan is not voided')
    }
    const r = await c.query('update scans set voided_at = $2, void_reason = $3 where id = $1 returning *', [id, voided ? new Date() : null, reason])
    await audit(c, adminActor(admin), voided ? 'scan.void' : 'scan.unvoid', {
      entity: 'scan',
      entityId: id,
      detail: voided ? { reason } : { previous_reason: was.void_reason },
    })
    return r.rows[0]
  })
  return { scan: scanJson(row) }
}
// Deleting a scan row for good (test data, a row that should never have been there). The database refuses every other
// delete: this route tells it, for the length of its own transaction, that this one is intended. Who deleted what goes
// to the audit log, with a copy of the row's main fields.
route('DELETE', '/admin/scans/:id', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  await tx(async (c) => {
    await c.query("select set_config('app.allow_scan_delete', 'on', true)")
    const r = await c.query('delete from scans where id = $1 returning *', [id])
    if (!r.rows.length) throw notFound('scan_not_found', 'Scan not found')
    const gone = r.rows[0]
    await audit(c, adminActor(admin), 'scan.delete', {
      entity: 'scan',
      entityId: id,
      detail: {
        point_name: gone.point_name,
        provider_name: gone.provider_name,
        checked_in_at: new Date(gone.checked_in_at).toISOString(),
        outcome: gone.outcome,
        voided: gone.voided_at != null,
      },
    })
  })
  return { ok: true }
})

route('POST', '/admin/scans/:id/void', ({ req, params, body }) => setVoid(req, params, body, true))
route('POST', '/admin/scans/:id/unvoid', ({ req, params, body }) => setVoid(req, params, body, false))

// ---------- API keys for the agent ----------

route('GET', '/admin/api-keys', async ({ req }) => {
  await requireAdmin(req)
  const { rows } = await query(
    'select id, name, key_prefix, created_at, last_used_at, revoked_at from api_keys order by created_at desc',
  )
  return { api_keys: rows }
})

// The secret is shown exactly once, here.
route('POST', '/admin/api-keys', async ({ req, body }) => {
  const { admin } = await requireAdmin(req)
  const name = str(body.name, { field: 'name', max: KEY_NAME_MAX_LENGTH, required: true })
  const key = randomToken(API_KEY_PREFIX)
  const created = await tx(async (c) => {
    const { rows } = await c.query(
      'insert into api_keys (name, key_prefix, key_hash) values ($1, $2, $3) returning id, name, key_prefix, created_at',
      [name, key.slice(0, 8), sha256(key)],
    )
    await audit(c, adminActor(admin), 'api_key.create', { entity: 'api_key', entityId: rows[0].id, detail: { name } })
    return rows[0]
  })
  return { status: 201, json: { api_key: created, key } }
})

// Revoking keeps the row (it shows as revoked, with when it was last used); the key stops working at once.
route('POST', '/admin/api-keys/:id/revoke', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  await tx(async (c) => {
    const r = await c.query('update api_keys set revoked_at = now() where id = $1 and revoked_at is null returning id', [id])
    if (!r.rows.length) throw notFound('api_key_not_found', 'API key not found')
    await audit(c, adminActor(admin), 'api_key.revoke', { entity: 'api_key', entityId: id })
  })
  return { ok: true }
})

// Deleting removes the row for good, revoked or not (a key that is still active stops working at once, because the
// agent API looks the key up by its hash).
route('DELETE', '/admin/api-keys/:id', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  await tx(async (c) => {
    const r = await c.query('delete from api_keys where id = $1 returning name, key_prefix, revoked_at', [id])
    if (!r.rows.length) throw notFound('api_key_not_found', 'API key not found')
    await audit(c, adminActor(admin), 'api_key.delete', {
      entity: 'api_key',
      entityId: id,
      detail: { name: r.rows[0].name, key_prefix: r.rows[0].key_prefix, was_revoked: r.rows[0].revoked_at != null },
    })
  })
  return { ok: true }
})
