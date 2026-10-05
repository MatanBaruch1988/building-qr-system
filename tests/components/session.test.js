// @vitest-environment jsdom
// The session that the provider app keeps on the phone (src/worker/session.js).
//
// The home screen reads `session.provider` on every start. A stored value that lacks usable provider details used to make
// it fail on every start (the screen that replaces a broken one, "Try again" and "Reload the app" all read the same bad value
// again), and the only way out for a service provider was to clear the site's data, which nobody knows how to do. So what is
// read back is checked, and a value that is not a usable session is removed and counts as signed out.
//
// And the phone is old: an installed app keeps its own copy of the JavaScript for weeks and keeps what it stored
// (AGENTS.md, "Database and API changes"). The sessions that EARLIER versions of the app stored must still be accepted,
// unchanged, or every phone that has one is signed out by this change. Every shape that was ever written is in VALID below,
// found in git (src/worker/session.js has not changed since the first v2 commit; what changed is the provider details that the
// server sent, and the app stores them as they come).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { loadSession, saveSession, clearSession, isSession, isProvider, isProviderToken } from '../../src/worker/session.js'
import { safeStorage } from '../../src/worker/storage.js'
import { PROVIDER_TOKEN_PREFIX, MAX_TOKEN_LENGTH } from '../../shared/contract.js'
import { SAMPLE_PROVIDER_NAMES } from '../../scripts/sample-data.mjs'

const KEY = 'qr.session'
const PREFIX = PROVIDER_TOKEN_PREFIX
const TOKEN = PREFIX + 'a'.repeat(43) // as long as a minted one: the prefix and 32 random bytes in base64url
const ID = '00000000-0000-4000-8000-000000000001'

const raw = (value) => JSON.stringify(value)

afterEach(() => {
  vi.restoreAllMocks()
  clearSession()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// ---- every shape that a version of the app could have stored ------------------------------------------------------------

const DETAILS = { id: ID, company: 'Sample Cleaning', contact_name: SAMPLE_PROVIDER_NAMES.cleaner, service_type: 'cleaning' }

/** [what it is, the stored value] */
const VALID = [
  ['the first v2 sign-in answer: details with a `lang` of their own, no `is_demo` (e1134d5, before the language moved to the phone)', { token: TOKEN, provider: { ...DETAILS, lang: 'he' } }],
  ['the sign-in answer today: id, company, contact person and service type', { token: TOKEN, provider: DETAILS }],
  ['the details of GET /api/session: with `is_demo`', { token: TOKEN, provider: { ...DETAILS, is_demo: true } }],
  ['the details of a provider that is not a demo', { token: TOKEN, provider: { ...DETAILS, is_demo: false } }],
  ['a provider with no contact person (an empty name) and no service type', { token: TOKEN, provider: { id: ID, company: 'Sample Gardening', contact_name: '', service_type: null } }],
  ['details with no contact_name at all (the app falls back to the company)', { token: TOKEN, provider: { id: ID, company: 'Sample Gardening' } }],
  ['details with a null contact_name', { token: TOKEN, provider: { id: ID, company: 'Sample Gardening', contact_name: null } }],
  ['a field that a newer version stores and this one does not know', { token: TOKEN, provider: { ...DETAILS, badge: 'x' }, issued: 1 }],
  ['a token as long as a token can be', { token: PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH - PREFIX.length), provider: DETAILS }],
  ['a token of the shortest shape (the prefix and one character)', { token: PREFIX + 'x', provider: DETAILS }],
]

describe('a stored session that an earlier version could have written is accepted, unchanged', () => {
  it.each(VALID)('%s (localStorage, "remember me")', (_what, stored) => {
    window.localStorage.setItem(KEY, raw(stored))
    expect(loadSession()).toEqual({ ...stored, remember: true })
    expect(window.localStorage.getItem(KEY)).toBe(raw(stored)) // read, never rewritten
  })

  it.each(VALID)('%s (sessionStorage, not remembered)', (_what, stored) => {
    window.sessionStorage.setItem(KEY, raw(stored))
    expect(loadSession()).toEqual({ ...stored, remember: false })
    expect(window.sessionStorage.getItem(KEY)).toBe(raw(stored))
  })

  it('keeps the details exactly as they were stored (nothing is dropped or added)', () => {
    const stored = { token: TOKEN, provider: { ...DETAILS, lang: 'ru', is_demo: false } }
    window.localStorage.setItem(KEY, raw(stored))
    expect(Object.keys(loadSession().provider).sort()).toEqual(Object.keys(stored.provider).sort())
  })

  it('what saveSession writes is read back, with and without "remember me"', () => {
    saveSession({ token: TOKEN, provider: DETAILS }, true)
    expect(loadSession()).toEqual({ token: TOKEN, provider: DETAILS, remember: true })
    saveSession({ token: TOKEN, provider: DETAILS }, false)
    expect(loadSession()).toEqual({ token: TOKEN, provider: DETAILS, remember: false })
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })
})

// ---- what is not a usable session ---------------------------------------------------------------------------------------

const BAD_TOKENS = [
  ['no token', undefined],
  ['a token that is null', null],
  ['an empty token', ''],
  ['a token that is a number', 12345],
  ['a token that is an object', { value: TOKEN }],
  ['a token that is a list', [TOKEN]],
  ['a token with no prefix', 'a'.repeat(43)],
  ['the prefix of a committee session', 'qra_' + 'a'.repeat(43)],
  ['the prefix of an agent key', 'qrk_' + 'a'.repeat(43)],
  ['the prefix in capital letters', PREFIX.toUpperCase() + 'a'.repeat(43)],
  ['a space before the prefix', ' ' + TOKEN],
  ['the prefix alone', PREFIX],
  ['a token one character longer than a token can be', PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH - PREFIX.length + 1)],
]

