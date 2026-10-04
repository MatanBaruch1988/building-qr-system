import { randomBytes } from 'node:crypto'
import { route } from '../router.js'
import { query, tx } from '../db.js'
import { hashPassword, randomToken, sha256 } from '../crypto.js'
import {
  ApiError, bad, conflict, forbidden, notFound, requireUuid, isUuid, str, num, toCsv, cookieHeader, getCookie, clientIp,
} from '../http.js'
import { requireAdmin, isAdminToken, guardLogin } from '../auth.js'
import { verifyGoogleCredential } from '../google.js'
import { readAddress, saveAddress, parseAddress } from '../building.js'
import { listScans, listAllScans, scanJson, COMMITTEE_CSV_COLUMNS, committeeCsvRow } from '../scans.js'
import {
  ADMIN_COOKIE, ADMIN_SESSION_DAYS, ADMIN_TOKEN_PREFIX, API_KEY_PREFIX, PASSWORD_MIN_LENGTH,
} from '../config.js'

const GPS_MODES = ['required', 'optional', 'none']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isSecure = (req) => !!process.env.VERCEL || String(req.headers['x-forwarded-proto'] || '').includes('https')

function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '')
  const proto = req.headers['x-forwarded-proto'] || 'http'
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`
}

async function audit(admin, action, entity, entityId, detail) {
  await query(
    'insert into audit_log (actor_type, actor_id, action, entity, entity_id, detail) values ($1,$2,$3,$4,$5,$6)',
    ['admin', admin.id, action, entity, entityId ?? null, detail ? JSON.stringify(detail) : null],
  )
}

/** Builds "col = $n, …" from an object of already-validated fields. */
function setClause(fields, startAt = 1) {
  const keys = Object.keys(fields)
  return {
    sql: keys.map((k, i) => `${k} = $${startAt + i}`).join(', '),
    values: keys.map((k) => fields[k]),
  }
}

function password(value, required = false) {
  const pw = str(value, { field: 'password', max: 200, required })
  if (pw !== undefined && pw.length < PASSWORD_MIN_LENGTH) {
    throw bad('password_too_short', `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  }
  return pw
}

// ---------- sign in / out ----------

/** Local development only: lets a developer (or an automated UI check) get an admin session without Google. */
const devLoginAllowed = () => !process.env.VERCEL && process.env.DEV_ADMIN_LOGIN === '1'

async function startAdminSession(req, res, adminRow) {
  const token = randomToken(ADMIN_TOKEN_PREFIX)
  await query(
    `insert into admin_sessions (admin_id, token_hash, expires_at)
     values ($1, $2, now() + ($3 || ' days')::interval)`,
    [adminRow.id, sha256(token), String(ADMIN_SESSION_DAYS)],
  )
  await query('update admins set last_login_at = now() where id = $1', [adminRow.id])
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
  const { rows } = await query('select * from admins where email = $1 and is_active', [google.email])
  if (!rows.length) throw forbidden('not_an_admin', 'This Google account is not on the committee list')
  await query(
    `update admins set google_sub = coalesce(google_sub, $2), name = case when name = '' then $3 else name end where id = $1`,
    [rows[0].id, google.sub, google.name],
  )
  if (rows[0].google_sub && rows[0].google_sub !== google.sub) {
    throw forbidden('google_account_mismatch', 'This e-mail is linked to a different Google account')
  }
  await attempt.success()
  return startAdminSession(req, res, { ...rows[0], name: rows[0].name || google.name })
})

route('POST', '/admin/dev-login', async ({ req, res, body }) => {
  if (!devLoginAllowed()) throw new ApiError(404, 'not_found', 'Unknown endpoint')
  const email = str(body.email, { field: 'email', max: 200, required: true }).toLowerCase()
  const { rows } = await query('select * from admins where email = $1 and is_active', [email])
  if (!rows.length) throw forbidden('not_an_admin', 'Not an admin')
  return startAdminSession(req, res, rows[0])
})

