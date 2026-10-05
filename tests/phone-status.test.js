// @vitest-environment jsdom
// The phone reports its status (ADR 0007, decision 4, "Phone health"; src/worker/deviceStatus.js, the counting in
// src/worker/scanQueue.js, the reset in src/worker/session.js). The server side is tested in tests/device-status.test.js and the
// provider app as a whole in tests/components/phone-status.test.jsx.
//
// What this file proves, with no browser and no network (the clock, the timers, the storage and `api` are the test's own):
//   - the report: how many items wait (the signed-in person's), the earliest save time of them (an item that an older version of
//     the app wrote has no `saved_at`: its own time is used), the build, and the two totals;
//   - the totals: the queue counts a visit that the server refused for good and a visit that a full queue dropped, in the same
//     step; they only grow, a report never resets them, a retry sends the same numbers, and a sign-in or a sign-out starts from
//     zero; a missing or corrupt `qr.health.v1` reads as zeros; a storage that refuses is never an error;
//   - the queue's own stored format is the one that it always had;
//   - when a report is sent: not offline, not for nobody, an unchanged queue once every 10 minutes, a changed one at once but
//     never within DEVICE_STATUS_MIN_INTERVAL_S (what that held back is sent afterwards, once), a 404 stops it for the run, a 401
//     goes to the app's sign-out, any other failure keeps going the next time;
//   - nothing is ever written to the console.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueue, flushQueue } from '../src/worker/scanQueue.js'
import { saveSession, clearSession } from '../src/worker/session.js'
import { safeStorage } from '../src/worker/storage.js'
import { ApiError } from '../src/api/client.js'
import {
  buildReport, readHealth, addToHealth, resetHealth, createDeviceReporter, REPORT_EVERY_MS,
} from '../src/worker/deviceStatus.js'
import { APP_BUILD } from '../src/ui/build.js'
import { DEVICE_STATUS_MIN_INTERVAL_S, DEVICE_STATUS_MAX_TOTAL, SYNC_QUEUE_MAX_ITEMS, PROVIDER_TOKEN_PREFIX } from '../shared/contract.js'

const memoryStorage = () => {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }
}
const QUEUE_KEY = 'qr.queue.v1'
const HEALTH_KEY = 'qr.health.v1'
const GAP_MS = DEVICE_STATUS_MIN_INTERVAL_S * 1000
const START = Date.parse('2026-10-05T08:00:00.000Z')

/** A queued visit of the shape that the app writes today. `extra` adds or overrides a field. */
const item = (id, extra = {}) => ({
  id, code: 'BQR-abc123', client_time: '2026-10-05T07:30:00.000Z', gps: null, provider_id: 'prov-1', saved_at: '2026-10-05T07:30:00.000Z', ...extra,
})
/** One written by an older version: no `saved_at`. */
const oldItem = (id, client_time) => {
  const written = item(id, { client_time })
  delete written.saved_at
  return written
}

let consoleSpies
beforeEach(() => {
  consoleSpies = ['error', 'warn', 'log', 'info', 'debug'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
})
afterEach(() => {
  // A report is best effort and silent: the end-to-end console guard fails on any console.error, and none of these paths may log.
  const lines = consoleSpies.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))
  vi.restoreAllMocks()
  expect(lines).toEqual([])
})

