// The server's ping to its check on healthchecks.io (server/heartbeat.js, docs/adr/0007). The address is a secret, so this file
// proves, with fake addresses and a fetcher that it injects (nothing here reaches the network, and there is no database):
//   - nothing at all is sent without HEALTH_HEARTBEAT_URL, or with an address that is not safe to use (not https, a user name
//     or a password in it, not an address);
//   - /fail and /log are joined to the address correctly, also with a trailing slash or a query string;
//   - the request is a POST of plain text with redirect: 'error', and a body longer than 8 kB is cut (bytes, not characters);
//   - a fetch that throws, times out or answers with anything but 2xx gives { sent: false } and a fixed word, never throws, and
//     nothing is logged on any console method, so the address (or a part of it, or the message of the error) is never in a log;
//   - the variable is read at every call, and the default fetcher is the global fetch of the moment.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sendHeartbeat, isHeartbeatConfigured, cutToBytes } from '../server/heartbeat.js'
import { HEARTBEAT_BODY_MAX_BYTES } from '../server/config.js'

// Fake on purpose: the host ends in .test, and the "uuid" is made up. A real address is a secret and never goes in a file.
const HOST = 'hc.example.test'
const KEY = '00000000-0000-4000-8000-0000000000aa'
const ADDRESS = `https://${HOST}/ping/${KEY}`

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace']

let saved
let consoles
let reachedForTheNetwork
beforeEach(() => {
  saved = process.env.HEALTH_HEARTBEAT_URL
  process.env.HEALTH_HEARTBEAT_URL = ADDRESS
  // A safety net: the real fetch is never used. A test that wants a fetch passes a fetcher or stubs the global one itself.
  reachedForTheNetwork = []
  vi.stubGlobal('fetch', (url) => {
    reachedForTheNetwork.push(String(url))
    return Promise.reject(new Error('no network in tests'))
  })
  consoles = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
  for (const spy of consoles) spy.mockClear() // since Vitest 4 a method that is already spied returns the same spy
})
afterEach(() => {
  expect(reachedForTheNetwork, 'a test reached for the real fetch').toEqual([])
  if (saved === undefined) delete process.env.HEALTH_HEARTBEAT_URL
  else process.env.HEALTH_HEARTBEAT_URL = saved
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Everything that was written to any console method since the test began, as text. */
const everythingLogged = () => JSON.stringify(consoles.map((spy) => spy.mock.calls))
const nothingLogged = () => expect(consoles.flatMap((spy) => spy.mock.calls)).toEqual([])

/** A fetcher that records its calls and answers with `status`, with a body that can be cancelled. */
function fetcherAnswering(status = 200) {
  const cancel = vi.fn(async () => {})
  const fetcher = vi.fn(async () => ({ status, body: { cancel } }))
  return { fetcher, cancel }
}

describe('without a usable address nothing is sent', () => {
  it('sends nothing when HEALTH_HEARTBEAT_URL is not set, empty or only spaces, and says not_configured', async () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.HEALTH_HEARTBEAT_URL
      else process.env.HEALTH_HEARTBEAT_URL = value
      const { fetcher } = fetcherAnswering()
      expect(await sendHeartbeat({ signal: 'fail', body: 'x', fetcher }), JSON.stringify(value)).toEqual({ sent: false, reason: 'not_configured' })
      expect(fetcher, JSON.stringify(value)).not.toHaveBeenCalled()
      expect(isHeartbeatConfigured(), JSON.stringify(value)).toBe(false)
    }
    nothingLogged()
  })

  it('sends nothing to an address that is not https, has a user name or a password, or is not an address', async () => {
    for (const value of [
      `http://${HOST}/ping/${KEY}`,
      `ftp://${HOST}/ping/${KEY}`,
      `file:///ping/${KEY}`,
      `javascript:alert(1)`,
      `https://user@${HOST}/ping/${KEY}`,
      `https://user:pass@${HOST}/ping/${KEY}`,
      `https://:pass@${HOST}/ping/${KEY}`,
      `${HOST}/ping/${KEY}`,
      'not an address',
      '//hc.example.test/ping',
    ]) {
      process.env.HEALTH_HEARTBEAT_URL = value
      const { fetcher } = fetcherAnswering()
      expect(await sendHeartbeat({ signal: 'fail', body: 'x', fetcher }), value).toEqual({ sent: false, reason: 'invalid_url' })
      expect(fetcher, value).not.toHaveBeenCalled()
      expect(isHeartbeatConfigured(), value).toBe(false)
    }
    nothingLogged()
  })

  it('is configured only by an https address without a user name or a password', () => {
    expect(isHeartbeatConfigured()).toBe(true)
    process.env.HEALTH_HEARTBEAT_URL = `  ${ADDRESS}  ` // the spaces around it are not part of it
    expect(isHeartbeatConfigured()).toBe(true)
  })

  it('refuses a signal that is not ok, fail or log, before it looks at the address', async () => {
    for (const signal of ['FAIL', 'start', 'constructor', '__proto__', 'toString', '', null, 5, {}]) {
      const { fetcher } = fetcherAnswering()
      expect(await sendHeartbeat({ signal, fetcher }), String(signal)).toEqual({ sent: false, reason: 'bad_signal' })
      expect(fetcher, String(signal)).not.toHaveBeenCalled()
    }
  })

  it('reads the variable at every call, not once', async () => {
    const { fetcher } = fetcherAnswering()
    delete process.env.HEALTH_HEARTBEAT_URL
    expect((await sendHeartbeat({ signal: 'fail', fetcher })).sent).toBe(false)
    process.env.HEALTH_HEARTBEAT_URL = ADDRESS
    expect((await sendHeartbeat({ signal: 'fail', fetcher })).sent).toBe(true)
    process.env.HEALTH_HEARTBEAT_URL = `https://other.example.test/ping/${KEY}`
    expect((await sendHeartbeat({ signal: 'fail', fetcher })).sent).toBe(true)
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([`${ADDRESS}/fail`, `https://other.example.test/ping/${KEY}/fail`])
  })
})

