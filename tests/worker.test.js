import { describe, it, expect, vi, afterEach } from 'vitest'
import { performCheckIn, withScanContext, providerLabel } from '../src/worker/checkIn.js'
import { KNOWN_ERROR_CODES, errorMessageKey, isKnownError } from '../src/worker/errors.js'
import { createQueue, flushQueue } from '../src/worker/scanQueue.js'
import { api, ApiError } from '../src/api/client.js'
import { SAMPLE_PROVIDER_NAMES } from '../scripts/sample-data.mjs'
import { GPS_MAX_USABLE_ACCURACY_M } from '../shared/contract.js'

const memoryStorage = () => {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }
}
const session = { token: 'qrp_x', provider: { id: 'prov-1' } }
const scanRes = (over = {}, extra = {}) => ({ scan: { id: 's', outcome: 'accepted', point_name: 'לובי', ...over }, duplicate: false, ...extra })

function setup({ apiImpl, fix = { fix: { lat: 1, lng: 2, accuracy: 10 }, reason: null } } = {}) {
  const queue = createQueue(memoryStorage())
  const getFix = vi.fn(async () => fix)
  const apiFn = vi.fn(apiImpl)
  const deps = { api: apiFn, getFix, queue, newId: () => 'scan-id-1', now: () => new Date('2026-09-30T05:12:00Z') }
  return { queue, getFix, apiFn, run: (point = { gps_mode: 'optional' }, onPhase) => performCheckIn({ code: 'BQR-abc123', point, session, deps, onPhase }) }
}

