// The values that the phone (src/) and the server (server/) must agree on are written once, in shared/contract.js (and the
// QR reader in shared/qrToken.js). This file keeps them honest:
//   1. the offline sync contract: the phone's chunk fits under the server's limit, every code that the server can attach
//      to one sync item is classified by the phone, and both facts are checked against the real code and a real call;
//   2. the GPS limits and the vocabularies, tied to the behaviour of both sides and to the check constraints of the table;
//   3. every number and list is PINNED, with the reason it matters: an installed phone keeps its own copy of the
//      JavaScript for days or weeks, and the offline queue on a phone can hold check-ins that an old version wrote
//      (AGENTS.md, "Database and API changes"), so a changed value is a decision about those phones, never a detail;
//   4. src/ and server/ hold no copy of what moved (a static scan, like the flag-literal check of agent-docs.test.js);
//   5. the client bundle holds no server-only code (it is built here and read).
// When a test here fails because you changed a value on purpose, update the pinned number in the same pull request and say
// in its description why the old phones are safe.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, assert } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { setupDb, call, seedAdmin, adminCookie } from './helpers.js'
import * as contract from '../shared/contract.js'
import { parseQrToken } from '../shared/qrToken.js'
import * as config from '../server/config.js'
import { parseQrToken as parseQrTokenFromServer, evaluateGps } from '../server/scanLogic.js'
import { createQueue, flushQueue } from '../src/worker/scanQueue.js'
import { getFix } from '../src/worker/geo.js'
import { KNOWN_ERROR_CODES } from '../src/worker/errors.js'

const {
  MAX_SYNC_BATCH, SYNC_CHUNK_SIZE, SYNC_QUEUE_MAX_ITEMS,
  SYNC_PERMANENT_ERROR_CODES, SYNC_RETRYABLE_ERROR_CODES, SYNC_ITEM_ERROR_CODES,
  GPS_MAX_USABLE_ACCURACY_M, GPS_MAX_STALE_AGE_S,
} = contract

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const abs = (relative) => path.join(ROOT, relative)
const read = (relative) => fs.readFileSync(abs(relative), 'utf8').replace(/\r\n/g, '\n')

/** Fails with every problem on its own line. An empty list passes. */
function report(problems) {
  const unique = [...new Set(problems)]
  if (unique.length) assert.fail(`\n${unique.map((p) => `  - ${p}`).join('\n')}\n`)
}

const SCAN_ERRORS = Object.fromEntries(Object.entries(contract).filter(([name]) => name.startsWith('SCAN_ERROR_')))

// ---------- reading the code ----------

// One pass over a file that tells a comment from a string from code: whichever starts first wins, so a quote inside a
// comment or a `//` inside a string starts nothing. (A regular expression literal that holds a quote can confuse it; the
// scans below only look for words, so the worst that happens is a miss on that line.)
const TOKEN_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g

/** Every .js, .jsx and .mjs file under the given folders: [{ file, text }]. */
function codeFiles(...dirs) {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(abs(dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(js|jsx|mjs)$/.test(entry.name)) files.push({ file: rel, text: read(rel) })
    }
  }
  dirs.forEach(walk)
  return files
}

/** The string literals of a file, with their line (comments are skipped). */
function stringLiterals(text) {
  const found = []
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[0].startsWith('//') || m[0].startsWith('/*')) continue
    found.push({ value: m[0].slice(1, -1), line: text.slice(0, m.index).split('\n').length })
  }
  return found
}

/** The text with its comments blanked (the line numbers stay). */
const withoutComments = (text) => text.replace(TOKEN_RE, (t) => (t.startsWith('//') ? ' ' : t.startsWith('/*') ? t.replace(/[^\n]/g, ' ') : t))

// ======================================================================================================================
// 1. The offline sync contract
// ======================================================================================================================

const memoryStorage = () => {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }
}
const queued = (id) => ({ id, code: 'BQR-abc123', client_time: '2026-09-30T05:00:00Z', gps: null, provider_id: 'prov-1' })

describe('the offline sync contract: the phone and the server', () => {
  it("the phone's chunk is not larger than the server's batch limit", () => {
    expect(
      SYNC_CHUNK_SIZE,
      `The phone uploads ${SYNC_CHUNK_SIZE} check-ins per request but the server takes ${MAX_SYNC_BATCH}: a batch above the limit is refused whole (batch_too_large), so the queue of the phone would never empty.`,
    ).toBeLessThanOrEqual(MAX_SYNC_BATCH)
    expect(Number.isInteger(SYNC_CHUNK_SIZE) && SYNC_CHUNK_SIZE >= 1, 'the chunk is a whole number of 1 or more').toBe(true)
  })

  it('the queue cap is a positive whole number of chunks (the phone uploads the queue in rounds of one chunk)', () => {
    expect(Number.isInteger(SYNC_QUEUE_MAX_ITEMS) && SYNC_QUEUE_MAX_ITEMS > 0).toBe(true)
    expect(SYNC_QUEUE_MAX_ITEMS % SYNC_CHUNK_SIZE, 'the queue cap is a multiple of the chunk').toBe(0)
  })

  it("the phone really sends chunks of SYNC_CHUNK_SIZE, never more than the server's limit (the real flushQueue)", async () => {
    const queue = createQueue(memoryStorage())
    for (let i = 0; i < SYNC_CHUNK_SIZE * 3 + 1; i++) queue.add(queued('i' + i))
    const sizes = []
    const api = async (_path, { body }) => {
      sizes.push(body.scans.length)
      return { results: body.scans.map((s) => ({ id: s.id, ok: true, scan: { outcome: contract.OUTCOME_ACCEPTED } })) }
    }
    const done = await flushQueue({ queue, api, token: 't', providerId: 'prov-1' })
    expect(done.remaining).toBe(0)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_SYNC_BATCH)
    expect(sizes).toEqual([SYNC_CHUNK_SIZE, SYNC_CHUNK_SIZE, SYNC_CHUNK_SIZE, 1])
  })

  it('the phone keeps at most SYNC_QUEUE_MAX_ITEMS check-ins (the oldest go first)', () => {
    const queue = createQueue(memoryStorage())
    for (let i = 0; i < SYNC_QUEUE_MAX_ITEMS + 5; i++) queue.add(queued('q' + i))
    const kept = queue.list('prov-1')
    expect(kept).toHaveLength(SYNC_QUEUE_MAX_ITEMS)
    expect(kept[0].id).toBe('q5')
  })

  it('the server config exports the same sync, GPS and password values as shared/contract.js (one value, two names)', () => {
    expect(config.MAX_SYNC_BATCH).toBe(MAX_SYNC_BATCH)
    expect(config.GPS_MAX_USABLE_ACCURACY_M).toBe(GPS_MAX_USABLE_ACCURACY_M)
    expect(config.GPS_MAX_STALE_AGE_S).toBe(GPS_MAX_STALE_AGE_S)
    expect(config.PASSWORD_MIN_LENGTH).toBe(contract.PASSWORD_MIN_LENGTH)
    expect(config.PROVIDER_TOKEN_PREFIX).toBe(contract.PROVIDER_TOKEN_PREFIX)
    expect(config.MAX_TOKEN_LENGTH).toBe(contract.MAX_TOKEN_LENGTH)
  })
})

