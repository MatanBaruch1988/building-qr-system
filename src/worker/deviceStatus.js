// What the phone tells the server about itself (ADR 0007, decision 4, "Phone health"): how many visits wait in its offline queue
// and since when, which build it runs, and how many visits it had to give up since this person signed in. The server keeps it on
// the row of the phone (server/deviceStatus.js, POST /api/my/device-status) and the committee reads it. Best effort by design: a
// report that cannot be sent is not an error, it never reaches the console, and nothing the person does waits for it.
//
// Two kinds of numbers, kept apart:
//   - `waiting` and `oldest_waiting_at` are read from the queue each time (what is true now);
//   - `not_accepted_total` and `overflowed_total` are counts that the queue writes as it happens and that only grow: they are
//     kept in `qr.health.v1` from the moment a person signs in (a new device token) until they sign out, and a report only
//     SENDS them, it never resets them. The server keeps the larger of what it has and what it gets, so a report that is sent
//     twice (an answer that was lost, a retry) changes nothing, and a report that is dropped loses nothing: the next one carries
//     the same totals and more.
import { safeStorage, readJson } from './storage.js'
import { APP_BUILD } from '../ui/build.js'
import { SYNC_QUEUE_MAX_ITEMS, DEVICE_STATUS_MIN_INTERVAL_S, DEVICE_STATUS_MAX_TOTAL } from '../../shared/contract.js'

/** @import { DeviceStatusReport } from '../../shared/types.js' */
/** @import { StorageLike } from './storage.js' */
/** @import { Queue, QueuedScan } from './scanQueue.js' */

const KEY = 'qr.health.v1'

/**
 * How often a phone whose queue has not changed reports again: a report says what is waiting NOW, so a stuck phone repeats it
 * (the committee sees that it is alive and still waiting) and a phone that nothing happens on stays quiet. A report is sent
 * sooner when what it says has changed (how many wait, since when, the totals), never sooner than DEVICE_STATUS_MIN_INTERVAL_S
 * after the last one.
 */
export const REPORT_EVERY_MS = 10 * 60 * 1000

// ---- the totals ------------------------------------------------------------------------------------------------------

/**
 * What the queue counts, from the moment a person signed in on this phone (stored under `qr.health.v1`, which is read back
 * whatever it holds: a value that is not a whole number counts as 0).
 * @typedef {object} Health
 * @property {number} not_accepted_total  queued visits that the server refused for good (a permanent code), so the phone dropped them
 * @property {number} overflowed_total  queued visits that left a full queue (the oldest go first)
 */

/** A total as it is stored: a whole number from 0 up, cut to what the server takes (DEVICE_STATUS_MAX_TOTAL), anything else is 0. */
const totalOf = (value) => (Number.isInteger(value) && value > 0 ? Math.min(value, DEVICE_STATUS_MAX_TOTAL) : 0)

/**
 * The totals of this phone. A missing, corrupt or not-ours value is read as zeros, and nothing here throws.
 * @param {StorageLike} [storage]
 * @returns {Health}
 */
export function readHealth(storage = safeStorage) {
  const stored = readJson(storage, KEY, null)
  const record = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  return { not_accepted_total: totalOf(record.not_accepted_total), overflowed_total: totalOf(record.overflowed_total) }
}

/**
 * Adds to the totals. Called by the queue where the visits leave it (src/worker/scanQueue.js), so the count is made where it
 * happens and in the same step. Never throws: a phone whose storage refuses the write only misses a count.
 * @param {{ not_accepted?: number, overflowed?: number }} more  how many visits to add to each total
 * @param {StorageLike} [storage]
 */
export function addToHealth({ not_accepted = 0, overflowed = 0 }, storage = safeStorage) {
  const add = (n) => (Number.isInteger(n) && n > 0 ? n : 0)
  if (!add(not_accepted) && !add(overflowed)) return
  const now = readHealth(storage)
  const next = {
    not_accepted_total: totalOf(now.not_accepted_total + add(not_accepted)),
    overflowed_total: totalOf(now.overflowed_total + add(overflowed)),
  }
  try {
    storage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage refused: the count is lost, which is better than a crash */
  }
}

/**
 * Back to zero: a person signed in (a new device token starts a new row on the server) or signed out. Called by src/worker/session.js.
 * @param {StorageLike} [storage]
 */
