import React, { useState, useEffect } from 'react'
import { isOnline, getPendingScansCount } from '../services/offlineStorage'
import { syncPendingScans } from '../services/syncService'

function QRScanner() {
  const [online, setOnline] = useState(isOnline())
  const [pendingCount, setPendingCount] = useState(getPendingScansCount())
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true)
      syncPendingScans().then(() => {
        setPendingCount(getPendingScansCount())
      })
    }
    const handleOffline = () => setOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  const handleManualSync = async () => {
    if (!isOnline()) {
      alert('אין חיבור לאינטרנט')
      return
    }
    setSyncing(true)
    await syncPendingScans()
    setPendingCount(getPendingScansCount())
    setSyncing(false)
  }

  return (
    <div className="card">
      <h2 style={{ textAlign: 'center', marginBottom: '20px' }}>סריקת קוד QR</h2>

      {/* Connection status */}
      <div style={{
        textAlign: 'center',
        marginBottom: '15px',
        padding: '8px',
        borderRadius: '8px',
        background: online ? 'rgba(52,199,89,0.12)' : 'rgba(255,149,0,0.12)',
        color: online ? 'var(--green)' : '#FF9500'
      }}>
        {online ? '🟢 מחובר לאינטרנט' : '🟡 אין חיבור - סריקות יישמרו מקומית'}
      </div>

      {/* Pending scans indicator */}
      {pendingCount > 0 && (
        <div style={{
          textAlign: 'center',
          marginBottom: '15px',
          padding: '10px',
          borderRadius: '8px',
          background: 'rgba(0,122,255,0.12)',
          color: '#007AFF'
        }}>
          <span>📤 {pendingCount} סריקות ממתינות לסנכרון</span>
          {online && (
            <button
              onClick={handleManualSync}
              disabled={syncing}
              style={{
                marginRight: '10px',
                padding: '4px 12px',
                borderRadius: '4px',
                border: 'none',
                background: '#007AFF',
                color: 'white',
                cursor: 'pointer'
              }}
            >
              {syncing ? 'מסנכרן...' : 'סנכרן עכשיו'}
            </button>
          )}
        </div>
      )}

      <div style={{ padding: '15px', background: 'var(--surface-2)', borderRadius: '8px' }}>
        <h4 style={{ marginBottom: '10px', color: 'var(--text-primary)' }}>הוראות:</h4>
        <ul style={{ paddingRight: '20px', lineHeight: '2', color: 'var(--text-secondary)' }}>
          <li>פתח את אפליקציית המצלמה במכשיר</li>
          <li>כוון את המצלמה לקוד ה-QR</li>
          <li>היכנס ללינק</li>
          <li>הסריקה תתבצע אוטומטית</li>
        </ul>

        <h4 style={{ margin: '14px 0 6px', color: 'var(--text-primary)' }}>שים לב:</h4>
        <ul style={{ paddingRight: '20px', lineHeight: '2', color: 'var(--text-secondary)' }}>
          <li>ודא שאתה נמצא ליד הנקודה המתאימה</li>
          <li>המערכת תבדוק את המיקום שלך אוטומטית</li>
          <li><strong style={{ color: 'var(--text-primary)' }}>גם ללא אינטרנט - הסריקה תישמר ותסונכרן אחר כך</strong></li>
        </ul>
      </div>
    </div>
  )
}

export default QRScanner