describe('performCheckIn', () => {
  it('success: sends id, phone time and GPS fix, reports the phases', async () => {
    const t = setup({ apiImpl: async () => scanRes() })
    const phases = []
    const r = await t.run(undefined, (p) => phases.push(p))
    expect(r.kind).toBe('success')
    expect(phases).toEqual(['locating', 'saving'])
    const [path, opts] = t.apiFn.mock.calls[0]
    expect(path).toBe('/scan')
    expect(opts).toMatchObject({ method: 'POST', token: 'qrp_x', timeoutMs: 8000 })
    expect(opts.body).toEqual({ id: 'scan-id-1', code: 'BQR-abc123', client_time: '2026-09-30T05:12:00.000Z', gps: { lat: 1, lng: 2, accuracy: 10 } })
  })

  it("skips GPS entirely for 'none' points (no permission prompt in the basement)", async () => {
    const t = setup({ apiImpl: async () => scanRes() })
    const phases = []
    await t.run({ gps_mode: 'none' }, (p) => phases.push(p))
    expect(t.getFix).not.toHaveBeenCalled()
    expect(phases).toEqual(['saving'])
    expect(t.apiFn.mock.calls[0][1].body.gps).toBeNull()
  })

  it("waits for a precise position (never a remembered one) only on points that 'require' location", async () => {
    const t = setup({ apiImpl: async () => scanRes() })
    await t.run({ gps_mode: 'required' })
    expect(t.getFix).toHaveBeenLastCalledWith({ precise: true })
    await t.run({ gps_mode: 'optional' })
    expect(t.getFix).toHaveBeenLastCalledWith(undefined) // the default (a position up to 5 minutes old is fine)
  })

  it("labels who is signed in the way the committee named them", () => {
    expect(providerLabel({ contact_name: SAMPLE_PROVIDER_NAMES.cleaner, company: 'ניקיון' })).toBe(`${SAMPLE_PROVIDER_NAMES.cleaner} · ניקיון`)
    expect(providerLabel({ contact_name: '', company: 'ניקיון' })).toBe('ניקיון')
    expect(providerLabel(null)).toBe('')
  })

  it('still records when there is no fix (server flags it, does not refuse)', async () => {
    const t = setup({ apiImpl: async () => scanRes({}), fix: { fix: null, reason: 'denied' } })
    expect((await t.run()).kind).toBe('success')
    expect(t.apiFn.mock.calls[0][1].body.gps).toBeNull()
  })

  it('maps server outcomes', async () => {
    expect((await setup({ apiImpl: async () => scanRes({}, { duplicate: true }) }).run()).kind).toBe('duplicate')
    const far = await setup({ apiImpl: async () => scanRes({ outcome: 'rejected_far', distance_m: 800 }) }).run()
    expect(far.kind).toBe('far')
    expect(far.scan.distance_m).toBe(800)
    const need = await setup({ apiImpl: async () => scanRes({ outcome: 'rejected_no_location' }), fix: { fix: null, reason: 'denied' } }).run()
    expect(need).toMatchObject({ kind: 'needLocation', locationReason: 'denied' })
  })

  it('no signal or timeout: saves to the phone with the same id and says so', async () => {
    for (const status of [0, 502]) {
      const t = setup({ apiImpl: async () => { throw new ApiError(status, status ? 'server_error' : 'timeout') } })
      const r = await t.run()
      expect(r).toMatchObject({ kind: 'queued', id: 'scan-id-1', persisted: true })
      expect(t.queue.list('prov-1')).toEqual([
        { id: 'scan-id-1', code: 'BQR-abc123', client_time: '2026-09-30T05:12:00.000Z', gps: { lat: 1, lng: 2, accuracy: 10 }, provider_id: 'prov-1', saved_at: '2026-09-30T05:12:00.000Z' },
      ])
    }
  })

  it('a saved visit says whether it carries a position that the server can use', async () => {
    const offline = async () => { throw new ApiError(0, 'timeout') }
    const usable = { fix: { lat: 1, lng: 2, accuracy: 10, age_s: 0 }, reason: null }
    const limit = { fix: { lat: 1, lng: 2, accuracy: GPS_MAX_USABLE_ACCURACY_M, age_s: 0 }, reason: null }
    const vague = { fix: { lat: 1, lng: 2, accuracy: GPS_MAX_USABLE_ACCURACY_M + 1, age_s: 0 }, reason: null }
    const nothing = { fix: null, reason: 'timeout' }
    for (const [fix, located] of [[usable, true], [limit, true], [vague, false], [nothing, false]]) {
      for (const point of [{ gps_mode: 'required' }, { gps_mode: 'optional' }]) {
        const r = await setup({ apiImpl: offline, fix }).run(point)
        expect(r, `${point.gps_mode}, accuracy ${fix.fix?.accuracy}`).toMatchObject({ kind: 'queued', located })
      }
    }
  })

  it("a saved visit to a point that does not check the location is never 'not located': no position was asked for", async () => {
    const t = setup({ apiImpl: async () => { throw new ApiError(0, 'timeout') }, fix: { fix: null, reason: 'timeout' } })
    expect(await t.run({ gps_mode: 'none' })).toMatchObject({ kind: 'queued', located: true })
    expect(t.getFix).not.toHaveBeenCalled()
  })

  it('expired session: signs out and does not queue', async () => {
    const t = setup({ apiImpl: async () => { throw new ApiError(401, 'invalid_session') } })
    expect((await t.run()).kind).toBe('signedOut')
    expect(t.queue.list('prov-1')).toEqual([])
  })

  it('a refusal keeps its own code through to the result screen (regression: it was overwritten by the QR address)', async () => {
    const qrCode = 'https://building-qr-system.web.app/scan?code=BQR-abc123'
    for (const code of KNOWN_ERROR_CODES.filter((c) => c !== 'invalid_session')) {
      const t = setup({ apiImpl: async () => { throw new ApiError(403, code) } })
      const shown = withScanContext(await t.run(), { qrCode, point: { name: 'גימבורי' } })
      expect(shown).toMatchObject({ kind: 'error', code, qrCode, point: { name: 'גימבורי' } })
      // exactly what the screen does with it: a specific message and NO retry button
      expect(errorMessageKey(shown.code)).toBe(`error.${code}`)
      expect(isKnownError(shown.code)).toBe(true)
    }
  })

  it('an unexpected refusal shows the generic message with a retry button', () => {
    expect(errorMessageKey('conflict')).toBe('error.generic')
    expect(isKnownError('conflict')).toBe(false)
    // and the QR address is never mistaken for an error code
    expect(isKnownError('https://x.web.app/scan?code=BQR-1')).toBe(false)
  })

  it('permanent refusals surface the server code and do not queue', async () => {
    for (const code of ['point_inactive', 'not_assigned', 'unknown_code']) {
      const t = setup({ apiImpl: async () => { throw new ApiError(409, code) } })
      expect(await t.run()).toEqual({ kind: 'error', code })
      expect(t.queue.list('prov-1')).toEqual([])
    }
  })
})

