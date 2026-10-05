import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { parseQrToken } from '../../shared/qrToken.js' // one definition of "what is one of our QR codes", shared with the server
import { SCAN_ERROR_INVALID_CODE, SCAN_ERROR_UNKNOWN_CODE } from '../../shared/contract.js'
import { safeStorage, readJson } from './storage.js'
import { getCachedPoint, setCachedPoint, dropCachedPoint } from './pointCache.js'
import { getCachedAddress, setCachedAddress } from './buildingCache.js'
import { flushQueue } from './scanQueue.js'
import { createDeviceReporter } from './deviceStatus.js'
import { isoDay } from '../../shared/datetime.js'

/** Provider names for the login tiles. Shows the last list instantly and refreshes in the background. */
export function useProviders() {
  const KEY = 'qr.providers.v1'
  const [state, setState] = useState(() => {
    const cached = readJson(safeStorage, KEY, null)
    return cached ? { status: 'ready', providers: cached } : { status: 'loading', providers: [] }
  })
  const load = useCallback(() => {
    setState((s) => (s.providers.length ? s : { status: 'loading', providers: [] }))
    api('/public/providers', { timeoutMs: 8000 })
      .then((res) => {
        safeStorage.setItem(KEY, JSON.stringify(res.providers))
        setState({ status: 'ready', providers: res.providers })
      })
      .catch(() => setState((s) => (s.providers.length ? s : { status: 'error', providers: [] })))
  }, [])
  useEffect(load, [load])
  return { ...state, reload: load }
}

/**
 * The building's address for the header. The last one the phone saw is shown at once (and with no signal), then the
 * network answer replaces it, an empty one included. A failed request changes nothing. Asked once, when the app starts.
 */
export function useBuildingAddress() {
  const [address, setAddress] = useState(() => getCachedAddress())
  useEffect(() => {
    let cancelled = false
    api('/public/building', { timeoutMs: 8000 })
      .then((res) => {
        const next = res?.building?.address
        if (typeof next !== 'string') return // not an answer of ours: keep what the phone knows
        setCachedAddress(next)
        if (!cancelled) setAddress(next)
      })
      .catch(() => {}) // no signal or a server hiccup: keep the saved one
    return () => {
      cancelled = true
    }
  }, [])
  return address
}

/**
 * Looks up which point a scanned code belongs to. status: none | loading | ready | invalid.
 * `settled` is true once the network answered (or failed): until then a cached copy may be stale, so
 * callers must not act on a cached "inactive" flag. Offline with no cached copy still ends in `ready`
 * (point = null): the server decides later.
 */
