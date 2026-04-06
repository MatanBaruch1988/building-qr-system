import React, { useState, useRef } from 'react'
import { getDisplayWorkerName, getWorkerInitials } from '../utils/formatters'

const PIN_MIN_LENGTH = 4
const PIN_MAX_LENGTH = 10

function WorkerLogin({ workers, onLogin }) {
  const [selectedWorker, setSelectedWorker] = useState(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef(null)

  const handleWorkerSelect = (worker) => {
    setSelectedWorker(worker)
    setPin('')
    setError('')
  }

  const handlePinChange = (e) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, PIN_MAX_LENGTH)
    setPin(val)
    setError('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!selectedWorker || pin.length < PIN_MIN_LENGTH) return
    setSubmitting(true)
    try {
      await onLogin(selectedWorker.id, pin)
    } catch (err) {
      setError(
        err.code === 'functions/resource-exhausted'
          ? 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.'
          : 'קוד שגוי, נסה שוב'
      )
      setPin('')
      inputRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  const handleBack = () => {
    setSelectedWorker(null)
    setPin('')
    setError('')
  }

  const activeWorkers = workers.filter(w => w.isActive !== false)

  if (activeWorkers.length === 0) {
    return (
      <div className="login-container">
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">👤</div>
            <h3>אין נותני שירות במערכת</h3>
            <p>עבור לממשק הניהול להוספת נותני שירות</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="login-container">
      <div className="card" style={{ padding: '20px 20px', overflow: 'visible' }}>

        {/* Badge + Title */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{
            display: 'inline-block',
            background: 'rgba(0,122,255,0.15)',
            color: '#007AFF',
            fontSize: '11px',
            fontWeight: 700,
            padding: '3px 10px',
            borderRadius: '6px',
            marginBottom: '10px',
            letterSpacing: '0.02em'
          }}>
            כניסה לנותן שירות
          </div>
          <h2 style={{
            fontSize: '20px',
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginBottom: '4px',
            padding: 0,
            border: 'none'
          }}>
            {selectedWorker ? `שלום, ${getDisplayWorkerName(selectedWorker)}` : 'שלום, מי את/ה?'}
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', margin: 0 }}>
            {selectedWorker ? 'הזן/י קוד אישי כדי להמשיך' : 'בחר/י שם מהרשימה'}
          </p>
        </div>

        {/* Worker grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '8px',
          marginBottom: '14px'
        }}>
          {activeWorkers.map(worker => (
            <div
              key={worker.id}
              onClick={() => handleWorkerSelect(worker)}
              style={{
                background: selectedWorker?.id === worker.id
                  ? 'rgba(0,122,255,0.1)'
                  : 'var(--surface-2)',
                border: `1px solid ${selectedWorker?.id === worker.id ? '#007AFF' : 'var(--border-mid)'}`,
                borderRadius: '10px',
                padding: '11px 10px',
                textAlign: 'center',
                fontSize: '13px',
                fontWeight: selectedWorker?.id === worker.id ? 600 : 400,
                color: selectedWorker?.id === worker.id ? '#007AFF' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all 0.15s',
                userSelect: 'none'
              }}
            >
              {getDisplayWorkerName(worker)}
            </div>
          ))}
        </div>

        {/* PIN section */}
        <form onSubmit={handleSubmit}>
          <div style={{
            fontSize: '12px',
            color: 'var(--text-tertiary)',
            marginBottom: '10px',
            textAlign: 'center'
          }}>
            {selectedWorker ? 'קוד אישי' : 'בחר/י נותן שירות תחילה'}
          </div>

          {/* PIN input — only shown when worker is selected */}
          {selectedWorker && (
            <input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pin}
              onChange={handlePinChange}
              disabled={submitting}
              placeholder="••••"
              autoComplete="off"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'center',
                fontSize: '1.5rem',
                letterSpacing: '0.4rem',
                padding: '11px 14px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-mid)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                marginBottom: '8px',
                cursor: 'text',
              }}
            />
          )}

          {error && (
            <div role="alert" style={{
              color: '#FF453A',
              textAlign: 'center',
              fontSize: '13px',
              marginBottom: '14px'
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            {selectedWorker && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={handleBack}
                disabled={submitting}
              >
                חזור
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={!selectedWorker || pin.length < PIN_MIN_LENGTH || submitting}
            >
              {submitting ? <span className="spinner" /> : 'כניסה →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default WorkerLogin
