// The invented sample values (scripts/sample-data.mjs) keep the relations that the other tests rely on: "far" is far,
// the legacy codes are in the legacy format and are accepted by the server, and the names sort the way the tests expect.
import { describe, it, expect } from 'vitest'
import { haversineMeters, parseQrToken } from '../server/scanLogic.js'
import {
  SAMPLE_POINT, SAMPLE_FAR_POINT, SAMPLE_COARSE_POINT, SAMPLE_PROVIDER_NAMES, SAMPLE_LEGACY_TOKENS,
} from '../scripts/sample-data.mjs'

const metersBetween = (a, b) => haversineMeters(a.lat, a.lng, b.lat, b.lng)

describe('sample locations', () => {
  it('are valid coordinates, as the admin API validates them', () => {
    for (const p of [SAMPLE_POINT, SAMPLE_FAR_POINT, SAMPLE_COARSE_POINT]) {
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(p.lng)).toBeLessThanOrEqual(180)
    }
  })
  it('put the far point about 5.5 km due north of the sample point (clearly beyond any point radius)', () => {
    expect(SAMPLE_FAR_POINT.lng).toBe(SAMPLE_POINT.lng)
    expect(SAMPLE_FAR_POINT.lat).toBeGreaterThan(SAMPLE_POINT.lat)
    const d = metersBetween(SAMPLE_POINT, SAMPLE_FAR_POINT)
    expect(d).toBeGreaterThan(5400)
    expect(d).toBeLessThan(5700)
  })
  it('keep the coarse point a few hundred metres from the sample point', () => {
    const d = metersBetween(SAMPLE_POINT, SAMPLE_COARSE_POINT)
    expect(d).toBeGreaterThan(200)
    expect(d).toBeLessThan(1000)
  })
})

describe('sample provider names', () => {
  it('are two different names, and the gardener sorts before the cleaner', () => {
    const { cleaner, gardener } = SAMPLE_PROVIDER_NAMES
    expect(cleaner).not.toBe(gardener)
    expect([cleaner, gardener].sort()).toEqual([gardener, cleaner])
  })
  it('do not contain each other (a sign-in test finds a person by a pattern made of the name)', () => {
    const { cleaner, gardener } = SAMPLE_PROVIDER_NAMES
    expect(cleaner.includes(gardener)).toBe(false)
    expect(gardener.includes(cleaner)).toBe(false)
  })
})

describe('sample legacy tokens', () => {
  const tokens = Object.values(SAMPLE_LEGACY_TOKENS)
  it('have the legacy shape: BQR-, a 13 digit timestamp twice, 6 characters', () => {
    for (const token of tokens) {
      const m = /^BQR-(\d{13})-(\d{13})-([a-z0-9]{6})$/.exec(token)
      expect(m, token).not.toBeNull()
      expect(m[1]).toBe(m[2])
    }
  })
  it('are different from each other and accepted by the scan rules, bare or inside the old printed URL', () => {
    expect(new Set(tokens).size).toBe(tokens.length)
    for (const token of tokens) {
      expect(parseQrToken(token)).toBe(token)
      expect(parseQrToken(`https://building-qr-system.web.app/scan?code=${token}`)).toBe(token)
    }
  })
})
