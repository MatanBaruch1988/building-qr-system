import { describe, it, expect } from 'vitest'
import { parseQrToken, evaluateGps, resolveClock, haversineMeters } from '../server/scanLogic.js'
import { hashPassword, verifyPassword } from '../server/crypto.js'
import { SAMPLE_POINT, SAMPLE_LEGACY_TOKENS } from '../scripts/sample-data.mjs'

const point = { ...SAMPLE_POINT, radius_m: 50 }
// ~111 m per 0.001° of latitude
const at = (metersNorth) => ({ lat: point.lat + metersNorth / 111_000, lng: point.lng })

describe('parseQrToken', () => {
  it('accepts the printed URL of the legacy format', () => {
    expect(parseQrToken(`https://building-qr-system.web.app/scan?code=${SAMPLE_LEGACY_TOKENS.printed}`))
      .toBe(SAMPLE_LEGACY_TOKENS.printed)
  })
  it('accepts the bare token and new-style tokens', () => {
    expect(parseQrToken(SAMPLE_LEGACY_TOKENS.printed)).toBe(SAMPLE_LEGACY_TOKENS.printed)
    expect(parseQrToken('BQR-0123456789abcdef01234567')).toBe('BQR-0123456789abcdef01234567')
  })
  it('rejects anything else', () => {
    for (const bad of [null, undefined, '', 'hello', 'https://evil.example/scan?code=XYZ', 'BQR-', 'BQR-a b c d e f g']) {
      expect(parseQrToken(bad)).toBeNull()
    }
  })
})

describe('haversineMeters', () => {
  it('is ~111 m per 0.001 degrees of latitude', () => {
    const d = haversineMeters(32, 35, 32.001, 35)
    expect(d).toBeGreaterThan(105)
    expect(d).toBeLessThan(117)
  })
})

describe('evaluateGps (soft GPS)', () => {
  it('accepts a good fix at the point, no flags', () => {
    const r = evaluateGps({ mode: 'optional', point, gps: { ...at(10), accuracy: 15 } })
    expect(r.outcome).toBe('accepted')
    expect(r.flags).toEqual([])
    expect(r.distance_m).toBeLessThan(20)
    expect(r.gps_accuracy_m).toBe(15)
  })
  it('rejects a usable fix that is clearly far away (scan from home)', () => {
    const r = evaluateGps({ mode: 'optional', point, gps: { ...at(5000), accuracy: 20 } })
    expect(r.outcome).toBe('rejected_far')
    expect(r.distance_m).toBeGreaterThan(4000)
  })
  it('does not reject when the fix is too vague to trust, even if far', () => {
    const r = evaluateGps({ mode: 'optional', point, gps: { ...at(5000), accuracy: 900 } })
    expect(r.outcome).toBe('accepted')
    expect(r.flags).toEqual(['location_unverified'])
  })
  it('accepts with location_unverified when no fix was sent (basement / no reception)', () => {
    const r = evaluateGps({ mode: 'optional', point, gps: null })
    expect(r.outcome).toBe('accepted')
    expect(r.flags).toEqual(['location_unverified'])
    expect(r.distance_m).toBeNull()
  })
  it("requires a usable fix for 'required' points", () => {
    expect(evaluateGps({ mode: 'required', point, gps: null }).outcome).toBe('rejected_no_location')
    expect(evaluateGps({ mode: 'required', point, gps: { ...at(5), accuracy: 900 } }).outcome).toBe('rejected_no_location')
    expect(evaluateGps({ mode: 'required', point, gps: { ...at(5), accuracy: 10 } }).outcome).toBe('accepted')
  })
  // 'required' and 'optional' judge a usable fix identically; they differ only when there is none (tests above).
  describe.each(['required', 'optional'])("%s points are strict about a usable fix: the circle + 15 m, crediting the phone's own inaccuracy (up to 50 m)", (mode) => {
    const judge = (metersAway, accuracy) => evaluateGps({ mode, point, gps: { ...at(metersAway), accuracy } })
    it('accepts inside the circle without a flag', () => {
      const r = judge(40, 10)
      expect(r.outcome).toBe('accepted')
      expect(r.flags).toEqual([])
    })
    it('accepts just outside the circle (inside the 15 m pin tolerance) but flags it', () => {
      // 60 m away at 5 m accuracy: 55 m after credit, 5 m outside a 50 m circle
      const r = judge(60, 5)
      expect(r.outcome).toBe('accepted')
      expect(r.flags).toEqual(['location_outside_radius'])
    })
    it('refuses beyond circle + 15 m: 100 m away at a good fix is not "near the point"', () => {
      const r = judge(100, 10)
      expect(r.outcome).toBe('rejected_far')
      expect(r.distance_m).toBeGreaterThan(95)
    })
    it('no longer accepts a fix a few hundred metres away (the old 250 m margin is gone)', () => {
      expect(judge(150, 10).outcome).toBe('rejected_far')
      expect(judge(300, 10).outcome).toBe('rejected_far')
    })
    it("credits the phone's own inaccuracy, so an honest weak reading is not punished", () => {
      expect(judge(100, 40).outcome).toBe('accepted') // 100 - 40 = 60 <= 50 + 15
    })
    it('but only up to 50 m: a very vague reading cannot stretch the circle', () => {
      expect(judge(200, 140).outcome).toBe('rejected_far') // credit capped at 50: 150 > 65
      expect(judge(110, 50).outcome).toBe('accepted') // 60 <= 65
      expect(judge(120, 50).outcome).toBe('rejected_far') // 70 > 65
    })
  })
  describe('a remembered position is where the phone WAS', () => {
    const remembered = (mode, metersAway, accuracy, age_s) => evaluateGps({ mode, point, gps: { ...at(metersAway), accuracy, age_s } })
    it('a fresh reading (or one under a minute old) is judged as is, with no flag', () => {
      expect(remembered('optional', 40, 10, 5).flags).toEqual([])
      expect(remembered('optional', 100, 10, 30).outcome).toBe('rejected_far')
    })
    it("'optional': an honest walk since the reading is allowed for (2 m/s) and the reading is flagged", () => {
      // from the lobby 4 minutes ago: 300 m away then, 240 s * 2 m/s = 480 m of room
      const r = remembered('optional', 300, 10, 240)
      expect(r.outcome).toBe('accepted')
      expect(r.flags).toEqual(['location_stale'])
    })
    it("'optional': but not a reading from kilometres away, however old", () => {
      expect(remembered('optional', 5000, 10, 240).outcome).toBe('rejected_far')
      expect(remembered('optional', 5000, 10, 86_400).outcome).toBe('rejected_far') // the room is capped at 5 minutes of walking
    })
    it("'required' points get no such room: they ask for a fresh reading", () => {
      expect(remembered('required', 300, 10, 240).outcome).toBe('rejected_far')
      const near = remembered('required', 30, 10, 240) // still flagged when it is near
      expect(near.outcome).toBe('accepted')
      expect(near.flags).toEqual(['location_stale'])
    })
    it('a missing or nonsense age means "fresh"', () => {
      for (const age_s of [undefined, null, NaN, 'x', -5]) expect(remembered('optional', 300, 10, age_s).outcome).toBe('rejected_far')
    })
  })
  it("the two modes differ only when the phone cannot say where it is", () => {
    for (const gps of [null, { ...at(5), accuracy: 900 }]) {
      expect(evaluateGps({ mode: 'required', point, gps }).outcome).toBe('rejected_no_location')
      const optional = evaluateGps({ mode: 'optional', point, gps })
      expect(optional.outcome).toBe('accepted')
      expect(optional.flags).toEqual(['location_unverified'])
    }
  })
  it("never judges 'none' points but still records the evidence", () => {
    const r = evaluateGps({ mode: 'none', point, gps: { ...at(5000), accuracy: 10 } })
    expect(r.outcome).toBe('accepted')
    expect(r.flags).toEqual([])
    expect(r.distance_m).toBeGreaterThan(4000)
  })
  it('cannot judge a point that has no coordinates: accepts, but says the location is unverified', () => {
    for (const mode of ['required', 'optional']) {
      const r = evaluateGps({ mode, point: { lat: null, lng: null, radius_m: 50 }, gps: { lat: 1, lng: 2, accuracy: 5 } })
      expect(r.outcome).toBe('accepted')
      expect(r.flags).toEqual(['location_unverified'])
    }
    expect(evaluateGps({ mode: 'none', point: { lat: null, lng: null, radius_m: 50 }, gps: null }).flags).toEqual([])
  })
  it('ignores malformed fixes', () => {
    const r = evaluateGps({ mode: 'optional', point, gps: { lat: 'x', lng: 34, accuracy: 5 } })
    expect(r.flags).toEqual(['location_unverified'])
  })
})

