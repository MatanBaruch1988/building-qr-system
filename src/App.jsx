import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import WorkerApp from './pages/WorkerApp'
import AdminApp from './pages/AdminApp'
import AdminLogin from './components/AdminLogin'
import { useAdminAuth } from './hooks/useAdminAuth'

// Protected route component for admin
function ProtectedAdminRoute({ children }) {
  const { user, loading, error, login, isAuthenticated } = useAdminAuth()

  // Show loading spinner while checking auth
  if (loading) {
    return (
      <div className="container" style={{ textAlign: 'center', paddingTop: '100px' }}>
        <div className="spinner" style={{
          width: '48px',
          height: '48px',
          margin: '0 auto'
        }}></div>
        <p style={{ marginTop: '20px', color: 'var(--text-secondary)' }}>
          בודק הרשאות...
        </p>
      </div>
    )
  }

  // Show login if not authenticated
  if (!isAuthenticated) {
    return <AdminLogin onLogin={login} loading={loading} error={error} />
  }

  // Render admin content if authenticated — pass user/logout as props
  return React.cloneElement(children, { user, logout })
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<WorkerApp />} />
        <Route path="/scan" element={<WorkerApp />} />
        <Route
          path="/admin"
          element={
            <ProtectedAdminRoute>
              <AdminApp />
            </ProtectedAdminRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App
