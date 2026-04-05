import React from 'react'
import { EditButton, DeleteButton } from './ui/IconButton'
import { getLocationAssignedNames } from '../utils/formatters'
import { downloadQRCode, printQRCode } from '../utils/qrGenerator'

function LocationManagement({
  locations,
  workers,
  onAddLocation,
  onEditLocation,
  onDeleteLocation,
  selectedLocation,
  onSelectLocation,
  qrCodeDataUrl
}) {
  return (
    <div className="grid grid-2">
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
          <h2>נקודות QR</h2>
          <button className="btn btn-primary" onClick={onAddLocation}>
            + הוסף נקודה
          </button>
        </div>

        {locations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📍</div>
            <p>אין נקודות עדיין</p>
            <p>הוסף נקודה חדשה להתחיל</p>
          </div>
        ) : (
          <div>
            {locations.map(location => {
              const assignedNames = getLocationAssignedNames(location, workers)
              return (
                <div
                  key={location.id}
                  className="list-item"
                  style={{
                    cursor: 'pointer',
                    background: selectedLocation?.id === location.id ? '#e8f0fe' : undefined
                  }}
                  onClick={() => onSelectLocation(location)}
                >
                  <div className="list-item-content">
                    <h4>{location.name}</h4>
                    <p>{location.description || 'ללא תיאור'}</p>
                    <p style={{ fontSize: '0.8rem' }}>
                      רדיוס: {location.radiusMeters} מטר
                      {assignedNames && (
                        <span> • משויך ל: {assignedNames}</span>
                      )}
                    </p>
                  </div>
                  <div className="list-item-actions">
                    <EditButton
                      onClick={() => onEditLocation(location)}
                      stopPropagation
                    />
                    <DeleteButton
                      onClick={() => onDeleteLocation(location.id)}
                      stopPropagation
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* QR Code Display */}
      <div className="card">
        <h2>קוד QR</h2>
        {selectedLocation ? (
          <div className="qr-display">
            <h3>{selectedLocation.name}</h3>
            {qrCodeDataUrl && (
              <>
                <img src={qrCodeDataUrl} alt="QR Code" style={{ marginTop: '15px' }} />
                <div style={{ marginTop: '15px', display: 'flex', gap: '10px', justifyContent: 'center' }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => downloadQRCode(qrCodeDataUrl, `qr-${selectedLocation.name}.png`)}
                  >
                    הורד
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => printQRCode(qrCodeDataUrl, selectedLocation.name)}
                  >
                    הדפס
                  </button>
                </div>
              </>
            )}
            <p style={{ marginTop: '15px', fontSize: '0.9rem', color: '#666' }}>
              קואורדינטות: {selectedLocation.latitude.toFixed(5)}, {selectedLocation.longitude.toFixed(5)}
            </p>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">📷</div>
            <p>בחר נקודה לצפייה בקוד QR</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default LocationManagement
