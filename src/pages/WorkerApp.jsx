import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { I18nProvider, useI18n } from '../i18n/index.jsx'
import { api } from '../api/client.js'
import { loadSession, saveSession, clearSession, isProvider } from '../worker/session.js'
import { createQueue } from '../worker/scanQueue.js'
import { getFix, forgetLastFix } from '../worker/geo.js'
import { performCheckIn, withScanContext } from '../worker/checkIn.js'
import { uuid } from '../worker/uuid.js'
import { SCAN_ERROR_POINT_INACTIVE } from '../../shared/contract.js'
import { useProviders, useBuilding, usePoint, useTodayVisits, useQueueSync, useDeviceStatus, useErrorReport } from '../worker/hooks.js'
import { noteClientError, setPlace, currentPlace } from '../ui/errorReport.js'
import { TopBar, LoginView, HomeView, WorkingView, ResultView } from '../worker/components.jsx'
import '../ui/ui.css'

/** @import { PublicPoint } from '../../shared/types.js' */

export default function WorkerApp() {
  const [session, setSession] = useState(loadSession)
  // Asked here, above the language provider, because the building's name is part of the title of the window, which the provider
  // writes (in the person's language); the header takes its two lines from the same answer. Asked once, when the app starts.
  const building = useBuilding()
  return (
    <I18nProvider buildingName={building.name}>
      <WorkerShell session={session} setSession={setSession} building={building} />
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

function WorkerShell({ session, setSession, building }) {
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

  // Which screen is drawn. It is decided here once, before anything below that can fail (a hook that reads the server's answer
  // breaks a render), and told to src/ui/errorReport.js so that a crash is put on the right screen (`provider:home`, ...). A scanned
  // code that is being looked up shows the working screen with its "loading" step, so it is the same screen.
  const resolving = session && code && pointState.status === 'loading' && view === 'home'
  const screen = !session ? 'login' : view === 'working' || resolving ? 'working' : view === 'result' && result ? 'result' : 'home'
  setPlace(`provider:${screen}`)

  // A session that the server ended (a 401 on a call made with the stored or the new session) comes here, whichever call met it,
  // with the code that the server answered. This is where it is noted for the report (src/ui/errorReport.js): a sign-out that the
  // person chose is `switchWorker`, which is not. Calls that find the session gone together note it once.
  const signedIn = useRef(session)
  signedIn.current = session
  const handleSignedOut = useCallback((code = 'invalid_session') => {
    if (signedIn.current) {
      signedIn.current = null
      noteClientError({ kind: 'signed_out', place: currentPlace(), code })
    }
    clearSession()
    forgetLastFix() // and the next person must not send the previous person's last position either (src/worker/geo.js)
    setSession(null)
    setView('home')
    setResult(null)
    setNotice(null) // the next person must not inherit the previous person's messages
    startedFor.current = null // after signing in again the still-pending code is processed
    setLoginNotice(t('error.invalid_session'))
  }, [setSession, t])

  // The phone tells the server how it is doing (what waits in its queue and since when, its build). The token that the server
  // has confirmed (the session check below at app start, or a sign-in just now) is what starts the first report. There is
  // nothing to see on the screen.
  const [confirmedToken, setConfirmedToken] = useState(null)
  const reportStatus = useDeviceStatus({ session, queue, confirmedToken, onSignedOut: handleSignedOut })
  // What went wrong on the phone (a crash, an error that nothing caught, a forced sign-out) goes to the server at the same moments.
  useErrorReport({ session, confirmedToken, onSignedOut: handleSignedOut, liveSession: () => signedIn.current })

  const sync = useQueueSync({
    session,
    queue,
    onSignedOut: handleSignedOut,
    onFlushed: reportStatus,
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
  // The answer refreshes the person's details, but only when it has usable ones. A 200 without them (an old or broken
  // server) is no reason to sign out (the token was accepted) and must not replace what the screens draw from.
  useEffect(() => {
    if (!session) return
    const token = session.token
    api('/session', { token, timeoutMs: 8000 })
      .then((res) => {
        setConfirmedToken(token) // the server accepted the token, with usable details or not
        if (!isProvider(res?.provider)) return
        setSession((s) => (s && s.token === token ? { ...s, provider: res.provider } : s))
      })
      .catch((err) => err.status === 401 && handleSignedOut(err.code))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check the stored session once, at app start: a later `session` is a new sign-in, and `handleSignedOut` changes with the language
  }, [])
  // (A slow answer that arrives after "Switch person" and a new sign-in must not touch the new session:
  //  the token comparison above covers the 200 case; `switchWorker` clears the verify via the token check below.)

  const runCheckIn = useCallback(
    /**
     * @param {string} theCode  the scanned QR address
     * @param {PublicPoint | null} [pointOverride]  the point to check in at, instead of the one that was looked up
     */
    async (theCode, pointOverride) => {
      const point = pointOverride ?? pointRef.current
      setResult(null)
      setWorkingPhase('locating')
      setView('working')
      const r = await performCheckIn({ code: theCode, point, session, deps, onPhase: setWorkingPhase })
      if (r.kind === 'signedOut') return handleSignedOut(r.code)
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
      setResult({ kind: 'error', code: SCAN_ERROR_POINT_INACTIVE })
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
    forgetLastFix() // a position kept before this person signed in (the last person left without signing out) is not theirs
    setLoginNotice(null)
    setConfirmedToken(data.token) // the server has just issued it
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
    forgetLastFix() // on a shared phone the next person must not send the previous one's last position
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

  return (
    <div className="w-app">
      <div className="w-shell">
        <TopBar name={building.name} address={building.address} />
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {screen === 'login' ? (
            <LoginScreen pointName={pointState.point?.name} notice={loginNotice} onSignedIn={onSignedIn} />
          ) : screen === 'working' ? (
            // a scanned code that is being looked up shows progress instead of the idle "scan a QR" screen
            <WorkingView phase={view === 'working' ? workingPhase : 'loading'} />
          ) : screen === 'result' ? (
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
