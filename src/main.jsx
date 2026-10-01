import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import '@fontsource-variable/rubik' // Hebrew, Arabic, Cyrillic and Latin, bundled: no external request, works offline
import App from './App.jsx'
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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
