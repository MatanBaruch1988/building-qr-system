import { GPS_MODE_NONE, GPS_MODE_REQUIRED, OUTCOME_REJECTED_FAR, OUTCOME_REJECTED_NO_LOCATION } from '../../shared/contract.js'
import { isUsableFix } from './geo.js'

/** @import { PublicPoint, Scan, ScanResponse } from '../../shared/types.js' */
/** @import { Session } from './session.js' */

/**
 * What the result screen needs besides the outcome: the scanned QR address and the point (for "try again").
 * They get their own names. `code` is the SERVER's error code ('not_assigned', …) and must stay untouched:
 * overwriting it with the QR address turned every specific refusal into "something went wrong".
 */
export const withScanContext = (result, { qrCode, point }) => ({ ...result, qrCode, point })

/** "Ploni · Cleaning": who is signed in, as the committee named them (the same shape as its own lists). */
export const providerLabel = (p) => (p?.contact_name ? `${p.contact_name} · ${p.company}` : p?.company ?? '')

// The whole "scan → recorded" journey as one function with injectable dependencies, so every branch
// (success, duplicate, no signal, too far, …) is unit-tested without a browser.
//
// Result kinds: success | duplicate | queued | far | needLocation | signedOut | error

/**
 * What performCheckIn needs from outside, so that a test can replace each of them.
 * @typedef {object} CheckInDeps
 * @property {typeof import('../api/client.js').api} api
 * @property {typeof import('./geo.js').getFix} getFix
 * @property {ReturnType<typeof import('./scanQueue.js').createQueue>} queue
 * @property {() => string} newId  a new scan id
 * @property {() => Date} now
 */

/** @typedef {'locating' | 'saving'} CheckInPhase */

/**
 * @typedef {object} CheckInArgs
 * @property {string} code  the scanned QR address
 * @property {PublicPoint | null | undefined} point  null or undefined when the phone does not know the point yet
 * @property {Session} session
 * @property {CheckInDeps} deps
 * @property {(phase: CheckInPhase) => void} [onPhase]  told when the journey moves to the next step
 */

/**
 * The answer of performCheckIn, by `kind`. A `queued` visit says whether it is `located`: false when the point asks for a
 * position and the saved visit has none that the server can use.
 * @typedef {{ kind: 'success' | 'duplicate', scan: Scan }
 *   | { kind: 'far', scan: Scan }
 *   | { kind: 'needLocation', scan: Scan, locationReason: string | null }
 *   | { kind: 'queued', id: string, client_time: string, persisted: boolean, located: boolean }
 *   | { kind: 'signedOut', code: string }
 *   | { kind: 'error', code: string }} CheckInResult
 */

/**
 * @param {CheckInArgs} args
 * @returns {Promise<CheckInResult>}
 */
export async function performCheckIn({ code, point, session, deps, onPhase = () => {} }) {
  const { api, getFix, queue, newId, now } = deps
  const id = newId()
  const client_time = now().toISOString()

  let gps = null
  let locationReason = null
  if (point?.gps_mode !== GPS_MODE_NONE) {
    onPhase('locating')
    // A point that MUST verify location waits a few seconds for a precise reading (src/worker/geo.js), and it is always a
    // fresh one: a position the phone remembers from a few minutes earlier (fine for "optional" points, and quicker) would
    // let someone scan right after leaving the building. It is precise because the quick estimate of a network (up to 150 m)
    // would widen the fence by up to 50 m: the server counts the accuracy that the phone reports.
    const res = await getFix(point?.gps_mode === GPS_MODE_REQUIRED ? { precise: true } : undefined)
    gps = res.fix
    locationReason = res.reason
  }

  onPhase('saving')
  try {
    /** @type {ScanResponse} */
    const res = await api('/scan', {
      method: 'POST',
      token: session.token,
      timeoutMs: 8000,
      body: { id, code, client_time, gps },
    })
    const scan = res.scan
    if (scan.outcome === OUTCOME_REJECTED_FAR) return { kind: 'far', scan }
    if (scan.outcome === OUTCOME_REJECTED_NO_LOCATION) return { kind: 'needLocation', scan, locationReason }
    return { kind: res.duplicate ? 'duplicate' : 'success', scan }
  } catch (err) {
    if (err.status === 401) return { kind: 'signedOut', code: err.code } // the code that the server answered: the app notes it (src/ui/errorReport.js)
    if (err.transient) {
      // No signal (or a server hiccup): keep the visit on the phone. The same id is reused on upload,
      // so if the server did receive it after all, the retry cannot create a second record.
      const persisted = queue.add({ id, code, client_time, gps, provider_id: session.provider.id, saved_at: client_time, point_name: point?.name })
      // persisted=false: the phone refused to store it, so it only survives while this page stays open.
      // located=false: the point asks for a position and the visit carries none that the server can use (no reception often means
      // no fresh position either), so the screen warns that the server may refuse it when it is sent. A point that does not check
      // the location never asked for one, so there is nothing missing to warn about.
      const located = point?.gps_mode === GPS_MODE_NONE || isUsableFix(gps)
      return { kind: 'queued', id, client_time, persisted, located }
    }
    return { kind: 'error', code: err.code }
  }
}
