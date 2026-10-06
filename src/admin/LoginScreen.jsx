import { useEffect, useRef, useState } from 'react'
import { adminApi, errorText } from './api.js'
import { IconAlert, IconLock, IconShield } from './icons.jsx'
import ThemeSwitch, { HEBREW_THEME_LABELS } from '../ui/ThemeSwitch.jsx'
import { useBuildingName } from './buildingName.jsx'

const GIS_SRC = 'https://accounts.google.com/gsi/client'

/** Loads Google's sign-in script once and draws its button. The button hands back a signed ID token. */
function useGoogleButton(clientId, onCredential, container) {
  const cb = useRef(onCredential)
  cb.current = onCredential
  const [state, setState] = useState(clientId ? 'loading' : 'off')

  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    const draw = () => {
      if (cancelled || !window.google?.accounts?.id || !container.current) return
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (res) => cb.current(res.credential),
        auto_select: false,
        cancel_on_tap_outside: true,
      })
      container.current.innerHTML = ''
      window.google.accounts.id.renderButton(container.current, {
        // Google draws the button at a fixed pixel width: keep it inside narrow phones.
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'he',
        width: Math.max(200, Math.min(300, Math.floor(container.current.clientWidth || 300))),
      })
      setState('ready')
    }
    if (window.google?.accounts?.id) draw()
    else {
      let script = document.querySelector(`script[src="${GIS_SRC}"]`)
      if (!script) {
        script = document.createElement('script')
        script.src = GIS_SRC
        script.async = true
        document.head.appendChild(script)
      }
      script.addEventListener('load', draw)
      script.addEventListener('error', () => !cancelled && setState('blocked'))
    }
    return () => {
      cancelled = true
    }
  }, [clientId, container])

  return state
}

export default function LoginScreen({ config, onSignedIn }) {
  const { name: buildingName } = useBuildingName() // from the public route: '' until it answers, and for a building with no name
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [devEmail, setDevEmail] = useState('dev@example.test')
  const buttonBox = useRef(null)

  const signIn = async (path, body) => {
    setBusy(true)
    setError('')
    try {
      const res = await adminApi(path, { method: 'POST', body })
      onSignedIn(res.admin)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const google = useGoogleButton(config.google_client_id, (credential) => signIn('/google', { credential }), buttonBox)

  return (
    <main className="a-login">
      <div className="a-login__tools"><ThemeSwitch labels={HEBREW_THEME_LABELS} /></div>
      <div className="a-login__card">
        <span className="a-login__mark"><IconShield size={34} /></span>
        <h1 className="w-h1">ניהול נוכחות הבניין</h1>
        {/* the building's own name, typed by the committee in any language: no line at all when there is none */}
        {buildingName && <p className="a-login__building" dir="auto">{buildingName}</p>}
        <p className="w-lead">כניסה לוועד הבית בלבד. היכנסו עם חשבון Google שהוגדר ברשימת הוועד.</p>

        <div className="a-login__google">
          <div ref={buttonBox} aria-busy={google === 'loading'} />
          {google === 'loading' && <p className="w-small">טוען את הכניסה עם Google…</p>}
          {google === 'blocked' && (
            <p className="w-error"><IconAlert size={18} />לא הצלחנו לטעון את Google. בדקו את החיבור או חוסם פרסומות ורעננו.</p>
          )}
          {google === 'off' && (
            <div className="w-banner w-banner--warn" role="status">
              <IconAlert />
              <div className="w-banner__body">הכניסה עם Google עדיין לא הוגדרה בשרת (חסר <bdi>GOOGLE_CLIENT_ID</bdi>).</div>
            </div>
          )}
        </div>

        <div role="alert" aria-live="assertive">
          {error && <p className="w-error"><IconAlert size={18} />{error}</p>}
        </div>
        {busy && <p className="w-small" role="status">מתחבר…</p>}

        {config.dev_login && (
          <form className="a-login__dev" onSubmit={(e) => { e.preventDefault(); signIn('/dev-login', { email: devEmail }) }}>
            <p className="w-small">מצב פיתוח מקומי בלבד: כניסה בלי Google.</p>
            <input className="a-input" type="email" value={devEmail} onChange={(e) => setDevEmail(e.target.value)} aria-label="אימייל אדמין לפיתוח" dir="ltr" />
            <button className="w-btn w-btn--quiet w-btn--small" type="submit" disabled={busy}>כניסת פיתוח</button>
          </form>
        )}

        <a className="w-admin-link" href="/" style={{ marginBlockStart: 8 }}>
          <IconLock size={18} />חזרה לאפליקציית נותני השירות
        </a>
      </div>
    </main>
  )
}