route('POST', '/admin/logout', async ({ req, res }) => {
  const token = getCookie(req, ADMIN_COOKIE)
  // Only a cookie shaped like one of our session tokens can match a session: any other value costs no query.
  if (token && isAdminToken(token)) {
    await query('update admin_sessions set revoked_at = now() where token_hash = $1', [sha256(token)])
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
  const email = str(body.email, { field: 'email', max: 200, required: true }).toLowerCase()
  if (!EMAIL_RE.test(email)) throw bad('invalid_field', 'Not a valid e-mail address', { field: 'email' })
  const name = str(body.name, { field: 'name', max: 120 }) ?? ''
  const { rows } = await query(
    `insert into admins (email, name) values ($1, $2)
     on conflict (email) do update set is_active = true returning id, email, name, is_active`,
    [email, name],
  )
  await audit(admin, 'admin.add', 'admin', rows[0].id, { email })
  return { status: 201, json: { admin: rows[0] } }
})

route('PATCH', '/admin/admins/:id', async ({ req, params, body }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  if (typeof body.is_active !== 'boolean') throw bad('invalid_field', 'is_active must be true or false', { field: 'is_active' })
  if (id === admin.id && !body.is_active) throw conflict('cannot_deactivate_self', 'You cannot remove your own access')
  const r = await query('update admins set is_active = $2 where id = $1 returning id, email, name, is_active', [id, body.is_active])
  if (!r.rows.length) throw notFound('admin_not_found', 'Admin not found')
  if (!body.is_active) await query('update admin_sessions set revoked_at = now() where admin_id = $1 and revoked_at is null', [id])
  await audit(admin, body.is_active ? 'admin.enable' : 'admin.disable', 'admin', id)
  return { admin: r.rows[0] }
})

// Deleting a committee member takes them off the list for good (their sessions go with them). You cannot delete
// yourself, which also means the list is never left without someone who can sign in. To keep the person on the list but
// shut them out for now, remove their access instead.
route('DELETE', '/admin/admins/:id', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  if (id === admin.id) throw conflict('cannot_delete_self', 'You cannot delete yourself')
  const r = await query('delete from admins where id = $1 returning email, name', [id])
  if (!r.rows.length) throw notFound('admin_not_found', 'Admin not found')
  await audit(admin, 'admin.delete', 'admin', id, { email: r.rows[0].email, name: r.rows[0].name })
  return { ok: true }
})

// ---------- the building ----------

// The address shown at the top of the service providers' app. It may be empty: then the app shows no address.
route('GET', '/admin/building', async ({ req }) => {
  await requireAdmin(req)
  return { building: { address: await readAddress() } }
})