describe('the codes of a sync item: the server attaches them, the phone classifies them', () => {
  it('every code is permanent (the phone drops the item) or retryable (the item stays), never both and never neither', () => {
    const both = SYNC_PERMANENT_ERROR_CODES.filter((c) => SYNC_RETRYABLE_ERROR_CODES.includes(c))
    expect(both, 'a code cannot be both permanent and retryable').toEqual([])
    expect([...SYNC_ITEM_ERROR_CODES].sort()).toEqual([...SYNC_PERMANENT_ERROR_CODES, ...SYNC_RETRYABLE_ERROR_CODES].sort())
    const problems = []
    for (const [name, value] of Object.entries(SCAN_ERRORS)) {
      if (!SYNC_ITEM_ERROR_CODES.includes(value)) {
        problems.push(`shared/contract.js defines ${name} ("${value}") but neither SYNC_PERMANENT_ERROR_CODES nor SYNC_RETRYABLE_ERROR_CODES lists it: decide what the phone does with an item that carries it (an installed phone keeps an unknown code in the queue and retries it for ever, which blocks the items behind it).`)
      }
    }
    for (const code of SYNC_ITEM_ERROR_CODES) {
      if (!Object.values(SCAN_ERRORS).includes(code)) problems.push(`"${code}" is classified but is not the value of any SCAN_ERROR_* constant: write the code once, as a constant.`)
    }
    report(problems)
  })

  it('the phone drops an item for every permanent code, keeps it for every retryable one and for any code it does not know', async () => {
    const cases = [
      ...SYNC_PERMANENT_ERROR_CODES.map((code) => [code, 'dropped']),
      ...SYNC_RETRYABLE_ERROR_CODES.map((code) => [code, 'kept']),
      ['a_code_from_a_newer_server', 'kept'],
    ]
    for (const [code, want] of cases) {
      const queue = createQueue(memoryStorage())
      queue.add(queued('only'))
      const api = async (_path, { body }) => ({ results: body.scans.map((s) => ({ id: s.id, ok: false, error: { code } })) })
      const res = await flushQueue({ queue, api, token: 't', providerId: 'prov-1' })
      expect(res.dropped === 1 ? 'dropped' : 'kept', `the phone's decision for the code "${code}"`).toBe(want)
      expect(res.remaining).toBe(want === 'dropped' ? 0 : 1)
    }
  })

  it('the refusals that the phone shows a message for are codes of the contract', () => {
    const own = new Set(Object.values(SCAN_ERRORS))
    // `invalid_session` is not a refusal of a scan: it is the answer of the session check (server/auth.js).
    const stray = KNOWN_ERROR_CODES.filter((c) => c !== 'invalid_session' && !own.has(c))
    expect(stray, 'src/worker/errors.js names a code that shared/contract.js does not define').toEqual([])
  })

  // ---- read from the code: what can the server put on one item?

  /** The top-level arguments of the call whose '(' is at `open` in `code`, as text. */
  function callArgs(code, open) {
    const args = []
    let depth = 0
    let start = open + 1
    for (let i = open; i < code.length; i++) {
      const ch = code[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const m = new RegExp(`${ch}(?:[^${ch}\\\\]|\\\\[\\s\\S])*${ch}`, 'y')
        m.lastIndex = i
        const hit = m.exec(code)
        if (hit) i += hit[0].length - 1
      } else if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) {
        depth--
        if (depth === 0) {
          args.push(code.slice(start, i).trim())
          return args
        }
      } else if (ch === ',' && depth === 1) {
        args.push(code.slice(start, i).trim())
        start = i + 1
      }
    }
    throw new Error('a call in the scanned code never closes: the scan of tests/contract.test.js cannot read it')
  }

  /** The code argument of every call that makes an ApiError in `code`: bad(code), notFound(code), new ApiError(status, code), requireUuid(value, code)... */
  function refusalCodes(code) {
    const found = []
    for (const m of code.matchAll(/\b(bad|notFound|forbidden|conflict|unauthorized|requireUuid|new ApiError)\(/g)) {
      const args = callArgs(code, m.index + m[0].length - 1)
      const index = m[1] === 'new ApiError' || m[1] === 'requireUuid' ? 1 : 0
      found.push({ call: m[1], code: args[index] ?? '(no code argument: the default code of the helper)' })
    }
    return found
  }

  const RECORDING = 'server/scans.js (everything above the "reading" section: recordScan and what it calls)'
  const recordingCode = () => {
    const text = read('server/scans.js')
    const end = text.indexOf('// ---------- reading ----------')
    if (end < 0) throw new Error('server/scans.js has no "// ---------- reading ----------" line: tests/contract.test.js reads the recording half of the file above it.')
    return withoutComments(text.slice(0, end))
  }
  const handlerCode = () => {
    const text = read('server/routes/provider.js')
    const start = text.indexOf("route('POST', '/scans/sync'")
    const end = text.indexOf('\n})\n', start)
    if (start < 0 || end < 0) throw new Error("server/routes/provider.js has no route('POST', '/scans/sync', ...) ending in })")
    return withoutComments(text.slice(start, end))
  }

  it('the server refuses one scan only with codes of the contract, written as constants (no string of its own)', () => {
    const problems = []
    const sources = [
      [RECORDING, recordingCode()],
      ['server/scanLogic.js (the pure scan rules, which refuse nothing: they return an outcome)', withoutComments(read('server/scanLogic.js'))],
    ]
    const emitted = []
    for (const [where, code] of sources) {
      for (const { call, code: arg } of refusalCodes(code)) {
        emitted.push(arg)
        if (!/^SCAN_ERROR_[A-Z_]+$/.test(arg)) {
          problems.push(`${where}: ${call}(...) is given ${arg} as its code. A code that one scan can be refused with is a SCAN_ERROR_* constant of shared/contract.js, classified there for the phone (a string here would reach installed phones unclassified).`)
        } else if (!(arg in SCAN_ERRORS)) {
          problems.push(`${where}: ${arg} is not exported by shared/contract.js.`)
        } else if (!SYNC_ITEM_ERROR_CODES.includes(SCAN_ERRORS[arg])) {
          problems.push(`${where}: ${arg} ("${SCAN_ERRORS[arg]}") is not classified for the phone: add it to SYNC_PERMANENT_ERROR_CODES or SYNC_RETRYABLE_ERROR_CODES in shared/contract.js.`)
        }
      }
    }
    expect(emitted.length, 'the scan of the code found the refusals of recordScan').toBeGreaterThanOrEqual(6)
    report(problems)
  })

  it('the sync handler puts on an item only the code of the refusal it caught, or a constant of the contract', () => {
    const code = handlerCode()
    const used = [...code.matchAll(/ok: false, error: \{ code: ([^,}]+),/g)].map((m) => m[1].trim())
    expect(used.length, 'the scan of the code found the error branches of the handler').toBeGreaterThanOrEqual(2)
    report(
      used
        .filter((expr) => expr !== 'err.code' && !(/^SCAN_ERROR_[A-Z_]+$/.test(expr) && expr in SCAN_ERRORS && SYNC_ITEM_ERROR_CODES.includes(SCAN_ERRORS[expr])))
        .map((expr) => `The sync handler (server/routes/provider.js) attaches ${expr} to an item: use err.code (the code of a refusal of recordScan) or a classified SCAN_ERROR_* constant of shared/contract.js.`),
    )
    expect(used, 'the database error that the handler turns into invalid_item').toContain('SCAN_ERROR_INVALID_ITEM')
  })
})

