// What an app tells the server about its own errors (ADR 0007, decision 3; docs/privacy.md, "What the two apps report"): a screen that
// crashed, an error that nothing caught, and a session that the server ended. The provider app and the committee app share this file.
//
// There are three parts, and none of them logs anything or throws, whatever the storage or the network does:
//   - the OUTBOX: a note of each event, on the device, under `qr.errors.v1`, aggregated (one entry per kind, screen, name, code and
//     build, with a count) and capped. An event is noted where it happens (src/ui/crash.js for a crash and for an error that nothing
//     caught, the sign-out of each app for a session that the server ended) and waits there until a report can go out. A crash before
//     sign-in therefore waits for the next sign-in: both endpoints need a session, there is no public one on purpose;
//   - the PLACE: the screen that the app is showing, written by the app while it renders (setPlace) and read when something breaks.
//     It is the app's own state (the view or the tab) and never the address;
//   - the REPORTER: sends the outbox of one app to the endpoint of its role, through the app's own API client, and removes what the
//     server took. The apps call report() when somebody has signed in, when the app has started and the server has confirmed the
//     session, and when the app comes back to the foreground; it decides by itself whether to send.
//
// What is stored and sent (shared/contract.js, section 9, and the ClientErrorEvent of shared/types.js): `kind`, `place`, `name` (the
// class of an error), `code` (a short word such as `invalid_session`), `build` and `count`. Every value is checked against the contract
// before it is stored, again when it is read back, and an invalid value is dropped. Never a message, a stack, an address, a body, a
// token, a name, a QR code or a position: noteClientError takes four fields and ignores whatever else it is given, so the only way to
// put something in the outbox is one of those fields, and each has a fixed shape.
import { safeStorage, readJson } from '../worker/storage.js'
import { currentApp } from '../appKind.js'
import { APP_BUILD } from './build.js'
import {
  APP_BUILD_RE,
  CLIENT_ERROR_CODE_RE,
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_MAX_COUNT,
  CLIENT_PLACES,
  ERROR_NAME_RE,
  MAX_CLIENT_ERROR_EVENTS,
} from '../../shared/contract.js'

/** @import { ClientErrorEvent, ClientErrorReport } from '../../shared/types.js' */
/** @import { StorageLike } from '../worker/storage.js' */

/** Where the outbox lives on the device. A change of its shape is a new key (the same rule as the queue's `qr.queue.v1`). */
export const ERRORS_KEY = 'qr.errors.v1'

/** The shortest time between two reports of one run of an app. */
export const ERROR_REPORT_MIN_INTERVAL_MS = 60 * 1000

/**
 * An event of the outbox: a ClientErrorEvent with its `count` always there (how many times it happened since it was last sent).
 * @typedef {ClientErrorEvent & { count: number }} OutboxEvent
 */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Is this the same entry of the outbox: the same kind, screen, name, code and build? */
const sameEntry = (a, b) =>
  a.kind === b.kind && a.place === b.place && a.name === b.name && a.code === b.code && a.build === b.build

/**
 * An event as the contract allows it, built from the known fields only, or null when it has no valid `kind` and `place` (the server
 * would ignore it, so it is not kept). A `name`, a `code` or a `build` that does not have its shape is left out, and the event stays.
 * `count` is a whole number from 1 up to CLIENT_ERROR_MAX_COUNT, else 1.
 * @param {any} raw  anything: what a caller passed, or what was read from the storage
 * @returns {OutboxEvent | null}
 */
function cleanEvent(raw) {
  if (!isRecord(raw)) return null
  const { kind, place, name, code, build, count } = raw
  if (!CLIENT_ERROR_KINDS.includes(kind) || !CLIENT_PLACES.includes(place)) return null
  /** @type {OutboxEvent} */
  const event = { kind, place, count: Number.isInteger(count) ? Math.min(Math.max(count, 1), CLIENT_ERROR_MAX_COUNT) : 1 }
  if (typeof name === 'string' && ERROR_NAME_RE.test(name)) event.name = name
  if (typeof code === 'string' && CLIENT_ERROR_CODE_RE.test(code)) event.code = code
  if (typeof build === 'string' && APP_BUILD_RE.test(build)) event.build = build
  return event
}

/**
 * The outbox as it is stored now, every entry rebuilt through cleanEvent (so a value that was edited, or written by another version,
 * is checked the way a new one is), equal entries joined and no more than MAX_CLIENT_ERROR_EVENTS of them. A missing, corrupt or
 * not-ours value is an empty outbox. Never throws.
 * @param {StorageLike} [storage]
 * @returns {OutboxEvent[]}
 */
