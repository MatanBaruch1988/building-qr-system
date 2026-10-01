import { describe, it, expect } from 'vitest'
import { DICTS, LANGS, translate, pickLang, dirOf, makeFormatters } from '../src/i18n/core.js'
import { KNOWN_ERROR_CODES } from '../src/worker/errors.js'

const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const strip = (s) => s.replace(/[⁨⁩]/g, '')

describe('dictionaries stay in sync', () => {
  const baseKeys = Object.keys(DICTS.he).sort()
  for (const { code } of LANGS) {
    it(`${code}: same keys as Hebrew, none empty`, () => {
      expect(Object.keys(DICTS[code]).sort()).toEqual(baseKeys)
      for (const key of baseKeys) expect(DICTS[code][key].trim(), `${code}:${key}`).not.toBe('')
    })
    it(`${code}: same {placeholders} as Hebrew for every key`, () => {
      for (const key of baseKeys) expect(params(DICTS[code][key]), `${code}:${key}`).toEqual(params(DICTS.he[key]))
    })
  }
  it('every server refusal the worker app shows specifically has a message in every language', () => {
    for (const { code: lang } of LANGS) {
      for (const code of KNOWN_ERROR_CODES) expect(DICTS[lang][`error.${code}`], `${lang}:${code}`).toBeTruthy()
      expect(DICTS[lang]['error.generic']).toBeTruthy()
    }
  })
})

describe('translate', () => {
  it('interpolates and isolates names so mixed scripts do not scramble punctuation', () => {
    const out = translate('he', 'checkin.success.body', { point: 'Lobby', time: '08:12' })
    expect(strip(out)).toBe('Lobby · 08:12')
    expect(out).toContain('⁨Lobby⁩')
  })
  it('falls back to Hebrew, then to the key', () => {
    expect(translate('xx', 'app.name')).toBe(DICTS.he['app.name'])
    expect(translate('en', 'no.such.key')).toBe('no.such.key')
  })
  it('leaves an unknown placeholder untouched', () => {
    expect(translate('en', 'login.pointBanner', {})).toContain('{name}')
  })
})

describe('language choice', () => {
  it('prefers an explicit choice, then the provider profile, then Hebrew', () => {
    expect(pickLang({ stored: 'ru', provider: 'ar' })).toBe('ru')
    expect(pickLang({ stored: null, provider: 'ar' })).toBe('ar')
    expect(pickLang({ stored: 'klingon', provider: 'nope' })).toBe('he')
    expect(pickLang()).toBe('he')
  })
  it("ignores the phone's own language: the app opens in Hebrew even on an English phone", () => {
    // a `browser` hint (what the old code accepted) must have no effect any more
    expect(pickLang({ browser: ['en-US', 'ru'] })).toBe('he')
    expect(pickLang({ provider: undefined, browser: ['ar-EG'] })).toBe('he')
  })
  it('right-to-left for Hebrew and Arabic only', () => {
    expect(['he', 'ar', 'en', 'ru'].map(dirOf)).toEqual(['rtl', 'rtl', 'ltr', 'ltr'])
  })
})

describe('formatters', () => {
  it('shows building time (Asia/Jerusalem) in 24h, with Western digits even in Arabic', () => {
    // 2026-09-30T05:12:00Z is 08:12 in Israel (UTC+3 in summer time)
    for (const lang of ['he', 'en', 'ru', 'ar']) {
      expect(makeFormatters(lang).time('2026-09-30T05:12:00Z'), lang).toMatch(/^08[:.]12$/)
    }
  })
  it('formats distances in meters, switching to km when large', () => {
    const f = makeFormatters('en')
    expect(f.distance(153.4)).toMatch(/153/)
    expect(f.distance(5200)).toMatch(/5\.2/)
    expect(f.distance(0.2)).toMatch(/^1\D/)
  })
})