// A real call of POST /api/scans/sync, with bad items of every kind the server knows how to refuse.

describe('POST /api/scans/sync with bad items (the real handler and database)', () => {
  let db, cookie, token
  const ids = {}
  const HOME = { lat: 32.0853, lng: 34.7818 }
  const sync = (scans, as = token) => call('POST', '/api/scans/sync', { token: as, body: { scans } })
  const makePoint = async (extra = {}) =>
    (await call('POST', '/api/admin/points', { cookie, body: { name: 'p-' + randomUUID().slice(0, 6), ...HOME, gps_mode: 'none', ...extra } })).json.point
  const login = async (provider_id, password) => (await call('POST', '/api/session', { body: { provider_id, password } })).json.token

  beforeAll(async () => {
    db = await setupDb()
    await seedAdmin(db.pool)
    cookie = await adminCookie()
    const mkProvider = async (company, password) =>
      (await call('POST', '/api/admin/providers', { cookie, body: { company, password } })).json.provider
    const a = await mkProvider('Contract A', 'contract-a-1')
    const b = await mkProvider('Contract B', 'contract-b-1')
    token = await login(a.id, 'contract-a-1')
    ids.tokenB = await login(b.id, 'contract-b-1')
    ids.open = await makePoint()
    ids.inactive = await makePoint()
    await call('PATCH', `/api/admin/points/${ids.inactive.id}`, { cookie, body: { is_active: false } })
    ids.onlyB = await makePoint({ provider_ids: [b.id] })
  })
  afterAll(async () => db?.teardown())
  afterEach(() => vi.restoreAllMocks())

  /** Makes the first lookup of a point by its QR token fail the way the database refuses an out-of-range value (SQLSTATE 22003). */
  function databaseRefusesTheItem() {
    let armed = true
    const realConnect = db.pool.connect.bind(db.pool)
    vi.spyOn(db.pool, 'connect').mockImplementation(async () => {
      const client = await realConnect()
      if (!client.contractPatched) {
        const realQuery = client.query.bind(client)
        client.query = (text, ...rest) =>
          armed && typeof text === 'string' && text.includes('from points where qr_token')
            ? Promise.reject(Object.assign(new Error('value out of range'), { code: '22003' }))
            : realQuery(text, ...rest)
        client.contractPatched = true
      }
      return client
    })
    return () => {
      armed = false
    }
  }

  it('refuses a batch above MAX_SYNC_BATCH whole, and takes exactly MAX_SYNC_BATCH', async () => {
    const items = (n) => Array.from({ length: n }, () => ({ id: 'not-a-uuid', code: 'x' }))
    const exact = await sync(items(MAX_SYNC_BATCH))
    expect(exact.status).toBe(200)
    expect(exact.json.results).toHaveLength(MAX_SYNC_BATCH)
    const over = await sync(items(MAX_SYNC_BATCH + 1))
    expect(over.status).toBe(400)
    expect(over.json.error.code).toBe('batch_too_large')
  })

  const seen = new Set()
  const codesOf = (res) => res.json.results.filter((r) => !r.ok).map((r) => r.error.code)

  it('every refusal of one item carries a code that the phone classifies', async () => {
    const goodId = randomUUID()
    const sharedId = randomUUID()
    const t = '2026-09-01T10:00:00Z'
    // B records a scan under sharedId, then A sends the same id: that id belongs to someone else.
    expect((await sync([{ id: sharedId, code: ids.open.qr_token, client_time: t }], ids.tokenB)).json.results[0].ok).toBe(true)
    const res = await sync([
      { id: 'not-a-uuid', code: ids.open.qr_token, client_time: t }, // invalid_scan_id
      null, // not even an object: invalid_scan_id as well
      { id: randomUUID(), code: 'nonsense', client_time: t }, // invalid_code
      { id: randomUUID(), code: 12345, client_time: t }, // invalid_code (not text)
      { id: randomUUID(), code: 'BQR-unknown0000000', client_time: t }, // unknown_code
      { id: randomUUID(), code: ids.inactive.qr_token, client_time: t }, // point_inactive
      { id: randomUUID(), code: ids.onlyB.qr_token, client_time: t }, // not_assigned
      { id: sharedId, code: ids.open.qr_token, client_time: t }, // scan_id_conflict
      { id: goodId, code: ids.open.qr_token, client_time: t }, // fine
    ])
    expect(res.status).toBe(200)
    expect(res.json.results.find((r) => r.id === goodId).ok).toBe(true)
    const codes = codesOf(res)
    codes.forEach((c) => seen.add(c))
    expect(codes.filter((c) => !SYNC_ITEM_ERROR_CODES.includes(c)), 'codes that the server attached and the phone does not classify').toEqual([])
    expect(new Set(codes)).toEqual(new Set(Object.values(SCAN_ERRORS).filter((c) => c !== contract.SCAN_ERROR_INVALID_ITEM)))
  })

  it('a database refusal of one item is invalid_item, which the phone drops, and it does not stop the item behind it', async () => {
    const disarm = databaseRefusesTheItem()
    const poison = { id: randomUUID(), code: ids.open.qr_token, client_time: '2026-09-02T10:00:00Z' }
    const res = await sync([poison])
    disarm()
    expect(res.status).toBe(200)
    expect(res.json.results[0]).toMatchObject({ id: poison.id, ok: false, error: { code: contract.SCAN_ERROR_INVALID_ITEM } })
    codesOf(res).forEach((c) => seen.add(c))
    const after = await sync([{ id: randomUUID(), code: ids.open.qr_token, client_time: '2026-09-03T10:00:00Z' }])
    expect(after.json.results[0].ok).toBe(true)
  })

  it('the matrix above reached every classified code (add a case here when a code is added)', () => {
    expect([...seen].sort()).toEqual([...SYNC_ITEM_ERROR_CODES].sort())
  })
})