export function readOutbox(storage = safeStorage) {
  const stored = readJson(storage, ERRORS_KEY, [])
  if (!Array.isArray(stored)) return []
  /** @type {OutboxEvent[]} */
  const events = []
  for (const raw of stored) {
    const event = cleanEvent(raw)
    if (!event) continue
    const same = events.find((e) => sameEntry(e, event))
    if (same) same.count = Math.min(same.count + event.count, CLIENT_ERROR_MAX_COUNT)
    else if (events.length < MAX_CLIENT_ERROR_EVENTS) events.push(event)
  }
  return events
}

/**
 * Writes the outbox, or removes it when it is empty. A storage that refuses is not an error: the safe storage keeps it in memory, and
 * one that throws loses the note, which is better than a second error.
 * @returns {boolean}  false when the storage threw
 */
function writeOutbox(events, storage) {
  try {
    if (events.length) storage.setItem(ERRORS_KEY, JSON.stringify(events))
    else storage.removeItem(ERRORS_KEY)
    return true
  } catch {
    return false
  }
}

/**
 * Notes that something happened. Aggregated with an entry of the same kind, screen, name, code and build (its count goes up, to
 * CLIENT_ERROR_MAX_COUNT at most); at MAX_CLIENT_ERROR_EVENTS entries a new one is dropped, so the outbox cannot grow. The build is the
 * one that is running (APP_BUILD). Only the four fields below are read: a message, a stack, an address or anything else that is
 * passed along is ignored. Never throws and never logs, so it may be called from any error handler.
 * @param {{ kind: string, place: string, name?: string, code?: string }} input  `kind` of CLIENT_ERROR_KINDS, `place` of CLIENT_PLACES
 *   (src/ui/errorReport.js currentPlace), `name` the class of an error (ERROR_NAME_RE), `code` a short word (CLIENT_ERROR_CODE_RE)
 * @param {StorageLike} [storage]
 * @returns {boolean}  true when the event was written to the outbox (false: it is not valid, the outbox is full of other entries, or the
 *   storage threw)
 */
export function noteClientError(input, storage = safeStorage) {
  try {
    const { kind, place, name, code } = input ?? {}
    const event = cleanEvent({ kind, place, name, code, build: APP_BUILD, count: 1 })
    if (!event) return false
    const events = readOutbox(storage)
    const same = events.find((e) => sameEntry(e, event))
    if (same) same.count = Math.min(same.count + 1, CLIENT_ERROR_MAX_COUNT)
    else if (events.length < MAX_CLIENT_ERROR_EVENTS) events.push(event)
    else return false
    return writeOutbox(events, storage)
  } catch {
    return false
  }
}

/**
 * Takes out what a report carried, once the server has taken it: each entry loses the count that was sent, and goes when nothing is left.
 * What was noted while the report was on its way (a higher count, a new entry) stays.
 * @param {OutboxEvent[]} sent
 * @param {StorageLike} [storage]
 */
export function removeSent(sent, storage = safeStorage) {
  try {
    /** @type {OutboxEvent[]} */
    const left = []
    for (const event of readOutbox(storage)) {
      const was = sent.find((s) => sameEntry(s, event))
      const rest = event.count - (was ? was.count : 0)
      if (rest > 0) left.push({ ...event, count: rest })
    }
    writeOutbox(left, storage)
  } catch {
    /* nothing to do: the entries stay and go with the next report */
  }
}

// ---- the place -------------------------------------------------------------------------------------------------------

let shown = null

/**
 * Says which screen the app is showing: a key of CLIENT_PLACES (`provider:home`, `committee:history`, ...). The app calls it while it
 * renders (WorkerShell, AdminApp and Shell), on purpose and not in an effect: a screen that breaks the first time it is drawn never
 * reaches an effect, and the crash would be put on the screen before it. The value is only read when something breaks, so writing it
 * during a render that React throws away does no harm.
 * @param {string | null} place
 */
export function setPlace(place) {
  shown = typeof place === 'string' ? place : null
}

/**
 * The screen to put on an event: the one that the app said it is showing, else `provider:app` or `committee:app` (a crash outside any
 * screen: the language provider, the boundary above everything, a screen that is still being downloaded). A key that is not in
 * CLIENT_PLACES falls back to the same, so a wrong key costs precision and never the event. It is not read from the address: only
 * the app (which of the two it is) comes from there, as everywhere else (src/appKind.js).
 * @returns {string}
 */
