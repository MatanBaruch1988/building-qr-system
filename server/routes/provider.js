import { route } from '../router.js'
import { query } from '../db.js'
import { verifyPassword, burnPasswordCheck, randomToken, sha256 } from '../crypto.js'
import { ApiError, bad, notFound, requireUuid, str, clientIp } from '../http.js'
import { requireProvider, guardLogin } from '../auth.js'
import { recordScan, scanJson } from '../scans.js'
import { recordRefusedVisit, isDataError } from '../scanRefusals.js'
import { touchLastSync } from '../deviceStatus.js'
import { parseQrToken } from '../../shared/qrToken.js'
import { PROVIDER_TOKEN_PREFIX } from '../config.js'
import {
  MAX_SYNC_BATCH,
  PASSWORD_MAX_LENGTH,
  DEVICE_LABEL_MAX_LENGTH,
  SOURCE_ONLINE,
  SOURCE_OFFLINE_SYNC,
  SCAN_ERROR_INVALID_CODE,
  SCAN_ERROR_UNKNOWN_CODE,
  SCAN_ERROR_INVALID_ITEM,
} from '../../shared/contract.js'
import { readAddress } from '../building.js'

/** @import { SyncItemResult } from '../../shared/types.js' */

const providerJson = (p) => ({
  id: p.id,
  company: p.company,
  contact_name: p.contact_name,
  service_type: p.service_type,
})

// Names for the login tiles. Only providers who can actually sign in (a password is set).
route('GET', '/public/providers', async () => {
  const { rows } = await query(
    `select id, company, contact_name, service_type
       from providers where is_active and password_hash is not null
      order by company, contact_name`,
  )
  return { providers: rows }
})

// The building's address for the header of the app: only that, nothing else about the building. One single-row select by
// primary key. Every phone asks once per app start, so the CDN may keep the answer for a minute (the browser always
// revalidates, max-age=0); a change by the committee shows up within that minute.
route('GET', '/public/building', async () => ({
  json: { building: { address: await readAddress() } },
  headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60' },
}))

// Lets the phone show "Lobby" before anyone signs in, and skip GPS for points that never use it.
route('GET', '/public/points/resolve', async ({ query: q }) => {
  const token = parseQrToken(q.code)
  if (!token) throw bad(SCAN_ERROR_INVALID_CODE, 'This is not a QR code of this system')
  const { rows } = await query(
    'select name, description, is_active, gps_mode from points where qr_token = $1',
    [token],
  )
  if (!rows.length) throw notFound(SCAN_ERROR_UNKNOWN_CODE, 'QR code not found in the system')
  return { point: rows[0] }
})

route('POST', '/session', async ({ req, body }) => {
  const providerId = requireUuid(body.provider_id, 'invalid_provider')
  const password = str(body.password, { field: 'password', max: PASSWORD_MAX_LENGTH, required: true })
  const label = str(body.device_label, { field: 'device_label', max: DEVICE_LABEL_MAX_LENGTH }) ?? ''

  const attempt = await guardLogin({ scope: 'provider', account: providerId, ip: clientIp(req) })
  const { rows } = await query(
    'select * from providers where id = $1 and is_active and password_hash is not null',
    [providerId],
  )
  const provider = rows[0]
  const ok = provider ? await verifyPassword(password, provider.password_hash) : (await burnPasswordCheck(password), false)
  if (!ok) throw new ApiError(401, 'invalid_credentials', 'Wrong password')
  await attempt.success()

  const token = randomToken(PROVIDER_TOKEN_PREFIX)
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
  const input = toInput(body)
  try {
    const { scan, duplicate } = await recordScan({ provider, deviceId, input, source: SOURCE_ONLINE })
    return { scan, duplicate }
  } catch (err) {
    // A refusal that the phone treats as final leaves a record for the committee (server/scanRefusals.js), then answers as
    // it always did: the same error goes on to the router. If the record cannot be written because the database is down, that
    // failure is the answer (a 500, which the phone keeps the visit for and sends again), so a refusal never goes unrecorded.
    if (err instanceof ApiError) await recordRefusedVisit({ code: err.code, source: SOURCE_ONLINE, provider, deviceId, input, err })
    throw err
  }
})

// Batch upload of scans saved on the phone while it had no signal. Each item succeeds or fails alone. The error of an item
// carries one of the SCAN_ERROR_* codes of shared/contract.js (the phone drops the item for a permanent code and keeps it
// for any other); the size limit and the phone's chunk are in the same file.
route('POST', '/scans/sync', async ({ req, body }) => {
  const { provider, deviceId } = await requireProvider(req)
  if (!Array.isArray(body.scans)) throw bad('invalid_field', 'scans must be a list', { field: 'scans' })
  if (body.scans.length > MAX_SYNC_BATCH) throw bad('batch_too_large', `At most ${MAX_SYNC_BATCH} scans per request`)

  const items = [...body.scans].sort((a, b) => String(a?.client_time).localeCompare(String(b?.client_time)))
  /** @type {SyncItemResult[]} */
  const results = []
  for (const item of items) {
    const input = toInput(item)
    try {
      const { scan, duplicate } = await recordScan({ provider, deviceId, input, source: SOURCE_OFFLINE_SYNC })
      results.push({ id: item?.id, ok: true, scan, duplicate })
    } catch (err) {
      if (err instanceof ApiError) {
        // The phone drops an item for a permanent code and the server would keep no trace of it: record the refused visit
        // (server/scanRefusals.js) before answering. If that fails because the database is down, the failure is thrown on
        // like the one below: the request answers 500, the phone keeps the items and sends them again, and the items that
        // were recorded already replay by id.
        await recordRefusedVisit({ code: err.code, source: SOURCE_OFFLINE_SYNC, provider, deviceId, input, err })
        results.push({ id: item?.id, ok: false, error: { code: err.code, message: err.message } })
      } else if (isDataError(err)) {
        // The database rejected this one item's data (out of range, malformed): retrying can never help,
        // and it must not block the good items queued behind it.
        await recordRefusedVisit({ code: SCAN_ERROR_INVALID_ITEM, source: SOURCE_OFFLINE_SYNC, provider, deviceId, input, err })
        results.push({ id: item?.id, ok: false, error: { code: SCAN_ERROR_INVALID_ITEM, message: 'Item could not be stored' } })
      } else {
        throw err // infrastructure trouble (connection, timeout): fail the request so the phone retries later
      }
    }
  }
  // The items are recorded: stamp the end of the upload on the phone's row, for the committee's view of the phone (migration 009).
  // The server does it from the sync itself, so it is right for a phone of any version, and it is the LAST thing the request does.
  // A failure is swallowed and logged by touchLastSync, and the answer below is exactly what it always was.
  await touchLastSync(deviceId)
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