// ======================================================================================================================
// 2. The GPS limits and the vocabularies
// ======================================================================================================================

describe('the GPS limits: one number for the phone and the server', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A phone whose position answers are `accuracies`, one per request; records the options of every request. */
  function fakePhone(accuracies) {
    const requests = []
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition(ok, _fail, options) {
          const accuracy = accuracies[Math.min(requests.length, accuracies.length - 1)]
          requests.push(options)
          ok({ coords: { latitude: 32.08, longitude: 34.78, accuracy }, timestamp: Date.now() })
        },
      },
    })
    return requests
  }

  it('the phone is content with a position of exactly the accuracy that the server counts as usable, and asks again for a vaguer one', async () => {
    const usable = fakePhone([config.GPS_MAX_USABLE_ACCURACY_M])
    await getFix()
    expect(usable, 'one request: the first position was good enough').toHaveLength(1)
    const vague = fakePhone([config.GPS_MAX_USABLE_ACCURACY_M + 1, 5])
    await getFix()
    expect(vague, 'a second request for a fresh position').toHaveLength(2)
    expect(vague[1]).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 })
  })

  it('the phone accepts a remembered position of up to the age that the server credits walking for', async () => {
    const requests = fakePhone([5])
    await getFix()
    expect(requests[0].maximumAge).toBe(config.GPS_MAX_STALE_AGE_S * 1000)
    expect(requests[0].maximumAge).toBe(5 * 60_000)
  })

  it('the server judges a position of exactly that accuracy and refuses to judge a vaguer one', () => {
    const point = { lat: 32.0853, lng: 34.7818, radius_m: 50 }
    const farAway = { lat: point.lat + 0.05, lng: point.lng }
    const judged = evaluateGps({ mode: contract.GPS_MODE_REQUIRED, point, gps: { ...farAway, accuracy: GPS_MAX_USABLE_ACCURACY_M } })
    expect(judged.outcome).toBe(contract.OUTCOME_REJECTED_FAR)
    const vague = evaluateGps({ mode: contract.GPS_MODE_REQUIRED, point, gps: { ...farAway, accuracy: GPS_MAX_USABLE_ACCURACY_M + 1 } })
    expect(vague.outcome).toBe(contract.OUTCOME_REJECTED_NO_LOCATION)
  })
})

