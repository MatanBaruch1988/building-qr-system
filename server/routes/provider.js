import { route } from '../router.js'
import { query } from '../db.js'
import { verifyPassword, burnPasswordCheck, randomToken, sha256 } from '../crypto.js'
import { ApiError, bad, notFound, requireUuid, str, clientIp } from '../http.js'
import { requireProvider, guardLogin } from '../auth.js'
import { recordScan, scanJson } from '../scans.js'
import { parseQrToken } from '../scanLogic.js'
import { MAX_SYNC_BATCH } from '../config.js'

const providerJson = (p) => ({
  id: p.id,
  company: p.company,
  contact_name: p.contact_name,
  service_type: p.service_type,
  lang: p.lang,
})

// Names for the login tiles. Only providers who can actually sign in (a password is set).
route('GET', '/public/providers', async () => {
  const { rows } = await query(
    `select id, company, contact_name, service_type, lang
       from providers where is_active and password_hash is not null
      order by company, contact_name`,
  )
  return { providers: rows }
})

// Lets the phone show "Lobby" before anyone signs in, and skip GPS for points that never use it.
route('GET', '/public/points/resolve', async ({ query: q }) => {
  const token = parseQrToken(q.code)
  if (!token) throw bad('invalid_code', 'This is not a QR code of this system')
  const { rows } = await query(
    'select name, description, is_active, gps_mode from points where qr_token = $1',
    [token],
  )
  if (!rows.length) throw notFound('unknown_code', 'QR code not found in the system')
  return { point: rows[0] }
})

route('POST', '/session', async ({ req, body }) => {
  const providerId = requireUuid(body.provider_id, 'invalid_provider')
  const password = str(body.password, { field: 'password', max: 200, required: true })
  const label = str(body.device_label, { field: 'device_label', max: 80 }) ?? ''

  const attempt = await guardLogin({ scope: 'provider', account: providerId, ip: clientIp(req) })
  const { rows } = await query(
    'select * from providers where id = $1 and is_active and password_hash is not null',
    [providerId],
  )
  const provider = rows[0]
  const ok = provider ? await verifyPassword(password, provider.password_hash) : (await burnPasswordCheck(password), false)
  if (!ok) throw new ApiError(401, 'invalid_credentials', 'Wrong password')
  await attempt.success()

  const token = randomToken('qrp_')
  await query(
    'insert into provider_devices (provider_id, token_hash, label) values ($1, $2, $3)',
    [provider.id, sha256(token), label],
  )
  return { token, provider: providerJson(provider) }
})

route('GET', '/session', async ({ req }) => {
  const { provider } = await requireProvider(req)
  return { provider }
})

route('DELETE', '/session', async ({ req }) => {
  const { deviceId } = await requireProvider(req)
  await query('update provider_devices set revoked_at = now() where id = $1', [deviceId])
  return { ok: true }
})

const toInput = (s) => ({ id: s?.id, code: s?.code, clientTime: s?.client_time, gps: s?.gps })

route('POST', '/scan', async ({ req, body }) => {
  const { provider, deviceId } = await requireProvider(req)
  const { scan, duplicate } = await recordScan({
    provider,
    deviceId,
    input: toInput(body),
    source: 'online',
  })
  return { scan, duplicate }
})

// Batch upload of scans saved on the phone while it had no signal. Each item succeeds or fails alone.
route('POST', '/scans/sync', async ({ req, body }) => {
  const { provider, deviceId } = await requireProvider(req)
  if (!Array.isArray(body.scans)) throw bad('invalid_field', 'scans must be a list', { field: 'scans' })
  if (body.scans.length > MAX_SYNC_BATCH) throw bad('batch_too_large', `At most ${MAX_SYNC_BATCH} scans per request`)

  const items = [...body.scans].sort((a, b) => String(a?.client_time).localeCompare(String(b?.client_time)))
  const results = []
  for (const item of items) {
    try {
      const { scan, duplicate } = await recordScan({
        provider,
        deviceId,
        input: toInput(item),
        source: 'offline_sync',
      })
      results.push({ id: item?.id, ok: true, scan, duplicate })
    } catch (err) {
      if (err instanceof ApiError) {
        results.push({ id: item?.id, ok: false, error: { code: err.code, message: err.message } })
      } else if (typeof err?.code === 'string' && /^2[23]/.test(err.code)) {
        // The database rejected this one item's data (out of range, malformed): retrying can never help,
        // and it must not block the good items queued behind it.
        results.push({ id: item?.id, ok: false, error: { code: 'invalid_item', message: 'Item could not be stored' } })
      } else {
        throw err // infrastructure trouble (connection, timeout): fail the request so the phone retries later
      }
    }
  }
  return { results }
})

// A provider's own recent visits (their history screen).
route('GET', '/my/scans', async ({ req }) => {
  const { provider } = await requireProvider(req)
  const { rows } = await query(
    `select * from scans where provider_id = $1 and outcome = 'accepted' and voided_at is null
      order by checked_in_at desc, id desc limit 50`,
    [provider.id],
  )
  return { scans: rows.map(scanJson) }
})