describe('the report', () => {
  it('counts the signed-in person\'s items and takes the earliest save time, also from items that an older version wrote', () => {
    const storage = memoryStorage()
    storage.setItem(QUEUE_KEY, JSON.stringify([
      item('new-1', { saved_at: '2026-10-05T07:00:00.000Z', client_time: '2026-10-05T07:00:00.000Z' }),
      oldItem('old-1', '2026-10-04T20:15:00Z'), // no saved_at: its own time is the one
      item('garbage', { saved_at: 'yesterday', client_time: '2026-10-05T05:00:00.000Z' }), // a save time that cannot be read: the item's own
      item('someone-else', { provider_id: 'prov-2', saved_at: '2020-01-01T00:00:00.000Z' }), // another person's visit is not this phone's wait
    ]))
    const queue = createQueue(storage)
    expect(buildReport(queue.list('prov-1'), readHealth(storage))).toEqual({
      build: APP_BUILD,
      waiting: 3,
      oldest_waiting_at: '2026-10-04T20:15:00.000Z', // the old item's client_time, written the way Date writes an ISO time
      not_accepted_total: 0,
      overflowed_total: 0,
    })
  })

  it('prefers the save time to the visit time, and writes a time with an offset as UTC', () => {
    const queue = createQueue(memoryStorage())
    queue.add(item('a', { client_time: '2026-10-05T06:00:00.000Z', saved_at: '2026-10-05T10:00:00+03:00' })) // saved at 07:00 UTC, visit time earlier
    queue.add(item('b', { saved_at: '2026-10-05T07:30:00.000Z' }))
    expect(buildReport(queue.list('prov-1'), readHealth(memoryStorage())).oldest_waiting_at).toBe('2026-10-05T07:00:00.000Z')
  })

  it('an empty queue is 0 waiting and no time', () => {
    const report = buildReport([], readHealth(memoryStorage()))
    expect(report).toMatchObject({ waiting: 0, oldest_waiting_at: null })
  })

  it('an item with no time that can be read still counts as waiting, and gives no time', () => {
    const report = buildReport([item('x', { saved_at: 'no', client_time: 'nor this' })], readHealth(memoryStorage()))
    expect(report).toMatchObject({ waiting: 1, oldest_waiting_at: null })
  })

  it('names the build of this app, and nothing else that the server does not need', () => {
    const report = buildReport([], readHealth(memoryStorage()))
    expect(report.build).toBe(APP_BUILD)
    expect(Object.keys(report).sort()).toEqual(['build', 'not_accepted_total', 'oldest_waiting_at', 'overflowed_total', 'waiting'])
  })

  it('never says more than the queue can hold', () => {
    const many = Array.from({ length: SYNC_QUEUE_MAX_ITEMS + 5 }, (_, i) => item('i' + i))
    expect(buildReport(many, readHealth(memoryStorage())).waiting).toBe(SYNC_QUEUE_MAX_ITEMS)
  })
})