route('PUT', '/admin/building', async ({ req, body }) => {
  const { admin } = await requireAdmin(req)
  const address = parseAddress(body.address)
  await saveAddress(admin.id, address)
  await audit(admin, 'building.update', 'building', null, { address })
  return { building: { address } }
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

const newQrToken = () => `BQR-${randomBytes(12).toString('hex')}`

function pointFields(body, { create }) {
  const f = {}
  const name = str(body.name, { field: 'name', max: 120, required: create, nonEmpty: true })
  if (name !== undefined) f.name = name
  const description = str(body.description, { field: 'description', max: 500 })
  if (description !== undefined) f.description = description
  if (body.service_type !== undefined) f.service_type = str(body.service_type, { field: 'service_type', max: 60 }) || null
  if (body.gps_mode !== undefined) {
    if (!GPS_MODES.includes(body.gps_mode)) throw bad('invalid_field', 'gps_mode must be required, optional or none', { field: 'gps_mode' })
    f.gps_mode = body.gps_mode
  }
  // null clears the coordinate; a blank string is an error (it used to silently switch GPS checking off).
  if (body.lat !== undefined) f.lat = body.lat === null ? null : num(body.lat, { field: 'lat', min: -90, max: 90 })
  if (body.lng !== undefined) f.lng = body.lng === null ? null : num(body.lng, { field: 'lng', min: -180, max: 180 })
  if (body.radius_m !== undefined) f.radius_m = num(body.radius_m, { field: 'radius_m', min: 1, max: 1000, integer: true })
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') throw bad('invalid_field', 'is_active must be true or false', { field: 'is_active' })
    f.is_active = body.is_active
  }
  return f
}

/** A point that must verify GPS needs somewhere to verify against. */
function assertLocatable(point) {
  if (point.gps_mode === 'required' && (point.lat == null || point.lng == null)) {
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

async function replaceAssignments(c, pointId, ids) {
  await c.query('delete from point_providers where point_id = $1', [pointId])
  if (!ids.length) return
  const found = await c.query('select id, is_demo from providers where id = any($1::uuid[])', [ids])
  if (found.rows.length !== ids.length) throw bad('unknown_provider', 'One of the providers does not exist')
  // The demo account may scan every point (see recordScan), so it is never listed per point.
  const real = found.rows.filter((r) => !r.is_demo).map((r) => r.id)
  if (!real.length) return
  await c.query(
    'insert into point_providers (point_id, provider_id) select $1, unnest($2::uuid[])',
    [pointId, real],
  )
}

route('GET', '/admin/points', async ({ req }) => {
  await requireAdmin(req)
  const { rows } = await query(`${POINT_SELECT} group by p.id order by p.is_active desc, p.name`)
  return { points: rows.map((p) => pointJson(p, req)) }
})

route('POST', '/admin/points', async ({ req, body }) => {
  const { admin } = await requireAdmin(req)
  const fields = pointFields(body, { create: true })
  assertLocatable({ gps_mode: 'optional', ...fields })
  const ids = providerIds(body) ?? []
  const created = await tx(async (c) => {
    const cols = [...Object.keys(fields), 'qr_token']
    const vals = [...Object.values(fields), newQrToken()]
    const { rows } = await c.query(
      `insert into points (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      vals,
    )
    await replaceAssignments(c, rows[0].id, ids)
    return rows[0].id
  })
  await audit(admin, 'point.create', 'point', created, fields)
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
    if (Object.keys(fields).length) {
      const { sql, values } = setClause({ ...fields, updated_at: new Date() })
      await c.query(`update points set ${sql} where id = $${values.length + 1}`, [...values, id])
    }
    if (ids !== undefined) await replaceAssignments(c, id, ids)
  })
  await audit(admin, 'point.update', 'point', id, { ...fields, provider_ids: ids })
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
    return { name: found.rows[0].name, scans_kept: kept.rows[0].n }
  })
  await audit(admin, 'point.delete', 'point', id, gone)
  return { ok: true, scans_kept: gone.scans_kept }
})

// Old printed QR stops working; use when a photo of it may have leaked.
route('POST', '/admin/points/:id/regenerate-qr', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const r = await query('update points set qr_token = $2, updated_at = now() where id = $1 returning id', [id, newQrToken()])
  if (!r.rows.length) throw notFound('point_not_found', 'Point not found')
  await audit(admin, 'point.regenerate_qr', 'point', id)
  const { rows } = await query(`${POINT_SELECT} where p.id = $1 group by p.id`, [id])
  return { point: pointJson(rows[0], req) }
})

// ---------- providers ----------

const PROVIDER_SELECT = `
  select p.id, p.company, p.contact_name, p.service_type, p.is_active, p.is_demo, p.created_at,
         (p.password_hash is not null) as has_password,
         (select count(*)::int from provider_devices d where d.provider_id = p.id and d.revoked_at is null) as active_devices,
         (select max(s.checked_in_at) from scans s where s.provider_id = p.id and s.outcome = 'accepted' and s.voided_at is null) as last_scan_at,
         (select count(*)::int from scans s where s.provider_id = p.id) as scan_count -- scans recorded for them (they survive deleting them)
    from providers p`

function providerFields(body, { create }) {
  const f = {}
  const company = str(body.company, { field: 'company', max: 120, required: create, nonEmpty: true })
  if (company !== undefined) f.company = company
  const contact = str(body.contact_name, { field: 'contact_name', max: 120 })
  if (contact !== undefined) f.contact_name = contact
  if (body.service_type !== undefined) f.service_type = str(body.service_type, { field: 'service_type', max: 60 }) || null
  for (const flag of ['is_active', 'is_demo']) {
    if (body[flag] === undefined) continue
    if (typeof body[flag] !== 'boolean') throw bad('invalid_field', `${flag} must be true or false`, { field: flag })
    f[flag] = body[flag]
  }
  return f
}

route('GET', '/admin/providers', async ({ req }) => {
  await requireAdmin(req)
  const { rows } = await query(`${PROVIDER_SELECT} order by p.is_active desc, p.company, p.contact_name`)
  return { providers: rows }
})

route('POST', '/admin/providers', async ({ req, body }) => {
  const { admin } = await requireAdmin(req)
  const fields = providerFields(body, { create: true })
  const pw = password(body.password)
  if (pw) fields.password_hash = await hashPassword(pw)
  const cols = Object.keys(fields)
  const { rows } = await query(
    `insert into providers (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(fields),
  )
  await audit(admin, 'provider.create', 'provider', rows[0].id, { company: fields.company })
  const out = await query(`${PROVIDER_SELECT} where p.id = $1`, [rows[0].id])
  return { status: 201, json: { provider: out.rows[0] } }
})

route('PATCH', '/admin/providers/:id', async ({ req, params, body }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const fields = providerFields(body, { create: false })
  const pw = password(body.password)
  if (pw) fields.password_hash = await hashPassword(pw)
  if (!Object.keys(fields).length) throw bad('nothing_to_update', 'No fields to update')

  await tx(async (c) => {
    const { sql, values } = setClause({ ...fields, updated_at: new Date() })
    const r = await c.query(`update providers set ${sql} where id = $${values.length + 1} returning id`, [...values, id])
    if (!r.rows.length) throw notFound('provider_not_found', 'Provider not found')
    // Deactivating or resetting a password signs the person out of every phone.
    if (fields.is_active === false || pw) {
      await c.query('update provider_devices set revoked_at = now() where provider_id = $1 and revoked_at is null', [id])
    }
  })
  const { password_hash, ...loggable } = fields
  await audit(admin, 'provider.update', 'provider', id, { ...loggable, password_changed: !!password_hash })
  const out = await query(`${PROVIDER_SELECT} where p.id = $1`, [id])
  return { provider: out.rows[0] }
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
    return { company: found.rows[0].company, contact_name: found.rows[0].contact_name, scans_kept: kept.rows[0].n }
  })
  await audit(admin, 'provider.delete', 'provider', id, gone)
  return { ok: true, scans_kept: gone.scans_kept }
})

route('POST', '/admin/providers/:id/revoke-devices', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const r = await query(
    'update provider_devices set revoked_at = now() where provider_id = $1 and revoked_at is null',
    [id],
  )
  await audit(admin, 'provider.revoke_devices', 'provider', id, { devices: r.rowCount })
  return { revoked: r.rowCount }
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
  const reason = voided ? str(body.reason, { field: 'reason', max: 300 }) || null : null
  const r = await query(
    `update scans set voided_at = $2, void_reason = $3
      where id = $1 and (voided_at is null) = $4 returning *`,
    [id, voided ? new Date() : null, reason, voided],
  )
  if (!r.rows.length) {
    const exists = await query('select 1 from scans where id = $1', [id])
    if (!exists.rows.length) throw notFound('scan_not_found', 'Scan not found')
    throw conflict(voided ? 'already_voided' : 'not_voided', voided ? 'Scan is already voided' : 'Scan is not voided')
  }
  await audit(admin, voided ? 'scan.void' : 'scan.unvoid', 'scan', id, { reason })
  return { scan: scanJson(r.rows[0]) }
}
// Deleting a scan row for good (test data, a row that should never have been there). The database refuses every other
// delete: this route tells it, for the length of its own transaction, that this one is intended. Who deleted what goes
// to the audit log, with a copy of the row's main fields.
route('DELETE', '/admin/scans/:id', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const row = await tx(async (c) => {
    await c.query("select set_config('app.allow_scan_delete', 'on', true)")
    const r = await c.query('delete from scans where id = $1 returning *', [id])
    if (!r.rows.length) throw notFound('scan_not_found', 'Scan not found')
    return r.rows[0]
  })
  await audit(admin, 'scan.delete', 'scan', id, {
    point_name: row.point_name,
    provider_name: row.provider_name,
    checked_in_at: new Date(row.checked_in_at).toISOString(),
    outcome: row.outcome,
    voided: row.voided_at != null,
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
  const name = str(body.name, { field: 'name', max: 80, required: true })
  const key = randomToken(API_KEY_PREFIX)
  const { rows } = await query(
    'insert into api_keys (name, key_prefix, key_hash) values ($1, $2, $3) returning id, name, key_prefix, created_at',
    [name, key.slice(0, 8), sha256(key)],
  )
  await audit(admin, 'api_key.create', 'api_key', rows[0].id, { name })
  return { status: 201, json: { api_key: rows[0], key } }
})

// Revoking keeps the row (it shows as revoked, with when it was last used); the key stops working at once.
route('POST', '/admin/api-keys/:id/revoke', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const r = await query('update api_keys set revoked_at = now() where id = $1 and revoked_at is null returning id', [id])
  if (!r.rows.length) throw notFound('api_key_not_found', 'API key not found')
  await audit(admin, 'api_key.revoke', 'api_key', id)
  return { ok: true }
})

// Deleting removes the row for good, revoked or not (a key that is still active stops working at once, because the
// agent API looks the key up by its hash).
route('DELETE', '/admin/api-keys/:id', async ({ req, params }) => {
  const { admin } = await requireAdmin(req)
  const id = requireUuid(params.id)
  const r = await query('delete from api_keys where id = $1 returning name, key_prefix, revoked_at', [id])
  if (!r.rows.length) throw notFound('api_key_not_found', 'API key not found')
  await audit(admin, 'api_key.delete', 'api_key', id, { name: r.rows[0].name, key_prefix: r.rows[0].key_prefix, was_revoked: r.rows[0].revoked_at != null })
  return { ok: true }
})
