import React from 'react'
import LocationMap from './LocationMap'
import { getDisplayWorkerName } from '../utils/formatters'
import { GEOFENCE_CONFIG } from '../utils/distance'

function LocationForm({ form, onChange, workers, onMapClick, gettingLocation, onGetCurrentLocation }) {
  const handleWorkerToggle = (worker) => {
    const isChecked = form.assignedWorkerIds.includes(worker.id)
    const displayName = getDisplayWorkerName(worker)
    if (isChecked) {
      onChange({
        ...form,
        assignedWorkerIds: form.assignedWorkerIds.filter(id => id !== worker.id),
        assignedWorkerNames: form.assignedWorkerNames.filter(n => n !== displayName)
      })
    } else {
      onChange({
        ...form,
        assignedWorkerIds: [...form.assignedWorkerIds, worker.id],
        assignedWorkerNames: [...form.assignedWorkerNames, displayName]
      })
    }
  }

  return (
    <>
      <div className="form-group">
        <label>שם הנקודה *</label>
        <input
          type="text"
          value={form.name}
          onChange={e => onChange({ ...form, name: e.target.value })}
          placeholder="לדוגמא: חדר מדרגות קומה 2"
          required
        />
      </div>

      <div className="form-group">
        <label>תיאור מיקום</label>
        <input
          type="text"
          value={form.description}
          onChange={e => onChange({ ...form, description: e.target.value })}
          placeholder="לדוגמא: ליד המעלית"
        />
      </div>

      <div className="form-group">
        <label>רדיוס אימות (מטרים)</label>
        <input
          type="number"
          value={form.radiusMeters}
          onChange={e => {
            const val = parseInt(e.target.value)
            onChange({ ...form, radiusMeters: (val > 0) ? val : GEOFENCE_CONFIG.DEFAULT_RADIUS })
          }}
          min="1"
          max="100"
        />
      </div>

      <div className="form-group">
        <label>שיוך לנותני שירות</label>
        <div style={{ border: '1px solid var(--border-mid)', borderRadius: '8px', padding: '10px', maxHeight: '200px', overflowY: 'auto', background: 'var(--surface-2)' }}>
          {workers.length === 0 ? (
            <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>אין נותני שירות</p>
          ) : (
            workers.map(w => (
              <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 4px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)' }}>
                <input
                  type="checkbox"
                  checked={form.assignedWorkerIds.includes(w.id)}
                  onChange={() => handleWorkerToggle(w)}
                  style={{ width: '18px', height: '18px', flexShrink: 0 }}
                />
                <span style={{ fontSize: '0.95rem' }}>{getDisplayWorkerName(w)}</span>
              </label>
            ))
          )}
        </div>
        <small style={{ color: '#888', marginTop: '4px', display: 'block' }}>ללא בחירה = כולם מורשים</small>
      </div>

      <div className="form-group">
        <label>בחר מיקום על המפה</label>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginBottom: '10px', width: '100%' }}
          onClick={onGetCurrentLocation}
          disabled={gettingLocation}
        >
          {gettingLocation ? (
            <>
              <span className="spinner" style={{ marginLeft: '8px' }}></span>
              מקבל מיקום...
            </>
          ) : (
            '📍 השתמש במיקום הנוכחי שלי'
          )}
        </button>
        <div className="map-container">
          <LocationMap
            center={[form.latitude, form.longitude]}
            zoom={17}
            onClick={onMapClick}
            marker={{ lat: form.latitude, lng: form.longitude }}
          />
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '5px' }}>
          לחץ על המפה לבחירת מיקום מדויק, או השתמש בכפתור למעלה
        </p>
      </div>

      <div style={{ display: 'flex', gap: '10px' }}>
        <div className="form-group" style={{ flex: 1 }}>
          <label>קו רוחב (Latitude)</label>
          <input
            type="number"
            step="any"
            value={form.latitude}
            onChange={e => onChange({ ...form, latitude: parseFloat(e.target.value) })}
            required
          />
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>קו אורך (Longitude)</label>
          <input
            type="number"
            step="any"
            value={form.longitude}
            onChange={e => onChange({ ...form, longitude: parseFloat(e.target.value) })}
            required
          />
        </div>
      </div>
    </>
  )
}

export default LocationForm
