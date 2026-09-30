import { safeStorage, readJson } from './storage.js'

const KEY = 'qr.queue.v1'
const MAX_ITEMS = 500
// The server handles a batch item by item (about ten database round trips each), so keep batches small
// enough to finish well inside the request timeout even on a slow connection or a sleeping database.
const BATCH = 10 // must not exceed the server's MAX_SYNC_BATCH

// The server refuses these for good; retrying would never help, so the item is dropped and counted.
const PERMANENT = new Set([
  'invalid_code', 'unknown_code', 'point_inactive', 'not_assigned', 'invalid_scan_id', 'scan_id_conflict',
  'invalid_item',
])

/**
 * Check-ins saved on the phone while it had no signal. Each item carries the id the server uses for
 * idempotency, so a retry after a half-finished upload can never create a duplicate visit.
 */
export function createQueue(storage = safeStorage) {
  const read = () => readJson(storage, KEY, [])
  const write = (items) => storage.setItem(KEY, JSON.stringify(items.slice(-MAX_ITEMS)))
  return {
    list: (providerId) => read().filter((i) => i.provider_id === providerId),
    /** @returns {boolean} false when the item is held in memory only (persistent storage refused it) */
    add(item) {
      const items = read()
      if (items.some((i) => i.id === item.id)) return true
      return write([...items, item]) !== false
    },
    remove(ids) {
      const drop = new Set(ids)
      write(read().filter((i) => !drop.has(i.id)))
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
    let res
    try {
      res = await api('/scans/sync', {
        method: 'POST',
        token,
        timeoutMs: 8000 + 1500 * items.length,
        body: { scans: items.map(({ id, code, client_time, gps }) => ({ id, code, client_time, gps })) },
      })
    } catch (err) {
      if (err.status === 401) throw err
      break // no signal / server hiccup: keep everything for the next attempt
    }
    const done = []
    for (const r of res.results) {
      if (!inBatch.has(r.id)) continue // never trust ids we did not send
      if (r.ok) {
        if (r.scan?.outcome && r.scan.outcome !== 'accepted') rejected++
        else sent++
        done.push(r.id)
      } else if (PERMANENT.has(r.error?.code)) {
        dropped++
        done.push(r.id)
      }
    }
    if (!done.length) break // nothing progressed: avoid spinning on a stuck batch
    queue.remove(done)
  }
  return { sent, rejected, dropped, remaining: queue.list(providerId).length }
}
