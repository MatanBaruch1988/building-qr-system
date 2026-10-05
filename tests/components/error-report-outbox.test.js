// @vitest-environment jsdom
// What an app tells the server about its own errors (ADR 0007, decision 3; src/ui/errorReport.js for the outbox, the place and the
// reporter, src/ui/crash.js for what notes a crash and an error that nothing caught). The two apps wired to it are in
// tests/components/error-report.test.jsx and tests/components/error-report-committee.test.jsx, and the server side in tests/client-errors.test.js.
//
// What this file proves, with no browser and no network (the clock, the storage and the sender are the test's own):
//   - the outbox: an event is aggregated by kind, screen, name, code and build with a count; no more than MAX_CLIENT_ERROR_EVENTS entries
//     are kept (a new key beyond that is dropped, an old one still counts) and a count stops at CLIENT_ERROR_MAX_COUNT; a value that is
//     not valid is dropped (the whole event when it is the kind or the screen, the field when it is a name, a code or a build); what is
//     read back is checked again, and a storage that is corrupt or that throws is never an error;
//   - nothing that a person could have typed is stored or sent: an error whose message holds a fake personal value leaves only its name;
//   - the screen: set by the app, read when something breaks, `provider:app` / `committee:app` without one, never the address;
//   - what nothing caught: an error from our own origin is noted, one from another origin is not, a rejection is noted by the error's
//     name or, for something that is not an Error, by the code `non_error`, and none of it hides the error from the browser;
//   - when a report is sent: not for nobody, not offline, not with nothing to say, not twice at once, at most once a minute; a 200
//     removes exactly what was sent, a 404 stops it for the run, a 401 goes to the app's own handling, any other answer keeps the entries;
//   - the report only carries the other app's entries when they are its own, and never a field that is not on the list;
//   - nothing is ever written to the console (the end-to-end console guard fails on any console.error).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ERRORS_KEY, ERROR_REPORT_MIN_INTERVAL_MS, noteClientError, readOutbox, removeSent, setPlace, currentPlace, createErrorReporter,
} from '../../src/ui/errorReport.js'
import { reportCrash, watchUnhandledErrors, isOwnOrigin } from '../../src/ui/crash.js'
import { safeStorage } from '../../src/worker/storage.js'
import { ApiError } from '../../src/api/client.js'
import { APP_BUILD } from '../../src/ui/build.js'
import {
  CLIENT_ERROR_KINDS, CLIENT_ERROR_MAX_COUNT, CLIENT_PLACES, MAX_CLIENT_ERROR_EVENTS,
} from '../../shared/contract.js'

const memoryStorage = () => {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }
}
const START = Date.parse('2026-10-05T08:00:00.000Z')
const MINUTE = ERROR_REPORT_MIN_INTERVAL_MS
// A made-up value that only a person could have typed, and that an error message may have been built from.
const SECRET = 'fake-person-7731@example.test 050-0000000'

const crash = { kind: 'crash', place: 'provider:home', name: 'TypeError' }

let consoleSpies
beforeEach(() => {
  consoleSpies = ['error', 'warn', 'log', 'info', 'debug'].map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  setPlace(null)
})
afterEach(() => {
  // Noting and reporting are silent: the end-to-end console guard fails on any console.error, and none of these paths may log.
  const lines = consoleSpies.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))
  vi.restoreAllMocks()
  safeStorage.removeItem(ERRORS_KEY)
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  expect(lines).toEqual([])
})

