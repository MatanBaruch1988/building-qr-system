import { route } from '../router.js'
import { requireAdmin, requireProvider } from '../auth.js'
import { notFound, requireUuid } from '../http.js'
import { commit } from '../health.js'
import { parseDeviceStatusReport, reportDeviceStatus, listProviderDevices, deviceJson } from '../deviceStatus.js'

/** @import { DeviceStatusAnswer } from '../../shared/types.js' */

// The phone tells the server what is waiting in its offline queue, since when, and which build it runs (ADR 0007, "Phone health").
// A request of its own, never a field of the sync request, so the sync contract does not change. The router has run the guard of
// the provider (server/access.js) before this handler, and the guard remembers its answer: the row that is updated is the phone
// that is signed in, found from its token, and nothing in the body can name another one. The body is read only through
// parseDeviceStatusReport, which ignores whatever is not valid (never a 400), and the answer is always the same: `build` is the
// server's own, so that a phone can tell that it is outdated. A report within DEVICE_STATUS_MIN_INTERVAL_S of the last one is
// answered the same way and stores nothing (reportDeviceStatus).
route('POST', '/my/device-status', async ({ req, body }) => {
  const { deviceId } = await requireProvider(req)
  await reportDeviceStatus(deviceId, parseDeviceStatusReport(body))
  /** @type {DeviceStatusAnswer} */
  const answer = { ok: true, build: commit() }
  return answer
})

// What the committee sees of a provider's phones: the active ones, with what each reported about itself and when the server last
// finished an upload from it. Never the label (the browser string) and never the token hash (server/deviceStatus.js selects named
// columns). The same codes as the other provider routes of the committee: 400 `invalid_id` for an id that is not an id, 404
// `provider_not_found` for a provider that does not exist.
route('GET', '/admin/providers/:id/devices', async ({ req, params }) => {
  await requireAdmin(req)
  const id = requireUuid(params.id)
  const devices = await listProviderDevices(id)
  if (!devices) throw notFound('provider_not_found', 'Provider not found')
  const serverBuild = commit()
  return { devices: devices.map((device) => deviceJson(device, serverBuild)) }
})
