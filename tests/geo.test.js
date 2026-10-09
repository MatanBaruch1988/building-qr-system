// The phone's location for a scan (src/worker/geo.js). A point that requires the location waits a few seconds for a precise
// reading (the precise path, `getFix({ precise: true })`); every other point keeps the quick position it always had. The
// browser is replaced by a phone whose readings the test sends by hand, and time by fake timers, so a wait of 8.5 seconds
// costs nothing and its edges (just before and just after) can be tested.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFix, PRECISE_TARGET_ACCURACY_M, PRECISE_WAIT_MS } from '../src/worker/geo.js'
import { GPS_MAX_STALE_AGE_S } from '../shared/contract.js'

/** The extra wait when there is still no reading at the end of PRECISE_WAIT_MS (the watchdog of `ask`, which is also 2.5 s). */
const GRACE_MS = 2500

/** A phone whose position the test drives: it records every request, and answers a watch only when `reading` or `fail` is called. */
function fakePhone({ answerWhileWatching } = {}) {
  const phone = {
    watches: [],
    cleared: [],
    quickRequests: [],
    onReading: null,
    onError: null,
    /** A reading with this accuracy, taken `ageMs` milliseconds ago. */
    reading(accuracy, ageMs = 0) {
      phone.onReading({ coords: { latitude: 32.08, longitude: 34.78, accuracy }, timestamp: Date.now() - ageMs })
    },
    fail(code) {
      phone.onError({ code })
    },
  }
  vi.stubGlobal('navigator', {
    geolocation: {
      watchPosition(ok, fail, options) {
        phone.onReading = ok
        phone.onError = fail
        phone.watches.push(options)
        answerWhileWatching?.(phone)
        return phone.watches.length
      },
      clearWatch(id) {
        phone.cleared.push(id)
      },
      getCurrentPosition(ok, _fail, options) {
        phone.quickRequests.push(options)
        ok({ coords: { latitude: 32.08, longitude: 34.78, accuracy: 10 }, timestamp: Date.now() })
      },
    },
  })
  return phone
}

/** Starts a request and reports whether and with what it has finished. */
function ask(options) {
  const out = { done: false, value: null }
  getFix(options).then((value) => {
    out.done = true
    out.value = value
  })
  return out
}