describe('noting an event', () => {
  it('stores the kind, the screen, the name and the build that is running, with a count of 1', () => {
    const storage = memoryStorage()
    expect(noteClientError(crash, storage)).toBe(true)
    expect(readOutbox(storage)).toEqual([{ kind: 'crash', place: 'provider:home', name: 'TypeError', build: APP_BUILD, count: 1 }])
    expect(JSON.parse(storage.getItem(ERRORS_KEY))).toEqual(readOutbox(storage))
  })

  it('keeps a code of its own, and writes neither a name nor a code that it was not given', () => {
    const storage = memoryStorage()
    noteClientError({ kind: 'signed_out', place: 'provider:home', code: 'invalid_session' }, storage)
    noteClientError({ kind: 'unhandled', place: 'committee:points' }, storage)
    expect(readOutbox(storage)).toEqual([
      { kind: 'signed_out', place: 'provider:home', code: 'invalid_session', build: APP_BUILD, count: 1 },
      { kind: 'unhandled', place: 'committee:points', build: APP_BUILD, count: 1 },
    ])
  })

  it('joins an event that has the same kind, screen, name, code and build into one entry with a count', () => {
    const storage = memoryStorage()
    for (let i = 0; i < 3; i++) noteClientError(crash, storage)
    expect(readOutbox(storage)).toEqual([{ ...crash, build: APP_BUILD, count: 3 }])
  })

  it.each([
    ['another kind', { ...crash, kind: 'unhandled' }],
    ['another screen', { ...crash, place: 'provider:login' }],
    ['another name', { ...crash, name: 'RangeError' }],
    ['a code as well', { ...crash, code: 'non_error' }],
  ])('keeps an event that differs by %s apart from the first', (_what, other) => {
    const storage = memoryStorage()
    noteClientError(crash, storage)
    noteClientError(other, storage)
    noteClientError(crash, storage)
    const outbox = readOutbox(storage)
    expect(outbox).toHaveLength(2)
    expect(outbox[0]).toMatchObject({ ...crash, count: 2 })
    expect(outbox[1]).toMatchObject({ ...other, count: 1 })
  })

  it('keeps an entry that another build wrote apart from what this build notes (an installed app keeps old code for weeks)', () => {
    const storage = memoryStorage()
    storage.setItem(ERRORS_KEY, JSON.stringify([{ ...crash, build: 'abc1234', count: 4 }]))
    noteClientError(crash, storage)
    expect(readOutbox(storage)).toEqual([
      { ...crash, build: 'abc1234', count: 4 },
      { ...crash, build: APP_BUILD, count: 1 },
    ])
  })

  it('keeps at most MAX_CLIENT_ERROR_EVENTS entries: a new key beyond that is dropped, and one that is there still counts', () => {
    const storage = memoryStorage()
    for (let i = 0; i < MAX_CLIENT_ERROR_EVENTS; i++) expect(noteClientError({ ...crash, name: `Error${i}` }, storage)).toBe(true)
    expect(noteClientError({ ...crash, name: 'OneTooMany' }, storage)).toBe(false)
    expect(readOutbox(storage)).toHaveLength(MAX_CLIENT_ERROR_EVENTS)
    expect(readOutbox(storage).some((e) => e.name === 'OneTooMany')).toBe(false)
    expect(noteClientError({ ...crash, name: 'Error3' }, storage)).toBe(true)
    expect(readOutbox(storage).find((e) => e.name === 'Error3')?.count).toBe(2)
  })

  it('stops a count at CLIENT_ERROR_MAX_COUNT', () => {
    const storage = memoryStorage()
    storage.setItem(ERRORS_KEY, JSON.stringify([{ ...crash, build: APP_BUILD, count: CLIENT_ERROR_MAX_COUNT - 1 }]))
    noteClientError(crash, storage)
    noteClientError(crash, storage)
    noteClientError(crash, storage)
    expect(readOutbox(storage)[0].count).toBe(CLIENT_ERROR_MAX_COUNT)
  })

  it.each([
    ['no kind', { place: 'provider:home' }],
    ['a kind that is not one of the three', { kind: 'warning', place: 'provider:home' }],
    ['no screen', { kind: 'crash' }],
    ['a screen that is not on the list', { kind: 'crash', place: 'provider:settings' }],
    ['an address as the screen', { kind: 'crash', place: '/admin#history' }],
    ['a screen that is not a string', { kind: 'crash', place: 7 }],
    ['nothing at all', undefined],
    ['null', null],
  ])('drops the whole event when it has %s', (_what, input) => {
    const storage = memoryStorage()
    expect(noteClientError(/** @type {any} */ (input), storage)).toBe(false)
    expect(storage.getItem(ERRORS_KEY)).toBeNull()
  })

  it.each([
    ['a name with a space', 'Error with a message'],
    ['a name that starts with a digit', '7Error'],
    ['a name that is too long', 'E'.repeat(65)],
    ['a name that is an address', 'https://example.test/x'],
    ['a name that is not a string', 42],
  ])('leaves the name out when it is %s, and keeps the event', (_what, name) => {
    const storage = memoryStorage()
    expect(noteClientError({ ...crash, name: /** @type {any} */ (name) }, storage)).toBe(true)
    expect(readOutbox(storage)).toEqual([{ kind: 'crash', place: 'provider:home', build: APP_BUILD, count: 1 }])
  })

  it.each([
    ['capitals', 'Invalid_Session'],
    ['a dash', 'invalid-session'],
    ['a space', 'invalid session'],
    ['too long', 'a'.repeat(41)],
    ['an empty string', ''],
  ])('leaves the code out when it has %s, and keeps the event', (_what, code) => {
    const storage = memoryStorage()
    expect(noteClientError({ kind: 'signed_out', place: 'provider:home', code }, storage)).toBe(true)
    expect(readOutbox(storage)[0]).not.toHaveProperty('code')
  })

  it('reads four fields and ignores the rest: a message, a stack, an address or a token passed along are not kept', () => {
    const storage = memoryStorage()
    noteClientError(
      /** @type {any} */ ({
        ...crash,
        message: SECRET, stack: `TypeError: ${SECRET}\n    at secret (https://example.test/a.js:1:1)`, url: `https://example.test/?q=${SECRET}`,
        body: { name: SECRET }, token: 'qrp_' + 'a'.repeat(43), qrCode: 'BQR-abc123', position: { lat: 1, lng: 2 }, count: 500, build: 'abc1234',
      }),
      storage,
    )
    const stored = storage.getItem(ERRORS_KEY)
    expect(JSON.parse(stored)).toEqual([{ kind: 'crash', place: 'provider:home', name: 'TypeError', build: APP_BUILD, count: 1 }]) // not the count or the build that was passed
    for (const value of [SECRET, 'secret', 'example.test', 'qrp_', 'BQR-', 'lat']) expect(stored).not.toContain(value)
  })

  it('accepts every kind and every screen of the contract', () => {
    const storage = memoryStorage()
    for (const kind of CLIENT_ERROR_KINDS) expect(noteClientError({ kind, place: 'provider:home' }, storage)).toBe(true)
    expect(readOutbox(storage).map((e) => e.kind)).toEqual([...CLIENT_ERROR_KINDS])
    for (const place of CLIENT_PLACES) {
      const fresh = memoryStorage()
      expect(noteClientError({ kind: 'crash', place }, fresh), place).toBe(true)
    }
  })
})