export function resetHealth(storage = safeStorage) {
  try {
    storage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

// ---- the report ------------------------------------------------------------------------------------------------------

/** The time of a queued visit in ms: when it was saved on the phone, else (an older version did not write that) its own time. */
function savedAt(item) {
  for (const value of [item?.saved_at, item?.client_time]) {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/**
 * What the phone reports now: the queue of the person who is signed in (the visits that this sign-in can upload; on a shared
 * phone the rest wait for their owners), and the totals. `oldest_waiting_at` is the earliest save time, as an ISO time that
 * `Date` wrote, or null when nothing waits or no item has a time that can be read.
 * @param {QueuedScan[]} items  the queue of the person who is signed in
 * @param {Health} health
 * @returns {DeviceStatusReport}
 */
export function buildReport(items, health) {
  const times = items.map(savedAt).filter((ms) => ms !== null)
  return {
    build: APP_BUILD,
    waiting: Math.min(items.length, SYNC_QUEUE_MAX_ITEMS),
    oldest_waiting_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
    not_accepted_total: health.not_accepted_total,
    overflowed_total: health.overflowed_total,
  }
}

/**
 * Does this report say what the last one said? The build does not count (it is the same for the whole run). What does: how many
 * wait, since when the oldest has waited, and the two totals. A refusal or a drop that leaves the number that waits where it was
 * (a visit that was saved and refused between two reports) must still reach the committee, and when the queue is empty nothing
 * else would ask for a report until the app is opened again.
 * @param {DeviceStatusReport} a
 * @param {DeviceStatusReport} b
 */
const sameState = (a, b) =>
  a.waiting === b.waiting &&
  a.oldest_waiting_at === b.oldest_waiting_at &&
  a.not_accepted_total === b.not_accepted_total &&
  a.overflowed_total === b.overflowed_total

/**
 * @typedef {object} ReporterOptions
 * @property {Queue} queue
 * @property {typeof import('../api/client.js').api} api
 * @property {() => { token: string, providerId: string } | null} getSession  who is signed in NOW (read again each time: a report
 *   that waits for its turn must not be sent for a person who has left)
 * @property {(token: string) => void} onUnauthorized  told when the server refused the token, so the app signs out the way it does
 *   for any other call
 * @property {StorageLike} [storage]
 * @property {() => number} [now]  ms
 * @property {() => boolean} [isOnline]
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(timer: any) => void} [clearTimer]
 */

/**
 * The ways a call of `report()` can end. It never rejects and never logs.
 * @typedef {'sent' | 'failed' | 'skipped' | 'deferred' | 'offline' | 'stopped' | 'unauthorized'} ReportOutcome
 */

/**
 * The reporter of one run of the app. `report()` is safe to call at any time and as often as you like: it decides by itself
 * whether to send.
 *  - never while the phone says it is offline, never for nobody, never two at once (a call that comes while one is on its way
 *    is looked at when that one has ended, by these same rules);
 *  - an unchanged state is reported at most once every REPORT_EVERY_MS; a changed one (see sameState) at once, but never within
 *    DEVICE_STATUS_MIN_INTERVAL_S of the last attempt (the server would answer 200 and store nothing). What the minimum
 *    held back is sent when it has passed, once (`deferred`), so the last state is never lost to the throttle;
 *  - a 404 (a server from before this endpoint, rolled back) stops it until the app starts again; a 401 is handed to
 *    `onUnauthorized`; any other failure changes nothing (the totals are the phone's own and the next report sends them again).
 * @param {ReporterOptions} options
 */
export function createDeviceReporter({
  queue,
  api,
  getSession,
  onUnauthorized,
  storage = safeStorage,
  now = Date.now,
  isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const minGapMs = DEVICE_STATUS_MIN_INTERVAL_S * 1000
  let stopped = false // the server has no such endpoint (404): not again in this run
  let inFlight = false
  let again = false // a call came while a report was on its way: it is looked at when that one has ended, not dropped
  let timer = null
  /** The last attempt of this run, sent or failed: when it ended, for whom, and what it said. */
  let last = null

  const cancelTimer = () => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  /** Reports again once `ms` have passed (one timer at most), with whatever is true then. */
  function later(ms) {
    if (timer !== null) return
    timer = setTimer(() => {
      timer = null
      void report()
    }, ms + 250) // a little over, so that the minimum has passed on the server's clock too
  }

  /** @returns {Promise<ReportOutcome>} */
  async function report() {
    if (stopped) return 'stopped'
    if (inFlight) {
      again = true
      return 'skipped'
    }
    const session = getSession()
    if (!session) return 'skipped'
    if (!isOnline()) return 'offline'

    /** @type {DeviceStatusReport} */
    let body
    try {
      body = buildReport(queue.list(session.providerId), readHealth(storage))
    } catch {
      return 'skipped' // a queue that cannot be read (corrupt storage) has nothing to report
    }

    const t = now()
    const before = last !== null && last.token === session.token && t >= last.at ? last : null // a clock set back: not a reason to wait
    if (before && sameState(before.state, body) && t - before.at < REPORT_EVERY_MS) return 'skipped'
    if (before && t - before.at < minGapMs) {
      later(minGapMs - (t - before.at))
      return 'deferred'
    }

    inFlight = true
    /** @type {ReportOutcome} */
    let outcome = 'failed'
    try {
      const answer = await api('/my/device-status', { method: 'POST', token: session.token, timeoutMs: 8000, body })
      if (answer?.ok === true) outcome = 'sent'
    } catch (err) {
      if (err?.status === 404) {
        stopped = true
        cancelTimer()
        outcome = 'stopped'
      } else if (err?.status === 401) outcome = 'unauthorized'
    } finally {
      inFlight = false
      last = { at: now(), token: session.token, state: body }
    }
    const rerun = again
    again = false
    if (outcome === 'unauthorized') onUnauthorized(session.token)
    else if (rerun) void report() // by the same rules: an unchanged queue is skipped, a changed one waits for the minimum
    return outcome
  }

  return { report, stop: cancelTimer }
}
