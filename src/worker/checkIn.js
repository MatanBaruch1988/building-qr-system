// The whole "scan → recorded" journey as one function with injectable dependencies, so every branch
// (success, duplicate, no signal, too far, …) is unit-tested without a browser.
//
// Result kinds: success | duplicate | queued | far | needLocation | signedOut | error

export async function performCheckIn({ code, point, session, deps, onPhase = () => {} }) {
  const { api, getFix, queue, newId, now } = deps
  const id = newId()
  const client_time = now().toISOString()

  let gps = null
  let locationReason = null
  if (point?.gps_mode !== 'none') {
    onPhase('locating')
    const res = await getFix()
    gps = res.fix
    locationReason = res.reason
  }

  onPhase('saving')
  try {
    const res = await api('/scan', {
      method: 'POST',
      token: session.token,
      timeoutMs: 8000,
      body: { id, code, client_time, gps },
    })
    const scan = res.scan
    if (scan.outcome === 'rejected_far') return { kind: 'far', scan }
    if (scan.outcome === 'rejected_no_location') return { kind: 'needLocation', scan, locationReason }
    return { kind: res.duplicate ? 'duplicate' : 'success', scan }
  } catch (err) {
    if (err.status === 401) return { kind: 'signedOut' }
    if (err.transient) {
      // No signal (or a server hiccup): keep the visit on the phone. The same id is reused on upload,
      // so if the server did receive it after all, the retry cannot create a second record.
      const persisted = queue.add({ id, code, client_time, gps, provider_id: session.provider.id, saved_at: client_time, point_name: point?.name })
      // persisted=false: the phone refused to store it, so it only survives while this page stays open.
      return { kind: 'queued', id, client_time, persisted }
    }
    return { kind: 'error', code: err.code }
  }
}