describe('the address of each signal', () => {
  const urlsFor = async (address, signal) => {
    process.env.HEALTH_HEARTBEAT_URL = address
    const { fetcher } = fetcherAnswering()
    await sendHeartbeat({ signal, fetcher })
    return fetcher.mock.calls.map((c) => c[0])
  }

  it('ok is the address, fail adds /fail and log adds /log', async () => {
    expect(await urlsFor(ADDRESS, 'ok')).toEqual([ADDRESS])
    expect(await urlsFor(ADDRESS, 'fail')).toEqual([`${ADDRESS}/fail`])
    expect(await urlsFor(ADDRESS, 'log')).toEqual([`${ADDRESS}/log`])
  })

  it('is ok when no signal is given', async () => {
    process.env.HEALTH_HEARTBEAT_URL = ADDRESS
    const { fetcher } = fetcherAnswering()
    await sendHeartbeat({ fetcher })
    expect(fetcher.mock.calls[0][0]).toBe(ADDRESS)
  })

  it('joins the ending correctly after a trailing slash, or several', async () => {
    expect(await urlsFor(`${ADDRESS}/`, 'fail')).toEqual([`${ADDRESS}/fail`])
    expect(await urlsFor(`${ADDRESS}///`, 'log')).toEqual([`${ADDRESS}/log`])
    expect(await urlsFor(`${ADDRESS}/`, 'ok')).toEqual([ADDRESS])
  })

  it('works for an address that is only a host, and for the two-part form of a ping key and a slug', async () => {
    expect(await urlsFor(`https://${HOST}`, 'fail')).toEqual([`https://${HOST}/fail`])
    expect(await urlsFor(`https://${HOST}/`, 'log')).toEqual([`https://${HOST}/log`])
    expect(await urlsFor(`https://${HOST}/some-ping-key/backup-slug`, 'fail')).toEqual([`https://${HOST}/some-ping-key/backup-slug/fail`])
  })

  it('puts the ending on the path, before a query string that the address has', async () => {
    expect(await urlsFor(`${ADDRESS}?create=1`, 'fail')).toEqual([`${ADDRESS}/fail?create=1`])
    expect(await urlsFor(`${ADDRESS}/?create=1`, 'log')).toEqual([`${ADDRESS}/log?create=1`])
  })
})

