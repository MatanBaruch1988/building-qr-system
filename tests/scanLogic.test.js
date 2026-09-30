import { describe, it, expect } from 'vitest'
import { parseQrToken, evaluateGps, resolveClock, haversineMeters } from '../server/scanLogic.js'
import { hashPassword, verifyPassword } from '../server/crypto.js'

const point = { lat: 32.3132, lng: 34.9442, radius_m: 50 }
// ~111 m per 0.001° of latitude
const at = (metersNorth) => ({ lat: point.lat + metersNorth / 111_000, lng: point.lng })

describe('parseQrToken', () => {
  it('accepts the printed URL of the legacy format', () => {
    expect(parseQrToken('https://building-qr-system.web.app/scan?code=BQR-1770182174672-1770182174672-mftfhf'))
      .toBe('BQR-1770182174672-1770182174672-mftfhf')
  })
  it('accepts the bare token and new-style tokens', () => {
    expect(parseQrToken('BQR-1770182174672-1770182174672-mftfhf')).toBe('BQR-1770182174672-1770182174672-mftfhf')
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
  it('flags but accepts a fix a bit outside the radius', () => {
    const r = evaluateGps({ mode: 'optional', point, gps: { ...at(150), accuracy: 10 } })
    expect(r.outcome).toBe('accepted')
    expect(r.flags).toEqual(['location_outside_radius'])
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
