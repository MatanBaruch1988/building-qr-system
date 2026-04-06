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
    <div className="admin-layout">

      {/* ── SIDEBAR (desktop only, hidden on mobile via CSS) ── */}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand">
          <h2>ממשק ניהול</h2>
        </div>
        <nav className="admin-sidebar-nav">
          <button
            className={`admin-sidebar-btn ${view === 'management' ? 'active' : ''}`}
            onClick={() => setView('management')}
          >
            <span className="sidebar-icon">⚙️</span>
            ניהול
          </button>
          <button
            className={`admin-sidebar-btn ${view === 'history' ? 'active' : ''}`}
            onClick={() => setView('history')}
          >
            <span className="sidebar-icon">📋</span>
            היסטוריה
          </button>
          <a href="/" className="admin-sidebar-btn" style={{ textDecoration: 'none' }}>
            <span className="sidebar-icon">👷</span>
            ממשק נותני שירות
          </a>
        </nav>
        <div className="admin-sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 4px 12px' }}>
            {user?.photoURL && (
              <img src={user.photoURL} alt="" style={{ width: '28px', height: '28px', borderRadius: '50%' }} />
            )}
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email}
            </span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout} style={{ width: '100%' }}>
            התנתק
          </button>
        </div>
      </aside>

      {/* ── CONTENT ── */}
      <main className="admin-content container">

        {/* Mobile-only header */}
        <header className="header admin-mobile-only" style={{ paddingBottom: '16px' }}>
          <h1>ממשק ניהול</h1>
        </header>

        {/* Mobile-only user info bar */}
        <div className="admin-mobile-only" style={{
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
              <img src={user.photoURL} alt="" style={{ width: '28px', height: '28px', borderRadius: '50%' }} />
            )}
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {user?.email}
            </span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout}>
            התנתק
          </button>
        </div>

        {/* Mobile-only nav */}
        <div className="admin-mobile-nav">
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
            <a href="/" className="nav-btn" style={{ textDecoration: 'none' }}>
              ממשק נותני שירות
            </a>
          </nav>
        </div>

        {view === 'management' && (
          <AdminPanel locations={locations} workers={workers} />
        )}

        {view === 'history' && (
          <ScansHistory workers={workers} />
        )}
      </main>
    </div>
  )
}

export default AdminApp
