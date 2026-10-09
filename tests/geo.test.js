// The phone's location for a scan (src/worker/geo.js). A point that requires the location waits a few seconds for a precise
// reading (the precise path, `getFix({ precise: true })`); every other point keeps the quick position it always had. The
// browser is replaced by a phone whose readings the test sends by hand, and time by fake timers, so a wait of 8.5 seconds
// costs nothing and its edges (just before and just after) can be tested. When a way ends with no usable reading, the
// position that the phone kept from its last live reading is the last resort. A position that the browser merely remembers is
// neither kept nor used: it can be from before the person signed in, and the app cannot clear the browser's memory at sign-out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFix, forgetLastFix, PRECISE_TARGET_ACCURACY_M, PRECISE_WAIT_MS } from '../src/worker/geo.js'
import { GPS_MAX_STALE_AGE_S, GPS_MAX_USABLE_ACCURACY_M } from '../shared/contract.js'

/** The extra wait when there is still no reading at the end of PRECISE_WAIT_MS (the watchdog of `ask`, which is also 2.5 s). */
const GRACE_MS = 2500

/** The key under which the phone keeps its last usable reading. */
const LAST_FIX_KEY = 'qr.lastfix.v1'

/** localStorage as a test sees it: a map, so that what the app keeps can be read back. */
function fakeStorage() {
  const items = new Map()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  }
}

beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()))

/**
 * A phone whose position the test drives: it records every request, and answers a watch only when `reading` or `fail` is called.
 * `browser` is what the browser answers to a one-off request (the quick path): a position it remembers (`{ accuracy, ageMs }`),
 * a refusal (`{ error: code }`), or, by default, nothing (position unavailable), as in a basement. A function gets the options of
 * the request and answers with one of those, so that the first and the second request of the quick path can differ.
 */
function fakePhone({ answerWhileWatching, browser = null } = {}) {
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
      getCurrentPosition(ok, fail, options) {
        phone.quickRequests.push(options)
        const answer = typeof browser === 'function' ? browser(options) : browser
        if (!answer) return fail({ code: 2 })
        if (answer.error) return fail({ code: answer.error })
        ok({ coords: { latitude: 32.08, longitude: 34.78, accuracy: answer.accuracy }, timestamp: Date.now() - (answer.ageMs ?? 0) })
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
    const phone = fakePhone({ browser: { accuracy: 10 } })
    const res = await getFix()
    expect(phone.quickRequests).toEqual([{ enableHighAccuracy: false, timeout: 4000, maximumAge: GPS_MAX_STALE_AGE_S * 1000 }])
    expect(phone.watches).toHaveLength(0)
    expect(res).toMatchObject({ fix: { accuracy: 10 }, reason: null })
  })

  it('getFix({ maxAgeMs: 0 }) is still the quick path, with its own age', async () => {
    const phone = fakePhone({ browser: { accuracy: 10 } })
    await getFix({ maxAgeMs: 0 })
    expect(phone.quickRequests).toEqual([{ enableHighAccuracy: false, timeout: 4000, maximumAge: 0 }])
    expect(phone.watches).toHaveLength(0)
  })
})