export function currentPlace() {
  return shown !== null && CLIENT_PLACES.includes(shown) ? shown : `${currentApp()}:app`
}

// ---- the report ------------------------------------------------------------------------------------------------------

/**
 * The event as it goes on the wire: the known fields, a field that has no value left out.
 * @param {OutboxEvent} entry
 * @returns {ClientErrorEvent}
 */
function wireEvent({ kind, place, name, code, build, count }) {
  /** @type {ClientErrorEvent} */
  const event = { kind, place }
  if (name !== undefined) event.name = name
  if (code !== undefined) event.code = code
  if (build !== undefined) event.build = build
  event.count = count
  return event
}

/**
 * @typedef {object} ErrorReporterOptions
 * @property {string} app  `provider` or `committee` (src/appKind.js): the reporter sends only the entries whose screen key starts with
 *   `<app>:`, because the outbox is shared by the two apps (they share the origin) and the endpoint of a role takes only its own
 * @property {() => any} getSession  who is signed in NOW: whatever `send` needs (the provider's token, `true` for the committee), or a
 *   falsy value for nobody. Read again each time
 * @property {(body: ClientErrorReport, session: any) => Promise<any>} send  the app's own API client: POSTs the body to the endpoint
 *   of the role and returns the parsed answer, or throws an error with a `status` and a `code` (ApiError of src/api/client.js)
 * @property {(session: any, code: string) => void} onUnauthorized  told when the server refused the session (a 401), with the code that
 *   it answered, so that the app handles it the way it handles a 401 of any other call. The reporter has no sign-out of its own
 * @property {StorageLike} [storage]
 * @property {() => number} [now]  ms
 * @property {() => boolean} [isOnline]
 */

/**
 * The ways a call of `report()` can end. It never rejects and never logs.
 * @typedef {'sent' | 'failed' | 'empty' | 'skipped' | 'throttled' | 'offline' | 'stopped' | 'unauthorized'} ErrorReportOutcome
 */

/**
 * The reporter of one run of an app. `report()` is safe to call at any time and as often as you like: it decides by itself whether to send.
 *  - never for nobody, never while the device says it is offline, never two at once, and never when this app has nothing noted;
 *  - at most one request a minute (ERROR_REPORT_MIN_INTERVAL_MS after the last attempt, a failed one included). A call that comes too
 *    soon is dropped, not kept: the next call after the minute sends what is noted by then;
 *  - at most MAX_CLIENT_ERROR_EVENTS entries in a request (the outbox holds no more);
 *  - a 200 `{ ok: true }` removes what was sent; a 404 (a server from before the endpoint) stops it for the rest of this run and keeps
 *    the entries; a 401 is handed to `onUnauthorized` and keeps them; anything else keeps them for the next time.
 * @param {ErrorReporterOptions} options
 */
export function createErrorReporter({
  app,
  getSession,
  send,
  onUnauthorized,
  storage = safeStorage,
  now = Date.now,
  isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false,
}) {
  const prefix = `${app}:`
  let stopped = false // the server has no such endpoint (404): not again in this run
  let inFlight = false
  let lastAt = null // when the last attempt ended

  /** @returns {Promise<ErrorReportOutcome>} */
  async function report() {
    if (stopped) return 'stopped'
    if (inFlight) return 'skipped'
    const session = getSession()
    if (!session) return 'skipped'
    if (!isOnline()) return 'offline'

    const events = readOutbox(storage).filter((event) => event.place.startsWith(prefix))
    if (!events.length) return 'empty'

    const t = now()
    if (lastAt !== null && t >= lastAt && t - lastAt < ERROR_REPORT_MIN_INTERVAL_MS) return 'throttled' // a clock set back is no reason to wait

    inFlight = true
    /** @type {ErrorReportOutcome} */
    let outcome = 'failed'
    let refusedWith = ''
    try {
      const answer = await send({ events: events.map(wireEvent) }, session)
      if (answer?.ok === true) {
        removeSent(events, storage)
        outcome = 'sent'
      }
    } catch (err) {
      if (err?.status === 404) {
        stopped = true
        outcome = 'stopped'
      } else if (err?.status === 401) {
        outcome = 'unauthorized'
        refusedWith = typeof err.code === 'string' ? err.code : ''
      }
    } finally {
      inFlight = false
      lastAt = now()
    }
    if (outcome === 'unauthorized') {
      try {
        onUnauthorized(session, refusedWith)
      } catch {
        /* the app's own sign-out failed: a report never throws */
      }
    }
    return outcome
  }

  return { report }
}