const BAD_PROVIDERS = [
  ['no provider', undefined],
  ['a provider that is null', null],
  ['a provider that is a string', 'Sample Cleaning'],
  ['a provider that is a number', 7],
  ['a provider that is a list', [DETAILS]],
  ['a provider that is empty', {}],
  ['a provider with no id', { company: 'Sample Cleaning', contact_name: 'x' }],
  ['a provider whose id is a number', { ...DETAILS, id: 1 }],
  ['a provider whose id is empty', { ...DETAILS, id: '' }],
  ['a provider whose id is an object', { ...DETAILS, id: { value: ID } }],
  ['a provider with no company', { id: ID, contact_name: 'x' }],
  ['a provider whose company is null', { ...DETAILS, company: null }],
  ['a provider whose company is a number', { ...DETAILS, company: 3 }],
  ['a provider whose contact person is an object', { ...DETAILS, contact_name: { first: 'x' } }],
  ['a provider whose contact person is a number', { ...DETAILS, contact_name: 3 }],
]

/** [what it is, the text that is stored] */
const REJECTED = [
  ['text that is not JSON', 'not json{'],
  ['an empty string', ''],
  ['JSON null', 'null'],
  ['JSON that is a string', '"just text"'],
  ['JSON that is a number', '7'],
  ['JSON true', 'true'],
  ['JSON that is a list', '[]'],
  ['a list that holds a session', raw([{ token: TOKEN, provider: DETAILS }])],
  ['an empty object', '{}'],
  ...BAD_TOKENS.map(([what, token]) => [what, raw({ token, provider: DETAILS })]),
  ...BAD_PROVIDERS.map(([what, provider]) => [what, raw({ token: TOKEN, provider })]),
]

