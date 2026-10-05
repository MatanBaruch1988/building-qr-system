import { safeStorage, readJson } from './storage.js'
import { addToHealth } from './deviceStatus.js'
import {
  SYNC_CHUNK_SIZE, SYNC_QUEUE_MAX_ITEMS, SYNC_PERMANENT_ERROR_CODES, OUTCOME_ACCEPTED,
} from '../../shared/contract.js'

/** @import { SyncItem, SyncRequest, SyncResponse } from '../../shared/types.js' */
/** @import { StorageLike } from './storage.js' */

const KEY = 'qr.queue.v1'
// The queue size, the size of one upload and the codes below are the phone's side of the sync contract with the server,
// written once in shared/contract.js (tests/contract.test.js keeps the chunk under the server's MAX_SYNC_BATCH).
const MAX_ITEMS = SYNC_QUEUE_MAX_ITEMS
// The server handles a batch item by item (about ten database round trips each), so keep batches small
// enough to finish well inside the request timeout even on a slow connection or a sleeping database.
const BATCH = SYNC_CHUNK_SIZE // must not exceed the server's MAX_SYNC_BATCH

// The server refuses these for good; retrying would never help, so the item is dropped and counted.
const PERMANENT = new Set(SYNC_PERMANENT_ERROR_CODES)

/**
 * One saved check-in: what the sync upload sends (`SyncItem`) and what only the phone keeps. The queue key is versioned
 * (`qr.queue.v1`) because an old version of the app writes items too: an item may lack a field that a newer one adds.
 * @typedef {SyncItem & { provider_id: string, saved_at: string, point_name?: string }} QueuedScan
 */

/** @typedef {ReturnType<typeof createQueue>} Queue */

/**
 * Check-ins saved on the phone while it had no signal. Each item carries the id the server uses for
 * idempotency, so a retry after a half-finished upload can never create a duplicate visit.
 * @param {StorageLike} [storage]
 */
export function createQueue(storage = safeStorage) {
  const read = () => readJson(storage, KEY, [])
  // The cap keeps the newest items. The oldest ones that it drops are counted (qr.health.v1, src/worker/deviceStatus.js), so
  // the committee can tell a phone that lost visits from one that did not. The stored format of the queue is unchanged.
  const write = (items) => {
    const kept = items.slice(-MAX_ITEMS)
    const saved = storage.setItem(KEY, JSON.stringify(kept))
    if (items.length > kept.length) addToHealth({ overflowed: items.length - kept.length }, storage)
    return saved
  }
  return {
    /**
     * @param {string} providerId
     * @returns {QueuedScan[]}
     */
    list: (providerId) => read().filter((i) => i.provider_id === providerId),
    /**
     * @param {QueuedScan} item
     * @returns {boolean} false when the item is held in memory only (persistent storage refused it)
     */
    add(item) {
      const items = read()
      if (items.some((i) => i.id === item.id)) return true
      return write([...items, item]) !== false
    },
    /**
     * @param {string[]} ids  the items that leave the queue
     * @param {{ notAccepted?: number }} [why]  how many of them the server refused for good (a permanent code): they are
     *   counted in the same call as the removal, so a refusal is counted once
     */
    remove(ids, { notAccepted = 0 } = {}) {
      const drop = new Set(ids)
      write(read().filter((i) => !drop.has(i.id)))
      addToHealth({ not_accepted: notAccepted }, storage)
    },
  }
}

/**
 * Uploads this provider's saved check-ins. Returns { sent, rejected, dropped, remaining }:
 *  - sent     recorded as attendance,
 *  - rejected the server stored the attempt but did not count it (e.g. clearly far away): the person has
 *             left the point, so they must be told rather than shown a green "sent",
 *  - dropped  refused for good (unknown code, point removed, …).
 * Throws ApiError only for a 401 (the caller signs the person out); network trouble just stops early.
 * @param {object} args
 * @param {Queue} args.queue
 * @param {typeof import('../api/client.js').api} args.api
 * @param {string} args.token  the provider's device token
 * @param {string} args.providerId  whose check-ins to upload
 * @returns {Promise<{ sent: number, rejected: number, dropped: number, remaining: number }>}
 */
export async function flushQueue({ queue, api, token, providerId }) {
  let sent = 0
  let rejected = 0
  let dropped = 0
  // Hard cap on rounds: the queue holds at most MAX_ITEMS, so this can never spin forever.
  for (let round = 0; round <= MAX_ITEMS / BATCH + 1; round++) {
    const items = queue.list(providerId).slice(0, BATCH)
    if (!items.length) break
    const inBatch = new Set(items.map((i) => i.id))
    /** @type {SyncResponse} */
    let res
    try {
      res = await api('/scans/sync', {
        method: 'POST',
        token,
        timeoutMs: 8000 + 1500 * items.length,
        body: /** @type {SyncRequest} */ ({ scans: items.map(({ id, code, client_time, gps }) => ({ id, code, client_time, gps })) }),
      })
    } catch (err) {
      if (err.status === 401) throw err
      break // no signal / server hiccup: keep everything for the next attempt
    }
    const done = []
    let refused = 0 // of `done`, the ones that the server refused for good
    for (const r of res.results) {
      if (!inBatch.has(r.id)) continue // never trust ids we did not send
      if (r.ok) {
        if (r.scan?.outcome && r.scan.outcome !== OUTCOME_ACCEPTED) rejected++
        else sent++
        done.push(r.id)
      } else if (PERMANENT.has(r.error?.code)) {
        dropped++
        refused++
        done.push(r.id)
      }
    }
    if (!done.length) break // nothing progressed: avoid spinning on a stuck batch
    queue.remove(done, { notAccepted: refused })
  }
  return { sent, rejected, dropped, remaining: queue.list(providerId).length }
}