describe('reading the outbox back', () => {
  it.each([
    ['not JSON', '{not json'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['a number', '7'],
    ['an object, not a list', '{"events":[]}'],
    ['an empty list', '[]'],
  ])('a stored value that is %s is an empty outbox, and the next note builds on that', (_what, stored) => {
    const storage = memoryStorage()
    storage.setItem(ERRORS_KEY, stored)
    expect(readOutbox(storage)).toEqual([])
    noteClientError(crash, storage)
    expect(readOutbox(storage)).toHaveLength(1)
  })

  it('checks every entry again: it keeps the valid ones and rebuilds each from the known fields only', () => {
    const storage = memoryStorage()
    storage.setItem(ERRORS_KEY, JSON.stringify([
      { ...crash, build: 'abc1234', count: 2, message: SECRET, stack: 'at x', url: 'https://example.test/' }, // valid, with fields that do not belong
      { kind: 'nope', place: 'provider:home' }, // not a kind
      { kind: 'crash', place: 'provider:elsewhere' }, // not a screen
      'text',
      null,
      [1, 2],
      { kind: 'unhandled', place: 'committee:app', name: 'a name with spaces', code: 'Bad Code', build: 'not-a-build', count: 'many' }, // the fields that are not valid go, the event stays
    ]))
    const outbox = readOutbox(storage)
    expect(outbox).toEqual([
      { kind: 'crash', place: 'provider:home', name: 'TypeError', build: 'abc1234', count: 2 },
      { kind: 'unhandled', place: 'committee:app', count: 1 },
    ])
    expect(JSON.stringify(outbox)).not.toContain(SECRET)
  })

  it('cuts a count to a whole number from 1 to CLIENT_ERROR_MAX_COUNT', () => {
    const storage = memoryStorage()
    storage.setItem(ERRORS_KEY, JSON.stringify([
      { ...crash, name: 'A', count: 10 ** 9 },
      { ...crash, name: 'B', count: -4 },
      { ...crash, name: 'C', count: 1.5 },
      { ...crash, name: 'D', count: '7' },
      { ...crash, name: 'E' },
    ]))
    expect(readOutbox(storage).map((e) => e.count)).toEqual([CLIENT_ERROR_MAX_COUNT, 1, 1, 1, 1])
  })

  it('joins equal entries and keeps no more than MAX_CLIENT_ERROR_EVENTS', () => {
    const storage = memoryStorage()
    const many = Array.from({ length: MAX_CLIENT_ERROR_EVENTS + 5 }, (_, i) => ({ ...crash, name: `Error${i}`, count: 1 }))
    storage.setItem(ERRORS_KEY, JSON.stringify([...many, { ...crash, name: 'Error0', count: 2 }]))
    const outbox = readOutbox(storage)
    expect(outbox).toHaveLength(MAX_CLIENT_ERROR_EVENTS)
    expect(outbox[0]).toMatchObject({ name: 'Error0', count: 3 })
  })

  it('never throws when the storage cannot be read or written, and says that nothing was stored', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('blocked') } }
    expect(readOutbox(broken)).toEqual([])
    expect(noteClientError(crash, broken)).toBe(false)
    expect(() => removeSent([{ ...crash, count: 1 }], broken)).not.toThrow()
  })

  it('keeps the note in memory when the browser refuses to store it (the safe storage), and reports it from there', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(noteClientError(crash)).toBe(true)
    expect(readOutbox()).toEqual([{ ...crash, build: APP_BUILD, count: 1 }])
  })

  it('works when the browser refuses to read the storage as well', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => noteClientError(crash)).not.toThrow()
    expect(readOutbox()).toHaveLength(1)
  })
})

