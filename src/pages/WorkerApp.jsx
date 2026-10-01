import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { I18nProvider, useI18n } from '../i18n/index.jsx'
import { api } from '../api/client.js'
import { loadSession, saveSession, clearSession } from '../worker/session.js'
import { createQueue } from '../worker/scanQueue.js'
import { getFix } from '../worker/geo.js'
import { performCheckIn, withScanContext } from '../worker/checkIn.js'
import { uuid } from '../worker/uuid.js'
import { useProviders, usePoint, useTodayVisits, useQueueSync } from '../worker/hooks.js'
import { TopBar, LoginView, HomeView, WorkingView, ResultView } from '../worker/components.jsx'
import '../ui/ui.css'

export default function WorkerApp() {
  const [session, setSession] = useState(loadSession)
  return (
    <I18nProvider providerLang={session?.provider?.lang}>
      <WorkerShell session={session} setSession={setSession} />
    </I18nProvider>
  )
}

function LoginScreen({ pointName, notice, onSignedIn }) {
  const providers = useProviders()
  return <LoginView providers={providers} pointName={pointName} notice={notice} onSignedIn={onSignedIn} />
}

const vibrate = () => {
  try {
    navigator.vibrate?.(70)
  } catch {
    /* not supported */
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stripCodeFromUrl = () => window.history.replaceState(null, '', '/')

function WorkerShell({ session, setSession }) {
  const { t } = useI18n()
  const queue = useMemo(() => createQueue(), [])
  const deps = useMemo(() => ({ api, getFix, queue, newId: uuid, now: () => new Date() }), [queue])

  // The QR link is /scan?code=…. The code stays in the address bar (and in `code`) until the check-in has
  // produced an answer, so a refresh while signing in or while waiting does not lose it.
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('code'))
  const pointState = usePoint(code)
  const pointRef = useRef(null)
  pointRef.current = pointState.point

  const [view, setView] = useState('home') // home | working | result
  const [workingPhase, setWorkingPhase] = useState('locating')
  const [result, setResult] = useState(null)
  const [notice, setNotice] = useState(null)
  const [loginNotice, setLoginNotice] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const startedFor = useRef(null)

  const handleSignedOut = useCallback(() => {
    clearSession()
    setSession(null)
    setView('home')
    setResult(null)
    setNotice(null) // the next person must not inherit the previous person's messages
    startedFor.current = null // after signing in again the still-pending code is processed
    setLoginNotice(t('error.invalid_session'))
  }, [setSession, t])

  const sync = useQueueSync({
    session,
    queue,
    onSignedOut: handleSignedOut,
    onDone: (res) => {
      setRefreshKey((k) => k + 1)
      const unaccepted = res.rejected + res.dropped
      setNotice(unaccepted
        ? { tone: 'warn', text: t('sync.dropped', { count: unaccepted }) }
        : { tone: 'ok', text: t('sync.done') })
    },
  })

  // Good news fades; a warning stays until dismissed (it may be the only word that visits were refused).
  useEffect(() => {
    if (!notice || notice.tone !== 'ok') return
    const timer = setTimeout(() => setNotice(null), 9000)
    return () => clearTimeout(timer)
  }, [notice])

  // A stored session may have been revoked (provider deactivated, password reset): check quietly.
  useEffect(() => {
    if (!session) return
    const token = session.token
    api('/session', { token, timeoutMs: 8000 })
      .then((res) => setSession((s) => (s && s.token === token ? { ...s, provider: res.provider } : s)))
      .catch((err) => err.status === 401 && handleSignedOut())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // (A slow answer that arrives after "Switch person" and a new sign-in must not touch the new session:
  //  the token comparison above covers the 200 case; `switchWorker` clears the verify via the token check below.)

  const runCheckIn = useCallback(
    async (theCode, pointOverride) => {
      const point = pointOverride ?? pointRef.current
      setResult(null)
      setWorkingPhase('locating')
      setView('working')
      const r = await performCheckIn({ code: theCode, point, session, deps, onPhase: setWorkingPhase })
      if (r.kind === 'signedOut') return handleSignedOut()
      // There is an answer now: the code is spent. (Kept in the result for the retry button.) Clearing it here
      // also stops a later sign-out + sign-in from firing the same check-in a second time.
      stripCodeFromUrl()
      setCode(null)
      setResult(withScanContext(r, { qrCode: theCode, point }))
      setView('result')
      if (r.kind === 'success' || r.kind === 'duplicate') vibrate()
      if (r.kind === 'queued') sync.refresh()
      setRefreshKey((k) => k + 1)
    },
    [session, deps, handleSignedOut, sync],
  )

  // Signed in + a scanned code → check in straight away, once per code.
  useEffect(() => {
    if (!session || !code || pointState.status === 'loading' || startedFor.current === code) return
    // A cached "inactive" flag may be stale (the committee may have re-enabled the point): wait for the network.
    if (pointState.status === 'ready' && pointState.point?.is_active === false && !pointState.settled) return
    startedFor.current = code
    if (pointState.status === 'invalid') {
      stripCodeFromUrl()
      setCode(null)
      setResult({ kind: 'error', code: pointState.error })
      setView('result')
    } else if (pointState.point?.is_active === false) {
      stripCodeFromUrl()
      setCode(null)
      setResult({ kind: 'error', code: 'point_inactive' })
      setView('result')
    } else {
      runCheckIn(code)
    }
  }, [session, code, pointState, runCheckIn])

  // `refreshKey` alone drives refetching. (Adding sync.pending to it was a bug: React batches the two updates
  // after a sync and the sum can come out unchanged, so the list never refreshed.) The waiting rows are read
  // from the queue on every render, and this component re-renders whenever the sync state changes.
  const visits = useTodayVisits({ session, queue, refreshKey })

  const onSignedIn = (data, remember) => {
    saveSession(data, remember)
    setLoginNotice(null)
    setSession({ ...data, remember })
  }

  // Give the phone one last chance to upload this person's saved visits before they are signed out: on a shared
  // phone they may never come back to it.
  const switchWorker = async () => {
    if (session) {
      await Promise.race([sync.flush(), sleep(2500)])
      api('/session', { method: 'DELETE', token: session.token, timeoutMs: 5000 }).catch(() => {})
    }
    clearSession()
    setSession(null)
    setView('home')
    setResult(null)
    setNotice(null)
    setCode(null)
    startedFor.current = null
    stripCodeFromUrl()
  }

  const done = () => {
    setResult(null)
    setView('home')
  }

  // A scanned code is being looked up: show progress instead of the idle "scan a QR" screen.
  const resolving = session && code && pointState.status === 'loading' && view === 'home'

  return (
    <div className="w-app">
      <div className="w-shell">
        <TopBar />
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {!session ? (
            <LoginScreen pointName={pointState.point?.name} notice={loginNotice} onSignedIn={onSignedIn} />
          ) : view === 'working' ? (
            <WorkingView phase={workingPhase} />
          ) : resolving ? (
            <WorkingView phase="loading" />
          ) : view === 'result' && result ? (
            <ResultView
              result={result}
              pointName={result.point?.name}
              provider={session.provider}
              onDone={done}
              onRetry={() => runCheckIn(result.qrCode, result.point)}
            />
          ) : (
            <HomeView
              session={session}
              visits={visits}
              pending={sync.pending}
              syncing={sync.syncing}
              onSync={sync.flush}
              notice={notice}
              onDismissNotice={() => setNotice(null)}
              onSwitch={switchWorker}
            />
          )}
        </main>
      </div>
    </div>
  )
}