describe('the vocabularies and limits: the same as the database that stores them', () => {
  const migrations = fs
    .readdirSync(abs('db/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => read(`db/migrations/${f}`))
    .join('\n')
  // The last `check (<column> in (...))` wins (a later migration may replace a constraint).
  const allowed = (column) => {
    const all = [...migrations.matchAll(new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)\\s*\\)`, 'gi'))]
    if (!all.length) throw new Error(`no check constraint "${column} in (...)" in db/migrations: tests/contract.test.js reads it`)
    return [...all.at(-1)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  }

  it('GPS modes, outcomes and sources are exactly what the scans and points tables allow', () => {
    expect(contract.GPS_MODES).toEqual(allowed('gps_mode'))
    expect([...contract.SCAN_OUTCOMES].sort()).toEqual(allowed('outcome').sort())
    expect([...contract.SCAN_SOURCES].sort()).toEqual(allowed('source').sort())
  })

  it('the radius bounds and default are those of points.radius_m', () => {
    expect(migrations).toMatch(new RegExp(`radius_m\\s+integer\\s+not null\\s+default\\s+${contract.POINT_RADIUS_DEFAULT_M}\\s+check\\s*\\(\\s*radius_m\\s+between\\s+${contract.POINT_RADIUS_MIN_M}\\s+and\\s+${contract.POINT_RADIUS_MAX_M}\\s*\\)`, 'i'))
  })

  it('the address limit is that of building_settings.address', () => {
    expect(migrations).toContain(`char_length(address) <= ${contract.ADDRESS_MAX_LENGTH}`)
  })

  it('the default GPS mode is that of points.gps_mode', () => {
    expect(migrations).toMatch(new RegExp(`gps_mode\\s+text\\s+not null\\s+default\\s+'${contract.DEFAULT_GPS_MODE}'`, 'i'))
  })
})

describe('the QR token: one reader for the phone and the server', () => {
  it('is the same function on both sides', () => {
    expect(parseQrTokenFromServer).toBe(parseQrToken)
  })

  it('accepts a token of 6 to 80 letters, digits or hyphens after the prefix, bare or in the printed address', () => {
    const body = (n) => 'a1-'.repeat(30).slice(0, n)
    for (const n of [6, 24, 80]) {
      const token = `${contract.QR_TOKEN_PREFIX}${body(n)}`
      expect(parseQrToken(token), `${n} characters`).toBe(token)
      expect(parseQrToken(`https://example.test/scan?code=${token}`), `${n} characters, in the address`).toBe(token)
    }
    expect(parseQrToken(`  ${contract.QR_TOKEN_PREFIX}abc123  `), 'surrounding spaces are trimmed').toBe('BQR-abc123')
  })

  it('refuses everything else', () => {
    const body = (n) => 'a'.repeat(n)
    for (const bad of [
      `${contract.QR_TOKEN_PREFIX}${body(5)}`, // too short
      `${contract.QR_TOKEN_PREFIX}${body(81)}`, // too long
      `BQT-${body(10)}`, // another prefix
      `bqr-${body(10)}`, // case matters
      `${contract.QR_TOKEN_PREFIX}abc_123`, // an underscore is not allowed
      `${contract.QR_TOKEN_PREFIX}abc 123`,
      '', null, undefined, 42, {},
      'https://example.test/scan?code=nonsense',
      'https://example.test/scan',
    ]) {
      expect(parseQrToken(bad), String(bad)).toBeNull()
    }
  })

  it('a token that this system mints is a token that it reads', () => {
    const minted = `${contract.QR_TOKEN_PREFIX}${'0123456789abcdef01234567'}`
    expect(contract.QR_TOKEN_RE.test(minted)).toBe(true)
  })
})

// ======================================================================================================================
// 3. The values themselves are pinned
// ======================================================================================================================

const OLD_PHONES = 'Installed phones keep their own copy of the JavaScript for days or weeks, and the offline queue on a phone holds check-ins that an old version wrote (AGENTS.md, "Database and API changes").'
const OLD_FORM = 'The committee form (src/admin) and the server both check it, and a tab that is open keeps the old form for as long as it stays open.'

