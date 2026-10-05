import { useCallback, useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { APP_COMMITTEE } from '../appKind.js'
import { createErrorReporter } from '../ui/errorReport.js'

/** Loads data once, then on demand. Keeps the previous data on screen while reloading. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null })
  const fnRef = useRef(fn)
  fnRef.current = fn
  const load = useCallback(async () => {
    try {
      const data = await fnRef.current()
      setState({ status: 'ready', data, error: null })
    } catch (error) {
      setState((s) => ({ status: 'error', data: s.data, error }))
    }
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's `deps` decide when to load again; `load` never changes
  useEffect(() => { load() }, deps)
  return { ...state, reload: load }
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
