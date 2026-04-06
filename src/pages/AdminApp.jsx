import React, { useState } from 'react'
import { useLocations, useWorkers } from '../hooks/useFirebaseData'
import AdminPanel from '../components/AdminPanel'
import ScansHistory from '../components/ScansHistory'

function AdminApp({ user, logout }) {
  const [view, setView] = useState('management') // 'management' | 'history'
  const locations = useLocations()
  const workers = useWorkers()

  const handleLogout = async () => {
    if (window.confirm('האם להתנתק מהמערכת?')) {
      await logout()
    }
  }

  return (
    <div className="container">
      <header className="header" style={{ paddingBottom: '16px' }}>
        <h1>ממשק ניהול</h1>
      </header>

      {/* Logged-in user info and logout */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: '10px 16px',
        marginBottom: '20px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {user?.photoURL && (
            <img
              src={user.photoURL}
              alt=""
              style={{ width: '28px', height: '28px', borderRadius: '50%' }}
            />
          )}
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            {user?.email}
          </span>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={handleLogout}
        >
          התנתק
        </button>
      </div>

      <nav className="nav">
        <button
          className={`nav-btn ${view === 'management' ? 'active' : ''}`}
          onClick={() => setView('management')}
        >
          ניהול
        </button>
        <button
          className={`nav-btn ${view === 'history' ? 'active' : ''}`}
          onClick={() => setView('history')}
        >
          היסטוריה
        </button>
        <a
          href="/"
          className="nav-btn"
          style={{ textDecoration: 'none' }}
        >
          ממשק נותני שירות
        </a>
      </nav>

      {view === 'management' && (
        <AdminPanel
          locations={locations}
          workers={workers}
        />
      )}

      {view === 'history' && (
        <ScansHistory workers={workers} />
      )}
    </div>
  )
}

export default AdminApp