export function usePoint(code) {
  const [state, setState] = useState({ status: code ? 'loading' : 'none', point: null, error: null, settled: !code })
  useEffect(() => {
    if (!code) return setState({ status: 'none', point: null, error: null, settled: true })
    const token = parseQrToken(code)
    if (!token) return setState({ status: 'invalid', point: null, error: SCAN_ERROR_INVALID_CODE, settled: true })

    const cached = getCachedPoint(token)
    setState(cached
      ? { status: 'ready', point: cached, error: null, settled: false }
      : { status: 'loading', point: null, error: null, settled: false })
    let cancelled = false
    api(`/public/points/resolve?code=${encodeURIComponent(token)}`, { timeoutMs: 6000 })
      .then((res) => {
        if (cancelled) return
        setCachedPoint(token, res.point)
        setState({ status: 'ready', point: res.point, error: null, settled: true })
      })
      .catch((err) => {
        if (cancelled) return
        if (err.status === 404) {
          dropCachedPoint(token)
          setState({ status: 'invalid', point: null, error: SCAN_ERROR_UNKNOWN_CODE, settled: true })
        } else if (cached) {
          setState((s) => ({ ...s, settled: true }))
        } else {
          setState({ status: 'ready', point: null, error: null, settled: true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [code])
  return state
}

const israelToday = () => isoDay()

/**
 * Today's visits: confirmed ones from the server plus check-ins still waiting on the phone.
 * The server copy is tagged with the provider it belongs to, so on a shared phone the next person
 * never sees the previous person's visits (not even for a moment, not even while offline).
 */
export function useTodayVisits({ session, queue, refreshKey }) {
  const [confirmed, setConfirmed] = useState({ pid: null, scans: [] })
  const pid = session?.provider.id
  useEffect(() => {
    if (!session) return
    let cancelled = false
    api('/my/scans', { token: session.token, timeoutMs: 8000 })
      .then((res) => !cancelled && setConfirmed({ pid: session.provider.id, scans: res.scans }))
      .catch(() => {}) // keep whatever we showed before
    return () => {
      cancelled = true
    }
  }, [session, refreshKey])

  const today = israelToday()
  const mine = confirmed.pid === pid ? confirmed.scans : []
  const known = new Set(mine.map((s) => s.id))
  const rows = [
    ...mine.filter((s) => s.local_date === today).map((s) => ({ id: s.id, time: s.checked_in_at, point: s.point_name, pending: false })),
    ...(session ? queue.list(session.provider.id) : [])
      .filter((q) => !known.has(q.id))
      .map((q) => ({ id: q.id, time: q.client_time, point: q.point_name ?? '', pending: true })),
  ]
  return rows.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
}

/**
 * Sends saved check-ins whenever it can: on load, when the network returns, when the app comes back
 * to the foreground, and every 30 s while something is waiting.
 * A result only counts if the same person is still signed in when it arrives.
 * `onFlushed` is told when an upload has ended (whatever came of it, except a sign-out): the phone reports its status then.
 */
export function useQueueSync({ session, queue, onSignedOut, onDone, onFlushed }) {
  const [pending, setPending] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const busy = useRef(false)
  const cb = useRef({ onSignedOut, onDone, onFlushed })
  cb.current = { onSignedOut, onDone, onFlushed }
  const current = useRef(session)
  current.current = session

  const refresh = useCallback(() => setPending(session ? queue.list(session.provider.id).length : 0), [session, queue])

  const flush = useCallback(async () => {
    if (!session || busy.current || !queue.list(session.provider.id).length) return refresh()
    const token = session.token
    const stillSame = () => current.current?.token === token
    busy.current = true
    setSyncing(true)
    let signedOut = false
    try {
      const res = await flushQueue({ queue, api, token, providerId: session.provider.id })
      if (stillSame() && (res.sent || res.rejected || res.dropped)) cb.current.onDone(res)
    } catch (err) {
      if (err.status === 401 && stillSame()) {
        signedOut = true
        cb.current.onSignedOut()
      }
    } finally {
      busy.current = false
      setSyncing(false)
      refresh()
    }
    if (!signedOut) cb.current.onFlushed?.()
  }, [session, queue, refresh])

  useEffect(() => {
    refresh()
    if (!session) return
    flush()
    const onVisible = () => document.visibilityState === 'visible' && flush()
    window.addEventListener('online', flush)
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(flush, 30_000)
    return () => {
      window.removeEventListener('online', flush)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [session, flush, refresh])

  return { pending, syncing, flush, refresh }
}

/**
 * Tells the server how the phone is doing (src/worker/deviceStatus.js, ADR 0007 "Phone health"): what waits in the queue and
 * since when, the build, the totals. Best effort, and nothing on the screen changes. It reports:
 *  - once when the app has started and the server has confirmed the stored session (`confirmedToken` is that session's token),
 *    or when somebody has just signed in (the app passes the new token the same way);
 *  - when the app comes back to the foreground;
 *  - when the function that it returns is called: the queue sync does that when an upload has ended.
 * The reporter decides by itself whether to send (a changed queue at once, an unchanged one every 10 minutes, never
 * offline, never for nobody), so calling it often is fine. A 401 signs the person out the way the other calls of the app do.
 * @param {object} args
 * @param {import('./session.js').Session | null} args.session
 * @param {import('./scanQueue.js').Queue} args.queue
 * @param {string | null} args.confirmedToken
 * @param {() => void} args.onSignedOut
 * @returns {() => Promise<unknown>}  asks for a report
 */
export function useDeviceStatus({ session, queue, confirmedToken, onSignedOut }) {
  const current = useRef(session)
  current.current = session
  const signOut = useRef(onSignedOut)
  signOut.current = onSignedOut
  // One reporter for the life of the app: its throttle and its "this server has no such endpoint" are per run.
  const [reporter] = useState(() =>
    createDeviceReporter({
      queue,
      api,
      getSession: () => (current.current ? { token: current.current.token, providerId: current.current.provider.id } : null),
      onUnauthorized: (token) => current.current?.token === token && signOut.current(),
    }),
  )
  const token = session?.token

  useEffect(() => () => reporter.stop(), [reporter])

  useEffect(() => {
    if (token && token === confirmedToken) reporter.report()
  }, [token, confirmedToken, reporter])

  useEffect(() => {
    if (!token) return
    const onVisible = () => document.visibilityState === 'visible' && reporter.report()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [token, reporter])

  return reporter.report
}