describe('resolveClock', () => {
  const now = new Date('2026-09-30T10:00:00Z')
  it('online: uses the server time and only flags a skewed phone clock', () => {
    const ok = resolveClock({ source: 'online', clientTime: '2026-09-30T09:59:00Z', now })
    expect(ok.checkedInAt).toEqual(now)
    expect(ok.flags).toEqual([])
    const skew = resolveClock({ source: 'online', clientTime: '2026-09-30T08:00:00Z', now })
    expect(skew.flags).toEqual(['clock_skew'])
  })
  it('online: an unbelievable phone time is flagged; no phone time is not', () => {
    for (const clientTime of ['0000-01-01', 'garbage', -8.64e15]) {
      const r = resolveClock({ source: 'online', clientTime, now })
      expect(r.checkedInAt).toEqual(now)
      expect(r.clientTime).toBeNull()
      expect(r.flags).toEqual(['clock_skew'])
    }
    expect(resolveClock({ source: 'online', clientTime: undefined, now }).flags).toEqual([])
  })
  it('offline: keeps a plausible phone time', () => {
    const r = resolveClock({ source: 'offline_sync', clientTime: '2026-09-30T06:30:00Z', now })
    expect(r.checkedInAt.toISOString()).toBe('2026-09-30T06:30:00.000Z')
    expect(r.flags).toEqual(['offline_sync'])
  })
  it('offline: falls back to server time and flags an implausible or missing clock', () => {
    for (const clientTime of ['2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z', undefined, 'garbage']) {
      const r = resolveClock({ source: 'offline_sync', clientTime, now })
      expect(r.checkedInAt).toEqual(now)
      expect(r.flags).toEqual(['offline_sync', 'clock_skew'])
    }
  })
  it('offline: a phone slightly ahead is clamped to now', () => {
    const r = resolveClock({ source: 'offline_sync', clientTime: '2026-09-30T10:02:00Z', now })
    expect(r.checkedInAt).toEqual(now)
    expect(r.flags).toEqual(['offline_sync'])
  })
})

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const stored = await hashPassword('correct horse')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('wrong', stored)).toBe(false)
    expect(await verifyPassword('x', null)).toBe(false)
    expect(await verifyPassword('x', 'sha256:abcd')).toBe(false)
  })
  it('salts: same password hashes differently', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })
})
