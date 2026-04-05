import React from 'react'
import { formatDistance, CONFIDENCE_LEVELS } from '../utils/distance'
import { formatTime, formatFullDate } from '../utils/formatters'
import ConfidenceBadge from './ui/ConfidenceBadge'

function ScanResult({ result, onBack }) {
  return (
    <div className="card">
      <div className={`result ${result.success ? 'result-success' : 'result-error'}`}>
        <div className="result-icon">
          {result.success ? '✓' : '✗'}
        </div>

        <h2>
          {result.success
            ? (result.confidenceScore === CONFIDENCE_LEVELS.HIGH
                ? 'נוכחות אומתה בהצלחה!'
                : 'נוכחות אומתה')
            : 'אימות נכשל'}
        </h2>

        {result.success && result.confidenceScore && result.confidenceScore !== CONFIDENCE_LEVELS.HIGH && (
          <div style={{ marginBottom: '16px' }}>
            <ConfidenceBadge confidence={result.confidenceScore} />
          </div>
        )}

        {result.success ? (
          <div>
            <div style={{ background: '#d4edda', padding: '20px', borderRadius: '8px', marginBottom: '20px', textAlign: 'right' }}>
              <div style={{ marginBottom: '10px' }}><strong>נקודה:</strong> {result.location}</div>
              <div style={{ marginBottom: '10px' }}><strong>נותן שירות:</strong> {result.worker}</div>
              <div style={{ marginBottom: '10px' }}><strong>מרחק:</strong> {formatDistance(result.distance)}</div>
              <div style={{ marginBottom: '10px' }}><strong>תאריך:</strong> {formatFullDate(result.timestamp)}</div>
              <div><strong>שעה:</strong> {formatTime(result.timestamp)}</div>
            </div>

            <p style={{ color: '#155724' }}>
              {result.savedOffline
                ? '📱 הסריקה נשמרה מקומית ותסונכרן כשיהיה חיבור'
                : '✓ הסריקה נשמרה במערכת'}
            </p>

            {result.savedOffline && (
              <div style={{ marginTop: '10px', padding: '10px', background: '#fff3cd', borderRadius: '6px', color: '#856404', fontSize: '0.9rem' }}>
                💡 הסריקה תסונכרן אוטומטית ברגע שיהיה חיבור לאינטרנט
              </div>
            )}
          </div>
        ) : (
          <div>
            <div style={{ background: '#f8d7da', padding: '20px', borderRadius: '8px', marginBottom: '20px', textAlign: 'right' }}>
              <div style={{ marginBottom: '10px' }}><strong>שגיאה:</strong> {result.error}</div>
              {result.details && <div style={{ marginBottom: '10px' }}>{result.details}</div>}
              {result.location && <div style={{ marginBottom: '10px' }}><strong>נקודה:</strong> {result.location}</div>}
              {result.distance !== undefined && <div><strong>מרחק שלך:</strong> {formatDistance(result.distance)}</div>}
            </div>
            <p style={{ color: '#721c24' }}>אנא ודא שאתה נמצא ליד הנקודה הנכונה</p>
          </div>
        )}

        <button className="btn btn-primary" style={{ marginTop: '20px' }} onClick={onBack}>
          חזור לסריקה
        </button>
      </div>
    </div>
  )
}

export default ScanResult