describe('the totals', () => {
  it('count a visit that the server refused for good, once, and not one that it will take later or that it stored but did not count', async () => {
    const storage = memoryStorage()
    const queue = createQueue(storage)
    ;['ok', 'gone', 'late', 'far', 'gone-too'].forEach((id) => queue.add(item(id)))
    const verdict = {
      ok: { ok: true, scan: { outcome: 'accepted' } },
      far: { ok: true, scan: { outcome: 'rejected_far' } }, // stored, not counted as attendance: the person is told, nothing is dropped
      gone: { ok: false, error: { code: 'unknown_code' } },
      'gone-too': { ok: false, error: { code: 'point_inactive' } },
      late: { ok: false, error: { code: 'server_error' } }, // will be retried
    }
    const api = vi.fn(async (_path, { body }) => ({ results: body.scans.map((s) => ({ id: s.id, ...verdict[s.id] })) }))
    const res = await flushQueue({ queue, api, token: 't', providerId: 'prov-1' })
    expect(res).toMatchObject({ sent: 1, rejected: 1, dropped: 2, remaining: 1 })
    expect(readHealth(storage)).toEqual({ not_accepted_total: 2, overflowed_total: 0 })
    // the next upload tries 'late' again and it is refused for good this time: one more
    const refuse = vi.fn(async (_path, { body }) => ({ results: body.scans.map((s) => ({ id: s.id, ok: false, error: { code: 'invalid_item' } })) }))
    await flushQueue({ queue, api: refuse, token: 't', providerId: 'prov-1' })
    expect(readHealth(storage)).toEqual({ not_accepted_total: 3, overflowed_total: 0 })
  })

  it('count the visits that a full queue drops (the oldest go first), one for each', () => {
    const storage = memoryStorage()
    const queue = createQueue(storage)
    for (let i = 0; i < SYNC_QUEUE_MAX_ITEMS + 2; i++) queue.add(item('i' + i))
    expect(queue.list('prov-1')).toHaveLength(SYNC_QUEUE_MAX_ITEMS)
    expect(queue.list('prov-1')[0].id).toBe('i2')
    expect(readHealth(storage)).toEqual({ not_accepted_total: 0, overflowed_total: 2 })
  })

  it('a removal that is not a refusal counts nothing, and neither does an add that fits', () => {
    const storage = memoryStorage()
    const queue = createQueue(storage)
    queue.add(item('a'))
    queue.add(item('a')) // the same id again: nothing changes
    queue.remove(['a'])
    expect(readHealth(storage)).toEqual({ not_accepted_total: 0, overflowed_total: 0 })
    expect(storage.getItem(HEALTH_KEY)).toBeNull() // nothing was written for nothing
  })

  it('leave the queue in the format it always had (an array of the items, newest 500, no extra field)', () => {
    const storage = memoryStorage()
    const queue = createQueue(storage)
    const first = item('a')
    queue.add(first)
    queue.remove(['zzz'], { notAccepted: 1 })
    expect(JSON.parse(storage.getItem(QUEUE_KEY))).toEqual([first])
    expect(Object.keys(JSON.parse(storage.getItem(HEALTH_KEY))).sort()).toEqual(['not_accepted_total', 'overflowed_total'])
  })

  it('only grow: every add is on top of what was there', () => {
    const storage = memoryStorage()
    const seen = []
    for (const more of [{ not_accepted: 1 }, { overflowed: 2 }, { not_accepted: 3, overflowed: 1 }, {}, { not_accepted: 0 }]) {
      addToHealth(more, storage)
      seen.push(readHealth(storage))
    }
    expect(seen).toEqual([
      { not_accepted_total: 1, overflowed_total: 0 },
      { not_accepted_total: 1, overflowed_total: 2 },
      { not_accepted_total: 4, overflowed_total: 3 },
      { not_accepted_total: 4, overflowed_total: 3 },
      { not_accepted_total: 4, overflowed_total: 3 },
    ])
  })

  it('stop at what the server takes (DEVICE_STATUS_MAX_TOTAL), whatever was stored and whatever is added', () => {
    const storage = memoryStorage()
    storage.setItem(HEALTH_KEY, JSON.stringify({ not_accepted_total: DEVICE_STATUS_MAX_TOTAL * 3, overflowed_total: DEVICE_STATUS_MAX_TOTAL - 1 }))
    expect(readHealth(storage)).toEqual({ not_accepted_total: DEVICE_STATUS_MAX_TOTAL, overflowed_total: DEVICE_STATUS_MAX_TOTAL - 1 })
    addToHealth({ not_accepted: 1, overflowed: 5 }, storage)
    expect(readHealth(storage)).toEqual({ not_accepted_total: DEVICE_STATUS_MAX_TOTAL, overflowed_total: DEVICE_STATUS_MAX_TOTAL })
  })

  it('ignore what is not a count to add (a negative, a fraction, text)', () => {
    const storage = memoryStorage()
    addToHealth({ not_accepted: 2 }, storage)
    addToHealth({ not_accepted: -5, overflowed: 1.5 }, storage)
    addToHealth(/** @type {any} */ ({ not_accepted: '7', overflowed: NaN }), storage)
    expect(readHealth(storage)).toEqual({ not_accepted_total: 2, overflowed_total: 0 })
  })

  it.each([
    ['not JSON', '{not json'],
    ['an array', '[1,2]'],
    ['a string', '"x"'],
    ['a number', '7'],
    ['null', 'null'],
    ['fields that are not counts', '{"not_accepted_total":-5,"overflowed_total":"7"}'],
    ['fractions', '{"not_accepted_total":1.5,"overflowed_total":2.5}'],
    ['an empty record', '{}'],
  ])('a stored value that is %s starts from zeros (and the next count builds on that)', (_what, stored) => {
    const storage = memoryStorage()
    storage.setItem(HEALTH_KEY, stored)
    expect(readHealth(storage)).toEqual({ not_accepted_total: 0, overflowed_total: 0 })
    addToHealth({ overflowed: 1 }, storage)
    expect(readHealth(storage)).toEqual({ not_accepted_total: 0, overflowed_total: 1 })
  })

  it('keep what is valid in a record that is half valid', () => {
    const storage = memoryStorage()
    storage.setItem(HEALTH_KEY, '{"not_accepted_total":4,"overflowed_total":"many"}')
    expect(readHealth(storage)).toEqual({ not_accepted_total: 4, overflowed_total: 0 })
  })

  it('never throw when the storage cannot be read or written', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('blocked') } }
    expect(readHealth(broken)).toEqual({ not_accepted_total: 0, overflowed_total: 0 })
    expect(() => addToHealth({ not_accepted: 1, overflowed: 1 }, broken)).not.toThrow()
    expect(() => resetHealth(broken)).not.toThrow()
  })

  it('a queue whose storage refuses still counts what it drops without throwing (the count is memory only, like the item)', () => {
    const queue = createQueue({ getItem: () => null, setItem: () => false, removeItem: () => {} })
    expect(queue.add(item('a'))).toBe(false)
  })

  it('reset to zero when somebody signs in (a new device token) and when somebody signs out', () => {
    const provider = { id: 'prov-1', company: 'Fake company' }
    const token = (n) => PROVIDER_TOKEN_PREFIX + String(n).repeat(43)
    try {
      addToHealth({ not_accepted: 3, overflowed: 4 }) // the real storage of the app: safeStorage, here the jsdom localStorage
      saveSession({ token: token(1), provider }, true)
      expect(readHealth()).toEqual({ not_accepted_total: 0, overflowed_total: 0 })

      addToHealth({ not_accepted: 1 })
      expect(readHealth().not_accepted_total).toBe(1)
      clearSession()
      expect(readHealth()).toEqual({ not_accepted_total: 0, overflowed_total: 0 })

      addToHealth({ overflowed: 2 })
      saveSession({ token: token(2), provider }, false) // not remembered: still a new token, still from zero
      expect(readHealth()).toEqual({ not_accepted_total: 0, overflowed_total: 0 })
    } finally {
      clearSession()
      safeStorage.removeItem(HEALTH_KEY)
    }
  })
})

