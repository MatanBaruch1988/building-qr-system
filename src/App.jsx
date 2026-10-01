import React, { lazy, Suspense } from 'react'
import WorkerApp from './pages/WorkerApp'

// The committee app (map, QR tools) is only downloaded by people who open /admin.
const AdminApp = lazy(() => import('./pages/AdminApp'))

// Two full-page apps, no router needed: /admin is the committee, everything else (/, /scan?code=…) is
// the service-provider app. Links between them are ordinary page loads.
const isAdminPath = () => /^\/admin(\/|$)/.test(window.location.pathname)

export default function App() {
  return isAdminPath() ? (
    <Suspense fallback={null}>
      <AdminApp />
    </Suspense>
  ) : (
    <WorkerApp />
  )
}