describe('the precise position of a point that requires the location', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('watches with high accuracy and no remembered position, and a reading of exactly the target ends it at once', async () => {
    const phone = fakePhone()
    const out = ask({ precise: true })
    expect(phone.watches).toEqual([{ enableHighAccuracy: true, maximumAge: 0, timeout: PRECISE_WAIT_MS }])
    expect(phone.quickRequests, 'the quick request is not used on this path').toHaveLength(0)

    phone.reading(PRECISE_TARGET_ACCURACY_M)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.done).toBe(true)
    expect(out.value).toEqual({ fix: { lat: 32.08, lng: 34.78, accuracy: PRECISE_TARGET_ACCURACY_M, age_s: 0 }, reason: null })
    expect(phone.cleared, 'the watch is cleared').toEqual([1])
    expect(vi.getTimerCount(), 'no timer is left running').toBe(0)

    phone.reading(5)
    expect(phone.cleared, 'a late reading does not clear it a second time').toEqual([1])
  })

  it('keeps waiting while the readings are vaguer than the target, and gives the best one when the wait is over', async () => {
    const phone = fakePhone()
    const out = ask({ precise: true })
    phone.reading(80)
    await vi.advanceTimersByTimeAsync(1000)
    phone.reading(45)
    await vi.advanceTimersByTimeAsync(1000)
    phone.reading(60)
    await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS - 2000 - 1)
    expect(out.done, 'not before the wait is over').toBe(false)
    expect(phone.cleared).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(out.done).toBe(true)
    expect(out.value.reason).toBeNull()
    expect(out.value.fix.accuracy, 'the best reading, not the last or the first').toBe(45)
    expect(phone.cleared).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns a reading vaguer than the server can use too: the server decides that it does not count', async () => {
    const phone = fakePhone()
    const out = ask({ precise: true })
    phone.reading(400)
    await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS)
    expect(out.value).toMatchObject({ fix: { accuracy: 400 }, reason: null })
  })

  it('finishes at once when the permission is denied', async () => {
    const phone = fakePhone()
    const out = ask({ precise: true })
    await vi.advanceTimersByTimeAsync(1000)
    phone.fail(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.done).toBe(true)
    expect(out.value).toEqual({ fix: null, reason: 'denied' })
    expect(phone.cleared).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a reading that arrived before the permission was withdrawn', async () => {
    const phone = fakePhone()
    const out = ask({ precise: true })
    phone.reading(70)
    phone.fail(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.value).toMatchObject({ fix: { accuracy: 70 }, reason: null })
  })

  it('with no reading at all, answers after the wait and the watchdog, not after the wait alone', async () => {
    const phone = fakePhone()
    const out = ask({ precise: true })
    await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS)
    expect(out.done, 'the browser may still be asking for the permission').toBe(false)
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1)
    expect(out.done).toBe(false)
    expect(phone.cleared).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(out.done).toBe(true)
    expect(out.value).toEqual({ fix: null, reason: 'timeout' })
    expect(phone.cleared).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('remembers why the browser could not give a position, and keeps watching until the timers end', async () => {
    const phone = fakePhone()
    const out = ask({ precise: true })
    phone.fail(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(out.done, 'an unavailable position can pass: the watch stays alive').toBe(false)
    phone.fail(3)
    phone.fail(2)
    await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS + GRACE_MS)
    expect(out.value).toEqual({ fix: null, reason: 'unavailable' })

    const second = fakePhone()
    const timedOut = ask({ precise: true })
    second.fail(3)
    await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS + GRACE_MS)
    expect(timedOut.value).toEqual({ fix: null, reason: 'timeout' })
  })

  it('takes the first reading that comes while it waits the extra time, whatever its accuracy', async () => {
    const phone = fakePhone()
    const out = ask({ precise: true })
    await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS + 1000)
    phone.reading(120)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.value).toMatchObject({ fix: { accuracy: 120 }, reason: null })
    expect(phone.cleared).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers "unsupported" at once when the browser has no geolocation', async () => {
    vi.stubGlobal('navigator', {})
    const out = ask({ precise: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(out.done).toBe(true)
    expect(out.value).toEqual({ fix: null, reason: 'unsupported' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts age_s from the timestamp of the reading, up to the moment that it is handed over', async () => {
    const phone = fakePhone()
    const quick = ask({ precise: true })
    phone.reading(PRECISE_TARGET_ACCURACY_M, 4200)
    await vi.advanceTimersByTimeAsync(0)
    expect(quick.value.fix.age_s, 'a reading taken 4.2 seconds ago').toBe(4)

    const slow = fakePhone()
    const waiting = ask({ precise: true })
    slow.reading(45, 2000)
    await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS)
    expect(waiting.value.fix.age_s, 'taken 2 s before it arrived, and kept for 6 s more').toBe(8)

    const skewed = fakePhone()
    const fromTheFuture = ask({ precise: true })
    skewed.reading(PRECISE_TARGET_ACCURACY_M, -5000)
    await vi.advanceTimersByTimeAsync(0)
    expect(fromTheFuture.value.fix.age_s, 'a clock that runs ahead is never a negative age').toBe(0)
  })

  it('clears the watch of a browser that answers before watchPosition has returned', async () => {
    const phone = fakePhone({ answerWhileWatching: (p) => p.reading(PRECISE_TARGET_ACCURACY_M) })
    const out = ask({ precise: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(out.value).toMatchObject({ fix: { accuracy: PRECISE_TARGET_ACCURACY_M }, reason: null })
    expect(phone.cleared).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the quick position of the other points is untouched', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('getFix() asks once, for a position that the phone remembers, without high accuracy and without a watch', async () => {
    const phone = fakePhone()
    const res = await getFix()
    expect(phone.quickRequests).toEqual([{ enableHighAccuracy: false, timeout: 4000, maximumAge: GPS_MAX_STALE_AGE_S * 1000 }])
    expect(phone.watches).toHaveLength(0)
    expect(res).toMatchObject({ fix: { accuracy: 10 }, reason: null })
  })

  it('getFix({ maxAgeMs: 0 }) is still the quick path, with its own age', async () => {
    const phone = fakePhone()
    await getFix({ maxAgeMs: 0 })
    expect(phone.quickRequests).toEqual([{ enableHighAccuracy: false, timeout: 4000, maximumAge: 0 }])
    expect(phone.watches).toHaveLength(0)
  })
})