/**
 * A reporter with everything it touches in the test's hands: the clock, the timers, the network, the storage, who is signed in.
 * @param {{ items?: any[], online?: boolean, session?: { token: string, providerId: string } | null, answer?: (path: string, options: any) => any }} [setup]
 */
function rig({ items = [], online = true, session = { token: 'qrp_a', providerId: 'prov-1' }, answer = async () => ({ ok: true, build: null }) } = {}) {
  const storage = memoryStorage()
  if (items.length) storage.setItem(QUEUE_KEY, JSON.stringify(items))
  const queue = createQueue(storage)
  const clock = { now: START }
  const timers = []
  const state = { session, online }
  const unauthorized = vi.fn()
  const api = vi.fn(async (path, options) => answer(path, options))
  const reporter = createDeviceReporter({
    queue,
    api,
    storage,
    getSession: () => state.session,
    onUnauthorized: unauthorized,
    now: () => clock.now,
    isOnline: () => state.online,
    setTimer: (fn, ms) => {
      const timer = { fn, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const at = timers.indexOf(timer)
      if (at >= 0) timers.splice(at, 1)
    },
  })
  /** Moves the clock on by `ms`. */
  const wait = (ms) => {
    clock.now += ms
  }
  /** Runs the timer that is waiting (the way the browser does when its time has come), after moving the clock to its time. */
  const fire = async () => {
    const [timer] = timers.splice(0, 1)
    wait(timer.ms)
    await timer.fn()
    await Promise.resolve()
  }
  return { storage, queue, api, reporter, timers, state, unauthorized, wait, fire }
}

describe('the reporter: what it sends and how', () => {
  it('posts the report to /my/device-status with the session token', async () => {
    const t = rig({ items: [item('a', { saved_at: '2026-10-05T07:00:00.000Z' }), item('b')] })
    addToHealth({ not_accepted: 2, overflowed: 1 }, t.storage)
    expect(await t.reporter.report()).toBe('sent')
    expect(t.api).toHaveBeenCalledTimes(1)
    const [path, options] = t.api.mock.calls[0]
    expect(path).toBe('/my/device-status')
    expect(options).toMatchObject({ method: 'POST', token: 'qrp_a' })
    expect(options.timeoutMs).toBeGreaterThan(0)
    expect(options.body).toEqual({
      build: APP_BUILD, waiting: 2, oldest_waiting_at: '2026-10-05T07:00:00.000Z', not_accepted_total: 2, overflowed_total: 1,
    })
  })

  it('reports the queue of the person who is signed in, not of the whole phone', async () => {
    const t = rig({ items: [item('mine'), item('theirs', { provider_id: 'prov-2' })] })
    await t.reporter.report()
    expect(t.api.mock.calls[0][1].body.waiting).toBe(1)
  })

  it('never reports for nobody', async () => {
    const t = rig({ session: null })
    expect(await t.reporter.report()).toBe('skipped')
    expect(t.api).not.toHaveBeenCalled()
  })

  it('sends nothing while the phone says it is offline, and sends when it is back', async () => {
    const t = rig({ items: [item('a')], online: false })
    expect(await t.reporter.report()).toBe('offline')
    expect(t.api).not.toHaveBeenCalled()
    expect(t.timers).toEqual([])
    t.state.online = true
    expect(await t.reporter.report()).toBe('sent') // the offline call did not count as a report: no throttle
  })

  it('does not send two at once', async () => {
    let release
    const t = rig({ answer: () => new Promise((resolve) => { release = () => resolve({ ok: true, build: 'abc1234' }) }) })
    const first = t.reporter.report()
    expect(await t.reporter.report()).toBe('skipped')
    release()
    expect(await first).toBe('sent')
    expect(t.api).toHaveBeenCalledTimes(1)
  })

  it('a change that comes while a report is on its way is looked at when that one has ended, not lost', async () => {
    let release
    let hold = true
    const t = rig({
      items: [item('a')],
      answer: () => (hold ? new Promise((resolve) => { release = () => resolve({ ok: true, build: null }) }) : { ok: true, build: null }),
    })
    const first = t.reporter.report() // waiting 1 is on its way
    t.queue.add(item('b'))
    expect(await t.reporter.report()).toBe('skipped')
    hold = false
    release()
    expect(await first).toBe('sent')
    expect(t.timers).toHaveLength(1) // the second call was kept: waiting is 2 now, and the minimum between two reports has not passed
    await t.fire()
    expect(t.api).toHaveBeenCalledTimes(2)
    expect(t.api.mock.calls.map((c) => c[1].body.waiting)).toEqual([1, 2])
  })

  it('a call that came while a report was on its way, for a queue that did not change, makes no second report', async () => {
    let release
    const t = rig({ items: [item('a')], answer: () => new Promise((resolve) => { release = () => resolve({ ok: true, build: null }) }) })
    const first = t.reporter.report()
    await t.reporter.report()
    release()
    await first
    expect(t.timers).toEqual([])
    expect(t.api).toHaveBeenCalledTimes(1)
  })

  it('a call that came while a report was on its way does not make a second report after a 401 (the person is signed out)', async () => {
    let fail
    const t = rig({ items: [item('a')], answer: () => new Promise((_resolve, reject) => { fail = () => reject(new ApiError(401, 'invalid_session')) }) })
    const first = t.reporter.report()
    await t.reporter.report()
    fail()
    expect(await first).toBe('unauthorized')
    expect(t.unauthorized).toHaveBeenCalledTimes(1)
    expect(t.timers).toEqual([])
    expect(t.api).toHaveBeenCalledTimes(1)
  })

  it('does not trust an answer that is not the server\'s "ok"', async () => {
    const t = rig({ answer: async () => ({}) })
    expect(await t.reporter.report()).toBe('failed')
  })
})

describe('the reporter: the totals are only sent, never reset by a report', () => {
  it('a report that the server accepted leaves the totals where they are', async () => {
    const t = rig()
    addToHealth({ not_accepted: 2, overflowed: 5 }, t.storage)
    expect(await t.reporter.report()).toBe('sent')
    expect(readHealth(t.storage)).toEqual({ not_accepted_total: 2, overflowed_total: 5 })
  })

  it('a retry after a failure sends the same totals, and a later one sends them with whatever was counted since', async () => {
    let fail = true
    const t = rig({ answer: async () => { if (fail) throw new ApiError(0, 'timeout'); return { ok: true, build: null } } })
    addToHealth({ not_accepted: 2, overflowed: 1 }, t.storage)
    expect(await t.reporter.report()).toBe('failed')
    expect(readHealth(t.storage)).toEqual({ not_accepted_total: 2, overflowed_total: 1 }) // a failed report changes nothing

    fail = false
    t.wait(REPORT_EVERY_MS) // a failed attempt counts for the throttle: the retry of an unchanged queue comes when its time has come
    expect(await t.reporter.report()).toBe('sent')
    expect(t.api.mock.calls[1][1].body).toEqual(t.api.mock.calls[0][1].body) // the same totals as the attempt that failed

    addToHealth({ not_accepted: 1, overflowed: 2 }, t.storage) // counted since, on top of the same ones
    t.wait(REPORT_EVERY_MS)
    await t.reporter.report()
    expect(t.api.mock.calls[2][1].body).toMatchObject({ not_accepted_total: 3, overflowed_total: 3 })
  })

  it('the same report sent twice carries the same numbers (what the server relies on to ignore a duplicate)', async () => {
    const t = rig({ items: [item('a')] })
    addToHealth({ not_accepted: 3 }, t.storage)
    await t.reporter.report()
    t.wait(REPORT_EVERY_MS)
    await t.reporter.report()
    expect(t.api).toHaveBeenCalledTimes(2)
    expect(t.api.mock.calls[1][1].body).toEqual(t.api.mock.calls[0][1].body)
  })

  it('the totals sent never go down from one report to the next', async () => {
    const t = rig()
    const sent = []
    for (const more of [{}, { not_accepted: 1 }, { overflowed: 2 }, {}, { not_accepted: 2, overflowed: 1 }]) {
      addToHealth(more, t.storage)
      t.wait(REPORT_EVERY_MS) // far enough apart that each one is sent
      await t.reporter.report()
      const { not_accepted_total, overflowed_total } = t.api.mock.calls.at(-1)[1].body
      sent.push([not_accepted_total, overflowed_total])
    }
    expect(t.api).toHaveBeenCalledTimes(5)
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i][0]).toBeGreaterThanOrEqual(sent[i - 1][0])
      expect(sent[i][1]).toBeGreaterThanOrEqual(sent[i - 1][1])
    }
    expect(sent.at(-1)).toEqual([3, 3])
  })

  it('corrupt storage sends zeros, and still sends', async () => {
    const t = rig()
    t.storage.setItem(HEALTH_KEY, '{not json')
    expect(await t.reporter.report()).toBe('sent')
    expect(t.api.mock.calls[0][1].body).toMatchObject({ not_accepted_total: 0, overflowed_total: 0 })
  })

  it('a queue that cannot be read is not reported on, and is not an error', async () => {
    const t = rig()
    t.storage.setItem(QUEUE_KEY, '{}') // JSON, but not a list: queue.list throws
    expect(await t.reporter.report()).toBe('skipped')
    expect(t.api).not.toHaveBeenCalled()
  })
})