describe('scan queue', () => {
  const item = (id, provider_id = 'prov-1') => ({ id, code: 'BQR-abc123', client_time: '2026-09-30T05:00:00Z', gps: null, provider_id })

  it('is idempotent per id and separated per provider', () => {
    const q = createQueue(memoryStorage())
    q.add(item('a')); q.add(item('a')); q.add(item('b', 'prov-2'))
    expect(q.list('prov-1').map((i) => i.id)).toEqual(['a'])
    expect(q.list('prov-2').map((i) => i.id)).toEqual(['b'])
  })

  it('survives corrupt storage', () => {
    const s = memoryStorage()
    s.setItem('qr.queue.v1', '{not json')
    expect(createQueue(s).list('prov-1')).toEqual([])
  })

  it('flush: removes accepted and permanently-refused items, keeps retryable ones', async () => {
    const q = createQueue(memoryStorage())
    ;['ok', 'gone', 'later'].forEach((id) => q.add(item(id)))
    const verdict = { ok: { ok: true }, gone: { ok: false, error: { code: 'unknown_code' } }, later: { ok: false, error: { code: 'server_error' } } }
    const apiFn = vi.fn(async (_p, { body }) => ({ results: body.scans.map((s) => ({ id: s.id, ...verdict[s.id] })) }))
    const r = await flushQueue({ queue: q, api: apiFn, token: 't', providerId: 'prov-1' })
    expect(r).toEqual({ sent: 1, rejected: 0, dropped: 1, remaining: 1 })
    expect(q.list('prov-1').map((i) => i.id)).toEqual(['later'])
    // round 1 made progress, round 2 (only 'later' left) made none and stopped: no endless retry loop
    expect(apiFn).toHaveBeenCalledTimes(2)
  })

  it('flush: cannot be tricked into looping by a server that echoes unknown ids', async () => {
    const q = createQueue(memoryStorage())
    q.add(item('a'))
    const apiFn = vi.fn(async () => ({ results: [{ id: 'not-ours', ok: true }] }))
    const r = await flushQueue({ queue: q, api: apiFn, token: 't', providerId: 'prov-1' })
    expect(r).toEqual({ sent: 0, rejected: 0, dropped: 0, remaining: 1 })
    expect(apiFn).toHaveBeenCalledTimes(1)
  })

  it('flush: uploads more than one batch (10 at a time, small enough to finish inside the timeout)', async () => {
    const q = createQueue(memoryStorage())
    for (let i = 0; i < 50; i++) q.add(item('i' + i))
    const apiFn = vi.fn(async (_p, { body }) => ({ results: body.scans.map((s) => ({ id: s.id, ok: true })) }))
    const r = await flushQueue({ queue: q, api: apiFn, token: 't', providerId: 'prov-1' })
    expect(r).toEqual({ sent: 50, rejected: 0, dropped: 0, remaining: 0 })
    expect(apiFn.mock.calls.map((c) => c[1].body.scans.length)).toEqual([10, 10, 10, 10, 10])
  })

  it("drops items the server can never store ('invalid_item') so they cannot clog the queue", async () => {
    const q = createQueue(memoryStorage())
    q.add(item('poison')); q.add(item('fine'))
    const apiFn = vi.fn(async (_p, { body }) => ({
      results: body.scans.map((s) => (s.id === 'poison' ? { id: s.id, ok: false, error: { code: 'invalid_item' } } : { id: s.id, ok: true })),
    }))
    expect(await flushQueue({ queue: q, api: apiFn, token: 't', providerId: 'prov-1' })).toEqual({ sent: 1, rejected: 0, dropped: 1, remaining: 0 })
  })

  it('flush: no signal keeps everything and does not throw; 401 throws so the app can sign out', async () => {
    const q = createQueue(memoryStorage())
    q.add(item('a'))
    const offline = await flushQueue({ queue: q, api: async () => { throw new ApiError(0, 'network') }, token: 't', providerId: 'prov-1' })
    expect(offline).toEqual({ sent: 0, rejected: 0, dropped: 0, remaining: 1 })
    await expect(flushQueue({ queue: q, api: async () => { throw new ApiError(401, 'invalid_session') }, token: 't', providerId: 'prov-1' })).rejects.toMatchObject({ status: 401 })
    expect(q.list('prov-1')).toHaveLength(1)
  })
})

describe('scan queue: what the person is told', () => {
  const item = (id) => ({ id, code: 'BQR-abc123', client_time: '2026-09-30T05:00:00Z', gps: null, provider_id: 'prov-1' })

  it('a visit the server stored but refused (e.g. far away) is reported as rejected, never as sent', async () => {
    const q = createQueue(memoryStorage())
    ;['good', 'far', 'nogps'].forEach((id) => q.add(item(id)))
    const outcome = { good: 'accepted', far: 'rejected_far', nogps: 'rejected_no_location' }
    const apiFn = vi.fn(async (_p, { body }) => ({ results: body.scans.map((s) => ({ id: s.id, ok: true, scan: { outcome: outcome[s.id] } })) }))
    const r = await flushQueue({ queue: q, api: apiFn, token: 't', providerId: 'prov-1' })
    expect(r).toEqual({ sent: 1, rejected: 2, dropped: 0, remaining: 0 })
  })

  it('scales the request timeout with the batch (the server handles items one by one)', async () => {
    const q = createQueue(memoryStorage())
    for (let i = 0; i < 4; i++) q.add(item('t' + i))
    const apiFn = vi.fn(async (_p, { body }) => ({ results: body.scans.map((s) => ({ id: s.id, ok: true, scan: { outcome: 'accepted' } })) }))
    await flushQueue({ queue: q, api: apiFn, token: 't', providerId: 'prov-1' })
    expect(apiFn.mock.calls[0][1].timeoutMs).toBe(8000 + 1500 * 4)
  })

  it('tells the caller when the phone could only hold the visit in memory', () => {
    const failing = { getItem: () => null, setItem: () => false, removeItem: () => {} }
    expect(createQueue(failing).add(item('a'))).toBe(false)
    expect(createQueue(memoryStorage()).add(item('a'))).toBe(true)
  })
})