describe('the request', () => {
  it('is one POST of plain text with redirect: error, an abort signal, and the body that was given', async () => {
    const { fetcher } = fetcherAnswering()
    const result = await sendHeartbeat({ signal: 'fail', body: 'First server error today, 05/10/2026 14:03: POST /scans/sync 57014', fetcher })
    expect(result).toEqual({ sent: true })
    expect(fetcher).toHaveBeenCalledTimes(1) // one try: no retry on the path of a request
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe(`${ADDRESS}/fail`)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain; charset=utf-8' })
    expect(init.body).toBe('First server error today, 05/10/2026 14:03: POST /scans/sync 57014')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(Object.keys(init).sort()).toEqual(['body', 'headers', 'method', 'redirect', 'signal'])
  })

  it('sends no body at all when there is none', async () => {
    for (const body of [undefined, '', null]) {
      const { fetcher } = fetcherAnswering()
      await sendHeartbeat({ signal: 'ok', body, fetcher })
      expect('body' in fetcher.mock.calls[0][1], String(body)).toBe(false)
    }
  })

  it('lets go of the answer without reading it, and a body that cannot be cancelled changes nothing', async () => {
    const { fetcher, cancel } = fetcherAnswering(200)
    expect(await sendHeartbeat({ signal: 'ok', fetcher })).toEqual({ sent: true })
    expect(cancel).toHaveBeenCalledTimes(1)
    for (const response of [
      { status: 200 }, // no body
      { status: 200, body: { cancel: () => undefined } }, // a cancel that gives no promise
      { status: 200, body: { cancel: () => Promise.reject(new Error(`cannot cancel ${ADDRESS}`)) } },
      { status: 200, body: { cancel: () => { throw new Error(`cannot cancel ${ADDRESS}`) } } },
    ]) {
      expect(await sendHeartbeat({ signal: 'ok', fetcher: async () => response })).toEqual({ sent: true })
    }
    nothingLogged()
  })

  it('uses the fetch of the moment when no fetcher is given', async () => {
    const { fetcher } = fetcherAnswering()
    vi.stubGlobal('fetch', fetcher)
    expect(await sendHeartbeat({ signal: 'fail', body: 'x' })).toEqual({ sent: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(`${ADDRESS}/fail`)
  })
})

describe('the body is cut to 8 kB', () => {
  it('keeps a body that fits, and cuts one that does not, by bytes', async () => {
    expect(HEARTBEAT_BODY_MAX_BYTES).toBe(8 * 1024)
    const fits = 'a'.repeat(HEARTBEAT_BODY_MAX_BYTES)
    const long = 'a'.repeat(HEARTBEAT_BODY_MAX_BYTES + 5000)
    const { fetcher } = fetcherAnswering()
    await sendHeartbeat({ signal: 'log', body: fits, fetcher })
    await sendHeartbeat({ signal: 'log', body: long, fetcher })
    expect(fetcher.mock.calls[0][1].body).toBe(fits)
    expect(fetcher.mock.calls[1][1].body).toBe(fits)
    expect(new TextEncoder().encode(fetcher.mock.calls[1][1].body)).toHaveLength(8192)
  })

  it('never cuts a character in half and never goes over the limit', () => {
    expect(cutToBytes('abc', 8)).toBe('abc')
    expect(cutToBytes('abcdef', 4)).toBe('abcd')
    // Three bytes each: 8 bytes holds two whole characters, and the half of the third is dropped.
    const euros = cutToBytes('\u{20ac}'.repeat(10), 8)
    expect(euros).toBe('\u{20ac}\u{20ac}')
    expect(new TextEncoder().encode(euros).length).toBeLessThanOrEqual(8)
    // Two bytes each, and four bytes each (a letter outside the plane that most text uses).
    expect(cutToBytes('\u{e9}'.repeat(10), 5)).toBe('\u{e9}\u{e9}')
    expect(cutToBytes('\u{1F600}'.repeat(10), 7)).toBe('\u{1F600}')
    // Nothing is left of a text whose first character does not fit.
    expect(cutToBytes('\u{1F600}', 3)).toBe('')
    for (let max = 0; max < 20; max++) {
      expect(new TextEncoder().encode(cutToBytes('a\u{e9}\u{20ac}\u{1F600}'.repeat(6), max)).length).toBeLessThanOrEqual(max)
    }
  })

  it('cuts a long multi-byte body inside sendHeartbeat too', async () => {
    const { fetcher } = fetcherAnswering()
    await sendHeartbeat({ signal: 'log', body: '\u{20ac}'.repeat(5000), fetcher })
    const sent = fetcher.mock.calls[0][1].body
    expect(new TextEncoder().encode(sent).length).toBeLessThanOrEqual(HEARTBEAT_BODY_MAX_BYTES)
    expect(new TextEncoder().encode(sent).length).toBeGreaterThan(HEARTBEAT_BODY_MAX_BYTES - 3)
    expect(sent).toBe('\u{20ac}'.repeat(sent.length))
  })

  it('sends the text of a value that is not a string, and nothing for null', async () => {
    const { fetcher } = fetcherAnswering()
    await sendHeartbeat({ signal: 'log', body: 42, fetcher })
    expect(fetcher.mock.calls[0][1].body).toBe('42')
  })
})

describe('when the ping does not work', () => {
  it('returns { sent: false } and a fixed word for a fetch that throws, and never says the address or the message', async () => {
    const leaky = new Error(`getaddrinfo ENOTFOUND ${HOST} while sending to ${ADDRESS}/fail`)
    const attempts = [
      async () => {
        throw leaky
      },
      () => {
        throw leaky // before it returns a promise
      },
      () => Promise.reject(leaky),
      () => Promise.reject(`${ADDRESS}`), // not an Error
      () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: leaky })), // a refused redirect looks like this
      async () => undefined, // an answer that is not an answer
      async () => null,
    ]
    for (const [i, fetcher] of attempts.entries()) {
      const result = await sendHeartbeat({ signal: 'fail', body: 'x', fetcher })
      expect(result, `attempt ${i}`).toEqual({ sent: false, reason: 'failed' })
      const text = JSON.stringify(result)
      for (const part of [HOST, KEY, ADDRESS, 'getaddrinfo', 'ENOTFOUND', 'ping']) expect(text, part).not.toContain(part)
    }
    nothingLogged()
  })

  it('returns { sent: false, reason: rejected } for every answer that is not 2xx', async () => {
    for (const status of [100, 301, 302, 400, 401, 404, 410, 429, 500, 502, 503]) {
      const { fetcher } = fetcherAnswering(status)
      expect(await sendHeartbeat({ signal: 'fail', body: 'x', fetcher }), String(status)).toEqual({ sent: false, reason: 'rejected' })
      expect(fetcher, String(status)).toHaveBeenCalledTimes(1) // not tried again, not even a 5xx
    }
    for (const status of [200, 201, 202, 204, 299]) {
      expect(await sendHeartbeat({ signal: 'fail', body: 'x', fetcher: fetcherAnswering(status).fetcher }), String(status)).toEqual({ sent: true })
    }
    nothingLogged()
  })

  it('gives up after the timeout, also when the fetcher never answers and ignores its signal', async () => {
    let seen
    const hangs = vi.fn((url, init) => {
      seen = init.signal
      return new Promise(() => {})
    })
    const started = Date.now()
    const result = await sendHeartbeat({ signal: 'fail', body: 'x', fetcher: hangs, timeoutMs: 80 })
    const took = Date.now() - started
    expect(result).toEqual({ sent: false, reason: 'timeout' })
    expect(took).toBeGreaterThanOrEqual(70)
    expect(took).toBeLessThan(1000)
    expect(seen.aborted).toBe(true) // a fetch that does honour the signal lets go of the connection
    nothingLogged()
  })

  it('is a timeout, and not a failure, for a fetch that rejects when it is aborted', async () => {
    const honours = (url, init) =>
      new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    expect(await sendHeartbeat({ signal: 'fail', fetcher: honours, timeoutMs: 60 })).toEqual({ sent: false, reason: 'timeout' })
    nothingLogged()
  })

  it('does not leave an unhandled rejection behind when a fetch fails after the timeout', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const late = () => new Promise((resolve, reject) => setTimeout(() => reject(new Error(`late failure ${ADDRESS}`)), 120))
      expect(await sendHeartbeat({ signal: 'fail', fetcher: late, timeoutMs: 30 })).toEqual({ sent: false, reason: 'timeout' })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    nothingLogged()
  })

  it('never throws, whatever it is given, and logs nothing on any console method', async () => {
    vi.stubGlobal('fetch', fetcherAnswering().fetcher)
    for (const options of [undefined, null, {}, 5, 'x', [], { fetcher: 5 }, { signal: 'fail', fetcher: 'nope' }, { timeoutMs: 'soon' }]) {
      const result = await sendHeartbeat(options)
      expect(typeof result.sent, JSON.stringify(options)).toBe('boolean')
    }
    nothingLogged()
    expect(everythingLogged()).not.toContain(HOST)
  })
})