describe('removing what was sent', () => {
  it('takes off the count that was sent, and removes an entry when nothing is left', () => {
    const storage = memoryStorage()
    for (let i = 0; i < 3; i++) noteClientError(crash, storage)
    noteClientError({ ...crash, name: 'RangeError' }, storage)
    const sent = readOutbox(storage) // TypeError x3, RangeError x1
    noteClientError(crash, storage) // while the report was on its way: a fourth TypeError
    noteClientError({ ...crash, name: 'URIError' }, storage) // and a new entry
    removeSent(sent, storage)
    expect(readOutbox(storage)).toEqual([
      { ...crash, build: APP_BUILD, count: 1 },
      { ...crash, name: 'URIError', build: APP_BUILD, count: 1 },
    ])
  })

  it('removes the key altogether when the outbox is empty', () => {
    const storage = memoryStorage()
    noteClientError(crash, storage)
    removeSent(readOutbox(storage), storage)
    expect(storage.getItem(ERRORS_KEY)).toBeNull()
  })

  it('does not remove an entry that was not part of the report', () => {
    const storage = memoryStorage()
    noteClientError(crash, storage)
    removeSent([{ ...crash, name: 'RangeError', build: APP_BUILD, count: 1 }], storage)
    expect(readOutbox(storage)).toHaveLength(1)
  })
})

describe('nothing that a person typed is stored or sent', () => {
  it('a crash leaves its name and nothing of the message, the stack or the component stack', () => {
    const error = new TypeError(`Cannot read properties of ${SECRET}`)
    error.stack = `TypeError: ${SECRET}\n    at Secret (https://example.test/assets/index-abc.js:1:2)`
    setPlace('provider:home')
    reportCrash(error)
    consoleSpies[0].mockClear() // the one console line of a crash is logCrash's own and is tested in tests/crash.test.js
    const stored = window.localStorage.getItem(ERRORS_KEY)
    expect(JSON.parse(stored)).toEqual([{ kind: 'crash', place: 'provider:home', name: 'TypeError', build: APP_BUILD, count: 1 }])
    for (const value of [SECRET, 'Secret', 'index-abc', 'example.test', 'Cannot read']) expect(stored).not.toContain(value)
  })

  it('a crash with a thrown string or an error whose name is free text is "UnknownError"', () => {
    reportCrash(`a plain string holding ${SECRET}`)
    reportCrash(Object.assign(new Error('x'), { name: `name typed by ${SECRET}` }))
    reportCrash(null)
    consoleSpies[0].mockClear()
    expect(readOutbox()).toEqual([{ kind: 'crash', place: 'provider:app', name: 'UnknownError', build: APP_BUILD, count: 3 }])
    expect(window.localStorage.getItem(ERRORS_KEY)).not.toContain(SECRET)
  })

  it('an error that nothing caught leaves its name, not its message, its file or its line', () => {
    const storage = memoryStorage()
    const stop = watchUnhandledErrors({ storage })
    window.dispatchEvent(new ErrorEvent('error', {
      message: `Uncaught TypeError: ${SECRET}`, filename: `${window.location.origin}/assets/index-${SECRET.length}.js?user=${encodeURIComponent(SECRET)}`,
      lineno: 12, colno: 34, error: new TypeError(SECRET),
    }))
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError(SECRET) }))
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: SECRET }))
    stop()
    const stored = storage.getItem(ERRORS_KEY)
    expect(readOutbox(storage).map(({ kind, name, code }) => ({ kind, name, code }))).toEqual([
      { kind: 'unhandled', name: 'TypeError', code: undefined },
      { kind: 'unhandled', name: 'RangeError', code: undefined },
      { kind: 'unhandled', name: undefined, code: 'non_error' },
    ])
    for (const value of [SECRET, 'assets', 'index-', 'user=', '12', 'Uncaught']) expect(stored).not.toContain(value)
  })

  it('a report carries only the fields of the contract, whatever was noted', async () => {
    const t = rig({ notes: [] })
    noteClientError(/** @type {any} */ ({ ...crash, message: SECRET, stack: SECRET, url: SECRET }), t.storage)
    noteClientError({ kind: 'signed_out', place: 'provider:home', code: 'invalid_session' }, t.storage)
    // an outbox that somebody edited, or another version wrote, is checked again before it is sent
    t.storage.setItem(ERRORS_KEY, JSON.stringify([...JSON.parse(t.storage.getItem(ERRORS_KEY)), { ...crash, name: 'URIError', build: 'abc1234', message: SECRET, token: SECRET }]))
    await t.reporter.report()
    const body = t.send.mock.calls[0][0]
    expect(Object.keys(body)).toEqual(['events'])
    expect(body.events.map((e) => Object.keys(e).sort())).toEqual([
      ['build', 'count', 'kind', 'name', 'place'],
      ['build', 'code', 'count', 'kind', 'place'],
      ['build', 'count', 'kind', 'name', 'place'],
    ])
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })
})

