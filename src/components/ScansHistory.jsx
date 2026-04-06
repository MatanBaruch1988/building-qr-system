import React, { useState, useEffect } from 'react'
import { db } from '../services/firebase'
import { collection, query, orderBy, limit, onSnapshot, where, Timestamp, deleteDoc, doc } from 'firebase/firestore'
import { formatDistance, CONFIDENCE_LEVELS } from '../utils/distance'
import { formatTime, getScanWorkerDisplayName } from '../utils/formatters'
import { DeleteButton } from './ui/IconButton'
import ConfidenceBadge from './ui/ConfidenceBadge'

function ScansHistory({ readOnly = false, workerNameFilter = '', workerIdFilter = '', workers = [], showWorkerFilter = false }) {
  const [scans, setScans] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('today')
  const [workerFilter, setWorkerFilter] = useState('')

  useEffect(() => {
    const now = new Date()
    let startDate

    if (filter === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    } else if (filter === 'week') {
      const dayOfWeek = now.getDay()
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek)
    } else if (filter === 'month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1)
    }

    // Build query with server-side workerId filtering when applicable
    const constraints = [
      where('createdAt', '>=', Timestamp.fromDate(startDate)),
      orderBy('createdAt', 'desc'),
      limit(200)
    ]

    // Server-side filter: workers only receive their own scans
    if (workerIdFilter) {
      constraints.unshift(where('workerId', '==', workerIdFilter))
    }

    const q = query(collection(db, 'scans'), ...constraints)

    const unsubscribe = onSnapshot(q, (snapshot) => {
      let scansList = snapshot.docs.map(doc => {
        const data = doc.data()
        // Support both createdAt (Timestamp) and timestamp (ISO string)
        let ts = data.createdAt?.toDate?.() || (data.timestamp ? new Date(data.timestamp) : null)
        return {
          id: doc.id,
          ...data,
          timestamp: ts
        }
      })

      // Client-side name filter only (workerIdFilter is now handled server-side)
      if (workerNameFilter) {
        scansList = scansList.filter(s => {
          if (workers.length > 0 && s.workerId) {
            const w = workers.find(w => w.id === s.workerId)
            if (w) return (w.company || w.name) === workerNameFilter
          }
          return s.workerName === workerNameFilter
        })
      }

      setScans(scansList)
      setLoading(false)
    }, (error) => {
      console.error('Error fetching scans:', error)
      setLoading(false)
    })

    return () => unsubscribe()
  }, [filter, workerIdFilter, workerNameFilter, workers])

  const handleDeleteScan = async (scanId) => {
    if (!window.confirm('האם למחוק סריקה זו?')) return
    try {
      await deleteDoc(doc(db, 'scans', scanId))
    } catch (error) {
      console.error('Error deleting scan:', error)
      alert('שגיאה במחיקת הסריקה')
    }
  }

  const getDisplayName = (scan) => getScanWorkerDisplayName(scan, workers)

  const uniqueWorkers = [...new Set(scans.map(s => getDisplayName(s)).filter(Boolean))].sort()

  const filteredScans = workerFilter
    ? scans.filter(s => getDisplayName(s) === workerFilter)
    : scans

  const groupedScans = filteredScans.reduce((groups, scan) => {
    if (!scan.timestamp) return groups
    const dateKey = scan.timestamp.toLocaleDateString('he-IL')
    if (!groups[dateKey]) groups[dateKey] = []
    groups[dateKey].push(scan)
    return groups
  }, {})

  const TIME_FILTERS = [
    { key: 'today', label: 'היום' },
    { key: 'week', label: 'שבוע' },
    { key: 'month', label: 'חודש' }
  ]

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap', gap: '10px' }}>
        <h2>היסטוריית סריקות</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          {TIME_FILTERS.map(f => (
            <button
              key={f.key}
              className={`btn ${filter === f.key ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '6px 12px', fontSize: '0.9rem' }}
              onClick={() => setFilter(f.key)}
              aria-current={filter === f.key ? 'true' : undefined}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {(showWorkerFilter || (!readOnly && !workerNameFilter)) && uniqueWorkers.length > 0 && (
        <div style={{ marginBottom: '15px' }}>
          <select
            value={workerFilter}
            onChange={e => setWorkerFilter(e.target.value)}
            style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-mid)', background: 'var(--surface-2)', color: 'var(--text-primary)', fontSize: '1rem' }}
          >
            <option value="">כל נותני השירות</option>
            {uniqueWorkers.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <span className="spinner"></span>
          <p style={{ marginTop: '15px', color: 'var(--text-secondary)' }}>טוען...</p>
        </div>
      ) : filteredScans.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📋</div>
          <p>אין סריקות {filter === 'today' ? 'להיום' : filter === 'week' ? 'השבוע' : 'החודש'}{workerFilter ? ` עבור ${workerFilter}` : ''}</p>
        </div>
      ) : (
        <div>
          {Object.entries(groupedScans).map(([date, dateScans]) => (
            <div key={date} style={{ marginBottom: '25px' }}>
              <h4 style={{ background: 'var(--surface-2)', padding: '10px 15px', borderRadius: '6px', marginBottom: '10px', color: 'var(--text-primary)' }}>
                {date}
                <span style={{ float: 'left', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  {dateScans.length} סריקות
                </span>
              </h4>

              {/* DESKTOP TABLE */}
              <div className="scans-table-wrapper">
                <table className="scan-desktop-table">
                  <thead>
                    <tr>
                      <th>שעה</th>
                      <th>נקודה</th>
                      <th>נותן שירות</th>
                      <th>מרחק</th>
                      <th>סטטוס</th>
                      {!readOnly && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {dateScans.map(scan => (
                      <tr key={scan.id}>
                        <td style={{ fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {formatTime(scan.timestamp)}
                        </td>
                        <td style={{ color: scan.isValid ? 'var(--text-primary)' : 'var(--red)', fontWeight: 500 }}>
                          {!scan.isValid && '❌ '}{scan.locationName}
                        </td>
                        <td style={{ color: 'var(--text-secondary)' }}>{getDisplayName(scan)}</td>
                        <td style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {scan.distanceMeters !== undefined ? formatDistance(scan.distanceMeters) : '—'}
                        </td>
                        <td>
                          {scan.confidenceScore
                            ? <ConfidenceBadge confidence={scan.confidenceScore} />
                            : <span style={{ color: scan.isValid ? 'var(--green)' : 'var(--red)', fontSize: '0.8125rem', fontWeight: 600 }}>
                                {scan.isValid ? '✓ אומת' : '✗ נדחה'}
                              </span>
                          }
                        </td>
                        {!readOnly && (
                          <td>
                            <DeleteButton onClick={() => handleDeleteScan(scan.id)} title="מחק סריקה" />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* MOBILE CARDS */}
              <div className="scan-card-rows">
                {dateScans.map(scan => (
                  <div key={scan.id} className="list-item" style={{ marginBottom: '8px' }}>
                    <div className="list-item-content" style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <h4 style={{ marginBottom: '5px', color: scan.isValid ? 'var(--text-primary)' : 'var(--red)' }}>
                            {!scan.isValid && '❌ '}{scan.locationName}
                          </h4>
                          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                            {getDisplayName(scan)}
                            {scan.distanceMeters !== undefined && <span> • {formatDistance(scan.distanceMeters)}</span>}
                            {scan.gpsAccuracy && <span> • דיוק GPS: {Math.round(scan.gpsAccuracy)}m</span>}
                          </p>
                          {!scan.isValid && scan.errorReason && (
                            <p style={{ fontSize: '0.85rem', color: '#dc3545', marginTop: '4px' }}>
                              סיבה: {scan.errorReason}
                            </p>
                          )}
                        </div>
                        <div style={{ textAlign: 'left' }}>
                          <span style={{ fontWeight: 'bold', fontSize: '1.1rem', color: 'var(--text-primary)' }}>
                            {formatTime(scan.timestamp)}
                          </span>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'flex-end', marginTop: '4px' }}>
                            {scan.isValid && scan.confidenceScore && (
                              <ConfidenceBadge confidence={scan.confidenceScore} />
                            )}
                            {!scan.isValid && <span className="badge badge-danger">נדחה</span>}
                            {scan.isValid && !scan.confidenceScore && <span className="badge badge-success">אומת</span>}
                          </div>
                          {!readOnly && (
                            <DeleteButton onClick={() => handleDeleteScan(scan.id)} title="מחק סריקה" />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div aria-live="polite" style={{ marginTop: '20px', padding: '15px', background: 'var(--surface-2)', borderRadius: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
        <strong>סטטיסטיקה{workerFilter ? ` - ${workerFilter}` : ''}:</strong>
        <div style={{ display: 'flex', gap: '20px', marginTop: '10px', flexWrap: 'wrap' }}>
          <div>סה"כ סריקות: <strong>{filteredScans.length}</strong></div>
          <div>🟢 ביטחון גבוה: <strong>{filteredScans.filter(s => s.confidenceScore === CONFIDENCE_LEVELS.HIGH).length}</strong></div>
          <div>🟠 ביטחון בינוני: <strong>{filteredScans.filter(s => s.confidenceScore === CONFIDENCE_LEVELS.MEDIUM).length}</strong></div>
          <div>🟡 ביטחון נמוך: <strong>{filteredScans.filter(s => s.confidenceScore === CONFIDENCE_LEVELS.LOW).length}</strong></div>
          <div>❌ נדחו: <strong>{filteredScans.filter(s => !s.isValid).length}</strong></div>
        </div>
      </div>
    </div>
  )
}

export default ScansHistory