describe('the reporter: when it sends', () => {
  it('the first report of a run goes at once; an unchanged queue is not reported again for 10 minutes, then it is', async () => {
    const t = rig({ items: [item('a')] })
    expect(await t.reporter.report()).toBe('sent')
    t.wait(GAP_MS + 1)
    expect(await t.reporter.report()).toBe('skipped')
    t.wait(REPORT_EVERY_MS - GAP_MS - 2)
    expect(await t.reporter.report()).toBe('skipped') // one ms short of the 10 minutes since the last report ended
    expect(t.api).toHaveBeenCalledTimes(1)
    t.wait(2)
    expect(await t.reporter.report()).toBe('sent')
    expect(t.api).toHaveBeenCalledTimes(2)
    expect(t.timers).toEqual([]) // an unchanged queue is not a reason to come back later
  })

  it('a changed number of waiting visits is reported at once, once the minimum between two reports has passed', async () => {
    const t = rig({ items: [item('a')] })
    await t.reporter.report()
    t.queue.add(item('b'))
    t.wait(GAP_MS)
    expect(await t.reporter.report()).toBe('sent')
    expect(t.api.mock.calls.map((c) => c[1].body.waiting)).toEqual([1, 2])
  })

  it('a total that changed is reported at once too, although the number that waits is the same (a visit refused between two reports)', async () => {
    const t = rig() // nothing waits, and nothing waited at the last report either
    await t.reporter.report()
    addToHealth({ not_accepted: 1 }, t.storage)
    t.wait(GAP_MS)
    expect(await t.reporter.report()).toBe('sent')
    addToHealth({ overflowed: 2 }, t.storage)
    t.wait(1000)
    expect(await t.reporter.report()).toBe('deferred') // inside the minimum: held back, not lost
    await t.fire()
    expect(t.api.mock.calls.map((c) => [c[1].body.not_accepted_total, c[1].body.overflowed_total])).toEqual([[0, 0], [1, 0], [1, 2]])
  })

  it('a different oldest visit is reported at once too, although the number that waits is the same', async () => {
    const t = rig({ items: [item('old', { saved_at: '2026-10-05T06:00:00.000Z' })] })
    await t.reporter.report()
    t.queue.remove(['old'])
    t.queue.add(item('new', { saved_at: '2026-10-05T07:30:00.000Z' })) // one still waits, but not the one from before
    t.wait(GAP_MS)
    expect(await t.reporter.report()).toBe('sent')
    expect(t.api.mock.calls.map((c) => c[1].body.oldest_waiting_at)).toEqual(['2026-10-05T06:00:00.000Z', '2026-10-05T07:30:00.000Z'])
  })

  it('a change inside the minimum is not lost: it is sent when the minimum has passed, once, with the state of that time', async () => {
    const t = rig({ items: [item('a'), item('b')] })
    await t.reporter.report() // waiting 2
    t.wait(1000)
    t.queue.remove(['a', 'b']) // the upload finished one second later
    expect(await t.reporter.report()).toBe('deferred')
    expect(await t.reporter.report()).toBe('deferred') // asking again does not stack timers
    expect(t.timers).toHaveLength(1)
    expect(t.api).toHaveBeenCalledTimes(1)

    t.queue.add(item('c')) // and by the time the minimum has passed there is something new
    await t.fire()
    expect(t.api).toHaveBeenCalledTimes(2)
    expect(t.api.mock.calls[1][1].body.waiting).toBe(1)
    expect(t.timers).toEqual([])
  })

  it('the wait after a change is what is left of the minimum (not the whole of it), and a little over', async () => {
    const t = rig({ items: [item('a')] })
    await t.reporter.report()
    t.wait(3000)
    t.queue.add(item('b'))
    await t.reporter.report()
    expect(t.timers[0].ms).toBeGreaterThanOrEqual(GAP_MS - 3000)
    expect(t.timers[0].ms).toBeLessThan(GAP_MS)
  })

  it('a report that was held back is dropped when the person has gone by the time its turn comes', async () => {
    const t = rig({ items: [item('a')] })
    await t.reporter.report()
    t.queue.add(item('b'))
    expect(await t.reporter.report()).toBe('deferred')
    t.state.session = null // signed out meanwhile
    await t.fire()
    expect(t.api).toHaveBeenCalledTimes(1)
  })

  it('a held-back report does not go out while the phone is offline', async () => {
    const t = rig({ items: [item('a')] })
    await t.reporter.report()
    t.queue.add(item('b'))
    await t.reporter.report()
    t.state.online = false
    await t.fire()
    expect(t.api).toHaveBeenCalledTimes(1)
  })

  it('a different person on the same phone gets a first report at once, whatever was sent for the one before', async () => {
    const t = rig({ items: [item('a')] })
    await t.reporter.report()
    t.state.session = { token: 'qrp_b', providerId: 'prov-2' }
    expect(await t.reporter.report()).toBe('sent')
    expect(t.api.mock.calls[1][1]).toMatchObject({ token: 'qrp_b', body: { waiting: 0 } })
  })

  it('a clock that was set back is not a reason to stay quiet', async () => {
    const t = rig({ items: [item('a')] })
    await t.reporter.report()
    t.wait(-3600 * 1000)
    expect(await t.reporter.report()).toBe('sent')
  })

  it('a failed attempt counts for the throttle too (a server that is down is not asked every 30 seconds)', async () => {
    const t = rig({ items: [item('a')], answer: async () => { throw new ApiError(503, 'unavailable') } })
    expect(await t.reporter.report()).toBe('failed')
    t.wait(GAP_MS + 1)
    expect(await t.reporter.report()).toBe('skipped')
    t.wait(REPORT_EVERY_MS)
    expect(await t.reporter.report()).toBe('failed')
    expect(t.api).toHaveBeenCalledTimes(2)
  })
})

