import React, { useState } from 'react'
import { getDisplayWorkerName, getWorkerInitials } from '../utils/formatters'

function WorkerLogin({ workers, onLogin }) {
  const [selectedWorker, setSelectedWorker] = useState(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [step, setStep] = useState('select') // 'select' | 'code'

  const handleWorkerSelect = (worker) => {
    setSelectedWorker(worker)
    setStep('code')
    setError('')
    setCode('')
  }

  const [submitting, setSubmitting] = useState(false)

  const handleCodeSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!selectedWorker) {
      setError('אנא בחר נותן שירות')
      return
    }

    setSubmitting(true)
    try {
      await onLogin(selectedWorker.id, code)
    } catch (err) {
      // Error message is set by the hook; show a generic fallback
      setError(err.code === 'functions/resource-exhausted'
        ? 'יותר מדי ניסיונות. נסה שוב בעוד מספר דקות.'
        : 'קוד שגוי')
    } finally {
      setSubmitting(false)
    }
  }

  if (workers.length === 0) {
    return (
      <div className="login-container">
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">👤</div>
            <h3>אין נותני שירות במערכת</h3>
            <p>עבור ללשונית "ניהול" להוספת נותני שירות</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="login-container">
      <div className="card">
        <h2 style={{ textAlign: 'center', marginBottom: '20px' }}>
          {step === 'select' ? 'בחר נותן שירות' : 'הזן קוד'}
        </h2>

        {step === 'select' && (
          <div className="worker-grid">
            {workers.filter(w => w.isActive !== false).map(worker => (
              <div
                key={worker.id}
                className={`worker-card ${selectedWorker?.id === worker.id ? 'selected' : ''}`}
                onClick={() => handleWorkerSelect(worker)}
              >
                <div className="worker-avatar">
                  {getWorkerInitials(getDisplayWorkerName(worker))}
                </div>
                <div className="worker-name">{getDisplayWorkerName(worker)}</div>
                {worker.name && worker.company && (
                  <div style={{ fontSize: '0.8rem', color: '#666', marginTop: '5px' }}>
                    {worker.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {step === 'code' && selectedWorker && (
          <form onSubmit={handleCodeSubmit}>
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
              <div className="worker-avatar" style={{ margin: '0 auto' }}>
                {getWorkerInitials(getDisplayWorkerName(selectedWorker))}
              </div>
              <h3 style={{ marginTop: '10px' }}>{getDisplayWorkerName(selectedWorker)}</h3>
              {selectedWorker.name && selectedWorker.company && (
                <p style={{ color: '#666', fontSize: '0.9rem' }}>{selectedWorker.name}</p>
              )}
            </div>

            <div className="form-group">
              <label>קוד כניסה</label>
              <input
                type="password"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="הזן קוד"
                autoFocus
                style={{ textAlign: 'center', fontSize: '1.5rem', letterSpacing: '0.5rem' }}
              />
            </div>

            {error && (
              <div role="alert" style={{ color: '#dc3545', textAlign: 'center', marginBottom: '15px' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => {
                  setStep('select')
                  setSelectedWorker(null)
                  setCode('')
                  setError('')
                }}
              >
                חזור
              </button>
              <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={submitting}>
                {submitting ? <span className="spinner"></span> : 'כניסה'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export default WorkerLogin