// [name, the value now, the value pinned, why it matters]
const PINNED = [
  ['MAX_SYNC_BATCH', MAX_SYNC_BATCH, 20, `Lowering the server's batch limit makes it refuse a batch that an installed phone still sends (it sends up to its own chunk), for good: that phone never empties its queue. ${OLD_PHONES}`],
  ['SYNC_CHUNK_SIZE', SYNC_CHUNK_SIZE, 10, `It sizes the upload to finish inside the request timeout (the server takes about ten round trips per item). A larger chunk can time out on a slow connection and the same batch is retried for ever. ${OLD_PHONES}`],
  ['SYNC_QUEUE_MAX_ITEMS', SYNC_QUEUE_MAX_ITEMS, 500, `It is how many check-ins a phone keeps while it has no signal; a lower cap throws away visits that a worker already made. ${OLD_PHONES}`],
  ['SYNC_PERMANENT_ERROR_CODES', [...SYNC_PERMANENT_ERROR_CODES], ['invalid_code', 'unknown_code', 'point_inactive', 'not_assigned', 'invalid_scan_id', 'scan_id_conflict', 'invalid_item'], `These are the seven codes after which a phone drops a queued scan. A code missing here is retried for ever and blocks the queue; a code added here makes a phone drop a scan that might have been accepted later. ${OLD_PHONES}`],
  ['SYNC_RETRYABLE_ERROR_CODES', [...SYNC_RETRYABLE_ERROR_CODES], [], `No code of a sync item is retried on purpose today. ${OLD_PHONES}`],
  ['GPS_MAX_USABLE_ACCURACY_M', GPS_MAX_USABLE_ACCURACY_M, 150, `A position vaguer than this is not judged (the server) and is replaced by a fresh one (the phone). Raising it lets a vaguer position decide a check-in; lowering it refuses positions that old phones still accept. ${OLD_PHONES}`],
  ['GPS_MAX_STALE_AGE_S', GPS_MAX_STALE_AGE_S, 300, `5 minutes: how old a remembered position the phone accepts, and the cap of the walking allowance on the server. Old phones accept a position this old whatever the server says. ${OLD_PHONES}`],
  ['GPS_MODES', [...contract.GPS_MODES], ['required', 'optional', 'none'], 'They are the values of points.gps_mode (a check constraint), sent by the committee form and read by the phone to decide whether to ask for a location.'],
  ['DEFAULT_GPS_MODE', contract.DEFAULT_GPS_MODE, 'optional', 'It is the default of the column and of the form for a new point.'],
  ['SCAN_OUTCOMES', [...contract.SCAN_OUTCOMES], ['accepted', 'rejected_far', 'rejected_no_location'], `They are stored in scans.outcome (a check constraint), documented for the agent, and read by the phone to tell the worker what happened. ${OLD_PHONES}`],
  ['SCAN_SOURCES', [...contract.SCAN_SOURCES], ['online', 'offline_sync'], 'They are stored in scans.source (a check constraint) and documented for the agent.'],
  ['POINT_RADIUS_MIN_M', contract.POINT_RADIUS_MIN_M, 1, `${OLD_FORM} It is also the check constraint of points.radius_m.`],
  ['POINT_RADIUS_MAX_M', contract.POINT_RADIUS_MAX_M, 1000, `${OLD_FORM} It is also the check constraint of points.radius_m.`],
  ['POINT_RADIUS_DEFAULT_M', contract.POINT_RADIUS_DEFAULT_M, 50, `${OLD_FORM} It is also the default of points.radius_m, and what the import gives a point whose radius it cannot read.`],
  ['PASSWORD_MIN_LENGTH', contract.PASSWORD_MIN_LENGTH, 8, `${OLD_FORM} A provider's password that was set under the old rule must still be accepted when the person signs in: the minimum is only checked when a password is set.`],
  ['PASSWORD_MAX_LENGTH', contract.PASSWORD_MAX_LENGTH, 200, `${OLD_FORM} It is also the longest password that the sign-in reads.`],
  ['NAME_MAX_LENGTH', contract.NAME_MAX_LENGTH, 120, `${OLD_FORM} Names of points, companies, contact persons and committee members of that length are already stored.`],
  ['DESCRIPTION_MAX_LENGTH', contract.DESCRIPTION_MAX_LENGTH, 500, OLD_FORM],
  ['SERVICE_TYPE_MAX_LENGTH', contract.SERVICE_TYPE_MAX_LENGTH, 60, OLD_FORM],
  ['VOID_REASON_MAX_LENGTH', contract.VOID_REASON_MAX_LENGTH, 300, OLD_FORM],
  ['KEY_NAME_MAX_LENGTH', contract.KEY_NAME_MAX_LENGTH, 80, OLD_FORM],
  ['DEVICE_LABEL_MAX_LENGTH', contract.DEVICE_LABEL_MAX_LENGTH, 80, `The phone cuts its label to this when it signs in, and the server refuses a longer one (device_label is too long): a lower limit on the server would refuse the sign-in of an installed phone. ${OLD_PHONES}`],
  ['EMAIL_MAX_LENGTH', contract.EMAIL_MAX_LENGTH, 200, OLD_FORM],
  ['ADDRESS_MAX_LENGTH', contract.ADDRESS_MAX_LENGTH, 200, `${OLD_FORM} It is also the check constraint of building_settings.address.`],
  ['QR_TOKEN_PREFIX', contract.QR_TOKEN_PREFIX, 'BQR-', 'Every QR code that was ever printed starts with it (the old system printed the same prefix). A different prefix stops them all.'],
  ['QR_TOKEN_RE (its source)', contract.QR_TOKEN_RE.source, '^BQR-[A-Za-z0-9-]{6,80}$', 'It has to accept every QR code that was ever printed, including the old system\'s, so it is never narrowed: a narrower pattern turns a printed code into "not one of ours".'],
  ['PROVIDER_TOKEN_PREFIX', contract.PROVIDER_TOKEN_PREFIX, 'qrp_', `Every device token that the server minted starts with it, and the phone drops a stored session whose token does not (src/worker/session.js), so a different prefix signs out every installed phone the next time it starts. The server also refuses a token without it. ${OLD_PHONES}`],
  ['MAX_TOKEN_LENGTH', contract.MAX_TOKEN_LENGTH, 200, `The server refuses a token longer than this without a query, and the phone drops a stored session whose token is longer. A minted token is 47 characters: a value below that would refuse every token that exists, and every installed phone would be signed out. ${OLD_PHONES}`],
  ['QR_TOKEN_RE (its flags)', contract.QR_TOKEN_RE.flags, '', 'A global or sticky flag makes test() remember where it stopped, and the next scan of a valid code fails.'],
  ['APP_BUILD_RE (its source)', contract.APP_BUILD_RE.source, '^(?:[0-9a-f]{7}|dev)$', `It is the shape of the build id that vite.config.js writes into the bundle (7 characters of the commit, or dev) and that src/ui/build.js accepts. It is never narrowed: a phone keeps the id it was built with until it is updated, and a reader of the shape (the server, once a phone reports its build) must accept every id that a build ever wrote. ${OLD_PHONES}`],
  ['APP_BUILD_RE (its flags)', contract.APP_BUILD_RE.flags, '', 'A global or sticky flag makes test() remember where it stopped, and the next id that is checked fails.'],
  ['DEVICE_STATUS_MIN_INTERVAL_S', contract.DEVICE_STATUS_MIN_INTERVAL_S, 10, `The server stores a report of a phone only when the last one is this many seconds old, and answers one that comes sooner as usual without storing it. The phone (a later release) reports no more often than this, so a higher value makes the server drop reports of a phone that keeps to this rhythm, and a lower one lets a loop on a phone write a row for each report. ${OLD_PHONES}`],
  ['DEVICE_STATUS_MAX_TOTAL', contract.DEVICE_STATUS_MAX_TOTAL, 1000000, `The largest cumulative count that the server takes for not_accepted_total and overflowed_total (the phone counts them since it signed in and never resets them): a larger whole number is cut to it, and the stored total never goes down. A lower value would cut the honest count of a phone that has run for a long time, and its total would stop growing there. ${OLD_PHONES}`],
  ['DEVICE_STATUS_MAX_AGE_DAYS', contract.DEVICE_STATUS_MAX_AGE_DAYS, 60, `The oldest_waiting_at that the server believes: an older time is stored as nothing. It is the one place where the age of a waiting visit is judged, and a phone that reports an older time shows "unknown" to the committee, so a higher value shows a time that is certainly a wrong clock and a lower one hides a real, long wait. ${OLD_PHONES}`],
  ['CLIENT_ERROR_KINDS', [...contract.CLIENT_ERROR_KINDS], ['crash', 'unhandled', 'signed_out'], `The kinds that an app reports, which are values of app_errors.kind (a check constraint). The server skips an event of a kind that is not here, so removing one silently drops what an installed app still sends, and a new one needs the check constraint of the table and a decision about whether it tells the owner (server/routes/clientErrors.js). ${OLD_PHONES}`],
  ['CLIENT_PLACES', [...contract.CLIENT_PLACES], ['provider:login', 'provider:home', 'provider:working', 'provider:result', 'provider:app', 'committee:login', 'committee:points', 'committee:providers', 'committee:history', 'committee:agent', 'committee:committee', 'committee:app'], `The closed list of screen keys that an app may report as the place of an error: it keeps the number of rows of app_errors small whatever an app sends. The server skips an event whose place is not here, so a key that is removed silently drops what an installed app still sends. A new screen gets a new key in the same change that adds it (tests/client-errors.test.js compares the list with the tabs of the committee app). ${OLD_PHONES}`],
  ['ERROR_NAME_RE (its source)', contract.ERROR_NAME_RE.source, '^[A-Za-z][A-Za-z0-9_$]{0,63}$', `The shape of an error's name (the class of the error). The phone reports a name of this shape and "UnknownError" for anything else (src/ui/crash.js), and the server keeps a reported name only in this shape. It is never narrowed: a narrower pattern makes the server drop the name that an installed app sends, and a wider one lets free text into app_errors. ${OLD_PHONES}`],
  ['ERROR_NAME_RE (its flags)', contract.ERROR_NAME_RE.flags, '', 'A global or sticky flag makes test() remember where it stopped, and the next name that is checked fails.'],
  ['CLIENT_ERROR_CODE_RE (its source)', contract.CLIENT_ERROR_CODE_RE.source, '^[a-z0-9_]{1,40}$', `The shape of a code that an app reports (an API error code such as invalid_session). The server keeps it only in this shape, so a narrower pattern drops the codes that an installed app sends, and a wider one lets free text into app_errors. ${OLD_PHONES}`],
  ['CLIENT_ERROR_CODE_RE (its flags)', contract.CLIENT_ERROR_CODE_RE.flags, '', 'A global or sticky flag makes test() remember where it stopped, and the next code that is checked fails.'],
  ['MAX_CLIENT_ERROR_EVENTS', contract.MAX_CLIENT_ERROR_EVENTS, 20, `The most events that the server takes from one report (it ignores the rest, and answers 200 as always). A lower value drops events that an installed app sends in one report. ${OLD_PHONES}`],
  ['CLIENT_ERROR_MAX_COUNT', contract.CLIENT_ERROR_MAX_COUNT, 1000, `The largest count of one event (a larger whole number is cut to it, and anything else is taken as 1). It is also the most that one call of recordEvent adds to a row. A lower value cuts the honest count of an app that was offline for a while. ${OLD_PHONES}`],
]