describe('the last position of the phone, when there is no fresh one', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Everything the precise path waits when no reading comes, before the last resort looks at what the phone kept. */
  const WAITED_MS = PRECISE_WAIT_MS + GRACE_MS
  const kept = () => JSON.parse(localStorage.getItem(LAST_FIX_KEY))
  /** Puts a position on the phone as an earlier visit would have left it, `ageMs` before now. */
  const keep = (ageMs, accuracy = 20) => localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lat: 32.1, lng: 34.8, accuracy, taken_at: Date.now() - ageMs }))
  /** Puts a position on the phone that is `ageS` seconds old when the precise path has waited for nothing and the last resort looks at it. */
  const keepAged = (ageS, accuracy = 20) => keep(ageS * 1000 - WAITED_MS, accuracy)
  /** The precise path with no reading at all, until it gives up (and the last resort has answered). */
  async function preciseWithNothing() {
    const out = ask({ precise: true })
    await vi.advanceTimersByTimeAsync(WAITED_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.done).toBe(true)
    return out.value
  }

  describe('keeping it', () => {
    it('keeps a usable reading with the time of the reading, not the time of keeping it', async () => {
      const phone = fakePhone()
      const taken = Date.now() - 4200
      const out = ask({ precise: true })
      phone.reading(PRECISE_TARGET_ACCURACY_M, 4200)
      await vi.advanceTimersByTimeAsync(0)
      expect(out.value.fix).toMatchObject({ accuracy: PRECISE_TARGET_ACCURACY_M, age_s: 4 })
      expect(kept()).toEqual({ lat: 32.08, lng: 34.78, accuracy: PRECISE_TARGET_ACCURACY_M, taken_at: taken })
    })

    it("does not keep a usable answer of the quick path's first request: the browser may have remembered it from before this person signed in", async () => {
      const phone = fakePhone({ browser: { accuracy: 40, ageMs: 100_000 } })
      const res = await getFix()
      expect(res.fix, 'it is still what this scan sends').toMatchObject({ accuracy: 40, age_s: 100 })
      expect(phone.quickRequests, 'it was asked for a remembered position').toEqual([{ enableHighAccuracy: false, timeout: 4000, maximumAge: GPS_MAX_STALE_AGE_S * 1000 }])
      expect(localStorage.getItem(LAST_FIX_KEY)).toBeNull()
    })

    it("keeps the quick path's fresh second request, with the time of that reading", async () => {
      const phone = fakePhone({ browser: (options) => (options.maximumAge === 0 ? { accuracy: 25, ageMs: 1500 } : { accuracy: GPS_MAX_USABLE_ACCURACY_M + 50, ageMs: 100_000 }) })
      const taken = Date.now() - 1500
      const res = await getFix()
      expect(res.fix).toMatchObject({ accuracy: 25, age_s: 2 })
      expect(phone.quickRequests.map((o) => o.maximumAge)).toEqual([GPS_MAX_STALE_AGE_S * 1000, 0])
      expect(kept()).toEqual({ lat: 32.08, lng: 34.78, accuracy: 25, taken_at: taken })
    })

    it('keeps the answer of a first request that allowed no remembered position (maxAgeMs: 0), which is live', async () => {
      fakePhone({ browser: { accuracy: 40, ageMs: 1000 } })
      await getFix({ maxAgeMs: 0 })
      expect(kept()).toMatchObject({ accuracy: 40, taken_at: Date.now() - 1000 })
    })

    it('never keeps a reading that is too vague for the server, and keeps one of exactly the limit', async () => {
      const phone = fakePhone()
      const out = ask({ precise: true })
      phone.reading(GPS_MAX_USABLE_ACCURACY_M + 1)
      await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS)
      expect(out.value.fix.accuracy).toBe(GPS_MAX_USABLE_ACCURACY_M + 1)
      expect(localStorage.getItem(LAST_FIX_KEY)).toBeNull()

      const exact = fakePhone()
      const usable = ask({ precise: true })
      exact.reading(GPS_MAX_USABLE_ACCURACY_M)
      await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS)
      expect(usable.value.fix.accuracy).toBe(GPS_MAX_USABLE_ACCURACY_M)
      expect(kept().accuracy).toBe(GPS_MAX_USABLE_ACCURACY_M)
    })

    it('does not replace a younger position with an older one', async () => {
      keep(10_000)
      const before = localStorage.getItem(LAST_FIX_KEY)
      const old = fakePhone()
      const first = ask({ precise: true })
      old.reading(PRECISE_TARGET_ACCURACY_M, 100_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(first.done).toBe(true)
      expect(localStorage.getItem(LAST_FIX_KEY)).toBe(before)

      const young = fakePhone()
      const second = ask({ precise: true })
      young.reading(PRECISE_TARGET_ACCURACY_M, 2000)
      await vi.advanceTimersByTimeAsync(0)
      expect(second.done).toBe(true)
      expect(kept().taken_at, 'a younger one does replace it').toBe(Date.now() - 2000)
    })
  })

  describe('using it', () => {
    it('gives the kept position, with its real age, when the precise path got nothing', async () => {
      keepAged(200)
      const phone = fakePhone()
      expect(await preciseWithNothing()).toEqual({ fix: { lat: 32.1, lng: 34.8, accuracy: 20, age_s: 200 }, reason: null })
      expect(phone.cleared).toEqual([1])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('uses a kept position of exactly the limit, and not one a second older, which it also deletes', async () => {
      keepAged(GPS_MAX_STALE_AGE_S)
      fakePhone()
      expect(await preciseWithNothing()).toMatchObject({ fix: { age_s: GPS_MAX_STALE_AGE_S }, reason: null })

      forgetLastFix()
      keepAged(GPS_MAX_STALE_AGE_S + 1)
      fakePhone()
      expect(await preciseWithNothing()).toEqual({ fix: null, reason: 'timeout' })
      expect(localStorage.getItem(LAST_FIX_KEY), 'it can never be used again').toBeNull()
    })

    it('deletes, and does not use, a value that is not a position', async () => {
      const damaged = [
        'not json',
        '{}',
        JSON.stringify({ lat: 1, lng: 2, accuracy: 'x', taken_at: Date.now() }),
        JSON.stringify({ lat: 1, lng: 2, accuracy: 10, taken_at: Date.now() + 60_000 }), // from the future: the clock was set back
      ]
      for (const value of damaged) {
        localStorage.setItem(LAST_FIX_KEY, value)
        fakePhone()
        expect(await preciseWithNothing(), value).toEqual({ fix: null, reason: 'timeout' })
        expect(localStorage.getItem(LAST_FIX_KEY), value).toBeNull()
      }
    })

    it("does not use the browser's own last known position when nothing is kept: it does not even ask for it", async () => {
      const phone = fakePhone({ browser: { accuracy: 35, ageMs: 120_000 } })
      expect(await preciseWithNothing()).toEqual({ fix: null, reason: 'timeout' })
      expect(phone.quickRequests).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it("gives the kept position even when the browser remembers a younger one", async () => {
      keepAged(200)
      const phone = fakePhone({ browser: { accuracy: 35, ageMs: 100_000 } })
      expect(await preciseWithNothing()).toEqual({ fix: { lat: 32.1, lng: 34.8, accuracy: 20, age_s: 200 }, reason: null })
      expect(phone.quickRequests).toHaveLength(0)
    })

    it('ignores a kept position that is too vague for the server', async () => {
      keepAged(10, GPS_MAX_USABLE_ACCURACY_M + 1)
      fakePhone()
      expect(await preciseWithNothing()).toEqual({ fix: null, reason: 'timeout' })
    })

    it('prefers a usable remembered position to a fresh reading that is too vague, and keeps the vague one when there is none', async () => {
      keep(60_000)
      const phone = fakePhone()
      const out = ask({ precise: true })
      phone.reading(GPS_MAX_USABLE_ACCURACY_M + 50)
      await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(out.value.fix).toMatchObject({ lat: 32.1, accuracy: 20 })

      forgetLastFix()
      const bare = fakePhone()
      const vague = ask({ precise: true })
      bare.reading(GPS_MAX_USABLE_ACCURACY_M + 50)
      await vi.advanceTimersByTimeAsync(PRECISE_WAIT_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(vague.value).toMatchObject({ fix: { accuracy: GPS_MAX_USABLE_ACCURACY_M + 50 }, reason: null })
    })

    it('serves the quick path too, after both of its requests have failed, and asks the browser for nothing more', async () => {
      keep(100_000)
      const phone = fakePhone()
      const res = await getFix()
      expect(res).toEqual({ fix: { lat: 32.1, lng: 34.8, accuracy: 20, age_s: 100 }, reason: null })
      expect(phone.quickRequests).toHaveLength(2) // the remembered position and the fresh one
    })
  })

  describe('never using it', () => {
    it('does not use it after the permission was denied: the person does not share the location now', async () => {
      keep(10_000)
      const phone = fakePhone()
      const out = ask({ precise: true })
      phone.fail(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(out.value).toEqual({ fix: null, reason: 'denied' })
      expect(phone.quickRequests, 'it did not even ask the browser').toHaveLength(0)

      const quick = fakePhone({ browser: { error: 1 } })
      expect(await getFix()).toEqual({ fix: null, reason: 'denied' })
      expect(quick.quickRequests, 'the quick path stops at the refusal').toHaveLength(1)
    })

    it('does not use it in a browser without geolocation', async () => {
      keep(10_000)
      vi.stubGlobal('navigator', {})
      const out = ask({ precise: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(out.value).toEqual({ fix: null, reason: 'unsupported' })
      expect(await getFix()).toEqual({ fix: null, reason: 'unsupported' })
    })

    it('does not keep what the last resort gave: the kept position is not refreshed', async () => {
      keepAged(200)
      const before = localStorage.getItem(LAST_FIX_KEY)
      fakePhone()
      await preciseWithNothing()
      expect(localStorage.getItem(LAST_FIX_KEY), 'a position handed back is as old as it was').toBe(before)
    })

    it("never takes a position from before the person signed in: the browser's memory is neither used nor copied", async () => {
      // The previous person's scan left a position in the browser's memory. Nothing was kept by the app (it was deleted at sign-out).
      const phone = fakePhone({ browser: { accuracy: 35, ageMs: 100_000 } })
      expect(await preciseWithNothing()).toEqual({ fix: null, reason: 'timeout' })
      expect(phone.quickRequests).toHaveLength(0)
      expect(localStorage.getItem(LAST_FIX_KEY)).toBeNull()
    })

    it('is forgotten by forgetLastFix', async () => {
      const phone = fakePhone()
      const out = ask({ precise: true })
      phone.reading(PRECISE_TARGET_ACCURACY_M)
      await vi.advanceTimersByTimeAsync(0)
      expect(out.done).toBe(true)
      expect(kept()).not.toBeNull()

      forgetLastFix()
      expect(localStorage.getItem(LAST_FIX_KEY)).toBeNull()
      fakePhone()
      expect(await preciseWithNothing()).toEqual({ fix: null, reason: 'timeout' })
      forgetLastFix() // nothing kept: no error
    })
  })
})