describe('a stored value that is not a usable session counts as signed out and is removed', () => {
  it.each(REJECTED)('%s (localStorage)', (_what, text) => {
    window.localStorage.setItem(KEY, text)
    expect(loadSession()).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBeNull() // gone, so the next start does not meet it again
    expect(loadSession()).toBeNull()
  })

  it.each(REJECTED)('%s (sessionStorage)', (_what, text) => {
    window.sessionStorage.setItem(KEY, text)
    expect(loadSession()).toBeNull()
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
    expect(loadSession()).toBeNull()
  })

  it('removes only the storage that held the bad value: a good session in the other one is used and kept', () => {
    window.localStorage.setItem(KEY, raw({ token: TOKEN, provider: null }))
    window.sessionStorage.setItem(KEY, raw({ token: TOKEN, provider: DETAILS }))
    expect(loadSession()).toEqual({ token: TOKEN, provider: DETAILS, remember: false })
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(window.sessionStorage.getItem(KEY)).toBe(raw({ token: TOKEN, provider: DETAILS }))
  })

  it('removes both when both are bad', () => {
    window.localStorage.setItem(KEY, 'not json{')
    window.sessionStorage.setItem(KEY, raw({ token: TOKEN }))
    expect(loadSession()).toBeNull()
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
  })

  it('does not touch the other things that the phone keeps (the language, the theme, the waiting check-ins)', () => {
    window.localStorage.setItem('qr.lang', 'ru')
    window.localStorage.setItem('qr.theme', 'dark')
    window.localStorage.setItem('qr.queue.v1', '[]')
    window.localStorage.setItem(KEY, raw({ token: TOKEN }))
    expect(loadSession()).toBeNull()
    expect(window.localStorage.getItem('qr.lang')).toBe('ru')
    expect(window.localStorage.getItem('qr.theme')).toBe('dark')
    expect(window.localStorage.getItem('qr.queue.v1')).toBe('[]')
  })

  it('is signed out when nothing is stored, and removes nothing', () => {
    const removed = vi.spyOn(Storage.prototype, 'removeItem')
    expect(loadSession()).toBeNull()
    expect(removed).not.toHaveBeenCalled()
  })
})

describe('storage that the browser blocks', () => {
  it('reads a session that only lives in memory (localStorage refuses to write), and removes a bad one from there too', () => {
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === window.localStorage) throw new Error('quota')
      return real.call(this, key, value)
    })
    saveSession({ token: TOKEN, provider: DETAILS }, true) // kept in memory until the tab closes
    expect(loadSession()).toEqual({ token: TOKEN, provider: DETAILS, remember: true })

    safeStorage.setItem(KEY, raw({ token: TOKEN })) // memory again, now with a value that cannot be used
    expect(loadSession()).toBeNull()
    expect(safeStorage.getItem(KEY)).toBeNull()
  })

  it('is signed out, and does not throw, when sessionStorage throws on every read', () => {
    const real = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) {
      if (this === window.sessionStorage) throw new Error('blocked')
      return real.call(this, key)
    })
    expect(loadSession()).toBeNull()
  })
})

// ---- the pieces ---------------------------------------------------------------------------------------------------------

describe('the token shape is the one the server checks before any query', () => {
  it('accepts the prefix and up to MAX_TOKEN_LENGTH characters in all, and nothing else', () => {
    expect(isProviderToken(TOKEN)).toBe(true)
    expect(isProviderToken(PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH - PREFIX.length))).toBe(true)
    expect(isProviderToken(PREFIX + 'a'.repeat(MAX_TOKEN_LENGTH - PREFIX.length + 1))).toBe(false)
    expect(isProviderToken(PREFIX)).toBe(false)
    expect(isProviderToken('')).toBe(false)
    expect(isProviderToken(undefined)).toBe(false)
    expect(isProviderToken(null)).toBe(false)
    expect(isProviderToken(['qrp_x'])).toBe(false)
  })
})

describe('provider details and sessions', () => {
  it('isProvider is true for the details of every version of the server, false for what the screens cannot draw', () => {
    for (const [, stored] of VALID) expect(isProvider(stored.provider), JSON.stringify(stored.provider)).toBe(true)
    for (const [what, provider] of BAD_PROVIDERS) expect(isProvider(provider), what).toBe(false)
  })

  it('isSession needs both a token of ours and usable details', () => {
    expect(isSession({ token: TOKEN, provider: DETAILS })).toBe(true)
    expect(isSession({ token: TOKEN })).toBe(false)
    expect(isSession({ provider: DETAILS })).toBe(false)
    expect(isSession(null)).toBe(false)
    expect(isSession(undefined)).toBe(false)
    expect(isSession('text')).toBe(false)
    expect(isSession([])).toBe(false)
  })
})