describe('the screen', () => {
  it('is the one that the app set', () => {
    setPlace('provider:working')
    expect(currentPlace()).toBe('provider:working')
    setPlace('committee:history')
    expect(currentPlace()).toBe('committee:history')
  })

  it('is provider:app in the provider app and committee:app in the committee app when no screen was set', () => {
    expect(currentPlace()).toBe('provider:app')
    window.history.replaceState(null, '', '/scan?code=BQR-abc123')
    expect(currentPlace()).toBe('provider:app')
    window.history.replaceState(null, '', '/admin')
    expect(currentPlace()).toBe('committee:app')
  })

  it('is not read from the address: a screen that was set wins over the path and the hash', () => {
    window.history.replaceState(null, '', '/admin#history')
    setPlace('committee:points')
    expect(currentPlace()).toBe('committee:points')
  })

  it.each([['a key that is not on the list', 'provider:settings'], ['an address', '/scan?code=BQR-abc123'], ['nothing', null], ['something that is not text', 5]])(
    'falls back to the app\'s own key for %s, so a wrong key costs the precision and not the event',
    (_what, value) => {
      setPlace(/** @type {any} */ (value))
      expect(currentPlace()).toBe('provider:app')
    },
  )

  it('is on the event that is noted with it', () => {
    setPlace('committee:agent')
    noteClientError({ kind: 'unhandled', place: currentPlace(), name: 'Error' })
    expect(readOutbox()[0].place).toBe('committee:agent')
  })
})

describe('what nothing caught', () => {
  const errorEvent = (filename, error = new TypeError('x')) => new ErrorEvent('error', { message: 'x', filename, error, cancelable: true })
  const rejection = (reason) => Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason })
  let storage
  let target
  let stop
  beforeEach(() => {
    storage = memoryStorage()
    target = new EventTarget()
    stop = watchUnhandledErrors({ target, origin: 'https://app.example.test', storage })
  })
  afterEach(() => stop())

  it('notes an error from a file of our own origin, by the name of the error', () => {
    setPlace('provider:home')
    target.dispatchEvent(errorEvent('https://app.example.test/assets/index-abc.js', new RangeError('x')))
    expect(readOutbox(storage)).toEqual([{ kind: 'unhandled', place: 'provider:home', name: 'RangeError', build: APP_BUILD, count: 1 }])
  })

  it('notes "UnknownError" for an error with no error object, or a name that is not a name', () => {
    target.dispatchEvent(errorEvent('https://app.example.test/assets/a.js', /** @type {any} */ (null)))
    target.dispatchEvent(errorEvent('https://app.example.test/assets/a.js', Object.assign(new Error('x'), { name: 'a name typed by somebody' })))
    expect(readOutbox(storage)).toEqual([{ kind: 'unhandled', place: 'provider:app', name: 'UnknownError', build: APP_BUILD, count: 2 }])
  })

  it.each([
    ['Google\'s sign-in script (another origin)', 'https://accounts.google.com/gsi/client'],
    ['the empty file name of a cross-origin "Script error."', ''],
    ['a file name that the browser masked', 'webkit-masked-url://hidden/'],
    ['an origin that only starts like ours', 'https://app.example.test.evil.test/a.js'],
    ['the same host on another port', 'https://app.example.test:8443/a.js'],
    ['the same host on another scheme', 'http://app.example.test/a.js'],
    ['a text that is not an address', 'not an address'],
    ['no file name', undefined],
    ['a file name that is not text', 7],
  ])('ignores an error from %s', (_what, filename) => {
    target.dispatchEvent(errorEvent(/** @type {any} */ (filename)))
    expect(readOutbox(storage)).toEqual([])
    expect(storage.getItem(ERRORS_KEY)).toBeNull()
  })

  it('tells our own origin from another with isOwnOrigin', () => {
    expect(isOwnOrigin('https://app.example.test/assets/a.js', 'https://app.example.test')).toBe(true)
    expect(isOwnOrigin('blob:https://app.example.test/1234', 'https://app.example.test')).toBe(true)
    expect(isOwnOrigin('https://other.example.test/assets/a.js', 'https://app.example.test')).toBe(false)
    expect(isOwnOrigin('', 'https://app.example.test')).toBe(false)
    expect(isOwnOrigin(null, 'https://app.example.test')).toBe(false)
  })

  it('notes a rejection with an Error by the error\'s name, also an error of a class of our own', () => {
    class ApiError extends Error {}
    ApiError.prototype.name = 'ApiError'
    target.dispatchEvent(rejection(new TypeError('x')))
    target.dispatchEvent(rejection(new ApiError('x')))
    expect(readOutbox(storage).map((e) => [e.kind, e.name, e.code])).toEqual([['unhandled', 'TypeError', undefined], ['unhandled', 'ApiError', undefined]])
  })

  it.each([['a string', 'nope'], ['a number', 4], ['null', null], ['undefined', undefined], ['an object', { message: SECRET }], ['an object that looks like an error', { name: 'TypeError', message: SECRET }]])(
    'notes a rejection with %s by the code non_error, and no name',
    (_what, reason) => {
      target.dispatchEvent(rejection(reason))
      expect(readOutbox(storage)).toEqual([{ kind: 'unhandled', place: 'provider:app', code: 'non_error', build: APP_BUILD, count: 1 }])
      expect(storage.getItem(ERRORS_KEY)).not.toContain(SECRET)
    },
  )

  it('aggregates the same error into one entry with a count', () => {
    for (let i = 0; i < 4; i++) target.dispatchEvent(rejection('again'))
    expect(readOutbox(storage)).toHaveLength(1)
    expect(readOutbox(storage)[0].count).toBe(4)
  })

  it('does not hide anything from the browser: the event is not cancelled', () => {
    const first = errorEvent('https://app.example.test/a.js')
    const second = rejection(new Error('x'))
    target.dispatchEvent(first)
    target.dispatchEvent(second)
    expect(first.defaultPrevented).toBe(false)
    expect(second.defaultPrevented).toBe(false)
  })

  it('never throws, whatever the event holds', () => {
    const hostile = (type, ...fields) => {
      const event = new Event(type)
      for (const field of fields) Object.defineProperty(event, field, { get() { throw new Error('no') } })
      return event
    }
    expect(() => {
      target.dispatchEvent(hostile('error', 'filename', 'error'))
      target.dispatchEvent(hostile('unhandledrejection', 'reason'))
    }).not.toThrow()
    expect(readOutbox(storage)).toEqual([])
  })

  it('stops noting when it is stopped', () => {
    stop()
    target.dispatchEvent(errorEvent('https://app.example.test/a.js'))
    target.dispatchEvent(rejection('x'))
    expect(readOutbox(storage)).toEqual([])
  })

  it('listens on window with our own origin when it is not told otherwise', () => {
    const own = watchUnhandledErrors()
    window.dispatchEvent(new ErrorEvent('error', { filename: `${window.location.origin}/assets/a.js`, error: new TypeError('x') }))
    window.dispatchEvent(new ErrorEvent('error', { filename: 'https://accounts.google.com/gsi/client', error: new TypeError('x') }))
    own()
    expect(readOutbox().map((e) => e.name)).toEqual(['TypeError'])
  })
})

