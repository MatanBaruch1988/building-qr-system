import { useCallback, useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { APP_COMMITTEE } from '../appKind.js'
import { createErrorReporter } from '../ui/errorReport.js'
import { loadCacheEpoch, readLoadCache, writeLoadCache } from './loadCache.js'

// The in-memory cache of the last answers lives in loadCache.js; AdminApp empties it when the committee member changes.
export { clearLoadCache, setLoadCache, LOAD_KEY } from './loadCache.js'

/** The state of a load that has not answered yet: loading, or ready with the answer that was kept for `cacheKey` the last time. */
function startState(cacheKey) {
  const kept = cacheKey === undefined ? undefined : readLoadCache(cacheKey)
  return kept === undefined
    ? { cacheKey, status: 'loading', data: null, error: null }
    : { cacheKey, status: 'ready', data: kept, error: null }
}

/**
 * Loads data once, then on demand. Keeps the previous data on screen while reloading.
 *
 * With `cacheKey` the last good answer is kept in memory for the life of the page (src/admin/loadCache.js): a screen that opens again
 * starts with it (`status: 'ready'`, no loading state), asks the server again at once, and takes the new answer when it comes. If that
 * request fails the old data stays on screen and the state says `error`, as it does for a reload. `reload()` stores its answer too. A
 * key that changes while the screen is open is another list: the old key's data is never shown under it. Without a key nothing is kept.
 * @param {() => Promise<any>} fn
 * @param {any[]} [deps]  the load runs again when these change
 * @param {{ cacheKey?: string }} [options]
 */
export function useLoad(fn, deps = [], { cacheKey } = {}) {
  const [state, setState] = useState(() => startState(cacheKey))
  if (state.cacheKey !== cacheKey) setState(startState(cacheKey)) // the key changed: this is another list
  const fnRef = useRef(fn)
  fnRef.current = fn
  const keyRef = useRef(cacheKey)
  keyRef.current = cacheKey
  const load = useCallback(async () => {
    const key = keyRef.current
    const asked = loadCacheEpoch()
    try {
      const data = await fnRef.current()
      if (key !== undefined) writeLoadCache(key, data, asked) // also when the screen has gone: the next one draws it
      setState((s) => (s.cacheKey === key ? { cacheKey: key, status: 'ready', data, error: null } : s))
    } catch (error) {
      setState((s) => (s.cacheKey === key ? { cacheKey: key, status: 'error', data: s.data, error } : s))
    }
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's `deps` (and the key) decide when to load again; `load` never changes
  useEffect(() => { load() }, [cacheKey, ...deps])
  return { status: state.status, data: state.data, error: state.error, reload: load }
}

export const SERVICE_TYPES = [
  { value: 'cleaning', label: 'ניקיון' },
  { value: 'gardening', label: 'גינון' },
  { value: 'maintenance', label: 'תחזוקה' },
  { value: 'other', label: 'אחר' },
]
export const serviceLabel = (value) => SERVICE_TYPES.find((s) => s.value === value)?.label ?? value ?? ''

// Every date and time on the committee screens is written by the shared module: DD/MM/YYYY and HH:MM.
export { formatDateTime } from '../../shared/datetime.js'

/**
 * Tells the server what went wrong in the committee app (src/ui/errorReport.js, ADR 0007 decision 3): a screen that crashed, an error
 * that nothing caught, a sign-out that the server forced. They are noted in the browser where they happen and wait there; this sends them
 * to POST /api/admin/client-errors, through `adminApi` and with the session's cookie, which is why a crash before sign-in waits for the
 * next one. It sends when somebody is signed in (at app start, once `/me` has confirmed the session, and after a sign-in) and when the
 * page comes back to the foreground. The reporter decides by itself whether to send (at most once a minute, never offline, never with
 * nothing noted, and not at all for the rest of the run after a 404). Nothing on the screen changes and nothing reaches the console.
 *
 * There is no sign-out of its own here: a 401 is `adminApi`'s to announce (the `admin-session-expired` event), and AdminApp answers it
 * with the sign-in screen, as it does for every other call.
 * @param {boolean} signedIn  a committee member is signed in now (as of the last render)
 * @param {() => boolean} [signedInNow]  whether one is signed in this very moment, for an app that learns of a forced sign-out before it has
 *   drawn it: nothing is sent for a session that has just ended, though `signedIn` stays true until the next render. Without it `signedIn`
 *   is trusted
 */
export function useErrorReport(signedIn, signedInNow) {
  const now = useRef({ signedIn, signedInNow })
  now.current = { signedIn, signedInNow }
  const [reporter] = useState(() =>
    createErrorReporter({
      app: APP_COMMITTEE,
      getSession: () => (now.current.signedInNow ? now.current.signedInNow() : now.current.signedIn),
      send: (body) => adminApi('/client-errors', { method: 'POST', body, timeoutMs: 8000 }),
      onUnauthorized: () => {}, // adminApi has announced it already (see above)
    }),
  )

  useEffect(() => {
    if (signedIn) reporter.report()
  }, [signedIn, reporter])

  useEffect(() => {
    if (!signedIn) return
    const onVisible = () => document.visibilityState === 'visible' && reporter.report()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [signedIn, reporter])
}