describe('safeStorage (blocked / full localStorage)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads back what it could not persist, and reports that it did not persist', async () => {
    const { safeStorage } = await import('../src/worker/storage.js')
    const store = new Map([['k', 'old']])
    vi.stubGlobal('localStorage', {
      getItem: (k) => store.get(k) ?? null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
      removeItem: (k) => store.delete(k),
    })
    expect(safeStorage.setItem('k', 'new')).toBe(false)
    expect(safeStorage.getItem('k')).toBe('new') // the in-memory copy wins over the stale persisted one
    safeStorage.removeItem('k')
    expect(safeStorage.getItem('k')).toBeNull()
  })

  it('goes back to persistent storage when it works again', async () => {
    const { safeStorage } = await import('../src/worker/storage.js')
    const store = new Map()
    let broken = true
    vi.stubGlobal('localStorage', {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { if (broken) throw new Error('quota'); store.set(k, v) },
      removeItem: (k) => store.delete(k),
    })
    expect(safeStorage.setItem('q', 'v1')).toBe(false)
    broken = false
    expect(safeStorage.setItem('q', 'v2')).toBe(true)
    expect(store.get('q')).toBe('v2')
    expect(safeStorage.getItem('q')).toBe('v2')
    safeStorage.removeItem('q')
  })

  it('does not throw when reading is blocked too', async () => {
    const { safeStorage } = await import('../src/worker/storage.js')
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } })
    expect(safeStorage.getItem('never-set')).toBeNull()
    expect(safeStorage.setItem('x', '1')).toBe(false)
    expect(safeStorage.getItem('x')).toBe('1')
    safeStorage.removeItem('x')
  })
})

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals())
  const json = (status, body) => ({ ok: status < 400, status, statusText: 'x', json: async () => body })

  it('returns parsed JSON and sends token + JSON headers on writes', async () => {
    const f = vi.fn(async () => json(200, { ok: true }))
    vi.stubGlobal('fetch', f)
    await api('/scan', { method: 'POST', token: 'qrp_1', body: { a: 1 } })
    expect(f.mock.calls[0][0]).toBe('/api/scan')
    expect(f.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer qrp_1' })
    expect(f.mock.calls[0][1].body).toBe('{"a":1}')
  })

  it('bodiless DELETE still sends JSON content-type and a body (server CSRF rule)', async () => {
    const f = vi.fn(async () => json(200, { ok: true }))
    vi.stubGlobal('fetch', f)
    await api('/session', { method: 'DELETE', token: 't' })
    expect(f.mock.calls[0][1].headers['Content-Type']).toBe('application/json')
    expect(f.mock.calls[0][1].body).toBe('{}')
  })

  it('maps server errors to ApiError with code and status', async () => {
    vi.stubGlobal('fetch', async () => json(429, { error: { code: 'too_many_attempts', message: 'slow down' } }))
    await expect(api('/session', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 429, code: 'too_many_attempts', transient: false })
  })

  it('a hanging request times out instead of spinning forever', async () => {
    vi.stubGlobal('fetch', (_u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))))
    const err = await api('/scan', { method: 'POST', body: {}, timeoutMs: 30 }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 0, code: 'timeout', transient: true })
  })

  it('a body that stalls after the headers arrived still times out (one bar of signal)', async () => {
    vi.stubGlobal('fetch', (_u, { signal }) => Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    }))
    const err = await api('/scan', { method: 'POST', body: {}, timeoutMs: 30 }).catch((e) => e)
    expect(err).toMatchObject({ status: 0, code: 'timeout', transient: true })
  })

  it('a reply cut off mid-body counts as no answer, so the visit is kept to retry instead of "failed"', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new TypeError('network error') } }))
    const err = await api('/scan', { method: 'POST', body: {} }).catch((e) => e)
    expect(err).toMatchObject({ status: 0, transient: true })
  })

  it('network failure and non-JSON replies are distinguishable', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    await expect(api('/x')).rejects.toMatchObject({ status: 0, code: 'network', transient: true })
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('not json') } }))
    await expect(api('/x')).rejects.toMatchObject({ status: 0, code: 'bad_response', transient: true }) // not our server's answer: nothing was recorded
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new Error('html') } }))
    await expect(api('/x')).rejects.toMatchObject({ status: 502, code: 'bad_response', transient: true })
  })
})