describe('the reporter: what the server answers', () => {
  it('a 404 (a server rolled back to before the endpoint) stops it for the rest of the run, and nothing held back goes out', async () => {
    let answer = async () => ({ ok: true, build: null })
    const t = rig({ items: [item('a')], answer: () => answer() })
    expect(await t.reporter.report()).toBe('sent')
    t.queue.add(item('b'))
    expect(await t.reporter.report()).toBe('deferred') // held back by the minimum between two reports
    expect(t.timers).toHaveLength(1)

    answer = async () => { throw new ApiError(404, 'not_found') } // the server was rolled back meanwhile
    await t.fire() // the held-back report goes out and meets the 404
    expect(t.api).toHaveBeenCalledTimes(2)
    expect(t.timers).toEqual([])

    for (let i = 0; i < 3; i++) {
      t.queue.add(item('c' + i))
      t.wait(REPORT_EVERY_MS)
      expect(await t.reporter.report()).toBe('stopped')
    }
    expect(t.api).toHaveBeenCalledTimes(2) // nothing more in this run
    expect(t.timers).toEqual([])
  })

  it('a 404 on the first report stops at once', async () => {
    const t = rig({ answer: async () => { throw new ApiError(404, 'not_found') } })
    expect(await t.reporter.report()).toBe('stopped')
    t.wait(REPORT_EVERY_MS)
    expect(await t.reporter.report()).toBe('stopped')
    expect(t.api).toHaveBeenCalledTimes(1)
  })

  it('a new reporter (the app started again) tries again', async () => {
    const down = rig({ answer: async () => { throw new ApiError(404, 'not_found') } })
    await down.reporter.report()
    const next = rig()
    expect(await next.reporter.report()).toBe('sent')
  })

  it('a 401 goes to the app\'s own sign-out with the token that was refused, and the reporter itself does not throw', async () => {
    const t = rig({ answer: async () => { throw new ApiError(401, 'invalid_session') } })
    expect(await t.reporter.report()).toBe('unauthorized')
    expect(t.unauthorized).toHaveBeenCalledTimes(1)
    expect(t.unauthorized).toHaveBeenCalledWith('qrp_a')
  })

  it.each([
    ['no signal', new ApiError(0, 'network')],
    ['a timeout', new ApiError(0, 'timeout')],
    ['a server that is down', new ApiError(503, 'unavailable')],
    ['a server that fails', new ApiError(500, 'server_error')],
    ['a refusal that is not a 401 or a 404', new ApiError(429, 'too_many_attempts')],
    ['something that is not an ApiError at all', new TypeError('boom')],
  ])('%s is a failed attempt: nothing is thrown, nothing is logged, nothing is signed out, the totals stay', async (_what, error) => {
    const t = rig({ items: [item('a')], answer: async () => { throw error } })
    addToHealth({ not_accepted: 1 }, t.storage)
    expect(await t.reporter.report()).toBe('failed')
    expect(t.unauthorized).not.toHaveBeenCalled()
    expect(readHealth(t.storage)).toEqual({ not_accepted_total: 1, overflowed_total: 0 })
    // and the next attempt goes out when its time comes
    t.wait(REPORT_EVERY_MS)
    expect(await t.reporter.report()).toBe('failed')
    expect(t.api).toHaveBeenCalledTimes(2)
    expect(t.api.mock.calls[1][1].body).toEqual(t.api.mock.calls[0][1].body)
  })

  it('stop() drops a held-back report (the app was closed)', async () => {
    const t = rig({ items: [item('a')] })
    await t.reporter.report()
    t.queue.add(item('b'))
    await t.reporter.report()
    expect(t.timers).toHaveLength(1)
    t.reporter.stop()
    expect(t.timers).toEqual([])
  })
})
