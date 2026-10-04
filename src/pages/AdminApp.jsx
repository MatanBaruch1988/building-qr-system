import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import '../ui/ui.css'
import '../admin/admin.css'
import { adminApi } from '../admin/api.js'
import { ToastProvider, ConfirmProvider, Spinner, IconButton, useToast } from '../admin/ui.jsx'
import LoginScreen from '../admin/LoginScreen.jsx'
import PointsView from '../admin/views/PointsView.jsx'
import ProvidersView from '../admin/views/ProvidersView.jsx'
import HistoryView from '../admin/views/HistoryView.jsx'
import AgentView from '../admin/views/AgentView.jsx'
import CommitteeView from '../admin/views/CommitteeView.jsx'
import { applyUpdate, isUpdateReady, subscribeUpdate } from '../worker/update.js'
import ThemeSwitch, { HEBREW_THEME_LABELS as THEME_LABELS } from '../ui/ThemeSwitch.jsx'
import { IconPin, IconUsers, IconList, IconKey, IconShield, IconLogout, IconQr, IconDevice, IconAlert, IconRefresh } from '../admin/icons.jsx'

const TABS = [
  { key: 'points', label: 'נקודות', icon: IconPin, View: PointsView },
  { key: 'providers', label: 'נותני שירות', icon: IconUsers, View: ProvidersView },
  { key: 'history', label: 'היסטוריה', icon: IconList, View: HistoryView },
  { key: 'agent', label: 'אייג׳נט', icon: IconKey, View: AgentView },
  { key: 'committee', label: 'ועד', icon: IconShield, View: CommitteeView },
]

const tabFromHash = () => TABS.find((t) => t.key === window.location.hash.slice(1))?.key ?? 'points'

function useTab() {
  const [tab, setTab] = useState(tabFromHash)
  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return [tab, (key) => { window.location.hash = key }]
}

// Defined once, outside Shell: a component created inside a render would be a new type each time and every
// tab change would remount the buttons (losing keyboard focus).
function NavItem({ tab, current, onGo, className, size }) {
  return (
    <button className={className} onClick={() => onGo(tab.key)} aria-current={current ? 'page' : undefined}>
      <tab.icon size={size} />{tab.label}
    </button>
  )
}

// The same three icons on every screen size (the side rail on a computer, the top bar on a phone): the provider app,
// light / dark, and signing out. Only the place they sit changes with the width, never what they look like.
function ShellTools({ onSignOut }) {
  return (
    <div className="a-tools">
      <IconButton icon={IconDevice} label="אפליקציית נותני השירות" href="/" />
      <ThemeSwitch labels={THEME_LABELS} />
      <IconButton icon={IconLogout} label="יציאה" onClick={onSignOut} />
    </div>
  )
}

function Shell({ admin, onSignedOut }) {
  const toast = useToast()
  const [tab, goTo] = useTab()
  const { View, label } = TABS.find((t) => t.key === tab)
  const updateReady = useSyncExternalStore(subscribeUpdate, isUpdateReady)
  const mainRef = useRef(null)
  const first = useRef(true)

  // A tab change is a page change: title for the tab strip/history, scroll to the top, focus to the content.
  useEffect(() => {
    document.title = `${label} · נוכחות בבניין`
    if (first.current) return void (first.current = false)
    window.scrollTo(0, 0)
    mainRef.current?.focus({ preventScroll: true })
  }, [tab, label])

  // Only leave the screen once the server has really ended the session; otherwise a reload would sign the
  // person straight back in (a shared computer).
  const signOut = async () => {
    try {
      await adminApi('/logout', { method: 'POST' })
    } catch (err) {
      if (err.status !== 401) return toast.error('ההתנתקות לא הושלמה. בדקו את החיבור ונסו שוב.')
    }
    onSignedOut()
  }

  return (
    <>
      <aside className="a-side">
        <div className="a-brand"><span className="a-brand__mark"><IconQr size={22} /></span>נוכחות בבניין</div>
        <nav className="a-nav" aria-label="ניווט ראשי">
          {TABS.map((t) => <NavItem key={t.key} tab={t} current={tab === t.key} onGo={goTo} className="a-nav__item" size={24} />)}
        </nav>
        <div className="a-side__foot">
          <div className="a-user"><strong>{admin.name || 'חבר ועד'}</strong><span dir="ltr">{admin.email}</span></div>
          <ShellTools onSignOut={signOut} />
        </div>
      </aside>

      <header className="a-top">
        <div className="a-brand"><span className="a-brand__mark"><IconQr size={22} /></span>{label}</div>
        <ShellTools onSignOut={signOut} />
      </header>

      <main className="a-main" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }}>
        {updateReady && (
          <div className="w-banner" role="status" style={{ marginBlockEnd: 16 }}>
            <IconRefresh />
            <div className="w-banner__body">יש גרסה חדשה של המערכת.</div>
            <button className="w-btn w-btn--small w-btn--quiet" onClick={applyUpdate}>עדכון</button>
          </div>
        )}
        <View admin={admin} />
      </main>

      <nav className="a-tabbar" aria-label="ניווט ראשי (טלפון)">
        {TABS.map((t) => <NavItem key={t.key} tab={t} current={tab === t.key} onGo={goTo} className="a-tab" size={24} />)}
      </nav>
    </>
  )
}

export default function AdminApp() {
  const [boot, setBoot] = useState({ status: 'loading' })
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const [config, me] = await Promise.all([
        adminApi('/config'),
        adminApi('/me').catch((e) => (e.status === 401 ? null : Promise.reject(e))),
      ])
      setBoot({ status: 'ready', config, admin: me?.admin ?? null })
    } catch {
      setBoot({ status: 'error' })
    }
  }, [])
  useEffect(() => { load() }, [load])

  // Any call that finds the session gone sends the person back to the sign-in screen.
  useEffect(() => {
    const expired = () => {
      setNotice('פג תוקף ההתחברות. היכנסו שוב.')
      setBoot((b) => (b.status === 'ready' ? { ...b, admin: null } : b))
    }
    window.addEventListener('admin-session-expired', expired)
    return () => window.removeEventListener('admin-session-expired', expired)
  }, [])

  let content
  if (boot.status === 'loading') content = <Spinner />
  else if (boot.status === 'error') {
    content = (
      <div className="a-login"><div className="a-login__card">
        <span className="a-login__mark"><IconAlert size={34} /></span>
        <h1 className="w-h1">אין חיבור לשרת</h1>
        <button className="w-btn" onClick={() => { setBoot({ status: 'loading' }); load() }}>נסו שוב</button>
      </div></div>
    )
  } else if (!boot.admin) {
    content = (
      <>
        {notice && <div className="w-banner w-banner--warn" role="status" style={{ margin: '16px auto 0', maxWidth: 440 }}><IconAlert /><div className="w-banner__body">{notice}</div></div>}
        <LoginScreen config={boot.config} onSignedIn={(admin) => { setNotice(''); setBoot((b) => ({ ...b, admin })) }} />
      </>
    )
  } else content = <Shell admin={boot.admin} onSignedOut={() => { setNotice(''); setBoot((b) => ({ ...b, admin: null })) }} />

  return (
    <div className="a-app">
      <ToastProvider>
        <ConfirmProvider>{content}</ConfirmProvider>
      </ToastProvider>
    </div>
  )
}