describe('the values of shared/contract.js are pinned: a change is a decision about the installed phones', () => {
  it.each(PINNED)('%s', (name, now, pinned, why) => {
    expect(now, `${name} is ${JSON.stringify(now)} but the contract pins ${JSON.stringify(pinned)}. ${why} If the change is on purpose, make it in its own release (expand, migrate, contract: AGENTS.md) and update the pinned value in tests/contract.test.js.`).toEqual(pinned)
  })

  it('no value of the contract goes without a pin (a new value needs its pin and its reason)', () => {
    const pinnedNames = new Set(PINNED.map(([name]) => name.replace(/ \(.*\)$/, '')))
    const missing = Object.keys(contract)
      .filter((name) => !pinnedNames.has(name))
      // The single words of a vocabulary and the single codes are pinned through their list (GPS_MODES, SCAN_OUTCOMES,
      // SCAN_SOURCES, SYNC_PERMANENT_ERROR_CODES); SYNC_ITEM_ERROR_CODES is built from the two lists above it.
      .filter((name) => !/^(GPS_MODE_|OUTCOME_|SOURCE_|SCAN_ERROR_)/.test(name) && name !== 'SYNC_ITEM_ERROR_CODES')
    expect(missing, 'exports of shared/contract.js that tests/contract.test.js does not pin').toEqual([])
  })

  it('every word of a vocabulary is in its list, and the lists hold nothing else', () => {
    const words = (prefix) => Object.entries(contract).filter(([n, v]) => n.startsWith(prefix) && typeof v === 'string').map(([, v]) => v)
    expect(words('GPS_MODE_').sort()).toEqual([...contract.GPS_MODES].sort())
    expect(words('OUTCOME_').sort()).toEqual([...contract.SCAN_OUTCOMES].sort())
    expect(words('SOURCE_').sort()).toEqual([...contract.SCAN_SOURCES].sort())
    expect(Object.values(SCAN_ERRORS).sort()).toEqual([...SYNC_ITEM_ERROR_CODES].sort())
  })
})

// ======================================================================================================================
// 4. src/ and server/ hold no copy of what moved
// ======================================================================================================================

describe('src/ and server/ write a word of the contract only through its constant', () => {
  // Where a quoted word that equals a word of the contract is NOT that word, and why.
  const NOT_THE_WORD = [
    { file: 'src/worker/hooks.js', value: 'online', reason: "the browser's own event name (window.addEventListener('online'))" },
  ]
  // "none" is also a CSS value (pointerEvents, display), an SVG value (fill) and a status of the phone's own: it counts as the
  // GPS mode only on a line that talks about the GPS or a mode. The other words are not that common, so every one counts.
  const GENERIC = new Set([contract.GPS_MODE_NONE])
  const aboutTheMode = /gps|mode/i

  it('no string literal of a GPS mode, outcome, source or scan error code', () => {
    const words = new Map()
    const add = (kind, list) => list.forEach((w) => words.set(w, [...(words.get(w) ?? []), kind]))
    add('a GPS mode', contract.GPS_MODES)
    add('an outcome', contract.SCAN_OUTCOMES)
    add('a source', contract.SCAN_SOURCES)
    add('a scan error code', Object.values(SCAN_ERRORS))
    const problems = []
    for (const { file, text } of codeFiles('src', 'server')) {
      const lines = withoutComments(text).split('\n')
      for (const { value, line } of stringLiterals(text)) {
        if (!words.has(value)) continue
        if (NOT_THE_WORD.some((x) => x.file === file && x.value === value)) continue
        if (GENERIC.has(value) && !aboutTheMode.test(lines[line - 1])) continue
        problems.push(`${file}:${line} writes "${value}" (${words.get(value).join(' and ')}) as a string literal: import its constant from shared/contract.js (a typo in a string is silent, one in an import is an error). If it is another thing that happens to be spelled the same, add it to NOT_THE_WORD in tests/contract.test.js with the reason.`)
      }
    }
    report(problems)
  })

  it('the exceptions above still exist (a stale exception hides nothing)', () => {
    const problems = []
    for (const { file, value, reason } of NOT_THE_WORD) {
      const hit = stringLiterals(read(file)).some((l) => l.value === value)
      if (!hit) problems.push(`NOT_THE_WORD names "${value}" in ${file} (${reason}), which no longer writes it: remove the exception.`)
    }
    report(problems)
  })
})

