import React, { useState, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useLocations, usePublicWorkerList } from '../hooks/useFirebaseData'
import { useWorkerAuth } from '../hooks/useWorkerAuth'
import { processQRScan } from '../services/scanProcessor'
import WorkerLogin from '../components/WorkerLogin'
import QRScanner from '../components/QRScanner'
import ScanResult from '../components/ScanResult'
import ScansHistory from '../components/ScansHistory'
import { getDisplayWorkerName } from '../utils/formatters'

function WorkerApp() {
  const [view, setView] = useState('login') // 'login' | 'scanner' | 'result' | 'processing' | 'history'
  const [scanResult, setScanResult] = useState(null)
  const [processingMessage, setProcessingMessage] = useState('')
  const isProcessingRef = useRef(false)
  const pendingResultRef = useRef(null)

  const locations = useLocations()
  const { workers, loading: workersLoading } = usePublicWorkerList()
  const { worker, login, logout, isLoggedIn } = useWorkerAuth()

  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const qrCodeFromUrl = searchParams.get('code')

  // עדכון view כשעובד מתחבר
  useEffect(() => {
    if (isLoggedIn && view === 'login') {
      setView('scanner')
    }
  }, [isLoggedIn, view])

  // Polling to check for pending results (iOS fix)
  // Always runs, doesn't depend on view state
  useEffect(() => {
    const checkPendingResult = () => {
      if (pendingResultRef.current) {
        const result = pendingResultRef.current
        pendingResultRef.current = null
        isProcessingRef.current = false
        setScanResult(result)
        setView('result')
      }
    }

    const interval = setInterval(checkPendingResult, 500)
    return () => clearInterval(interval)
  }, []) // No dependencies - always running

  // כשיש קוד ב-URL ויש עובד מחובר - עבד אוטומטית
  useEffect(() => {
    if (qrCodeFromUrl && worker && locations.length > 0 && !isProcessingRef.current) {
      processCode(qrCodeFromUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrCodeFromUrl, worker, locations.length])

  const processCode = (code) => {
    // מניעת עיבוד כפול
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    pendingResultRef.current = null

    // נקה את הקוד מה-URL מיד כדי למנוע עיבוד חוזר
    if (qrCodeFromUrl) {
      navigate('/', { replace: true })
    }

    setView('processing')
    setProcessingMessage('מעבד קוד QR...')

    processQRScan(code, locations, worker, (msg) => {
      setProcessingMessage(msg)
    })
      .then((result) => {
        // Store result for polling to pick up
        pendingResultRef.current = result
      })
      .catch((err) => {
        console.error('Error processing QR:', err)
        pendingResultRef.current = {
          success: false,
          error: err.message || 'שגיאה לא ידועה',
          details: `קוד: ${code}`
        }
      })
  }

  const handleWorkerLogin = async (workerId, pin) => {
    const workerInfo = await login(workerId, pin)
    // If there's a QR code in the URL, process it
    if (qrCodeFromUrl && locations.length > 0) {
      processCode(qrCodeFromUrl)
    } else {
      setView('scanner')
    }
  }

  const handleBackToScanner = () => {
    setScanResult(null)
    setView('scanner')
    if (qrCodeFromUrl) {
      navigate('/', { replace: true })
    }
  }

  const handleLogout = () => {
    logout()
    setScanResult(null)
    setView('login')
    if (qrCodeFromUrl) {
      navigate('/', { replace: true })
    }
  }

  const workerDisplayName = worker ? getDisplayWorkerName(worker) : ''

  return (
    <div className="container">
      <header className="header">
        <h1>מערכת אימות נוכחות</h1>
        {!worker && <p>סריקת QR עם אימות GPS</p>}
      </header>

      {worker && (view === 'scanner' || view === 'result' || view === 'processing' || view === 'history') && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '10px 16px',
          marginBottom: '16px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: 'var(--green)',
              boxShadow: '0 0 6px rgba(52,199,89,0.5)'
            }} />
            <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              מחובר כ: <strong style={{ color: 'var(--text-primary)' }}>{workerDisplayName}</strong>
            </span>
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleLogout}
          >
            התנתק
          </button>
        </div>
      )}

      {/* הודעה כשיש קוד ב-URL אבל אין עובד מחובר */}
      {qrCodeFromUrl && !worker && view === 'login' && (
        <div className="card" style={{
          textAlign: 'center',
          padding: '20px',
          background: 'linear-gradient(135deg, #007AFF 0%, #AF52DE 100%)',
          color: 'white'
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '10px' }}>📱</div>
          <p style={{ margin: 0, fontSize: '1.1rem' }}>
            נמצא קוד QR! בחר נותן שירות כדי להמשיך
          </p>
        </div>
      )}

      {view === 'login' && (
        <WorkerLogin
          workers={workers}
          onLogin={handleWorkerLogin}
        />
      )}

      {view === 'processing' && (
        <div className="card" style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div className="spinner" style={{
            width: '48px',
            height: '48px',
            borderWidth: '3px',
            margin: '0 auto 20px'
          }}></div>
          <p style={{ fontSize: '1.1rem', color: 'var(--text-secondary)' }}>
            {processingMessage}
          </p>
        </div>
      )}

      {view === 'scanner' && worker && (
        <>
          <QRScanner />
          <button
            className="btn btn-secondary"
            style={{ width: '100%', marginTop: '15px', padding: '14px' }}
            onClick={() => setView('history')}
          >
            היסטוריית סריקות
          </button>
        </>
      )}

      {view === 'history' && worker && (
        <>
          <button
            className="btn btn-secondary"
            style={{ width: '100%', marginBottom: '15px', padding: '14px' }}
            onClick={() => setView('scanner')}
          >
            ← חזרה
          </button>
          <ScansHistory
            readOnly={true}
            workerIdFilter={workerDisplayName === 'Test' ? '' : worker.id}
            workers={workers}
            showWorkerFilter={workerDisplayName === 'Test'}
          />
        </>
      )}

      {view === 'result' && scanResult && (
        <ScanResult
          result={scanResult}
          onBack={handleBackToScanner}
        />
      )}

      {/* Admin link at bottom - hide on login screen to save space */}
      {view !== 'login' && (
        <div style={{ textAlign: 'center', marginTop: '30px', paddingBottom: '10px' }}>
          <a href="/admin" className="admin-link">
            גישה לניהול
          </a>
        </div>
      )}
    </div>
  )
}

export default WorkerApp