// ---- the reporter ----------------------------------------------------------------------------------------------------

/**
 * One reporter with its own storage, clock and sender. `notes` are noted first. `answer(body, session)` is what the server says.
 * @param {object} [options]
 */
function rig({
  app = 'provider', session = 'qrp_a', online = true, answer = async () => ({ ok: true, recorded: 1 }), notes = [crash],
} = {}) {
  const storage = memoryStorage()
  const state = { clock: START, session, online }
  for (const note of notes) noteClientError(note, storage)
  const send = vi.fn(async (body, who) => answer(body, who))
  const unauthorized = vi.fn()
  const reporter = createErrorReporter({
    app, getSession: () => state.session, send, onUnauthorized: unauthorized, storage, now: () => state.clock, isOnline: () => state.online,
  })
  return { storage, send, unauthorized, reporter, state, wait: (ms) => { state.clock += ms } }
}

describe('the reporter: what it sends and how', () => {
  it('sends the outbox with the session, in a body of events and nothing else', async () => {
    const t = rig({ notes: [crash, { kind: 'signed_out', place: 'provider:working', code: 'invalid_session' }] })
    expect(await t.reporter.report()).toBe('sent')
    expect(t.send).toHaveBeenCalledTimes(1)
    const [body, session] = t.send.mock.calls[0]
    expect(session).toBe('qrp_a')
    expect(body).toEqual({
      events: [
        { kind: 'crash', place: 'provider:home', name: 'TypeError', build: APP_BUILD, count: 1 },
        { kind: 'signed_out', place: 'provider:working', code: 'invalid_session', build: APP_BUILD, count: 1 },
      ],
    })
  })

  it('sends the count of an aggregated event', async () => {
    const t = rig({ notes: [crash, crash, crash] })
    await t.reporter.report()
    expect(t.send.mock.calls[0][0].events).toEqual([{ ...crash, build: APP_BUILD, count: 3 }])
  })

  it('sends only the entries of its own app: the outbox is shared by the two apps, and a role\'s endpoint takes only its own', async () => {
    const committee = { kind: 'crash', place: 'committee:history', name: 'Error' }
    const provider = rig({ notes: [crash, committee] })
    await provider.reporter.report()
    expect(provider.send.mock.calls[0][0].events.map((e) => e.place)).toEqual(['provider:home'])
    expect(readOutbox(provider.storage).map((e) => e.place)).toEqual(['committee:history']) // the other app's entry waits for its own sign-in

    const admin = rig({ app: 'committee', session: true, notes: [crash, committee] })
    await admin.reporter.report()
    expect(admin.send.mock.calls[0][0].events.map((e) => e.place)).toEqual(['committee:history'])
    expect(readOutbox(admin.storage).map((e) => e.place)).toEqual(['provider:home'])
  })

  it('has nothing to send for an app whose entries are not there, and makes no request', async () => {
    const t = rig({ notes: [{ kind: 'crash', place: 'committee:points', name: 'Error' }] })
    expect(await t.reporter.report()).toBe('empty')
    expect(t.send).not.toHaveBeenCalled()
  })

  it('sends no more than MAX_CLIENT_ERROR_EVENTS entries in one request (the outbox holds no more)', async () => {
    const t = rig({ notes: [] })
    for (let i = 0; i < MAX_CLIENT_ERROR_EVENTS + 10; i++) noteClientError({ ...crash, name: `Error${i}` }, t.storage)
    await t.reporter.report()
    expect(t.send.mock.calls[0][0].events).toHaveLength(MAX_CLIENT_ERROR_EVENTS)
  })

  it('a 200 removes what was sent and not what was noted while the report was on its way', async () => {
    let t
    t = rig({
      notes: [crash, crash],
      answer: async () => {
        noteClientError(crash, t.storage) // a third crash, while the request is out
        noteClientError({ ...crash, name: 'RangeError' }, t.storage) // and a new kind
        return { ok: true, recorded: 1 }
      },
    })
    expect(await t.reporter.report()).toBe('sent')
    expect(readOutbox(t.storage)).toEqual([
      { ...crash, build: APP_BUILD, count: 1 },
      { ...crash, name: 'RangeError', build: APP_BUILD, count: 1 },
    ])
  })

  it('a 200 for everything leaves no outbox at all', async () => {
    const t = rig()
    await t.reporter.report()
    expect(t.storage.getItem(ERRORS_KEY)).toBeNull()
  })

  it('does not trust an answer that is not the server\'s "ok", and keeps the entries', async () => {
    const t = rig({ answer: async () => ({}) })
    expect(await t.reporter.report()).toBe('failed')
    expect(readOutbox(t.storage)).toHaveLength(1)
  })

  it('does not send for nobody, and leaves the outbox alone', async () => {
    const t = rig({ session: null })
    expect(await t.reporter.report()).toBe('skipped')
    expect(t.send).not.toHaveBeenCalled()
    expect(readOutbox(t.storage)).toHaveLength(1)
    t.state.session = 'qrp_a' // somebody signs in: the wait is over, with no minute to wait for what was never sent
    expect(await t.reporter.report()).toBe('sent')
  })

  it('reads who is signed in each time, so a report is sent with the session of now', async () => {
    const t = rig({ session: 'qrp_first' })
    t.state.session = 'qrp_second'
    await t.reporter.report()
    expect(t.send.mock.calls[0][1]).toBe('qrp_second')
  })

  it('sends nothing while the device says it is offline, and sends when it is back (the offline call is not an attempt)', async () => {
    const t = rig({ online: false })
    expect(await t.reporter.report()).toBe('offline')
    expect(t.send).not.toHaveBeenCalled()
    expect(readOutbox(t.storage)).toHaveLength(1)
    t.state.online = true
    expect(await t.reporter.report()).toBe('sent')
  })

  it('does not send two at once', async () => {
    let release
    const t = rig({ answer: () => new Promise((resolve) => { release = () => resolve({ ok: true, recorded: 1 }) }) })
    const first = t.reporter.report()
    expect(await t.reporter.report()).toBe('skipped')
    release()
    expect(await first).toBe('sent')
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('asks the browser whether it is online when it is not told (navigator.onLine)', async () => {
    const storage = memoryStorage()
    noteClientError(crash, storage)
    const send = vi.fn(async () => ({ ok: true, recorded: 1 }))
    const reporter = createErrorReporter({ app: 'provider', getSession: () => 'qrp_a', send, onUnauthorized: vi.fn(), storage })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(await reporter.report()).toBe('offline')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    expect(await reporter.report()).toBe('sent')
  })
})

describe('the reporter: at most once a minute', () => {
  it('a report that comes inside the minute after the last one is not sent, and one that comes after it is', async () => {
    const t = rig()
    expect(await t.reporter.report()).toBe('sent')
    noteClientError({ ...crash, name: 'RangeError' }, t.storage)
    t.wait(MINUTE - 1)
    expect(await t.reporter.report()).toBe('throttled')
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(readOutbox(t.storage)).toHaveLength(1) // kept, not lost
    t.wait(1)
    expect(await t.reporter.report()).toBe('sent')
    expect(t.send.mock.calls[1][0].events.map((e) => e.name)).toEqual(['RangeError'])
  })

  it('a failed attempt counts too: a server that is down is not asked at every visibility change', async () => {
    const t = rig({ answer: async () => { throw new ApiError(503, 'unavailable') } })
    expect(await t.reporter.report()).toBe('failed')
    t.wait(MINUTE - 1)
    expect(await t.reporter.report()).toBe('throttled')
    t.wait(1)
    expect(await t.reporter.report()).toBe('failed')
    expect(t.send).toHaveBeenCalledTimes(2)
  })

  it('a call with nothing to send is not an attempt: a note that comes right after is sent at once', async () => {
    const t = rig({ notes: [] })
    expect(await t.reporter.report()).toBe('empty')
    noteClientError(crash, t.storage)
    expect(await t.reporter.report()).toBe('sent')
  })

  it('keeps no timer: nothing is sent that nobody asked for', async () => {
    vi.useFakeTimers()
    try {
      const t = rig()
      await t.reporter.report()
      noteClientError({ ...crash, name: 'RangeError' }, t.storage)
      await t.reporter.report()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a clock that was set back is not a reason to stay quiet', async () => {
    const t = rig()
    await t.reporter.report()
    noteClientError({ ...crash, name: 'RangeError' }, t.storage)
    t.wait(-3600 * 1000)
    expect(await t.reporter.report()).toBe('sent')
  })

  it('a new reporter (the app started again, or "Try again" on the crash screen) is not held back by the last one', async () => {
    const t = rig()
    await t.reporter.report()
    noteClientError(crash, t.storage)
    const next = createErrorReporter({ app: 'provider', getSession: () => 'qrp_a', send: t.send, onUnauthorized: t.unauthorized, storage: t.storage, now: () => t.state.clock })
    expect(await next.report()).toBe('sent')
  })
})

describe('the reporter: what the server answers', () => {
  it('a 404 (a server from before the endpoint) stops it for the rest of the run, and keeps the entries', async () => {
    const t = rig({ answer: async () => { throw new ApiError(404, 'not_found') } })
    expect(await t.reporter.report()).toBe('stopped')
    expect(readOutbox(t.storage)).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      noteClientError({ ...crash, name: `Error${i}` }, t.storage)
      t.wait(MINUTE)
      expect(await t.reporter.report()).toBe('stopped')
    }
    expect(t.send).toHaveBeenCalledTimes(1) // nothing more in this run
    expect(t.unauthorized).not.toHaveBeenCalled()
    expect(readOutbox(t.storage)).toHaveLength(4)
  })

  it('a new reporter (the app starts again) tries again after a 404', async () => {
    const down = rig({ answer: async () => { throw new ApiError(404, 'not_found') } })
    await down.reporter.report()
    const next = createErrorReporter({ app: 'provider', getSession: () => 'qrp_a', send: vi.fn(async () => ({ ok: true, recorded: 1 })), onUnauthorized: vi.fn(), storage: down.storage })
    expect(await next.report()).toBe('sent')
  })

  it('a 401 goes to the app\'s own handling with the session and the code that the server answered, and keeps the entries', async () => {
    const t = rig({ answer: async () => { throw new ApiError(401, 'invalid_session') } })
    expect(await t.reporter.report()).toBe('unauthorized')
    expect(t.unauthorized).toHaveBeenCalledTimes(1)
    expect(t.unauthorized).toHaveBeenCalledWith('qrp_a', 'invalid_session')
    expect(readOutbox(t.storage)).toHaveLength(1)
  })

  it('a 401 that has no code is handed over with an empty one', async () => {
    const t = rig({ answer: async () => { throw Object.assign(new Error('refused'), { status: 401 }) } })
    expect(await t.reporter.report()).toBe('unauthorized')
    expect(t.unauthorized).toHaveBeenCalledWith('qrp_a', '')
  })

  it('a report never rejects, even when the app\'s own handling of a 401 throws', async () => {
    const t = rig({ answer: async () => { throw new ApiError(401, 'invalid_session') } })
    t.unauthorized.mockImplementation(() => { throw new Error('the sign-out failed') })
    await expect(t.reporter.report()).resolves.toBe('unauthorized')
  })

  it.each([
    ['no signal', new ApiError(0, 'network')],
    ['a timeout', new ApiError(0, 'timeout')],
    ['an answer that is not ours', new ApiError(0, 'bad_response')],
    ['a server that is down', new ApiError(503, 'unavailable')],
    ['a server that fails', new ApiError(500, 'server_error')],
    ['a refusal that is not a 401 or a 404', new ApiError(429, 'too_many_attempts')],
    ['something that is not an ApiError at all', new TypeError('boom')],
    ['a sender that throws at once', Object.assign(new Error('x'), { status: undefined })],
  ])('%s is a failed attempt: nothing is thrown, nothing is signed out, the entries stay and go with the next report', async (_what, error) => {
    const t = rig({ answer: async () => { throw error } })
    expect(await t.reporter.report()).toBe('failed')
    expect(t.unauthorized).not.toHaveBeenCalled()
    expect(readOutbox(t.storage)).toHaveLength(1)
    t.wait(MINUTE)
    expect(await t.reporter.report()).toBe('failed')
    expect(t.send.mock.calls[1][0]).toEqual(t.send.mock.calls[0][0]) // the same events again
  })

  it('goes through after a failure once the server answers', async () => {
    let down = true
    const t = rig({ answer: async () => { if (down) throw new ApiError(503, 'unavailable'); return { ok: true, recorded: 1 } } })
    await t.reporter.report()
    down = false
    t.wait(MINUTE)
    expect(await t.reporter.report()).toBe('sent')
    expect(t.storage.getItem(ERRORS_KEY)).toBeNull()
  })
})