describe('src/ and server/ hold no copy of a number or a pattern that moved to shared/contract.js', () => {
  // [what, pattern (on the code of a line, comments blanked), the files it is looked for in, what to use instead]
  const SRC = ['src']
  const BOTH = ['src', 'server']
  const COPIES = [
    ['a number given to a moved constant', /\b(?:BATCH|MAX_ITEMS|MAX_SYNC_BATCH|USABLE_ACCURACY_M|GPS_MAX_USABLE_ACCURACY_M|GPS_MAX_STALE_AGE_S|PASSWORD_MIN_LENGTH|ADDRESS_MAX)\s*=\s*\d/, BOTH, 'the shared constant'],
    ['the sync batch, the chunk or the queue cap as a number', /\b(?:20|500)\b[^\n]*(?:batch|BATCH|chunk|queue)|(?:batch|BATCH|chunk|queue)[^\n]*\b(?:20|500)\b/i, BOTH, 'MAX_SYNC_BATCH, SYNC_CHUNK_SIZE or SYNC_QUEUE_MAX_ITEMS'],
    ['the GPS accuracy limit or the age of a remembered position', /\b150\b|\b300\b|\b5\s*\*\s*60_?000\b/, ['src/worker', 'server/scanLogic.js'], 'GPS_MAX_USABLE_ACCURACY_M or GPS_MAX_STALE_AGE_S'],
    ['a text limit as a maxLength', /maxLength=\{(?:60|80|120|200|300|500)\}/, SRC, 'the *_MAX_LENGTH constant of the field'],
    ['a text limit in a server check', /\bmax:\s*(?:60|80|120|200|300|500)\b/, ['server'], 'the *_MAX_LENGTH constant of the field'],
    ['a text limit in a cut of the device label', /slice\(0,\s*80\)/, SRC, 'DEVICE_LABEL_MAX_LENGTH'],
    ['the radius bounds or default', /radius[^\n]*\b(?:50|1000)\b|\bmin:\s*1,\s*max:\s*1000\b/i, BOTH, 'POINT_RADIUS_MIN_M, POINT_RADIUS_MAX_M or POINT_RADIUS_DEFAULT_M'],
    ['the shortest password', /\.length\s*<\s*8\b/, BOTH, 'PASSWORD_MIN_LENGTH'],
    ['the QR token pattern or prefix', /BQR-/, BOTH, 'QR_TOKEN_RE, QR_TOKEN_PREFIX or parseQrToken from shared/'],
    ['the prefix of a provider device token', /['"`]qrp_/, BOTH, 'PROVIDER_TOKEN_PREFIX'],
  ]

  it('finds no copy', () => {
    const problems = []
    const files = codeFiles('src', 'server')
    for (const [what, pattern, where, instead] of COPIES) {
      for (const { file, text } of files) {
        if (!where.some((w) => file === w || file.startsWith(`${w}/`))) continue
        withoutComments(text).split('\n').forEach((line, i) => {
          if (pattern.test(line)) problems.push(`${file}:${i + 1} (${what}): ${line.trim()}  -> use ${instead} from shared/contract.js`)
        })
      }
    }
    report(problems)
  })

  it('the scan can see a copy (it flags a planted one)', () => {
    const planted = ["const BATCH = 10", 'maxLength={120}', "radius_m: '50'", 'x.length < 8', "const t = 'BQR-abc'", "token.startsWith('qrp_')"]
    const hits = planted.filter((line) => COPIES.some(([, pattern]) => pattern.test(line)))
    expect(hits).toEqual(planted)
  })
})

// ======================================================================================================================
// 5. The client bundle holds no server-only code
// ======================================================================================================================

describe('the client does not reach into server/', () => {
  it('no file under src/ imports from server/ (what both sides need is in shared/)', () => {
    const problems = []
    for (const { file, text } of codeFiles('src')) {
      withoutComments(text).split('\n').forEach((line, i) => {
        if (/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\bserver\//.test(line)) {
          problems.push(`${file}:${i + 1} imports from server/: ${line.trim()}  -> move what it needs to shared/ and import it from there (server code in the bundle can carry server-only strings)`)
        }
      })
    }
    report(problems)
  })
})

describe('the built client bundle', () => {
  let outDir
  let output = ''
  const files = []

  beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bqr-contract-bundle-'))
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production' // vitest sets 'test'; the bundle must be the one that npm run build makes
    try {
      await build({ root: ROOT, logLevel: 'silent', build: { outDir, emptyOutDir: true, reportCompressedSize: false } })
    } finally {
      if (before === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = before
    }
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|html|css)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8')
          files.push({ file: path.relative(outDir, full).replace(/\\/g, '/'), text })
          output += text + '\n'
        }
      }
    }
    walk(outDir)
  }, 240_000)

  afterAll(() => {
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true })
  })

  it('was built, and holds the phone code that it should (so that the checks below read the right thing)', () => {
    expect(files.some((f) => f.file.endsWith('.js'))).toBe(true)
    expect(output).toContain('qr.queue.v1') // the key of the offline queue (src/worker/scanQueue.js)
    expect(output).toContain('BQR-[A-Za-z0-9-]{6,80}') // the QR pattern of shared/contract.js, through shared/qrToken.js
  })

  it('holds no server-only code: no cookie name of the committee session, no database or password-hashing code', () => {
    // Strings that only server/ writes. qr_admin is the committee session cookie (ADMIN_COOKIE in server/config.js): it is
    // a plain constant that the bundler drops when nothing uses it, so finding it means that something under src/ does.
    const SERVER_ONLY = ['qr_admin', 'DATABASE_URL', 'pg_advisory_xact_lock', 'scryptSync', 'statement_timeout', 'DEV_ADMIN_LOGIN', 'app.allow_scan_delete']
    report(SERVER_ONLY.filter((marker) => output.includes(marker)).map((marker) => `the built client bundle contains "${marker}", which only server/ writes: something under src/ imports server code (import what both need from shared/ instead).`))
  })
})
