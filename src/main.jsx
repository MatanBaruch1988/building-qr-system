import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import '@fontsource-variable/heebo' // the one typeface (Hebrew + Latin), variable weight, bundled: no external request, works offline
import App from './App.jsx'
import ErrorBoundary from './ui/ErrorBoundary.jsx'
import { crashRootOptions } from './ui/crash.js'
import { setUpdater, markUpdateReady } from './worker/update.js'
import './ui/base.css'
import { initTheme } from './ui/theme.js'

initTheme() // light / dark: the person's choice, else the device's setting

// Offline support. A new version is downloaded in the background and announced in the UI (HomeView and the
// committee shell show an "update" button); it is applied only when the person taps it, never mid check-in.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: markUpdateReady,
  onRegisteredSW(_url, registration) {
    if (!registration) return
    const check = () => registration.update().catch(() => {})
    setInterval(check, 60 * 60 * 1000)
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check())
  },
})
setUpdater(updateSW)

// The boundary is the outermost component, so it catches a crash in either app, in a screen that failed to download, and in
// the language provider itself. crashRootOptions makes the console line for a crash carry the error's name and nothing else.
ReactDOM.createRoot(document.getElementById('root'), crashRootOptions).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
