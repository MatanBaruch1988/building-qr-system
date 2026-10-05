import { route } from '../router.js'
import { recordEvent } from '../errorLog.js'
import { noteAppError } from '../alerts.js'
import { ERROR_RECORD_TIMEOUT_MS } from '../config.js'
import {
  APP_BUILD_RE,
  CLIENT_ERROR_CODE_RE,
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_MAX_COUNT,
  CLIENT_PLACES,
  ERROR_NAME_RE,
  MAX_CLIENT_ERROR_EVENTS,
} from '../../shared/contract.js'

/** @import { ClientErrorAnswer, ClientErrorEvent } from '../../shared/types.js' */

// What the two apps report about their errors (ADR 0007, decision 3; the limits are in section 9 of shared/contract.js, the shapes in
// shared/types.js): a crash or an unhandled error in the provider's app, in the committee app, and a session that the server ended.
// There are two endpoints, one for each role, and no public one, so nobody who is not signed in can write to app_errors:
//   - POST /api/my/errors: the provider's phone. `/my/.*` belongs to the provider's guard (server/access.js), which the router runs
//     before this handler;
//   - POST /api/admin/client-errors: the committee app, guarded as every `/admin/` route is.
// Both read the body only through parseClientErrorReport, which never throws and ignores whatever is not valid, and answer the same way
// whatever they were sent: 200 `{ ok: true, recorded }`, never a 400 for an event (a newer app may send more than this server
// knows). Each endpoint takes only the screen keys of its own app. The handlers do not ask who is signed in and store nothing about
// who sent the report: not the provider, not the phone, not the member.
//
// What is stored (AGENTS.md, Safety), through recordEvent of server/errorLog.js and nothing else: the source (`provider_app` or
// `committee_app`), the kind, the screen key as the place, the error's code or else its name, the build and a count. Never a message,
// a stack, an address, a body, a token, a name, a QR code or a position: a field that is not in the list above is never read, and the
// name, the code and the build are kept only in the shape that the contract gives them. Recording is bounded like every record
// (recordEvent: it never queues for a connection and waits for the database at most ERROR_RECORD_TIMEOUT_MS), and a report is bounded
// to the first event whose insert used up that wait: the database is not answering, and the others would wait just as long.
//
// A crash or an unhandled error is also the first error of the building day when no other error came before it, and then it tells
// the owner (noteAppError of server/alerts.js, one ping a day for an error of any kind). A signed-out event never does.

// The screen keys of each app start with the same word as the source of the app. An endpoint takes only its own.
const PLACE_PREFIX = Object.freeze({ provider_app: 'provider:', committee_app: 'committee:' })

// The kinds that tell the owner. `signed_out` is only counted: a session that ends is not a fault.
const ALERTING_KINDS = Object.freeze(['crash', 'unhandled'])

const shaped = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : undefined)

/**
 * The events of a report that this server takes, for the app `source` (`provider_app` or `committee_app`). Pure and never throws,
 * for any body. Nobody has checked the body: it is read as an object with `events` only, and each event only through the fields below.
 *  - `events` that is not an array gives no events, and only the first MAX_CLIENT_ERROR_EVENTS of an array are looked at;
 *  - an event needs a `kind` of CLIENT_ERROR_KINDS and a `place` of CLIENT_PLACES that belongs to this app, else it is skipped;
 *  - `name` (ERROR_NAME_RE), `code` (CLIENT_ERROR_CODE_RE) and `build` (APP_BUILD_RE) are kept when they have their shape and left out
 *    otherwise (the event is still taken);
 *  - `count` is a whole number cut to 1..CLIENT_ERROR_MAX_COUNT, else 1;
 *  - every other field is ignored, and none is looked at.
 * @param {unknown} body  the parsed JSON of the request
 * @param {string} source  `provider_app` or `committee_app`; any other source takes nothing
 * @returns {Array<ClientErrorEvent & { count: number }>}
 */
export function parseClientErrorReport(body, source) {
  try {
    const prefix = Object.hasOwn(PLACE_PREFIX, source) ? PLACE_PREFIX[source] : null
    const list = /** @type {{ events?: unknown } | null | undefined} */ (body)?.events
    if (prefix === null || !Array.isArray(list)) return []
    const events = []
    for (const item of list.slice(0, MAX_CLIENT_ERROR_EVENTS)) {
      if (item === null || typeof item !== 'object') continue
      const { kind, place, name, code, build, count } = item
      if (!CLIENT_ERROR_KINDS.includes(kind) || !CLIENT_PLACES.includes(place) || !place.startsWith(prefix)) continue
      events.push({
        kind,
        place,
        name: shaped(name, ERROR_NAME_RE),
        code: shaped(code, CLIENT_ERROR_CODE_RE),
        build: shaped(build, APP_BUILD_RE),
        count: Number.isInteger(count) ? Math.min(Math.max(count, 1), CLIENT_ERROR_MAX_COUNT) : 1,
      })
    }
    return events
  } catch {
    return [] // an object that cannot be read (a getter that throws): nothing is taken
  }
}

/** What an event is recorded as: its code, else its name, else nothing. */
const labelOf = (event) => event.code ?? event.name ?? ''

// An insert that took this long used up the wait of recordEvent. A timer can fire a few milliseconds early, hence the margin.
const USED_UP_THE_WAIT_MS = ERROR_RECORD_TIMEOUT_MS - 10

/**
 * Records the events of a report one after the other, up to the first insert that used up its wait (USED_UP_THE_WAIT_MS: the rest are
 * not tried, so the request waits for one timeout at most and not for twenty), then tells the owner about the first crash or unhandled
 * error of it (one ping at most, however many there are: the day row decides whether it is the first of the day).
 * @param {string} source  `provider_app` or `committee_app`
 * @param {unknown} body
 * @returns {Promise<ClientErrorAnswer>}
 */
async function recordReport(source, body) {
  const events = parseClientErrorReport(body, source)
  for (const event of events) {
    const started = Date.now()
    await recordEvent({
      source,
      kind: event.kind,
      place: event.place,
      method: '',
      status: 0,
      code: labelOf(event),
      appBuild: event.build ?? '',
      count: event.count,
    })
    if (Date.now() - started >= USED_UP_THE_WAIT_MS) break
  }
  const alerting = events.find((event) => ALERTING_KINDS.includes(event.kind))
  if (alerting) await noteAppError({ source, place: alerting.place, code: labelOf(alerting), build: alerting.build })
  return { ok: true, recorded: events.length }
}

route('POST', '/my/errors', async ({ body }) => recordReport('provider_app', body))
route('POST', '/admin/client-errors', async ({ body }) => recordReport('committee_app', body))
